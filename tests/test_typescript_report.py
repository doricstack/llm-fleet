#!/usr/bin/env python3
"""The TypeScript runner's report: written where asked, counted as the gate counts.

A gate decides from a JUnit report, because an exit code cannot tell a run that
passed from one that selected nothing. Node writes its test cases at the top of
its own report with no suite round them, and the gate's merge keeps suites, so
the runner wraps each file's cases in one suite named for the file.

The cases run real suites through a real Node, written into a throwaway folder;
without Node 22.6 they are skipped and say why.

Run with: python3 tests/test_typescript_report.py
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "typescript-suite.py"


def load_runner():
    specification = importlib.util.spec_from_file_location("typescript_suite", RUNNER)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


NODE, NODE_DETAIL = load_runner().node_runtime()


def isolated(**overrides: str) -> dict[str, str]:
    """This machine's environment without a report folder, plus what a case sets.

    The selection that runs this suite under a gate exports the folder its
    reports go to. A case that inherited it would write its throwaway suite's
    report into that folder, and the gate would count those cases as the
    repository's own.
    """
    env = {key: value for key, value in os.environ.items() if key != "FLEET_TS_JUNIT_DIR"}
    env.update(overrides)
    return env

PASSING = """import assert from "node:assert/strict";
import { test } from "node:test";
test("one is one", () => { assert.equal(1, 1); });
test("two is two", () => { assert.equal(2, 2); });
test("later", { skip: "not yet" }, () => {});
"""

FAILING = """import assert from "node:assert/strict";
import { test } from "node:test";
test("one is one", () => { assert.equal(1, 1); });
test("one is two", () => { assert.equal(1, 2); });
"""


@unittest.skipIf(NODE is None, "Node cannot run TypeScript here: {0}".format(NODE_DETAIL))
class ReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_suite(self, body: str, report: Path | None) -> subprocess.CompletedProcess[str]:
        suite = self.root / "case.test.ts"
        suite.write_text(body, encoding="utf-8")
        argv = [sys.executable, str(RUNNER), "--suite", str(suite)]
        if report is not None:
            argv += ["--junit", str(report)]
        return subprocess.run(argv, capture_output=True, text=True, check=False,
                              env=isolated())

    def cases(self, report: Path) -> list[ElementTree.Element]:
        root = ElementTree.fromstring(report.read_text(encoding="utf-8"))
        return list(root.iter("testcase"))

    def test_a_passing_suite_writes_one_suite_holding_every_case(self) -> None:
        report = self.root / "out" / "fleet-ts-case.xml"
        result = self.run_suite(PASSING, report)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        root = ElementTree.fromstring(report.read_text(encoding="utf-8"))
        suites = list(root.iter("testsuite"))
        # One suite, so the gate's merge, which keeps suites, keeps the cases.
        self.assertEqual(len(suites), 1)
        self.assertEqual(suites[0].get("name"), str(self.root / "case.test.ts"))
        self.assertEqual(suites[0].get("tests"), "3")
        self.assertEqual(suites[0].get("failures"), "0")
        self.assertEqual(suites[0].get("skipped"), "1")
        names = sorted(str(case.get("name")) for case in self.cases(report))
        self.assertEqual(names, ["later", "one is one", "two is two"])
        skipped = [case for case in self.cases(report) if case.find("skipped") is not None]
        self.assertEqual([case.get("name") for case in skipped], ["later"])
        # The run still prints what a person reads, not the report.
        self.assertIn("passed under", result.stdout)
        self.assertNotIn("<testsuite", result.stdout)

    def test_a_failing_suite_writes_its_failure_and_exits_failed(self) -> None:
        report = self.root / "fleet-ts-case.xml"
        result = self.run_suite(FAILING, report)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        failed = [case.get("name") for case in self.cases(report)
                  if case.find("failure") is not None]
        self.assertEqual(failed, ["one is two"])
        suite = next(ElementTree.fromstring(report.read_text(encoding="utf-8")).iter("testsuite"))
        self.assertEqual(suite.get("failures"), "1")
        self.assertEqual(suite.get("tests"), "2")

    def test_no_destination_writes_no_report(self) -> None:
        result = self.run_suite(PASSING, None)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["case.test.ts"])

    def test_a_relative_destination_is_read_from_where_the_run_was_started(self) -> None:
        # Node runs from the repository root while the caller may stand anywhere:
        # a relative path checked against one folder and written to the other
        # passed tests would read as no report.
        suite = self.root / "case.test.ts"
        suite.write_text(PASSING, encoding="utf-8")
        result = subprocess.run([sys.executable, str(RUNNER), "--suite", str(suite),
                                 "--junit", "out.xml"], capture_output=True, text=True,
                                check=False, cwd=str(self.root), env=isolated())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.cases(self.root / "out.xml")), 3)
        self.assertFalse((ROOT / "out.xml").exists())
        self.assertFalse((ROOT / "out.xml.node").exists())

    def test_a_relative_report_folder_is_read_from_where_the_run_was_started(self) -> None:
        suite = self.root / "case.test.ts"
        suite.write_text(PASSING, encoding="utf-8")
        result = subprocess.run([sys.executable, str(RUNNER), "--suite", str(suite)],
                                capture_output=True, text=True, check=False, cwd=str(self.root),
                                env=isolated(FLEET_TS_JUNIT_DIR="reports"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        written = list((self.root / "reports").glob("fleet-ts-case-*.xml"))
        self.assertEqual(len(written), 1)
        self.assertEqual(len(self.cases(written[0])), 3)
        self.assertFalse((ROOT / "reports").exists())

    def test_a_suite_that_is_not_there_writes_no_report(self) -> None:
        # A report over a run that never started would be a clean report of
        # nothing, which is what a gate refuses to be handed.
        report = self.root / "fleet-ts-missing.xml"
        result = subprocess.run([sys.executable, str(RUNNER), "--suite",
                                 str(self.root / "absent.test.ts"), "--junit", str(report)],
                                capture_output=True, text=True, check=False, env=isolated())
        self.assertEqual(result.returncode, 2)
        self.assertFalse(report.exists())


@unittest.skipIf(NODE is None, "Node cannot run TypeScript here: {0}".format(NODE_DETAIL))
class FolderTests(unittest.TestCase):
    """Reports written into the folder a gate names, as every make target runs them."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / "reports"

    def run_in_folder(self, suite: Path) -> subprocess.CompletedProcess[str]:
        env = isolated(FLEET_TS_JUNIT_DIR=str(self.folder))
        return subprocess.run([sys.executable, str(RUNNER), "--suite", str(suite)],
                              capture_output=True, text=True, check=False, env=env)

    def test_suites_whose_flattened_names_meet_write_apart(self) -> None:
        # `a.b` and `a-b` flatten to one name; each report must keep its own.
        dotted = self.root / "a.b.test.ts"
        dashed = self.root / "a-b.test.ts"
        dotted.write_text(PASSING, encoding="utf-8")
        dashed.write_text(FAILING, encoding="utf-8")
        self.assertEqual(self.run_in_folder(dotted).returncode, 0)
        self.assertEqual(self.run_in_folder(dashed).returncode, 1)
        reports = sorted(self.folder.glob("*.xml"))
        self.assertEqual(len(reports), 2, reports)
        named = set()
        for path in reports:
            suite = ElementTree.fromstring(path.read_text(encoding="utf-8")).find("testsuite")
            self.assertIsNotNone(suite)
            named.add(suite.get("name") if suite is not None else None)
        self.assertEqual(named, {str(dotted), str(dashed)})
        # Nothing but the reports is left behind.
        self.assertEqual(sorted(path.suffix for path in self.folder.iterdir()), [".xml", ".xml"])

    def test_the_same_suite_run_twice_writes_one_report(self) -> None:
        suite = self.root / "case.test.ts"
        suite.write_text(PASSING, encoding="utf-8")
        self.run_in_folder(suite)
        self.run_in_folder(suite)
        self.assertEqual(len(list(self.folder.glob("*.xml"))), 1)

    def test_a_run_that_cannot_start_removes_the_last_clean_report(self) -> None:
        # The destination held a passing report from before. A run that dies
        # before Node writes anything must not leave that report to be counted.
        suite = self.root / "case.test.ts"
        suite.write_text(PASSING, encoding="utf-8")
        self.assertEqual(self.run_in_folder(suite).returncode, 0)
        self.assertEqual(len(list(self.folder.glob("*.xml"))), 1)
        suite.unlink()
        result = self.run_in_folder(suite)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(list(self.folder.glob("*.xml")), [])

    def stand_in(self, writes: str) -> Path:
        """A runtime that passes every suite and writes `writes` as its report."""
        node = self.root / "fake-node"
        node.write_text("#!/bin/sh\n"
                        "if [ \"$1\" = \"--version\" ]; then echo v26.5.0; exit 0; fi\n"
                        "for arg in \"$@\"; do case \"$arg\" in\n"
                        "  --test-reporter-destination=stdout) ;;\n"
                        "  --test-reporter-destination=*) " + writes + " ;;\n"
                        "esac; done\nexit 0\n", encoding="utf-8")
        node.chmod(0o755)
        return node

    def run_stand_in(self, node: Path) -> tuple[subprocess.CompletedProcess[str], Path]:
        suite = self.root / "case.test.ts"
        suite.write_text(PASSING, encoding="utf-8")
        report = self.root / "out.xml"
        result = subprocess.run([sys.executable, str(RUNNER), "--node", str(node),
                                 "--suite", str(suite), "--junit", str(report)],
                                capture_output=True, text=True, check=False, env=isolated())
        return result, report

    @unittest.skipIf(os.name == "nt", "a stand-in runtime is a shebang script, not runnable here")
    def test_a_passing_run_that_writes_no_report_fails(self) -> None:
        # A report was asked for and none came: the suite would vanish from the
        # gate's count while the run said it passed.
        result, report = self.run_stand_in(self.stand_in("true"))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("wrote no report", result.stderr)
        self.assertFalse(report.exists())

    @unittest.skipIf(os.name == "nt", "a stand-in runtime is a shebang script, not runnable here")
    def test_a_passing_run_that_writes_an_empty_report_fails(self) -> None:
        result, report = self.run_stand_in(
            self.stand_in(": > \"${arg#--test-reporter-destination=}\""))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("wrote no report", result.stderr)
        self.assertFalse(report.exists())
        self.assertFalse((self.root / "out.xml.node").exists())

    @unittest.skipIf(os.name == "nt", "a stand-in runtime is a shebang script, not runnable here")
    def test_a_passing_run_whose_report_holds_no_case_fails(self) -> None:
        # A report that parses and counts nothing says no test ran. Passed, the
        # suite would read as run while other suites' counts hid that it was not.
        result, report = self.run_stand_in(
            self.stand_in("printf '<testsuites/>' > \"${arg#--test-reporter-destination=}\""))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ran no test", result.stderr)
        self.assertFalse(report.exists())
        self.assertFalse((self.root / "out.xml.node").exists())

    @unittest.skipIf(os.name == "nt", "a stand-in runtime is a shebang script, not runnable here")
    def test_an_unreadable_report_is_no_report_and_a_failure(self) -> None:
        # A runtime that passes and writes a report nobody can read: the gate is
        # handed nothing, and the run says it failed rather than passed.
        node = self.root / "fake-node"
        node.write_text("#!/bin/sh\n"
                        "if [ \"$1\" = \"--version\" ]; then echo v26.5.0; exit 0; fi\n"
                        "for arg in \"$@\"; do case \"$arg\" in\n"
                        "  --test-reporter-destination=stdout) ;;\n"
                        "  --test-reporter-destination=*) printf '<testsuites><testcase' "
                        "> \"${arg#--test-reporter-destination=}\" ;;\n"
                        "esac; done\nexit 0\n", encoding="utf-8")
        node.chmod(0o755)
        suite = self.root / "case.test.ts"
        suite.write_text(PASSING, encoding="utf-8")
        report = self.root / "out.xml"
        report.write_text("<testsuites><testsuite name=\"old\"/></testsuites>", encoding="utf-8")
        result = subprocess.run([sys.executable, str(RUNNER), "--node", str(node),
                                 "--suite", str(suite), "--junit", str(report)],
                                capture_output=True, text=True, check=False, env=isolated())
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("unreadable report", result.stderr)
        self.assertFalse(report.exists())
        self.assertFalse((self.root / "out.xml.node").exists())


class WrapTests(unittest.TestCase):
    """The wrap alone, on documents of the shapes Node writes."""

    def setUp(self) -> None:
        self.runner = load_runner()

    def test_top_level_cases_are_wrapped_and_nested_suites_kept(self) -> None:
        raw = ("<?xml version=\"1.0\" encoding=\"utf-8\"?><testsuites>"
               "<testcase name=\"a\" classname=\"test\"/>"
               "<testcase name=\"b\" classname=\"test\"><failure message=\"no\"/></testcase>"
               "<testsuite name=\"group\"><testcase name=\"c\" classname=\"test\"/></testsuite>"
               "</testsuites>")
        wrapped = ElementTree.fromstring(self.runner.wrap_report(raw, "x.test.ts"))
        self.assertEqual(wrapped.tag, "testsuites")
        suites = list(wrapped)
        self.assertEqual([suite.tag for suite in suites], ["testsuite"])
        self.assertEqual(suites[0].get("name"), "x.test.ts")
        self.assertEqual(suites[0].get("tests"), "3")
        self.assertEqual(suites[0].get("failures"), "1")
        self.assertEqual(sorted(str(case.get("name")) for case in wrapped.iter("testcase")),
                         ["a", "b", "c"])

    def test_a_document_with_a_declaration_is_refused(self) -> None:
        raw = "<!DOCTYPE x [<!ENTITY e \"boom\">]><testsuites>&e;</testsuites>"
        with self.assertRaises(ValueError):
            self.runner.wrap_report(raw, "x.test.ts")

    def test_a_document_that_does_not_parse_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            self.runner.wrap_report("<testsuites><testcase", "x.test.ts")


if __name__ == "__main__":
    unittest.main()
