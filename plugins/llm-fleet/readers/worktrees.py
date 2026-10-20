#!/usr/bin/env python3
"""The worktree reader: what is checked out, and whether it can be cleaned up.

A worktree row is a claim about a folder, so it is built from facts a probe can
prove: the branch on disk, whether that branch is contained in the declared base
ref, whether an archive ref preserves it, and whether a live process holds it.
Anything a probe could not establish is reported as unknown, never as safe.

A failed probe does not erase a row this reader already published: the previous
row is kept with its own timestamp and a note saying it was not rechecked, which
is a stale row and not a fresh one.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import time
from typing import Any, Mapping

from .runtime import (CACHE_BYTES, ReaderFailure, child_environment, printable, read_bounded_json,
                      read_bounded_text, resolve_command, shell_command, write_private_json)

CACHE_NAME = "worktrees.json"
LOCK_NAME = "worktrees.lock"
ARCHIVE_PREFIX = "refs/archive/"
# Processes that hold a folder without using it. A holder list that is only
# these means the folder is free.
INERT_HOLDERS = frozenset({"caffeinate", "caffeinat"})
LIVE = "active"
STALE_STATES = frozenset({"active", "held", "merged", "preserved"})


def git(argv: list[str], path: Path, seconds: float,
        environment: Mapping[str, str]) -> tuple[int, str, str]:
    """One git command inside a worktree, bounded: its exit status, output and errors."""
    try:
        completed = subprocess.run(["git", "-C", str(path), *argv], capture_output=True,
                                   text=True, env=dict(environment), timeout=seconds)
    except subprocess.TimeoutExpired:
        raise ReaderFailure("timed out after {0:g}s".format(seconds)) from None
    except OSError as caught:
        raise ReaderFailure(caught.strerror or type(caught).__name__) from None
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()


def first_line(text: str) -> str:
    """The first line of a tool's error output, fit for a row."""
    lines = text.strip().splitlines()
    return printable(lines[0])[:160] if lines else ""


def live_holders(config: Mapping[str, Any], path: Path,
                 environment: Mapping[str, str]) -> list[str] | None:
    """The names of live processes holding a folder, or None when unknowable.

    None is not an empty list: a platform without the inspection tool cannot say
    the folder is free, and saying so would invite a cleanup that deletes work.
    """
    return _inspect_holders(config, path, environment)[0]


def _lsof_output(config: Mapping[str, Any], command: list[str], args: list[str],
                 environment: Mapping[str, str]) -> tuple[str, str]:
    """What one lsof call printed, or why nothing could be read from it.

    The three answers are kept apart because two of them are not facts: a
    silent exit 1 is lsof saying nothing is open, an exit 1 with a warning is a
    directory it could not read, and any other failing exit is no answer at
    all. Neither of the last two may read as a folder nobody holds.
    """
    seconds = float(config["timeouts"]["liveHoldersSeconds"])
    try:
        completed = subprocess.run([*command, *args], capture_output=True, text=True,
                                   env=dict(environment), timeout=seconds)
    except subprocess.TimeoutExpired:
        return "", "lsof did not answer within {0:g}s".format(seconds)
    except OSError as caught:
        return "", "lsof could not start: " + (caught.strerror or type(caught).__name__)
    if completed.returncode == 1 and not completed.stdout.strip() and not completed.stderr.strip():
        return "", ""
    if completed.returncode != 0:
        detail = first_line(completed.stderr)
        return "", "lsof exited {0}".format(completed.returncode) + (": " + detail if detail else "")
    return completed.stdout, ""


def _roots_as_written(roots: list[Path]) -> list[str]:
    """Every spelling of a root this machine may use for a path inside it.

    A tool reports what the kernel has, which is the resolved path: a folder
    reached through a link, or `/var` on macOS, is spelled the resolved way.
    Matching the configured text alone would read a folder somebody is in as
    free, and free is the answer that offers a cleanup over live work.
    """
    spellings: list[str] = []
    for root in roots:
        candidates = [str(root)]
        try:
            candidates.append(os.path.realpath(root))
        except OSError:
            pass
        for candidate in candidates:
            folded = _folded(candidate)
            if folded and folded not in spellings:
                spellings.append(folded)
    return spellings


def open_paths(config: Mapping[str, Any], environment: Mapping[str, str],
               roots: list[Path], links: list[Path] | None = None
               ) -> tuple[list[tuple[str, str]], str]:
    """Every path open on the machine under these roots, read once for a sweep.

    Asking `lsof` per worktree with `+D` walks that checkout's entire tree on
    disk, which costs half a second per worktree and grows with the repository.
    This asks instead for the file every process already has open, which is one
    pass over the process table for the whole sweep and showed 0.63s against
    five seconds of walks for the same machine. It also answers what `+D` was
    there for: an editor holding a file under a folder it does not sit in.

    A pair is the process name and its path. The second value is why nothing
    could be read, and is empty when the pass answered.
    """
    command = resolve_command(["lsof"], environment)
    if command is None:
        return [], "lsof is not on the PATH"
    printed, why = _lsof_output(config, command, ["-nP", "-Fpcn"], environment)
    if why:
        return [], why
    # The roots are the folders the worktrees live in, so a path is kept only
    # when it starts with one of them: one comparison per line rather than one
    # per worktree, and a machine with hundreds of them pays the same. A
    # worktree that is itself a link is kept under its target's spelling too,
    # because that is the path the kernel reports for a file opened there.
    spellings = tuple(_roots_as_written([*roots, *(links or [])]))
    pairs: list[tuple[str, str]] = []
    name = ""
    for line in printed.splitlines():
        if line.startswith("c"):
            name = line[1:].strip()
        elif line.startswith("n") and name:
            where = _folded(line[1:].strip())
            if where and name not in INERT_HOLDERS and where.startswith(spellings):
                pairs.append((name, where))
    return pairs, ""


def _folded(text: str) -> str:
    """A folder as this platform spells it, with no trailing separator.

    A folder read from a tool and a folder built here need not agree on the
    separator: a Windows listing may spell one either way, and Windows folds
    case too. Comparing the text alone reads a folder somebody is working in as
    free, and free is the answer that offers a cleanup over live work.
    """
    folded = text.replace(os.altsep, os.sep) if os.altsep else text
    return os.path.normcase(folded.rstrip(os.sep))


def _real(text: str) -> str:
    """What a path resolves to, and the path itself when it resolves to nothing."""
    try:
        return os.path.realpath(text)
    except OSError:
        return text


def _held_by(folders: list[tuple[str, str]], path: Path) -> list[str]:
    """The processes whose working folder is this one or a folder inside it.

    A worktree folder may itself be a link, and a tool reports the path the
    kernel has, which is the resolved one. Matching only the spelling the
    listing was built from would read a folder somebody is working in as free.
    """
    roots = {_folded(str(path)), _folded(_real(str(path)))}
    prefixes = [root + os.sep for root in roots]
    held = set()
    for name, folder in folders:
        where = _folded(folder)
        if where in roots or where.startswith(tuple(prefixes)):
            held.add(name)
    return sorted(held)


def _inspect_holders(config: Mapping[str, Any], path: Path,
                     environment: Mapping[str, str],
                     folders: list[tuple[str, str]] | None = None
                     ) -> tuple[list[str] | None, str]:
    """The live holders of a folder, or None with the reason they could not be read.

    `folders` is every path open on the machine under the worktree roots, read
    once by the caller from one `lsof` pass. It holds the file every process has
    open as well as its working folder, so it answers the question the recursive
    walk was there for: an editor holding a file under a folder it does not sit
    in. Where it was read, no tree is walked. It is None when that pass could not
    be read, and then the walk answers, or the holder count is unknown.
    """
    if folders is not None:
        return _held_by(folders, path), ""
    command = resolve_command(["lsof"], environment)
    if command is None:
        return None, "lsof is not on the PATH"
    printed, why = _lsof_output(config, command, ["-nP", "-Fpc", "+D", str(path)], environment)
    if why:
        return None, why
    names = []
    for line in printed.splitlines():
        if line.startswith("c"):
            name = line[1:].strip()
            if name and name not in INERT_HOLDERS:
                names.append(name)
    return sorted(set(names)), ""


# A `.git` file and a `HEAD` file are both one line, not a document.
GITFILE_BYTES = 4096
HEAD_BYTES = 256
HEADS_PREFIX = "ref: refs/heads/"


def _branch_of(path: Path) -> str | None:
    """The branch this checkout has checked out, or None when it has none.

    Read from the worktree's own `HEAD` file rather than asked of git, because a
    sweep asks this of every worktree and a file read starts no process. A
    detached checkout has no branch and answers None, which sends the row down
    the full probe for its reason to be stated.
    """
    marker = path / ".git"
    gitdir: Path | None = None
    if marker.is_dir():
        gitdir = marker
    elif marker.is_file():
        document = read_bounded_text(marker, GITFILE_BYTES) or ""
        first = document.strip().splitlines()[0] if document.strip() else ""
        if first.startswith("gitdir:"):
            target = Path(first[len("gitdir:"):].strip())
            gitdir = target if target.is_absolute() else path / target
    if gitdir is None:
        return None
    head = (read_bounded_text(gitdir / "HEAD", HEAD_BYTES) or "").strip()
    if not head.startswith(HEADS_PREFIX):
        return None
    branch = head[len(HEADS_PREFIX):].strip()
    return branch or None


def head_facts(config: Mapping[str, Any], path: Path,
               environment: Mapping[str, str]) -> tuple[str, str] | None:
    """The branch and commit a checkout stands at, or None when they cannot be read.

    One git call, because the branch a checkout has may sit in a packed ref and
    a file alone cannot say which commit that is. A sweep compares these two
    with what it proved last time: a tree that has not moved has not changed what
    it is merged into, nor whether an archive holds it, until the refs move too.
    """
    branch = _branch_of(path)
    if branch is None:
        return None
    seconds = float(config["timeouts"]["gitSeconds"])
    try:
        code, head, _ = git(["rev-parse", "HEAD"], path, seconds, environment)
    except ReaderFailure:
        return None
    if code != 0 or not head.strip():
        return None
    return branch, head.strip()


def repo_facts(config: Mapping[str, Any], root: Path,
               environment: Mapping[str, str]) -> dict[str, str] | None:
    """The base ref's commit and the archive refs, as one repository stands now.

    Two facts a worktree's row is derived from but does not own: the commit the
    base ref points at, and which archive refs exist. Asked once per repository
    per sweep, because every worktree of a repository shares them.
    """
    seconds = float(config["timeouts"]["gitSeconds"])
    base = str(config["sources"]["worktrees"]["baseRef"])
    try:
        code, tip, _ = git(["rev-parse", "--verify", "--quiet", base], root, seconds, environment)
        if code != 0 or not tip.strip():
            return None
        code, refs, warned = git(["for-each-ref", "--format=%(refname) %(objectname)",
                                  ARCHIVE_PREFIX], root, seconds, environment)
    except ReaderFailure:
        return None
    if code != 0 or warned:
        return None
    # A digest rather than the listing: what a sweep compares is whether the
    # archive refs moved, and a machine with many worktrees would otherwise
    # store the same lines once per tree until the cache passed its bound.
    return {"base": tip.strip(),
            "archive": hashlib.sha256(refs.encode("utf-8")).hexdigest()}


def change_facts(config: Mapping[str, Any], path: Path, branch: str,
                 environment: Mapping[str, str],
                 known: dict[str, str] | None = None) -> dict[str, Any]:
    """What the controller store knows about this worktree, when it can answer.

    The worktree path is part of the match, so a change belonging to another
    worktree of the same branch is never reported as this one's.

    `known` carries the remote and root commit this repository's worktrees
    answered before. A remote is one value for the whole repository. A root
    commit is one value per branch history, so the first tree's answer is kept
    for the rest: a worktree whose branch carries an unrelated history of its
    own would miss the change store rather than be given another branch's, which
    is the direction that cannot claim someone else's change.
    """
    source = config["sources"]["trials"]
    if not source["enabled"] or not source["database"]:
        return {}
    database = Path(source["database"])
    if not database.is_file():
        return {}
    if known is not None and known.get("remote") and known.get("root"):
        remote, root = known["remote"], known["root"]
    else:
        seconds = float(config["timeouts"]["gitSeconds"])
        try:
            code, remote, _ = git(["config", "--get", "remote.origin.url"], path, seconds,
                                  environment)
            if code != 0 or not remote:
                return {}
            code, roots, _ = git(["rev-list", "--max-parents=0", "HEAD"], path, seconds,
                                 environment)
            if code != 0 or not roots:
                return {}
        except ReaderFailure as failure:
            return {"error": str(failure)}
        root = sorted(roots.splitlines())[-1]
        if known is not None:
            known["remote"], known["root"] = remote, root
    timeout = float(config["timeouts"]["trialDatabaseSeconds"])
    try:
        with sqlite3.connect("file:{0}?mode=ro".format(database), uri=True,
                             timeout=timeout) as connection:
            connection.row_factory = sqlite3.Row
            found = connection.execute(
                "SELECT * FROM repos WHERE remote_url=? AND root_oid=?",
                (remote, root)).fetchone()
            if found is None:
                return {}
            change = connection.execute(
                "SELECT * FROM changes WHERE branch=? AND worktree_path=? "
                "ORDER BY rowid DESC LIMIT 1", (branch, str(path))).fetchone()
            if change is None:
                return {}
            owner = None
            updated = None
            identifier = change["change_id"] if "change_id" in change.keys() else None
            if identifier is not None:
                milestone = connection.execute(
                    "SELECT session, created_at FROM milestones WHERE change_id=? "
                    "ORDER BY created_at DESC LIMIT 1", (identifier,)).fetchone()
                if milestone is not None:
                    owner, updated = milestone["session"], milestone["created_at"]
    except (sqlite3.Error, OSError) as caught:
        return {"error": "change store unavailable: {0}".format(caught)}
    return {"state": change["state"], "owner": owner, "updated_at": updated}


def cleaned_count(config: Mapping[str, Any], now: float) -> int | None:
    """How many worktrees were cleaned inside the retention window, or None."""
    source = config["sources"]["trials"]
    if not source["enabled"] or not source["database"]:
        return None
    database = Path(source["database"])
    if not database.is_file():
        return None
    window = float(config["history"]["cleanedSeconds"])
    timeout = float(config["timeouts"]["trialDatabaseSeconds"])
    try:
        with sqlite3.connect("file:{0}?mode=ro".format(database), uri=True,
                             timeout=timeout) as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM milestones WHERE to_state=? AND created_at >= ? "
                "AND created_at <= ?", ("CLEANED", now - window, now)).fetchone()
    except (sqlite3.Error, OSError):
        return None
    return int(row[0]) if row else 0


# The platform the cleanup command is offered for, read at the call so a test
# can stand in for another one.
PLATFORM = os.name
# What cmd on Windows reads as nothing but the characters themselves. Its own
# quoting is not a POSIX shell's, so a quoted argument protects nothing there.
# A tilde is plain to cmd, and Windows writes long folder names in their 8.3
# form with one, so a worktree under such a folder is still offered a command.
WINDOWS_PLAIN = re.compile(r"[A-Za-z0-9_./\\:~-]+")
# Said in place of a command when no command could be offered safely.
CLEANUP_BY_HAND = "clean this worktree up by hand: its name holds characters the shell would read"


# The words a cleanup line fills in, and the arguments it takes when the
# configuration names none: the change controller's own shape.
PATH_WORD = "{path}"
BRANCH_WORD = "{branch}"
CLEANUP_ARGS = ("cleanup", "--worktree", PATH_WORD, "--branch", BRANCH_WORD)


def cleanup_command(config: Mapping[str, Any], path: Path, branch: str,
                    platform: str | None = None) -> str:
    """The cleanup action for a worktree, as configured, or nothing at all.

    The line is copied into a shell, so on a POSIX shell every argument is
    quoted: a folder named with a space would split there, and a quote, a
    semicolon or a dollar sign in a folder or a branch would end the argument
    and run what followed it. On Windows a command is offered only when every
    argument is plain, and nothing is offered otherwise.
    """
    command = config["commands"]["cleanup"]
    template = config["commands"].get("cleanupArgs") or CLEANUP_ARGS
    # A placeholder is a whole word; a line that never names the worktree acts
    # on none in particular, and one that names a branch needs one to name.
    if not command or PATH_WORD not in template or (BRANCH_WORD in template and not branch):
        return ""
    filled = {PATH_WORD: str(path), BRANCH_WORD: branch}
    arguments = [*[str(part) for part in command],
                 *[filled.get(word, word) for word in template]]
    if (platform or PLATFORM) == "nt":
        if all(WINDOWS_PLAIN.fullmatch(argument) for argument in arguments):
            return " ".join(arguments)
        return ""
    # Quoted word by word, and a configured `$HOME/` or `~/` prefix is left
    # outside the quotes so the shell that runs the pasted line expands it.
    return shell_command(arguments)


def probe_worktree(config: Mapping[str, Any], path: Path,
                   environment: Mapping[str, str],
                   folders: list[tuple[str, str]] | None = None,
                   proved: Mapping[str, Any] | None = None,
                   change_cache: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    """Everything one worktree can be asked, with what could not be proved named.

    `merged` is True, False or None. None is unknown: a detached checkout, a
    base ref that does not resolve, or a comparison that failed. Only an answer
    from the comparison itself is a fact, and an unknown never derives a state
    that claims the branch merged or not, nor offers a cleanup. `archived` is
    three-state the same way, and so is `held`: a row whose archive lookup failed,
    or whose live holders could not be read, is offered no cleanup either.

    `proved` carries the facts a sweep has already established for this row: the
    branch and commit still stand where the last probe found them, and the base
    ref and the archive refs have not moved since it compared against them. What
    that probe answered about the merge and the archive still holds, so the four
    git calls that asked again are skipped. Only answers it settled on are
    carried here, so an uncertainty is always re-asked rather than repeated.
    """
    git_seconds = float(config["timeouts"]["gitSeconds"])
    budget = float(config["timeouts"]["worktreeProbeSeconds"])
    deadline = time.monotonic() + budget
    body: dict[str, Any] = {"name": printable(path.name), "path": str(path)}

    spent = "probe budget of {0:g}s was spent".format(budget)

    def bounded(argv: list[str]) -> tuple[int, str, str]:
        """One git call inside this probe's budget, refused in the budget's name.

        The call is handed what is left of the probe's budget whenever that is
        shorter than a git call's own bound. A call given a sliver of a second
        times out, and the refusal then reads "timed out after 0.001s", which
        says git was slow when what happened is that the probe ran out of time.
        Which bound ended the probe is the one thing the row is there to say, so
        a timeout the budget caused is reported as the budget.
        """
        left = deadline - time.monotonic()
        if left <= 0:
            raise ReaderFailure(spent)
        seconds = min(git_seconds, left)
        try:
            return git(argv, path, seconds, environment)
        except ReaderFailure as failure:
            if seconds < git_seconds and str(failure).startswith("timed out after "):
                raise ReaderFailure(spent) from None
            raise

    notes: list[str] = []
    if proved is not None:
        body.update({"branch": proved["branch"], "merged": proved["merged"],
                     "archived": proved["archived"]})
        for key in ("project", "project_root"):
            if key in proved:
                body[key] = proved[key]
        merged, archived = proved["merged"], proved["archived"]
    else:
        code, branch, _ = bounded(["symbolic-ref", "--quiet", "--short", "HEAD"])
        # Which project a worktree belongs to, asked of git rather than guessed
        # from its folder: a checkout under another project's `.claude/worktrees`
        # and one under a shared worktrees folder both name the repository they
        # hold. A call that fails reports nothing rather than a name built from a
        # path that may be a convention this machine does not follow.
        code, common, _ = bounded(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        if code == 0 and common.strip():
            common_path = Path(common.strip())
            project = common_path.parent if common_path.name == ".git" else common_path
            body["project"] = printable(project.name)
            body["project_root"] = printable(str(project))
        if code != 0 or not branch:
            body.update({"branch": "", "merged": None, "archived": False, "held": None,
                         "state": "unknown", "cleanup_command": "",
                         "error": "detached worktree has no cleanup branch"})
            return body
        body["branch"] = printable(branch)
        base = str(config["sources"]["worktrees"]["baseRef"])
        code, _, _ = bounded(["rev-parse", "--verify", "--quiet", base])
        if code != 0:
            body.update({"merged": None, "archived": False, "held": None, "state": "unknown",
                         "cleanup_command": "", "error": "cannot compare with " + base})
            return body
        code, _, _ = bounded(["merge-base", "--is-ancestor", "HEAD", base])
        # Exit 0 is an ancestor and exit 1 is not; any other exit is git failing
        # to answer, which says nothing about the branch.
        merged: bool | None = {0: True, 1: False}.get(code)
        if merged is None:
            notes.append("cannot tell whether {0} is merged into {1}: git merge-base exited {2}"
                         .format(body["branch"], printable(base), code))
        code, refs, warned = bounded(["for-each-ref", "--contains=HEAD", "--format=%(refname)",
                             ARCHIVE_PREFIX])
        # A lookup that failed has not shown that no archive ref holds the branch,
        # and one that wrote errors and still exited 0 walked a damaged history:
        # it lists a ref whose commits it could not read as one holding the branch.
        archived: bool | None = bool(refs) if code == 0 and not warned else None
        if archived is None:
            why = ("git for-each-ref exited {0}".format(code) if code != 0
                   else "git for-each-ref reported: " + first_line(warned))
            notes.append("cannot tell whether {0} is archived: {1}".format(body["branch"], why))
    # A holder is answered from the paths read once for the sweep, which hold
    # the file every process has open as well as its working folder, so the row
    # that offers to remove a worktree is as sure as the one beside it.
    holders, unread = _inspect_holders(config, path, environment, folders)
    body.update({"merged": merged, "archived": archived,
                 "held": None if holders is None else bool(holders)})
    if holders is None:
        notes.append("live process inspection unavailable: " + unread)
    elif holders:
        notes.append("held by " + ", ".join(holders[:3]))
    key = str(body.get("project_root") or path)
    known = change_cache.setdefault(key, {}) if change_cache is not None else None
    facts = change_facts(config, path, body["branch"], environment, known)
    body["change_state"] = facts.get("state")
    body["change_owner"] = facts.get("owner")
    body["change_updated_at"] = facts.get("updated_at")
    if facts.get("error"):
        notes.append(printable(facts["error"]))
    if notes:
        body["error"] = "; ".join(notes)
    if body["held"] is None:
        state = "unknown"
    elif body["held"]:
        state = "held"
    elif merged is None:
        state = "unknown"
    elif archived is None:
        state = "unknown"
    elif merged:
        state = "merged"
    elif archived:
        state = "preserved"
    else:
        state = LIVE
    body["state"] = state
    if merged is None:
        # Nothing says the work is safe to remove, so no line to remove it is offered.
        body["cleanup_command"] = ""
        return body
    if archived is None:
        # Whether a copy of the work is kept is not known, so it is not removed either.
        body["cleanup_command"] = ""
        return body
    if body["held"] is None:
        # No one could check whether a process is using the folder.
        body["cleanup_command"] = ""
        return body
    body["cleanup_command"] = cleanup_command(config, path, body["branch"])
    if not body["cleanup_command"] and config["commands"]["cleanup"]:
        body["cleanup_note"] = CLEANUP_BY_HAND
    return body


def _lock(path: Path, now: float, abandon_after: float) -> int | None:
    """An exclusive lock, or None when another reader holds one that is still live.

    The lock file carries the moment it was taken, so a reader that died holding
    it does not stop every later inspection: a lock older than one probe budget is
    abandoned and taken again. Without that, one interrupted run would leave this
    reader serving its cache and never probing again.
    """
    for attempt in (1, 2):
        try:
            handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if attempt == 2:
                return None
            # Read without following a link: a lock is this reader's own file,
            # and one planted as a link says nothing about a live inspection.
            try:
                taken = float((read_bounded_text(path, 64) or "").strip() or 0)
            except ValueError:
                taken = 0.0
            if now - taken <= abandon_after:
                return None
            try:
                path.unlink()
            except OSError:
                return None
            continue
        except OSError:
            return -1
        try:
            os.write(handle, "{0:.6f}".format(now).encode("utf-8"))
        except OSError:
            pass
        return handle
    return None


def _unlock(path: Path, handle: int) -> None:
    """Release a lock this caller actually took."""
    if handle < 0:
        return
    os.close(handle)
    try:
        path.unlink()
    except OSError:
        pass


def _read_cache(path: Path) -> dict[str, Any]:
    """The cache as written, never read through a link; empty for anything else."""
    document = read_bounded_json(path, CACHE_BYTES)
    return document if isinstance(document, dict) else {}


def read_worktrees(config: Mapping[str, Any], *, environ: Mapping[str, str] | None = None,
                   now: float | None = None, refresh: bool = False) -> dict[str, Any]:
    """Every worktree under the configured roots, with the ones that could not be read."""
    source = config["sources"]["worktrees"]
    clock = float(now) if now is not None else time.time()
    errors: list[dict[str, str]] = []
    result: dict[str, Any] = {"state": "disabled", "worktrees": [], "cleaned": None,
                              "errors": errors}
    if not source["enabled"]:
        return result
    environment = child_environment(config["runtime"]["childEnvironment"],
                                    os.environ if environ is None else environ)
    limit = int(config["limits"]["questionCharacters"])
    state = config.get("stateDir")
    cache_path = Path(state) / CACHE_NAME if state else None
    lock_path = Path(state) / LOCK_NAME if state else None
    cached = _read_cache(cache_path) if cache_path is not None else {}
    ttl = float(config["cache"]["worktreeSeconds"])
    fresh = (isinstance(cached.get("at"), (int, float))
             and 0 <= clock - float(cached["at"]) < ttl)
    if fresh and not refresh:
        result["worktrees"] = cached.get("worktrees", [])
        result["cleaned"] = cached.get("cleaned")
        result["state"] = "ready" if result["worktrees"] else "empty"
        for entry in cached.get("errors", []):
            if isinstance(entry, Mapping):
                errors.append({"source": printable(entry.get("source")),
                               "reason": printable(entry.get("reason"))})
        return result
    handle = (_lock(lock_path, clock, float(config["timeouts"]["worktreeProbeSeconds"]))
              if lock_path is not None else -1)
    if handle is None:
        # Another session is inspecting. Its rows on hand are served as they are,
        # each with the age it was checked at: that is how most reads go on a
        # machine running several sessions, not a fault to warn about. With
        # nothing on hand the section cannot say what is there, and says why.
        result["worktrees"] = [row for row in cached.get("worktrees", [])
                               if isinstance(row, Mapping)]
        if result["worktrees"]:
            result["state"] = "ready"
        else:
            errors.append({"source": "worktrees", "reason": "inspection in progress"})
            result["state"] = "unavailable"
        return result
    try:
        paths: list[Path] = []
        bases: list[Path] = []
        for root in source["roots"]:
            base = Path(root)
            if not base.is_dir():
                continue
            try:
                paths.extend(sorted(entry for entry in base.iterdir() if entry.is_dir()))
                bases.append(base)
            except OSError:
                errors.append({"source": "worktrees", "reason": "could not list " + str(base)})
        previous: dict[str, Any] = {}
        for row in cached.get("worktrees", []):
            if isinstance(row, Mapping) and isinstance(row.get("path"), str):
                previous[row["path"]] = row
        standing: dict[str, Any] = {}
        # A cache written by another version, or by a run that died, may hold
        # anything under this key. A shape that is not one is read as none, so
        # the sweep asks every tree again rather than failing the whole section.
        raw_probes = cached.get("probes")
        for key, entry in (raw_probes.items() if isinstance(raw_probes, Mapping) else ()):
            if isinstance(entry, Mapping):
                standing[str(key)] = entry
        rows: list[dict[str, Any]] = []
        probes: dict[str, dict[str, str]] = {}
        repos: dict[str, dict[str, str] | None] = {}
        change_repos: dict[str, dict[str, str]] = {}
        # A worktree folder that is a link is where somebody may be working, and
        # a tool reports its target. Those spellings are handed to the pass, so
        # a process there is not dropped before its row is asked.
        links = [path for path in paths if path.is_symlink()]
        # Every path open on the machine under these worktrees, read once for the
        # whole sweep. Asking per worktree walked every checkout on disk.
        folders, folders_unread = open_paths(config, environment, bases, links)
        if folders_unread:
            folders = None
        for path in paths:
            key = str(path)
            # What this checkout stands at, asked of one git call and its HEAD
            # file. The sweep compares it with what the last one proved.
            here = head_facts(config, path, environment)
            proved = _proved_row(config, previous.get(key), here, standing.get(key), repos,
                                 environment)
            try:
                row = probe_worktree(config, path, environment, folders, proved, change_repos)
            except ReaderFailure as failure:
                rows.append(_keep_previous(previous.get(key), key, printable(path.name),
                                           str(failure), clock))
                errors.append({"source": "worktrees:" + printable(path.name),
                               "reason": printable(str(failure))[:limit]})
                continue
            row["checked_at"] = clock
            rows.append(row)
            # What a fresh probe compared is the commit it read while it ran. If
            # the checkout moved under it, the answers may describe either one,
            # so nothing is kept for the next sweep to compare against and the
            # tree is asked again rather than reused on a guess.
            after = here if proved is not None else head_facts(config, path, environment)
            if after is not None and after == here:
                facts = _proved_facts(config, row, after, repos, environment)
                if facts is not None:
                    probes[key] = facts
        result["worktrees"] = rows
        result["cleaned"] = cleaned_count(config, clock)
        result["state"] = "ready" if rows else "empty"
        if cache_path is not None:
            try:
                write_private_json(cache_path, {"at": clock, "worktrees": rows,
                                                "cleaned": result["cleaned"], "errors": errors,
                                                "probes": probes})
            except OSError:
                errors.append({"source": "worktrees", "reason": "cache was not written"})
        return result
    finally:
        if lock_path is not None:
            _unlock(lock_path, handle)


def _repo_refs(config: Mapping[str, Any], root: str, repos: dict[str, dict[str, str] | None],
               environment: Mapping[str, str]) -> dict[str, str] | None:
    """The base and archive refs of one repository, asked once per sweep.

    A repository that could not be read keeps that answer too, so the worktrees
    that live in it do not each ask again and pay the same failure.
    """
    if root not in repos:
        try:
            repos[root] = repo_facts(config, Path(root), environment)
        except ReaderFailure:
            repos[root] = None
    return repos[root]


def _proved_row(config: Mapping[str, Any], previous: Any, here: tuple[str, str] | None,
                standing: Any, repos: dict[str, dict[str, str] | None],
                environment: Mapping[str, str]) -> dict[str, Any] | None:
    """The facts an earlier sweep proved, when this checkout still stands on them.

    A tree whose branch and commit have not moved, in a repository whose base
    ref and archive refs have not moved, stands where it stood: what the last
    probe answered about the merge and the archive still holds. Only settled
    answers are carried, so an uncertainty is asked again rather than repeated
    for as long as the tree sits still.
    """
    if not isinstance(previous, Mapping) or previous.get("recheck_error"):
        return None
    if here is None or not isinstance(standing, Mapping):
        return None
    if previous.get("merged") is None or previous.get("archived") is None:
        return None
    root = previous.get("project_root")
    if not isinstance(root, str) or not root:
        return None
    refs = _repo_refs(config, root, repos, environment)
    if refs is None:
        return None
    if (here[0] != standing.get("branch") or here[1] != standing.get("head")
            or refs["base"] != standing.get("base")
            or refs["archive"] != standing.get("archive")):
        return None
    proved: dict[str, Any] = {"branch": here[0], "merged": previous["merged"],
                              "archived": previous["archived"]}
    for name in ("project", "project_root"):
        if isinstance(previous.get(name), str):
            proved[name] = previous[name]
    return proved


def _proved_facts(config: Mapping[str, Any], row: Mapping[str, Any],
                  here: tuple[str, str] | None, repos: dict[str, dict[str, str] | None],
                  environment: Mapping[str, str]) -> dict[str, str] | None:
    """What this sweep established about a row, kept for the next one to compare.

    A detached checkout, a row with no branch, or a repository whose refs could
    not be read keeps nothing: the next sweep asks it in full rather than
    comparing against a fact nobody proved.
    """
    root = row.get("project_root")
    if here is None or not row.get("branch") or not isinstance(root, str) or not root:
        return None
    refs = _repo_refs(config, root, repos, environment)
    if refs is None:
        return None
    return {"branch": here[0], "head": here[1], "base": refs["base"],
            "archive": refs["archive"]}


def _keep_previous(previous: Any, path: str, name: str, reason: str,
                   clock: float) -> dict[str, Any]:
    """The row this reader last published, kept with a note instead of a fresh claim."""
    if isinstance(previous, Mapping) and previous.get("state") in STALE_STATES:
        kept = dict(previous)
        kept["recheck_error"] = reason
        return kept
    return {"name": name, "path": path, "branch": "", "merged": None, "archived": False,
            "held": None, "state": "unknown", "error": reason, "cleanup_command": "",
            "checked_at": clock}

