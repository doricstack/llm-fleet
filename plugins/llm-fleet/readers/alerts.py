#!/usr/bin/env python3
"""What the alerts and the voice need from the machine, shared by every session.

Each session runs the plugin, and every one of them sees the same fleet. Two
things therefore have to be decided once per machine rather than once per
session, and they are decided here, in files under the state directory:

- which session the person is typing in (`focus`, `focused`), because a toast
  belongs in that one and not in every session open;
- which session says an event aloud (`claim`), because a job that blocks
  should be said once, not once per open session.

A reply sent from the pane asks here first what the job asks now
(`question`), since the pane may be a reading behind and a reply belongs to
the question it was typed for: the hash of the whole question and the session
the job's own file names, read from a path with no link below the home. Asked
for a holder, it records a reply to the question as pending for that pane with
a marker file, so a question gets one reply: a second pane, a pane a reading
behind, and the same pane asking again are each refused. The holder records it
sent once the host took it (`confirm`), takes it back when the send failed
(`release --failed`), and a person may clear one pending too long (`release
--stale`) or one whose marker does not read (`release --unreadable`); a sent
one is never taken back. A marker is written whole to a file of its own and then
published under its name with a link, so it is there whole or not at all.

Every folder beneath the state directory is checked once and held open, and
the files in it are reached through that handle (`Folder`), never by walking
its path again; Windows, which cannot, reaches them by name.

The voice itself is here too (`voices`, `speak`, `discard`). The plugin has no
configuration file of its own to read, and the synthesizer is a command the
configuration names, so the configuration is resolved here and the plugin is
handed a file to play. A file this wrote is the only file `discard` removes.

Every subcommand answers with its exit code; `voices` and `speak` also print
one JSON object.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
from typing import Any, Callable, Iterator, Mapping
import wave

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.jobs import question_of, read_contained_state
from readers.runtime import READ_FLAGS, child_environment, read_json_handle, valid_job_id

# A session identifier names a session and nothing else: no separator, no dot.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
# A voice is passed to the synthesizer as an argument, so it is a plain name.
VOICE = re.compile(r"[A-Za-z0-9_]{1,64}")
# The only files `discard` may remove: the ones `speak` names.
SPOKEN_FILE = re.compile(r"fleet-speak-[A-Za-z0-9_-]{1,96}\.wav")
# A claim key is hashed before it names a file, so its length only bounds work.
CLAIM_KEY_LIMIT = 1024
# What one utterance may be: a sentence, not a document.
TEXT_LIMIT = 400
# The folder beneath the state directory that holds focus and the voice's hold.
ALERTS_FOLDER = "alerts"
FOCUS_FILE = "focus.json"
# The machine's one voice: when the clip playing now ends, shared by every session.
VOICE_FILE = "voice.json"
# A breath between two clips, so the second is not heard as the end of the first.
VOICE_MARGIN_SECONDS = 0.4
# How long a clip waits for the voice before it is dropped rather than said late.
VOICE_WAIT_SECONDS = 60.0
# How fast a line is said when its clip cannot be measured, in words a second.
WORDS_PER_SECOND = 2.5
# How far ahead a hold may be dated before it is taken as wrong rather than as busy.
VOICE_HOLD_LIMIT_SECONDS = 600.0
CLAIMS = "claims"
# The folder the plugin makes for the locks that guard files in the state
# directory itself, so no lock sits in, and no check runs on, the state
# directory: that is the owner's own setting.
LOCKS = "locks"
# Opens of a lock that another session is making at that instant (open_lock).
LOCK_OPEN_TRIES = 5
VOICE_LOCK = "voice.lock"
# Where each question a pane sent a reply to is recorded as answered.
REPLY_ANSWERS = "reply-answers"
ANSWERED = ".answered"
# What may name a reply's holder: a token, never a path.
HOLDER = re.compile(r"[A-Za-z0-9_-]{1,128}")
# A marker holds who sent, to which job and question, and when; nothing longer.
REPLY_MARKER_BYTES = 1024
# How many live answered questions are kept; past this a new reply is refused.
REPLY_MARKER_LIMIT = 256
# Opened without following a final link where the platform can say so (not Windows).
_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
_BINARY = getattr(os, "O_BINARY", 0)
_CLOSE_ON_EXEC = getattr(os, "O_CLOEXEC", 0)
# What a file written whole and then published or moved into place is named
# until then, so one left by a helper that died is known and swept.
TEMP_SUFFIX = ".tmp"

# Windows marks a link, a junction and every other redirect this way.
FILE_ATTRIBUTE_REPARSE_POINT = 0x400

# A test's hook, run with the name of the step about to be taken, so a swap
# between a check and the use it guards can be staged at that step.
_between: Callable[[str], None] | None = None


class UnsafePath(OSError):
    """A path that is a link, or not the kind of file this user owns that it must be.

    Raised with a path, what is wrong with it and what fixes it, it can be told
    to a person relative to the state directory (`beneath`); raised with a
    message alone, it is told as that message.
    """

    def __init__(self, what: Path | str, problem: str | None = None, fix: str | None = None):
        if problem is None:
            super().__init__(str(what))
            self.path: Path | None = None
        else:
            super().__init__("{0} {1}; {2}".format(what, problem, fix))
            self.path = Path(what)
        self.problem = problem
        self.fix = fix

    def beneath(self, state_dir: Path) -> str:
        """The refusal with its path named relative to the state directory."""
        if self.path is None:
            return str(self)
        try:
            named = self.path.relative_to(state_dir).as_posix()
        except ValueError:
            named = self.path.name
        return "{0} {1}; {2}".format(named, self.problem, self.fix)


def is_link(info: os.stat_result) -> bool:
    """Whether an lstat names a link or, on Windows, any reparse point."""
    return (stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT))


def _this_user() -> int | None:
    """Who runs this, where the platform has file owners to compare (not Windows)."""
    return os.getuid() if hasattr(os, "getuid") else None


def _owned(info: os.stat_result) -> bool:
    """Whether this user owns the file; a platform with no user ids has no other owner."""
    user = _this_user()
    return user is None or info.st_uid == user


def _step(name: str) -> None:
    """Run the test hook, if one is set, before the step named."""
    if _between is not None:
        _between(name)


def state_root(state_dir: Path) -> Path:
    """The configured state directory as the real directory it names.

    The state directory is the owner's own setting, so a link there is theirs
    to make and is followed once, here. Everything the plugin makes beneath it,
    its directories, locks and records, is checked against links and other
    owners from the real path down.
    """
    return Path(os.path.realpath(state_dir))


def _directory_handles() -> bool:
    """Whether files beneath a folder can be reached through the folder's own handle.

    That takes opening a folder without following a link, and opening, looking
    at, linking, renaming, removing and listing names relative to a handle.
    Windows has none of it: there each file is reached by its path, with a link
    or reparse point refused before each use, and folders keep the mode they
    have, since they carry no mode bits to close.
    """
    return (hasattr(os, "O_DIRECTORY") and hasattr(os, "fchmod")
            and {os.open, os.stat, os.unlink, os.link, os.rename, os.mkdir} <= os.supports_dir_fd
            and os.listdir in os.supports_fd)


class Folder:
    """A folder beneath the state directory, checked once and then held open.

    Where `_directory_handles` holds, `handle` is the folder opened without
    following a link when it was checked, and every file beneath is opened,
    looked at, published, replaced, removed and listed through that handle by
    its bare name. No path is walked again after the check, so a folder swapped
    for a link afterwards changes nothing this touches, and the bare name is the
    last part, which an open without following refuses as a link.

    Where it does not (Windows), `handle` is None and each file is reached by
    its path, with a link or reparse point at the file refused just before each
    open. A folder swapped for a junction between its check and a later use is
    followed there: that is the weaker guarantee on Windows, which has no open
    relative to a folder in Python.

    What this guards against: a link left at a name or a folder beforehand, a
    helper killed mid-write, and a file cut short. What it does not: another
    process of this same user writing in these folders while the helper runs.
    Such a process can write any record here directly, so no check made here
    takes anything from it; the identity checks on a written file catch the
    simple swaps and are not a boundary against that process.
    """

    def __init__(self, path: Path, handle: int | None):
        self.path = path
        self.handle = handle
        # Each file `write_temp` made here, by name, as the device and inode it
        # had when it was written: what a publish or replace checks it still is.
        self._made: dict[str, tuple[int, int]] = {}

    def __enter__(self) -> "Folder":
        return self

    def __exit__(self, *raised: object) -> None:
        self.close()

    def close(self) -> None:
        if self.handle is not None and self.handle >= 0:
            os.close(self.handle)
            self.handle = -1

    def _at(self, name: str) -> tuple[Any, dict[str, int]]:
        """What names `name` to the os module: the bare name and the handle, or the path."""
        if self.handle is None:
            return self.path / name, {}
        return name, {"dir_fd": self.handle}

    def lstat(self, name: str) -> os.stat_result:
        target, at = self._at(name)
        return os.stat(target, follow_symlinks=False, **at)

    def present(self, name: str) -> bool:
        """Whether anything at all, a link included, has this name."""
        try:
            self.lstat(name)
        except FileNotFoundError:
            return False
        return True

    def refuse_link(self, name: str) -> None:
        """Raise UnsafePath when `name` is a link; a name that is not there is not one."""
        try:
            info = self.lstat(name)
        except FileNotFoundError:
            return
        if is_link(info):
            raise UnsafePath(self.path / name, "is a link", "remove the link")

    def open(self, name: str, flags: int, mode: int = 0o600,
             opener: Callable[..., int] = os.open) -> int:
        """Open `name` here, never through a link at it."""
        self.refuse_link(name)
        target, at = self._at(name)
        return opener(target, flags | _NO_FOLLOW | _CLOSE_ON_EXEC | _BINARY, mode, **at)

    def unlink(self, name: str) -> None:
        target, at = self._at(name)
        os.unlink(target, **at)

    def names(self) -> list[str]:
        return sorted(os.listdir(self.path if self.handle is None else self.handle))

    def _identity(self, name: str) -> tuple[int, int] | None:
        """The device and inode at `name`, a link's own, or None when nothing is there."""
        try:
            info = self.lstat(name)
        except FileNotFoundError:
            return None
        return None if is_link(info) else (info.st_dev, info.st_ino)

    def _still_made(self, source: str) -> tuple[int, int]:
        """The identity `source` was written with, refused if it is anything else now.

        Between its write and its use, a file this made may be swapped for a link
        or another file; published, that would put a file this never wrote, with
        its own mode, where a marker goes.
        """
        made = self._made.get(source)
        if made is None or self._identity(source) != made:
            raise UnsafePath(self.path / source, "was changed after it was written", "remove it")
        return made

    def _check_landed(self, name: str, made: tuple[int, int], *, remove: bool) -> None:
        """Refuse when `name` is not the very file put there, removing it when `remove` says.

        A name this call created holds nothing yet and is removed. A name that
        held a record is left as it landed: it reads as a record that does not
        read, which still holds its question and has a press of its own, where
        removing it would open the question to a second reply.
        """
        if self._identity(name) == made:
            return
        if remove:
            with contextlib.suppress(OSError):
                self.unlink(name)
        raise UnsafePath(self.path / name, "was changed while it was put in place", "remove it")

    def publish(self, source: str, name: str) -> None:
        """Give the file `source` made here the name `name` too; fails on a name already there.

        The link is made to `source` itself, never through a link at it, and the
        name is checked to hold that very file afterwards.
        """
        made = self._still_made(source)
        _step("publish-checked")
        if self.handle is None:
            os.link(self.path / source, self.path / name)
        else:
            os.link(source, name, src_dir_fd=self.handle, dst_dir_fd=self.handle,
                    follow_symlinks=False)
        self._check_landed(name, made, remove=True)

    def replace(self, source: str, name: str) -> None:
        """Move the file `source` made here onto `name`, replacing whatever has that name."""
        _step("replace")
        made = self._still_made(source)
        _step("replace-checked")
        if self.handle is None:
            os.replace(self.path / source, self.path / name)
        else:
            os.replace(source, name, src_dir_fd=self.handle, dst_dir_fd=self.handle)
        self._made.pop(source, None)
        self._check_landed(name, made, remove=False)

    def read_json(self, name: str, max_bytes: int) -> Any:
        """A small regular file here, parsed; None for anything else, a link included."""
        try:
            handle = self.open(name, READ_FLAGS, 0)
        except OSError:
            return None
        return read_json_handle(handle, max_bytes)

    def write_temp(self, name: str, data: bytes) -> str:
        """Write `data` whole to a new file for this user alone, flushed to disk; its name.

        The name is `name` with a random part and TEMP_SUFFIX, so a stray one is
        known for what it is and swept.
        """
        temp = "{0}.{1}{2}".format(name, secrets.token_hex(8), TEMP_SUFFIX)
        _step("write")
        handle = self.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(handle, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
                written = os.fstat(out.fileno())
                self._made[temp] = (written.st_dev, written.st_ino)
        except BaseException:
            with contextlib.suppress(OSError):
                self.unlink(temp)
            raise
        return temp

    def write_json(self, name: str, value: Any) -> None:
        """Replace `name` whole, so a reader sees the old file or the new and never half."""
        temp = self.write_temp(name, json.dumps(value).encode("utf-8"))
        try:
            self.replace(temp, name)
        except BaseException:
            with contextlib.suppress(OSError):
                self.unlink(temp)
            raise


def _why_not_a_folder(path: Path, error: OSError, parent: int) -> UnsafePath:
    """Why a folder did not open: a link put there since its check, or the error itself.

    Platforms differ in the error a link opened without following gives (a loop
    on Linux, not a folder on macOS), so the name is looked at again.
    """
    with contextlib.suppress(OSError):
        if is_link(os.stat(path.name, dir_fd=parent, follow_symlinks=False)):
            return UnsafePath(path, "is a link", "remove the link")
    return UnsafePath(path, "did not open as a directory: {0}".format(error.strerror), "remove it")


def private_directory(path: Path, opener: Callable[..., int] = os.open,
                      create: bool = True) -> Folder:
    """Hold `path` open as a folder only this user can enter, or raise UnsafePath; the caller closes it.

    `path.parent` is the state directory, the owner's own setting, trusted as
    given and opened as it is. `path` itself is made there when missing (unless
    `create` is false, when a missing one raises FileNotFoundError), and used
    only when it is a real directory this user owns: a link put there would
    send every file beneath it somewhere else. It is looked at and opened
    relative to the state directory's handle, without following a link, and the
    handle is checked again; one this user owns that others may enter is closed
    to them through that handle. Everything beneath is then reached through it
    (`Folder`).

    Windows has no link-refusing open, file owner or mode here: there only the
    look for a link or reparse point holds, ownership is not checked, no mode
    is changed, and the folder is reached by its path from then on.
    """
    root = path.parent
    if create:
        root.mkdir(parents=True, exist_ok=True)
    if not _directory_handles():
        if create:
            with contextlib.suppress(FileExistsError):
                os.mkdir(path, 0o700)
        _step("folder")
        info = os.lstat(path)
        if is_link(info):
            raise UnsafePath(path, "is a link", "remove the link")
        if not stat.S_ISDIR(info.st_mode) or not _owned(info):
            raise UnsafePath(path, "is not a directory this user owns", "remove it, or give it to this user")
        return Folder(path, None)
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | _CLOSE_ON_EXEC)
    try:
        if create:
            with contextlib.suppress(FileExistsError):
                os.mkdir(path.name, 0o700, dir_fd=parent)
        _step("folder")
        info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        if is_link(info):
            raise UnsafePath(path, "is a link", "remove the link")
        # Whose it is, is judged on the handle below: what is used is what is checked.
        if not stat.S_ISDIR(info.st_mode):
            raise UnsafePath(path, "is not a directory this user owns", "remove it, or give it to this user")
        _step("folder-open")
        try:
            handle = opener(path.name, os.O_RDONLY | os.O_DIRECTORY | _NO_FOLLOW | _CLOSE_ON_EXEC,
                            dir_fd=parent)
        except OSError as error:
            raise _why_not_a_folder(path, error, parent) from error
    finally:
        os.close(parent)
    try:
        held = os.fstat(handle)
        if not stat.S_ISDIR(held.st_mode) or not _owned(held):
            raise UnsafePath(path, "is not a directory this user owns", "remove it, or give it to this user")
        if held.st_mode & 0o077:
            os.fchmod(handle, 0o700)
    except BaseException:
        os.close(handle)
        raise
    return Folder(path, handle)


def open_lock(folder: Folder, name: str, opener: Callable[..., int] = os.open) -> int:
    """Open a lock file in `folder` to write, made if missing, never through a link.

    A link is refused before the open, which matters where the platform cannot
    refuse it in the open, and the handle is checked after it: a regular file
    this user owns. One this user owns that others may read or write is closed
    to them through the handle already checked.
    """
    _step("lock")
    tries = 0
    while True:
        tries += 1
        try:
            handle = folder.open(name, os.O_RDWR | os.O_CREAT, 0o600, opener)
            break
        except UnsafePath:
            raise
        except FileNotFoundError as error:
            # macOS answers a create through a folder handle with "no such file"
            # when another process makes the same name at that instant; the file
            # is there by the next try. A folder that is gone stays gone.
            if tries < LOCK_OPEN_TRIES:
                time.sleep(0.001 * tries)
                continue
            raise UnsafePath(folder.path / name, "did not open: {0}".format(error.strerror),
                             "remove it") from error
        except OSError as error:
            raise UnsafePath(folder.path / name, "did not open: {0}".format(error.strerror),
                             "remove it") from error
    info = os.fstat(handle)
    if not stat.S_ISREG(info.st_mode) or not _owned(info):
        os.close(handle)
        raise UnsafePath(folder.path / name, "is not a regular file this user owns",
                         "remove it, or give it to this user")
    if hasattr(os, "fchmod") and info.st_mode & 0o177:
        # This user's own lock, left open to others: closed to them and used.
        os.fchmod(handle, 0o600)
    return handle


@contextlib.contextmanager
def exclusive(path: Path) -> Iterator[Folder]:
    """Hold an exclusive lock on `path` for the block, on any platform; yield its folder, held.

    The lock's folder is made for this user alone when missing, and held open:
    everything the block does beneath it goes through the `Folder` yielded, so
    no path is walked again once the folder was checked. Raises UnsafePath,
    before anything is locked, for a folder that is a link or another user's,
    and for a lock that is a link or not a regular file this user owns.
    """
    with private_directory(path.parent) as folder:
        with os.fdopen(open_lock(folder, path.name), "r+b") as handle:
            try:
                import fcntl
            except ImportError:  # Windows
                import msvcrt
                handle.seek(0)
                while True:
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                        break
                    except OSError:
                        time.sleep(0.05)
                try:
                    yield folder
                finally:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                return
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield folder
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


def read_owned_json(path: Path, max_bytes: int) -> Any:
    """A file this helper keeps, read through its folder held open; None otherwise.

    The folder is checked as `private_directory` checks it and is not made; the
    file is opened through it without following a link, so neither a planted
    file nor a planted folder is read.
    """
    try:
        with private_directory(path.parent, create=False) as folder:
            return folder.read_json(path.name, max_bytes)
    except OSError:
        return None


def focus_path(state_dir: Path) -> Path:
    """Where the session typed in last is kept."""
    return state_dir / ALERTS_FOLDER / FOCUS_FILE


def voice_path(state_dir: Path) -> Path:
    """Where the machine's voice is held, until the clip playing ends."""
    return state_dir / ALERTS_FOLDER / VOICE_FILE


def write_json(path: Path, value: Any) -> None:
    """Write atomically, so a reader never sees half a file.

    The folder is checked and held by `private_directory` (never a link, this
    user's alone), the file is made for this user alone through it, and the
    replace swaps the name itself, so a link planted at it is replaced rather
    than written through. Raises UnsafePath for a folder it refuses.
    """
    with private_directory(path.parent) as folder:
        folder.write_json(path.name, value)


def set_focus(state_dir: Path, session: str, now: float) -> bool:
    """Mark `session` as the one the person typed in last."""
    if not SESSION_ID.fullmatch(session):
        return False
    try:
        write_json(focus_path(state_dir), {"session": session, "at": now})
    except UnsafePath:
        return False
    return True


def is_focused(state_dir: Path, session: str, now: float, keep_seconds: float) -> bool:
    """Whether `session` is the one typed in last, within the configured window."""
    focus = read_owned_json(focus_path(state_dir), 4096)
    if not isinstance(focus, dict):
        return False
    at = focus.get("at")
    if isinstance(at, bool) or not isinstance(at, (int, float)):
        return False
    return focus.get("session") == session and 0 <= now - at <= keep_seconds


def claim(state_dir: Path, key: str, now: float, keep_seconds: float) -> bool:
    """True for the first caller on this machine to claim `key`.

    Pruning and creating hold one lock: without it a pruner that read an expired
    claim's age could remove the claim another session had just made under the
    same name, and both sessions would speak. The listing, the ages, the removals
    and the claim go through the claims folder held open with the lock.
    """
    if not key or len(key) > CLAIM_KEY_LIMIT:
        return False
    name = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    with contextlib.ExitStack() as held:
        # A lock this user cannot trust claims nothing: no session speaks.
        try:
            claims = held.enter_context(exclusive(state_dir / CLAIMS / ".lock"))
        except OSError:
            return False
        for entry in claims.names():
            if entry == ".lock":
                continue
            # Best effort: a claim that outlives its window costs one stale file.
            with contextlib.suppress(OSError):
                if now - claims.lstat(entry).st_mtime > keep_seconds:
                    claims.unlink(entry)
        try:
            handle = claims.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except OSError:
            # Claimed already, or a link put at its name: either way not this caller's.
            return False
        os.close(handle)
        return True


def voices_document(config: Mapping[str, Any]) -> dict[str, Any]:
    """What the plugin may offer: whether speech can run, and the voices to pick."""
    speech = config.get("speech") or {}
    command = speech.get("command")
    reason = None
    if not speech.get("enabled"):
        reason = "speech is off in the configuration (speech.enabled)"
    elif not command:
        reason = "no synthesizer is configured (speech.command)"
    elif not os.access(command, os.X_OK):
        reason = "the configured synthesizer is not an executable file (speech.command)"
    voices = speech.get("voices") or {}
    return {
        "state": "ready" if reason is None else "unavailable",
        "reason": reason,
        "group": speech.get("group") or "female",
        "voice": speech.get("voice"),
        "voices": {kind: [str(name) for name in names] for kind, names in voices.items()},
    }


def known_voice(config: Mapping[str, Any], voice: str) -> bool:
    voices = (config.get("speech") or {}).get("voices") or {}
    return VOICE.fullmatch(voice) is not None and any(voice in names for names in voices.values())


def clip_seconds(path: Path, text: str) -> float:
    """How long a clip plays: from its own samples, or from its words when unreadable."""
    try:
        with wave.open(str(path), "rb") as clip:
            rate = clip.getframerate()
            if rate > 0:
                return clip.getnframes() / rate
    except (wave.Error, EOFError, OSError):
        pass
    return max(1.0, len(text.split()) / WORDS_PER_SECOND)


def hold_voice(state_dir: Path, seconds: float, clock: Callable[[], float] = time.time,
               sleep: Callable[[float], None] = time.sleep,
               wait_seconds: float = VOICE_WAIT_SECONDS) -> bool:
    """Take the machine's voice for a clip of `seconds`, waiting for the one playing.

    Every session says its lines through this, so two sessions never speak over
    each other: a clip starts once the one before it has ended. A hold nobody can
    read, or one dated further ahead than any clip runs, is taken as wrong and
    does not stop the voice. A clip that waits past `wait_seconds` is dropped
    rather than said long after the news it carries.
    """
    lock = state_dir / LOCKS / VOICE_LOCK
    started = clock()
    while True:
        with exclusive(lock):
            now = clock()
            held = read_owned_json(voice_path(state_dir), 4096)
            until = held.get("until") if isinstance(held, dict) else None
            busy = (isinstance(until, (int, float)) and not isinstance(until, bool)
                    and now < until <= now + VOICE_HOLD_LIMIT_SECONDS)
            if not busy:
                write_json(voice_path(state_dir),
                           {"until": now + seconds + VOICE_MARGIN_SECONDS})
                return True
            left = float(until) - now
        if clock() - started + left > wait_seconds:
            return False
        sleep(min(left, 0.25))


def speak(config: Mapping[str, Any], voice: str, text: str,
          environ: Mapping[str, str], state_dir: Path | None = None,
          clock: Callable[[], float] = time.time,
          sleep: Callable[[float], None] = time.sleep,
          wait_seconds: float = VOICE_WAIT_SECONDS) -> dict[str, Any]:
    """Synthesize `text` in `voice` to a file the plugin plays, or say why not.

    The exit code is the only sign the voice rendered: a synthesizer that failed
    and left an earlier file behind must not have that file played as this one.
    The file is handed back only once the machine's voice is this clip's, for as
    long as the clip runs.
    """
    document = voices_document(config)
    if document["state"] != "ready":
        return {"file": None, "reason": document["reason"]}
    if not known_voice(config, voice):
        return {"file": None, "reason": "not a configured voice"}
    line = " ".join(text.split())[:TEXT_LIMIT]
    if not line:
        return {"file": None, "reason": "nothing to say"}
    speech = config["speech"]
    directory = Path(speech["tempDirectory"])
    target = directory / "fleet-speak-{0}.wav".format(secrets.token_hex(12))
    timeout = config["timeouts"]["synthesisMs"] / 1000
    policy = (config.get("runtime") or {}).get("childEnvironment") or {}
    try:
        completed = subprocess.run(
            [speech["command"], "--out", str(target), "--voice", voice, "--", line],
            capture_output=True, env=child_environment(policy, environ),
            timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        target.unlink(missing_ok=True)
        return {"file": None, "reason": "the synthesizer took longer than {0:g}s".format(timeout)}
    except OSError as caught:
        target.unlink(missing_ok=True)
        return {"file": None, "reason": caught.strerror or type(caught).__name__}
    if completed.returncode != 0:
        target.unlink(missing_ok=True)
        return {"file": None, "reason": "the synthesizer exited {0}".format(completed.returncode)}
    try:
        size = target.stat().st_size
    except OSError:
        size = 0
    if size == 0:
        target.unlink(missing_ok=True)
        return {"file": None, "reason": "the synthesizer wrote nothing"}
    seconds = clip_seconds(target, line)
    holder = state_root(Path(config["stateDir"])) if state_dir is None else state_dir
    try:
        held = hold_voice(holder, seconds, clock, sleep, wait_seconds)
    except OSError as refused:
        target.unlink(missing_ok=True)
        return {"file": None, "reason": "the machine's voice lock could not be taken: {0}".format(refused)}
    if not held:
        target.unlink(missing_ok=True)
        return {"file": None, "reason": "another session is still speaking"}
    return {"file": str(target), "reason": None, "seconds": round(seconds, 3)}


def discard(config: Mapping[str, Any], path: str) -> bool:
    """Remove a file `speak` wrote, and nothing else."""
    candidate = Path(path)
    directory = Path(config["speech"]["tempDirectory"])
    if not SPOKEN_FILE.fullmatch(candidate.name):
        return False
    try:
        if candidate.parent.resolve() != directory.resolve() or candidate.is_symlink():
            return False
    except OSError:
        return False
    candidate.unlink(missing_ok=True)
    return True


def reply_marker_name(provider: str, job_id: str, job_session: str | None, digest: str) -> str:
    """The name of the file that records one job's question as answered, a hash of all four.

    The job's session is part of it: a job restarted into another session that
    asks the same words again is asking again, and the reply sent to the old
    session never reached it.
    """
    key = "\n".join((provider, job_id, job_session or "", digest))
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32] + ANSWERED


def reply_marker_path(state_dir: Path, provider: str, job_id: str, job_session: str | None,
                      digest: str) -> Path:
    """Where `reply_marker_name` lives beneath the state directory."""
    return state_dir / REPLY_ANSWERS / reply_marker_name(provider, job_id, job_session, digest)


def _sweep_temps(folder: Folder, now: float, after: float) -> None:
    """Remove the files a helper wrote and died before publishing or moving, once older than `after`.

    A marker is published or replaced within one helper run, under the folder's
    lock, so a file still waiting to be published that is older than a reply may
    be pending belongs to a run that died. Called under the folder's lock.
    """
    for name in folder.names():
        if not name.endswith(TEMP_SUFFIX):
            continue
        with contextlib.suppress(OSError):
            if now - folder.lstat(name).st_mtime > after:
                folder.unlink(name)


def _prune_markers(config: Mapping[str, Any], folder: Folder, claiming: str) -> int:
    """Forget the answered questions of jobs gone from their home; count the rest.

    A marker names its provider and job. One whose provider is ready and whose job
    has no folder in that home any more belongs to a job the roster no longer
    lists, and goes. Nothing else goes: a marker of a job still in its home may be
    the only thing between a question and a second reply, and one that cannot be
    read, or whose provider is not ready, cannot be judged. The marker being
    claimed is never judged at all. Called under the folder's lock.
    """
    homes = {entry["id"]: Path(entry["home"]) for entry in config["providers"]
             if entry["state"] == "ready"}
    kept = 0
    for name in folder.names():
        if not name.endswith(ANSWERED) or name == claiming:
            continue
        body = folder.read_json(name, REPLY_MARKER_BYTES)
        provider = body.get("provider") if isinstance(body, dict) else None
        job_id = body.get("job") if isinstance(body, dict) else None
        home = homes.get(provider) if isinstance(provider, str) else None
        if (home is not None and isinstance(job_id, str) and valid_job_id(job_id)
                and not os.path.lexists(home / "jobs" / job_id)):
            with contextlib.suppress(OSError):
                folder.unlink(name)
            continue
        kept += 1
    return kept


def _mark_answered(folder: Folder, name: str, body: Mapping[str, Any]) -> bool:
    """Publish the marker whole, or find one there: True when this call made it.

    The body is written to a file of its own and flushed first, then published
    under the marker's name with a hard link, which fails on any name already
    there, a link included, and never replaces it: of two callers for one
    question only one makes it. A helper killed before the link leaves only that
    file, swept later, and the question answerable; one killed after it leaves
    the marker whole. So a marker is there whole or not at all.
    """
    temp = folder.write_temp(name, json.dumps(body).encode("utf-8"))
    try:
        _step("marker")
        try:
            folder.publish(temp, name)
        except FileExistsError:
            return False
        _step("marker-published")
    finally:
        with contextlib.suppress(OSError):
            folder.unlink(temp)
    return True


def _marker_body(folder: Folder, name: str) -> dict[str, Any] | None:
    """A marker as written, read without following a link, or None for one that does not read."""
    body = folder.read_json(name, REPLY_MARKER_BYTES)
    if not isinstance(body, dict) or body.get("state") not in ("pending", "sent"):
        return None
    at = body.get("at")
    if isinstance(at, bool) or not isinstance(at, (int, float)):
        return None
    try:
        finite = math.isfinite(at)
    except OverflowError:
        # An integer past what a float holds: JSON allows it, a time cannot be it.
        return None
    if not finite:
        # Python reads 1e309 as infinity and would write it back as Infinity,
        # which is not JSON and which the pane would refuse with the whole reading.
        return None
    return body


def _unreadable_reply(folder: Folder, name: str) -> dict[str, Any] | None:
    """Where a reply stands when its marker is there but does not read.

    Cut short by a disk, written by a helper from before markers were published
    whole, or a link: it holds the question like any marker, so it is shown, not
    taken as none. Its `id` names this very file, so a pane that cleared one
    still shows the next that goes bad for the same question.
    """
    try:
        info = folder.lstat(name)
    except FileNotFoundError:
        return None
    return {"state": "unreadable", "at": None,
            "id": "{0}-{1}".format(info.st_ino, info.st_mtime_ns)}


def reply_marker(state_dir: Path, provider: str, job_id: str, job_session: str | None,
                 digest: str) -> dict[str, Any] | None:
    """Where a job's question stands: a reply `pending` since `at`, `sent`, `unreadable`, or None."""
    name = reply_marker_name(provider, job_id, job_session, digest)
    try:
        with private_directory(state_dir / REPLY_ANSWERS, create=False) as folder:
            body = _marker_body(folder, name)
            if body is None:
                return _unreadable_reply(folder, name)
    except OSError:
        return None
    return {"state": body["state"], "at": float(body["at"])}


def confirm_reply(state_dir: Path, provider: str, job_id: str, job_session: str | None,
                  digest: str, holder: str, now: float) -> bool:
    """Record a pending reply as sent, once the host took it, for its holder only.

    The marker is replaced whole, by a file made for this user alone, so a reader
    sees it pending or sent and never half of either, and a link at its name is
    replaced rather than written through.
    """
    path = reply_marker_path(state_dir, provider, job_id, job_session, digest)
    if not path.parent.exists():
        return False
    try:
        with exclusive(path.parent / ".lock") as folder:
            body = _marker_body(folder, path.name)
            if body is None or body.get("holder") != holder or body["state"] != "pending":
                return False
            folder.write_json(path.name, {**body, "state": "sent", "sentAt": now})
            return True
    except UnsafePath:
        return False


def release_reply(state_dir: Path, provider: str, job_id: str, job_session: str | None,
                  digest: str, holder: str | None, *, stale_after: float | None = None,
                  now: float = 0.0) -> bool:
    """Take back a pending reply's marker; a sent one is never taken back.

    Without `stale_after` this is a send that failed, and only its holder may
    take it back. With it, this is the press a person makes on a reply that may
    not have been sent: any pane may make it, but only for a marker pending at
    least that long, since a younger one may still be on its way.
    """
    path = reply_marker_path(state_dir, provider, job_id, job_session, digest)
    if not path.parent.exists():
        return False
    try:
        with exclusive(path.parent / ".lock") as folder:
            body = _marker_body(folder, path.name)
            if body is None or body["state"] != "pending":
                return False
            if stale_after is None:
                if body.get("holder") != holder:
                    return False
            elif 0 <= now - body["at"] < stale_after:
                return False
            folder.unlink(path.name)
            return True
    except UnsafePath:
        return False


def release_unreadable(state_dir: Path, provider: str, job_id: str, job_session: str | None,
                       digest: str) -> bool:
    """Remove a marker that does not read, and only one: the press a person makes on its row.

    A marker that reads, pending or sent, is never removed here, and a link at
    the marker's name is removed itself, never what it points at.
    """
    path = reply_marker_path(state_dir, provider, job_id, job_session, digest)
    if not path.parent.exists():
        return False
    try:
        with exclusive(path.parent / ".lock") as folder:
            if not folder.present(path.name) or _marker_body(folder, path.name) is not None:
                return False
            folder.unlink(path.name)
            return True
    except UnsafePath:
        return False


def prune_sent(config: Mapping[str, Any], now: float | None = None) -> int:
    """Forget the sent replies that answer nothing any more, and say how many went.

    A sent marker goes when its job has left its home, or when the job now asks
    another question or runs in another session; one whose job still asks what
    was answered stays, since it is what stops a second send. A pending marker
    never goes here: it may be a reply still on its way. A marker that cannot be
    read, or whose provider is not ready, cannot be judged and stays; it has a
    press of its own on its row.
    """
    folder_path = state_root(Path(config["stateDir"])) / REPLY_ANSWERS
    if not os.path.lexists(folder_path):
        return 0
    homes = {entry["id"]: Path(entry["home"]) for entry in config["providers"]
             if entry["state"] == "ready"}
    limits = config["limits"]
    removed = 0
    with exclusive(folder_path / ".lock") as folder:
        _sweep_temps(folder, time.time() if now is None else now,
                     float(config["pane"]["replyPendingSeconds"]))
        for name in folder.names():
            if not name.endswith(ANSWERED):
                continue
            body = _marker_body(folder, name)
            if body is None or body["state"] != "sent":
                continue
            provider = body.get("provider")
            job_id = body.get("job")
            home = homes.get(provider) if isinstance(provider, str) else None
            if home is None or not isinstance(job_id, str) or not valid_job_id(job_id):
                continue
            if os.path.lexists(home / "jobs" / job_id):
                state, _ = read_contained_state(home, job_id, int(limits["jobStateBytes"]))
                if state is None:
                    continue
                _, _, digest = question_of(state, int(limits["questionCharacters"]))
                named = state.get("sessionId")
                session = named if isinstance(named, str) and named else None
                if digest == body.get("hash") and session == body.get("jobSession"):
                    continue
            with contextlib.suppress(FileNotFoundError):
                folder.unlink(name)
                removed += 1
    return removed


def question(config: Mapping[str, Any], provider: str, job_id: str, *,
             holder: str | None = None, session: str | None = None,
             expected_hash: str | None = None, expected_session: str | None = None,
             now: float | None = None) -> dict[str, Any]:
    """What a job asks now, read from its own state file, or why that cannot be said.

    `needs` is cut and made printable exactly as the roster reader cuts it, for
    the words a toast may quote. Identity is `needsHash`, the same hash of the
    whole question the roster reader carries, since two questions can share all
    the words a row draws; and `sessionId` is the session the job's own file
    names now, the only one a reply may go to. A provider that is not ready, a
    job identifier that may not name a folder, a path with a link below the home,
    and a state file that cannot be read are each a reason rather than a question
    of nothing, because "no question" is the answer that says a reply would land
    on a job that stopped asking.

    Asked for a holder, the job is read, checked against the session and the
    question the reply was typed for, and recorded as a reply pending, all under
    one lock: `held` is true only for the caller whose marker was made. A marker
    already there is a reply sent or on its way, and nothing resends it on its
    own; a person may clear a pending one that waited too long (`release
    --stale`), and one that does not read (`release --unreadable`). A new
    question has a new hash and is free. Past the cap on live markers the reply
    is refused (`full`) rather than any live marker forgotten.
    """
    def refused(reason: str, state: str = "unavailable") -> dict[str, Any]:
        return {"state": state, "needs": None, "needsHash": None, "sessionId": None,
                "held": False, "reason": reason}

    homes = {entry["id"]: entry for entry in config["providers"]}
    entry = homes.get(provider)
    if entry is None or entry["state"] != "ready":
        return refused("provider {0} is not ready".format(provider))
    if holder is not None and not HOLDER.fullmatch(holder):
        return refused("the reply's holder may not name a marker")
    home = Path(entry["home"])
    limits = config["limits"]

    def asked() -> dict[str, Any]:
        state, why = read_contained_state(home, job_id, int(limits["jobStateBytes"]))
        if state is None:
            return refused(why or "the job's state file could not be read")
        needs, _, digest = question_of(state, int(limits["questionCharacters"]))
        # The session a reply goes to is the one the job's own file names now, not
        # the one a reading named seconds ago: a job that was restarted is another
        # session, and a reply to the old one lands nowhere or somewhere else.
        named = state.get("sessionId")
        job_session = named if isinstance(named, str) and named else None
        if expected_session is not None and job_session != expected_session:
            return refused("the job's session changed", "session-changed")
        if expected_hash is not None and digest != expected_hash:
            return refused("the job is asking something else", "question-changed")
        return {"state": "ready", "needs": needs, "needsHash": digest,
                "sessionId": job_session, "held": False, "reason": None}

    if holder is None:
        return asked()
    root = state_root(Path(config["stateDir"]))
    clock = time.time() if now is None else now
    try:
        with exclusive(root / REPLY_ANSWERS / ".lock") as folder:
            answer = asked()
            if answer["state"] != "ready":
                return answer
            if answer["needsHash"] is None:
                return refused("the job is not asking anything", "question-changed")
            name = reply_marker_name(provider, job_id, answer["sessionId"], answer["needsHash"])
            _sweep_temps(folder, clock, float(config["pane"]["replyPendingSeconds"]))
            live = _prune_markers(config, folder, name)
            if live >= REPLY_MARKER_LIMIT and not folder.present(name):
                return refused("{0} replies are held for jobs still waiting".format(live), "full")
            try:
                made = _mark_answered(folder, name, {
                    "state": "pending", "holder": holder, "session": session, "provider": provider,
                    "job": job_id, "jobSession": answer["sessionId"], "hash": answer["needsHash"],
                    "at": clock})
            except UnsafePath:
                raise
            except OSError as failure:
                # A full disk, or a filesystem with no hard links: nothing was published.
                return refused("the reply's marker could not be made: {0}".format(
                    failure.strerror or failure))
            if made:
                return {**answer, "held": True}
            if _marker_body(folder, name) is not None:
                return refused("already answered", "answered")
            try:
                folder.refuse_link(name)
            except UnsafePath as linked:
                return refused("the reply's marker {0} {1}; clear it from the job's row".format(
                    name, linked.problem), "unreadable")
            return refused("the reply's marker could not be read; clear it from the job's row",
                           "unreadable")
    except UnsafePath as refusal:
        return refused(refusal.beneath(root), "locked")


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Focus, claims and the voice for fleet alerts")
    parser.add_argument("--config", default=None)
    parser.add_argument("--now", type=float, default=None, help="the clock, for a reproducible run")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("focus", help="mark a session as the one in use").add_argument("session")
    sub.add_parser("focused", help="exit 0 when this session is the one in use").add_argument("session")
    sub.add_parser("claim", help="exit 0 for the first session to claim a key").add_argument("key")
    sub.add_parser("voices", help="print whether speech can run, and the voices")
    speaker = sub.add_parser("speak", help="synthesize a line to a file and print its path")
    speaker.add_argument("--voice", required=True)
    speaker.add_argument("text")
    sub.add_parser("discard", help="remove a file speak wrote").add_argument("path")
    asker = sub.add_parser("question", help="print what a waiting job asks now, marking it answered")
    asker.add_argument("provider")
    asker.add_argument("job")
    asker.add_argument("--holder", default=None, help="mark the question answered by this pane")
    asker.add_argument("--session", default=None, help="the session the holder runs in")
    asker.add_argument("--hash", default=None, help="the question the reply was typed for")
    asker.add_argument("--job-session", default=None, help="the session the reading named")
    for name, about in (("release", "take back a reply: one that failed, one stale, or one unreadable"),
                        ("confirm", "record a pending reply as sent, once the host took it")):
        marker = sub.add_parser(name, help=about)
        marker.add_argument("provider", nargs="?" if name == "release" else None)
        marker.add_argument("job", nargs="?" if name == "release" else None)
        marker.add_argument("--hash", required=name != "release", help="the question the reply was for")
        marker.add_argument("--job-session", default=None, help="the session the reply was for")
        marker.add_argument("--holder", default=None)
        if name == "release":
            marker.add_argument("--failed", action="store_true",
                                help="the send failed: the holder takes its reply back")
            marker.add_argument("--stale", action="store_true",
                                help="a person clears a reply pending past pane.replyPendingSeconds")
            marker.add_argument("--unreadable", action="store_true",
                                help="a person clears a reply marker that does not read")
            marker.add_argument("--prune-sent", action="store_true",
                                help="forget the sent replies that answer nothing any more")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        json.dump({"configErrors": refusal.errors}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    now = args.now if args.now is not None else time.time()
    state_dir = state_root(Path(config["stateDir"]))
    alerts = config["alerts"]
    if args.command == "focus":
        return 0 if set_focus(state_dir, args.session, now) else 2
    if args.command == "focused":
        return 0 if is_focused(state_dir, args.session, now, alerts["focusSeconds"]) else 1
    if args.command == "claim":
        return 0 if claim(state_dir, args.key, now, alerts["claimRetentionSeconds"]) else 1
    if args.command == "discard":
        return 0 if discard(config, args.path) else 2
    if args.command == "question":
        asked = question(config, args.provider, args.job, holder=args.holder,
                         session=args.session, expected_hash=args.hash,
                         expected_session=args.job_session, now=now)
        print(json.dumps(asked))
        return 0 if asked["state"] == "ready" else 1
    if args.command == "confirm":
        if args.holder is None:
            return 2
        return 0 if confirm_reply(state_dir, args.provider, args.job, args.job_session, args.hash,
                                  args.holder, now) else 1
    if args.command == "release" and args.prune_sent:
        if args.failed or args.stale or args.unreadable or args.provider is not None:
            return 2
        try:
            removed = prune_sent(config, now)
        except UnsafePath as refusal:
            print(json.dumps({"removed": 0, "reason": refusal.beneath(state_dir)}))
            return 3
        print(json.dumps({"removed": removed}))
        return 0 if removed else 1
    if args.command == "release":
        if (args.failed + args.stale + args.unreadable != 1 or (args.failed and args.holder is None)
                or args.provider is None or args.job is None or args.hash is None):
            return 2
        if args.unreadable:
            return 0 if release_unreadable(state_dir, args.provider, args.job, args.job_session,
                                           args.hash) else 1
        stale_after = float(config["pane"]["replyPendingSeconds"]) if args.stale else None
        return 0 if release_reply(state_dir, args.provider, args.job, args.job_session, args.hash,
                                  args.holder, stale_after=stale_after, now=now) else 1
    if args.command == "voices":
        print(json.dumps(voices_document(config)))
        return 0
    spoken = speak(config, args.voice, args.text, os.environ if environ is None else environ)
    print(json.dumps(spoken))
    return 0 if spoken["file"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
