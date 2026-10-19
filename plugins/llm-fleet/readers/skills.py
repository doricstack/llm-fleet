#!/usr/bin/env python3
"""The skill reader: findings from a scan this repository does not run.

The scan folder is written by another tool, so every document in it is treated
as untrusted: a malformed line is skipped, a malformed row is refused, and a
progress figure is only reported while the file behind it is fresh. Nothing in
this reader raises: a scan folder that is missing is unavailable, not an error
in the pane.
"""

from __future__ import annotations

import time
import json
from pathlib import Path
import re
from typing import Any, Mapping

from .jobs import short_path
from .runtime import cut, printable, read_bounded_json, read_bounded_text, shell_command

# A target folder named after a version or a commit hash belongs to its parent,
# so the parent is what the row is named after.
VERSION_OR_HASH = re.compile(r"(v?\d+(\.\d+)+\S*|[0-9a-f]{7,40})")
SUMMARY_NAME = "summary.json"
PROGRESS_NAME = "progress.json"
NOTICES_NAME = "notices.jsonl"
CLEAN = "clean"


def _read_json(path: Path, max_bytes: int) -> Any:
    """A JSON document from a folder this reader does not own."""
    return read_bounded_json(path, max_bytes)


def _countable(value: Any) -> bool:
    """Whether a field is a count this reader may publish as a denominator."""
    return isinstance(value, int) and not isinstance(value, bool) or isinstance(value, list)


def _count(value: Any) -> int:
    """A count, read from a number or a list, and zero for anything else."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        return len(value)
    return 0


def skill_name(target: Any) -> str:
    """A scan target's name, with a version or hash folder folded onto its parent."""
    if not isinstance(target, str) or not target:
        return ""
    name = Path(target).name
    if VERSION_OR_HASH.fullmatch(name):
        return Path(target).parent.name + "@" + name
    return name


def _text(value: Any) -> str:
    """A field printed as it stands, whether it is text or a number."""
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    return printable(value)


def issue_line(issue: Any, limit: int) -> str:
    """The first finding of a row, as one line, or nothing."""
    if not isinstance(issue, Mapping):
        return ""
    severity = printable(issue.get("severity"))
    category = printable(issue.get("category"))
    finding = printable(issue.get("finding"))
    where = "{0}:{1}".format(_text(issue.get("file")), _text(issue.get("line")))
    return cut("{0} {1}: {2} ({3})".format(severity, category, finding, where).strip(), limit) or ""


def skill_item(row: Any, home: Path | None, limit: int) -> dict[str, Any] | None:
    """One finding row, or None when the row does not carry what a row needs."""
    if not isinstance(row, Mapping):
        return None
    target = row.get("target")
    verdict = row.get("verdict")
    if not isinstance(target, str) or not isinstance(verdict, str):
        return None
    issues = row.get("issues")
    first = issues[0] if isinstance(issues, list) and issues else None
    score = row.get("score")
    return {
        "name": skill_name(target),
        "target": short_path(target, home) if home is not None else printable(target),
        "verdict": printable(verdict),
        "score": score if isinstance(score, (int, float)) and not isinstance(score, bool) else None,
        "hash": printable(row.get("hash") or ""),
        "issue": issue_line(first, limit),
    }


def read_notices(path: Path, now: float, window: float, limit: int,
                 max_bytes: int) -> dict[str, str]:
    """Recent notice verdicts by target, one line per notice, skipping what cannot be read.

    The file is bounded like every other read here: it is written by another tool
    in a folder this reader does not own, and a pipe or an oversized file must not
    stall a snapshot. Only the newest bytes are read, since the file is appended.
    """
    text = read_bounded_text(path, max_bytes, tail=True)
    if text is None:
        return {}
    notices: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            notice = json.loads(line)
        except ValueError:
            continue
        if not isinstance(notice, Mapping):
            continue
        at = notice.get("at")
        target = notice.get("target")
        verdict = notice.get("verdict")
        if isinstance(at, bool) or not isinstance(at, (int, float)):
            continue
        if not isinstance(target, str) or not isinstance(verdict, str):
            continue
        if now - float(at) <= window:
            notices[target] = printable(verdict)
    return notices


def report_command(config: Mapping[str, Any]) -> str | None:
    """The line that prints every finding, as configured, or None when it is not.

    The pane copies it and never runs it, so the configured argv is quoted for
    the person's shell rather than resolved here.
    """
    command = config["commands"]["skillReport"]
    return shell_command(list(command)) if command else None


def read_skills(config: Mapping[str, Any], *, now: float | None = None,
                home: Path | None = None) -> dict[str, Any]:
    """The findings worth showing, the newly noticed ones, and a live scan count."""
    source = config["sources"]["skills"]
    clock = float(now) if now is not None else time.time()
    limits = config["limits"]
    result: dict[str, Any] = {"state": "disabled", "generated_at": None, "counts": {},
                              "items": [], "new": [], "running": None, "errors": [],
                              "report_command": report_command(config)}
    if not source["enabled"]:
        return result
    folder = Path(source["directory"])
    if not folder.is_dir():
        result["state"] = "unavailable"
        result["errors"].append({"source": "skills", "reason": "no scan folder"})
        return result
    max_bytes = int(limits["jobStateBytes"])
    limit = int(limits["questionCharacters"])
    cap = int(limits["skillItems"])
    window = float(config["history"]["skillNoticeDays"]) * 86400
    stale = float(config["refresh"]["skillStaleSeconds"])
    # The summary lists every folder the scan saw, so it is far larger than a job
    # state file, and it is bounded by its own limit. A summary that is there and
    # cannot be read is said, not taken for a scan that has not run: the status
    # line would otherwise read as no scan at all on a machine that scans hourly.
    summary = _read_json(folder / SUMMARY_NAME, int(limits["skillScanBytes"]))
    if not isinstance(summary, Mapping):
        if (folder / SUMMARY_NAME).exists():
            result["errors"].append({
                "source": "skills",
                "reason": "the scan summary could not be read: larger than "
                          "limits.skillScanBytes, or not a JSON object"})
        summary = {}
    notices = read_notices(folder / NOTICES_NAME, clock, window, limit, max_bytes)
    progress = _read_json(folder / PROGRESS_NAME, max_bytes)
    running = None
    if isinstance(progress, Mapping) and progress.get("running"):
        try:
            fresh = clock - (folder / PROGRESS_NAME).stat().st_mtime <= stale
        except OSError:
            fresh = False
        if fresh and _countable(progress.get("done")) and _countable(progress.get("total")):
            running = {"done": _count(progress.get("done")), "total": _count(progress.get("total"))}
    items: list[dict[str, Any]] = []
    new: list[dict[str, Any]] = []
    for row in summary.get("targets") or []:
        if not isinstance(row, Mapping):
            continue
        if row.get("verdict") == CLEAN or row.get("reviewed") is True:
            continue
        item = skill_item(row, home, limit)
        if item is None:
            continue
        if len(items) < cap:
            items.append(item)
        # A notice names the target the scan wrote, so it is matched as written:
        # comparing it with the shortened path a row displays would never match.
        if row.get("target") in notices and len(new) < cap:
            new.append(item)
    result["generated_at"] = summary.get("generated_at")
    counts = summary.get("counts")
    result["counts"] = counts if isinstance(counts, Mapping) else {}
    result["items"] = items
    result["new"] = new
    result["running"] = running
    # A summary that could not be read is a failed read, not an empty scan.
    result["state"] = "ready" if (items or running) else "failed" if result["errors"] else "empty"
    return result
