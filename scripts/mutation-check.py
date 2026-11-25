#!/usr/bin/env python3
"""Run the declared mutants against their suites and report each one by name.

A mutant is one exact edit to one source file, and the suite that should notice
it. The run is reproducible from the repository alone: the mutants are declared
in `mutation/mutants.json`, and this script is the only thing that applies them.

Four rules keep a result honest:

- the mutants are applied to a copy of the tracked tree, never to the checkout,
  so a run that is killed half-way leaves nothing behind;
- each suite runs once unmutated first, and a suite that is already red stops
  the run, because a mutant cannot be killed by a suite that fails anyway;
- an edit whose text is not in its file exactly once is an error, never a skip:
  a mutant that silently stopped applying would read as one that was killed;
- a survivor fails the run unless it is declared equivalent with the reason,
  so the known survivors are written down rather than rediscovered.

Run with: python3 scripts/mutation-check.py [--only <id> ...]
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DECLARATIONS = ROOT / "mutation" / "mutants.json"
# The manifest a declaration may name the shipped version from, and the token it
# writes it as.
MANIFEST = ("plugins", "llm-fleet", ".claude-plugin", "plugin.json")
VERSION_TOKEN = "{version}"
KILLED = "killed"
SURVIVED = "survived"
EQUIVALENT = "equivalent"
ERROR = "error"


class MutationError(RuntimeError):
    """The declarations or the tree cannot produce a trustworthy result."""


def manifest_version(root: Path) -> str:
    """The version the tree's plugin manifest carries.

    A mutant whose text holds the shipped version stops matching on every
    release that raises it, and the harness refuses a mutant whose text has
    moved, so each release would have to carry that declaration by hand. Naming
    the version as `{version}` lets the declaration stand while the manifest
    stays the one place the number is written.
    """
    path = root.joinpath(*MANIFEST)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise MutationError("cannot read {0}: {1}".format(path, error)) from None
    version = document.get("version") if isinstance(document, dict) else None
    if not isinstance(version, str) or not version:
        raise MutationError("{0} carries no version".format(path))
    return version


def names_version(mutants: list[Any]) -> bool:
    """Whether any declaration names the shipped version as `{version}`.

    Read from the strings the document decoded to, so a token written with an
    escape is a token.
    """
    for mutant in mutants:
        if not isinstance(mutant, dict):
            continue
        for key in ("find", "replace"):
            text = mutant.get(key)
            if isinstance(text, str) and VERSION_TOKEN in text:
                return True
    return False


BARE_RUNTIMES = {"node": "{node}", "python": "{python}", "python3": "{python}"}


def load(path: Path, root: Path | None = None) -> list[dict[str, Any]]:
    """The declared mutants, each checked for the fields a run needs.

    `{version}` in a mutant's text is filled from the manifest of `root`, or of
    the tree the declarations sit in when no root is named.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise MutationError("cannot read {0}: {1}".format(path, error)) from None
    mutants = document.get("mutants") if isinstance(document, dict) else None
    if not isinstance(mutants, list) or not mutants:
        raise MutationError("{0} declares no mutants".format(path))
    # Read from the decoded strings, not the file's text: a declaration may spell
    # a brace as `{`, and a token that decodes to `{version}` but is not
    # seen as one would be left unfilled, which reads as a mutant whose text
    # moved rather than as the fill it needed.
    version = manifest_version(path.parent.parent if root is None else root) \
        if names_version(mutants) else None
    seen: set[str] = set()
    for mutant in mutants:
        if not isinstance(mutant, dict):
            raise MutationError("a mutant is not an object")
        for key in ("id", "file", "find", "replace"):
            if not isinstance(mutant.get(key), str):
                raise MutationError("mutant {0!r} has no {1}".format(mutant.get("id"), key))
        if version is not None:
            mutant["find"] = mutant["find"].replace(VERSION_TOKEN, version)
            mutant["replace"] = mutant["replace"].replace(VERSION_TOKEN, version)
        suite = mutant.get("suite")
        if not isinstance(suite, list) or not suite or not all(isinstance(a, str) for a in suite):
            raise MutationError("mutant {0} has no suite".format(mutant["id"]))
        # A bare runtime name runs whatever is first on PATH and, for Node, without
        # the resolver the plugin's `./name.js` imports need, so its baseline is red
        # for a reason the mutant never touched.
        if suite[0] in BARE_RUNTIMES:
            raise MutationError("mutant {0} starts its suite with {1!r}; write {2}".format(
                mutant["id"], suite[0], BARE_RUNTIMES[suite[0]]))
        if mutant["find"] == mutant["replace"]:
            raise MutationError("mutant {0} changes nothing".format(mutant["id"]))
        if mutant["id"] in seen:
            raise MutationError("mutant {0} is declared twice".format(mutant["id"]))
        if Path(mutant["file"]).is_absolute() or ".." in Path(mutant["file"]).parts:
            raise MutationError("mutant {0} names a file outside the tree".format(mutant["id"]))
        seen.add(mutant["id"])
    return mutants


def copy_tree(source: Path, destination: Path) -> None:
    """Copy what git tracks, plus files not yet added, into a fresh directory."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=source, capture_output=True, check=True)
    for name in listed.stdout.decode("utf-8").split("\0"):
        if not name:
            continue
        origin = source / name
        if not origin.is_file():
            continue
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin, target)


RUNTIMES = {"{python}": sys.executable, "{node}": "node"}
# The resolver the plugin's `./name.js` imports need under Node, relative to the
# root of the copy being measured, which is where a suite runs from.
RESOLVER = "components/resolve.ts"

TIMEOUT_REASON = "the suite did not finish within "


def command(suite: list[str], tree: Path) -> list[str]:
    """A suite's argv, with the configured runtimes standing in for `{python}` and `{node}`.

    A `{node}` suite starts with the tree's resolver under `--import` when the
    tree has one; a tree without it runs Node as written.
    """
    resolver = (tree / RESOLVER).is_file()
    argv: list[str] = []
    for part in suite:
        argv.append(RUNTIMES.get(part, part))
        if part == "{node}" and resolver:
            argv.extend(["--import", "./" + RESOLVER])
    return argv


def partial_text(value) -> str:
    """What a timed-out run had captured, as text.

    `TimeoutExpired` attaches its captured output as bytes even in text mode, so
    it is decoded the way the suite's own output was read.
    """
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def passes(suite: list[str], tree: Path, timeout: float) -> tuple[bool, str]:
    """Whether the suite passed, and the tail of what it said when it did not.

    The baseline's output is the only account of why a suite is red, and a run
    that discards it leaves a gate that says "red" and nothing else; that cost
    a two-hour slice on 2026-11-22, where the copied tree ran clean outside the
    gate and the failing test's name was never printed.
    """
    # Python keeps a compiled copy of each module keyed on the source's size and
    # modification second. A mutant the same length as the text it replaces,
    # written in the second the copy was made, would run the compiled original
    # and survive having never been tested, so no compiled copy is kept.
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    # The suite's own encoding, not the machine's: a Node failure marker is
    # UTF-8 and a non-UTF-8 locale read it as mojibake, which the tail below
    # then could not recognise as a name. Found by review, 2026-11-23.
    try:
        completed = subprocess.run(command(suite, Path(tree)), cwd=tree, capture_output=True,
                                   timeout=timeout, check=False, env=environment,
                                   text=True, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired as expired:
        # A suite that hung in teardown may already have named its failing test,
        # and dropping that output left the timeout as the only account of a
        # red run. Found by review, 2026-11-23.
        said = "\n".join(part for part in (
            partial_text(getattr(expired, "stdout", None)),
            partial_text(getattr(expired, "stderr", None))) if part)
        return False, (TIMEOUT_REASON + "%gs" % timeout
                       + ("\n" + said if said else ""))
    if completed.returncode == 0:
        return True, ""
    # Both streams, each cut to its own tail: a suite usually names the failing
    # test on stdout and may still write a warning to stderr, and one combined
    # tail let twenty lines of stderr push the failing test's name out. A tail
    # alone can still drop the name when one stream is long, so every line that
    # names a failure is kept ahead of the tail that holds the final counts.
    def tail(text: str) -> str:
        lines = (text or "").strip().splitlines()
        kept = lines[-10:]
        # pytest writes `FAILED name` and, for a collection or fixture error,
        # `ERROR name`; unittest writes `FAIL:`/`ERROR:`, and the javascript
        # runner either TAP's `not ok 3 - name` (indented under its parent
        # when it is a subtest) or marks the case with a cross. Only a line
        # that starts a failure counts: a bare `ERROR ` or `FAILED ` in the
        # middle of a log line is a retry message, and counting those let a
        # hundred log lines push the failing test's name out of the excerpt.
        # No named line is dropped: a cap silently lost the eleventh name, and
        # the point of keeping them is that the name is the whole account.
        # Found by review, 2026-11-23.
        named = [line for line in lines
                 if line.startswith(("FAIL:", "ERROR:", "FAILED ", "ERROR "))
                 or line.lstrip().startswith("not ok ")
                 or "✖" in line]
        return "\n".join([line for line in named if line not in kept] + kept)

    tails = [tail(text) for text in (completed.stdout, completed.stderr)]
    return False, "\n".join(tail for tail in tails if tail)


def run(mutants: list[dict[str, Any]], source: Path, timeout: float) -> list[dict[str, str]]:
    """Every mutant's outcome, in declaration order."""
    results: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="mutation-") as scratch:
        tree = Path(scratch)
        copy_tree(source, tree)
        for suite in {tuple(mutant["suite"]) for mutant in mutants}:
            green, said = passes(list(suite), tree, timeout)
            if not green:
                raise MutationError("the suite is red before any mutant: "
                                    + " ".join(suite) + ("\n" + said if said else ""))
        for mutant in mutants:
            target = tree / mutant["file"]
            try:
                original = target.read_text(encoding="utf-8")
            except OSError:
                results.append({"id": mutant["id"], "outcome": ERROR,
                                "detail": "the file is not in the tree"})
                continue
            found = original.count(mutant["find"])
            if found != 1:
                results.append({"id": mutant["id"], "outcome": ERROR,
                                "detail": "the text occurs {0} times, not once".format(found)})
                continue
            target.write_text(original.replace(mutant["find"], mutant["replace"]),
                              encoding="utf-8")
            try:
                green, said = passes(mutant["suite"], tree, timeout)
            finally:
                target.write_text(original, encoding="utf-8")
            if not green:
                # A suite the mutant stopped counts as a kill, and a timeout is
                # one way it stops. The reason is kept so a hang that killed
                # nothing reads as a hang rather than as an ordinary kill; a
                # normal red suite's tail is already printed as the gate's
                # baseline answer and is not repeated here.
                detail = said if said.startswith(TIMEOUT_REASON) else ""
                outcome = KILLED
            elif isinstance(mutant.get("equivalent"), str) and mutant["equivalent"].strip():
                outcome, detail = EQUIVALENT, mutant["equivalent"]
            else:
                outcome, detail = SURVIVED, mutant.get("why", "")
            results.append({"id": mutant["id"], "outcome": outcome, "detail": detail})
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the declared mutants against their suites")
    # The report names a failing test by the line its runner wrote, and that
    # line can hold a character this machine's code page cannot encode: the
    # console escaped it, and the caller read the escape instead of the name.
    # The suite's own output is read as UTF-8, so the report is written as
    # UTF-8. Found by review, 2026-11-23.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="backslashreplace")
    parser.add_argument("--mutants", default=str(DECLARATIONS))
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--only", action="append", default=[],
                        help="run only the mutant with this id; repeat for more")
    parser.add_argument("--timeout", type=float, default=300.0,
                        help="seconds one suite run may take")
    parser.add_argument("--node", default="node", help="the Node runtime a `{node}` suite runs on")
    args = parser.parse_args(argv)
    RUNTIMES["{node}"] = args.node
    # The gate cancels a slice by signalling its process group. A SIGTERM that
    # kills the interpreter outright skips the copied tree's cleanup, so the
    # handler leaves through the with-blocks instead. Found by review,
    # 2026-11-22.
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(143))
    try:
        mutants = load(Path(args.mutants), Path(args.root))
        if args.only:
            unknown = sorted(set(args.only) - {mutant["id"] for mutant in mutants})
            if unknown:
                raise MutationError("no mutant is declared as " + ", ".join(unknown))
            mutants = [mutant for mutant in mutants if mutant["id"] in args.only]
        results = run(mutants, Path(args.root), args.timeout)
    except (MutationError, subprocess.CalledProcessError) as error:
        print("mutation-check: " + str(error), file=sys.stderr)
        return 2
    counts = {name: 0 for name in (KILLED, EQUIVALENT, SURVIVED, ERROR)}
    for result in results:
        counts[result["outcome"]] += 1
        line = "{0:<10} {1}".format(result["outcome"], result["id"])
        print(line + ("  " + result["detail"] if result["detail"] else ""))
    print("{0} mutants: {1} killed, {2} equivalent, {3} survived, {4} errors".format(
        len(results), counts[KILLED], counts[EQUIVALENT], counts[SURVIVED], counts[ERROR]))
    return 0 if counts[SURVIVED] == 0 and counts[ERROR] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
