#!/usr/bin/env python3
"""The provider roster reader: background jobs and interactive counts.

One roster command runs per ready provider home, in its own configuration
directory, with a child environment that carries no provider credential. The
result reports what happened: a read that failed is reported as a failure with
its reason, never as a provider with nothing running.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import tempfile
import time
from typing import Any, Mapping

from .agents import bucket_layout, read_agent
from .alerts import read_owned_json, reply_marker, state_root, write_json
from .jobs import job_activity, job_entered_at, job_question, short_path
from .runtime import (CACHE_BYTES, ReaderFailure, child_environment, printable, read_bounded_json,
                      resolve_command, run_json, shell_command, valid_job_id, write_private_json)


STATE_ORDER = {"blocked": 0, "working": 1}
BACKGROUND = "background"
INTERACTIVE = "interactive"
# Where each job's state and the time it entered it are kept between reads,
# beside the other caches in the state directory.
# The folder beneath the state directory that holds the readers' own records.
RECORDS = "records"
JOB_STATES_NAME = "job-states.json"
# Where one roster answer may be kept, so a read that lands inside the window a
# person set does not run the provider commands again.
CACHE_NAME = "roster.json"


def _cache_path(config: Mapping[str, Any]) -> Path | None:
    """Where a kept roster answer lives, or None when this machine keeps none."""
    state = config.get("stateDir")
    return Path(state) / CACHE_NAME if state else None


def _kept_answer(config: Mapping[str, Any], clock: float) -> dict[str, Any] | None:
    """The roster kept within the configured window, or None.

    A window of nothing keeps nothing, which is the packaged default: the
    command is the only way to ask, and a person who sets no window pays for
    every read rather than being handed an answer of an age nobody chose. An
    answer dated after the read that finds it is not fresh either: the clock
    moved, and the window is measured forward from what was kept.
    """
    window = float(config["cache"]["rosterSeconds"])
    if window <= 0:
        return None
    path = _cache_path(config)
    document = read_bounded_json(path, CACHE_BYTES) if path is not None else None
    if not isinstance(document, Mapping):
        return None
    at = document.get("at")
    kept = document.get("roster")
    if not isinstance(at, (int, float)) or not isinstance(kept, Mapping):
        return None
    age = clock - float(at)
    return dict(kept) if 0 <= age < window else None


def _keep_answer(config: Mapping[str, Any], clock: float, result: Mapping[str, Any]) -> None:
    """Keep this answer for the next read, when there is one worth keeping.

    Only an answer is kept. A failure kept for a minute is a session told its
    machine is broken long after it stopped being, so a failed read is left to
    be asked again by the read that follows it. A window of nothing keeps
    nothing either, and writing a record no read will look at is a cost with no
    answer bought by it.
    """
    if result.get("state") not in ("ready", "empty"):
        return
    if float(config["cache"]["rosterSeconds"]) <= 0:
        return
    path = _cache_path(config)
    if path is None:
        return
    try:
        write_private_json(path, {"at": clock, "roster": dict(result)})
    except OSError:
        # A record that cannot be written costs the next read its command and
        # nothing else, which is not worth failing a reading over.
        pass


def _previous_states(previous: Any) -> dict[tuple[str, str], dict[str, Any]]:
    """Each job's state and since, as the previous snapshot recorded them."""
    if not isinstance(previous, Mapping):
        return {}
    states: dict[tuple[str, str], dict[str, Any]] = {}
    for job in previous.get("jobs", []):
        if isinstance(job, Mapping) and "since" in job:
            states[(str(job.get("provider")), str(job.get("id")))] = {
                "state": job.get("state"), "since": job.get("since"),
                "since_observed": job.get("since_observed") is True,
                "entered_at": job.get("entered_at")}
    return states


def _record_path(config: Mapping[str, Any]) -> Path | None:
    state = config.get("stateDir")
    return Path(state) / RECORDS / JOB_STATES_NAME if state else None


def _entry(value: Any, now: float, skew: float = 0.0) -> dict[str, Any] | None:
    """One kept state, or None for anything a read of this machine could not have written.

    A time ahead of the read is refused unless it is within `skew`: a clock
    stepped back a little leaves a kept time just ahead of the next read, and
    that time is still the one the job entered its state at.
    """
    if not isinstance(value, Mapping):
        return None
    provider, job_id, state, since = (value.get("provider"), value.get("id"),
                                      value.get("state"), value.get("since"))
    if not isinstance(provider, str) or not valid_job_id(job_id) or not isinstance(state, str):
        return None
    since = _kept_time(since)
    if since is None or since > now + skew:
        return None
    # Whether `since` is the read that saw the job change state, rather than
    # the read that first saw it at all. A record that does not say is the latter.
    # The date a read gave the job's change into this state is kept with it,
    # held to the same bounds as `since`; anything else reads as undated.
    entered = _kept_time(value.get("entered_at"))
    if entered is not None and entered > now + skew:
        entered = None
    return {"provider": provider, "id": job_id, "state": state, "since": since,
            "since_observed": value.get("since_observed") is True,
            "entered_at": entered}


def _kept_time(value: Any) -> float | None:
    """A time a kept record holds, as a finite float, or None for anything else.

    A JSON integer can have any number of digits, and one too large for a float
    raises when it is converted rather than reading as not finite: raised here,
    one damaged record failed the whole roster on every read.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        converted = float(value)
    except OverflowError:
        return None
    return converted if math.isfinite(converted) else None


def load_job_states(config: Mapping[str, Any], now: float) -> dict[str, Any]:
    """The job states an earlier read kept, in the shape a roster document has.

    The read command is a new process each time, so this record is the only way
    an earlier read reaches this one. It is read under the job-state bound and
    never through a link; a record that is missing, damaged or too large reads
    as no record, so the worst it can do is date each job from this read.
    """
    path = _record_path(config)
    document = None if path is None else read_owned_json(
        path, int(config["limits"]["jobStateBytes"]))
    jobs = document.get("jobs") if isinstance(document, Mapping) else None
    skew = float(config["limits"]["jobStateClockSkewSeconds"])
    kept: list[dict[str, Any]] = []
    if isinstance(jobs, list):
        for value in jobs:
            entry = _entry(value, now, skew)
            if entry is not None:
                kept.append(entry)
    return {"jobs": kept}


def keep_job_states(config: Mapping[str, Any], result: Mapping[str, Any],
                    previous: Mapping[str, Any], now: float) -> bool:
    """Write this read's job states for the next read; False when they were not written.

    A provider whose command did not run, or whose output did not parse, keeps
    the states the record held for it, so one failed read does not date its jobs
    afresh: only a provider the roster lists as answered gives its states up.
    The record stays inside the same bound it is read under: the newest states
    are kept first and the rest dropped, and it is written whole or not at all.
    """
    path = _record_path(config)
    if path is None:
        return False
    answered = {name for name in result.get("answered") or [] if isinstance(name, str)}
    skew = float(config["limits"]["jobStateClockSkewSeconds"])
    entries: list[dict[str, Any]] = []
    for job in result.get("jobs") or []:
        entry = _entry(job, now, skew)
        if entry is not None:
            entries.append(entry)
    for entry in previous.get("jobs") or []:
        if entry["provider"] not in answered:
            entries.append(entry)
    entries.sort(key=lambda entry: entry["since"], reverse=True)
    bound = int(config["limits"]["jobStateBytes"])
    kept: list[dict[str, Any]] = []
    size = len(json.dumps({"jobs": []}))
    for entry in entries:
        added = len(json.dumps(entry)) + 2
        if size + added > bound:
            break
        kept.append(entry)
        size += added
    try:
        # The folder is never a link and this user's alone, the file is made for
        # this user alone, and a link planted at its name is replaced rather
        # than written through.
        write_json(path, {"jobs": kept})
    except OSError:
        return False
    return True


def _since(job: dict[str, Any], previous: dict[tuple[str, str], dict[str, Any]],
           now: float) -> tuple[float | None, bool]:
    """When the job entered its current state, as far as any read has seen, and whether a read saw it.

    A state that held since the previous read keeps its time, and whether that
    time was seen. A changed state starts now, and this read saw it change. A
    job no read saw before is in its state since now, except a finished one,
    which finished no later than it started; neither time is a change anyone
    saw, so neither is said to be one.
    """
    before = previous.get((job["provider"], job["id"]))
    if before is not None:
        if before["state"] == job["state"]:
            return before["since"], before.get("since_observed") is True
        return now, True
    if job["state"] == "done":
        return job["started_at"], False
    return now, False


def _entered_at(job: dict[str, Any], before: dict[str, Any] | None, recorded: float | None,
                now: float, skew: float) -> float | None:
    """The best real time the job entered its state, or None where no source states one.

    A date an earlier read gave this state stands until the job leaves it: the
    job rewrites its file while it waits, and a wait dated again by each write
    would be news each time.

    Otherwise the job's own file comes first, when it agrees with the registry
    and its time could be the change. It could not be when it is older than the
    time a read saw the job enter the state it held before, since that state
    came after it: the file is still describing an earlier spell in the same
    state. Nor could it be when it is later than the read that first saw the
    job already in this state, since the change came before that read; nor
    past this read's clock by more than the skew a kept time is allowed.

    Failing the file, a read that saw the state change stands. A job first seen
    already in its state, with no usable time in its file, has no such time:
    `since` there is only when a read first looked, and a digest that took it
    as the change would call a job waiting for a day new.
    """
    if before is not None and before["state"] == job["state"]:
        if before.get("entered_at") is not None:
            return before["entered_at"]
        earliest, latest = None, before["since"]
    else:
        earliest = before["since"] if before is not None else None
        latest = now + skew
    if recorded is not None and recorded <= latest \
            and (earliest is None or recorded >= earliest):
        return recorded
    return job["since"] if job["since_observed"] else None


def _finished_at(job: Mapping[str, Any]) -> float | None:
    """A finished job's finish where one is known, else its `since`."""
    return job["entered_at"] if job["entered_at"] is not None else job["since"]


def attach_command(command: list[Any], home: Path, job_id: str) -> str | None:
    """The line that opens a background job in a terminal, in its own provider home.

    The home is named in full: a shell set up for one provider carries its own
    configuration directory, and a bare `attach` there looks for the job in the
    wrong place. Every word is quoted for a POSIX shell, so an identifier or a
    home holding a space or a quote is one argument when pasted. An empty
    identifier names no job, and gets no line rather than one that attaches to
    nothing.
    """
    if not job_id:
        return None
    return shell_command([*command, "attach", job_id],
                         environment={"CLAUDE_CONFIG_DIR": str(home)})


def _rows_to_jobs(rows: list[Any], provider: dict[str, Any], config: Mapping[str, Any],
                  previous: dict[tuple[str, str], dict[str, Any]], now: float) -> list[dict[str, Any]]:
    """The background rows worth showing: every live one, and recently finished ones."""
    home = Path(provider["home"])
    limits = config["limits"]
    history = config["history"]
    limit = int(limits["questionCharacters"])
    live: list[dict[str, Any]] = []
    finished: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, Mapping) or row.get("kind") != BACKGROUND:
            continue
        started = row.get("startedAt")
        job: dict[str, Any] = {
            "id": str(row.get("id", "")),
            "name": printable(row.get("name") or row.get("id") or "unnamed")[:limit],
            "state": str(row.get("state") or "unknown"),
            "cwd": short_path(row.get("cwd") or "", home),
            "started_at": started / 1000 if isinstance(started, (int, float)) else None,
            "provider": provider["id"],
            "label": provider["label"],
            "session_id": row["sessionId"] if isinstance(row.get("sessionId"), str) else None,
            "needs": None,
            # The whole question's hash: the drawn one is cut, and a reply is sent
            # only to the question it was typed for.
            "needs_hash": None,
            "suggested_reply": None,
            # Where a reply to the question stands: pending since a time, or sent.
            "reply": None,
            # Whether a working job is mid-turn or sitting idle, when the registry says.
            "activity": row.get("status") if row.get("status") in ("busy", "idle") else None,
        }
        job["attach_command"] = attach_command(list(config["commands"]["claude"]), home, job["id"])
        if job["state"] == "blocked":
            job["needs"], job["suggested_reply"], job["needs_hash"] = job_question(
                home, job["id"], limits)
            if job["needs_hash"] is not None and config.get("stateDir"):
                job["reply"] = reply_marker(state_root(Path(config["stateDir"])), provider["id"], job["id"],
                                            job["session_id"], job["needs_hash"])
        job["detail"], job["fan"] = job_activity(home, job["id"], limits)
        job["since"], job["since_observed"] = _since(job, previous, now)
        job["entered_at"] = _entered_at(
            job, previous.get((job["provider"], job["id"])),
            job_entered_at(home, job["id"], job["state"], limits), now,
            float(limits["jobStateClockSkewSeconds"]))
        if job["state"] == "done":
            # A finished job is recent by when it finished, where that is
            # known; a job first seen finished otherwise has only its start.
            ended = _finished_at(job)
            if ended is not None and now - ended <= int(history["finishedJobSeconds"]):
                finished.append(job)
            continue
        live.append(job)
    finished.sort(key=lambda job: _finished_at(job) or 0, reverse=True)
    kept = live + finished[:int(history["finishedJobLimit"])]
    if config["sources"]["agents"]["enabled"]:
        # Read only for the rows that are kept: a finished row the history
        # limit drops would cost a transcript read and draw nothing.
        for job in kept:
            # The card's own figures. A read that fails here fails this card,
            # with its reason, and leaves the row and the roster standing.
            try:
                job["agent"] = read_agent(home, job["session_id"], job["id"], config, now=now)
            except Exception as caught:  # one agent may never take the roster down
                job["agent"] = {"state": "failed", "steps": None, "spend_series": None,
                                "timeline": None,
                                "reason": "{0}: {1}".format(type(caught).__name__, caught)}
    return kept


def roster_spend(config: Mapping[str, Any], jobs: list[dict[str, Any]],
                 unread_providers: bool) -> dict[str, Any]:
    """Every card's spend series summed, bucket by bucket, over the rows the roster keeps.

    It covers the sessions this read priced: the live rows and the finished
    rows the history limit keeps, and no interactive session, since the roster
    reads no transcript for one. It is complete only when every one of those
    cards read its transcript whole for the window and every enabled provider
    was read; a card with no series, a provider that failed, or one whose home
    is unavailable leaves the buckets it would have filled unmeasured, so the
    series says so rather than drawing a zero.

    The cards' figures are summed as they are, unrounded, so the total is the
    sum of every card's total and each bucket the sum of the cards' buckets.
    """
    length, count = bucket_layout(config["history"])
    columns: list[list[float]] = [[] for _ in range(count)]
    totals: list[float] = []
    complete = not unread_providers
    sessions = 0
    for job in jobs:
        agent = job.get("agent")
        series = agent.get("spend_series") if isinstance(agent, Mapping) else None
        if not isinstance(series, Mapping) or len(series.get("buckets") or []) != count:
            complete = False
            continue
        sessions += 1
        complete = complete and series.get("complete") is True
        for index, value in enumerate(series["buckets"]):
            columns[index].append(float(value))
        totals.append(float(series["total"]))
    return {"bucket_minutes": length // 60,
            "buckets": [math.fsum(column) for column in columns],
            "total": math.fsum(totals),
            "complete": complete,
            "sessions": sessions}


def sort_jobs(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Blocked work first, then working, then idle; newest first inside a state."""
    return sorted(jobs, key=lambda job: (STATE_ORDER.get(job["state"], 2),
                                         -(job["started_at"] or 0)))


def read_providers(config: Mapping[str, Any], *, environ: Mapping[str, str] | None = None,
                   previous: Any = None, now: float | None = None) -> dict[str, Any]:
    """Read every ready provider home once, and report honestly what came back.

    `state` is one of the source states plus the two reader states: ready when
    rows were found, empty when a read reached every enabled home and found none,
    failed when a read failed and no rows came back, unavailable when the
    configured command or every ready home is missing, and disabled when the
    configuration switched the source off.

    A per-provider map is returned alongside, so a caller can render which home
    answered and which did not.
    """
    environment = dict(os.environ if environ is None else environ)
    clock = float(now) if now is not None else time.time()
    jobs_source = config["sources"]["jobs"]
    interactive_source = config["sources"]["interactive"]
    errors: list[dict[str, str]] = []
    # The providers whose command ran and whose output parsed: the only ones a
    # read has the right to speak for. A provider configured ready whose command
    # could not be found is not among them.
    answered: list[str] = []
    # The spend over the window stays None until a provider answered with the
    # agent source on: a series of zeros from a roster nobody read is a claim.
    result: dict[str, Any] = {"state": "disabled", "jobs": [], "interactive": {},
                              "errors": errors, "providers": {}, "answered": answered,
                              "spend_series": None}
    # Every configured provider appears, whether or not a read reached it.
    for provider in config["providers"]:
        result["providers"][provider["id"]] = {"state": provider["state"], "reason": None}
    if not jobs_source["enabled"] and not interactive_source["enabled"]:
        result["sources"] = {"jobs": "disabled", "interactive": "disabled"}
        return result
    # An answer kept within the window a person set stands in for the read,
    # which is the whole of what that window buys: one command per provider
    # home, not run again until the answer is older than they allow.
    kept = _kept_answer(config, clock)
    if kept is not None:
        return kept

    ready = [provider for provider in config["providers"] if provider["state"] == "ready"]
    command = config["commands"]["claude"]
    resolved = resolve_command(command, environment)
    if not ready:
        result["state"] = "unavailable"
        errors.append({"source": "jobs", "reason": "no provider home is ready to read"})
    elif resolved is None:
        result["state"] = "unavailable"
        errors.append({"source": "jobs", "reason": "{0} is not on PATH".format(command[0])})
    else:
        timeout = float(config["timeouts"]["commandSeconds"])
        policy = config["runtime"]["childEnvironment"]
        states = _previous_states(previous)
        jobs: list[dict[str, Any]] = []
        counts: dict[str, int] = {}
        for provider in ready:
            label = provider["id"]
            child = child_environment(policy, environment,
                                      CLAUDE_CONFIG_DIR=str(provider["home"]))
            try:
                rows = run_json([*resolved, "agents", "--json", "--all"], child, timeout)
            except ReaderFailure as failure:
                result["providers"][label] = {"state": "failed", "reason": str(failure)}
                errors.append({"source": "jobs:" + label, "reason": str(failure)})
                continue
            if not isinstance(rows, list):
                result["providers"][label] = {"state": "failed", "reason": "not a list"}
                errors.append({"source": "jobs:" + label, "reason": "not a list"})
                continue
            result["providers"][label] = {"state": "ready", "reason": None}
            answered.append(label)
            jobs.extend(_rows_to_jobs(rows, provider, config, states, clock))
            count = sum(1 for row in rows
                        if isinstance(row, Mapping) and row.get("kind") == INTERACTIVE)
            if count:
                counts[label] = count
        for provider in config["providers"]:
            if provider["state"] != "ready":
                result["providers"][provider["id"]] = {"state": provider["state"], "reason": None}
        result["jobs"] = sort_jobs(jobs)
        result["interactive"] = counts
        if config["sources"]["agents"]["enabled"] and answered:
            # An enabled provider whose home is unavailable was never read, so
            # its sessions' spend is missing from the sum as a failed one's is.
            unavailable = any(provider["state"] == "unavailable"
                              for provider in config["providers"])
            result["spend_series"] = roster_spend(config, result["jobs"],
                                                  bool(errors) or unavailable)
        if jobs:
            result["state"] = "ready"
        elif errors or not answered:
            result["state"] = "failed"
        else:
            result["state"] = "empty"

    read_state = result["state"]
    result["sources"] = {
        "jobs": read_state if jobs_source["enabled"] else "disabled",
        "interactive": read_state if interactive_source["enabled"] else "disabled",
    }
    _keep_answer(config, clock, result)
    return result
