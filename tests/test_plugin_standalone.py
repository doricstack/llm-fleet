#!/usr/bin/env python3
"""The plugin folder runs on its own, the way an install leaves it.

A marketplace install copies the plugin folder and nothing beside it. A reader
that reached past that folder, for a loader kept at the repository root or for a
module found by counting parents up from itself, imports here and dies there,
and the pane then reports a machine it could not read.

So the folder is copied alone into a temporary directory and every Python entry
it has is run by path from a third directory that has nothing to do with either,
with no import path handed in from this process and a home of the test's own:
what the entries can reach is what the copy holds.

Exiting cleanly is not enough. The read command keeps a reader that raised in
its slot as a failed source and still exits 0, so a reader that reaches into the
repository only when it runs would pass a check of the exit code and the keys.
Every source is switched on here, with stub commands and empty stores of the
test's own, so each reader runs its body, and none may come back failed.

The entries are declared once, in the plugin's entry table
(`components/entries.ts`), and the plugin starts a Python script only through
that table; the boundary check refuses a script named anywhere else. This test
holds the other two sides: every module that runs as a command or does work
when it is loaded, found by reading its syntax tree, is in the table, and every
entry in the table is run here. A difference on either side fails by name.
"""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from typing import Any, Callable
import unittest

import paths


NOW = "1700000000"
# A question digest in the shape the read command hands the pane.
DIGEST = "0" * 64
IMPORT_FAILURE = re.compile(r"ModuleNotFoundError|ImportError|No module named")
# The one place the plugin names the Python scripts it starts.
ENTRY_TABLE = Path("components") / "entries.ts"
TABLE_START = "export const ENTRIES = {"
TABLE_END = "} as const;"
TABLE_ROW = re.compile(r'^\s*(?P<key>[a-z][A-Za-z]*): "(?P<path>[\w/-]+\.py)",$')
# The helper a reader started by path imports to find the plugin root. It does
# its work when it is loaded, which is its whole purpose, and it is never run.
ROOT_HELPER = "readers/plugin_root.py"
# Calls a module may make while it is loaded without that being work: building
# a pattern, a set, a path. Anything else at the top level makes the module an
# entry, which errs toward one more run case rather than one missed.
PURE_CALLS = frozenset({"re.compile", "frozenset", "set", "tuple", "dict", "list", "object",
                        "getattr", "hasattr", "Path", "TypeVar"})
PURE_METHODS = frozenset({"resolve"})
# Decorators that wrap a function and do nothing else while the module loads. A
# decorator runs when its function is defined, so any other is work, called or
# not; one of these called with arguments must have pure arguments.
PURE_DECORATORS = frozenset({"staticmethod", "classmethod", "property", "contextmanager",
                             "contextlib.contextmanager", "lru_cache", "functools.lru_cache",
                             "cache", "functools.cache", "dataclass", "dataclasses.dataclass"})

STORES = """
CREATE TABLE repos (repo_id INTEGER PRIMARY KEY, remote_url TEXT, root_oid TEXT);
CREATE TABLE changes (change_id INTEGER PRIMARY KEY, repo_id INTEGER, branch TEXT,
                      state TEXT, worktree_path TEXT);
CREATE TABLE leases (change_id INTEGER, tool TEXT, expires_at REAL, session TEXT);
CREATE TABLE receipts (receipt_id TEXT, change_id INTEGER, evidence TEXT, created_at REAL);
CREATE TABLE milestones (change_id INTEGER, session TEXT, created_at REAL, to_state TEXT);
"""

# Answers every command the readers start with an empty list.
EMPTY_STUB = "print('[]')\n"
# Prints the status pacer prints, and accepts on or off as its switch does.
PACER_STUB = ("import json\n"
              "print(json.dumps({'enabled': True, 'source': 'missing', 'reason': None,\n"
              "                  'config': {'slots': 2, 'workers_per_run': 4},\n"
              "                  'slots': [{'slot': 0, 'busy': False, 'holder': None},\n"
              "                            {'slot': 1, 'busy': False, 'holder': None}]}))\n")
CUSTOM_STUB = ("import json\n"
               "print(json.dumps({'summary': 'one row', 'rows': [{'title': 'row'}]}))\n")
PAYLOAD = {"session_id": "standalone", "model": {"id": "claude-opus-4-6", "display_name": "Opus"},
           "workspace": {"current_dir": "/tmp"}, "version": "2.0.0"}
TRANSCRIPT_LINE = {"type": "assistant", "requestId": "r1", "isSidechain": False,
                   "message": {"id": "m1", "model": "claude-opus-4-6",
                               "usage": {"input_tokens": 10, "output_tokens": 5,
                                         "cache_read_input_tokens": 0,
                                         "cache_creation_input_tokens": 0}}}


def entry_table(folder: Path) -> dict[str, str]:
    """The plugin's declared entries, key to script, refusing any line it cannot read exactly."""
    lines = (folder / ENTRY_TABLE).read_text(encoding="utf-8").splitlines()
    if lines.count(TABLE_START) != 1:
        raise AssertionError("the entry table must open once with {0!r}".format(TABLE_START))
    start = lines.index(TABLE_START) + 1
    if TABLE_END not in lines[start:]:
        raise AssertionError("the entry table never closes with {0!r}".format(TABLE_END))
    end = lines.index(TABLE_END, start)
    table: dict[str, str] = {}
    for line in lines[start:end]:
        if not line.strip() or line.strip().startswith("//"):
            continue
        row = TABLE_ROW.match(line)
        if row is None:
            raise AssertionError("an entry table line this test cannot read: {0!r}".format(line))
        if row.group("key") in table:
            raise AssertionError("an entry declared twice: {0}".format(row.group("key")))
        table[row.group("key")] = row.group("path")
    return table


def dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return dotted(node.value) + "." + node.attr
    return ""


def pure(node: ast.AST) -> bool:
    """Whether evaluating this expression while the module loads does no work."""
    for inner in ast.walk(node):
        if isinstance(inner, ast.Call):
            name = dotted(inner.func)
            method = inner.func.attr if isinstance(inner.func, ast.Attribute) else ""
            if name not in PURE_CALLS and method not in PURE_METHODS:
                return False
        if isinstance(inner, (ast.Await, ast.Yield, ast.YieldFrom, ast.NamedExpr)):
            return False
    return True


def main_guard(node: ast.stmt) -> bool:
    return (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
            and dotted(node.test.left) == "__name__"
            and any(isinstance(right, ast.Constant) and right.value == "__main__"
                    for right in node.test.comparators))


def imports_only(body: list[ast.stmt]) -> bool:
    return all(isinstance(node, (ast.Import, ast.ImportFrom, ast.Pass)) for node in body)


# What a property makes of itself to add an accessor: `@value.setter`.
ACCESSORS = frozenset({"setter", "getter", "deleter"})


def quiet_decorator(node: ast.expr, properties: frozenset[str] = frozenset()) -> bool:
    """A decorator that only wraps: a known one, called with pure arguments if called.

    `properties` names the properties defined above in the same class body,
    whose own accessors only wrap as well.
    """
    if (isinstance(node, ast.Attribute) and node.attr in ACCESSORS
            and isinstance(node.value, ast.Name) and node.value.id in properties):
        return True
    if isinstance(node, ast.Call):
        return dotted(node.func) in PURE_DECORATORS and all(
            pure(argument) for argument in [*node.args, *(word.value for word in node.keywords)])
    return dotted(node) in PURE_DECORATORS


def quiet_definition(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
                     properties: frozenset[str] = frozenset()) -> bool:
    """A definition whose decorators, defaults, bases and class body do no work while it loads."""
    if not all(quiet_decorator(decorator, properties) for decorator in node.decorator_list):
        return False
    if isinstance(node, ast.ClassDef):
        evaluated = [*node.bases, *(word.value for word in node.keywords)]
        return all(pure(value) for value in evaluated) and quiet_class_body(node.body)
    defaults = [*node.args.defaults, *(value for value in node.args.kw_defaults if value)]
    return all(pure(value) for value in defaults)


def quiet_block(body: list[ast.stmt]) -> bool:
    return all(loads_quietly(node) for node in body)


def makes_property(node: ast.stmt, properties: frozenset[str]) -> bool:
    """Whether this definition leaves a property under its name: `@property`, or an accessor."""
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return False
    for decorator in node.decorator_list:
        if dotted(decorator) == "property":
            return True
        if (isinstance(decorator, ast.Attribute) and decorator.attr in ACCESSORS
                and isinstance(decorator.value, ast.Name) and decorator.value.id in properties):
            return True
    return False


def quiet_class_body(body: list[ast.stmt]) -> bool:
    """A class body, read in order so a property's accessors know the property above them."""
    properties: frozenset[str] = frozenset()
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not quiet_definition(node, properties):
                return False
        elif not loads_quietly(node):
            return False
        if makes_property(node, properties):
            properties = properties | {node.name}
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # A plain method or class under the same name is no property any more.
            properties = properties - {node.name}
    return True


def loads_quietly(node: ast.stmt) -> bool:
    """A statement run while the module loads that defines rather than does."""
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.Pass)):
        return True
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return quiet_definition(node)
    if isinstance(node, ast.Expr):
        return isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
    if isinstance(node, ast.Assign):
        return pure(node.value)
    if isinstance(node, ast.AnnAssign):
        return node.value is None or pure(node.value)
    if isinstance(node, ast.If):
        # The guard a reader started by path uses to reach the plugin root.
        if not isinstance(node.test, ast.Compare) or node.orelse:
            return False
        return dotted(node.test.left) == "__package__" and imports_only(node.body)
    if isinstance(node, ast.Try):
        # The body, a handler, the else and the finally can each run as it loads.
        return (quiet_block(node.body) and quiet_block(node.orelse)
                and quiet_block(node.finalbody)
                and all(quiet_block(handler.body) for handler in node.handlers))
    return False


def entry_modules(folder: Path) -> set[str]:
    """Every plugin module that runs as a command or does work when it is loaded."""
    found: set[str] = set()
    for module in sorted(folder.rglob("*.py")):
        relative = module.relative_to(folder).as_posix()
        if ".claude-plugin" in module.parts or relative == ROOT_HELPER:
            continue
        tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        if any(main_guard(node) or not loads_quietly(node) for node in tree.body):
            found.add(relative)
    return found


def schema_scripts(folder: Path) -> set[str]:
    """Every string in the schema that names a Python script."""
    found: set[str] = set()
    pending: list[Any] = [json.loads((folder / "config" / "schema.json").read_text(encoding="utf-8"))]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str) and value.endswith(".py"):
            found.add(value)
    return found


def isolated_environment(home: Path) -> dict[str, str]:
    """The caller's environment with no import path, and a home of the test's own."""
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith("PYTHON") and not name.startswith("XDG_")}
    environment["HOME"] = str(home)
    environment["USERPROFILE"] = str(home)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


class Case:
    """One run of one entry: its arguments, its input, the codes it may exit with."""

    def __init__(self, arguments: list[str], codes: tuple[int, ...] = (0,), stdin: str = "",
                 check: Callable[[unittest.TestCase, str], None] | None = None) -> None:
        self.arguments = arguments
        self.codes = codes
        self.stdin = stdin
        self.check = check


def no_failed_source(test: unittest.TestCase, stdout: str) -> None:
    document = json.loads(stdout)
    test.assertNotIn("configErrors", document)
    for name, part in document.items():
        if not isinstance(part, dict) or "state" not in part:
            continue
        test.assertNotEqual(part["state"], "failed",
                            "{0} failed in the copy: {1}".format(name, part.get("errors")))


def every_source_ran(test: unittest.TestCase, stdout: str) -> None:
    """Each reader ran its body: none was off, so none returned before its work."""
    no_failed_source(test, stdout)
    document = json.loads(stdout)
    for name in ("roster", "trials", "progress", "prs", "skills", "worktrees", "session",
                 "custom", "pacer"):
        test.assertIn(name, document)
        test.assertNotEqual(document[name]["state"], "disabled",
                            "{0} was off, so its reader never ran".format(name))


def json_document_any_state(test: unittest.TestCase, stdout: str) -> None:
    """A JSON answer, whatever state it names: a refusal is an answer here."""
    test.assertIsInstance(json.loads(stdout), dict)


def default_rate_cards(plugin: Path) -> list[str]:
    """Every generation the copy's schema gives a rate card by default."""
    schema = json.loads((plugin / "config" / "schema.json").read_text(encoding="utf-8"))
    for field in schema["fields"]:
        if field["path"] == "sources.rates.cards":
            return sorted(field["default"])
    raise AssertionError("the schema declares no rate cards")


def a_failed_refresh(test: unittest.TestCase, stdout: str) -> None:
    """A refresh that reached no page keeps what it tried, and fails each card by name."""
    document = json.loads(stdout)
    test.assertEqual(document["state"], "ready")
    test.assertTrue(document["fetched"])
    test.assertTrue(document["failed"])


def json_document(test: unittest.TestCase, stdout: str) -> None:
    document = json.loads(stdout)
    test.assertIsInstance(document, dict)
    test.assertNotEqual(document.get("state"), "failed", stdout)


class StandalonePluginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fleet-standalone-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.plugin = self.root / "install" / "fleet"
        shutil.copytree(paths.PLUGIN, self.plugin,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.elsewhere = self.root / "elsewhere"
        self.elsewhere.mkdir()
        self.home = self.root / "home"
        self.home.mkdir()
        self.config = self.write_config()

    def stub(self, name: str, text: str) -> list[str]:
        path = self.root / "stubs" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return [sys.executable, str(path)]

    def write_config(self) -> Path:
        """Every source on, each pointed at a stub or an empty store of this test's own."""
        provider = self.root / "homes" / "one"
        provider.mkdir(parents=True)
        trials = self.root / "trials.sqlite"
        with sqlite3.connect(trials) as connection:
            connection.executescript(STORES)
        for made in ("progress", "skills", "worktrees"):
            (self.root / made).mkdir()
        payload = self.root / "payload.json"
        payload.write_text(json.dumps(PAYLOAD), encoding="utf-8")
        self.transcript = self.root / "transcript.jsonl"
        self.transcript.write_text(json.dumps(TRANSCRIPT_LINE) + "\n", encoding="utf-8")
        document = {
            "stateDir": str(self.root / "state"),
            "providers": [{"id": "one", "home": str(provider)}],
            "commands": {"claude": self.stub("claude.py", EMPTY_STUB),
                         "github": self.stub("gh.py", EMPTY_STUB)},
            "sources": {
                "trials": {"enabled": True, "database": str(trials)},
                "progress": {"enabled": True, "directory": str(self.root / "progress")},
                "prs": {"enabled": True, "repositories": ["owner/project"]},
                "skills": {"enabled": True, "directory": str(self.root / "skills")},
                "worktrees": {"enabled": True, "roots": [str(self.root / "worktrees")]},
                "statusline": {"enabled": True, "payload": str(payload)},
                "pacer": {"enabled": True, "command": self.stub("pacer.py", PACER_STUB)},
                # Every card the defaults name is pointed at a port nothing
                # listens on, so a refresh runs its whole path and reaches no
                # network.
                "rates": {"cards": {generation: "deepseek https://127.0.0.1:9/"
                                    for generation in default_rate_cards(self.plugin)}},
            },
            "alerts": {"tabTint": {"enabled": False}},
            "pane": {"custom": {"standalone": {"title": "Standalone",
                                               "command": self.stub("custom.py", CUSTOM_STUB),
                                               "timeoutSeconds": 10}}},
        }
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def cases(self) -> dict[str, list[Case]]:
        """How each entry is run: every form the plugin uses, with no effect outside the test."""
        config = ["--config", str(self.config)]
        return {
            "snapshot": [
                Case([*config, "--now", NOW, "--pretty"], check=every_source_ran),
                Case([*config, "--now", NOW, "--only", "progress"], check=no_failed_source),
                Case([*config, "--now", NOW, "--refresh-worktrees"], check=no_failed_source),
            ],
            "alerts": [
                Case([*config, "--now", NOW, "focus", "standalone"]),
                Case([*config, "--now", NOW, "focused", "standalone"]),
                Case([*config, "--now", NOW, "claim", "standalone-key"]),
                Case([*config, "voices"], check=json_document),
                # Speech is off, so nothing is synthesized and the answer names no file.
                Case([*config, "speak", "--voice=af_sky", "--", "hello"], codes=(1,),
                     check=lambda test, out: test.assertIsNone(json.loads(out)["file"])),
                Case([*config, "discard", str(self.root / "not-a-clip.wav")], codes=(2,)),
                # The reply markers, against a job the stub provider never listed:
                # each answers with a refusal, written only under the state directory.
                Case([*config, "--now", NOW, "question", "one", "job-1", "--holder", "pane-a",
                      "--session", "standalone", "--hash", DIGEST, "--job-session", "s-1"],
                     codes=(1,), check=json_document_any_state),
                Case([*config, "--now", NOW, "confirm", "one", "job-1", "--hash", DIGEST,
                      "--job-session", "s-1", "--holder", "pane-a"], codes=(1,)),
                Case([*config, "--now", NOW, "release", "one", "job-1", "--hash", DIGEST,
                      "--job-session", "s-1", "--holder", "pane-a", "--failed"], codes=(1,)),
                Case([*config, "--now", NOW, "release", "one", "job-1", "--job-session", "s-1",
                      "--hash", DIGEST, "--stale"], codes=(1,)),
                Case([*config, "--now", NOW, "release", "one", "job-1", "--job-session", "s-1",
                      "--hash", DIGEST, "--unreadable"], codes=(1,)),
                Case([*config, "--now", NOW, "release", "--prune-sent"], codes=(1,),
                     check=lambda test, out: test.assertEqual(json.loads(out)["removed"], 0)),
            ],
            # Tinting is off, so the helper keeps its record under the state
            # directory and writes to no terminal.
            "tab": [
                Case([*config, "--now", NOW, "set", "--tab", "tab-1", "--session", "standalone",
                      "--level", "failed"]),
                Case([*config, "--now", NOW, "set", "--tab", "tab-1", "--session", "standalone",
                      "--level", "waiting", "--record-only", "--tmux"]),
                Case([*config, "--now", NOW, "end", "--tab", "tab-1", "--session", "standalone"]),
            ],
            "host": [
                Case([*config], codes=(0,), stdin=json.dumps(PAYLOAD), check=json_document),
            ],
            "session": [
                Case([*config], codes=(0,), check=json_document),
            ],
            # No switch path is configured here, so the read says so and a write
            # is refused rather than writing a switch nobody named.
            "governance": [
                Case([*config], codes=(0,), check=json_document),
                Case([*config, "--set", "governor", "--off"], codes=(0,),
                     check=lambda test, out: test.assertEqual(json.loads(out)["state"],
                                                              "unconfigured")),
                Case([*config, "--set", "governor"], codes=(2,), check=json_document_any_state),
            ],
            # The status reads only the state folder; the refresh fetches every
            # card, each refused by the closed port, and keeps the failures.
            "rates": [
                Case([*config, "--now", NOW, "--status"], codes=(0,), check=json_document),
                Case([*config, "--now", NOW, "--refresh"], codes=(0,), check=a_failed_refresh),
            ],
            # The stub prints the status pacer prints; a switch is answered by
            # reading that status again.
            "pacer": [
                Case([*config], codes=(0,), check=json_document),
                Case([*config, "--set", "off"], codes=(0,),
                     check=lambda test, out: test.assertEqual(json.loads(out)["slotCount"], 2)),
            ],
            "transcript": [
                Case([*config, "--path", str(self.transcript), "--model", "claude-opus-4-6"],
                     codes=(0,), check=json_document),
            ],
            # The doctor reads and starts nothing; on this machine a command may
            # be missing from the isolated PATH, which it reports with exit 1.
            "doctor": [
                Case([*config, "--json"], codes=(0, 1), check=json_document),
                Case([*config], codes=(0, 1)),
            ],
            # The starter goes to a path under the test's root, and a second run
            # finds it there and leaves it as it is.
            "setup": [
                Case(["--path", str(self.root / "starter.json")], codes=(0,)),
                Case(["--path", str(self.root / "starter.json")], codes=(3,)),
                Case(["--dry-run", "--path", str(self.root / "dry.json")], codes=(0,),
                     check=json_document),
            ],
        }

    def run_entry(self, entry: str, case: Case) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.plugin / entry), *case.arguments],
            cwd=str(self.elsewhere), env=isolated_environment(self.home), input=case.stdin,
            capture_output=True, text=True, check=False, timeout=120)

    def test_the_copy_carries_its_own_loader_and_schema(self) -> None:
        self.assertTrue((self.plugin / "config" / "loader.py").is_file())
        self.assertTrue((self.plugin / "config" / "schema.json").is_file())

    def test_every_declared_entry_exists(self) -> None:
        table = entry_table(self.plugin)
        self.assertIn("snapshot", table)
        for key, script in sorted(table.items()):
            self.assertTrue((self.plugin / script).is_file(), "{0}: {1}".format(key, script))

    def test_every_module_that_runs_is_declared(self) -> None:
        declared = set(entry_table(self.plugin).values())
        found = entry_modules(self.plugin)
        self.assertEqual(sorted(found - declared), [],
                         "a plugin module runs as a command or works when loaded, undeclared")
        self.assertEqual(sorted(declared - found), [],
                         "a declared entry neither runs as a command nor works when loaded")

    def test_every_declared_entry_is_run_here(self) -> None:
        declared = set(entry_table(self.plugin))
        run = set(self.cases())
        self.assertEqual(sorted(declared - run), [], "a declared entry this test does not run")
        self.assertEqual(sorted(run - declared), [], "a run case for no declared entry")

    def test_a_script_the_schema_names_is_a_declared_entry(self) -> None:
        declared = set(entry_table(self.plugin).values())
        named = {script for script in schema_scripts(self.plugin)
                 if (self.plugin / script).is_file()}
        self.assertEqual(sorted(named - declared), [],
                         "the schema names a plugin script the entry table does not")

    def test_every_entry_runs_from_the_copy_alone(self) -> None:
        table = entry_table(self.plugin)
        for key, cases in self.cases().items():
            for case in cases:
                with self.subTest(entry=key, arguments=case.arguments[2:]):
                    completed = self.run_entry(table[key], case)
                    output = completed.stdout + completed.stderr
                    self.assertNotIn("Traceback", completed.stderr, completed.stderr[-800:])
                    self.assertIsNone(IMPORT_FAILURE.search(output), output[-800:])
                    self.assertIn(completed.returncode, case.codes, output[-800:])
                    if case.check is not None:
                        case.check(self, completed.stdout)


class EntryDiscoveryTests(unittest.TestCase):
    """The table is read exactly, and a module that runs is found from its syntax tree."""

    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp(prefix="fleet-entries-"))
        self.addCleanup(shutil.rmtree, self.folder, True)
        (self.folder / "components").mkdir()
        (self.folder / "readers").mkdir()

    def module(self, name: str, text: str) -> None:
        (self.folder / "readers" / name).write_text(text, encoding="utf-8")

    def table(self, *rows: str) -> None:
        (self.folder / ENTRY_TABLE).write_text(
            "/** The entries. */\n" + TABLE_START + "\n" + "".join(row + "\n" for row in rows)
            + TABLE_END + "\n", encoding="utf-8")

    def test_the_table_is_read_key_by_key(self) -> None:
        self.table('  snapshot: "readers/snapshot.py",', "  // a note", '  tab: "readers/tab.py",')
        self.assertEqual(entry_table(self.folder),
                         {"snapshot": "readers/snapshot.py", "tab": "readers/tab.py"})

    def test_a_table_line_built_from_pieces_is_refused(self) -> None:
        self.table('  snapshot: ["readers", "snapshot.py"].join("/"),')
        with self.assertRaises(AssertionError):
            entry_table(self.folder)

    def test_a_key_declared_twice_is_refused(self) -> None:
        self.table('  one: "readers/one.py",', '  one: "readers/two.py",')
        with self.assertRaises(AssertionError):
            entry_table(self.folder)

    def test_a_main_guard_makes_an_entry(self) -> None:
        self.module("tool.py", "def main():\n    return 0\n\nif __name__ == '__main__':\n"
                               "    main()\n")
        self.assertEqual(entry_modules(self.folder), {"readers/tool.py"})

    def test_work_at_the_top_level_makes_an_entry(self) -> None:
        self.module("loud.py", "import sys\nsys.stdout.write('hello')\n")
        self.module("call.py", "import os\nHOME = os.getcwd()\n")
        self.module("guard.py", "import sys\nif sys.platform:\n    print('x')\n")
        self.module("spaced.py", "def main():\n    return 0\n\nif __name__  ==  \"__main__\":\n"
                                 "    raise SystemExit(main())\n")
        self.assertEqual(entry_modules(self.folder), {"readers/loud.py", "readers/call.py",
                                                      "readers/guard.py", "readers/spaced.py"})

    def test_a_module_that_only_defines_is_no_entry(self) -> None:
        self.module("library.py",
                    '"""A library."""\n'
                    "from __future__ import annotations\n"
                    "import re\n"
                    "from pathlib import Path\n"
                    "if __package__ in (None, ''):\n"
                    "    import plugin_root\n"
                    "try:\n    import fcntl\nexcept ImportError:\n    pass\n"
                    "PATTERN = re.compile('x')\n"
                    "NAMES = frozenset({'a'})\n"
                    "HERE = Path(__file__).resolve()\n"
                    "LIMIT: int = 3\n"
                    "class Thing:\n    pass\n"
                    "def run():\n    print('only when called')\n")
        self.assertEqual(entry_modules(self.folder), set())

    # A class body, a decorator and a default value all run while the module
    # loads, so each is held to the same rule as the top level.

    def test_work_in_a_class_body_makes_an_entry(self) -> None:
        self.module("body.py", "from pathlib import Path\nclass Holder:\n"
                               "    TEXT = Path('x').read_text()\n")
        self.module("nested.py", "class Outer:\n    class Inner:\n        print('loaded')\n")
        self.module("base.py", "def make():\n    return object\nclass Thing(make()):\n    pass\n")
        self.assertEqual(entry_modules(self.folder), {"readers/body.py", "readers/nested.py",
                                                      "readers/base.py"})

    def test_a_decorator_that_does_work_makes_an_entry(self) -> None:
        self.module("called.py", "def register(name):\n    return lambda f: f\n"
                                 "@register('x')\ndef handler():\n    pass\n")
        self.module("bare.py", "def announce(f):\n    print(f)\n    return f\n"
                               "@announce\ndef handler():\n    pass\n")
        self.module("method.py", "def announce(f):\n    return f\nclass Thing:\n"
                                 "    @announce\n    def run(self):\n        pass\n")
        self.assertEqual(entry_modules(self.folder), {"readers/called.py", "readers/bare.py",
                                                      "readers/method.py"})

    def test_a_default_value_that_does_work_makes_an_entry(self) -> None:
        self.module("default.py", "import os\ndef run(home=os.getcwd()):\n    return home\n")
        self.module("keyword.py", "import time\ndef run(*, at=time.time()):\n    return at\n")
        self.assertEqual(entry_modules(self.folder), {"readers/default.py", "readers/keyword.py"})

    def test_definitions_that_only_define_stay_quiet(self) -> None:
        self.module("quiet.py",
                    "import contextlib\nimport re\nfrom functools import lru_cache\n"
                    "class Thing:\n    '''A thing.'''\n    PATTERN = re.compile('x')\n"
                    "    LIMIT: int = 3\n"
                    "    @staticmethod\n    def make(value=None, *, flag=False, names=()):\n"
                    "        return value\n"
                    "    @property\n    def size(self):\n        return 1\n"
                    "@lru_cache(maxsize=4)\ndef cached(path=''):\n    return path\n"
                    "@contextlib.contextmanager\ndef held():\n    yield\n")
        self.assertEqual(entry_modules(self.folder), set())

    def test_a_property_with_its_setter_and_deleter_stays_quiet(self) -> None:
        self.module("record.py",
                    "class Record:\n"
                    "    @property\n    def value(self):\n        return self._value\n"
                    "    @value.setter\n    def value(self, new):\n        self._value = new\n"
                    "    @value.getter\n    def value(self):\n        return self._value\n"
                    "    @value.deleter\n    def value(self):\n        del self._value\n")
        self.assertEqual(entry_modules(self.folder), set())

    def test_an_accessor_of_something_not_a_property_above_is_work(self) -> None:
        self.module("loose.py", "import registry\nclass Record:\n"
                                "    @registry.setter\n    def value(self, new):\n        pass\n")
        self.module("later.py", "class Record:\n"
                                "    @value.setter\n    def value(self, new):\n        pass\n"
                                "    @property\n    def value(self):\n        return 1\n")
        self.module("plain.py", "class Record:\n"
                                "    def value(self):\n        return 1\n"
                                "    @value.setter\n    def value(self, new):\n        pass\n")
        self.module("outside.py", "@property\ndef value():\n    return 1\n"
                                  "class Record:\n"
                                  "    @value.setter\n    def value(self, new):\n        pass\n")
        self.assertEqual(entry_modules(self.folder), {"readers/loose.py", "readers/later.py",
                                                      "readers/plain.py", "readers/outside.py"})

    # A try block runs its else and finally as well as its body.

    def test_work_in_any_part_of_a_try_makes_an_entry(self) -> None:
        self.module("orelse.py", "try:\n    import fcntl\nexcept ImportError:\n    pass\n"
                                 "else:\n    print('loaded')\n")
        self.module("final.py", "try:\n    import fcntl\nexcept ImportError:\n    pass\n"
                                "finally:\n    print('loaded')\n")
        self.module("handler.py", "try:\n    import fcntl\nexcept ImportError:\n"
                                  "    print('no fcntl')\n")
        self.module("body.py", "try:\n    import os\n    os.getcwd()\nexcept OSError:\n    pass\n")
        self.assertEqual(entry_modules(self.folder), {"readers/orelse.py", "readers/final.py",
                                                      "readers/handler.py", "readers/body.py"})

    def test_a_quiet_try_with_else_and_finally_stays_quiet(self) -> None:
        self.module("quiet.py", "try:\n    import fcntl\nexcept ImportError:\n    fcntl = None\n"
                                "else:\n    LOCK = True\nfinally:\n    pass\n")
        self.assertEqual(entry_modules(self.folder), set())

    def test_asking_what_the_platform_offers_stays_quiet(self) -> None:
        self.module("probe.py", "import os\n"
                                "_WALKS = os.open in os.supports_dir_fd and hasattr(os, 'O_DIRECTORY')\n"
                                "FLAGS = getattr(os, 'O_NOFOLLOW', 0)\n")
        self.assertEqual(entry_modules(self.folder), set())

    def test_the_root_helper_is_not_an_entry(self) -> None:
        self.module("plugin_root.py", "import sys\nsys.path.insert(0, 'x')\n")
        self.assertEqual(entry_modules(self.folder), set())


if __name__ == "__main__":
    unittest.main()
