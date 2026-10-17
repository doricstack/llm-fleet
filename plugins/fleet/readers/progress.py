#!/usr/bin/env python3
"""The progress reader: what a governor run actually completed.

A run record proves nothing on its own. The reader requires a live process, a
record inside its age ceiling, and a count file newer than the run that wrote it
before any number is reported. A run whose owner is gone is dropped rather than
kept as a stopped bar, and a count that cannot be trusted is an error, not a
zero.
"""

from __future__ import annotations

import time
import math
import os
from pathlib import Path
from typing import Any, Mapping

from .runtime import cut, printable, read_bounded_json, switch_state
from .trials import lease_sessions

# A count file is written beside its record and shares its session name.
STEP_SUFFIX = ".progress.json"
RUN_KIND = "run"
WAIT_KIND = "wait"


def _number(value: Any) -> float | None:
    """A finite number, or None. Booleans are not numbers here."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return float(value)


# The longest branch or command a row names.
NAME_CHARACTERS = 120


def _token(value: Any) -> str:
    """A short machine token: letters, digits, dot, underscore, dash."""
    if not isinstance(value, str) or len(value) > 64:
        return ""
    return value if all(character.isalnum() or character in "._-" for character in value) else ""


def process_is_alive(identifier: Any) -> bool | None:
    """Whether a process the record names still exists.

    None means this platform cannot answer. Unknown liveness is not proof of a
    live run, and it is not proof of a dead one either, so the caller decides.
    """
    number = _number(identifier)
    if number is None or number != int(number) or not 0 < number <= 2147483647:
        return False
    pid = int(number)
    checker = _windows_alive if os.name == "nt" else _posix_alive
    return checker(pid)


def _posix_alive(pid: int) -> bool | None:
    """Liveness from the null signal: no effect, and the error is the answer."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def _windows_alive(pid: int) -> bool | None:
    """Liveness through the system call Windows offers, without a new dependency."""
    try:
        import ctypes
    except ImportError:
        return None
    library = getattr(ctypes, "WinDLL", None)
    if library is None:
        return None
    process_query_limited_information = 0x1000
    access_denied = 5
    kernel32 = library("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        error = getattr(ctypes, "get_last_error", lambda: 0)()
        # A denied handle still proves something holds the identifier.
        return True if error == access_denied else False
    kernel32.CloseHandle(handle)
    return True


def _live_start(record: Mapping[str, Any], now: float, ceiling: float, stale: float) -> float | None:
    """When the run started, or None when it is not live on any reading."""
    kind = record.get("kind")
    started = _number(record.get("started_at"))
    if started is None or kind not in (RUN_KIND, WAIT_KIND):
        return None
    if process_is_alive(record.get("pid")) is False:
        return None
    if kind == RUN_KIND:
        return started if now - started <= ceiling else None
    updated = _number(record.get("updated_at"))
    if updated is None or now - updated > stale:
        return None
    return started


def _checked(record: Mapping[str, Any]) -> dict[str, Any] | None:
    """The fields a row needs, or None when the record does not carry them."""
    phase = _token(record.get("phase"))
    command_class = _token(record.get("command_class"))
    repo = _token(record.get("repo"))
    if not phase or not command_class or not repo:
        return None
    checked: dict[str, Any] = {"phase": phase, "command_class": command_class, "repo": repo}
    # What the run is and where, as the governor recorded it: someone else's
    # words, so made printable and cut, and absent rather than invented.
    for key in ("branch", "label"):
        value = cut(record.get(key), NAME_CHARACTERS)
        if value:
            checked[key] = value
    for key in ("queue_position", "queue_total", "total_seconds", "remaining_seconds"):
        value = _number(record.get(key))
        if value is not None and value >= 0:
            checked[key] = int(value)
    return checked


def _counts(state: Path, started: float, max_bytes: int) -> tuple[int, int, str, int, str]:
    """The step counts a count file holds, only when they can be trusted.

    A count file older than the run that is writing it belongs to an earlier
    run: this run has not counted yet, which is how every run under a reused
    name begins, so it reads as no counts rather than as a fault.
    """
    try:
        if state.stat().st_mtime < started:
            return 0, 0, "", 0, ""
    except OSError:
        # The writer released the run between the read and this check.
        return 0, 0, "", 0, ""
    document = read_bounded_json(state, max_bytes)
    if not isinstance(document, dict):
        return 0, 0, "", 0, ""
    done = _number(document.get("done"))
    total = _number(document.get("total"))
    if done is None or total is None or done < 0 or total <= 0:
        raise ValueError("invalid counts")
    failed = _number(document.get("failed"))
    first = document.get("first_failure")
    return (int(min(done, total)), int(total), _token(document.get("label")),
            int(failed) if failed is not None and failed > 0 else 0,
            printable(first) if isinstance(first, str) else "")


def step_file(directory: Path, stem: str) -> Path:
    """The count file beside a run record."""
    return directory / (stem + STEP_SUFFIX)


def _association(config: Mapping[str, Any], now: float, stem: str,
                 repo: str) -> tuple[str | None, str]:
    """The branch a run belongs to, or None when no single lease claims it."""
    matches = []
    for lease in lease_sessions(config, now):
        if lease["session"][:8] != stem:
            continue
        if repo in (lease["repo"], lease["worktree_repo"]):
            matches.append(lease)
    if len(matches) == 1:
        return matches[0]["branch"], matches[0]["repo"]
    return None, repo


def read_progress(config: Mapping[str, Any], *, now: float | None = None,
                  directory: Path | None = None) -> dict[str, Any]:
    """Every live governor run, with its measured counts and its failures."""
    source = config["sources"]["progress"]
    clock = float(now) if now is not None else time.time()
    progress_policy = config["progress"]
    limits = config["limits"]
    errors: list[dict[str, str]] = []
    result: dict[str, Any] = {"state": "disabled", "runs": [], "errors": errors}
    # The switch is a state of the machine rather than of the source: a governor
    # switched off in configuration is still off, and a person reading the pane
    # wants to know which of the two is keeping their work from running.
    state = switch_state(source)
    if state is not None:
        result["switch"] = state
    if not source["enabled"]:
        return result
    root = Path(directory if directory is not None else source["directory"])
    if not root.is_dir():
        result["state"] = "unavailable"
        errors.append({"source": "progress", "reason": "no progress directory"})
        return result
    try:
        records = sorted(entry for entry in root.glob("*.json")
                         if not entry.name.endswith(STEP_SUFFIX))
    except OSError:
        result["state"] = "failed"
        errors.append({"source": "progress", "reason": "could not list the progress directory"})
        return result
    ceiling = float(progress_policy["runCeilingSeconds"])
    stale = float(progress_policy["waitStaleSeconds"])
    minimum = int(progress_policy["etaMinimumOutcomes"])
    runs: list[dict[str, Any]] = []
    for path in records:
        stem = path.stem
        document = read_bounded_json(path, int(limits["jobStateBytes"]))
        if not isinstance(document, dict) or document.get("session") != stem:
            errors.append({"source": "progress", "reason": "invalid record " + stem})
            continue
        started = _live_start(document, clock, ceiling, stale)
        if started is None:
            continue
        checked = _checked(document)
        if checked is None:
            errors.append({"source": "progress", "reason": "invalid record " + stem})
            continue
        try:
            done, total, label, failed, first = _counts(
                step_file(root, stem), started, int(limits["jobStateBytes"]))
        except ValueError:
            errors.append({"source": "progress", "reason": "invalid counts " + stem})
            done, total, label, failed, first = 0, 0, "", 0, ""
        branch, repo = _association(config, clock, stem, checked["repo"])
        # The record's own branch is the run's; a lease is only a guess at it.
        branch = checked.get("branch") or branch
        label = label or checked.get("label", "")
        # A record whose clock is ahead of this one has no elapsed time to report.
        elapsed = max(0.0, clock - started)
        eta = None
        if total and done >= minimum and done > 0:
            eta = math.ceil(elapsed / done * (total - done) / 60)
        runs.append({
            "key": stem,
            "repo": repo,
            "branch": branch,
            "label": label,
            # A run is always named: by what it runs, by its branch, or at the
            # least by its class and repository.
            "display": label or (branch + "@" + repo if branch else
                                 checked["command_class"] + " in " + repo),
            "done": done,
            "total": total,
            "failed": failed,
            "first_failure": first,
            "elapsed": elapsed,
            "eta_minutes": eta,
            "phase": checked["phase"],
            # Whether the governor is running the command or holding it, and,
            # while it holds it, its place in the queue and the wait it set. Each
            # is the governor's own figure; an absent one stays absent.
            "kind": document.get("kind"),
            "command_class": checked["command_class"],
            "queue_position": checked.get("queue_position"),
            "queue_total": checked.get("queue_total"),
            "wait_total": checked.get("total_seconds") if document.get("kind") == WAIT_KIND else None,
            "wait_left": checked.get("remaining_seconds") if document.get("kind") == WAIT_KIND else None,
        })
    result["runs"] = runs
    if runs:
        result["state"] = "ready"
    elif errors:
        result["state"] = "failed"
    else:
        result["state"] = "empty"
    return result
