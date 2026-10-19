#!/usr/bin/env python3
"""The pull-request reader: open pull requests and their check verdicts.

One command runs per configured repository, in parallel, and each repository
answers for itself. A repository whose read failed is reported as failed and is
not cached, so the next read tries it again instead of serving a stale failure
as an answer.

`@me` among the repositories stands for every repository holding an open pull
request the signed-in account authored. The search that finds them answers no
check state, so each repository it names is then read like any other, limited
to that author's pull requests: a repository listed by name shows all of its
open pull requests, and one found through `@me` shows only the person's own.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any, Mapping

from .runtime import (CACHE_BYTES, ReaderFailure, child_environment, printable, read_bounded_json,
                      resolve_command, run_json, write_private_json)

# GitHub's own vocabulary for a check rollup. A state this reader does not
# recognize is neither a pass nor a failure: it leaves the row pending.
FAILED_CHECKS = frozenset({"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR",
                           "STARTUP_FAILURE"})
PASSED_CHECKS = frozenset({"SUCCESS", "SKIPPED", "NEUTRAL"})
PENDING = "PENDING"
FIELDS = "number,title,headRefName,headRefOid,isDraft,createdAt,statusCheckRollup"
# The name carries the shape of the rows the cache holds, and changes with it:
# an installed copy of another version shares the state folder, and under one
# name each would serve the other rows missing what it draws.
CACHE_NAME = "prs-2.json"
MINE = "@me"
# Where the search's answer is kept in the cache, beside the repositories.
MINE_KEY = "@me:search"
HEAD_LENGTH = 12
# The longest check name a row carries; a name is a label, not a document.
CHECK_NAME_LENGTH = 80
# How bad each per-check state is: a cap keeps the worst first, and two
# undated runs of one check keep the worse.
SEVERITY = {"fail": 2, "pending": 1, "pass": 0}


def _verdict(check: Any) -> str:
    """GitHub's word for one check, upper case; PENDING for anything not a check."""
    if not isinstance(check, Mapping):
        return PENDING
    state = check.get("conclusion") or check.get("state") or ""
    status = check.get("status")
    if isinstance(status, str) and status and status != "COMPLETED":
        state = PENDING
    return str(state).upper()


def check_state(check: Any) -> str:
    """One check as pass, fail or pending; a word this reader does not know is pending."""
    verdict = _verdict(check)
    if verdict in FAILED_CHECKS:
        return "fail"
    if verdict in PASSED_CHECKS:
        return "pass"
    return "pending"


def checks_state(rollup: Any) -> str:
    """One verdict for a rollup: pass, fail, pending, or none at all."""
    if not isinstance(rollup, list) or not rollup:
        return "none"
    verdicts = [_verdict(check) for check in rollup]
    if any(verdict in FAILED_CHECKS for verdict in verdicts):
        return "fail"
    if verdicts and all(verdict in PASSED_CHECKS for verdict in verdicts):
        return "pass"
    return "pending"


def _stamp(value: Any) -> datetime | None:
    """An ISO 8601 time GitHub wrote, as an aware time; None for anything else."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _iso(moment: datetime | None) -> str | None:
    if moment is None:
        return None
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _check_name(check: Mapping[str, Any]) -> str:
    """A check run's whole name or a status context's; empty when it states neither.

    The name is cut to a label only where a dot is drawn: two checks whose names
    share the part a label shows are still two checks.
    """
    for key in ("name", "context"):
        value = check.get(key)
        if isinstance(value, str) and value:
            return printable(value)
    return ""


def _standing(runs: list[tuple[dict[str, str], datetime | None]]) -> dict[str, str]:
    """The one run of a check named more than once that stands for it.

    Among the runs that state a time the latest stands, and runs finished at
    one time leave the worst. A run that states no time cannot be ordered
    against the others and never borrows a time from one, so the worst undated
    run is weighed against the dated one that stands and the worse of the two
    is kept: an undated failure is never replaced. The answer does not depend
    on the order the rollup lists the runs in.
    """
    dated = [(when, SEVERITY[run["state"]], run) for run, when in runs if when is not None]
    undated = [(SEVERITY[run["state"]], run) for run, when in runs if when is None]
    candidates: list[tuple[int, dict[str, str]]] = []
    if dated:
        latest = max(when for when, _, _ in dated)
        candidates.append(max(((severity, run) for when, severity, run in dated
                               if when == latest), key=lambda pair: pair[0]))
    if undated:
        candidates.append(max(undated, key=lambda pair: pair[0]))
    return max(candidates, key=lambda pair: pair[0])[1]


def check_runs(rollup: Any, limit: int) -> tuple[list[dict[str, str]], int]:
    """Each check as a name and a state, by name, capped at `limit`, and the count past it.

    A check named twice is one check run again, and `_standing` says which run
    stands for it: the latest, the worst of runs at one time, and never one that
    hides an undated failure. Checks are matched by their whole name, and the
    label each dot carries is cut to `CHECK_NAME_LENGTH`. A check with no name
    is never merged with another: it keeps its own dot under the empty name, so
    the dots still add up to the rollup. Past the cap the
    failing checks are kept first, then the pending ones, and the kept dots are
    drawn by name; `checks` still holds the verdict of the whole rollup.
    """
    if not isinstance(rollup, list):
        return [], 0
    named: dict[str, list[tuple[dict[str, str], datetime | None]]] = {}
    unnamed: list[dict[str, str]] = []
    for check in rollup:
        if not isinstance(check, Mapping):
            unnamed.append({"name": "", "state": "pending"})
            continue
        run = {"name": _check_name(check), "state": check_state(check)}
        if not run["name"]:
            unnamed.append(run)
            continue
        when = _stamp(check.get("completedAt")) or _stamp(check.get("startedAt"))
        named.setdefault(run["name"], []).append((run, when))
    # Checks are told apart by the whole name; only the label drawn is cut.
    runs = unnamed + [_standing(named[name]) for name in sorted(named)]
    runs = [{"name": run["name"][:CHECK_NAME_LENGTH], "state": run["state"]} for run in runs]
    if len(runs) <= limit:
        return runs, 0
    order = sorted(range(len(runs)), key=lambda index: -SEVERITY[runs[index]["state"]])
    kept = sorted(order[:max(0, limit)])
    return [runs[index] for index in kept], len(runs) - len(kept)


def pull_requests(repository: str, rows: Any, check_limit: int = 12,
                  mine: bool = False) -> list[dict[str, Any]]:
    """One row per open pull request, with nothing invented for a missing field.

    `mine` says this repository was found through the person's own search rather
    than named outright, which is what lets the pane drop the owner from a row
    where every repository carries the same one.
    """
    if not isinstance(rows, list):
        return []
    collected = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        head = row.get("headRefOid")
        runs, more = check_runs(row.get("statusCheckRollup"), check_limit)
        collected.append({
            "repo": repository,
            "mine": mine,
            "number": row.get("number") if isinstance(row.get("number"), int) else None,
            "title": printable(row.get("title") or ""),
            "branch": printable(row.get("headRefName") or ""),
            "head": printable(head)[:HEAD_LENGTH] if isinstance(head, str) else "",
            "is_draft": row.get("isDraft") is True,
            "checks": checks_state(row.get("statusCheckRollup")),
            "check_runs": runs,
            "check_runs_more": more,
            # When the pull request was opened, as GitHub states it.
            "opened_at": _iso(_stamp(row.get("createdAt"))),
        })
    return collected


def _searched(document: Any) -> list[str]:
    """The repositories a pull-request search names, each once, in a stable order."""
    names: set[str] = set()
    if isinstance(document, list):
        for row in document:
            repository = row.get("repository") if isinstance(row, Mapping) else None
            name = repository.get("nameWithOwner") if isinstance(repository, Mapping) else None
            # A name is owner/project and nothing else: it becomes an argument.
            if isinstance(name, str) and name.count("/") == 1 and not name.startswith("-") \
                    and all(part and not part.isspace() for part in name.split("/")):
                names.add(name)
    return sorted(names)


def _cache_path(config: Mapping[str, Any]) -> Path | None:
    state = config.get("stateDir")
    return Path(state) / CACHE_NAME if state else None


def _read_cache(path: Path | None) -> dict[str, Any]:
    """The cache as written, never read through a link; empty for anything else."""
    if path is None:
        return {}
    document = read_bounded_json(path, CACHE_BYTES)
    return document if isinstance(document, dict) else {}


def _write_cache(path: Path | None, document: dict[str, Any]) -> bool:
    if path is None:
        return False
    try:
        write_private_json(path, document)
    except OSError:
        return False
    return True


def read_prs(config: Mapping[str, Any], *, environ: Mapping[str, str] | None = None,
             now: float | None = None) -> dict[str, Any]:
    """Open pull requests per configured repository, with each failure named."""
    source = config["sources"]["prs"]
    clock = float(now) if now is not None else time.time()
    errors: list[dict[str, str]] = []
    result: dict[str, Any] = {"state": "disabled", "prs": [], "errors": errors}
    if not source["enabled"]:
        return result
    named = [str(entry) for entry in source["repositories"]]
    environment = dict(os.environ if environ is None else environ)
    command = config["commands"]["github"]
    resolved = resolve_command(command, environment)
    if resolved is None:
        result["state"] = "unavailable"
        errors.append({"source": "prs", "reason": command[0] + " is not on PATH"})
        return result
    child = child_environment(config["runtime"]["childEnvironment"], environment)
    timeout = float(config["timeouts"]["commandSeconds"])
    ttl = float(config["cache"]["prSeconds"])
    limit = int(source["limit"])
    check_limit = int(source["checkRunLimit"])
    path = _cache_path(config)
    cached = _read_cache(path)
    kept: dict[str, Any] = {}

    def fresh(entry: Any, field: str) -> bool:
        return isinstance(entry, Mapping) and isinstance(entry.get("at"), (int, float)) \
            and 0 <= clock - float(entry["at"]) < ttl and isinstance(entry.get(field), list)

    # Each read is keyed by what it asks for: a repository by name, or a
    # repository found through `@me`, whose list holds only the person's own.
    reads: list[tuple[str, str, bool]] = [(name, name, False) for name in named if name != MINE]
    if MINE in named:
        found: list[str] | None = None
        entry = cached.get(MINE_KEY)
        if fresh(entry, "repos"):
            kept[MINE_KEY] = entry
            found = [str(name) for name in entry["repos"]]
        else:
            argv = [*resolved, "search", "prs", "--author=@me", "--state=open",
                    "--limit", str(limit), "--json", "repository"]
            try:
                found = _searched(run_json(argv, child, timeout))
                kept[MINE_KEY] = {"at": clock, "repos": found}
            except ReaderFailure as failure:
                errors.append({"source": "prs:" + MINE, "reason": str(failure)})
        explicit = {name for name in named if name != MINE}
        reads.extend((MINE + ":" + name, name, True) for name in found or []
                     if name not in explicit)
    rows: list[dict[str, Any]] = []
    pending: list[tuple[str, str, bool]] = []
    mine_of = {key: mine for key, _repository, mine in reads}
    for key, repository, mine in reads:
        entry = cached.get(key)
        if fresh(entry, "prs"):
            kept[key] = entry
            rows.extend(entry["prs"])
            continue
        pending.append((key, repository, mine))

    def fetch(read: tuple[str, str, bool]) -> tuple[str, str, Any, str | None]:
        key, repository, mine = read
        argv = [*resolved, "pr", "list", "--repo", repository, "--state", "open",
                "--limit", str(limit), "--json", FIELDS]
        if mine:
            argv.extend(["--author", MINE])
        try:
            return key, repository, run_json(argv, child, timeout), None
        except ReaderFailure as failure:
            return key, repository, None, str(failure)

    if pending:
        with ThreadPoolExecutor(max_workers=max(1, len(pending))) as pool:
            answers = list(pool.map(fetch, pending))
        for key, repository, document, failure in answers:
            if failure is not None:
                errors.append({"source": "prs:" + repository, "reason": failure})
                continue
            collected = pull_requests(repository, document, check_limit,
                                      mine_of.get(key, False))
            kept[key] = {"at": clock, "prs": collected}
            rows.extend(collected)
    if _write_cache(path, kept) is False and (rows or errors):
        errors.append({"source": "prs", "reason": "cache was not written"})
    result["prs"] = sorted(rows, key=lambda row: (row["repo"], -(row["number"] or 0)))
    if rows:
        result["state"] = "ready"
    elif errors:
        result["state"] = "failed"
    else:
        result["state"] = "empty"
    return result
