#!/usr/bin/env python3
"""Check the declared primitive subset against the engine's own declaration.

This repository declares the Box, Text and Button props the shared layout writes, in
`plugins/llm-fleet/components/host.ts`, rather than copying the engine's generated declaration into
the published tree. That keeps the published surface small and readable, and it
leaves one risk: the engine could rename or drop a prop, and a layout that still
compiles here would stop rendering there.

This check is the answer to that risk. The host scaffolds its own generated
declaration into a plugin folder when it loads the plugin, and the check reads
that file by default, so the subset is measured against the engine's declaration
rather than against a stand-in this repository maintains. A declaration this
repository committed is refused, because a branch can change such a file in the
same commit that changes the subset, and a check that reads it is the check
agreeing with the change instead of checking it.

Without a declaration anywhere the check reports itself unavailable rather than
passing quietly. A caller that has to run where no engine exists, which is what
CI is, asks for that report with `--allow-unavailable` and reads it in the log.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PRIMITIVES = ROOT / "plugins" / "llm-fleet" / "components" / "host.ts"
# Where the engine writes its own declaration for a plugin it has loaded. The
# file is the engine's, is written inside the plugin folder, and is ignored by
# git, which is what keeps it out of reach of the branch that declares the
# subset.
ENGINE_DECLARATIONS = (
    "plugins/llm-fleet/.claude-plugin/types/claude-code/index.d.ts",
)
# Properties are read from the whole block, nested object types included: a name
# the engine carries that this repository does not use is fine, and the check
# only fails in the other direction.
PROPERTY = re.compile(r"^\s*(?P<name>[A-Za-z][A-Za-z0-9]*)\??\s*:", re.MULTILINE)
# The colors this repository writes are theme keys, never raw values: a key the
# engine does not carry follows no theme, and one the engine drops renders as
# whatever the terminal makes of the word.
COLORS = re.compile(r"^\s*export type (?P<name>Color|ThemeKey)\s*=\s*(?P<body>[^;]+);", re.MULTILINE)
LITERAL = re.compile(r"[\"'](?P<value>[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)*)[\"']")


def color_keys(text: str, name: str = "Color") -> set[str]:
    """Every color named by the union this file declares under that name."""
    for match in COLORS.finditer(text):
        if match.group("name") == name:
            return {entry.group("value") for entry in LITERAL.finditer(match.group("body"))}
    return set()


def block_bodies(text: str, name: str) -> list[str]:
    """The body of every block the file declares under this name.

    Braces are counted rather than matched by a pattern, because a property type
    may itself be written with braces and a pattern would end the block early.
    """
    opener = re.compile(r"(?:export\s+)?(?:interface|type)\s+" + re.escape(name) + r"\b[^{]*\{")
    bodies: list[str] = []
    for match in opener.finditer(text):
        start = match.end() - 1
        depth = 0
        for index in range(start, len(text)):
            character = text[index]
            if character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
                if depth == 0:
                    bodies.append(text[start + 1:index])
                    break
    return bodies


def declared_props(text: str, name: str) -> set[str]:
    """Every property name declared under this type name in this file."""
    names: set[str] = set()
    for body in block_bodies(text, name):
        names.update(entry.group("name") for entry in PROPERTY.finditer(body))
    return names


def engine_declaration() -> Path | None:
    """The engine's own declaration, when the engine has scaffolded one here.

    A plugin folder holds no declaration until the host loads the plugin, so a
    fresh clone and a CI runner both find nothing and the check says so.
    """
    for relative in ENGINE_DECLARATIONS:
        candidate = ROOT / relative
        if candidate.is_file():
            return candidate
    return None


def committed_by_git(path: Path) -> bool:
    """Whether a commit of this repository carries this file.

    The unresolved path is what git is asked about. Resolving it first would
    follow a symbolic link out of the repository and answer about whatever it
    points at, and a link committed at the engine's own path is the branch's file
    like any other.

    Git answering nothing, which is what a tree carrying no repository at all
    does, counts as not committed: a tree delivered without one, a downloaded
    archive or a written export, holds nothing a branch committed, so there is
    nothing there for this check to protect.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(path.parent), "ls-files", "--error-unmatch", "--",
             os.path.abspath(path)],
            capture_output=True, check=False)
    except OSError:
        return False
    return result.returncode == 0


def committed_here(declaration: Path) -> bool:
    """Whether the declaration is one this repository committed itself.

    A checkout of a commit holds nothing else, so a declaration git lists is one
    the branch declaring the subset can change in the same commit, and a check
    reading it can only agree with whatever the branch wrote. The engine's
    declaration is scaffolded into the plugin folder after the checkout, so git
    does not list it, and a declaration this repository committed is never read
    as the engine's word.
    """
    return committed_by_git(declaration)


def display(declaration: Path) -> str:
    """How to name the declaration in a result, from wherever a caller can read it."""
    try:
        return str(declaration.resolve().relative_to(ROOT.resolve()))
    except ValueError:
        return str(declaration)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--declaration", default="",
                        help="path to the engine's generated declaration; the one the "
                             "engine scaffolded into the plugin folder is used when this "
                             "is empty")
    parser.add_argument("--primitives", default=str(PRIMITIVES))
    parser.add_argument("--allow-unavailable", action="store_true",
                        help="report an absent declaration and exit zero, for a caller that "
                             "runs where no engine exists")
    args = parser.parse_args()
    declaration = Path(args.declaration) if args.declaration else engine_declaration()
    if declaration is None:
        print("Unavailable: no engine declaration is present. The host scaffolds one into the "
              "plugin folder when it loads this plugin, so load it, or set HOST_DECLARATION to "
              "the generated declaration of the engine this layout binds to. The subset was not "
              "checked against an engine.", file=sys.stderr)
        return 0 if args.allow_unavailable else 2
    if not declaration.is_file():
        print("Unavailable: {0} is not present.".format(declaration), file=sys.stderr)
        return 2
    if committed_here(declaration):
        print("Refused: {0} is committed to this repository, so the declaration the subset is "
              "checked against is one a branch can change alongside it. Read the engine's own "
              "declaration instead: the host scaffolds it into the plugin folder after the "
              "checkout, where no commit carries it.".format(display(declaration)), file=sys.stderr)
        return 1
    mine_text = Path(args.primitives).read_text(encoding="utf-8")
    engine_text = declaration.read_text(encoding="utf-8", errors="replace")
    missing: list[str] = []
    total = 0
    colors = color_keys(mine_text)
    engine_colors = color_keys(engine_text, "ThemeKey")
    if not colors:
        print("Refused: {0} declares no color.".format(args.primitives), file=sys.stderr)
        return 1
    if not engine_colors:
        print("Refused: {0} declares no theme key.".format(display(declaration)), file=sys.stderr)
        return 1
    for color in sorted(colors - engine_colors):
        missing.append("color {0} (the engine carries no such theme key)".format(color))
    total += len(colors)
    # The three elements are required. The two hover types, the vector leaf, the
    # link and the field are checked when the subset declares them: a hover prop the engine renamed is a
    # tree the surface refuses whole, which is a blank pane rather than a card that
    # does not light, and so is an Svg missing a prop the engine requires.
    optional = ("BoxHoverProps", "TextHoverProps", "SvgProps", "LinkProps", "InputProps")
    for name in ("BoxProps", "TextProps", "ButtonProps") + optional:
        props = declared_props(mine_text, name)
        if not props:
            if name in optional:
                continue
            print("Refused: {0} declares no {1}.".format(args.primitives, name), file=sys.stderr)
            return 1
        total += len(props)
        engine = declared_props(engine_text, name)
        if not engine:
            missing.append("{0} (the engine declares no such type)".format(name))
            continue
        for prop in sorted(props - engine):
            missing.append("{0}.{1}".format(name, prop))
    if missing:
        print("Refused: the engine declaration {0} no longer carries:".format(
            display(declaration)), file=sys.stderr)
        for entry in missing:
            print("  " + entry, file=sys.stderr)
        return 1
    print("Declared primitive subset is present in {0}: {1} props and {2} colors checked.".format(
        display(declaration), total - len(colors), len(colors)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
