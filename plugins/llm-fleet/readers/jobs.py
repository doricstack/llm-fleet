#!/usr/bin/env python3
"""Job files: what a background job is doing, read from its own state file.

A job row carries no invented progress. What the registry reports and what the
job wrote about itself are the only two sources, and a read that fails leaves the
row without those fields rather than guessing them.
"""

from __future__ import annotations

from datetime import datetime
import errno
import hashlib
import math
import os
import stat
from pathlib import Path
from typing import Any, Callable, Mapping

from .runtime import READ_FLAGS, cut, printable, read_bounded_json, read_json_handle, valid_job_id


def state_file(home: Path, job_id: Any) -> Path | None:
    """The state file for a job id, or None when the id may not name a folder."""
    if not valid_job_id(job_id):
        return None
    return Path(home) / "jobs" / str(job_id) / "state.json"


def read_job_state(home: Path, job_id: Any, max_bytes: int) -> dict[str, Any] | None:
    """The job's own state file, bounded, or None."""
    located = state_file(home, job_id)
    if located is None:
        return None
    state = read_bounded_json(located, max_bytes)
    return state if isinstance(state, dict) else None


# A test's hook, run with the name about to be opened between one step of a
# contained read and the next, so a swap made mid-read can be staged.
_between: Callable[[str], None] | None = None


def _step(name: str) -> None:
    if _between is not None:
        _between(name)


#: Whether this platform opens a folder relative to another without following a
#: link. Windows does not, and there the path is checked and opened by name.
_WALKS = (os.open in os.supports_dir_fd and hasattr(os, "O_DIRECTORY")
          and hasattr(os, "O_NOFOLLOW"))

LINKED = "the job's state is reached through a link"
UNREADABLE = "the job's state file could not be read"
OUTSIDE = "the job's state lies outside its home"


def read_contained_state(home: Path, job_id: Any,
                         max_bytes: int) -> tuple[dict[str, Any] | None, str | None]:
    """The job's own state, read from inside its home with no link on the way.

    The home is the configured root, and a link there is the person's own, so it
    is opened by its real path. Below it the jobs folder, the job's folder and the
    state file are written by the job's model, and any of them that is a link
    could point a reply's check at another job's question. Each is opened through
    the folder opened before it, never followed if it is a link, and the file is
    read through the descriptor that opened it: a folder swapped for a link once
    the walk is past it changes nothing that is read.

    Where a folder cannot be opened relative to another (Windows), each part is
    checked by name, then the real path is checked to lie inside the home, and
    the file is opened by name. A folder swapped for a link after those checks
    is followed there; that window is the platform's and is named in the docs.

    Returns the state, or None with the reason.
    """
    if not valid_job_id(job_id):
        return None, "the job identifier may not name a folder"
    if not _WALKS:
        return _read_checked_by_name(home, str(job_id), max_bytes)
    try:
        folder = os.open(os.path.realpath(home), os.O_RDONLY | os.O_DIRECTORY)
    except (OSError, ValueError):
        return None, UNREADABLE
    try:
        for part in ("jobs", str(job_id)):
            _step(part)
            try:
                inner = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=folder)
            except OSError as failure:
                return None, _why(failure, part, folder)
            os.close(folder)
            folder = inner
        _step("state.json")
        try:
            handle = os.open("state.json", READ_FLAGS, dir_fd=folder)
        except OSError as failure:
            return None, _why(failure, "state.json", folder)
    finally:
        os.close(folder)
    state = read_json_handle(handle, max_bytes)
    return (state, None) if isinstance(state, dict) else (None, UNREADABLE)


def _why(failure: OSError, name: str, folder: int) -> str:
    """Why one step of the walk failed: a link where a folder or file should be, or not there.

    Platforms differ in the error a link opened without following gives (a loop
    on Linux, not a folder on macOS, too many links on FreeBSD), so the part is
    looked at itself rather than its error trusted.
    """
    if failure.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
        try:
            if stat.S_ISLNK(os.stat(name, dir_fd=folder, follow_symlinks=False).st_mode):
                return LINKED
        except OSError:
            pass
    return UNREADABLE


def _read_checked_by_name(home: Path, job_id: str,
                          max_bytes: int) -> tuple[dict[str, Any] | None, str | None]:
    """The checks a platform without folder descriptors can make, then a read by name."""
    current = Path(home)
    for part in ("jobs", job_id, "state.json"):
        _step(part)
        current = current / part
        if current.is_symlink():
            return None, LINKED
    _step("realpath")
    try:
        root = Path(os.path.realpath(home))
        real = Path(os.path.realpath(current))
    except (OSError, ValueError):
        return None, UNREADABLE
    if root not in real.parents:
        return None, OUTSIDE
    state = read_bounded_json(current, max_bytes)
    return (state, None) if isinstance(state, dict) else (None, UNREADABLE)


def question_digest(value: Any) -> str | None:
    """A SHA-256 of a whole question, its line endings made alike; None for no question.

    The drawn question is cut to fit a row, so two questions that share the part a
    row shows would read as one. The hash is of all of it, and line endings are
    the one difference ignored, since a file rewritten on another platform is
    asking the same thing.
    """
    if not isinstance(value, str) or value == "":
        return None
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def question_of(state: Mapping[str, Any],
                limit: int) -> tuple[str | None, str | None, str | None]:
    """A state's question and suggested reply, cut and made printable, and the question's hash."""
    needs = state.get("needs")
    return cut(needs, limit), cut(state.get("suggestedReply"), limit), question_digest(needs)


def job_question(home: Path, job_id: Any,
                 limits: Mapping[str, Any]) -> tuple[str | None, str | None, str | None]:
    """What a waiting job asks, the reply it suggests, and the hash of the whole question."""
    state = read_job_state(home, job_id, int(limits["jobStateBytes"]))
    if state is None:
        return None, None, None
    return question_of(state, int(limits["questionCharacters"]))


def job_activity(home: Path, job_id: Any,
                 limits: Mapping[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    """Detail and fan entries, each kept at its own original meaning."""
    state = read_job_state(home, job_id, int(limits["jobStateBytes"]))
    if state is None:
        return None, []
    limit = int(limits["questionCharacters"])
    detail = cut(state.get("detail"), limit)
    entries = state.get("fan")
    fan: list[dict[str, Any]] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        if not all(isinstance(entry.get(key), str) for key in ("kind", "label")):
            continue
        item: dict[str, Any] = {key: printable(entry[key])[:limit] for key in ("kind", "label")}
        for key in ("startedAt", "doneAt"):
            value = entry.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) \
                    and math.isfinite(value):
                item[key] = value
        fan.append(item)
    return detail, fan


def _file_time(value: Any) -> float | None:
    """A time a job file holds, ISO 8601 with its zone, as epoch seconds; None for anything else."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    seconds = moment.timestamp()
    return seconds if math.isfinite(seconds) and seconds > 0 else None


def state_entered_at(state: Mapping[str, Any] | None, registry_state: str) -> float | None:
    """When the job's own file says it entered the state the registry reports, or None.

    The file is believed only when its own `state` is the registry's, since a
    file one write behind would date another state. A finished job's file
    holds `lastTerminalAt`, written as it finishes, and nothing writes after
    that, so `updatedAt` stands in only where that is missing. A waiting job's
    file holds no time of its own for the change, so `updatedAt` is used: the
    last time the job wrote while waiting, which is never before it began to
    wait. Any other state, and a file that states neither, gives None.
    """
    if not isinstance(state, Mapping) or state.get("state") != registry_state:
        return None
    if registry_state == "done":
        finished = _file_time(state.get("lastTerminalAt"))
        return finished if finished is not None else _file_time(state.get("updatedAt"))
    if registry_state == "blocked":
        return _file_time(state.get("updatedAt"))
    return None


def job_entered_at(home: Path, job_id: Any, registry_state: str,
                   limits: Mapping[str, Any]) -> float | None:
    """`state_entered_at` for the job's state file as it is on disk."""
    state = read_job_state(home, job_id, int(limits["jobStateBytes"]))
    return state_entered_at(state, registry_state)


def short_path(path: Any, home: Path) -> str:
    """A working directory with its provider home folded to a tilde."""
    text = printable(path)
    prefix = str(home)
    if text == prefix:
        return "~"
    if text.startswith(prefix + os.sep):
        return "~" + text[len(prefix):]
    return text
