#!/usr/bin/env python3
"""Name the test files a change reaches, one file at a time.

The selection this replaces worked by language lane: any Python change ran the
whole Python suite, and a change of one test file and a README ran more than a
thousand tests. This reads the repository's own sources instead and answers
with the test files a change can reach, and with a whole layer only when a
changed file reaches no test at all or changes how every test runs, naming the
file that forced it.

A test file is reached by a changed file when:

  - it is the changed file;
  - it imports the changed file, directly or through any module it imports:
    the suite helpers under tests/, the plugin's packages reached as
    `config.*` and `readers.*`, and a script the test loads by its path;
  - the changed file's repository path, or its trailing part down to the bare
    file name, is written as a string or a path expression in the test or in
    any module it reaches (suites read files by path: a README, the hooks
    module, the schema, the mutant list, the export allowlist, a script as
    `ROOT / "scripts" / "host-drift.py"`);
  - the test, or a module it reaches, walks a folder of this repository that
    holds the changed file (`PLUGIN.rglob`, `FIXTURES.iterdir`, a copytree).
    A walk of the repository root is not counted: it would reach every file,
    and the one suite that does it is the export suite, which the export rule
    in the impact plan names by itself.

Docstrings and comments are prose and name nothing. The TypeScript suites under
components/ and config/ are read the same way, from their relative imports and
their path strings. A Python module a suite starts by path is followed as an
import, and so is a TypeScript module a Python test names, so a chain that
crosses the two languages is still one chain.

Three things widen the selection, each named in the output with its file:

  - the harness: a helper under tests/ that is not a test, the Python runner,
    the root Makefile, a make fragment and the impact selection itself change
    how every Python test runs, so they select the whole Python suite;
  - a changed file no test reaches falls back: a TypeScript module to every
    TypeScript suite, anything else to the whole Python suite;
  - documentation never falls back: a Markdown file outside the plugin folder,
    and a path .test-impact.json lists as not code, selects the tests that read
    it and nothing more.

A deleted file that nothing still names selects nothing, since nothing left can
load it.

    python3 scripts/test-select.py tests/test_host_drift.py README.md
    git diff --name-only origin/main | python3 scripts/test-select.py

Output, one line each, in this order:

    python-test <tests/test_x.py>     a Python test file to run
    python-all <path>                 the whole Python suite; <path> forced it
    ts-suite <components/x.test.ts>   a TypeScript suite to run
    ts-all <path>                     every TypeScript suite; <path> forced it
    host-kit <path>                   a suite only the host's test kit can run
    docs <path>                       documentation no test reads

Exit: 0 with a selection (which may be empty), 2 when the root is unreadable.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath


# Folders that hold no source of this repository: other checkouts, caches and
# installed dependencies. A worktree under .claude/ is a whole second copy of
# every file, and reading it would make each test reach its own twin.
SKIP_DIRECTORIES = frozenset({
    ".git", ".claude", "node_modules", "__pycache__", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
})
PLUGIN_ROOT = "plugins/llm-fleet"
HOST_KIT = PLUGIN_ROOT + "/tests/"
PYTHON_TESTS = re.compile(r"^tests/test_[A-Za-z0-9_]+\.py$")
TS_SUITES = re.compile(r"^(?:components|config)/[A-Za-z0-9_.-]+\.test\.ts$")
# What runs every Python test: a change here reaches all of them whether or not
# a test names it.
HARNESS = re.compile(r"^(?:tests/(?!test_)[^/]+\.py|scripts/test-report\.py|Makefile"
                     r"|make/[^/]+\.mk|\.cits/[^/]+)$")
# What starts every TypeScript suite: a change here reaches all of them.
TS_HARNESS = re.compile(r"^scripts/typescript-suite\.py$")
TS_SOURCE = (".ts", ".tsx", ".mts")
DECLARATION = ".d.ts"
DOCS_NAMES = frozenset({"HANDOFF.md", "TODO.md", "SNAPSHOT.md", "PROJECT_CONTEXT.md"})
DOTTED_MODULE = re.compile(r"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$")
SCAN_METHODS = frozenset({"rglob", "glob", "iterdir", "walk"})
SCAN_FUNCTIONS = frozenset({"os.walk", "os.listdir", "os.scandir", "shutil.copytree"})
UNSAFE_IN_PATH = frozenset(" \t\n*?$<>|{}()[]:;,=\"'`")

TS_IMPORT = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']""")
TS_WALK = re.compile(r"\b(?:readdirSync|readdir|opendirSync|opendir|cpSync|globSync)\b")


@dataclass
class Module:
    """What one source file says about the files it reaches."""

    path: str
    edges: set[str] = field(default_factory=set)
    # Paths written out in full, present or not: a deleted file is still found
    # by the module that names it.
    named: set[str] = field(default_factory=set)
    # Partial paths, matched against the end of a changed path.
    literals: set[str] = field(default_factory=set)
    # Folders this module walks; every file under one is reached.
    walked: set[str] = field(default_factory=set)


def normal(text: str) -> str | None:
    """A repository-relative path in one spelling, or None when it climbs out."""
    parts: list[str] = []
    for part in text.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def literal_form(text: str) -> str | None:
    """A string as a partial path, or None when it cannot name a file."""
    if not text or len(text) > 200 or any(character in UNSAFE_IN_PATH for character in text):
        return None
    stripped = text.replace("\\", "/")
    while stripped.startswith("./") or stripped.startswith("../"):
        stripped = stripped.split("/", 1)[1]
    stripped = stripped.strip("/")
    if not stripped or stripped in (".", ".."):
        return None
    return stripped


def suffix_match(changed: str, literal: str) -> bool:
    return changed == literal or changed.endswith("/" + literal)


def folder_of(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


class Repository:
    """Every source file under the root, read once."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.helper_constants: dict[str, dict[str, tuple[str, str]]] = {}
        self.files: set[str] = set()
        self.directories: set[str] = {""}
        for directory, subdirectories, names in os.walk(root):
            subdirectories[:] = sorted(name for name in subdirectories
                                       if name not in SKIP_DIRECTORIES)
            relative = Path(directory).relative_to(root).as_posix()
            relative = "" if relative == "." else relative
            for name in subdirectories:
                self.directories.add(f"{relative}/{name}" if relative else name)
            for name in names:
                self.files.add(f"{relative}/{name}" if relative else name)
        self.by_name: dict[str, list[str]] = {}
        for path in self.files:
            self.by_name.setdefault(PurePosixPath(path).name, []).append(path)
        self.modules: dict[str, Module] = {}
        for path in sorted(self.files):
            if path.endswith(".py"):
                self.modules[path] = PythonReader(self, path).read()
            elif path.endswith(TS_SOURCE) and not path.endswith(DECLARATION):
                self.modules[path] = read_typescript(self, path)
        for module in self.modules.values():
            self.link(module)

    def present(self, path: str) -> bool:
        return path in self.files

    def named_by(self, literal: str) -> list[str]:
        """The files whose path ends with this partial path."""
        name = literal.rsplit("/", 1)[-1]
        return [path for path in self.by_name.get(name, ()) if suffix_match(path, literal)]

    def link(self, module: Module) -> None:
        """Turn every name that points at a present file into an edge."""
        for literal in module.literals:
            module.edges.update(self.named_by(literal))
        module.edges.update(path for path in module.named if path in self.files)
        module.edges.discard(module.path)


# --- Python ------------------------------------------------------------------

class PythonReader:
    """The imports, path expressions and walks in one Python module."""

    def __init__(self, repository: Repository, path: str) -> None:
        self.repository = repository
        self.path = path
        self.module = Module(path)
        self.constants: dict[str, tuple[str, str]] = {}
        self.aliases: dict[str, str] = {}

    def parse(self, path: str) -> ast.Module | None:
        try:
            source = (self.repository.root / path).read_text(encoding="utf-8")
            return ast.parse(source, filename=path)
        except (OSError, SyntaxError, UnicodeDecodeError, ValueError):
            return None

    def read(self) -> Module:
        tree = self.parse(self.path)
        if tree is None:
            # A module that cannot be parsed is still a file: it is found by
            # name, and its own reach is unknown rather than invented.
            return self.module
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.read_import(node)
            elif isinstance(node, ast.ImportFrom):
                self.read_from(node)
        self.read_constants(tree)
        # A string standing alone as a statement is a docstring or a note. It
        # names files in prose, and a test that mentions a script in its
        # docstring does not run it.
        skipped = {id(node.value) for node in ast.walk(tree)
                   if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)}
        # A part of a path this reader anchored is read as that whole path, not
        # again on its own: `PLUGIN / "README.md"` names the plugin's README,
        # and the bare "README.md" would also name every other one.
        for node in ast.walk(tree):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
                value = self.evaluate(node)
                self.add_value(value)
                if value is not None and value[0] == "abs":
                    skipped.update(id(part) for part in ast.walk(node)
                                   if isinstance(part, ast.Constant))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) not in skipped:
                    self.add_string(node.value)
            elif isinstance(node, ast.Call):
                self.read_call(node)
        return self.module

    def folder(self) -> str:
        return folder_of(self.path)

    def search_roots(self) -> list[str]:
        """Where an absolute import is looked for: beside the module, the suite
        folder the test runner puts first, and the plugin root every suite and
        every plugin module imports from."""
        return list(dict.fromkeys([self.folder(), "tests", PLUGIN_ROOT]))

    def as_module(self, stem: str) -> str | None:
        if not stem:
            return None
        for candidate in (stem + ".py", stem + "/__init__.py"):
            if self.repository.present(candidate):
                return candidate
        return None

    def resolve_module(self, dotted: str) -> str | None:
        relative = dotted.replace(".", "/")
        for root in self.search_roots():
            found = self.as_module(f"{root}/{relative}" if root else relative)
            if found:
                return found
        return None

    def read_import(self, node: ast.Import) -> None:
        for alias in node.names:
            target = self.resolve_module(alias.name)
            if target:
                self.module.edges.add(target)
                self.aliases[alias.asname or alias.name.split(".")[0]] = target
            else:
                self.module.literals.add(alias.name.replace(".", "/") + ".py")

    def read_from(self, node: ast.ImportFrom) -> None:
        base = (node.module or "").replace(".", "/")
        if node.level:
            # `from . import x` and `from .pkg import y`: looked for in the
            # package this module sits in, or one above it per extra dot.
            package = self.folder()
            for _ in range(node.level - 1):
                package = folder_of(package)
            stem = normal("/".join(part for part in (package, base) if part)) or ""
            roots = [stem]
            resolved = self.as_module(stem) if base else None
        else:
            roots = ["/".join(part for part in (root, base) if part)
                     for root in self.search_roots()]
            resolved = self.resolve_module(node.module) if node.module else None
            if node.module and not resolved:
                self.module.literals.add(base + ".py")
        if resolved:
            self.module.edges.add(resolved)
        for alias in node.names:
            if alias.name == "*":
                continue
            submodule = None
            for root in roots:
                submodule = self.as_module(f"{root}/{alias.name}" if root else alias.name)
                if submodule:
                    break
            if submodule:
                self.module.edges.add(submodule)
            else:
                # Not found as a file: an attribute of the package, or a module
                # this change deletes. The path it would have is kept, so the
                # deletion still selects the test that imports it.
                stem = roots[0] if node.level else base
                self.module.literals.add(f"{stem}/{alias.name}.py" if stem else f"{alias.name}.py")
            target = submodule or resolved
            if target:
                self.aliases[alias.asname or alias.name] = target

    def read_constants(self, tree: ast.Module) -> None:
        """Module-level names bound to a path, so a walk inside a function sees them."""
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                    and isinstance(node.targets[0], ast.Name):
                value = self.evaluate(node.value)
                if value is not None:
                    self.constants[node.targets[0].id] = value

    # --- path expressions -----------------------------------------------------
    # A value is ("abs", repository path) when the expression is anchored to
    # this file's location, or ("rel", partial path) when it is a path written
    # from somewhere this reader cannot see.
    def evaluate(self, node: ast.AST) -> tuple[str, str] | None:
        if isinstance(node, ast.Name):
            if node.id == "__file__":
                return ("abs", self.path)
            if node.id in self.constants:
                return self.constants[node.id]
            target = self.aliases.get(node.id)
            return None if target is None else self.foreign_constant(target, node.id)
        if isinstance(node, ast.Attribute):
            if node.attr == "parent":
                return self.up(self.evaluate(node.value), 1)
            if isinstance(node.value, ast.Name) and node.value.id in self.aliases:
                return self.foreign_constant(self.aliases[node.value.id], node.attr)
            return None
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) \
                and node.value.attr == "parents" and isinstance(node.slice, ast.Constant) \
                and isinstance(node.slice.value, int):
            return self.up(self.evaluate(node.value.value), node.slice.value + 1)
        if isinstance(node, ast.Call):
            return self.evaluate_call(node)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            right = node.right
            if not (isinstance(right, ast.Constant) and isinstance(right.value, str)):
                return None
            left = self.evaluate(node.left)
            if left is None:
                form = literal_form(right.value)
                return ("rel", form) if form else None
            kind, base = left
            joined = normal(f"{base}/{right.value}" if base else right.value)
            return None if joined is None else (kind, joined)
        return None

    def evaluate_call(self, node: ast.Call) -> tuple[str, str] | None:
        function = node.func
        if isinstance(function, ast.Attribute) and function.attr in ("resolve", "absolute") \
                and not node.args:
            return self.evaluate(function.value)
        if isinstance(function, ast.Name) and function.id in ("Path", "PurePath",
                                                               "PurePosixPath") \
                and len(node.args) == 1:
            argument = node.args[0]
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                form = literal_form(argument.value)
                return ("rel", form) if form else None
            return self.evaluate(argument)
        return None

    def up(self, value: tuple[str, str] | None, levels: int) -> tuple[str, str] | None:
        if value is None or value[0] != "abs":
            return None
        current = value[1]
        for _ in range(levels):
            if current == "":
                return None
            current = folder_of(current)
        return ("abs", current)

    def foreign_constant(self, module_path: str, name: str) -> tuple[str, str] | None:
        # A name imported from a helper (`from paths import PLUGIN`) or read off
        # it (`paths.PLUGIN`) carries the helper's own value. Only module-level
        # names are read there, and each helper is read once.
        cache = self.repository.helper_constants
        if module_path not in cache:
            cache[module_path] = {}
            reader = PythonReader(self.repository, module_path)
            tree = reader.parse(module_path)
            if tree is not None:
                for node in tree.body:
                    if isinstance(node, ast.ImportFrom):
                        reader.read_from(node)
                    elif isinstance(node, ast.Import):
                        reader.read_import(node)
                reader.read_constants(tree)
                cache[module_path] = dict(reader.constants)
        return cache[module_path].get(name)

    # --- what a module names --------------------------------------------------
    def add_string(self, text: str) -> None:
        if DOTTED_MODULE.match(text):
            target = self.resolve_module(text)
            if target:
                self.module.edges.add(target)
        form = literal_form(text)
        if form:
            self.module.literals.add(form)

    def add_value(self, value: tuple[str, str] | None) -> None:
        if value is None or not value[1]:
            return
        kind, path = value
        if kind == "abs":
            self.module.named.add(path)
        else:
            self.module.literals.add(path)

    def read_call(self, node: ast.Call) -> None:
        function = node.func
        walked = None
        if isinstance(function, ast.Attribute) and function.attr in SCAN_METHODS:
            walked = self.evaluate(function.value)
        elif dotted_name(function) in SCAN_FUNCTIONS and node.args:
            walked = self.evaluate(node.args[0])
        if walked is not None and walked[0] == "abs" and walked[1]:
            self.module.walked.add(walked[1])


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        inner = dotted_name(node.value)
        return f"{inner}.{node.attr}" if inner else ""
    return ""


# --- TypeScript --------------------------------------------------------------

def typescript_strings(source: str) -> tuple[str, list[str]]:
    """The source with its comments blanked, and every string literal in it.

    Read character by character, because a comment can hold a quote and a
    string can hold two slashes: a URL in a string is not a comment, and a
    path named in a comment is not a file the module reads.
    """
    code: list[str] = []
    strings: list[str] = []
    index = 0
    length = len(source)
    while index < length:
        character = source[index]
        pair = source[index:index + 2]
        if pair == "//":
            end = source.find("\n", index)
            index = length if end < 0 else end
            continue
        if pair == "/*":
            end = source.find("*/", index + 2)
            index = length if end < 0 else end + 2
            code.append(" ")
            continue
        if character in "\"'`":
            closing = index + 1
            text: list[str] = []
            interpolated = False
            while closing < length and source[closing] != character:
                if source[closing] == "\\" and closing + 1 < length:
                    text.append(source[closing + 1])
                    closing += 2
                    continue
                if character == "`" and source[closing:closing + 2] == "${":
                    interpolated = True
                if character != "`" and source[closing] == "\n":
                    break
                text.append(source[closing])
                closing += 1
            if not interpolated:
                strings.append("".join(text))
            code.append(source[index:closing + 1])
            index = closing + 1
            continue
        code.append(character)
        index += 1
    return "".join(code), strings


def read_typescript(repository: Repository, path: str) -> Module:
    module = Module(path)
    try:
        source = (repository.root / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return module
    here = folder_of(path)
    code, strings = typescript_strings(source)
    walks = bool(TS_WALK.search(code))

    def relative(specifier: str) -> str | None:
        return normal(f"{here}/{specifier}" if here else specifier)

    for match in TS_IMPORT.finditer(code):
        specifier = match.group(1)
        if not specifier.startswith("."):
            continue
        target = relative(specifier)
        if target is None:
            continue
        found = next((candidate for candidate in
                      (target, target + ".ts", target + ".tsx", target + "/index.ts")
                      if repository.present(candidate)), None)
        if found:
            module.edges.add(found)
        else:
            module.named.add(target)
    for text in strings:
        if text.startswith("./") or text.startswith("../"):
            target = relative(text)
            if target is None:
                continue
            if target in repository.directories:
                if walks and target:
                    module.walked.add(target)
            else:
                module.named.add(target)
            continue
        form = literal_form(text)
        if form:
            module.literals.add(form)
    return module


# --- the selection -----------------------------------------------------------

@dataclass
class Selection:
    python: list[str] = field(default_factory=list)
    python_all: list[str] = field(default_factory=list)
    typescript: list[str] = field(default_factory=list)
    typescript_all: list[str] = field(default_factory=list)
    host_kit: list[str] = field(default_factory=list)
    docs: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"python-test {path}" for path in self.python]
        out += [f"python-all {path}" for path in self.python_all]
        out += [f"ts-suite {path}" for path in self.typescript]
        out += [f"ts-all {path}" for path in self.typescript_all]
        out += [f"host-kit {path}" for path in self.host_kit]
        out += [f"docs {path}" for path in self.docs]
        return out


def non_code_paths(root: Path) -> set[str]:
    """Paths the repository's own impact declaration lists as not code."""
    try:
        declared = json.loads((root / ".test-impact.json").read_text(encoding="utf-8"))
        listed = declared.get("nonCodePaths", [])
    except (OSError, ValueError, AttributeError):
        return set()
    return {normal(path) or "" for path in listed if isinstance(path, str)}


def is_docs(path: str, declared: set[str]) -> bool:
    if path in declared or path in DOCS_NAMES:
        return True
    return path.endswith(".md") and not path.startswith("plugins/")


def is_typescript(path: str) -> bool:
    return path.endswith(TS_SOURCE) and not path.endswith(DECLARATION)


class Reach:
    """Which files each test reaches, computed once per test."""

    def __init__(self, repository: Repository) -> None:
        self.repository = repository
        self.cache: dict[str, tuple[set[str], set[str], set[str], set[str]]] = {}

    def of(self, test: str) -> tuple[set[str], set[str], set[str], set[str]]:
        if test not in self.cache:
            seen: set[str] = set()
            named: set[str] = set()
            literals: set[str] = set()
            walked: set[str] = set()
            pending = [test]
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                module = self.repository.modules.get(current)
                if module is None:
                    continue
                named |= module.named
                literals |= module.literals
                walked |= module.walked
                pending.extend(module.edges - seen)
            self.cache[test] = (seen, named, literals, walked)
        return self.cache[test]

    def reaches(self, test: str, changed: str) -> bool:
        seen, named, literals, walked = self.of(test)
        if changed in seen or changed in named:
            return True
        if any(suffix_match(changed, literal) for literal in literals):
            return True
        return any(changed.startswith(folder + "/") for folder in walked)


def select(root: Path, changed: list[str]) -> Selection:
    repository = Repository(root)
    reach = Reach(repository)
    declared = non_code_paths(root)
    python_tests = sorted(path for path in repository.files if PYTHON_TESTS.match(path))
    suites = sorted(path for path in repository.files if TS_SUITES.match(path))
    selection = Selection()
    chosen_python: set[str] = set()
    chosen_suites: set[str] = set()
    for path in dict.fromkeys(normal(raw.strip()) for raw in changed):
        if not path:
            continue
        python_hits = {test for test in python_tests if reach.reaches(test, path)}
        suite_hits = {suite for suite in suites if reach.reaches(suite, path)}
        chosen_python |= python_hits
        chosen_suites |= suite_hits
        if path.startswith(HOST_KIT):
            selection.host_kit.append(path)
        elif is_docs(path, declared):
            if not python_hits and not suite_hits:
                selection.docs.append(path)
        elif HARNESS.match(path):
            selection.python_all.append(path)
        elif TS_HARNESS.match(path):
            selection.typescript_all.append(path)
        elif not repository.present(path):
            # Deleted: whoever still names it is selected above, and a file
            # nothing names is a file nothing left can load.
            continue
        elif is_typescript(path):
            if not suite_hits:
                selection.typescript_all.append(path)
        elif not python_hits and not suite_hits:
            selection.python_all.append(path)
    selection.python = sorted(chosen_python)
    selection.typescript = sorted(chosen_suites)
    return selection


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Name the test files a change reaches, one file at a time.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]),
                        help="the repository to read (default: this one)")
    parser.add_argument("paths", nargs="*",
                        help="changed paths, relative to the root; read from stdin when none")
    args = parser.parse_args(argv)
    root = Path(args.root)
    if not root.is_dir():
        print(f"test-select: {root} is not a directory", file=sys.stderr)
        return 2
    changed = args.paths if args.paths else sys.stdin.read().splitlines()
    # One newline per line on every platform: the plan reads this through a
    # POSIX shell, and a carriage return left on a name makes a file that is
    # there read as one that is not.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(newline="\n")
    sys.stdout.write("".join(line + "\n" for line in select(root, changed).lines()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
