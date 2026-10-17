#!/usr/bin/env python3
"""The Python suite's report: what it holds, and what it says about a run.

The gate this repository's affected-test runner feeds reads a report rather than
an exit code, because an exit code cannot tell a suite that ran and passed from
one that selected nothing at all. unittest writes no report, and this repository
takes no dependency to get one, so the report is written here. That makes this
file the definition of a contract, and the cases below are about the two things
a report is for: saying what each test did, and saying it in a document that
stays well formed whatever a test's message contains.

Each case drives the real script over a throwaway suite on disk, so the exit
code, the document and the summary are all the ones a caller would get.

Run with: python3 tests/test_test_report.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "test-report.py"

# A suite per case, and each one is written to disk rather than mocked: the
# script's whole job is to run a real suite and read the result object unittest
# produces, so a stub result would prove nothing about it.
PASSING = """
import unittest


class Passing(unittest.TestCase):
    def test_one(self):
        self.assertEqual(1 + 1, 2)

    def test_two(self):
        self.assertTrue(True)
"""

FAILING = """
import unittest


class Failing(unittest.TestCase):
    def test_bad(self):
        self.assertEqual(1, 2, "one is not two")

    def test_good(self):
        self.assertTrue(True)
"""

ERRORING = """
import unittest


class Erroring(unittest.TestCase):
    def test_raises(self):
        raise RuntimeError("the fixture fell over")
"""

SKIPPING = """
import unittest


class Skipping(unittest.TestCase):
    @unittest.skip("no reason to run this")
    def test_skipped(self):
        pass

    def test_runs(self):
        self.assertTrue(True)
"""

# A message holding the characters that end an element or an attribute. A
# report is read by machines, and one that stops parsing the moment a test
# fails with a comparison of two dicts is worse than no report.
MARKUP = """
import unittest


class Markup(unittest.TestCase):
    def test_markup(self):
        self.assertEqual("<a> & </b>", "\\"quoted\\" & 'single'", "a < b && c > d")

    def test_control(self):
        raise ValueError("a tab\\there and a newline\\nthere")
"""

# A suite that fails inside a loop. unittest records these without going through
# the failure hooks: `addSubTest` appends to the failures list directly, so a
# writer that listens only for `addFailure` hears nothing at all and reports a
# red run as a clean one.
SUBTESTS = """
import unittest


class Subtests(unittest.TestCase):
    def test_each(self):
        for value in (1, 2):
            with self.subTest(value=value):
                self.assertEqual(value, 1)

    def test_raised(self):
        with self.subTest(step="boom"):
            raise RuntimeError("the fixture fell over inside a subtest")
"""

UNICODE = """
import unittest


class Unicode(unittest.TestCase):
    def test_raised(self):
        raise ValueError("a face \\U0001f600 and what comes after")
"""

CONTROL_CHARACTERS = """
import unittest


class Control(unittest.TestCase):
    def test_control(self):
        raise ValueError("color: \\x1b[31mred\\x1b[0m and a bell \\x07")
"""


def attr(node: ElementTree.Element, name: str) -> str:
    """An attribute as a string, so a case asserts on a value and not on None."""
    return node.get(name) or ""


def child(node: ElementTree.Element, tag: str) -> ElementTree.Element:
    """The named child, refused rather than returned as None.

    A case that asked for the element and got nothing is a case about a missing
    element, and the refusal says so instead of reading as a type complaint.
    """
    found = node.find(tag)
    if found is None:
        raise AssertionError("{0} has no {1} child: {2}".format(
            attr(node, "name"), tag, ElementTree.tostring(node)))
    return found


def isolated(**overrides: str) -> dict[str, str]:
    """This machine's environment without a report destination, plus what a case sets.

    Under a gate the selection exports where the Python report goes. A case that
    inherited it would write its sample suite's report over the real one.
    """
    env = {key: value for key, value in os.environ.items() if key != "FLEET_JUNIT_XML"}
    env.update(overrides)
    return env


def run_report(directory: Path, out: Path | None,
               env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    args = [sys.executable, str(SCRIPT), "--directory", str(directory)]
    if out is not None:
        args += ["--junit-xml", str(out)]
    return subprocess.run(args, capture_output=True, text=True, check=False,
                          env=env if env is not None else isolated())


class ReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fleet-report-"))
        self.addCleanup(self._clean)
        self.out = self.root / "report.xml"

    def _clean(self) -> None:
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def suite(self, source: str) -> Path:
        directory = self.root / "suite"
        directory.mkdir(exist_ok=True)
        (directory / "test_sample.py").write_text(source, encoding="utf-8")
        return directory

    def written(self, source: str) -> tuple[subprocess.CompletedProcess[str],
                                            ElementTree.Element]:
        result = run_report(self.suite(source), self.out)
        self.assertTrue(self.out.is_file(), result.stdout + result.stderr)
        return result, ElementTree.parse(self.out).getroot()

    def test_the_destination_can_come_from_the_environment(self) -> None:
        # A gate names the destination in the environment, so the path is never
        # spliced into a command line where a shell or make could expand it.
        result = run_report(self.suite(PASSING), None,
                            env=isolated(FLEET_JUNIT_XML=str(self.out)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        root = ElementTree.parse(self.out).getroot()
        self.assertEqual(root.get("tests"), "2")
        self.assertEqual(root.get("failures"), "0")

    def test_an_explicit_destination_wins_over_the_environment(self) -> None:
        elsewhere = self.root / "elsewhere.xml"
        result = run_report(self.suite(PASSING), self.out,
                            env=isolated(FLEET_JUNIT_XML=str(elsewhere)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.out.is_file())
        self.assertFalse(elsewhere.exists())

    def test_no_destination_anywhere_writes_nothing(self) -> None:
        result = run_report(self.suite(PASSING), None)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["suite"])

    def test_a_passing_run_reports_one_case_each_and_exits_clean(self) -> None:
        result, root = self.written(PASSING)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(root.get("tests"), "2")
        self.assertEqual(root.get("failures"), "0")
        self.assertEqual(root.get("errors"), "0")
        names = sorted(attr(case, "name") for case in root.iter("testcase"))
        self.assertEqual(names, ["test_one", "test_two"])

    def test_a_failure_is_a_failure_element_and_a_nonzero_exit(self) -> None:
        # The exit code is what a caller acts on, and the element is what a
        # reader reads. A report that carried the element but left the exit code
        # clean would let a red suite through.
        result, root = self.written(FAILING)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(root.get("tests"), "2")
        self.assertEqual(root.get("failures"), "1")
        self.assertEqual(root.get("errors"), "0")
        failed = [case for case in root.iter("testcase") if case.find("failure") is not None]
        self.assertEqual([attr(case, "name") for case in failed], ["test_bad"])
        self.assertIn("one is not two", attr(child(failed[0], "failure"), "message"))

    def test_an_error_is_an_error_element_rather_than_a_failure(self) -> None:
        # A test that raised is not a test that asserted: a reader triaging a
        # report treats the two differently, so the document has to.
        result, root = self.written(ERRORING)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(root.get("failures"), "0")
        self.assertEqual(root.get("errors"), "1")
        case = next(iter(root.iter("testcase")))
        self.assertIn("the fixture fell over", attr(child(case, "error"), "message"))

    def test_a_skip_is_counted_as_a_skip_and_not_as_a_pass(self) -> None:
        result, root = self.written(SKIPPING)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(root.get("tests"), "2")
        self.assertEqual(root.get("skipped"), "1")
        case = next(case for case in root.iter("testcase")
                    if case.get("name") == "test_skipped")
        self.assertIsNotNone(case.find("skipped"))

    def test_a_message_holding_markup_leaves_the_document_parseable(self) -> None:
        # Parsed, not grepped: the assertion is that the document survived, and
        # a substring check would pass over a document that no longer parses.
        result, root = self.written(MARKUP)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(root.get("tests"), "2")
        self.assertEqual(root.get("failures"), "1")
        self.assertEqual(root.get("errors"), "1")
        text = " ".join(node.text or "" for node in root.iter())
        self.assertIn("<a> & </b>", text)
        self.assertIn("a < b && c > d", text)

    def test_a_subtest_failure_reaches_the_report_and_the_exit_code(self) -> None:
        # The failure mode this case exists for is a report that says the run
        # was clean while the run returns red, which is worse than any report
        # being absent. unittest records a subtest failure without calling the
        # failure hook, so a writer listening only for the hook hears nothing.
        result, root = self.written(SUBTESTS)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(int(attr(root, "failures")), 1, ElementTree.tostring(root))
        self.assertEqual(int(attr(root, "errors")), 1, ElementTree.tostring(root))
        # One case per failing subtest, and the count is the number of cases:
        # a subtest that passed is not a result anybody acts on, and a parent
        # whose subtest failed is reported through the subtest rather than
        # beside it.
        cases = list(root.iter("testcase"))
        self.assertEqual(int(attr(root, "tests")), len(cases), ElementTree.tostring(root))
        self.assertEqual(len(cases), 2, ElementTree.tostring(root))
        names = " ".join(attr(case, "name") for case in cases)
        # The failing subtest is named, not just counted: a reader has to be
        # able to tell which turn of the loop failed.
        self.assertIn("value=2", names)
        self.assertIn("step='boom'", names)

    def test_a_message_holding_a_control_character_leaves_the_document_parseable(self) -> None:
        # Terminal color arrives in assertion messages all the time, and a
        # control character that is not legal in XML stops the document
        # parsing. The assertion is a parse, so a document that only looked
        # right would fail here.
        _, root = self.written(CONTROL_CHARACTERS)
        self.assertEqual(int(attr(root, "errors")), 1, ElementTree.tostring(root))
        text = " ".join(node.text or "" for node in root.iter())
        self.assertIn("color:", text)
        for character in ("\x1b", "\x07", "\x00"):
            self.assertNotIn(character, text)

    def test_a_message_above_the_basic_plane_is_kept(self) -> None:
        # Dropping what XML cannot hold is right; dropping what it can is a
        # filter that ate the last plane, and a message with an emoji in it is
        # how that shows up.
        _, root = self.written(UNICODE)
        text = " ".join(node.text or "" for node in root.iter())
        self.assertIn("\U0001f600", text)
        self.assertIn("after", text)

    def test_every_case_carries_the_class_it_came_from(self) -> None:
        # A report whose cases cannot be traced back to a class is a list of
        # names, and two classes with a test of the same name are one entry.
        _, root = self.written(PASSING)
        for case in root.iter("testcase"):
            self.assertIn("Passing", attr(case, "classname"))

    def test_a_run_that_collects_nothing_still_writes_a_report(self) -> None:
        # The whole reason the gate wants a report: nothing collected and
        # everything passed are the same exit code, and they are not the same
        # result. The document says zero, which is what tells them apart.
        directory = self.root / "empty"
        directory.mkdir()
        result = run_report(directory, self.out)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.out.is_file(), result.stdout + result.stderr)
        root = ElementTree.parse(self.out).getroot()
        self.assertEqual(root.get("tests"), "0")
        self.assertEqual(root.get("failures"), "0")

    def test_no_report_is_written_unless_one_was_asked_for(self) -> None:
        # A plain run is the common case and must leave nothing behind.
        result = run_report(self.suite(PASSING), None)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.out.exists())
        self.assertIn("2 tests", result.stdout)

    def test_the_summary_states_the_counts_it_found(self) -> None:
        # Read against the document, so a summary that disagrees with the
        # report it just wrote is caught here rather than by whoever trusts it.
        result, root = self.written(FAILING)
        self.assertIn("1 failed", result.stdout)
        self.assertEqual(root.get("tests"), "2")

    def test_a_directory_that_is_not_there_is_refused(self) -> None:
        result = run_report(self.root / "absent", self.out)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("absent", result.stderr)
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
