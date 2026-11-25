"""The Node runners run when they are started, whatever path names them.

A runner decides it was started, rather than imported, by comparing the module's
own URL with the path Node was given. That path is not a URL: on Windows it is
`D:\\...`, and anywhere it can hold a space or pass through a link, while the URL
is percent-encoded and names the file's real location. A comparison of the two as
strings is false there, the runner does nothing and exits 0 with no output, and
the script that started it draws an empty preview as though it were one.

Each case starts the real runner through a link whose name holds a space, so the
mismatch the Windows leg hits is reproduced on every platform that can make one.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
COMPONENTS = ROOT / "components"
PRELUDE = ["--import", (COMPONENTS / "resolve.ts").as_uri()]
DEMO = ROOT / "scripts" / "statusline-demo.py"

STATUSLINE_REQUEST = {"host": {"state": "empty"}, "transcript": {"state": "unavailable"},
                      "project": "example-project", "branch": "task/example", "width": 100}


@unittest.skipIf(shutil.which("node") is None, "no Node on PATH to start the runners")
class DirectRunCase(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="runner-entry-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.linked = self.root / "a folder with spaces"
        try:
            os.symlink(COMPONENTS, self.linked, target_is_directory=True)
        except OSError as refusal:
            # Windows lets only an elevated or developer-mode account make a link.
            # The Windows path itself is covered there by tests/test_statusline_demo.py,
            # which starts the runner by its plain path.
            self.skipTest("this account cannot make a symbolic link: " + str(refusal))

    def start(self, folder: Path, name: str, *argv: str, stdin: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["node", *PRELUDE, str(folder / name), *argv], input=stdin,
                              capture_output=True, text=True, encoding="utf-8", timeout=60,
                              cwd=str(self.root))

    def test_the_statusline_runner_draws_when_started_through_a_link(self) -> None:
        request = json.dumps(STATUSLINE_REQUEST)
        direct = self.start(COMPONENTS, "statusline-run.ts", stdin=request)
        linked = self.start(self.linked, "statusline-run.ts", stdin=request)
        self.assertEqual(direct.returncode, 0, direct.stderr)
        self.assertNotEqual(direct.stdout.strip(), "", "the plain path drew nothing")
        self.assertEqual(linked.returncode, 0, linked.stderr)
        self.assertEqual(linked.stdout, direct.stdout)

    def test_the_statusline_runner_refuses_an_empty_request_through_a_link(self) -> None:
        # A runner that never started exits 0 with nothing; one that started refuses.
        linked = self.start(self.linked, "statusline-run.ts", stdin="")
        self.assertEqual(linked.returncode, 1)
        self.assertIn("no request was sent on stdin", linked.stderr)
        self.assertEqual(linked.stdout, "")

    def test_the_review_runner_draws_when_started_through_a_link(self) -> None:
        snapshot = json.dumps({"generated_at": 1790000000})
        direct = self.start(COMPONENTS, "review.ts", "100", stdin=snapshot)
        linked = self.start(self.linked, "review.ts", "100", stdin=snapshot)
        self.assertEqual(direct.returncode, 0, direct.stderr)
        self.assertNotEqual(direct.stdout.strip(), "", "the plain path drew nothing")
        self.assertEqual(linked.returncode, 0, linked.stderr)
        self.assertEqual(linked.stdout, direct.stdout)

    def test_the_review_runner_refuses_text_that_is_not_json_through_a_link(self) -> None:
        linked = self.start(self.linked, "review.ts", "100", stdin="not json")
        self.assertEqual(linked.returncode, 1)
        self.assertIn("was not JSON", linked.stderr)
        self.assertEqual(linked.stdout, "")


@unittest.skipIf(shutil.which("node") is None, "no Node on PATH to run the check")
class EntryCheckCase(unittest.TestCase):
    """The check itself, on this platform's own paths: on Windows these are `D:\\...`."""

    def answers(self, *started: str | None) -> list[bool]:
        entry = (COMPONENTS / "entry.ts").as_uri()
        calls = ", ".join("startedDirectly(" + json.dumps(entry) + ", "
                          + ("undefined" if path is None else json.dumps(path)) + ")"
                          for path in started)
        script = ("import { startedDirectly } from " + json.dumps(entry) + ";\n"
                  "process.stdout.write(JSON.stringify([" + calls + "]));\n")
        with tempfile.TemporaryDirectory() as directory:
            ran = subprocess.run(["node", *PRELUDE, "--input-type=module", "-e", script],
                                 capture_output=True, text=True, encoding="utf-8", timeout=60,
                                 cwd=directory)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        return json.loads(ran.stdout)

    def test_each_runner_does_nothing_when_imported(self) -> None:
        # The other side of the check: imported, a runner must not read stdin or exit.
        # No link is made here, so this runs on every Windows account.
        for runner in ("statusline-run.ts", "review.ts"):
            with self.subTest(runner=runner):
                script = ("await import(" + json.dumps((COMPONENTS / runner).as_uri())
                          + "); process.stdout.write('imported\\n');")
                with tempfile.TemporaryDirectory() as directory:
                    imported = subprocess.run(["node", *PRELUDE, "--input-type=module", "-e", script],
                                              input="", capture_output=True, text=True,
                                              encoding="utf-8", timeout=60, cwd=directory)
                self.assertEqual(imported.returncode, 0, imported.stderr)
                self.assertEqual(imported.stdout, "imported\n")
                self.assertEqual(imported.stderr, "")

    def test_the_module_is_started_by_its_own_path(self) -> None:
        self.assertEqual(self.answers(str(COMPONENTS / "entry.ts")), [True])

    def test_another_file_is_not_this_module(self) -> None:
        self.assertEqual(self.answers(str(COMPONENTS / "review.ts"), str(DEMO)), [False, False])

    def test_a_path_that_names_no_file_or_no_path_is_not_this_module(self) -> None:
        missing = str(COMPONENTS / "no-such-runner.ts")
        self.assertEqual(self.answers(missing, "word", "", None), [False, False, False, False])


@unittest.skipIf(shutil.which("node") is None, "no Node on PATH to draw the lines")
class EmptyRenderCase(unittest.TestCase):
    """A render that printed nothing is a failure of the preview, never a preview."""

    def test_an_empty_render_is_refused(self) -> None:
        sys.path.insert(0, str(ROOT / "scripts"))
        self.addCleanup(sys.path.remove, str(ROOT / "scripts"))
        import importlib.util
        spec = importlib.util.spec_from_file_location("statusline_demo", DEMO)
        assert spec and spec.loader
        demo = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(demo)
        with tempfile.TemporaryDirectory() as directory:
            silent = Path(directory) / "silent.ts"
            silent.write_bytes(b"export {};\n")
            with self.assertRaises(SystemExit) as refused:
                demo.render(dict(STATUSLINE_REQUEST), 100, runner=silent)
        self.assertIn("printed nothing", str(refused.exception))
        self.assertIn("silent.ts", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
