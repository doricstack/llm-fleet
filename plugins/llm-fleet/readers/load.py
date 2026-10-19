#!/usr/bin/env python3
"""The load reader: which processes are using this machine, and where they run.

One sample of the process table, taken once per read. The rows drawn are the
ones at the top of the CPU list and the ones at the top of the memory list: a
process heavy in either is what a person is looking for, and a single order
would hide the other kind. A process in both lists is drawn once.

Every figure is a measurement this read took: a percentage as the platform
reported it, resident bytes as the platform reported them, and elapsed time
from the process's own start. The project a process works in is asked of the
system in a second pass, one call over every pid; a process whose working
directory nobody could read carries no project rather than a guessed one.

A platform whose process table this reader cannot read says so, and reads as
unavailable rather than as a machine under no load.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
import subprocess
import time
from typing import Any, Mapping

from readers.runtime import (ReaderFailure, child_environment, printable, read_bounded_text,
                             resolve_command)

# The POSIX listing: pid, CPU percent, resident kilobytes, elapsed, command.
POSIX_ARGV = ["ps", "-Ao", "pid=,pcpu=,rss=,etime=,comm="]
# The POSIX call that names the working directory of each pid it is given.
CWD_ARGV = "lsof"
# How far above a working directory the search for its repository may climb.
PROJECT_DEPTH = 12
# The longest command a row names, as the reader publishes it.
COMMAND_CHARACTERS = 200
# A `.git` file is a line, not a document.
GITFILE_BYTES = 4096
# The most process rows one reading keeps, so a busy machine cannot grow a
# snapshot without bound.
MAX_ROWS = 4096


class MissingCommand(ReaderFailure):
    """The process list cannot be taken here, which is unavailable rather than a failed read."""


def elapsed_seconds(value: str) -> float | None:
    """A process age from `[[dd-]hh:]mm:ss`, in seconds, or None when it does not read."""
    days = 0
    text = value.strip()
    if "-" in text:
        day_text, _, text = text.partition("-")
        if not day_text.isdigit():
            return None
        days = int(day_text)
    parts = text.split(":")
    if not 1 <= len(parts) <= 3 or not all(part.isdigit() for part in parts):
        return None
    numbers = [int(part) for part in parts]
    # ps drops the leading units it does not need: one part is seconds, two are
    # minutes and seconds, three are hours, minutes and seconds.
    if len(numbers) == 1:
        hours, minutes, seconds = 0, 0, numbers[0]
    elif len(numbers) == 2:
        hours, minutes, seconds = 0, numbers[0], numbers[1]
    else:
        hours, minutes, seconds = numbers
    return float(days * 86400 + hours * 3600 + minutes * 60 + seconds)


def process_line(line: str) -> dict[str, Any] | None:
    """One process from one listing line, or None when the line does not read.

    The command is the remainder of the line, because a program's path may hold
    spaces. Everything before it is four fields, and each is checked rather than
    trusted: a percentage that is not a number is not a process at zero.
    """
    fields = line.split(None, 4)
    if len(fields) != 5 or not all(fields[:4]):
        return None
    pid_text, cpu_text, rss_text, age_text, command = fields
    if not pid_text.isdigit():
        return None
    try:
        cpu = float(cpu_text)
        resident = int(rss_text)
    except ValueError:
        return None
    if not math.isfinite(cpu) or cpu < 0 or resident < 0:
        return None
    age = elapsed_seconds(age_text)
    if age is None or not command.strip():
        return None
    return {
        "pid": int(pid_text),
        "command": printable(command.strip())[:COMMAND_CHARACTERS],
        "cpu_percent": round(cpu, 1),
        "memory_bytes": resident * 1024,
        "elapsed_seconds": age,
    }


def _git_root(candidate: Path) -> Path | None:
    """The repository a folder is in, following a worktree's `.git` file.

    A folder in a linked worktree holds a `.git` file naming the worktree's
    directory under the repository's `.git`, and the project is the repository
    that owns it, not the worktree folder the process happens to run in.
    """
    marker = candidate / ".git"
    if marker.is_dir():
        return candidate
    if not marker.is_file():
        return None
    document = read_bounded_text(marker, GITFILE_BYTES)
    if not document:
        return None
    first = document.strip().splitlines()[0] if document.strip() else ""
    prefix = "gitdir:"
    if not first.startswith(prefix):
        return None
    target = Path(first[len(prefix):].strip())
    if not target.is_absolute():
        target = candidate / target
    try:
        target = target.resolve()
    except OSError:
        return None
    parents = target.parents
    if len(parents) >= 3 and parents[1].name == ".git":
        return parents[2]
    return None


def project_of(directory: Path) -> tuple[str, str] | None:
    """The nearest repository above a working directory, as (project, root).

    The climb is bounded, and stops at the filesystem root: a process running in
    a folder outside any repository has no project, and is not given the name
    of whichever folder it happens to sit in.
    """
    candidate = directory
    for _ in range(PROJECT_DEPTH + 1):
        root = _git_root(candidate)
        if root is not None and root.name:
            return root.name, str(root)
        parent = candidate.parent
        if parent == candidate:
            return None
        candidate = parent
    return None


def working_directories(pids: list[int], environment: Mapping[str, str],
                        seconds: float) -> dict[int, Path]:
    """The working directory of each pid, from one bounded lsof call.

    An empty map is this machine declining to answer: no lsof, a refusal of the
    pids it may not inspect, or a timeout. It is not evidence that no process
    has a working directory, so callers draw no project rather than one that
    guesses.
    """
    if not pids:
        return {}
    argv = [CWD_ARGV, "-a", "-d", "cwd", "-Fpn", "-p", ",".join(str(pid) for pid in pids)]
    resolved = resolve_command(argv, environment)
    if resolved is None:
        return {}
    try:
        # The same environment the listing gets: a child that never sees a
        # provider credential cannot leak one.
        completed = subprocess.run(resolved, capture_output=True, text=True,
                                   env=dict(environment), timeout=seconds,
                                   errors="replace")
    except subprocess.TimeoutExpired:
        return {}
    except OSError:
        return {}
    found: dict[int, Path] = {}
    pid: int | None = None
    for line in completed.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None and line[1:]:
            found[pid] = Path(line[1:])
    return found


def _sample(config: Mapping[str, Any], environment: Mapping[str, str]
            ) -> tuple[list[dict[str, Any]], int]:
    """One read of the process table: the rows, and how many lines did not read."""
    source = config["sources"]["load"]
    command = source.get("command")
    if command is None:
        if os.name == "nt":
            raise MissingCommand("the process load is not read on this platform")
        command = POSIX_ARGV
    resolved = resolve_command(list(command), environment)
    if resolved is None:
        raise MissingCommand(command[0] + " was not found")
    seconds = float(config["timeouts"]["commandSeconds"])
    try:
        completed = subprocess.run(resolved, capture_output=True, text=True,
                                   env=dict(environment), timeout=seconds,
                                   errors="replace")
    except subprocess.TimeoutExpired:
        raise ReaderFailure("timed out after {0:g}s".format(seconds)) from None
    except OSError as caught:
        raise ReaderFailure(caught.strerror or type(caught).__name__) from None
    if completed.returncode != 0:
        raise ReaderFailure("exit {0}".format(completed.returncode))
    rows: list[dict[str, Any]] = []
    unreadable = 0
    for line in completed.stdout.splitlines()[:MAX_ROWS]:
        if not line.strip():
            continue
        row = process_line(line)
        if row is None:
            unreadable += 1
            continue
        rows.append(row)
    return rows, unreadable


def _ranked(rows: list[dict[str, Any]], top: int) -> list[dict[str, Any]]:
    """The top rows by CPU and by memory, once each, by CPU first."""
    by_cpu = sorted(rows, key=lambda row: (-row["cpu_percent"], -row["memory_bytes"],
                                           row["pid"]))
    by_memory = sorted(rows, key=lambda row: (-row["memory_bytes"], -row["cpu_percent"],
                                              row["pid"]))
    chosen: dict[int, dict[str, Any]] = {}
    for row in [*by_cpu[:top], *by_memory[:top]]:
        chosen.setdefault(row["pid"], row)
    return sorted(chosen.values(), key=lambda row: (-row["cpu_percent"], -row["memory_bytes"],
                                                    row["pid"]))


def read_load(config: Mapping[str, Any], *, now: float | None = None,
              environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The processes under the most load, each with the project it works in."""
    source = config["sources"]["load"]
    clock = float(now) if now is not None else time.time()
    errors: list[dict[str, str]] = []
    result: dict[str, Any] = {"state": "disabled", "sampled_at": clock, "total": 0,
                              "processes": [], "errors": errors}
    if not source["enabled"]:
        return result
    inherited = dict(os.environ if environ is None else environ)
    # Both calls are handed the same stripped environment, and every command is
    # resolved on the PATH the child actually receives.
    environment = child_environment(config["runtime"]["childEnvironment"], inherited)
    try:
        rows, unreadable = _sample(config, environment)
    except MissingCommand as missing:
        result["state"] = "unavailable"
        errors.append({"source": "load", "reason": str(missing)})
        return result
    except ReaderFailure as failure:
        result["state"] = "failed"
        errors.append({"source": "load", "reason": str(failure)})
        return result
    if not rows:
        result["state"] = "failed" if unreadable else "empty"
        if unreadable:
            errors.append({"source": "load", "reason": "the process list did not read"})
        return result
    top = int(source["top"])
    chosen = _ranked(rows, top)
    directories = working_directories([row["pid"] for row in chosen], environment,
                                      float(config["timeouts"]["commandSeconds"]))
    for row in chosen:
        directory = directories.get(row["pid"])
        found = project_of(directory) if directory is not None else None
        if found is not None:
            row["project"], row["project_root"] = found
    result.update(state="ready", total=len(rows), processes=chosen)
    return result


