#!/usr/bin/env python3
"""Renderer behavior: the page is written only when nothing identifying survived.

The pane masks the fields it prints, so the renderer's job is to check that it
did rather than to hide anything itself. These cases drive the check directly and
then drive `main()` with a stubbed read, which is where a leak has to stop the
write instead of reaching a page.

The shapes below are assembled from parts. A key-shaped literal in this file is a
key-shaped literal the export would have to refuse.
"""

from importlib.util import module_from_spec, spec_from_file_location
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "render-review.py"
SPEC = spec_from_file_location("render_review", SCRIPT)
assert SPEC and SPEC.loader
RENDER = module_from_spec(SPEC)
SPEC.loader.exec_module(RENDER)


def shaped(*parts: str) -> str:
    return "".join(parts)


def stub_read(pane_text: str):
    """A read that returns a rendered pane instead of touching the machine."""
    def read(*_args: object, **_kwargs: object) -> tuple[dict, str]:
        return ({"generated_at": 0.0, "roster": {}}, pane_text)
    return read


def stub_vectors(vectors: list[dict] | None):
    """The drawings a desktop would put in the pane, without running the renderer."""
    def draw(*_args: object, **_kwargs: object) -> list[dict] | None:
        return vectors
    return draw


BAR = {"source": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10">'
                 '<rect width="42" height="10" fill="#2f9e44"/></svg>',
       "alt": "42 of 80 done", "cells": 30}


class LeakCase(unittest.TestCase):
    def test_a_rendered_pane_with_nothing_identifying_is_clean(self) -> None:
        pane = "\n".join([
            "  Fleet                                    4 working  2 waiting",
            "  Updated 4s ago",
            "    Background sessions",
            "        LFP-DSK-Oct-11                                Working",
            "        DeepSeek | session b5a42db5 | mid-turn",
            "    Trials                                    0 running  8 recent",
            "        fix/brand-tint-pins                             10 passed",
            "    Worktrees                      18 checked out  91 cleaned this week",
            "        [masked]                                     active",
        ])
        self.assertEqual(RENDER.leaked(pane), [])

    def test_each_identifying_shape_is_named(self) -> None:
        cases = [
            ("an organization identifier", "behind " + shaped("org", "_300382")),
            ("a location identifier", "at " + shaped("loc", "_173185")),
            ("a merchant identifier", shaped("M", "ID 1234567")),
            ("an account number", "account 1234567890"),
            ("a sign-in", "login " + shaped("y1av", "Jp1mg")),
            ("key material", "token: " + shaped("abc", "123def456")),
            ("a key prefix", shaped("sk-", "ant-", "api03-", "a" * 20)),
            ("a github token", shaped("ghp", "_", "b" * 24)),
            ("an aws key", shaped("AKIA", "C" * 16)),
            ("a private key", shaped("-----BEGIN ", "RSA ", "PRIVATE KEY-----")),
            ("a credentialed url", "https://" + shaped("operator", ":", "hunter2") + "@x.invalid"),
        ]
        for expected, text in cases:
            with self.subTest(expected=expected):
                self.assertIn(expected, RENDER.leaked("      " + text))
                self.assertIn(expected, RENDER.leaked("      " + text + "\n      more"))

    def test_ordinary_words_are_not_a_leak(self) -> None:
        for text in ["mid-turn", "the key is here", "login failed", "MID-Atlantic region",
                     "org chart for the quarter", "a monkey and a keyboard",
                     "high secret: looks like a key (a.py:4)", "3 working, 2 failed"]:
            with self.subTest(text=text):
                self.assertEqual(RENDER.leaked(text), [])

    def test_a_leak_stops_the_write_and_names_the_shape(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine",
                stub_read("    Background sessions\n        behind "
                          + shaped("org", "_300382") + "\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        self.use_vectors([BAR])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pane.html"
            argv = sys.argv
            sys.argv = ["render-review.py", "--out", str(target)]
            try:
                code = RENDER.main()
            finally:
                sys.argv = argv
            self.assertEqual(code, 1)
            self.assertEqual(target.exists(), False)
            self.assertEqual((Path(directory) / "pane.txt").exists(), False)

    def test_a_clean_pane_is_written_with_both_files(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine",
                stub_read("  Fleet                                    4 working  2 waiting\n"
                          "        DeepSeek | session b5a42db5 | mid-turn\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        self.use_vectors([BAR])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pane.html"
            argv = sys.argv
            sys.argv = ["render-review.py", "--out", str(target)]
            try:
                code = RENDER.main()
            finally:
                sys.argv = argv
            self.assertEqual(code, 0)
            page = target.read_text()
            self.assertIn("mid-turn", page)
            self.assertEqual((Path(directory) / "pane.txt").read_text().strip().endswith("mid-turn"),
                             True)

    def use_vectors(self, vectors: list[dict] | None) -> None:
        original = RENDER.draw_vectors
        setattr(RENDER, "draw_vectors", stub_vectors(vectors))
        self.addCleanup(setattr, RENDER, "draw_vectors", original)

    def write_page(self, directory: str) -> tuple[int, Path]:
        target = Path(directory) / "pane.html"
        argv, stderr = sys.argv, sys.stderr
        sys.argv = ["render-review.py", "--out", str(target)]
        sys.stderr = io.StringIO()
        try:
            code = RENDER.main()
        finally:
            sys.argv, sys.stderr = argv, stderr
        return code, target

    def test_the_page_draws_each_vector_with_its_alt_in_both_schemes(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine", stub_read("  Fleet               3 working\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        self.use_vectors([BAR])
        with tempfile.TemporaryDirectory() as directory:
            code, target = self.write_page(directory)
            self.assertEqual(code, 0)
            page = target.read_text()
        # An image, never inline markup: a drawing on the page cannot run what it holds.
        self.assertEqual(page.count('src="data:image/svg+xml;base64,'), 2)
        self.assertEqual(page.count('alt="42 of 80 done"'), 2)
        self.assertIn('class="vectors light"', page)
        self.assertIn('class="vectors dark"', page)
        self.assertIn('width="300"', page)
        self.assertNotIn("<rect", page)

    def test_a_reading_with_no_drawing_says_so(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine", stub_read("  Fleet               3 working\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        self.use_vectors([])
        with tempfile.TemporaryDirectory() as directory:
            code, target = self.write_page(directory)
            self.assertEqual(code, 0)
            self.assertIn("The pane drew no vector at this reading.", target.read_text())

    def test_a_drawing_that_could_not_be_rendered_writes_nothing(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine", stub_read("  Fleet               3 working\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        self.use_vectors(None)
        with tempfile.TemporaryDirectory() as directory:
            code, target = self.write_page(directory)
            self.assertEqual(code, 1)
            self.assertEqual(target.exists(), False)
            self.assertEqual((Path(directory) / "pane.txt").exists(), False)

    def test_a_leak_in_a_drawing_stops_the_write(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine", stub_read("  Fleet               3 working\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        for field in ("alt", "source"):
            with self.subTest(field=field):
                leaking = dict(BAR)
                leaking[field] = leaking[field] + " behind " + shaped("org", "_300382")
                self.use_vectors([leaking])
                with tempfile.TemporaryDirectory() as directory:
                    code, target = self.write_page(directory)
                    self.assertEqual(code, 1)
                    self.assertEqual(target.exists(), False)

    def test_the_renderer_answer_is_checked_before_it_is_drawn(self) -> None:
        cases = {
            "a failed run": (1, "[]"),
            "not JSON": (0, "<svg/>"),
            "not a list": (0, '{"source": "", "alt": ""}'),
            "an entry with no alt": (0, '[{"source": "<svg/>"}]'),
            "an alt that is not text": (0, '[{"source": "<svg/>", "alt": 3}]'),
        }
        original = RENDER.subprocess.run
        self.addCleanup(setattr, RENDER.subprocess, "run", original)
        for name, (code, stdout) in cases.items():
            with self.subTest(name):
                answer = RENDER.subprocess.CompletedProcess([], code, stdout, "")
                setattr(RENDER.subprocess, "run", lambda *_a, answer=answer, **_k: answer)
                self.assertIsNone(RENDER.draw_vectors({}, 100, 5.0))
        good = RENDER.subprocess.CompletedProcess([], 0, '[{"source": "<svg/>", "alt": "a"}]', "")
        seen: list[list[str]] = []

        def run(argv: list[str], **_kwargs: object):
            seen.append(argv)
            return good
        setattr(RENDER.subprocess, "run", run)
        self.assertEqual(RENDER.draw_vectors({}, 100, 5.0), [{"source": "<svg/>", "alt": "a"}])
        self.assertEqual(seen[0][-2:], ["100", "--vectors"])

    def test_a_text_render_that_failed_is_no_pane_even_with_output(self) -> None:
        # A renderer that printed half a pane and then exited non-zero is a
        # failed render: what it printed is not the pane, and nothing is written.
        answers = [RENDER.subprocess.CompletedProcess([], 0, '{"roster": {}}', ""),
                   RENDER.subprocess.CompletedProcess([], 1, "  Fleet  partial\n", "boom")]
        original = RENDER.subprocess.run
        self.addCleanup(setattr, RENDER.subprocess, "run", original)
        setattr(RENDER.subprocess, "run", lambda *_a, **_k: answers.pop(0))
        snapshot, pane_text = RENDER.read_machine(None, None, 5.0, 100)
        self.assertEqual(snapshot, {"roster": {}})
        self.assertEqual(pane_text, "")

    def test_printing_writes_the_pane_and_no_file(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine", stub_read("  Fleet               3 working\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pane.html"
            argv, out = sys.argv, io.StringIO()
            sys.argv = ["render-review.py", "--print", "--out", str(target),
                        "--print-width", "100"]
            stdout = sys.stdout
            sys.stdout = out
            try:
                code = RENDER.main()
            finally:
                sys.argv, sys.stdout = argv, stdout
            self.assertEqual(code, 0)
            self.assertIn("3 working", out.getvalue())
            self.assertEqual(target.exists(), False)
            self.assertEqual((Path(directory) / "pane.txt").exists(), False)

    def test_printing_a_leak_writes_nothing_at_all(self) -> None:
        original = RENDER.read_machine
        setattr(RENDER, "read_machine",
                stub_read("  behind " + shaped("org", "_300382") + "\n"))
        self.addCleanup(setattr, RENDER, "read_machine", original)
        argv, out = sys.argv, io.StringIO()
        sys.argv = ["render-review.py", "--print", "--print-width", "100"]
        stdout, stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, io.StringIO()
        try:
            code = RENDER.main()
        finally:
            sys.argv, sys.stdout, sys.stderr = argv, stdout, stderr
        self.assertEqual(code, 1)
        self.assertEqual(out.getvalue(), "")

    def test_the_terminal_width_is_the_terminals_own(self) -> None:
        original = os.environ.get("COLUMNS")
        self.addCleanup(self.restore_columns, original)
        os.environ["COLUMNS"] = "140"
        self.assertEqual(RENDER.terminal_width(100), 140)

    def test_a_terminal_too_narrow_for_a_row_falls_back(self) -> None:
        original = os.environ.get("COLUMNS")
        self.addCleanup(self.restore_columns, original)
        for value in ("10", "0", "not a number", ""):
            with self.subTest(value=value):
                os.environ["COLUMNS"] = value
                self.assertEqual(RENDER.terminal_width(100), 100)

    def restore_columns(self, original: str | None) -> None:
        if original is None:
            os.environ.pop("COLUMNS", None)
        else:
            os.environ["COLUMNS"] = original

    def test_the_page_says_the_masker_ran(self) -> None:
        page = RENDER.page({"generated_at": 0.0}, "  Fleet", 100, "2026-10-11 10:00:00")
        self.assertIn("masked by the pane", page)
        self.assertNotIn("hidden", page.lower().replace("overflow: hidden", ""))


class SourceCountTests(unittest.TestCase):
    def test_each_custom_section_answers_for_itself(self) -> None:
        rows = dict(RENDER.counts({"custom": {"state": "ready", "errors": [], "sections": {
            "disk": {"state": "ready", "rows": [{"title": "home"}], "errors": []},
            "gone": {"state": "unavailable", "rows": [],
                     "errors": [{"source": "custom:gone", "reason": "x is not on PATH"}]},
        }}}))
        self.assertEqual(rows["custom:disk"], "ready | 1 rows")
        self.assertEqual(rows["custom:gone"], "unavailable | 0 rows | 1 error(s)")
        # The built-in sources still each get a line, even when absent.
        self.assertEqual(rows["prs"], "no document")

    def test_no_custom_document_adds_no_custom_line(self) -> None:
        rows = dict(RENDER.counts({}))
        self.assertFalse([name for name in rows if name.startswith("custom")])
        self.assertEqual(len(rows), 6)


if __name__ == "__main__":
    unittest.main()
