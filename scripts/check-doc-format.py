#!/usr/bin/env python3
"""Check instruction paragraphs, punctuation, and the root Makefile boundary."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys


LLM_FILES = frozenset({"AGENTS.md", "PROJECT_CONTEXT.md", "TODO.md", "SNAPSHOT.md", "HANDOFF.md"})
MAX_PARAGRAPH_LINES = 3
BANNED_PUNCTUATION = tuple(chr(code).encode("utf-8") for code in
                           (0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D))
# Characters that are invisible or reorder text rather than spell it. They hide a
# value from a reader and from a rule that reads the file as written, and a
# console that cannot encode one refuses whatever step tried to print it.
INVISIBLE_CODES = (0x00AD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
                   0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060,
                   0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF)
# Only metadata and generated dependency/cache trees are outside source scope.
EXCLUDED_DIRS = frozenset({".git", ".state", "__pycache__", ".venv", "venv",
                           "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache",
                           # Scaffolded by the host engine; never this repository's source.
                           ".claude-plugin"})
# Formats whose bytes are not text: images, fonts, archives and documents.
BINARY_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns",
                             ".pdf", ".ttf", ".otf", ".woff", ".woff2", ".zip", ".gz"})
ASSIGNMENT = re.compile(r"^[^:=]+?(?:::?=|:=|[?+!]?=)")
STRUCTURAL = re.compile(r"^(?:#{1,6}\s|\||[-*+]\s|\d+[.)]\s)")


def paragraph_errors(value: str) -> list[tuple[int, str]]:
    errors = []
    count = 0
    fence = ""
    for number, line in enumerate(value.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            if not fence:
                fence = marker
            elif marker == fence:
                fence = ""
            count = 0
        elif fence or not stripped or STRUCTURAL.match(stripped):
            count = 0
        else:
            count += 1
            if count == MAX_PARAGRAPH_LINES + 1:
                errors.append((number - count + 1, "FMT-1 paragraph exceeds three lines"))
    return errors


def makefile_errors(value: str) -> list[tuple[int, str]]:
    errors = []
    pending = ""
    start = 0
    recipe_allowed = False
    for number, line in enumerate(value.splitlines(), 1):
        if line.startswith("\t"):
            if not recipe_allowed:
                errors.append((number, "FMT-3 recipe outside help"))
            continue
        stripped = line.split("#", 1)[0].strip()
        if not stripped:
            continue
        if not pending:
            start = number
        pending += stripped.rstrip("\\") + " "
        if stripped.endswith("\\"):
            continue
        logical = pending.strip()
        pending = ""
        if ASSIGNMENT.match(logical):
            continue
        if ":" not in logical:
            continue
        targets = logical.split(":", 1)[0].split()
        recipe_allowed = targets == ["help"]
        if not recipe_allowed and targets != [".PHONY"]:
            errors.append((start, "FMT-3 root target must live in make/"))
        elif targets == [".PHONY"] and ";" in logical:
            errors.append((start, "FMT-3 recipe outside help"))
    return errors


def check(root: Path) -> tuple[int, list[str]]:
    errors = []
    files = 0
    if not root.is_dir():
        return 0, ["FMT-0 root is not a directory"]
    pending = [root]
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            name = path.relative_to(root).as_posix()
            if path.name == ".git" or (path.is_dir() and path.name in EXCLUDED_DIRS):
                continue
            if path.is_symlink() or (not path.is_dir() and not path.is_file()):
                errors.append(f"{name}: FMT-0 source must be a regular file or directory")
                continue
            if path.is_dir():
                pending.append(path)
                continue
            # An image or a font is not source. Read as UTF-8 its bytes turn into
            # the very punctuation this rule bans, so the check would refuse an
            # asset it has nothing to say about.
            if path.suffix.lower() in BINARY_SUFFIXES:
                continue
            data = path.read_bytes()
            files += 1
            for number, line in enumerate(data.split(b"\n"), 1):
                if any(mark in line for mark in BANNED_PUNCTUATION):
                    errors.append(f"{name}:{number}: FMT-2 forbidden punctuation")
                if any(chr(code) in line.decode("utf-8", errors="ignore")
                       for code in INVISIBLE_CODES):
                    errors.append(f"{name}:{number}: FMT-2 invisible character")
            if path.name in LLM_FILES:
                for number, message in paragraph_errors(data.decode("utf-8")):
                    errors.append(f"{name}:{number}: {message}")
            if name == "Makefile":
                for number, message in makefile_errors(data.decode("utf-8")):
                    errors.append(f"{name}:{number}: {message}")
    if files == 0:
        errors.append("FMT-0 empty source scope")
    return files, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        files, errors = check(args.root)
    except (OSError, UnicodeError) as error:
        print(f"FMT-0 unable to read source: {type(error).__name__}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Doc format passed: {files} files checked; 0 violations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
