#!/usr/bin/env python3
"""Run the Python suite, and write the result as a JUnit report when asked.

The affected-test runner feeds a gate, and a gate reads a report rather than an
exit code. The reason is that an exit code cannot tell a suite that ran and
passed from one that selected nothing at all: both are exit zero, and they are
not the same answer. unittest writes no report, and this repository takes no
dependency to get one, so the report is written here, from the result object
unittest already produces. The format is not this repository's invention; it is
the one every gate and every hosted runner reads.

The discovery is the one `make test` publishes, so a run here and a run there
are the same tests rather than two lists to keep in step.

    python3 scripts/test-report.py
    python3 scripts/test-report.py --junit-xml report.xml
    python3 scripts/test-report.py --directory tests --pattern 'test_*.py'
    python3 scripts/test-report.py --file tests/test_a.py --file tests/test_b.py

A named file runs alone, in place of discovery: the impact plan selects test
files one at a time, and the files it names still make one report. A name that
is not a file inside the directory is refused, because running nothing for it
would read as a pass over a file the plan believed it was checking.

Exit: 0 when every test passed, 1 when one failed or errored, 2 when the suite
      could not be run at all.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
import unittest
import xml.etree.ElementTree as ElementTree
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIRECTORY = ROOT / "tests"
DEFAULT_PATTERN = "test_*.py"
SUITE_NAME = "fleet-python"

PASSED = "passed"
FAILURE = "failure"
ERROR = "error"
SKIPPED = "skipped"


def subtest_name(test: unittest.TestCase, subtest) -> str:
    """What a failing turn of a loop is called, as the runner prints it.

    Rendered from the subtest's own description rather than taken from the
    parent, so a report says which turn failed instead of naming the method
    four times.
    """
    described = ""
    describe = getattr(subtest, "_subDescription", None)
    if callable(describe):
        described = str(describe())
    return "{0}{1}".format(test._testMethodName, described)


class Recording(unittest.TextTestResult):
    """A result that keeps what each test did, so a report can be written after.

    The standard writer prints as it goes and keeps nothing, which is why a
    report could not be produced from it. This keeps one entry per test: the
    outcome, the message, and the traceback, which is what a reader triaging a
    red suite needs and what a hosted runner shows.
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.records: list[dict[str, str | float]] = []
        self.started: dict[object, float] = {}

    # --- the hooks unittest calls, one per outcome ---------------------------
    def startTest(self, test: unittest.TestCase) -> None:
        self.started[test] = time.monotonic()
        super().startTest(test)

    def addSuccess(self, test: unittest.TestCase) -> None:
        super().addSuccess(test)
        self.record(test, PASSED)

    def addFailure(self, test: unittest.TestCase, err) -> None:
        super().addFailure(test, err)
        self.record(test, FAILURE, err)

    def addError(self, test: unittest.TestCase, err) -> None:
        super().addError(test, err)
        self.record(test, ERROR, err)

    def addSkip(self, test: unittest.TestCase, reason: str) -> None:
        super().addSkip(test, reason)
        self.record(test, SKIPPED, message=reason)

    def addExpectedFailure(self, test: unittest.TestCase, err) -> None:
        super().addExpectedFailure(test, err)
        # An expected failure is a test that did what it said it would, so it is
        # neither a failure nor a pass, and the report needs a third word for
        # it. JUnit has none: it is recorded as a skip, which is the closest
        # thing that is not a lie about what happened.
        self.record(test, SKIPPED, message="expected failure")

    def addUnexpectedSuccess(self, test: unittest.TestCase) -> None:
        super().addUnexpectedSuccess(test)
        self.record(test, FAILURE, message="expected to fail, but passed")

    def addSubTest(self, test: unittest.TestCase, subtest, err) -> None:
        """A failure inside a loop, which unittest reports by no other hook.

        `addSubTest` is the only notice a subtest failure gets: the base result
        appends it to the failures list itself rather than calling addFailure,
        so a writer listening for the failure hook hears nothing and reports a
        red run as a clean one. That is the one thing a report must never do.
        The parent keeps its own timing; the subtest carries the name that says
        which turn of the loop failed.
        """
        super().addSubTest(test, subtest, err)
        if err is None or err[0] is None:
            return
        outcome = FAILURE if issubclass(err[0], test.failureException) else ERROR
        self.record(test, outcome, err, name=subtest_name(test, subtest), timed=False)

    # --- the entry a report is built from ------------------------------------
    def record(self, test: unittest.TestCase, outcome: str, err=None,
               message: str | None = None, name: str | None = None,
               timed: bool = True) -> None:
        took = 0.0
        if timed:
            started = self.started.pop(test, None)
            took = 0.0 if started is None else time.monotonic() - started
        detail = "" if err is None else "".join(traceback.format_exception(*err))
        if message is None and err is not None:
            message = str(err[1])
        self.records.append({
            "id": test.id(),
            "name": name or "",
            "outcome": outcome,
            "message": message or "",
            "detail": detail,
            "time": took,
        })


def legal(value: str) -> str:
    """The text as XML can hold it.

    XML 1.0 has no way to write most control characters, and ElementTree does
    not escape them: it writes them through and the document stops parsing.
    Terminal color arrives in an assertion message all the time, and this
    pane's own output is drawn with it, so a document that broke on one would
    break on the first test that printed a colored diff. They are dropped
    rather than escaped, because there is no escaping them.
    """
    return "".join(
        character for character in value
        if character in "\t\n\r"
        or " " <= character <= "퟿"
        or "" <= character <= "�"
        # Above the basic plane as well: XML 1.0 holds these, and a message
        # carrying an emoji was being stripped by a filter that stopped one
        # plane short of what the format allows.
        or "\U00010000" <= character <= "\U0010ffff")


def case_element(record: dict[str, str | float]) -> ElementTree.Element:
    """One testcase, with the element JUnit uses for what it did."""
    identifier = str(record["id"])
    parts = identifier.split(".")
    case = ElementTree.Element("testcase", {
        "name": legal(str(record["name"]) or parts[-1]),
        "classname": legal(".".join(parts[:-1]) or SUITE_NAME),
        "time": "%.6f" % float(record["time"]),
    })
    outcome = str(record["outcome"])
    if outcome == PASSED:
        return case
    if outcome == SKIPPED:
        skipped = ElementTree.SubElement(case, "skipped")
        skipped.set("message", legal(str(record["message"])))
        return case
    # A failure is a test that asserted; an error is a test that raised before
    # it could. A reader triaging a report treats those differently, so the
    # document does too.
    node = ElementTree.SubElement(case, outcome)
    node.set("message", legal(str(record["message"])))
    node.text = legal(str(record["detail"]))
    return case


def report_document(result: Recording, elapsed: float) -> ElementTree.Element:
    """The whole run as one testsuite element."""
    outcomes = [str(record["outcome"]) for record in result.records]
    root = ElementTree.Element("testsuite", {
        "name": SUITE_NAME,
        "tests": str(len(outcomes)),
        "failures": str(outcomes.count(FAILURE)),
        "errors": str(outcomes.count(ERROR)),
        "skipped": str(outcomes.count(SKIPPED)),
        "time": "%.6f" % elapsed,
    })
    for record in result.records:
        root.append(case_element(record))
    return root


def write_report(root: ElementTree.Element, destination: Path) -> None:
    """Write the document whole, making its directory if it is not there yet.

    Written beside the destination and moved into place, because a half-written
    document is worse than none: a reader cannot tell a truncated file from a
    short run, and a gate that reads one would count it as a result. A rename
    inside one directory is atomic, so the destination holds either the whole
    document or nothing this run wrote.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    tree = ElementTree.ElementTree(root)
    ElementTree.indent(tree, space="  ")
    beside = destination.with_name(destination.name + ".part")
    try:
        tree.write(beside, encoding="utf-8", xml_declaration=True)
        beside.replace(destination)
    finally:
        if beside.exists():
            beside.unlink()


def summary(result: Recording, elapsed: float) -> str:
    """One line, with the four counts a reader asks for in that order."""
    outcomes = [str(record["outcome"]) for record in result.records]
    return "{0} tests, {1} failed, {2} errors, {3} skipped in {4:.2f}s".format(
        len(outcomes), outcomes.count(FAILURE), outcomes.count(ERROR),
        outcomes.count(SKIPPED), elapsed)


def named_suite(directory: Path, names: list[str]) -> unittest.TestSuite | None:
    """The tests in the named files, each loaded once, or None after a refusal.

    Each file is loaded as the discovery would load it, as a module named from
    its place under the directory with the directory first on the import path,
    so a file run alone sees the same helpers it sees in the whole suite. A
    file that fails to import becomes a failed test rather than an exception,
    which is how discovery reports one too.
    """
    top = directory.resolve()
    modules: list[str] = []
    for name in names:
        path = Path(name).resolve()
        if not path.is_file():
            print("test-report: {0} is not a file".format(name), file=sys.stderr)
            return None
        try:
            relative = path.relative_to(top)
        except ValueError:
            print("test-report: {0} is not inside {1}".format(name, directory),
                  file=sys.stderr)
            return None
        if path.suffix != ".py":
            print("test-report: {0} is not a Python file".format(name), file=sys.stderr)
            return None
        dotted = ".".join(relative.with_suffix("").parts)
        if dotted not in modules:
            modules.append(dotted)
    if str(top) not in sys.path:
        sys.path.insert(0, str(top))
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for dotted in modules:
        try:
            suite.addTests(loader.loadTestsFromName(dotted))
        except Exception as exc:  # a module that will not load, a syntax error included
            suite.addTest(import_failure(dotted, exc))
    return suite


def import_failure(dotted: str, exc: Exception) -> unittest.TestCase:
    """A test that fails the way the named module failed to import."""
    def test(self: unittest.TestCase) -> None:
        raise ImportError("{0} could not be imported: {1}".format(dotted, exc))
    case = type(dotted.replace(".", "_"), (unittest.TestCase,), {"test_import": test})
    return case("test_import")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the Python suite, writing a JUnit report when asked.")
    parser.add_argument("--directory", default=str(DEFAULT_DIRECTORY),
                        help="where the suite lives")
    parser.add_argument("--pattern", default=DEFAULT_PATTERN,
                        help="the file pattern the suite is discovered by")
    # A gate names the destination in the environment, so the path never
    # passes through a command line a shell or make would expand.
    parser.add_argument("--junit-xml", default=os.environ.get("FLEET_JUNIT_XML") or None,
                        help="write the result here; nothing is written without it or "
                             "FLEET_JUNIT_XML")
    parser.add_argument("--file", action="append", default=[],
                        help="run this test file inside the directory instead of "
                             "discovering; repeat for more")
    parser.add_argument("--quiet", action="store_true",
                        help="drop the per-test lines and keep the summary")
    args = parser.parse_args()

    directory = Path(args.directory)
    if not directory.is_dir():
        print("test-report: {0} is not a directory".format(directory), file=sys.stderr)
        return 2

    try:
        if args.file:
            suite = named_suite(directory, args.file)
            if suite is None:
                return 2
        else:
            suite = unittest.TestLoader().discover(str(directory), pattern=args.pattern,
                                                   top_level_dir=str(directory))
    except ImportError as exc:
        print("test-report: the suite could not be loaded: {0}".format(exc), file=sys.stderr)
        return 2

    verbosity = 0 if args.quiet else 1
    runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=verbosity,
                                     resultclass=Recording)
    started = time.monotonic()
    result: Recording = runner.run(suite)  # type: ignore[assignment]
    elapsed = time.monotonic() - started

    if args.junit_xml:
        write_report(report_document(result, elapsed), Path(args.junit_xml))
    print(summary(result, elapsed))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
