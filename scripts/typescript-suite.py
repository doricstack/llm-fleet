#!/usr/bin/env python3
"""Run a TypeScript suite, or report the runtime as unavailable.

One definition of a usable runtime lives here, shared by `make test-typescript`,
`make test-components` and the configuration parity test: Node 22.6 is the first
release that runs TypeScript directly, so no build step or dependency install is
required. JSX is not part of that direct path, which is why the layout is written
as plain TypeScript and calls the host's elements as functions.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SUITE = ROOT / "config" / "loader.test.ts"
MINIMUM = (22, 6)
# The folder a gate names for reports, read by every suite whoever starts it.
REPORT_FOLDER = "FLEET_TS_JUNIT_DIR"


def node_runtime(name: str = "node") -> tuple[str | None, str]:
    """Return the Node executable when it can run TypeScript without a build."""
    found = shutil.which(name)
    if not found:
        return None, "{0} is not installed".format(name)
    detected = subprocess.run([found, "--version"], capture_output=True, text=True, check=False)
    if detected.returncode != 0:
        return None, "{0} --version failed".format(name)
    match = re.match(r"v(\d+)\.(\d+)", detected.stdout.strip())
    if not match:
        return None, "unreadable {0} version".format(name)
    numbers = (int(match.group(1)), int(match.group(2)))
    if numbers < MINIMUM:
        return None, "node {0}.{1} cannot run TypeScript directly".format(*numbers)
    return found, "node {0}.{1}".format(*numbers)


def wrap_report(raw: str, suite_name: str) -> str:
    """Node's JUnit document with its cases inside one suite named for the file.

    Node writes a top-level test as a case directly under the root, with no
    suite round it, and a gate that merges reports keeps suites. Left as Node
    wrote it, a run of a hundred cases merges as a run of none. A document with
    a DOCTYPE or ENTITY declaration is refused before it is parsed, as the gate
    refuses one, and one that does not parse is refused rather than wrapped.
    """
    lowered = raw.lower()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise ValueError("the report carries a doctype or entity declaration")
    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError as exc:
        raise ValueError("the report does not parse: {0}".format(exc)) from exc
    cases = list(root.iter("testcase"))
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases
                 if case.find("failure") is None and case.find("error") is not None)
    skipped = sum(1 for case in cases if case.find("skipped") is not None)
    wrapped = ElementTree.Element("testsuites")
    suite = ElementTree.SubElement(wrapped, "testsuite", {
        "name": suite_name, "tests": str(len(cases)), "failures": str(failures),
        "errors": str(errors), "skipped": str(skipped),
    })
    suite.extend(cases)
    return ElementTree.tostring(wrapped, encoding="unicode", xml_declaration=True)


def run_with_report(found: str, suite: Path, report: Path) -> int:
    """Run the suite printing what a person reads, and write its report.

    Node takes one reporter per destination: the spec reporter keeps the
    terminal as it was, and the JUnit one goes to a file beside the destination
    that is wrapped and moved into place. A run that wrote no report, because
    Node died before any test ran, leaves no file, so the gate counts nothing
    rather than a clean nothing.
    """
    report.parent.mkdir(parents=True, exist_ok=True)
    raw = report.with_name(report.name + ".node")
    clear_report(report)
    result = subprocess.run([found, "--test",
                             "--test-reporter=spec", "--test-reporter-destination=stdout",
                             "--test-reporter=junit",
                             "--test-reporter-destination={0}".format(raw),
                             str(suite)], cwd=str(ROOT), check=False)
    if not raw.is_file():
        return silent(suite, result.returncode)
    try:
        text = raw.read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            return silent(suite, result.returncode)
        try:
            wrapped = wrap_report(text, str(suite))
        except ValueError as exc:
            # A report that cannot be read is no report: the gate is handed
            # nothing to count, and the run says it failed.
            print("TypeScript suite {0} wrote an unreadable report: {1}".format(suite, exc),
                  file=sys.stderr)
            return result.returncode or 1
        if "<testcase" not in wrapped:
            # A report that parses and counts nothing says no test ran: passed,
            # the suite would read as run while other suites' counts hid it.
            print("TypeScript suite {0} ran no test".format(suite), file=sys.stderr)
            return result.returncode or 1
        report.write_text(wrapped, encoding="utf-8")
    finally:
        raw.unlink(missing_ok=True)
    return result.returncode


def silent(suite: Path, returncode: int) -> int:
    """A run asked for a report that wrote none: a failure, whatever Node said.

    Passed with no report, the suite would vanish from a gate's count while the
    run said it passed, and other suites' reports would keep the count from
    reading as empty.
    """
    print("TypeScript suite {0} wrote no report".format(suite), file=sys.stderr)
    return returncode or 1


def clear_report(report: Path) -> None:
    """Remove this suite's report and its raw copy from a previous run.

    A destination used before holds the last run's report. Left there, a run
    that dies before Node writes anything would hand a gate that earlier, clean
    report as though it were this one's.
    """
    report.unlink(missing_ok=True)
    report.with_name(report.name + ".node").unlink(missing_ok=True)


def report_name(suite: Path) -> str:
    """The report file for a suite: its name, and a digest of its whole path.

    A name flattened from the path alone lets two suites meet in one file
    (`a.b.test.ts` and `a-b.test.ts`), and the second report would hide the
    first. The digest is of the path as given, so the same suite run twice in
    one full run writes one file, not two.
    """
    digest = hashlib.sha256(suite.as_posix().encode("utf-8")).hexdigest()[:12]
    stem = suite.name[:-len(".test.ts")] if suite.name.endswith(".test.ts") else suite.stem
    return "fleet-ts-{0}-{1}.xml".format(stem, digest)


def destination(explicit: str | None, suite: Path) -> Path | None:
    """Where this run's report goes: the path asked for, or one in the folder a gate named.

    The folder comes through the environment, because a suite is started from
    many places and the one that knows a gate is reading is the selection, not
    the make target between them. A relative path is read from where this run
    was started, before Node starts from the repository root: checked against
    one folder and written to the other, a passing run would read as no report.
    """
    if explicit:
        return Path(explicit).resolve()
    folder = os.environ.get(REPORT_FOLDER, "")
    if not folder:
        return None
    return Path(folder).resolve() / report_name(suite)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--suite", default=str(DEFAULT_SUITE),
                        help="the TypeScript suite to run")
    parser.add_argument("--junit", default=None,
                        help="where to write the suite's JUnit report; none is written without it")
    args = parser.parse_args()
    suite = Path(args.suite)
    report = destination(args.junit, suite)
    if report is not None:
        clear_report(report)
    if not suite.is_file():
        print("Unavailable: {0} is not present.".format(suite), file=sys.stderr)
        return 2
    found, detail = node_runtime(args.node)
    if found is None:
        print("Unavailable: {0}; the TypeScript layer is unverified.".format(detail),
              file=sys.stderr)
        return 2
    if report is not None:
        returncode = run_with_report(found, suite, report)
    else:
        returncode = subprocess.run([found, "--test", str(suite)], cwd=str(ROOT),
                                    check=False).returncode
    if returncode != 0:
        print("TypeScript suite {0} failed under {1}".format(suite, detail), file=sys.stderr)
        return 1
    print("TypeScript suite {0} passed under {1}".format(suite, detail))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
