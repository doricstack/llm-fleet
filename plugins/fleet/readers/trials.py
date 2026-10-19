#!/usr/bin/env python3
"""The trial reader: what the change controller knows about tests it ran.

The controller store belongs to another tool. This reader opens it read-only,
never migrates it, and never lets a schema it does not recognize become a claim
about the work: an unreadable store is an error with a reason, and the rows it
did manage to read are kept.
"""

from __future__ import annotations

import time
import json
import math
from pathlib import Path
import re
import sqlite3
from typing import Any, Mapping

from .runtime import cut, printable, switch_state

# A receipt carries its own evidence document. Anything that is not a count is
# reported as zero rather than guessed at, and an absent selector result means
# the run did not select anything, not that it passed.
EXECUTED_DEFAULT = 1
SELECTED_DEFAULT = 0
SELECTOR_RESULT_DEFAULT = 1

RUNNING_LEASES = """
SELECT p.remote_url, c.branch, l.tool, l.expires_at, l.session
FROM leases l JOIN changes c USING(change_id) JOIN repos p USING(repo_id)
WHERE l.expires_at > ? ORDER BY p.remote_url, c.branch
"""

RECENT_RECEIPTS = """
SELECT r.receipt_id, p.remote_url, c.branch, c.state, r.evidence, r.created_at
FROM receipts r JOIN changes c USING(change_id) JOIN repos p USING(repo_id)
WHERE r.created_at > ? ORDER BY r.created_at DESC
"""

# Every change that is not finished and moved inside the window, with when it
# last moved and who holds it now. A change with no milestone at all never moved
# through the controller, so it is not in flight however its row reads.
CHANGES_IN_FLIGHT = """
SELECT p.remote_url, c.branch, c.state, m.moved_at,
       (SELECT l.tool FROM leases l WHERE l.change_id = c.change_id AND l.expires_at > ?)
FROM changes c JOIN repos p USING(repo_id)
JOIN (SELECT change_id, MAX(created_at) AS moved_at FROM milestones GROUP BY change_id) m
  USING(change_id)
WHERE m.moved_at >= ?
ORDER BY m.moved_at DESC
"""

# The states the controller uses for a change a person closed. The configured
# path names its own last stage, so only the closed states it does not name are
# listed here; anything else not on the path stays visible.
CLOSED_STATES = ("ABANDONED",)

LEASE_SESSIONS = """
SELECT l.session, p.remote_url, c.branch, c.worktree_path
FROM leases l JOIN changes c USING(change_id) JOIN repos p USING(repo_id)
WHERE l.expires_at > ?
"""


def repository_name(url: Any) -> str:
    """A repository's own name, taken from its remote URL."""
    text = str(url or "").rstrip("/")
    name = text.rsplit("/", 1)[-1]
    return name[:-4] if name.endswith(".git") else name


def count(value: Any) -> int:
    """A count, read from either a number or a list of items."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        return len(value)
    return 0


def facts_from(evidence: Any) -> dict[str, Any]:
    """The evidence document a receipt carries, or an empty one."""
    if isinstance(evidence, bytes):
        evidence = evidence.decode("utf-8", "replace")
    if not isinstance(evidence, str):
        return {}
    try:
        parsed = json.loads(evidence)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def trial_result(receipt: Any) -> dict[str, Any]:
    """One recent receipt as a row, with the four counts its evidence holds.

    A run is green only when the evidence says nothing failed, nothing errored,
    the selector itself succeeded, and it actually executed what it selected.
    """
    receipt_id, url, branch, state, evidence, created_at = receipt
    facts = facts_from(evidence)
    failed = count(facts.get("failed", 0))
    errors = count(facts.get("errors", 0))
    executed = count(facts.get("executed", EXECUTED_DEFAULT))
    selected = count(facts.get("selected", SELECTED_DEFAULT))
    selector_result = facts.get("selector_rc", SELECTOR_RESULT_DEFAULT)
    green = (failed == 0 and errors == 0 and selector_result == 0
             and not facts.get("collection_errors")
             and not (executed == 0 and selected > 0))
    return {
        "key": printable(receipt_id),
        "repo": repository_name(url),
        "branch": printable(branch),
        "change_state": printable(state),
        "at": created_at,
        "is_green": bool(green),
        "passed": count(facts.get("passed", 0)),
        "failed": failed,
        "errors": errors,
        "skipped": count(facts.get("skipped", 0)),
    }


def latest_per_branch(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One receipt per branch, the newest the store holds."""
    seen: set[tuple[str, str]] = set()
    kept: list[dict[str, Any]] = []
    for row in rows:
        key = (row["repo"], row["branch"])
        if key in seen:
            continue
        seen.add(key)
        kept.append(row)
    return kept


def _connect(path: Path, seconds: float) -> sqlite3.Connection:
    """A read-only connection to the controller store."""
    return sqlite3.connect("file:{0}?mode=ro".format(path), uri=True, timeout=seconds)


def lease_sessions(config: Mapping[str, Any], now: float) -> list[dict[str, str]]:
    """Live leases as session-to-branch associations, or nothing when unknown.

    A store this reader cannot read cannot prove which branch a session is
    trying, so the caller is told nothing rather than told the wrong branch.
    """
    source = config["sources"]["trials"]
    if not source["enabled"] or not source["database"]:
        return []
    marker = source.get("paused_when_exists")
    if marker and Path(marker).exists():
        return []
    path = Path(source["database"])
    if not path.is_file():
        return []
    timeout = float(config["timeouts"]["leaseDatabaseSeconds"])
    try:
        with sqlite3.connect("file:{0}?mode=ro".format(path), uri=True,
                             timeout=timeout) as connection:
            rows = connection.execute(LEASE_SESSIONS, (now,)).fetchall()
    except (sqlite3.Error, OSError):
        return []
    return [{"session": str(session) if session is not None else "",
             "repo": repository_name(url),
             "branch": printable(branch),
             "worktree_repo": re.sub(r"[^A-Za-z0-9._-]", "", Path(str(path_of or "")).name)}
            for session, url, branch, path_of in rows]


def history_of(outcomes: list[dict[str, Any]], clock: float,
               window: float) -> dict[str, Any]:
    """The window's trials, one bucket per hour, oldest first.

    The strip a pane draws from this is one cell per bucket, so a bucket has to
    mean one stretch of the clock rather than one twelfth of however many trials
    happened to land. The buckets are aligned to now, which is what makes the
    last cell "the hour we are in" and lets two readings an hour apart be read
    against each other.

    Every receipt in the window counts, not the newest per branch: a strip of one
    cell per branch would answer "how did the branches do" and be read as "how
    did the day go". What failed in a bucket is what a reader is looking for, so
    a bucket holding one failure is red whatever else it holds.
    """
    hours = max(1, int(round(window / 3600)))
    buckets = [{"outcomes": 0, "failed": 0} for _ in range(hours)]
    for outcome in outcomes:
        at = outcome.get("at")
        if not isinstance(at, (int, float)) or isinstance(at, bool):
            # A receipt with no readable time cannot be placed in an hour. It is
            # left out of the strip rather than dropped into the oldest bucket,
            # which is where a guess would put it.
            continue
        age = clock - float(at)
        # A stamp that is not a finite number cannot be placed in an hour, and
        # `nan < 0` and `nan >= window` are both false, so it would reach the
        # index below and raise there, failing the whole document. A SQLite REAL
        # cannot hold a nan, so this is a guard rather than a repair.
        if not math.isfinite(age) or age < 0 or age >= window:
            continue
        # `age` is in [0, window), so the index is in [0, hours - 1] and needs no
        # clamp: a clamp here would be a line that can never run, which reads as
        # evidence of a case that does not exist.
        index = hours - 1 - int(age // (window / hours))
        bucket = buckets[index]
        bucket["outcomes"] += 1
        if not outcome.get("is_green", False):
            bucket["failed"] += 1
    return {
        "label": ("Last " + str(hours) + " hours") if hours != 1 else "Last hour",
        "hours": hours,
        "cells": buckets,
        "outcomes": sum(bucket["outcomes"] for bucket in buckets),
        "failed": sum(bucket["failed"] for bucket in buckets),
    }


def read_trials(config: Mapping[str, Any], *, now: float | None = None) -> dict[str, Any]:
    """The running trials and the recent verdicts, with any failure named."""
    source = config["sources"]["trials"]
    clock = float(now) if now is not None else time.time()
    limits = config["limits"]
    errors: list[dict[str, str]] = []
    # The history is named on every path a source can take, and it is null until
    # a store is read: a disabled or absent store has measured no buckets, and a
    # fold of empty ones would be the pane claiming twelve quiet hours out of a
    # source nobody asked.
    result: dict[str, Any] = {"state": "disabled", "running": [], "recent": [],
                              "history": None, "changes": [], "errors": errors}
    # The change controller shares the machine switch with the governor, so the
    # pane can say which of them a person switched off and which is only idle.
    state = switch_state(source)
    if state is not None:
        result["switch"] = state
    if not source["enabled"]:
        return result
    marker = source.get("paused_when_exists")
    if marker and Path(marker).exists():
        result["state"] = "paused"
        return result
    path = Path(source["database"])
    if not path.is_file():
        result["state"] = "unavailable"
        errors.append({"source": "trials", "reason": "no controller store"})
        return result
    timeout = float(config["timeouts"]["trialDatabaseSeconds"])
    window = float(config["history"]["trialsSeconds"])
    reason_limit = int(limits["questionCharacters"])
    try:
        with _connect(path, timeout) as connection:
            running = connection.execute(RUNNING_LEASES, (clock,)).fetchall()
            receipts = connection.execute(RECENT_RECEIPTS, (clock - window,)).fetchall()
    except (sqlite3.Error, OSError) as caught:
        result["state"] = "failed"
        errors.append({"source": "trials",
                       "reason": cut(str(caught), reason_limit) or "unreadable store"})
        return result
    result["running"] = [{"repo": repository_name(url), "branch": printable(branch),
                          "tool": printable(tool), "expires_at": expires,
                          "session": printable(session)}
                         for url, branch, tool, expires, session in running]
    outcomes = [trial_result(row) for row in receipts]
    result["recent"] = latest_per_branch(outcomes)
    result["history"] = history_of(outcomes, clock, window)
    result["changes"] = _changes(path, timeout, clock, window, list(source.get("stages") or []),
                                 errors, reason_limit)
    result["state"] = "ready" if (result["running"] or result["recent"] or result["changes"]) \
        else "empty"
    return result


def _changes(path: Path, timeout: float, clock: float, window: float, stages: list[str],
             errors: list[dict[str, str]], reason_limit: int) -> list[dict[str, Any]]:
    """The changes still moving through the controller, each with its place on the path.

    Read on its own: a store from before milestones were kept answers the leases
    and receipts as it always did, and the missing table is named rather than
    failing the whole source. A state the configured path does not name keeps
    its row with no place on the path, rather than a guessed one.
    """
    if not stages:
        return []
    try:
        with _connect(path, timeout) as connection:
            rows = connection.execute(CHANGES_IN_FLIGHT, (clock, clock - window)).fetchall()
    except (sqlite3.Error, OSError) as caught:
        errors.append({"source": "trials:changes",
                       "reason": cut(str(caught), reason_limit) or "unreadable store"})
        return []
    changes: list[dict[str, Any]] = []
    for url, branch, state, moved_at, holder in rows:
        state_name = printable(state)
        # The last stage is the configured path's own word for finished, and an
        # abandoned change is one a person closed deliberately. Neither is
        # moving through the controller, so neither is counted as in flight. A
        # state the path does not name keeps its row: a controller that added a
        # stage keeps its work visible in this pane until the path names it.
        if state_name == stages[-1] or state_name in CLOSED_STATES:
            continue
        place = stages.index(state_name) + 1 if state_name in stages else None
        changes.append({"repo": repository_name(url), "branch": printable(branch),
                        "state": state_name, "stage": place, "stages": len(stages),
                        "moved_at": moved_at if isinstance(moved_at, (int, float)) else None,
                        "held_by": printable(holder) if holder else None})
    return changes
