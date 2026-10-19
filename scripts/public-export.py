#!/usr/bin/env python3
"""Export an allowlisted, text-only tree without touching Git metadata."""

from __future__ import annotations

import argparse
import base64
import binascii
import difflib
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import time
import unicodedata
from urllib.parse import unquote


MANIFEST = ".fleet-export.json"
LOCK = ".fleet-export.lock"
IDENTITY = "owner-identity.txt"
# The private checkout's own configuration and sections, kept beside the source
# and never published: a path under it is refused like the identity inventory.
PERSONAL = "personal"
# A lock older than this is treated as abandoned by a run that died holding it.
# The bound is time, not process identity: asking a pid whether it is alive is
# safe on POSIX and not on Windows, where a signal walks into TerminateProcess.
LOCK_STALE_SECONDS = 900
# Decoding is bounded, because a rule is checked against every decoded form.
MAX_DECODED_RUNS = 512
MAX_DECODED_BYTES = 8192
MAX_FORMS = 4096
# Characters that are invisible or reorder text rather than spell it. A rule that
# only reads the text as written is defeated by one of them dropped inside a value.
# Written as code points so this file stays plain ASCII: a character that cannot be
# written to a Windows console must not be a character a source file carries.
INVISIBLE = str.maketrans("", "", "".join(chr(code) for code in (
    0x00AD,  # soft hyphen
    0x200B, 0x200C, 0x200D,  # zero-width space, non-joiner, joiner
    0x200E, 0x200F,  # left-to-right and right-to-left marks
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E,  # bidi embedding and override
    0x2060,  # word joiner
    0x2066, 0x2067, 0x2068, 0x2069,  # bidi isolates
    0xFEFF,  # byte order mark
)))
PERCENT = re.compile(r"%[0-9A-Fa-f]{2}")
DECODABLE = re.compile(r"[A-Za-z0-9+/_-]{16,}={0,2}")


class ExportError(ValueError):
    """The export cannot be proved safe."""


def safe_name(name: str) -> bool:
    parts = PurePosixPath(name).parts
    return bool(parts) and not name.startswith("/") and parts[0] != PERSONAL and all(
        part not in ("..", ".git", MANIFEST, LOCK, IDENTITY) for part in parts
    ) and "\\" not in name and all(ord(char) >= 32 for char in name)


def reject_link_ancestors(path: Path) -> None:
    for part in (path, *path.parents):
        if part.is_symlink():
            # macOS exposes its temporary directories through root-owned aliases.
            if (sys.platform == "darwin" and part in (Path("/tmp"), Path("/var"))
                    and part.lstat().st_uid == 0
                    and part.resolve() == Path("/private") / part.name):
                continue
            raise ExportError("symlink in input or output path")


def lines(path: Path) -> list[str]:
    reject_link_ancestors(path)
    result = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.strip()
        if value and not value.startswith("#"):
            result.append(value)
    if not result:
        raise ExportError("empty export policy")
    return result


def inventory(root: Path) -> dict[str, Path]:
    """Inspect without following links or entering Git metadata."""
    result = {}
    if not root.exists():
        return result
    if not root.is_dir():
        raise ExportError("tree root is not a directory")
    pending = [root]
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            if path == root / ".git":
                continue
            name = path.relative_to(root).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                pending.append(path)
            else:
                result[name] = path
    return result


def text_file(path: Path) -> str:
    if not stat.S_ISREG(path.lstat().st_mode) or path.is_symlink():
        raise ExportError("selected path is not a regular file")
    # Strict decoding refuses binary assets instead of silently skipping bytes.
    try:
        value = path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as error:
        raise ExportError(
            "binary content requires a separate asset policy: not UTF-8") from error
    if "\0" in value:
        raise ExportError("binary content requires a separate asset policy")
    return value


def printable(value: str) -> bool:
    """Whether decoded bytes spell text rather than binary a rule could trip on."""
    return bool(value) and all(char.isprintable() or char in "\n\r\t" for char in value)


# The mode a written file takes when its source can be run. A public tree is
# read by whoever clones it, so the group and other bits are set rather than
# copied: what is carried over is the fact that the file is a program, not the
# permissions of the machine it was written on.
EXECUTABLE_MODE = 0o755


def executable(path: Path) -> bool:
    """Whether a source file is one a caller can run.

    The exported tree runs its own suites, and one of them executes a script
    from the tree. A write that drops the executable bit leaves that tree
    failing a check the source tree passes, over a property of the copy rather
    than of the source, and the failure reads as a machine that cannot run the
    script instead of one that was never given permission to.
    """
    return bool(stat.S_IMODE(path.lstat().st_mode) & 0o111)


def decode_run(run: str) -> str:
    """The text a base64-shaped run spells, or nothing when it spells binary."""
    padded = run + "=" * (-len(run) % 4)
    for candidate in (padded, padded.replace("-", "+").replace("_", "/")):
        try:
            raw = base64.b64decode(candidate, validate=True)
        except (binascii.Error, ValueError):
            continue
        if not raw or len(raw) > MAX_DECODED_BYTES:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if printable(text):
            return text
    return ""


def readable_forms(value: str) -> list[str]:
    """Every form a rule must also read: as written, normalized, and decoded.

    A value can be spelled so that the characters a rule looks for are not the
    characters in the file: a zero-width character dropped inside it, letters
    that normalize to ASCII, percent escapes, or base64. Reading only the text as
    written makes every rule in the denylist optional.

    Decoding goes one level deep on purpose. A decoded form is normalized and
    scanned, but not decoded again, so a file cannot turn one rule check into an
    unbounded search.
    """
    forms: list[str] = []

    def add(candidate: str) -> None:
        if not candidate or len(forms) >= MAX_FORMS:
            return
        if candidate not in forms:
            forms.append(candidate)
        normalized = unicodedata.normalize("NFKC", candidate)
        if normalized not in forms and len(forms) < MAX_FORMS:
            forms.append(normalized)

    add(value)
    stripped = value.translate(INVISIBLE)
    add(stripped)
    if PERCENT.search(stripped):
        add(unquote(stripped))
    for form in list(forms):
        for run in list(DECODABLE.finditer(form))[:MAX_DECODED_RUNS]:
            decoded = decode_run(run.group(0))
            if decoded:
                add(decoded)
    return forms


def scan(name: str, value: str, patterns: list[re.Pattern[str]],
         terms: list[str]) -> None:
    forms = readable_forms(name) + readable_forms(value)
    for index, pattern in enumerate(patterns, start=1):
        for form in forms:
            if pattern.search(form):
                # Neither the match nor the path is safe to echo after a leak.
                raise ExportError(f"denylist rule {index} matched an exported path or file")
    # An owner-specific identity is a literal, not a shape, so it is checked the
    # same way and never echoed: naming it in the refusal would publish it.
    for term in terms:
        if any(term in form for form in forms):
            raise ExportError("a private identity term matched an exported path or file")


def identity_terms(source: Path) -> list[str]:
    """Owner-specific strings to refuse, read from a file that is never exported.

    Absent means there are none to check; empty means the same, since a private
    inventory that is not filled in is not a reason to refuse an export.
    """
    path = source / "public-export" / IDENTITY
    if not path.is_file():
        return []
    reject_link_ancestors(path)
    return [term.strip() for term in path.read_text(encoding="utf-8").splitlines()
            if term.strip() and not term.strip().startswith("#")]


def acquire_lock(destination: Path) -> Path:
    """Take the destination for this run, or refuse because another holds it."""
    destination.mkdir(parents=True, exist_ok=True)
    lock = destination / LOCK
    for attempt in range(2):
        try:
            handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            age = time.time() - lock.lstat().st_mtime
            if attempt or age < LOCK_STALE_SECONDS:
                raise ExportError(
                    "another export holds this destination, or one died holding it "
                    f"less than {LOCK_STALE_SECONDS // 60} minutes ago")
            # Abandoned by a run that died: a lock this old is not a live export.
            lock.unlink()
            continue
        os.write(handle, str(os.getpid()).encode())
        os.close(handle)
        return lock
    raise ExportError("another export holds this destination")


def release_lock(lock: Path) -> None:
    try:
        lock.unlink()
    except FileNotFoundError:
        pass


def asset_digest(value: bytes) -> str:
    """What a binary asset is compared by, since its bytes cannot be a diff."""
    return "sha256:" + hashlib.sha256(value).hexdigest()


def prepare(source: Path) -> tuple[dict[str, str], dict[str, bytes],
                                   list[re.Pattern[str]], list[str]]:
    allow = lines(source / "public-export" / "allowlist.txt")
    if any(not safe_name(pattern) for pattern in allow):
        raise ExportError("unsafe allowlist path")
    # A binary file is copied byte for byte, and only where this list names it:
    # the allowlist alone cannot carry it, because a text scan would refuse to
    # decode it.
    asset_list = source / "public-export" / "assets.txt"
    binary = set(lines(asset_list)) if asset_list.is_file() else set()
    for name in binary:
        if not safe_name(name):
            raise ExportError("unsafe asset path")
    patterns = [re.compile(pattern, re.IGNORECASE) for pattern in
                lines(source / "public-export" / "denylist.txt")]
    terms = identity_terms(source)
    candidates = inventory(source)
    selected: dict[str, str] = {}
    assets: dict[str, bytes] = {}
    for pattern in allow:
        matched = [name for name in candidates if fnmatch.fnmatchcase(name, pattern)]
        if not matched:
            raise ExportError("allowlist entry matches no files")
        for name in matched:
            if not safe_name(name):
                raise ExportError("unsafe selected path")
            if name in binary:
                path = candidates[name]
                if not stat.S_ISREG(path.lstat().st_mode) or path.is_symlink():
                    raise ExportError("selected asset is not a regular file")
                value = path.read_bytes()
                # Its name is still read by every rule; only its bytes are not.
                scan(name, "", patterns, terms)
                assets[name] = value
            else:
                value = text_file(candidates[name])
                scan(name, value, patterns, terms)
                selected[name] = value
    listed = set(binary) - set(assets)
    if listed:
        raise ExportError("asset list entry is not allowlisted: " + sorted(listed)[0])
    if not selected and not assets:
        raise ExportError("empty export")
    return dict(sorted(selected.items())), dict(sorted(assets.items())), patterns, terms


def previous_tree(destination: Path, selected: dict[str, str],
                  assets: dict[str, bytes]) -> dict[str, str]:
    candidates = inventory(destination)
    candidates.pop(LOCK, None)
    manifest = candidates.pop(MANIFEST, None)
    old_names: set[str] = set()
    old_assets: set[str] = set()
    if manifest is not None:
        record = json.loads(text_file(manifest))
        if not isinstance(record, dict) or record.get("format") != 1:
            raise ExportError("invalid export manifest")
        names = record.get("files")
        if not isinstance(names, list) or not all(
            isinstance(name, str) and safe_name(name) for name in names
        ):
            raise ExportError("unsafe export manifest")
        old_names = set(names)
        binaries = record.get("assets", [])
        if not isinstance(binaries, list) or not all(
            isinstance(name, str) and safe_name(name) for name in binaries
        ):
            raise ExportError("unsafe export manifest")
        old_assets = set(binaries)
    elif candidates:
        raise ExportError("destination is not empty or exporter-owned")
    if set(candidates) - old_names:
        raise ExportError("destination contains unmanaged files")
    # Reject every output symlink, including directories with no selected child.
    for directory, dirs, _ in os.walk(destination, followlinks=False):
        if Path(directory) == destination:
            dirs[:] = [name for name in dirs if name != ".git"]
        for name in dirs:
            if (Path(directory) / name).is_symlink():
                raise ExportError("symlink in destination")
    previous = {}
    for name, path in candidates.items():
        previous[name] = asset_digest(path.read_bytes()) if name in old_assets \
            else text_file(path)
    for name in list(selected) + list(assets):
        path = destination / name
        reject_link_ancestors(path)
        if path.exists() and not path.is_file():
            raise ExportError("destination path conflicts with a directory")
        for parent in path.parents:
            if parent == destination:
                break
            if parent.exists() and not parent.is_dir():
                raise ExportError("destination parent conflicts with a file")
    return previous


def flags(value: str, patterns: list[re.Pattern[str]], terms: list[str]) -> bool:
    """Whether any rule or identity term reads in the value, however it is spelled."""
    forms = readable_forms(value)
    return (any(pattern.search(form) for pattern in patterns for form in forms)
            or any(term in form for term in terms for form in forms))


def print_plan(selected: dict[str, str], assets: dict[str, bytes],
               previous: dict[str, str],
               patterns: list[re.Pattern[str]], terms: list[str]) -> None:
    print(f"Export files ({len(selected) + len(assets)}):")
    for name in sorted(set(selected) | set(assets)):
        print(name)
    print("Diff:")
    changed = False
    asset_forms = {name: asset_digest(value) for name, value in assets.items()}
    for name in sorted(set(selected) | set(asset_forms) | set(previous)):
        if name in asset_forms:
            old, new = previous.get(name, ""), asset_forms[name]
            if old == new:
                continue
            changed = True
            print(f"Asset {'replaced' if old else 'added'}: "
                  f"{name} ({len(assets[name])} bytes)")
            continue
        old, new = previous.get(name, ""), selected.get(name, "")
        if name in previous and name in selected and old == new:
            continue
        changed = True
        # An earlier public leak must not be echoed as a removed diff line.
        if flags(name, patterns, terms) or flags(old, patterns, terms):
            print("[previous content redacted: denylist match]")
            continue
        before = f"a/{name}" if name in previous else "/dev/null"
        after = f"b/{name}" if name in selected else "/dev/null"
        difference = list(difflib.unified_diff(old.splitlines(), new.splitlines(),
                                             fromfile=before, tofile=after, lineterm=""))
        if difference:
            print("\n".join(difference))
        else:
            print(f"File presence or final newline changed: {name}")
    if not changed:
        print("No changes.")


def export(source: Path, destination: Path, dry_run: bool) -> None:
    reject_link_ancestors(source)
    reject_link_ancestors(destination)
    source, destination = source.resolve(), destination.resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ExportError("source and destination must be separate, non-nested trees")
    selected, assets, patterns, terms = prepare(source)
    previous = previous_tree(destination, selected, assets)
    print_plan(selected, assets, previous, patterns, terms)
    if dry_run:
        return
    # Every policy, byte and destination path is checked before the first write,
    # and the destination is held for the whole write so two runs cannot interleave
    # into one tree.
    lock = acquire_lock(destination)
    try:
        # Only files from a prior export manifest may be removed.
        for name in sorted(set(previous) - set(selected) - set(assets)):
            (destination / name).unlink()
        for name, value in selected.items():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value.encode("utf-8"))
            if executable(source / name):
                path.chmod(EXECUTABLE_MODE)
        for name, value in assets.items():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        # The manifest is written last: a tree without one is not owned by an export.
        manifest = {"format": 1, "files": sorted(set(selected) | set(assets)),
                    "assets": sorted(assets)}
        (destination / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n",
                                           encoding="utf-8")
    finally:
        release_lock(lock)
    print(f"Wrote {len(selected) + len(assets)} files. Git metadata was not changed.")


def main() -> int:
    # The plan is written for a person to read, and a Windows console cannot encode
    # every character a source file may hold. Refusing a safe export because a
    # preview cannot draw a character would be the wrong answer.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        export(args.source.expanduser().absolute(), args.destination.expanduser().absolute(), args.dry_run)
    except (OSError, ValueError, re.error) as error:
        # OS/decoder/regex errors may contain private filenames or source text.
        message = str(error) if isinstance(error, ExportError) else type(error).__name__
        print(f"Export refused: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
