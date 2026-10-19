#!/usr/bin/env python3
"""Events for a "since you left" digest, drawn from what the readers already read.

Nothing here reads the machine. The events come from the documents of one whole
reading, and an event is emitted only where a document holds a real time for
it; the view layer keeps the ones newer than the person's last look, which this
module does not track.

| Kind | Document | Time |
| --- | --- | --- |
| `trial-passed`, `trial-failed` | `trials.recent`: the newest receipt per branch within `history.trialsSeconds` | The receipt's own created time |
| `pr-opened` | `prs.prs` | `opened_at`, the time GitHub states the pull request was opened |
| `job-finished` | `roster.jobs` in the `done` state | `entered_at`: the finish the job's own file records, else the read that saw it finish |
| `job-waiting` | `roster.jobs` in the `blocked` state | `entered_at`: the time the job's own file last wrote while waiting, else the read that saw it begin to wait |

What is never emitted, and why:

- `pr-merged`: the pull request reader lists open pull requests only. A merged
  one leaves the list, and no reader states when it merged.
- `job-finished` or `job-waiting` for a job with no `entered_at`: a job first
  seen already finished or waiting, whose file states no time for it. Its
  `since` is its start or the read that first looked, and its last turn comes
  before the change, so none of them is the change; dated by one, a job
  waiting for a day would read as new. The event is left out rather than
  given a time nobody recorded.
- An earlier receipt on a branch that has a newer one: the trial document keeps
  the newest per branch, so one event per branch is what the reading holds.
- Any event whose time is missing, not a number, or not a time.
"""

from __future__ import annotations

from datetime import datetime
import math
from typing import Any, Mapping

from .agents import iso_time

# The documents events come from, each named with the state it was read in.
SOURCES = ("trials", "prs", "roster")


def _number_time(value: Any) -> float | None:
    """Epoch seconds a reader recorded: a positive finite number, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    seconds = float(value)
    return seconds if math.isfinite(seconds) and seconds > 0 else None


def _text_time(value: Any) -> float | None:
    """An ISO 8601 time with its zone, as epoch seconds, or None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.timestamp() if moment.tzinfo is not None else None


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _rows(document: Any, key: str) -> list[Mapping[str, Any]]:
    rows = document.get(key) if isinstance(document, Mapping) else None
    return [row for row in rows if isinstance(row, Mapping)] if isinstance(rows, list) else []


def trial_events(document: Any) -> list[tuple[float, dict[str, str]]]:
    events = []
    for row in _rows(document, "recent"):
        at = _number_time(row.get("at"))
        verdict = row.get("is_green")
        # A row that states no verdict is neither a pass nor a failure.
        if at is None or not isinstance(verdict, bool):
            continue
        kind = "trial-passed" if verdict else "trial-failed"
        title = " ".join(part for part in (_text(row.get("repo")), _text(row.get("branch")))
                         if part)
        events.append((at, {"kind": kind, "title": title, "ref": _text(row.get("key"))}))
    return events


def pr_events(document: Any) -> list[tuple[float, dict[str, str]]]:
    events = []
    for row in _rows(document, "prs"):
        at = _text_time(row.get("opened_at"))
        if at is None:
            continue
        repository = _text(row.get("repo"))
        number = row.get("number")
        ref = repository + "#" + str(number) if isinstance(number, int) \
            and not isinstance(number, bool) else repository
        events.append((at, {"kind": "pr-opened", "title": _text(row.get("title")), "ref": ref}))
    return events


def job_events(document: Any) -> list[tuple[float, dict[str, str]]]:
    events = []
    for job in _rows(document, "jobs"):
        state = job.get("state")
        if state == "done":
            kind = "job-finished"
        elif state == "blocked":
            kind = "job-waiting"
        else:
            continue
        at = _number_time(job.get("entered_at"))
        if at is None:
            continue
        ref = _text(job.get("provider")) + ":" + _text(job.get("id"))
        events.append((at, {"kind": kind, "title": _text(job.get("name")), "ref": ref}))
    return events


def read_events(reading: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, Any]:
    """Every event the reading's documents hold a time for, newest first, capped.

    `sources` names the state each document was read in, so a digest built
    from a failed or disabled source can say what it could not see rather than
    read as a quiet stretch.
    """
    limit = int(config["history"]["eventLimit"])
    gathered = (trial_events(reading.get("trials")) + pr_events(reading.get("prs"))
                + job_events(reading.get("roster")))
    gathered.sort(key=lambda pair: (-pair[0], pair[1]["kind"], pair[1]["ref"]))
    events = [{"at": iso_time(at), **body} for at, body in gathered[:limit]]
    sources = {}
    for name in SOURCES:
        document = reading.get(name)
        state = document.get("state") if isinstance(document, Mapping) else None
        sources[name] = state if isinstance(state, str) else "absent"
    return {"state": "ready" if events else "empty", "events": events, "sources": sources,
            "errors": []}
