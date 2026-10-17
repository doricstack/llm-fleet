#!/usr/bin/env python3
"""The mutation harness, run against a small repository it builds itself.

What it must never do is report a mutant as killed when nothing tested it: a
mutant whose text stopped matching, a suite that was red before any edit, or a
run that left the checkout mutated would each make a score that means nothing.

Run with: python3 tests/test_mutation_check.py -v
"""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "mutation-check.py"
SPEC = importlib.util.spec_from_file_location("mutation_check", SCRIPT)
mutation_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mutation_check)

SOURCE = "def add(a, b):\n    return a + b\n\n\ndef unused(a):\n    return a\n"
SUITE = ("import sys\nsys.path.insert(0, '.')\nfrom calc import add\n"
         "sys.exit(0 if add(2, 3) == 5 else 1)\n")


class HarnessCase(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="mutation-repo-"))
        self.addCleanup(shutil.rmtree, self.repo, True)
        (self.repo / "calc.py").write_text(SOURCE, encoding="utf-8")
        (self.repo / "check.py").write_text(SUITE, encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)

    def declare(self, mutants):
        path = self.repo / "mutants.json"
        path.write_text(json.dumps({"mutants": mutants}), encoding="utf-8")
        return path

    def mutant(self, identifier, find, replace, **extra):
        return {"id": identifier, "file": "calc.py", "find": find, "replace": replace,
                "suite": ["{python}", "check.py"], **extra}

    def run_harness(self, mutants, *extra):
        path = self.declare(mutants)
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.repo),
                               "--mutants", str(path), *extra],
                              capture_output=True, text=True, check=False)


class OutcomeTests(HarnessCase):
    def test_a_mutant_the_suite_notices_is_killed(self):
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("killed     plus", result.stdout)
        self.assertIn("1 mutants: 1 killed, 0 equivalent, 0 survived, 0 errors", result.stdout)

    def test_a_survivor_fails_the_run_and_names_why_it_matters(self):
        result = self.run_harness([self.mutant("dead", "return a\n", "return -a\n",
                                               why="Nothing calls it.")])
        self.assertEqual(result.returncode, 1)
        self.assertIn("survived   dead  Nothing calls it.", result.stdout)

    def test_a_survivor_declared_equivalent_passes_with_its_reason(self):
        result = self.run_harness([self.mutant("dead", "return a\n", "return -a\n",
                                               equivalent="Unreachable by design.")])
        self.assertEqual(result.returncode, 0)
        self.assertIn("equivalent dead  Unreachable by design.", result.stdout)

    def test_an_empty_equivalence_reason_is_no_reason(self):
        result = self.run_harness([self.mutant("dead", "return a\n", "return -a\n",
                                               equivalent="  ")])
        self.assertEqual(result.returncode, 1)

    def test_text_that_no_longer_matches_is_an_error_not_a_kill(self):
        result = self.run_harness([self.mutant("gone", "a * b", "a / b")])
        self.assertEqual(result.returncode, 1)
        self.assertIn("error      gone  the text occurs 0 times, not once", result.stdout)

    def test_text_that_matches_twice_is_an_error(self):
        result = self.run_harness([self.mutant("twice", "return", "yield")])
        self.assertIn("occurs 2 times", result.stdout)
        self.assertEqual(result.returncode, 1)

    def test_a_file_not_in_the_tree_is_an_error(self):
        mutant = self.mutant("nowhere", "a", "b")
        mutant["file"] = "missing.py"
        result = self.run_harness([mutant])
        self.assertIn("the file is not in the tree", result.stdout)
        self.assertEqual(result.returncode, 1)


class SafetyTests(HarnessCase):
    def test_the_checkout_is_never_edited(self):
        before = (self.repo / "calc.py").read_bytes()
        self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual((self.repo / "calc.py").read_bytes(), before)

    def test_a_red_suite_stops_the_run_before_any_mutant(self):
        (self.repo / "calc.py").write_text(SOURCE.replace("a + b", "a * b"), encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a * b", "a - b")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("red before any mutant", result.stderr)
        self.assertNotIn("killed", result.stdout)

    def test_a_suite_that_overruns_its_time_is_not_a_kill(self):
        (self.repo / "slow.py").write_text("import time\ntime.sleep(5)\n", encoding="utf-8")
        mutant = self.mutant("plus", "a + b", "a - b")
        mutant["suite"] = ["{python}", "slow.py"]
        result = self.run_harness([mutant], "--timeout", "0.5")
        self.assertEqual(result.returncode, 2)

    def test_a_runtime_placeholder_is_filled_from_the_command_line(self):
        mutant = self.mutant("plus", "a + b", "a - b")
        mutant["suite"] = ["{node}", "check.py"]
        result = self.run_harness([mutant], "--node", sys.executable)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("killed     plus", result.stdout)

    def test_files_not_yet_added_are_copied(self):
        (self.repo / "extra.py").write_text("VALUE = 5\n", encoding="utf-8")
        (self.repo / "check.py").write_text(
            "import sys\nsys.path.insert(0, '.')\nfrom extra import VALUE\nfrom calc import add\n"
            "sys.exit(0 if add(2, 3) == VALUE else 1)\n", encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 0, result.stderr)


class DeclarationTests(HarnessCase):
    def test_declarations_that_cannot_produce_a_result_are_refused(self):
        cases = {
            "twice declared": [self.mutant("x", "a + b", "a - b"),
                               self.mutant("x", "a + b", "a * b")],
            "outside the tree": [{**self.mutant("x", "a", "b"), "file": "../calc.py"}],
            "changes nothing": [self.mutant("x", "a + b", "a + b")],
            "no suite": [{**self.mutant("x", "a + b", "a - b"), "suite": []}],
            "no mutants": [],
        }
        for name, mutants in cases.items():
            with self.subTest(name):
                self.assertEqual(self.run_harness(mutants).returncode, 2)

    def test_only_runs_the_named_mutants_and_refuses_an_unknown_name(self):
        mutants = [self.mutant("plus", "a + b", "a - b"),
                   self.mutant("dead", "return a\n", "return -a\n")]
        result = self.run_harness(mutants, "--only", "plus")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("dead", result.stdout)
        self.assertEqual(self.run_harness(mutants, "--only", "nope").returncode, 2)

    def test_the_repository_declarations_load(self):
        mutants = mutation_check.load(ROOT / "mutation" / "mutants.json")
        self.assertGreater(len(mutants), 0)
        for mutant in mutants:
            self.assertTrue((ROOT / mutant["file"]).is_file(), mutant["id"])
            text = (ROOT / mutant["file"]).read_text(encoding="utf-8")
            self.assertEqual(text.count(mutant["find"]), 1, mutant["id"])


class VersionTokenTests(HarnessCase):
    """A declaration may name the shipped version instead of writing it.

    A mutant whose text holds the version breaks on every release that raises
    it, and the harness is right to refuse a declaration whose text has moved.
    The token is what lets the declaration stand across a bump.
    """

    def manifest(self, version):
        folder = self.repo / "plugins" / "fleet" / ".claude-plugin"
        folder.mkdir(parents=True, exist_ok=True)
        document = {"name": "x"} if version is None else {"name": "x", "version": version}
        (folder / "plugin.json").write_text(json.dumps(document), encoding="utf-8")

    def versioned(self, version):
        """A tree whose source names a version, and the suite that asserts it."""
        self.manifest(version)
        (self.repo / "calc.py").write_text('VERSION = "{0}"\n'.format(version) + SOURCE,
                                           encoding="utf-8")
        (self.repo / "check.py").write_text(
            "import sys\nsys.path.insert(0, '.')\nimport calc\n"
            "sys.exit(0 if calc.add(2, 3) == 5 and calc.VERSION == '{0}' else 1)\n"
            .format(version), encoding="utf-8")
        return [self.mutant("version", '"{version}"', '"0.0.0"')]

    def test_the_token_is_filled_from_the_manifest(self):
        self.manifest("9.9.9")
        mutants = mutation_check.load(self.declare(self.versioned("9.9.9")), self.repo)
        self.assertEqual((mutants[0]["find"], mutants[0]["replace"]),
                         ('"9.9.9"', '"0.0.0"'))

    def test_one_declaration_stands_across_a_version_bump(self):
        # The same declaration, two releases: the point of the token is that the
        # number moves in the manifest alone.
        for version in ("9.9.9", "9.9.10"):
            with self.subTest(version=version):
                result = self.run_harness(self.versioned(version))
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("killed     version", result.stdout)

    def test_a_token_written_with_an_escape_is_still_a_token(self):
        # `{version}` decodes to the same text. Read from the file's bytes
        # the token would go unfilled, and the mutant would be reported as one
        # whose text had moved rather than as the missing manifest it is.
        self.manifest("9.9.9")
        self.versioned("9.9.9")
        # Written as file text, because the escape has to reach the file: a
        # string Python hands to json.dumps would be written as a brace.
        path = self.repo / "mutants.json"
        path.write_text(
            json.dumps({"mutants": [self.mutant("version", "PLACEHOLDER", '"0.0.0"')]})
            .replace('"PLACEHOLDER"', '"\\u007bversion}"'), encoding="utf-8")
        mutants = mutation_check.load(path, self.repo)
        self.assertEqual(mutants[0]["find"], "9.9.9")

    def test_a_token_with_no_manifest_is_an_error(self):
        result = self.run_harness([self.mutant("version", '"{version}"', '"0.0.0"')])
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot read", result.stderr + result.stdout)

    def test_a_manifest_carrying_no_version_is_an_error(self):
        self.manifest(None)
        result = self.run_harness([self.mutant("version", '"{version}"', '"0.0.0"')])
        self.assertEqual(result.returncode, 2)
        self.assertIn("carries no version", result.stderr + result.stdout)

    def test_a_declaration_that_mutates_nothing_once_filled_is_refused(self):
        self.manifest("9.9.9")
        result = self.run_harness([self.mutant("same", '"{version}"', '"9.9.9"')])
        self.assertEqual(result.returncode, 2)
        self.assertIn("changes nothing", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
