#!/usr/bin/env python3
"""Keep the terminal tab's color for every session in it, and write the escape.

Several sessions can share one tab: tmux panes in one iTerm tab. Each session
tells this helper its own level, and the helper keeps one record per tab under
the configured state directory: each session's level with when it said it, and
what the tab was last painted. Under one exclusive lock it reads that record,
merges this session's word into it, drops any entry older than
`alerts.tabTint.staleSeconds`, paints the highest level still live when the tab
is not painted it already, and writes the record back whole. Nothing is decided
from a copy another process may have changed: two sessions take turns.

A record that cannot be read or parsed says nothing about the tab, so it is
never taken as an empty one: nothing is painted and nothing is replaced, and the
helper says why. A write that fails leaves the record saying the tab's color is
unknown, so the next session to speak paints it again.

The escape goes to the session's terminal device: the controlling terminal
this process has, or else the terminal of the nearest parent that has one,
walking up only through processes this user runs. The host may start the helper
in a session of its own, with no terminal; the parent's terminal is then the
session's. A parent's terminal is written only when the device opened by its
name is a character device this user owns and is the very device the parent
runs on, by device number. Every device is opened to write only, never to become
this process's terminal, never waiting on a reader, and never through a link.

Two forms, each with `--tmux` when the session runs inside tmux, which wraps
the escape so tmux hands it to the terminal around it:

- `set --tab ID --session ID --level none|waiting|failed` says this session's
  level; `--record-only` keeps the entry alive without painting, for a session
  that gave up on its writes;
- `end --tab ID --session ID` takes this session's entry out as it ends.

The escapes are iTerm's (OSC 6). The plugin calls this only for a terminal
that draws them, so nothing here guesses at the terminal.

Exit 0 when the tab is as the record says it should be, 1 when a paint failed
(why on standard error), 2 for words or a configuration this does not take, and
3 when the tab's record could not be read: nothing written, nothing replaced.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import stat
import subprocess
import sys
import time
from typing import Any, Callable, Mapping, Sequence

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.alerts import Folder, UnsafePath, exclusive

# The channels iTerm's tab color escape names, in the order a color gives them.
CHANNELS = ("red", "green", "blue")
# How far up the chain of parent processes a terminal is looked for.
PARENT_HOPS = 8
# A device name as `ps` prints it: a plain name under /dev, never a path out of it.
DEVICE = re.compile(r"[A-Za-z0-9]{1,32}(/[0-9]{1,6})?")
# What `ps` prints for a process with no terminal.
NO_DEVICE = frozenset({"", "?", "??", "-"})
# How long one `ps` may take before the walk gives up.
PS_SECONDS = 2.0
# A session identifier names a session and nothing else: no separator, no dot.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
# A tab identifier is hashed before it names a file, so its length only bounds work.
TAB_ID_LIMIT = 256
# Where the records live, under the state directory, and the one lock every tab's
# record is read and written under, inside that folder: the plugin makes the
# folder and checks it, and never checks the state directory itself.
TABS = "tabs"
TABS_LOCK = ".lock"
# A record's file name: a hash, so nothing else in the folder is taken for one.
RECORD_NAME = re.compile(r"[0-9a-f]{32}\.json")
# How many other records one update may look at to sweep, so a word on the tab
# never waits on a folder full of them.
SWEEP_LIMIT = 16
# The latest time an entry may say, in seconds: past it a time is not one a
# clock wrote, and a float holds every whole second below it exactly.
LATEST_SECONDS = 2 ** 53
# A number as ps and /proc print one: ASCII digits only, since int() refuses
# some characters str.isdigit() accepts.
NUMBER = re.compile(r"[0-9]{1,19}")
# How large one tab's record may be, and how many sessions it may hold.
RECORD_BYTES = 16384
MAX_ENTRIES = 64
# The levels a session may say, by rank; none is the tab's own color.
RANKS = {"waiting": 1, "failed": 2}
LEVELS = ("none", "waiting", "failed")
# What the record says the tab was last painted, besides a color.
OWN = "own"
UNKNOWN = "unknown"

Rgb = Sequence[int]
# A process as the walk asks about it: its parent, its real user, its terminal's
# name, and that terminal's device number when it has one.
Ps = Callable[[int], "tuple[int, int, str, int | None] | None"]
Paint = Callable[["Rgb | None"], "tuple[bool, str]"]


def sequence(color: Rgb | None, tmux: bool) -> bytes:
    """The escape for a color, or for the tab's own, wrapped for tmux when asked.

    tmux passes a sequence through when it is wrapped in its own device control
    string, with every escape inside doubled; anything else it keeps to itself.
    """
    if color is None:
        body = "\x1b]6;1;bg;*;default\x07"
    else:
        body = "".join("\x1b]6;1;bg;{0};brightness;{1}\x07".format(channel, int(value))
                       for channel, value in zip(CHANNELS, color))
    if tmux:
        body = "\x1bPtmux;" + body.replace("\x1b", "\x1b\x1b") + "\x1b\\"
    return body.encode("ascii")


def _run_ps(pid: int, fields: str) -> list[str] | None:
    try:
        completed = subprocess.run(["ps", "-o", fields, "-p", str(pid)], capture_output=True,
                                   text=True, timeout=PS_SECONDS, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    parts = completed.stdout.split()
    return parts if completed.returncode == 0 and parts else None


def _read_stat(pid: int) -> str | None:
    """What /proc says of a process, or None once it has gone or never had an entry."""
    try:
        return Path("/proc/{0}/stat".format(pid)).read_text(errors="replace")
    except OSError:
        return None


def parse_proc_stat(text: str) -> int | None:
    """The terminal device number in a /proc stat line, or None for none or a line that is not one.

    The command name sits in parentheses and may hold spaces and parentheses of
    its own, so the fields are counted from the last closing one: state, parent,
    group, session, then the terminal's device number.
    """
    close = text.rfind(")")
    if close < 0:
        return None
    fields = text[close + 1:].split()
    if len(fields) < 5 or not NUMBER.fullmatch(fields[4]):
        return None
    return int(fields[4]) or None


def parse_ps_device(text: str) -> int | None:
    """A device number as BSD `ps -o tdev` prints it, major/minor; None for none or anything else."""
    major, _, minor = text.partition("/")
    if not (NUMBER.fullmatch(major) and NUMBER.fullmatch(minor)) or not hasattr(os, "makedev"):
        return None
    try:
        return os.makedev(int(major), int(minor))
    except (OverflowError, ValueError):
        return None


def _ps(pid: int, run: Callable[[int, str], "list[str] | None"] = _run_ps,
        read_stat: Callable[[int], "str | None"] = _read_stat,
        linux: bool | None = None) -> tuple[int, int, str, int | None] | None:
    """A process's parent, real user, terminal and its device number, or None when ps cannot say.

    On Linux the device number is read from /proc, which BSD does not have; BSD's
    ps prints it as a column of its own. A process that goes between the two
    reads has no device number, and the walk refuses its terminal for that.
    """
    if linux is None:
        linux = os.path.exists("/proc/{0}/stat".format(pid))
    parts = run(pid, "ppid=,ruid=,tty=" if linux else "ppid=,ruid=,tdev=,tty=")
    if not parts or len(parts) < 2 or not NUMBER.fullmatch(parts[0]) or not NUMBER.fullmatch(parts[1]):
        return None
    if linux:
        name = parts[2] if len(parts) > 2 else ""
        text = read_stat(pid)
        device = parse_proc_stat(text) if text is not None else None
    else:
        name = parts[3] if len(parts) > 3 else ""
        device = parse_ps_device(parts[2]) if len(parts) > 2 else None
    return int(parts[0]), int(parts[1]), name, device


def _user() -> int | None:
    """This process's real user, or None on a platform with no user ids and no terminal devices."""
    return os.getuid() if hasattr(os, "getuid") else None


def parent_device(pid: int, ps: Ps = _ps) -> tuple[tuple[str, int] | None, str]:
    """The terminal of the nearest process up the chain that has one, with its device number, or why not.

    Starts at `pid` itself and walks only through processes this user runs: a
    process another user runs is no part of this person's session. A name `ps`
    prints that is not a plain device name is not opened, and neither is one
    whose device number is unknown, since the number is what proves the device
    opened is the one the process runs on.
    """
    uid = _user()
    if uid is None:
        return None, "this platform has no terminal devices to walk to"
    current = pid
    for _ in range(PARENT_HOPS):
        answer = ps(current)
        if answer is None:
            return None, "ps could not say what started process {0}".format(current)
        parent, user, name, device = answer
        if user != uid:
            return None, "process {0} up the chain belongs to another user".format(current)
        if name not in NO_DEVICE:
            if not DEVICE.fullmatch(name):
                return None, "ps named a terminal that is not a device name"
            if device is None:
                return None, "ps could not say the device number of {0}'s terminal".format(current)
            return ("/dev/" + name, device), ""
        if parent <= 1 or parent == current:
            break
        current = parent
    return None, "no process up the chain has a terminal"


# Opened to write only, never to become this process's terminal, never waiting
# on a terminal that will not take the bytes, and never through a link.
OPEN_FLAGS = (os.O_WRONLY | getattr(os, "O_NOCTTY", 0)
              | getattr(os, "O_NONBLOCK", 0)
              | getattr(os, "O_NOFOLLOW", 0))

Opener = Callable[[str, int], int]


def _open_terminal(path: str, device: int | None, opener: Opener) -> tuple[int | None, str]:
    """A terminal opened to write, or why it was not.

    Checked on the open handle rather than on the path, so the file checked is
    the file written. A device found up the chain must be this user's own and
    the very device that process runs on; the controlling terminal, named with
    no device number, is this process's by definition.
    """
    try:
        handle = opener(path, OPEN_FLAGS)
    except OSError as error:
        return None, "{0} did not open: {1}".format(path, error.strerror)
    info = os.fstat(handle)
    reason = ""
    if not stat.S_ISCHR(info.st_mode):
        reason = "{0} is not a character device".format(path)
    elif device is not None and info.st_uid != _user():
        reason = "{0} is owned by another user".format(path)
    elif device is not None and info.st_rdev != device:
        reason = "{0} is not the terminal the parent runs on".format(path)
    elif not os.isatty(handle):
        reason = "{0} is not a terminal".format(path)
    if reason:
        os.close(handle)
        return None, reason
    return handle, ""


def write(data: bytes, candidates: Sequence[tuple[str, int | None]],
          opener: Opener = os.open) -> tuple[bool, str]:
    """Write the escape to the first terminal that passes its checks.

    Each candidate is a path and the device number it must be, or None for the
    controlling terminal. Answers whether the escape was written whole, and why
    not when it was not.
    """
    reasons: list[str] = []
    for path, device in candidates:
        handle, reason = _open_terminal(path, device, opener)
        if handle is None:
            reasons.append(reason)
            continue
        try:
            view = memoryview(data)
            while view:
                written = os.write(handle, view)
                view = view[written:]
            return True, ""
        except OSError as error:
            return False, "{0} refused the write: {1}".format(path, error.strerror)
        finally:
            os.close(handle)
    return False, "; ".join(reasons) or "no terminal to write to"


def terminals(ps: Ps = _ps, parent: Callable[[], int] = os.getppid
              ) -> tuple[list[tuple[str, int | None]], str]:
    """Where the session's terminal may be: the controlling one, then up from the parent.

    Answers the candidates, each with the device number it must be, and why the
    walk up the parents found none when it did not.
    """
    found: list[tuple[str, int | None]] = [("/dev/tty", None)]
    device, reason = parent_device(parent(), ps)
    if device is not None:
        found.append(device)
    return found, reason


def record_path(state_dir: Path, tab: str) -> Path:
    """The file one tab's record lives in, named by a hash so no identifier names a path."""
    name = hashlib.sha256(tab.encode("utf-8")).hexdigest()[:32]
    return state_dir / TABS / (name + ".json")


def _is_time(value: Any) -> bool:
    """A number of seconds a clock could have written.

    A flag, a string, a negative number, NaN, an infinity, or anything past
    `LATEST_SECONDS` is not one. The range is checked before anything turns
    the number into a float, which an integer of four hundred digits would
    overflow.
    """
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and 0 <= value <= LATEST_SECONDS and math.isfinite(value))


def _record_from(value: Any) -> dict[str, Any] | None:
    """The record a parsed file holds, or None when any part of it is not one.

    Every field's type is checked before it is compared with anything, so a value
    of the wrong kind is a record that is not one rather than an error.
    """
    if not isinstance(value, dict):
        return None
    entries, painted = value.get("entries"), value.get("painted")
    if not isinstance(painted, str) or not isinstance(entries, dict):
        return None
    for entry in entries.values():
        if not isinstance(entry, dict):
            return None
        level = entry.get("level")
        if not isinstance(level, str) or level not in RANKS or not _is_time(entry.get("at")):
            return None
    return {"entries": entries, "painted": painted}


def read_record(tabs: Folder, name: str,
                opener: Callable[..., int] = os.open) -> tuple[dict[str, Any] | None, str]:
    """The tab's record, read through the tabs folder held open; a fresh one when nobody wrote it.

    Only a file that is not there is a tab nobody painted. One that is a link,
    will not open, is not a small regular file, or does not parse into a record
    says nothing about the tab, and is never taken as an empty one: None and
    why. A link is refused before the open as well as by it, since Windows
    cannot refuse one in the open.
    """
    try:
        handle = tabs.open(name, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0), 0, opener)
    except UnsafePath as error:
        return None, "the tab's record could not be read: {0}".format(error)
    except FileNotFoundError:
        return {"entries": {}, "painted": OWN}, ""
    except OSError as error:
        return None, "the tab's record could not be read: {0}".format(error.strerror)
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_size > RECORD_BYTES:
            return None, "the tab's record could not be read: not a small regular file"
        data = os.read(handle, RECORD_BYTES + 1)
    except OSError as error:
        return None, "the tab's record could not be read: {0}".format(error.strerror)
    finally:
        os.close(handle)
    try:
        record = _record_from(json.loads(data))
    except (ValueError, OverflowError, RecursionError):
        record = None
    if record is None or len(data) > RECORD_BYTES:
        return None, "the tab's record could not be read: it does not parse as one"
    return record, ""


def persist(tabs: Folder, name: str, record: Mapping[str, Any]) -> None:
    """Write the record whole through the tabs folder held open, or remove it once nobody holds the tab.

    A record with no entries at its own color says nothing a missing file does
    not, so no file is left for a tab nobody holds. A link where the record
    lives is refused rather than replaced.
    """
    tabs.refuse_link(name)
    if not record["entries"] and record["painted"] == OWN:
        with contextlib.suppress(FileNotFoundError):
            tabs.unlink(name)
        return
    tabs.write_json(name, record)


def _live(entry: Mapping[str, Any], now: float, stale: float) -> bool:
    """Said within the staleness, and not from ahead of this clock by more than it."""
    return now - entry["at"] < stale and entry["at"] - now < stale


def merged(record: Mapping[str, Any], session: str, level: str, now: float,
           stale: float) -> dict[str, Any]:
    """The record with this session's level in it, or out for none, stale entries dropped.

    At most `MAX_ENTRIES` stay, the newest first, so the file stays small however
    many sessions came and went without ending.
    """
    entries = {name: entry for name, entry in record["entries"].items()
               if name != session and _live(entry, now, stale)}
    if level != "none":
        entries[session] = {"level": level, "at": now}
    newest = sorted(entries.items(), key=lambda item: item[1]["at"], reverse=True)
    return {"entries": dict(newest[:MAX_ENTRIES]), "painted": record["painted"]}


def target(entries: Mapping[str, Mapping[str, Any]], tint: Mapping[str, Any]) -> Rgb | None:
    """The color the highest level in the record paints, or None for the tab's own."""
    if not tint["enabled"] or not entries:
        return None
    highest = max((entry["level"] for entry in entries.values()), key=RANKS.__getitem__)
    return tint["failureRgb"] if highest == "failed" else tint["waitingRgb"]


def color_key(color: Rgb | None) -> str:
    """How the record names a color: its parts, or own for the tab's own."""
    return OWN if color is None else ",".join(str(int(part)) for part in color)


def update(state_dir: Path, tab: str, session: str, level: str, now: float,
           tint: Mapping[str, Any], paint: Paint, record_only: bool = False,
           persist: Callable[[Folder, str, Mapping[str, Any]], None] = persist) -> tuple[int, str]:
    """Say this session's level for the tab, and paint what every live session holds.

    The record is read, merged, painted from and written while one lock is held,
    so a session that paints never decides from a record another has changed
    since. Before a paint the record is written saying the color is unknown,
    and only after the paint lands is the color written: a helper that dies or
    cannot write in between leaves the next session to paint again, never a
    record claiming a color the tab may not have. Answers the exit code and why,
    for anything but 0.
    """
    path = record_path(state_dir, tab)
    name = path.name
    with contextlib.ExitStack() as held:
        # The lock's folder is the tabs folder: taking the lock makes it, refuses
        # one that is a link or another user's, and holds it open, so the sweep,
        # the read and the writes below never walk its path again.
        try:
            tabs = held.enter_context(exclusive(path.parent / TABS_LOCK))
        except OSError as refused:
            return 3, "the tabs lock was refused: {0}".format(refused)
        sweep(tabs, now, float(tint["staleSeconds"]))
        record, reason = read_record(tabs, name)
        if record is None:
            return 3, reason
        record = merged(record, session, level, now, float(tint["staleSeconds"]))
        color = target(record["entries"], tint)
        if record_only or record["painted"] == color_key(color):
            return _written(persist, tabs, name, record)
        code, reason = _written(persist, tabs, name, {**record, "painted": UNKNOWN})
        if code != 0:
            return code, reason
        painted, reason = paint(color)
        if not painted:
            return 1, reason
        return _written(persist, tabs, name, {**record, "painted": color_key(color)})


def _written(persist: Callable[[Folder, str, Mapping[str, Any]], None], tabs: Folder, name: str,
             record: Mapping[str, Any]) -> tuple[int, str]:
    """Persist the record, answering 1 and why when it could not be."""
    try:
        persist(tabs, name, record)
    except OSError as error:
        return 1, "the tab's record could not be written: {0}".format(error)
    return 0, ""


def sweep(tabs: Folder, now: float, stale: float) -> int:
    """Remove records nobody holds any more; answer how many went.

    Called with the lock held. At most `SWEEP_LIMIT` records are looked at,
    picked at random so a run of records that must stay cannot hide the ones
    after it. A record goes when every entry in it is past the staleness and
    the tab is painted its own color. One painted a color, or unknown because a
    paint was never seen to finish, stays, so the tab can be given its own
    color back when it speaks again. A record that cannot be read stays too:
    what it says is not known. This tab's own record may be among them: one at
    its own color with nothing live reads the same removed as kept.
    """
    removed = 0
    try:
        names = tabs.names()
    except OSError:
        return 0
    candidates = [name for name in names if RECORD_NAME.fullmatch(name)]
    chosen = random.sample(candidates, min(len(candidates), SWEEP_LIMIT))
    for name in chosen:
        record, _ = read_record(tabs, name)
        if record is None or record["painted"] != OWN:
            continue
        if any(_live(entry, now, stale) for entry in record["entries"].values()):
            continue
        try:
            tabs.unlink(name)
        except OSError:
            continue
        removed += 1
    return removed


def end(state_dir: Path, tab: str, session: str, now: float, tint: Mapping[str, Any],
        paint: Paint) -> tuple[int, str]:
    """Take this session's entry out as it ends, and paint what the others still hold."""
    return update(state_dir, tab, session, "none", now, tint, paint)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tab.py",
                                     description="Keep a tab's color for the sessions in it")
    parser.add_argument("--config", default=None)
    parser.add_argument("--now", type=float, default=None, help="the clock, for a reproducible run")
    sub = parser.add_subparsers(dest="command", required=True)
    setter = sub.add_parser("set", help="say this session's level for the tab")
    ender = sub.add_parser("end", help="take this session's entry out as it ends")
    for form in (setter, ender):
        form.add_argument("--tab", required=True)
        form.add_argument("--session", required=True)
    setter.add_argument("--level", required=True, choices=LEVELS)
    setter.add_argument("--record-only", action="store_true",
                        help="keep the entry alive without painting")
    # `--tmux` wraps the escape for tmux, and may stand anywhere: the plugin
    # writes it after the form.
    words = list(sys.argv[1:] if argv is None else argv)
    tmux = "--tmux" in words
    words = [word for word in words if word != "--tmux"]
    try:
        args = parser.parse_args(words)
    except SystemExit:
        return 2
    if not SESSION_ID.fullmatch(args.session) or not 0 < len(args.tab) <= TAB_ID_LIMIT:
        sys.stderr.write("tab.py: a session is a plain name and a tab at most {0} characters\n"
                         .format(TAB_ID_LIMIT))
        return 2
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        sys.stderr.write("tab.py: configuration refused: " + json.dumps(refusal.errors) + "\n")
        return 2
    now = args.now if args.now is not None else time.time()

    def paint(color: Rgb | None) -> tuple[bool, str]:
        found, walked = terminals()
        written, reason = write(sequence(color, tmux), found)
        if written:
            return True, ""
        return False, "wrote nothing: " + "; ".join(part for part in (reason, walked) if part)

    level = args.level if args.command == "set" else "none"
    code, reason = update(Path(config["stateDir"]), args.tab, args.session, level, now,
                          config["alerts"]["tabTint"], paint,
                          args.command == "set" and args.record_only)
    if code != 0:
        sys.stderr.write("tab.py: " + reason + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
