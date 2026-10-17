#!/usr/bin/env python3
"""Refuse a plugin module the host cannot evaluate, or an install cannot run.

The host loads a plugin as a folder. Two rules follow from that, and both fail
in the same quiet way: a surface that never appears.

The first is that the folder is the boundary. The host compiles the modules
under it and refuses an import that reaches past it, so a layout kept one level
up, in a shared directory beside the plugin, reads as ordinary modular source
here and is refused there.

The second is that the host evaluates those modules in a sandbox with no node
globals: reading a process's arguments or standard input is not something a
loaded module can do, and such a module throws while it is being loaded. Work
that belongs to a command line - printing the pane for review, drawing the
statusline from a payload on standard input - therefore lives outside the
plugin, and the host's own `$.process.run` is how a loaded module starts a
process.

Every TypeScript module under each plugin folder is read. A relative import that
resolves outside the folder is refused, and so is a node built-in import or a
node global. A bare specifier naming a module the host provides, such as the
engine's own API, is left alone. The plugin names the Python scripts it starts
in one module, `components/entries.ts`, which also builds the command; a script
name or a Python interpreter anywhere else in a module the host loads is refused,
so every spawn goes through the table the standalone proof runs. A host-kit
suite may name the scripts it answers for.

The Python modules under the folder are what the plugin starts, and an install
copies the folder and nothing beside it. Each is read from its syntax tree:

- every import, at any depth, names the standard library or one of the plugin's
  own top-level packages; a relative import stays inside the plugin;
- only `readers/plugin_root.py` touches the import path: `sys.path`,
  `importlib`, `__import__` and `runpy` are refused elsewhere through whatever
  name an import or a plain assignment gives them;
- a path that comes from `__file__` climbs one level at most, counted along one
  expression chain and through the names assigned from it, each read at the
  height it holds where it is used, in its own function's scope; the helper
  climbs to the plugin root and no further; a path that does not come from the
  file, such as a configured directory, may climb as it likes;
- a `..` path segment in a string, or `os.pardir`, is refused.

This is defense in depth. The standalone proof, which runs every entry from a
lone copy of the folder, is the gate.

Run it with the plugin tree to read, defaulting to `plugins/` in this repository.
It exits 1 on a violation, 2 when there was nothing to check.
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
MANIFEST = Path(".claude-plugin") / "plugin.json"
# One pattern covers a static import, a bare side-effect import and a dynamic
# import, because each is written as a quoted specifier in the same line.
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*["'](?P<spec>[^"']+)["']""")
# A node global used as such, so `$.process.run`, a property named `process`,
# and an engine event named in quotes, such as "process.run", are not mistaken
# for one.
GLOBAL = re.compile(r"(?<![\w$.\"'`])(?P<name>process\s*\.|Buffer\b|require\s*\()")
# Generated into the folder by the host, never written by hand.
GENERATED = ".claude-plugin"
# The one module that names the Python scripts the plugin starts.
ENTRY_TABLE = "components/entries.ts"
SCRIPT_NAME = re.compile(r"\.py\b")
INTERPRETER = re.compile(r"""["'`]python[\d.]*["'`]""")
COMMENT = ("//", "/*", "*")
TEST_SUFFIXES = (".test.ts", ".test.tsx")
# The one module that sets the import path for a reader started by path.
ROOT_HELPER = "readers/plugin_root.py"
DOTDOT = re.compile(r"(?:^|[/\\])\.\.(?:$|[/\\])")
# Modules whose only use here would be to load code from a path.
LOADERS = frozenset({"importlib", "runpy"})
# Calls that hand back the path they were given, under another type or form.
SAME_PATH = frozenset({"Path", "PurePath", "PosixPath", "WindowsPath", "str", "fspath",
                       "abspath", "realpath", "normpath", "join"})
SAME_PATH_METHODS = frozenset({"resolve", "absolute", "expanduser", "joinpath"})


def plugin_folders(root: Path) -> list[Path]:
    """Every plugin folder directly under this tree, by its manifest."""
    if not root.is_dir():
        return []
    return sorted(child for child in root.iterdir()
                  if child.is_dir() and (child / MANIFEST).is_file())


def modules(folder: Path) -> list[Path]:
    """Every TypeScript module in this plugin, generated declarations aside."""
    found: list[Path] = []
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix not in (".ts", ".tsx"):
            continue
        if GENERATED in path.parts:
            continue
        found.append(path)
    return found


def python_modules(folder: Path) -> list[Path]:
    """Every Python module in this plugin, generated trees aside."""
    return [path for path in sorted(folder.rglob("*.py"))
            if path.is_file() and GENERATED not in path.parts]


def local_names(folder: Path) -> set[str]:
    """What a plugin module may import besides the standard library: the plugin's own top level."""
    names = {Path(ROOT_HELPER).stem, "__future__"}
    for child in folder.iterdir():
        if child.name.startswith(".") or child.name == GENERATED:
            continue
        if child.is_dir() and any(inner.suffix == ".py" for inner in child.iterdir()):
            names.add(child.name)
        elif child.suffix == ".py":
            names.add(child.stem)
    return names


def bound_names(tree: ast.Module) -> dict[str, str]:
    """Each name an import or a plain assignment binds to a module or a module's member."""
    aliases: dict[str, str] = {}
    for node in sorted((node for node in ast.walk(tree)
                        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign))),
                       key=lambda node: (node.lineno, node.col_offset)):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                aliases[bound] = alias.name if alias.asname else alias.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                for alias in node.names:
                    aliases[alias.asname or alias.name] = node.module + "." + alias.name
        elif (len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
              and isinstance(node.value, (ast.Name, ast.Attribute))):
            # `s = sys` or `p = sys.path`: a plain name for something an import bound.
            root = node.value
            while isinstance(root, ast.Attribute):
                root = root.value
            if isinstance(root, ast.Name) and root.id in aliases:
                aliases[node.targets[0].id] = canonical(node.value, aliases)
    return aliases


def canonical(node: ast.AST, aliases: dict[str, str]) -> str:
    """The dotted name an expression stands for, through the names imports bound."""
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = canonical(node.value, aliases)
        return base + "." + node.attr if base else ""
    return ""


def touches_import_path(named: str) -> bool:
    return (named == "sys.path" or named.startswith("sys.path.")
            or named.split(".")[0] in LOADERS or named.split(".")[-1] == "__import__")


DEFINITIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


class Scope:
    """The heights of the names one scope binds, as they stand at the statement being read.

    A name the scope binds anywhere is its own for the whole scope, as Python
    reads it; any other name is looked up in the enclosing function or module.
    A class body is a scope, and a method does not see its names.
    """

    def __init__(self, parent: Scope | None, own: set[str], is_class: bool = False) -> None:
        self.parent = parent
        self.own = own
        self.is_class = is_class
        self.heights: dict[str, int] = {}

    def height(self, name: str) -> int | None:
        if self.parent is None or name in self.own:
            return self.heights.get(name)
        return self.parent.height(name)

    def bind(self, name: str, height: int | None) -> None:
        if height is None:
            self.heights.pop(name, None)
        else:
            self.heights[name] = height


def stored_names(node: ast.AST) -> list[str]:
    """The plain names an assignment target binds."""
    return [inner.id for inner in ast.walk(node)
            if isinstance(inner, ast.Name) and isinstance(inner.ctx, ast.Store)]


def scope_names(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> set[str]:
    """Every name this function or class body binds, nested definitions' own bodies aside."""
    names: set[str] = set()
    declared: set[str] = set()
    if not isinstance(node, ast.ClassDef):
        arguments = node.args
        for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs,
                         arguments.vararg, arguments.kwarg]:
            if argument is not None:
                names.add(argument.arg)
    pending: list[ast.AST] = list(node.body)
    while pending:
        inner = pending.pop()
        if isinstance(inner, DEFINITIONS):
            names.add(inner.name)
            pending.extend([*inner.decorator_list, *direct_expressions(inner)])
            continue
        if isinstance(inner, (ast.Global, ast.Nonlocal)):
            declared.update(inner.names)
        if isinstance(inner, ast.Name) and isinstance(inner.ctx, ast.Store):
            names.add(inner.id)
        if isinstance(inner, ast.Lambda):
            continue
        pending.extend(ast.iter_child_nodes(inner))
    return names - declared


def direct_expressions(statement: ast.stmt) -> list[ast.expr]:
    """The expressions a statement evaluates itself, its nested statements aside."""
    found: list[ast.expr] = []
    for _, value in ast.iter_fields(statement):
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, ast.expr):
                found.append(item)
            elif isinstance(item, ast.keyword):
                found.append(item.value)
            elif isinstance(item, ast.arguments):
                found.extend(default for default in [*item.defaults, *item.kw_defaults]
                             if default is not None)
            elif isinstance(item, ast.withitem):
                found.append(item.context_expr)
    return found


def nested_blocks(statement: ast.stmt) -> list[list[ast.stmt]]:
    """The statement lists a compound statement runs in the same scope."""
    blocks = [getattr(statement, field) for field in ("body", "orelse", "finalbody")
              if isinstance(getattr(statement, field, None), list)]
    for handler in getattr(statement, "handlers", []):
        blocks.append(handler.body)
    for case in getattr(statement, "cases", []):
        blocks.append(case.body)
    return blocks


class Climbs:
    """How far each expression climbs from `__file__`, with names read where they are used."""

    def __init__(self, tree: ast.Module, aliases: dict[str, str]) -> None:
        self.aliases = aliases
        self.worst: dict[int, int] = {}
        pending: list[tuple[ast.stmt, Scope]] = []
        self.block(tree.body, Scope(None, set()), pending)
        while pending:
            node, parent = pending.pop(0)
            if not isinstance(node, ast.ClassDef):
                # A function does not see the names of a class it is defined in.
                while parent.is_class and parent.parent is not None:
                    parent = parent.parent
            scope = Scope(parent, scope_names(node), isinstance(node, ast.ClassDef))
            self.block(node.body, scope, pending)

    def block(self, body: list[ast.stmt], scope: Scope,
              pending: list[tuple[ast.stmt, Scope]]) -> None:
        for statement in body:
            self.check(direct_expressions(statement), scope)
            self.bind(statement, scope)
            if isinstance(statement, DEFINITIONS):
                pending.append((statement, scope))
                continue
            for handler in getattr(statement, "handlers", []):
                if handler.type is not None:
                    self.check([handler.type], scope)
                if handler.name:
                    scope.bind(handler.name, None)
            for nested in nested_blocks(statement):
                self.block(nested, scope, pending)

    def check(self, expressions: list[ast.expr], scope: Scope) -> None:
        for expression in expressions:
            for node in ast.walk(expression):
                if isinstance(node, ast.Name) or not isinstance(node, ast.expr):
                    continue
                levels = self.of(node, scope)
                if levels is not None:
                    self.worst[node.lineno] = max(levels, self.worst.get(node.lineno, -1))

    def bind(self, statement: ast.stmt, scope: Scope) -> None:
        """The height each name the statement binds holds after it."""
        if isinstance(statement, ast.Assign):
            height = self.of(statement.value, scope)
            for target in statement.targets:
                for name in stored_names(target):
                    scope.bind(name, height if isinstance(target, ast.Name) else None)
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            scope.bind(statement.target.id,
                       None if statement.value is None else self.of(statement.value, scope))
        elif isinstance(statement, ast.AugAssign) and isinstance(statement.target, ast.Name):
            # Joining onto a path keeps its height; anything else is another value.
            if not isinstance(statement.op, ast.Div):
                scope.bind(statement.target.id, None)
        elif isinstance(statement, (ast.For, ast.AsyncFor)):
            for name in stored_names(statement.target):
                scope.bind(name, None)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            for item in statement.items:
                if item.optional_vars is not None:
                    for name in stored_names(item.optional_vars):
                        scope.bind(name, None)
        elif isinstance(statement, DEFINITIONS):
            scope.bind(statement.name, None)

    def of(self, node: ast.AST, scope: Scope) -> int | None:
        if isinstance(node, ast.Name):
            return 0 if node.id == "__file__" else scope.height(node.id)
        if isinstance(node, ast.Attribute) and node.attr == "parent":
            base = self.of(node.value, scope)
            return None if base is None else base + 1
        if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute)
                and node.value.attr == "parents"):
            base = self.of(node.value.value, scope)
            if base is None:
                return None
            index = node.slice
            if isinstance(index, ast.Constant) and isinstance(index.value, int):
                return base + index.value + 1
            # An index nobody can read here could be any height.
            return base + 1_000
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr in SAME_PATH_METHODS:
                return self.of(node.func.value, scope)
            last = canonical(node.func, self.aliases).split(".")[-1]
            if last == "dirname" and node.args:
                base = self.of(node.args[0], scope)
                return None if base is None else base + 1
            if last in SAME_PATH and node.args:
                return self.of(node.args[0], scope)
            return None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return self.of(node.left, scope)
        return None


def docstrings(tree: ast.Module) -> set[int]:
    """The nodes that are docstrings, which may say anything."""
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                found.add(id(body[0].value))
    return found


def import_findings(tree: ast.Module, allowed: set[str], depth: int) -> list[tuple[int, str]]:
    """Every import, wherever it stands, that names something an install does not carry."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):  # every import, at any depth
        if isinstance(node, ast.ImportFrom) and node.level > 0:
            if node.level > depth:
                found.append((node.lineno, "a relative import that climbs past the plugin folder"))
            continue
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [node.module or ""]
        else:
            continue
        for name in names:
            top = name.split(".")[0]
            if top == "plugins":
                found.append((node.lineno, "an import through the repository's plugins package, "
                                           "which an install does not have"))
            elif top not in allowed:
                found.append((node.lineno, "{0}: neither the standard library nor a package of "
                                           "this plugin, and an install carries nothing else"
                              .format(name)))
    return found


def path_findings(tree: ast.Module, aliases: dict[str, str]) -> list[tuple[int, str]]:
    """Every reference that loads code from a path or changes where imports look."""
    found: list[tuple[int, str]] = []
    reason = "touches the import path, which only {0} may do".format(ROOT_HELPER)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(touches_import_path(alias.name) for alias in node.names):
                found.append((node.lineno, reason))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            if any(touches_import_path(node.module + "." + alias.name) for alias in node.names):
                found.append((node.lineno, reason))
        elif isinstance(node, (ast.Name, ast.Attribute)):
            if touches_import_path(canonical(node, aliases)):
                found.append((node.lineno, reason))
    return found


def climb_findings(climbs: Climbs, allowed: int, helper: bool) -> list[tuple[int, str]]:
    """Every line that climbs from `__file__` past what this module may."""
    found: list[tuple[int, str]] = []
    for line, levels in sorted(climbs.worst.items()):
        if levels <= (allowed if helper else 1):
            continue
        if levels > allowed:
            found.append((line, "{0} levels up from __file__, above the plugin folder, which an "
                                "install copies alone".format(levels)))
        else:
            found.append((line, "{0} levels up from __file__, and only {1} may climb more than "
                                "one".format(levels, ROOT_HELPER)))
    return found


def dotdot_findings(tree: ast.Module, aliases: dict[str, str]) -> list[tuple[int, str]]:
    """Every `..` segment in a string, and every use of os.pardir."""
    found: list[tuple[int, str]] = []
    skipped = docstrings(tree)
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in skipped and DOTDOT.search(node.value)):
            found.append((node.lineno, "{0!r}: a .. segment that can climb out of the plugin "
                                       "folder".format(node.value)))
        elif isinstance(node, (ast.Name, ast.Attribute)) and \
                canonical(node, aliases) in ("os.pardir", "os.path.pardir"):
            found.append((node.lineno, "os.pardir: a .. segment that can climb out of the "
                                       "plugin folder"))
    return found


def python_violations(folder: Path) -> tuple[int, list[str]]:
    """Every Python module that reaches past what an install of the folder holds."""
    found: list[str] = []
    read = 0
    allowed_imports = set(sys.stdlib_module_names) | local_names(folder)
    for module in python_modules(folder):
        read += 1
        relative = module.relative_to(folder)
        named = module.relative_to(folder.parent).as_posix()
        # The plugin root lies this many levels above the module: one for its
        # own directory, and one more for each directory between.
        allowed = len(relative.parts)
        helper = relative.as_posix() == ROOT_HELPER
        try:
            tree = ast.parse(module.read_text(encoding="utf-8", errors="replace"),
                             filename=str(module))
        except SyntaxError as caught:
            found.append("{0}:{1}: does not parse ({2})".format(named, caught.lineno or 0,
                                                                 caught.msg))
            continue
        aliases = bound_names(tree)
        findings = import_findings(tree, allowed_imports, allowed - 1)
        if not helper:
            findings += path_findings(tree, aliases)
        findings += climb_findings(Climbs(tree, aliases), allowed, helper)
        findings += dotdot_findings(tree, aliases)
        for line, reason in sorted(set(findings)):
            found.append("{0}:{1}: {2}".format(named, line, reason))
    return read, found


def escapes(folder: Path, module: Path, specifier: str) -> bool:
    """Whether this relative specifier lands outside the plugin folder."""
    if not specifier.startswith("."):
        return False
    resolved = (module.parent / specifier).resolve()
    return folder.resolve() not in resolved.parents


def violations(folder: Path) -> tuple[int, list[str]]:
    """Every module the host cannot evaluate, and how many were read."""
    found: list[str] = []
    read = 0
    for module in modules(folder):
        read += 1
        table = module.relative_to(folder).as_posix() == ENTRY_TABLE
        suite = module.name.endswith(TEST_SUFFIXES)
        lines = module.read_text(encoding="utf-8", errors="replace").splitlines()
        for number, line in enumerate(lines, start=1):
            # Named with forward slashes on every platform: a refusal is read by
            # a person and compared by a test, and one that changed shape with
            # the platform would read as a different refusal.
            where = "{0}:{1}".format(module.relative_to(folder.parent).as_posix(), number)
            for match in SPECIFIER.finditer(line):
                specifier = match.group("spec")
                if specifier.startswith("node:"):
                    found.append("{0}: {1} (a node built-in the host does not provide)".format(
                        where, specifier))
                elif escapes(folder, module, specifier):
                    found.append("{0}: {1} (outside the plugin folder)".format(where, specifier))
            for match in GLOBAL.finditer(line):
                found.append("{0}: {1} (a node global the host does not set)".format(
                    where, match.group("name").rstrip()))
            if table or suite or line.lstrip().startswith(COMMENT):
                continue
            if SCRIPT_NAME.search(line):
                found.append("{0}: {1} (names a Python script outside the entry table, "
                             "{2})".format(where, line.strip(), ENTRY_TABLE))
            if INTERPRETER.search(line):
                found.append("{0}: {1} (starts Python outside the entry table, {2})".format(
                    where, line.strip(), ENTRY_TABLE))
    return read, found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugins", default=str(PLUGINS),
                        help="the tree holding one folder per plugin")
    args = parser.parse_args()
    folders = plugin_folders(Path(args.plugins))
    if not folders:
        print("Refused: no plugin folder was found under {0}.".format(args.plugins),
              file=sys.stderr)
        return 2
    typescript = 0
    python = 0
    found: list[str] = []
    for folder in folders:
        read, outside = violations(folder)
        if not read:
            print("Refused: {0} holds no TypeScript module to check.".format(folder.name),
                  file=sys.stderr)
            return 2
        typescript += read
        found.extend(outside)
        read, outside = python_violations(folder)
        python += read
        found.extend(outside)
    if found:
        print("Refused: the host cannot evaluate these plugin modules:", file=sys.stderr)
        for entry in found:
            print("  " + entry, file=sys.stderr)
        print("It compiles the folder and evaluates its modules without node, and an "
              "install copies the folder alone, so the surface would never appear.",
              file=sys.stderr)
        return 1
    print("Plugin modules stay inside their folders and use no node global: "
          "{0} modules ({1} TypeScript, {2} Python) in {3} plugin(s) checked.".format(
              typescript + python, typescript, python, len(folders)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
