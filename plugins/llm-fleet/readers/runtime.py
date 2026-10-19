#!/usr/bin/env python3
"""The machine surface a reader may use, and the invariants that bound it.

A reader never touches the machine directly: it calls through here, so the
policy a read obeys is visible in one place. Three things are invariants rather
than preferences, because a config file must not be able to weaken them:

- a child process never inherits a provider credential,
- a job identifier is validated before it is used to build a path,
- a read is bounded in time and in bytes.

Everything else, including which variables to strip, comes from the resolved
configuration.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
from typing import Any, Mapping


# A job id names its own folder under the provider home. Nothing that could
# climb out of that folder, and nothing that is not a plain identifier.
JOB_ID = re.compile(r"[A-Za-z0-9_-]+")
# Windows defines neither flag; an explicit link check covers it there.
_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
# Windows opens a descriptor in text mode unless told otherwise, which turns
# every CRLF into LF as it reads: byte counts stop matching the file, and a
# bound measured in bytes stops meaning what it says.
_BINARY = getattr(os, "O_BINARY", 0)
_NON_BLOCKING = getattr(os, "O_NONBLOCK", 0)


class ReaderFailure(RuntimeError):
    """A read that could not be completed, with a reason fit for a pane row."""


def child_environment(policy: Mapping[str, Any], environ: Mapping[str, str],
                      **extra: str) -> dict[str, str]:
    """The environment a child command may see.

    Inherited provider credentials never reach a child: the roster command needs
    none, and a child that does not hold a key cannot leak one.
    """
    prefixes = tuple(policy.get("stripPrefixes", ()))
    names = frozenset(policy.get("stripNames", ()))
    child = {key: value for key, value in environ.items()
             if not key.startswith(prefixes) and key not in names}
    child.update(extra)
    return child


def resolve_command(argv: list[str], environ: Mapping[str, str]) -> list[str] | None:
    """A configured argv with its executable resolved, or None when it is absent.

    A name carrying a separator is taken as a path; a bare name is looked up on
    the PATH the child will actually receive, so a resolution that succeeds here
    cannot fail inside the child.
    """
    if not argv:
        return None
    name = argv[0]
    if os.sep in name or (os.altsep and os.altsep in name):
        return list(argv) if os.path.exists(name) else None
    located = shutil.which(name, path=environ.get("PATH"))
    if located is None:
        return None
    return [located, *argv[1:]]


def run_json(argv: list[str], environ: Mapping[str, str], timeout_seconds: float) -> Any:
    """Run argv and parse its stdout as JSON. Raises ReaderFailure with a reason."""
    try:
        completed = subprocess.run(list(argv), capture_output=True, text=True,
                                   env=dict(environ), timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        raise ReaderFailure("timed out after {0:g}s".format(timeout_seconds)) from None
    except OSError as caught:
        raise ReaderFailure(caught.strerror or type(caught).__name__) from None
    if completed.returncode != 0:
        raise ReaderFailure("exit {0}".format(completed.returncode))
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        raise ReaderFailure("output was not JSON") from None


def read_bounded_json(path: Path, max_bytes: int) -> Any:
    """A small regular file, parsed; None for anything else.

    The job's own model can write the folder this reads, so a link, a pipe, or a
    large file must not stall or swell a snapshot that every session waits on.
    """
    if os.path.islink(path):
        return None
    try:
        handle = os.open(path, READ_FLAGS)
    except OSError:
        return None
    return read_json_handle(handle, max_bytes)


#: How a file read through a descriptor is opened: not through a link, never waiting.
READ_FLAGS = os.O_RDONLY | _BINARY | _NO_FOLLOW | _NON_BLOCKING


def read_json_handle(handle: int, max_bytes: int) -> Any:
    """A file already opened, read within `max_bytes` and parsed; the handle is closed.

    None for anything that is not a regular file, is larger than the bound, or is
    not JSON.
    """
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            return None
        data = os.read(handle, max_bytes + 1)
    except OSError:
        return None
    finally:
        os.close(handle)
    if len(data) > max_bytes:
        return None
    try:
        return json.loads(data)
    except ValueError:
        return None


#: The most a reader's own cache under the state directory may hold before it is ignored.
CACHE_BYTES = 8 * 1024 * 1024


def write_private_json(path: Path, value: Any) -> None:
    """Write a document under the state directory, for this user alone, atomically.

    A folder made for it is this user's alone, the file is made the same way,
    and the replace swaps the name itself, so a reader never sees half a file and
    a link planted at the name is replaced rather than written through. Raises
    OSError when it cannot.
    """
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(value, out)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def read_bounded_text(path: Path, max_bytes: int, tail: bool = False) -> str | None:
    """A small regular file read as text, bounded; None for anything else.

    An append-only file, such as a log of notices, keeps its newest lines at the
    end, so `tail` reads the last bytes and drops the partial first line rather
    than discarding the part that matters. Anything that is not a regular file is
    refused: a pipe would block a snapshot that every session waits on.
    """
    if os.path.islink(path):
        return None
    try:
        handle = os.open(path, os.O_RDONLY | _BINARY | _NO_FOLLOW | _NON_BLOCKING)
    except OSError:
        return None
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode):
            return None
        oversize = info.st_size > max_bytes
        if oversize and not tail:
            return None
        if oversize:
            os.lseek(handle, info.st_size - max_bytes, os.SEEK_SET)
        data = os.read(handle, max_bytes)
    except OSError:
        return None
    finally:
        os.close(handle)
    text = data.decode("utf-8", "replace")
    return text.split("\n", 1)[-1] if oversize else text


def printable(value: Any) -> str:
    """Text fit for a terminal row: no control characters, no unpaired halves."""
    if not isinstance(value, str):
        return ""
    # Spacing becomes a space, so a line break between two words leaves them
    # two words; every other control character is dropped.
    text = "".join(" " if character.isspace() else character for character in value
                   if character.isprintable() or character.isspace())
    return " ".join(text.split())


def cut(value: Any, limit: int) -> str | None:
    """A printable string, cut to the configured length, or None when empty."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = printable(value)
    return text[:limit] if text else None


# The prefixes a copied command leaves for the person's shell to expand. The
# configuration keeps argv literal, so `$HOME/bin/tool` arrives here as written,
# and quoting it whole would hand the shell a path that names no file.
_EXPANDED_PREFIXES = ("$HOME/", "~/")


def shell_word(value: Any) -> str:
    """One argument as a POSIX shell reads it back: quoted unless it is plain.

    A leading `$HOME/` or `~/` is left outside the quotes so the shell that runs
    the copied line expands it; everything after it is quoted like any word, so
    a space or a quote in a path cannot split the argument or end the command.
    """
    text = str(value)
    for prefix in _EXPANDED_PREFIXES:
        if text.startswith(prefix) and len(text) > len(prefix):
            lead = '"$HOME"/' if prefix == "$HOME/" else prefix
            return lead + shlex.quote(text[len(prefix):])
    return shlex.quote(text)


def shell_command(argv: list[Any], *, environment: Mapping[str, str] | None = None) -> str:
    """A command line a person can paste: each word quoted, assignments first."""
    words = ["{0}={1}".format(name, shell_word(value))
             for name, value in (environment or {}).items()]
    words.extend(shell_word(part) for part in argv)
    return " ".join(words)


def valid_job_id(job_id: Any) -> bool:
    """Whether an identifier may name a job folder."""
    return isinstance(job_id, str) and bool(JOB_ID.fullmatch(job_id))


def switch_state(source: Mapping[str, Any],
                 governance: Mapping[str, Any] | None = None,
                 scope: str | None = None) -> str | None:
    """Whether a scope's machine switch is on: the document first, the marker after.

    The governor and the change controller share one switch, and the tool that
    owns it writes a document holding a boolean per scope. A machine set up
    before that document existed switched both by touching a marker file, and a
    source that still names one is read on those terms. The document is asked
    first: the marker is the older answer to the same question, and the tool
    that writes the document does not keep it in step.
    """
    if governance:
        declared = governance.get("switchPath")
        if isinstance(declared, str) and declared:
            path = Path(declared).expanduser()
            if (path.parent / "governor-controller.off").exists():
                return "off"
            try:
                raw = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                # The tool says a missing switch means both on, and saying so is
                # the difference between "gates are on" and "nobody knows".
                return "on"
            except OSError:
                return None
            try:
                document = json.loads(raw)
            except ValueError:
                return None
            if not isinstance(document, dict):
                return None
            fallback = document.get("enabled")
            fallback = True if fallback is None else fallback
            if scope is None:
                answers = [document.get(key, fallback) for key in ("governor", "controller")]
                if not all(isinstance(answer, bool) for answer in answers):
                    return None
                return ("on" if all(answers) else "off" if not any(answers) else None)
            answer = document.get(scope, fallback)
            return "on" if answer is True else "off" if answer is False else None
    declared = source.get("offSwitch")
    if not declared:
        return None
    try:
        return "off" if Path(str(declared)).exists() else "on"
    except OSError:
        return None
