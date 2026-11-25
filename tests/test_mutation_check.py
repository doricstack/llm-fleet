#!/usr/bin/env python3
"""The mutation harness, run against a small repository it builds itself.

What it must never do is report a mutant as killed when nothing tested it: a
mutant whose text stopped matching, a suite that was red before any edit, or a
run that left the checkout mutated would each make a score that means nothing.

Run with: python3 tests/test_mutation_check.py -v
"""

import importlib.util
import json
import os
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
        # The harness writes its report as UTF-8, so the test reads it as
        # UTF-8 whatever this machine's locale is. Found by review, 2026-11-23.
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.repo),
                               "--mutants", str(path), *extra],
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace", check=False)


class OutcomeTests(HarnessCase):
    def test_a_mutant_the_suite_notices_is_killed(self):
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("killed     plus", result.stdout)
        self.assertIn("killed     plus\n", result.stdout)
        self.assertIn("1 mutants: 1 killed, 0 equivalent, 0 survived, 0 errors", result.stdout)

    def test_a_mutant_whose_suite_hangs_is_a_kill_that_says_why(self):
        # A timeout counts as a kill, because the mutant stopped the suite; the
        # reason stays in the row so a hang caused by the machine's load does
        # not read as an ordinary kill with nothing behind it.
        mutant = self.mutant("hang", "return a + b", "while True:\n        a += 1")
        result = self.run_harness([mutant], "--timeout", "2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("killed     hang  the suite did not finish within 2s", result.stdout)

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

    def test_a_red_suite_says_what_it_said(self):
        # A gate that reports "red" without the suite's own words costs a
        # slice: on 2026-11-22 the copied tree ran clean outside the gate and
        # the failing test's name was never printed.
        (self.repo / "check.py").write_text(
            "import sys\nprint('the fixture says why', file=sys.stderr)\nsys.exit(1)\n",
            encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("red before any mutant", result.stderr)
        self.assertIn("the fixture says why", result.stderr)

    def test_a_red_suite_that_also_wrote_a_warning_keeps_its_failing_test(self):
        # stdout usually names the failing test and stderr may still hold a
        # warning; reading stderr in place of stdout dropped the name, and a
        # combined tail let long stderr push the name out.
        warnings = "".join("print('warning %d', file=sys.stderr)\n" % n for n in range(25))
        (self.repo / "check.py").write_text(
            "import sys\nprint('FAILED test_the_thing')\n" + warnings + "sys.exit(1)\n",
            encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("FAILED test_the_thing", result.stderr)
        self.assertIn("warning 24", result.stderr)

    def test_a_failing_test_name_survives_a_long_tail_of_its_own_stream(self):
        # Eleven lines on one stream put the failing test's name outside a
        # ten-line tail; the tail alone then reported only the counts below it.
        tail = "".join("print('%d')\n" % n for n in range(10))
        (self.repo / "check.py").write_text(
            "import sys\nprint('FAILED test_receipt')\n" + tail + "sys.exit(1)\n",
            encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("FAILED test_receipt", result.stderr)
        self.assertIn("\n9", result.stderr)

    def test_unittest_failure_lines_are_kept_ahead_of_the_tail(self):
        # unittest names a failure `FAIL:` and an error `ERROR:`, which the
        # pytest-shaped filter missed, and it dropped a name past the third
        # that fell outside the tail. Twelve names must all survive.
        names = "".join("print('FAIL: test_case_%d')\nprint('filler %d')\n" % (n, n)
                        for n in range(12))
        (self.repo / "check.py").write_text(
            "import sys\n" + names + "print('Ran 12 tests')\nsys.exit(1)\n",
            encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 2)
        for n in (0, 3, 11):
            self.assertIn("FAIL: test_case_%d" % n, result.stderr)

    def test_javascript_failure_lines_are_kept_ahead_of_the_tail(self):
        # The javascript runner names a failed case in TAP (`not ok 3 - name`)
        # or with a cross; neither is a Python shape, and a long baseline
        # pushed both out of the ten-line tail.
        names = "".join("print('not ok %d - case_%d')\nprint('filler %d')\n" % (n, n, n)
                        for n in range(12))
        # The runner's output is read as UTF-8, so the fixture writes it as
        # UTF-8: on Windows a redirected stdout is the locale's code page, and
        # the cross it printed there was an encoding error instead of a line.
        (self.repo / "check.py").write_text(
            "import sys\nsys.stdout.reconfigure(encoding='utf-8')\n"
            + names + "print('✖ case_after')\nsys.exit(1)\n",
            encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("not ok 3 - case_3", result.stderr)
        self.assertIn("not ok 11 - case_11", result.stderr)
        self.assertIn("✖ case_after", result.stderr)

    def test_the_report_keeps_a_cross_whatever_the_machine_s_encoding_says(self):
        # The report re-emits the line the runner wrote, and a console whose
        # code page cannot hold the cross escaped it: the caller then read the
        # escape instead of the name. The report is written as UTF-8 whatever
        # the locale says. Found by review, 2026-11-23.
        (self.repo / "check.py").write_text(
            "import sys\nsys.stdout.reconfigure(encoding='utf-8')\n"
            "print('not ok 0 - case_0')\nprint('✖ case_after')\nsys.exit(1)\n",
            encoding="utf-8")
        path = self.declare([self.mutant("plus", "a + b", "a - b")])
        environment = dict(os.environ, PYTHONIOENCODING="ascii", LC_ALL="C", LANG="C")
        completed = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.repo),
                                    "--mutants", str(path)], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", env=environment,
                                   check=False)
        self.assertIn("✖ case_after", completed.stderr)

    def test_a_retry_log_is_not_mistaken_for_a_named_failure(self):
        # A bare `ERROR ` or `FAILED ` in the middle of a log line is a retry
        # message, not a test's name. Reading those as names kept a hundred of
        # them ahead of the tail and pushed the real failure out. A line that
        # starts with the marker, as pytest writes it, is still a name. Found
        # by review, 2026-11-23.
        (self.repo / "check.py").write_text(
            "import sys\n"
            "print('ERROR tests/test_api.py::test_setup - ValueError: boom')\n"
            + "".join("print('retry %d: ERROR upstream, FAILED attempt')\n" % n
                      for n in range(40))
            + "".join("print('filler %d')\n" % n for n in range(15))
            + "sys.exit(1)\n",
            encoding="utf-8")
        result = self.run_harness([self.mutant("plus", "a + b", "a - b")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("ERROR tests/test_api.py::test_setup - ValueError: boom", result.stderr)
        self.assertNotIn("retry 0:", result.stderr)

    def test_a_suite_that_overruns_its_time_is_not_a_kill(self):
        (self.repo / "slow.py").write_text("import time\ntime.sleep(5)\n", encoding="utf-8")
        mutant = self.mutant("plus", "a + b", "a - b")
        mutant["suite"] = ["{python}", "slow.py"]
        result = self.run_harness([mutant], "--timeout", "0.5")
        self.assertEqual(result.returncode, 2)
        self.assertIn("did not finish within", result.stderr)

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
            "bare node": [{**self.mutant("x", "a + b", "a - b"), "suite": ["node", "--test", "t.ts"]}],
            "bare python3": [{**self.mutant("x", "a + b", "a - b"), "suite": ["python3", "check.py"]}],
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
        folder = self.repo / "plugins" / "llm-fleet" / ".claude-plugin"
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


@unittest.skipIf(shutil.which("node") is None, "no Node on PATH to run a TypeScript suite")
class NodeImportTests(HarnessCase):
    """A Node suite runs with the resolver the plugin's `./name.js` imports need.

    The plugin imports its siblings as `./name.js`, the form the host's strict
    check accepts, and Node does not find `name.ts` behind that name by itself.
    The harness starts every `{node}` suite with the repository's resolver, so
    a mutated plugin module is measured rather than failing to load.
    """

    def setUp(self):
        super().setUp()
        (self.repo / "components").mkdir()
        shutil.copy2(ROOT / "components" / "resolve.ts", self.repo / "components" / "resolve.ts")
        (self.repo / "sum.ts").write_bytes(
            b"export function add(a: number, b: number): number {\n  return a + b;\n}\n")
        (self.repo / "uses.ts").write_bytes(b'export { add } from "./sum.js";\n')
        (self.repo / "uses.test.ts").write_bytes(
            b'import { test } from "node:test";\nimport assert from "node:assert/strict";\n'
            b'import { add } from "./uses.ts";\n'
            b'test("adds", () => { assert.equal(add(2, 3), 5); });\n')
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)

    def node_mutant(self):
        return {"id": "node-add", "file": "sum.ts", "find": "return a + b;",
                "replace": "return a - b;", "suite": ["{node}", "--test", "uses.test.ts"]}

    def test_a_node_suite_starts_with_the_resolver(self):
        self.assertEqual(mutation_check.command(["{node}", "--test", "a.test.ts"], self.repo),
                         [mutation_check.RUNTIMES["{node}"], "--import",
                          "./components/resolve.ts", "--test", "a.test.ts"])

    def test_a_tree_without_the_resolver_runs_node_as_written(self):
        (self.repo / "components" / "resolve.ts").unlink()
        self.assertEqual(mutation_check.command(["{node}", "--test", "a.test.ts"], self.repo),
                         [mutation_check.RUNTIMES["{node}"], "--test", "a.test.ts"])

    def test_a_python_suite_is_left_as_written(self):
        self.assertEqual(mutation_check.command(["{python}", "check.py"], self.repo),
                         [mutation_check.RUNTIMES["{python}"], "check.py"])

    def test_a_mutant_behind_a_js_import_is_killed(self):
        result = self.run_harness([self.node_mutant()])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("killed     node-add", result.stdout)


BOUND = "MUTATION_SUITE_TIMEOUT"


SLOW_SUITE = (b"import sys, time\nsys.path.insert(0, '.')\nfrom calc import add\n"
              b"time.sleep(1.0)\nsys.exit(0 if add(2, 3) == 5 else 1)\n")


@unittest.skipIf(shutil.which("make") is None, "no make on PATH to start the harness")
class SuiteBoundTests(unittest.TestCase):
    """The suite bound is set through make, which is how the gate starts every slice.

    The harness bounds each suite run at 300s. The heavy-run slot runs the gate at
    a low priority, and under load a real-git suite that takes a minute alone
    took 376s there, so the slice was red before any mutant for a reason the
    change under test had nothing to do with. The gate hands its environment to
    the make call that runs a slice, so the bound is read from there.

    Each case starts this repository's own Makefile and harness in a small git
    tree of its own, whose suite takes a second: the harness lists what git
    tracks, and a measured copy of this repository is not a git checkout.
    """

    MUTANT = "slow-add"

    def setUp(self):
        self.tree = Path(tempfile.mkdtemp(prefix="mutation-bound-"))
        self.addCleanup(shutil.rmtree, self.tree, True)
        (self.tree / "make").mkdir()
        (self.tree / "scripts").mkdir()
        (self.tree / "mutation").mkdir()
        shutil.copy2(ROOT / "Makefile", self.tree / "Makefile")
        for fragment in (ROOT / "make").glob("*.mk"):
            shutil.copy2(fragment, self.tree / "make" / fragment.name)
        shutil.copy2(SCRIPT, self.tree / "scripts" / SCRIPT.name)
        (self.tree / "calc.py").write_bytes(SOURCE.encode("utf-8"))
        (self.tree / "check.py").write_bytes(SLOW_SUITE)
        declaration = {"mutants": [{"id": self.MUTANT, "file": "calc.py", "find": "return a + b",
                                    "replace": "return a - b",
                                    "suite": ["{python}", "check.py"]}]}
        (self.tree / "mutation" / "mutants.json").write_bytes(
            json.dumps(declaration).encode("utf-8"))
        subprocess.run(["git", "init", "-q"], cwd=self.tree, check=True)
        subprocess.run(["git", "add", "."], cwd=self.tree, check=True)

    def start(self, *assignments: str, bound: str | None = None) -> subprocess.CompletedProcess:
        environment = {name: value for name, value in os.environ.items() if name != BOUND}
        if bound is not None:
            environment[BOUND] = bound
        return subprocess.run(["make", "--no-print-directory", "script-mutation-check",
                               "MUTANTS=" + self.MUTANT, *assignments], cwd=self.tree,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=600, env=environment, check=False)

    def test_a_suite_past_the_bound_is_refused_before_any_mutant(self):
        result = self.start(BOUND + "=0.2")
        said = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, said)
        self.assertIn("the suite is red before any mutant", said)
        self.assertIn("the suite did not finish within 0.2s", said)
        self.assertNotIn("killed", said)

    def test_the_bound_is_read_from_the_environment_the_gate_hands_on(self):
        result = self.start(bound="0.2")
        said = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, said)
        self.assertIn("the suite did not finish within 0.2s", said)
        self.assertNotIn("killed", said)

    def test_without_a_bound_the_harness_default_holds(self):
        result = self.start()
        said = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, said)
        self.assertIn("killed     " + self.MUTANT, said)
        self.assertNotIn("--timeout", said)

    def test_a_bound_that_is_not_a_number_is_refused(self):
        result = self.start(BOUND + "=soon")
        said = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0, said)
        self.assertIn("invalid float value: 'soon'", said)
        self.assertNotIn("killed", said)


if __name__ == "__main__":
    unittest.main()
