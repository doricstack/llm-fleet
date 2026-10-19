"""Configuration contract, resolution, group states, rules, and parity.

The contract tests read `plugins/llm-fleet/config/schema.json` and check it against
the loaders, the documentation, and the fixture corpus, so a field or a state cannot be added
without the surrounding obligations. The behavior tests exercise the semantics
the schema declares. The parity tests run the same fixture corpus through the
Python loader and the TypeScript loader.

A fixture states only what it changes. The harness builds the rest from the
defaults the schema declares, so the corpus cannot drift from the contract and
a schema addition does not rewrite every expectation.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from typing import Any


import paths  # noqa: E402

ROOT = paths.ROOT
PLUGIN = paths.PLUGIN

import config.loader as loader  # noqa: E402
from config import ConfigError, load_config, load_schema  # noqa: E402


FIXTURES = ROOT / "config" / "fixtures"
RUNNER = ROOT / "config" / "parity-runner.ts"
SUITE = ROOT / "scripts" / "typescript-suite.py"
DOCUMENTATION = ROOT / "docs" / "configuration.md"
HOME = "C:/fixture/runner" if os.name == "nt" else "/fixture/runner"


def path_of(relative: str) -> str:
    """A synthetic path in the shape the running platform would return."""
    return os.path.normpath(HOME + "/" + relative)


def set_path(tree: dict, path: str, value: Any) -> None:
    node = tree
    parts = path.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def deep_merge(base: dict, overrides: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def declared_baseline(schema: dict) -> dict:
    """The tree the schema declares for absent fields, from literal defaults.

    A default that depends on the machine (a variable chain, the platform
    temporary directory, the state directory) is left out, so a fixture has to
    state it rather than inherit a value the harness guessed.
    """
    baseline: dict = {}
    for field in schema["fields"]:
        default = field["default"]
        if isinstance(default, dict) and ("firstResolvable" in default or "resolvedBy" in default):
            continue
        set_path(baseline, field["path"], copy.deepcopy(default))
    for group in schema["sources"] + schema["mods"]:
        enabled = group["path"] + ".enabled"
        node: Any = baseline
        for part in enabled.split("."):
            node = node[part]
        if node is False:
            set_path(baseline, group["path"] + ".state", "disabled")
        if group.get("requiresReadyProvider"):
            set_path(baseline, group["path"] + ".providers", [])
    return baseline


def expand_fixture(directory: Path, spec: dict) -> tuple[dict, dict, str | None]:
    """Build the environment, the path kinds, and the platform a fixture declares."""
    environ = {}
    for key, value in spec.get("environment", {}).items():
        environ[key] = str(directory / value[2:]) if value.startswith("./") else value
    kinds = {}
    for key, value in spec.get("paths", {}).items():
        located = str(directory / key[2:]) if key.startswith("./") else key
        # The loader hands the probe a platform-shaped path, so the declared
        # keys are put in the same shape.
        kinds[os.path.normpath(located)] = value
    selected = spec.get("configFile")
    if isinstance(selected, str) and selected:
        environ["FLEET_CONFIG"] = str(directory / selected)
    return environ, kinds, spec.get("platform")


def path_fields(schema: dict) -> dict:
    """Every declared field whose value is a path, by field path."""
    return {field["path"]: field["type"] for field in schema["fields"]
            if field["type"] in ("path", "pathArray")}


def normalize_payload(payload: dict, schema: dict, directory: Path) -> dict:
    """Put both sides of a comparison into the running platform's path shape."""
    payload = substitute(payload, directory)
    if "config" not in payload:
        return payload
    config = json.loads(json.dumps(payload["config"]))
    for path, kind in path_fields(schema).items():
        parts = path.split(".")
        node = config
        for part in parts[:-1]:
            node = node.get(part) if isinstance(node, dict) else None
        if not isinstance(node, dict):
            continue
        leaf = parts[-1]
        value = node.get(leaf)
        if kind == "path" and isinstance(value, str):
            node[leaf] = os.path.normpath(value)
        elif kind == "pathArray" and isinstance(value, list):
            node[leaf] = [os.path.normpath(item) if isinstance(item, str) else item
                          for item in value]
    for entry in config.get("providers", []):
        if isinstance(entry.get("home"), str):
            entry["home"] = os.path.normpath(entry["home"])
    return {"config": config}


def substitute(value: Any, directory: Path) -> Any:
    """Replace the checkout-specific and machine-specific tokens."""
    if isinstance(value, str):
        text = value.replace(str(directory), "<FIXTURE>")
        return text.replace("<TEMP>", os.path.normpath(tempfile.gettempdir()))
    if isinstance(value, list):
        return [substitute(item, directory) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, directory) for key, item in value.items()}
    return value


_RUNTIME_CHECK: Any = None


def node_runtime() -> tuple[str | None, str]:
    """The one runtime definition, shared with the TypeScript suite target."""
    global _RUNTIME_CHECK
    if _RUNTIME_CHECK is None:
        specification = importlib.util.spec_from_file_location("typescript_suite", SUITE)
        assert specification is not None and specification.loader is not None
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        _RUNTIME_CHECK = module.node_runtime
    return _RUNTIME_CHECK()


class ConfigTestCase(unittest.TestCase):
    """Shared helpers: a disposable config file and error assertions."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.schema = load_schema()

    def write_config(self, document) -> str:
        path = self.root / "config.json"
        text = document if isinstance(document, str) else json.dumps(document, indent=2)
        path.write_text(text, encoding="utf-8")
        return str(path)

    def load(self, document=None, environ=None, probe=None, config_path=None, schema_file=None,
             platform="darwin"):
        environment = {"HOME": HOME} if environ is None else environ
        if config_path is None and document is not None:
            config_path = self.write_config(document)
        return load_config(config_path=config_path, environ=environment, probe=probe,
                           schema_file=schema_file, platform=platform)

    def assert_errors(self, expected, document=None, **kwargs) -> None:
        with self.assertRaises(ConfigError) as caught:
            self.load(document, **kwargs)
        actual = [(entry["code"], entry["path"]) for entry in caught.exception.errors]
        self.assertEqual(actual, expected)


class ContractTests(unittest.TestCase):
    """The schema is the contract; these tests hold every party to it."""

    def setUp(self) -> None:
        self.schema = load_schema()

    def test_types_and_descriptor_keys_are_the_declared_vocabulary(self) -> None:
        declared_types = set(self.schema["types"])
        declared_keys = set(self.schema["fieldKeys"])
        for field in self.schema["fields"] + self.schema["providerFields"]:
            self.assertIn(field["type"], declared_types, field)
            self.assertLessEqual(set(field), declared_keys, field)

    def test_field_paths_are_unique_and_complete(self) -> None:
        paths = [field["path"] for field in self.schema["fields"]]
        self.assertEqual(len(paths), len(set(paths)), "duplicate field path")
        for field in self.schema["fields"]:
            self.assertIn("default", field, field["path"])
            self.assertIn(field["path"].split(".")[0], self.schema["resolvedKeys"],
                          field["path"])

    def test_bounds_and_forms_match_their_type(self) -> None:
        for field in self.schema["fields"]:
            kind = field["type"]
            label = field["path"]
            if "minimum" in field or "maximum" in field:
                self.assertIn(kind, ("integer", "number"), label)
            if "values" in field:
                self.assertEqual(kind, "string", label)
            if field.get("nullable"):
                self.assertIn(kind, ("path", "string", "argv", "map", "object"), label)
            if field.get("version"):
                self.assertEqual(kind, "integer", label)
            if kind == "map":
                self.assertIn("valueType", field, label)
                # An open map is the one shape that takes a key its list does
                # not name, so the flag is declared where a loader honors it.
                if field.get("openKeys"):
                    self.assertEqual(kind, "map", label)
            if kind == "object":
                # An object names its keys, so a mistyped one is refused, unless
                # its values are records: a map of named records, such as the
                # sections a person adds, holds keys nobody can list ahead of
                # time, and each record's own fields are still checked by name.
                if "recordFields" not in field:
                    self.assertIn("keyValues", field, label)
                shapes = [name for name in ("valueType", "valueFields", "recordFields")
                          if name in field]
                self.assertEqual(len(shapes), 1, label)
            if kind == "rgb":
                self.assertNotIn("values", field, label)

    def test_defaults_carry_no_personal_paths(self) -> None:
        variables = set(self.schema["environment"]["variables"])
        kinds = set(self.schema["defaultKinds"])
        for field in self.schema["fields"]:
            default = field["default"]
            if isinstance(default, dict) and "resolvedBy" in default:
                self.assertIn(default["resolvedBy"], kinds, field["path"])
                if default["resolvedBy"] == "underStateDir":
                    self.assertFalse(os.path.isabs(default["relative"]), field["path"])
                continue
            if isinstance(default, dict) and "firstResolvable" in default:
                candidates = default["firstResolvable"]
                self.assertIn("firstResolvable", kinds, field["path"])
            elif field["type"] in ("path", "pathArray"):
                candidates = default if isinstance(default, list) else [default]
            else:
                continue
            for candidate in candidates:
                if not isinstance(candidate, str):
                    self.assertIsNone(candidate, field["path"])
                    continue
                self.assertFalse(candidate.startswith(("/", "~")), field["path"])
                for name in re.findall(r"\$([A-Za-z_][A-Za-z0-9_]*)", candidate):
                    self.assertIn(name, variables, field["path"])

    def test_groups_agree_with_declared_fields(self) -> None:
        declared = {field["path"] for field in self.schema["fields"]}
        for group in self.schema["sources"] + self.schema["mods"]:
            for name in group["fields"]:
                self.assertIn("{0}.{1}".format(group["path"], name), declared, group["id"])
            for rule in group.get("requires", []) + group.get("targets", []):
                names = rule["anyPresent"] if "anyPresent" in rule else [rule["field"]]
                for name in names:
                    self.assertIn(name, group["fields"], group["id"])
            self.assertEqual(group["path"].split(".")[-1], group["id"])
        for path in declared:
            parts = path.split(".")
            if parts[0] in ("sources", "mods"):
                group = next(item for item in self.schema[parts[0]] if item["id"] == parts[1])
                self.assertIn(parts[2], group["fields"], path)

    def test_legacy_environment_names_are_declared_once(self) -> None:
        names = []
        for field in self.schema["fields"]:
            for name in field.get("legacyEnvironment", []):
                self.assertTrue(name.startswith("FLEET_"), name)
                names.append(name)
        self.assertEqual(len(names), len(set(names)), "legacy name declared twice")
        self.assertNotIn(self.schema["environment"]["selector"], names)

    def test_rules_reference_declared_fields(self) -> None:
        declared = {field["path"] for field in self.schema["fields"]}
        for rule in self.schema["rules"]:
            for key in ("field", "container", "by"):
                if key in rule:
                    self.assertIn(rule[key], declared, rule)
            for path in rule.get("fields", []):
                self.assertIn(path, declared, rule)

    def test_loader_constants_match_the_contract(self) -> None:
        declared = {entry["code"] for entry in self.schema["errorCodes"]}
        implemented = {value for name, value in vars(loader).items() if name.startswith("CODE_")}
        self.assertEqual(declared, implemented)
        self.assertEqual(tuple(self.schema["providerStates"]), loader.PROVIDER_STATES)
        self.assertEqual(tuple(self.schema["sourceStates"]), loader.SOURCE_STATES)
        self.assertEqual(tuple(self.schema["modStates"]), loader.MOD_STATES)

    def test_every_declared_error_code_has_a_behavior_test(self) -> None:
        source = Path(__file__).read_text(encoding="utf-8")
        for entry in self.schema["errorCodes"]:
            self.assertIn('"' + entry["code"] + '"', source, entry["code"])

    def test_documentation_names_every_declared_field(self) -> None:
        text = DOCUMENTATION.read_text(encoding="utf-8")
        for field in self.schema["fields"]:
            path = field["path"]
            self.assertTrue("`{0}`".format(path) in text or "`{0}.".format(path) in text, path)

    def test_resolved_output_follows_the_contract(self) -> None:
        resolved = load_config(environ={"HOME": HOME}, probe=lambda path: "missing",
                               platform="darwin")
        self.assertEqual(set(resolved), set(self.schema["resolvedKeys"]))
        for entry in resolved["providers"]:
            self.assertEqual(set(entry), set(self.schema["providerResolutionKeys"]))
        for group in self.schema["sources"] + self.schema["mods"]:
            keys = set(self.schema["groupResolutionKeys"])
            keys.update(name for name in group["fields"] if name != "enabled")
            if group.get("requiresReadyProvider"):
                keys.add("providers")
            node = resolved
            for part in group["path"].split("."):
                node = node[part]
            self.assertEqual(set(node), keys, group["id"])

    def test_fixture_corpus_is_well_formed_and_on_contract(self) -> None:
        cases = sorted(path for path in FIXTURES.iterdir() if path.is_dir())
        self.assertGreaterEqual(len(cases), 15, "fixture corpus is thinner than the contract")
        declared = {entry["code"] for entry in self.schema["errorCodes"]}
        namespaces = set(self.schema["resolvedKeys"])
        covered = set()
        for case in cases:
            self.assertTrue((case / "env.json").is_file(), case.name)
            expected = json.loads((case / "expected.json").read_text(encoding="utf-8"))
            self.assertEqual(set(expected) - {"config", "errors"}, set(), case.name)
            if "config" in expected:
                self.assertLessEqual(set(expected["config"]), namespaces, case.name)
                continue
            for entry in expected["errors"]:
                self.assertEqual(set(entry), {"code", "path"}, case.name)
                covered.add(entry["code"])
        self.assertLessEqual(covered, declared)


class ResolutionTests(ConfigTestCase):
    """Defaults, variables, relative paths, and refusal classes."""

    def test_absent_file_uses_the_declared_defaults(self) -> None:
        resolved = self.load()
        self.assertEqual(resolved["schemaVersion"], 1)
        self.assertEqual(resolved["stateDir"], path_of(".local/state/llm-fleet"))
        self.assertEqual(resolved["providers"], [])
        self.assertEqual(resolved["commands"]["github"], ["gh"])
        # Settings nothing read are gone, not defaulted: a document naming one is
        # refused (the retired-settings fixture), and the result does not carry it.
        self.assertNotIn("controller", resolved)
        self.assertNotIn("statusline", resolved)
        self.assertNotIn("labels", resolved)
        self.assertNotIn("python", resolved["commands"])
        self.assertEqual((resolved["timeouts"]["helperMs"], resolved["timeouts"]["worktreeHelperMs"]),
                         (25000, 60000))

    def test_every_declared_literal_default_reaches_the_result(self) -> None:
        resolved = self.load()
        for field in self.schema["fields"]:
            default = field["default"]
            if isinstance(default, dict) and ("firstResolvable" in default
                                              or "resolvedBy" in default):
                continue
            node: Any = resolved
            for part in field["path"].split("."):
                node = node[part]
            self.assertEqual(node, default, field["path"])

    def test_platform_temporary_directory_is_resolved(self) -> None:
        resolved = self.load()
        self.assertEqual(resolved["speech"]["tempDirectory"],
                         os.path.normpath(tempfile.gettempdir()))
        self.assertFalse(resolved["speech"]["tempDirectory"].startswith("$"))

    def test_mod_state_directory_sits_under_the_state_directory(self) -> None:
        resolved = self.load({"stateDir": path_of("fleet")})
        self.assertEqual(resolved["mods"]["typing"]["stateDir"],
                         os.path.normpath(path_of("fleet") + "/typing"))

    def test_state_home_prefers_the_declared_xdg_variable(self) -> None:
        resolved = self.load(environ={"HOME": HOME, "XDG_STATE_HOME": "/fixture/state"})
        self.assertEqual(resolved["stateDir"], os.path.normpath("/fixture/state/llm-fleet"))

    def test_windows_user_directory_is_used_when_the_platform_defines_one(self) -> None:
        resolved = self.load(environ={"LOCALAPPDATA": HOME + "/AppData/Local"})
        self.assertEqual(resolved["stateDir"], path_of("AppData/Local/llm-fleet"))

    def test_windows_user_directory_outranks_the_home_fallback(self) -> None:
        resolved = self.load(environ={"HOME": HOME, "LOCALAPPDATA": HOME + "/AppData/Local"})
        self.assertEqual(resolved["stateDir"], path_of("AppData/Local/llm-fleet"))

    def test_config_file_falls_back_to_the_platform_directory(self) -> None:
        located = self.root / "appdata" / "llm-fleet"
        located.mkdir(parents=True)
        (located / "config.json").write_text('{"stateDir": "./here"}', encoding="utf-8")
        resolved = self.load(environ={"APPDATA": str(self.root / "appdata")})
        self.assertEqual(resolved["stateDir"], str(located / "here"))

    def test_default_config_file_is_discovered_under_home(self) -> None:
        located = self.root / ".config" / "llm-fleet"
        located.mkdir(parents=True)
        (located / "config.json").write_text('{"stateDir": "./here"}', encoding="utf-8")
        resolved = self.load(environ={"HOME": str(self.root)})
        self.assertEqual(resolved["stateDir"], str(located / "here"))

    def test_xdg_config_home_outranks_the_home_fallback(self) -> None:
        fallback = self.root / ".config" / "llm-fleet"
        fallback.mkdir(parents=True)
        (fallback / "config.json").write_text('{"stateDir": "/fallback"}', encoding="utf-8")
        chosen = self.root / "xdg" / "llm-fleet"
        chosen.mkdir(parents=True)
        (chosen / "config.json").write_text('{"stateDir": "/chosen"}', encoding="utf-8")
        resolved = self.load(environ={"HOME": str(self.root),
                                      "XDG_CONFIG_HOME": str(self.root / "xdg")})
        self.assertEqual(resolved["stateDir"], os.path.normpath("/chosen"))

    def test_selector_chooses_another_file(self) -> None:
        selected = self.write_config({"stateDir": "/elsewhere"})
        resolved = self.load(environ={"HOME": HOME, "FLEET_CONFIG": selected})
        self.assertEqual(resolved["stateDir"], os.path.normpath("/elsewhere"))

    def test_selector_must_be_absolute(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "$FLEET_CONFIG")], document=None,
                           environ={"HOME": HOME, "FLEET_CONFIG": "relative/config.json"},
                           config_path=None)

    def test_missing_selected_file_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_FILE_NOT_FOUND", "$FLEET_CONFIG")], document=None,
                           environ={"HOME": HOME,
                                    "FLEET_CONFIG": str(self.root / "absent.json")})

    def test_directory_as_config_file_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_FILE_NOT_REGULAR", "$FLEET_CONFIG")], document=None,
                           environ={"HOME": HOME, "FLEET_CONFIG": str(self.root)})

    def test_unreadable_file_is_refused(self) -> None:
        if os.name != "posix":
            self.skipTest("a file mode cannot be made unreadable on this platform")
        if os.geteuid() == 0:
            self.skipTest("a root-run suite cannot produce an unreadable file")
        path = Path(self.write_config({"stateDir": "/quiet"}))
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        self.assert_errors([("E_CONFIG_UNREADABLE", "$FLEET_CONFIG")], document=None,
                           environ={"HOME": HOME, "FLEET_CONFIG": str(path)})

    def test_malformed_document_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_MALFORMED", "")], "{ not json")

    def test_document_root_must_be_an_object(self) -> None:
        self.assert_errors([("E_CONFIG_ROOT_TYPE", "")], [1, 2])

    def test_unsupported_version_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_VERSION", "schemaVersion")], {"schemaVersion": 2})

    def test_version_floor_is_enforced(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "schemaVersion")], {"schemaVersion": 0})

    def test_unknown_keys_are_refused_at_every_depth(self) -> None:
        self.assert_errors(
            [("E_CONFIG_UNKNOWN_KEY", "commands.githubh"),
             ("E_CONFIG_UNKNOWN_KEY", "providers[0].hom"),
             ("E_CONFIG_UNKNOWN_KEY", "stateDirr")],
            {"stateDirr": "/quiet", "commands": {"githubh": "gh"},
             "providers": [{"id": "one", "home": HOME, "hom": "typo"}]},
            probe=lambda path: "directory",
        )

    def test_unknown_keys_inside_maps_and_objects_are_refused(self) -> None:
        self.assert_errors(
            [("E_CONFIG_UNKNOWN_KEY", "mods.typing.vocab.bigramMax"),
             ("E_CONFIG_UNKNOWN_KEY", "pane.sections.middle"),
             ("E_CONFIG_UNKNOWN_KEY", "theme.worktrees.abandoned")],
            {"theme": {"worktrees": {"abandoned": "error"}},
             "pane": {"sections": {"middle": {"visible": True}}},
             "mods": {"typing": {"vocab": {"bigramMax": 3}}}},
        )

    def test_an_open_map_takes_a_key_its_list_does_not_carry_and_seeds_the_packaged_ones(self) -> None:
        # The packaged keys are what a partial map inherits, not the only keys
        # it may hold: a model from another vendor, or another generation of one
        # this document knows, is priced by a key no shipped list could carry.
        resolved = self.load({"sources": {"agents": {
            "outputPricePerMTok": {"mythos-1": 7},
            "contextWindowTokens": {"mythos-1": 200000}}}})
        prices = resolved["sources"]["agents"]
        self.assertEqual(prices["outputPricePerMTok"],
                         {"mythos-1": 7, "fable-5-1": 50, "opus-5-5": 20, "opus-5": 25,
                          "opus-4-8": 25, "opus-4-7": 25, "sonnet-5-5": 10, "sonnet-5": 10,
                          "haiku-5-5": 0.5, "haiku-4-5": 5})
        self.assertEqual(prices["contextWindowTokens"],
                         {"mythos-1": 200000, "fable-5-1": 1000000, "opus-5-5": 1000000,
                          "opus-5": 1000000, "opus-4-8": 1000000, "opus-4-7": 1000000,
                          "sonnet-5-5": 1000000, "sonnet-5": 1000000, "haiku-5-5": 1000000,
                          "haiku-4-5": 1000000})

    def test_a_map_without_open_keys_still_refuses_an_unknown_key(self) -> None:
        self.assert_errors([("E_CONFIG_UNKNOWN_KEY", "theme.worktrees.abandoned")],
                           {"theme": {"worktrees": {"abandoned": "error"}}})

    def test_nested_container_type_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_TYPE", "sources")], {"sources": []})

    def test_declared_variable_forms_are_expanded(self) -> None:
        resolved = self.load({"stateDir": "${HOME}/state"})
        self.assertEqual(resolved["stateDir"], path_of("state"))

    def test_relative_value_resolves_against_the_config_directory(self) -> None:
        resolved = self.load({"stateDir": "./state"})
        self.assertEqual(resolved["stateDir"], str(self.root / "state"))

    def test_relative_value_is_normalized(self) -> None:
        resolved = self.load({"stateDir": "./nested/../state"})
        self.assertEqual(resolved["stateDir"], str(self.root / "state"))

    def test_tilde_is_refused_rather_than_guessed(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "stateDir")], {"stateDir": "~/state"})

    def test_shell_expression_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "stateDir")], {"stateDir": "$(pwd)/state"})

    def test_percent_expansion_is_refused_rather_than_taken_literally(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "stateDir")],
                           {"stateDir": "%LOCALAPPDATA%/llm-fleet"})

    def test_undeclared_variable_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_UNRESOLVED_VAR", "stateDir")],
                           {"stateDir": "$FLEET_OTHER/state"})

    def test_unset_declared_variable_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_UNRESOLVED_VAR", "stateDir")],
                           {"stateDir": "$XDG_DATA_HOME/state"})

    def test_argv_entries_stay_literal(self) -> None:
        resolved = self.load({"commands": {"cleanup": ["$HOME/bin/cleanup", "--now"]}})
        self.assertEqual(resolved["commands"]["cleanup"], ["$HOME/bin/cleanup", "--now"])

    def test_empty_argv_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "commands.cleanup")], {"commands": {"cleanup": []}})

    def test_legacy_environment_overrides_are_not_read(self) -> None:
        resolved = self.load(environ={"HOME": HOME, "FLEET_STATE_DIR": "/elsewhere/state",
                                      "FLEET_HOMES": "/elsewhere/homes"})
        self.assertEqual(resolved["stateDir"], path_of(".local/state/llm-fleet"))
        self.assertEqual(resolved["providers"], [])

    def test_loader_follows_the_schema_it_is_given(self) -> None:
        schema = json.loads((PLUGIN / "config" / "schema.json").read_text(encoding="utf-8"))
        schema["fields"].append({"path": "greeting", "type": "string", "default": "hello"})
        custom = self.root / "schema.json"
        custom.write_text(json.dumps(schema), encoding="utf-8")
        accepted = self.load({"greeting": "hi"}, schema_file=str(custom))
        self.assertEqual(accepted["schemaVersion"], 1)
        self.assert_errors([("E_CONFIG_TYPE", "greeting")], {"greeting": 7},
                           schema_file=str(custom))


class ProviderStateTests(ConfigTestCase):
    """A provider home decides readiness; a missing home is never a failure."""

    def ready(self, path):
        return "directory"

    def test_missing_home_is_unavailable_not_failed(self) -> None:
        resolved = self.load({"providers": [{"id": "one", "home": HOME + "/homes/one"}]},
                             probe=lambda path: "missing")
        self.assertEqual(resolved["providers"][0]["state"], "unavailable")
        self.assertEqual(resolved["sources"]["jobs"]["state"], "unconfigured")
        self.assertEqual(resolved["sources"]["jobs"]["providers"], [])

    def test_present_home_is_ready_and_feeds_both_roster_sources(self) -> None:
        resolved = self.load({"providers": [{"id": "one", "home": HOME + "/homes/one"}]},
                             probe=self.ready)
        self.assertEqual(resolved["providers"][0]["state"], "ready")
        self.assertEqual(resolved["sources"]["jobs"]["state"], "ready")
        self.assertEqual(resolved["sources"]["interactive"]["providers"], ["one"])

    def test_disabled_provider_is_disabled_and_not_probed(self) -> None:
        probed = []

        def probe(path):
            probed.append(path)
            return "directory"

        resolved = self.load({"providers": [{"id": "one", "home": HOME + "/homes/one",
                                             "enabled": False}]}, probe=probe)
        self.assertEqual(resolved["providers"][0]["state"], "disabled")
        self.assertEqual(probed, [])

    def test_label_falls_back_to_the_identifier(self) -> None:
        resolved = self.load({"providers": [{"id": "one", "home": HOME + "/homes/one"}]},
                             probe=self.ready)
        self.assertEqual(resolved["providers"][0]["label"], "one")

    def test_enabled_provider_requires_a_home(self) -> None:
        self.assert_errors([("E_CONFIG_REQUIRED", "providers[0].home")],
                           {"providers": [{"id": "one"}]})

    def test_identifier_must_be_present_and_unique(self) -> None:
        self.assert_errors([("E_CONFIG_REQUIRED", "providers[0].home"),
                            ("E_CONFIG_REQUIRED", "providers[0].id")], {"providers": [{}]})
        self.assert_errors(
            [("E_CONFIG_VALUE", "providers[1].id")],
            {"providers": [{"id": "one", "home": HOME}, {"id": "one", "home": HOME}]},
            probe=self.ready,
        )

    def test_identifier_must_not_be_empty(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "providers[0].id")],
                           {"providers": [{"id": "", "home": HOME}]})

    def test_adapter_is_a_declared_choice(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "providers[0].adapter")],
                           {"providers": [{"id": "one", "home": HOME, "adapter": "other"}]})

    def test_ready_provider_list_carries_only_ready_identifiers(self) -> None:
        resolved = self.load(
            {"providers": [{"id": "one", "home": path_of("one")},
                           {"id": "two", "home": path_of("two")}]},
            probe=lambda path: "directory" if path.endswith("one") else "missing",
        )
        self.assertEqual(resolved["sources"]["jobs"]["providers"], ["one"])


class SourceStateTests(ConfigTestCase):
    """Enabled, unconfigured, unavailable, and disabled stay distinct."""

    def test_pause_marker_resolves_home_and_prevents_target_probe(self):
        for name, target in (("progress", "directory"), ("trials", "database")):
            probed = []
            def probe(path):
                probed.append(path)
                return "file"
            source = self.load({"sources": {name: {
                "enabled": True, target: path_of("missing"), "paused_when_exists": "~/paused"
            }}}, probe=probe)["sources"][name]
            self.assertEqual(source["paused_when_exists"], path_of("paused"))
            self.assertEqual(source["state"], "paused")
            self.assertEqual(probed, [path_of("paused")])

    def test_pause_marker_is_optional_nullable_and_validated(self):
        for name in ("progress", "trials"):
            for settings in ({}, {"paused_when_exists": None}):
                source = self.load({"sources": {name: settings}})["sources"][name]
                self.assertIsNone(source.get("paused_when_exists", "missing"))
                self.assertEqual(source["state"], "disabled")
            for value, code in ((7, "E_CONFIG_TYPE"), ("", "E_CONFIG_VALUE"),
                                ("$UNKNOWN/paused", "E_CONFIG_UNRESOLVED_VAR")):
                self.assert_errors([(code, "sources." + name + ".paused_when_exists")],
                                   {"sources": {name: {"paused_when_exists": value}}})

    def test_enabled_source_without_repositories_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_REQUIRED", "sources.prs.repositories")],
                           {"sources": {"prs": {"enabled": True}}})

    def test_enabled_source_without_a_target_path_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_REQUIRED", "sources.trials.database")],
                           {"sources": {"trials": {"enabled": True}}})

    def test_configured_source_targets_become_ready(self) -> None:
        resolved = self.load(
            {"sources": {"prs": {"enabled": True, "repositories": ["owner/project"]},
                         "progress": {"enabled": True, "directory": path_of("progress")},
                         "statusline": {"enabled": True,
                                        "payload": path_of("host-payload.json")}}},
            # The kind each target was declared with, so a directory target is
            # not asked to be a file and a file target is not asked to be one.
            probe=lambda path: "file" if path.endswith(".json") else "directory",
        )
        self.assertEqual(resolved["sources"]["prs"]["state"], "ready")
        self.assertEqual(resolved["sources"]["progress"]["state"], "ready")
        self.assertEqual(resolved["sources"]["statusline"]["state"], "ready")

    def test_an_enabled_source_without_its_target_is_refused(self) -> None:
        # The statusline reads a recorded host payload or the folder where the
        # status line keeps a routed session's priced spend, and one of them is
        # enough: a source switched on with neither is one that can only draw
        # nothing, and it is refused at the source rather than at one field,
        # because neither field is the one it needed.
        self.assert_errors([("E_CONFIG_REQUIRED", "sources.statusline")],
                           {"sources": {"statusline": {"enabled": True}}})
        # Either one alone satisfies it.
        for field, path in (("payload", "host-payload.json"), ("sessionCosts", "statusline")):
            resolved = self.load(
                {"sources": {"statusline": {"enabled": True, field: path_of(path)}}},
                probe=lambda candidate: "file" if candidate.endswith(".json") else "directory",
            )
            self.assertEqual(resolved["sources"]["statusline"]["state"], "ready", field)

    def test_the_statusline_spend_window_is_a_bounded_duration(self) -> None:
        # A window shorter than a minute is a read that prices at most a
        # handful of writes, and a config that names one is a typo rather than
        # a choice, so the floor is declared and enforced like every other bound.
        self.assertEqual(self.load()["sources"]["statusline"]["spendSeconds"], 86400)
        self.assertEqual(self.load({"sources": {"statusline": {"spendSeconds": 60}}})
                         ["sources"]["statusline"]["spendSeconds"], 60)
        for window in (0, 59):
            self.assert_errors([("E_CONFIG_VALUE", "sources.statusline.spendSeconds")],
                               {"sources": {"statusline": {"spendSeconds": window}}})
        self.assert_errors([("E_CONFIG_TYPE", "sources.statusline.spendSeconds")],
                           {"sources": {"statusline": {"spendSeconds": "day"}}})
    def test_a_codex_sessions_folder_alone_satisfies_the_statusline_source(self) -> None:
        # A session running under Codex has no Claude status line payload and no
        # routed-session priced spend: its own rollout folder is where the
        # windows the person is metered by are read. One field, set, is enough.
        resolved = self.load({"sources": {"statusline": {"enabled": True,
                                                         "codexSessions": path_of("codex")}}})
        self.assertEqual(resolved["sources"]["statusline"]["state"], "ready")
        self.assertEqual(resolved["sources"]["statusline"]["codexSessions"],
                         path_of("codex"))
        self.assertIsNone(self.load()["sources"]["statusline"]["codexSessions"])

    def test_wrong_target_kind_is_unavailable(self) -> None:
        resolved = self.load(
            {"sources": {"progress": {"enabled": True, "directory": path_of("not-a-dir")}}},
            probe=lambda path: "file",
        )
        self.assertEqual(resolved["sources"]["progress"]["state"], "unavailable")

    def test_one_missing_array_target_makes_the_source_unavailable(self) -> None:
        resolved = self.load(
            {"sources": {"worktrees": {"enabled": True,
                                       "roots": [path_of("present"), path_of("gone")]}}},
            probe=lambda path: "missing" if path.endswith("gone") else "directory",
        )
        self.assertEqual(resolved["sources"]["worktrees"]["state"], "unavailable")

    def test_disabled_source_is_not_probed_and_keeps_its_value(self) -> None:
        probed = []

        def probe(path):
            probed.append(path)
            return "missing"

        resolved = self.load(
            {"sources": {"skills": {"enabled": False, "directory": path_of("absent")}}},
            probe=probe,
        )
        self.assertEqual(resolved["sources"]["skills"]["state"], "disabled")
        self.assertEqual(resolved["sources"]["skills"]["directory"], path_of("absent"))
        self.assertEqual(probed, [])

    def test_agent_figures_switched_off_read_disabled(self) -> None:
        resolved = self.load({"sources": {"agents": {"enabled": False}}})
        self.assertEqual(resolved["sources"]["agents"]["state"], "disabled")

    def test_agent_prices_take_a_family_the_packaged_list_does_not_carry(self) -> None:
        resolved = self.load({"sources": {"agents": {"outputPricePerMTok": {"mythos": 50}}}})
        self.assertEqual(resolved["sources"]["agents"]["outputPricePerMTok"]["mythos"], 50)
        self.assert_errors([("E_CONFIG_TYPE", "sources.agents.contextWindowTokens.opus")],
                           {"sources": {"agents": {"contextWindowTokens": {"opus": 1.5}}}})

    def test_empty_provider_list_is_unconfigured_not_failed(self) -> None:
        resolved = self.load({"providers": []}, probe=lambda path: "directory")
        self.assertEqual(resolved["providers"], [])
        self.assertEqual(resolved["sources"]["jobs"]["state"], "unconfigured")

    def test_absent_reader_is_not_probed(self) -> None:
        probed = []
        self.load(probe=lambda path: probed.append(path) or "missing")
        self.assertEqual(probed, [])


class ModStateTests(ConfigTestCase):
    """A mod is opt in, and a mod that cannot run here reads unavailable."""

    def test_mods_are_disabled_by_default(self) -> None:
        resolved = self.load()
        for name in ("typing", "secretShield", "contextKeeper", "replyFold"):
            self.assertEqual(resolved["mods"][name]["state"], "disabled", name)

    def test_enabled_mod_on_a_supported_platform_is_ready(self) -> None:
        resolved = self.load({"mods": {"typing": {"enabled": True}}}, platform="darwin")
        self.assertEqual(resolved["mods"]["typing"]["state"], "ready")

    def test_enabled_mod_on_another_platform_is_unavailable(self) -> None:
        resolved = self.load({"mods": {"typing": {"enabled": True}}}, platform="win32")
        self.assertEqual(resolved["mods"]["typing"]["state"], "unavailable")

    def test_platform_rule_only_applies_to_the_declared_value(self) -> None:
        resolved = self.load({"mods": {"typing": {"enabled": True, "speller": "macos"}}},
                             platform="linux")
        self.assertEqual(resolved["mods"]["typing"]["state"], "unavailable")

    def test_enabled_mod_without_the_unresolved_thresholds_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_REQUIRED", "mods.secretShield.minimumLengths")],
                           {"mods": {"secretShield": {"enabled": True}}})

    def test_thresholds_are_accepted_when_the_mod_is_enabled(self) -> None:
        resolved = self.load({"mods": {"secretShield": {"enabled": True,
                                                       "minimumLengths": {"collector": 8,
                                                                          "urlPassword": 6,
                                                                          "masker": 6}}}})
        self.assertEqual(resolved["mods"]["secretShield"]["state"], "ready")
        self.assertEqual(resolved["mods"]["secretShield"]["minimumLengths"]["masker"], 6)

    def test_a_partial_threshold_object_names_the_missing_key(self) -> None:
        self.assert_errors([("E_CONFIG_REQUIRED", "mods.secretShield.minimumLengths.masker")],
                           {"mods": {"secretShield": {"enabled": True,
                                                      "minimumLengths": {"collector": 8,
                                                                         "urlPassword": 6}}}})

    def test_disabled_mod_does_not_require_its_thresholds(self) -> None:
        resolved = self.load({"mods": {"secretShield": {"enabled": False}}})
        self.assertEqual(resolved["mods"]["secretShield"]["state"], "disabled")
        self.assertIsNone(resolved["mods"]["secretShield"]["minimumLengths"])


class LayoutTests(ConfigTestCase):
    """Sections, keys, themes, and speech are validated where the doc says so."""

    def test_section_order_defaults_to_the_documented_order(self) -> None:
        resolved = self.load()
        self.assertEqual(resolved["pane"]["sectionOrder"],
                         ["load", "prs", "sessions", "trials", "running", "session",
                          "worktrees", "skills", "warnings", "governance", "keys"])

    def test_section_collapse_defaults_match_the_pane(self) -> None:
        sections = self.load()["pane"]["sections"]
        for name, expected in (("worktrees", True), ("skills", True), ("keys", True),
                               ("sessions", False), ("running", False)):
            self.assertEqual(sections[name]["collapsed"], expected, name)

    def test_unknown_section_is_refused(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "pane.sectionOrder[0]")],
                           {"pane": {"sectionOrder": ["middle"]}})

    def test_repeated_section_is_refused_by_the_rule(self) -> None:
        self.assert_errors([("E_CONFIG_RULE", "pane.sectionOrder")],
                           {"pane": {"sectionOrder": ["sessions", "sessions"]}})

    def test_repeated_key_binding_is_refused_by_the_rule(self) -> None:
        self.assert_errors([("E_CONFIG_RULE", "keys.collapse")],
                           {"keys": {"collapse": "x"}})

    def test_key_binding_on_a_section_digit_is_refused_by_the_rule(self) -> None:
        # The pane folds its sections with the digits, so a key bound to one
        # loads as a control that never fires unless the load refuses it.
        self.assert_errors([("E_CONFIG_RULE", "keys.close")], {"keys": {"close": "1"}})
        self.assert_errors([("E_CONFIG_RULE", "keys.expand")], {"keys": {"expand": "0"}})
        self.assert_errors([("E_CONFIG_RULE", "keys.collapse"), ("E_CONFIG_RULE", "keys.expand")],
                           {"keys": {"collapse": "9", "expand": "8"}})

    def test_key_binding_beside_the_digits_still_loads(self) -> None:
        keys = self.load({"keys": {"close": "q", "collapse": "z", "expand": "a"}})["keys"]
        self.assertEqual((keys["close"], keys["collapse"], keys["expand"]), ("q", "z", "a"))

    def test_key_binding_must_be_a_single_token(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "keys.close")], {"keys": {"close": "ctrl x"}})

    def test_theme_token_must_be_declared(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "theme.failure")], {"theme": {"failure": "purple"}})
        self.assert_errors([("E_CONFIG_VALUE", "theme.worktrees.held")],
                           {"theme": {"worktrees": {"held": "purple"}}})
        # The host has no token named accent, and a worktree state picks a tone, not a token.
        self.assert_errors([("E_CONFIG_VALUE", "theme.failure")], {"theme": {"failure": "accent"}})
        self.assert_errors([("E_CONFIG_VALUE", "theme.worktrees.held")],
                           {"theme": {"worktrees": {"held": "warning"}}})
        resolved = self.load({"theme": {"waiting": "claude", "worktrees": {"held": "failure"}}})
        self.assertEqual(resolved["theme"]["waiting"], "claude")
        self.assertEqual(resolved["theme"]["worktrees"]["held"], "failure")
        self.assertEqual(resolved["theme"]["worktrees"]["active"], "working")
        self.assertNotIn("running", resolved["theme"])

    def test_color_triple_is_three_bytes(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "alerts.tabTint.failureRgb")],
                           {"alerts": {"tabTint": {"failureRgb": [1, 2]}}})
        self.assert_errors([("E_CONFIG_VALUE", "alerts.tabTint.waitingRgb[1]")],
                           {"alerts": {"tabTint": {"waitingRgb": [1, 999, 3]}}})

    def test_a_tab_tint_entry_goes_stale_after_at_least_thirty_seconds(self) -> None:
        # The heartbeat says each level again every third of it: below thirty
        # seconds a session would run the helper more than every ten.
        for stale in (0, 29):
            self.assert_errors([("E_CONFIG_VALUE", "alerts.tabTint.staleSeconds")],
                               {"alerts": {"tabTint": {"staleSeconds": stale}}})
        self.assertEqual(self.load({"alerts": {"tabTint": {"staleSeconds": 30}}})
                         ["alerts"]["tabTint"]["staleSeconds"], 30)
        self.assert_errors([("E_CONFIG_TYPE", "alerts.tabTint.staleSeconds")],
                           {"alerts": {"tabTint": {"staleSeconds": "soon"}}})

    def test_numeric_bounds_are_enforced(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "mods.contextKeeper.keepThreshold")],
                           {"mods": {"contextKeeper": {"keepThreshold": 1.5}}})
        self.assert_errors([("E_CONFIG_VALUE", "pane.minimumColumns")],
                           {"pane": {"minimumColumns": 0}})

    def test_the_reply_bounds_and_task_lines_have_defaults_and_floors(self):
        pane = self.load({})["pane"]
        self.assertEqual((pane["replyMaxChars"], pane["replyPendingSeconds"], pane["fanLines"]),
                         (4000, 120, 4))
        # A reply is held by a marker no time takes back, so there is no claim time.
        self.assertNotIn("replyClaimSeconds", pane)
        # No task lines at all is a choice: the tasks are then only counted.
        self.assertEqual(self.load({"pane": {"fanLines": 0}})["pane"]["fanLines"], 0)
        self.assert_errors([("E_CONFIG_VALUE", "pane.fanLines")], {"pane": {"fanLines": -1}})
        self.assert_errors([("E_CONFIG_VALUE", "pane.replyMaxChars")],
                           {"pane": {"replyMaxChars": 0}})
        self.assert_errors([("E_CONFIG_VALUE", "pane.replyPendingSeconds")],
                           {"pane": {"replyPendingSeconds": 0}})
        self.assert_errors([("E_CONFIG_UNKNOWN_KEY", "pane.replyClaimSeconds")],
                           {"pane": {"replyClaimSeconds": 30}})

    def test_the_job_state_bound_holds_at_least_an_empty_record(self) -> None:
        # A bound smaller than an empty job-state record would refuse every
        # record the roster writes, so every job would date afresh each read.
        self.assert_errors([("E_CONFIG_VALUE", "limits.jobStateBytes")],
                           {"limits": {"jobStateBytes": 1023}})
        self.assertEqual(self.load({"limits": {"jobStateBytes": 1024}})["limits"]["jobStateBytes"],
                         1024)

    def test_a_kept_job_time_may_lead_the_read_by_a_bounded_skew(self) -> None:
        self.assertEqual(self.load()["limits"]["jobStateClockSkewSeconds"], 300)
        self.assertEqual(self.load({"limits": {"jobStateClockSkewSeconds": 0}})
                         ["limits"]["jobStateClockSkewSeconds"], 0)
        self.assert_errors([("E_CONFIG_VALUE", "limits.jobStateClockSkewSeconds")],
                           {"limits": {"jobStateClockSkewSeconds": -1}})

    def test_the_series_timeline_event_and_check_bounds_have_defaults_and_limits(self) -> None:
        resolved = self.load()
        history = resolved["history"]
        self.assertEqual((history["spendWindowHours"], history["spendBucketMinutes"],
                          history["timelineIdleMinutes"], history["timelineSegmentLimit"],
                          history["eventLimit"]), (24, 60, 5, 48, 50))
        self.assertEqual(resolved["sources"]["prs"]["checkRunLimit"], 12)
        # No dots at all is a choice: every check is then only counted.
        self.assertEqual(self.load({"sources": {"prs": {"checkRunLimit": 0}}})
                         ["sources"]["prs"]["checkRunLimit"], 0)
        for path, value in (("history.spendWindowHours", 0), ("history.spendWindowHours", 169),
                            ("history.spendBucketMinutes", 0),
                            ("history.spendBucketMinutes", 1441),
                            ("history.timelineIdleMinutes", 0),
                            ("history.timelineSegmentLimit", 0), ("history.eventLimit", 0),
                            ("sources.prs.checkRunLimit", -1),
                            ("sources.prs.checkRunLimit", 101)):
            document: dict = {}
            set_path(document, path, value)
            self.assert_errors([("E_CONFIG_VALUE", path)], document)
        self.assert_errors([("E_CONFIG_TYPE", "history.eventLimit")],
                           {"history": {"eventLimit": 2.5}})

    def test_voice_must_belong_to_the_selected_group(self) -> None:
        self.assert_errors([("E_CONFIG_RULE", "speech.voice")],
                           {"speech": {"group": "female", "voice": "am_onyx"}})
        self.assert_errors([("E_CONFIG_RULE", "speech.voice")],
                           {"speech": {"group": "male", "voice": "not-a-voice"}})

    def test_voice_in_the_selected_group_is_accepted(self) -> None:
        resolved = self.load({"speech": {"group": "male", "voice": "am_onyx"}})
        self.assertEqual(resolved["speech"]["voice"], "am_onyx")

    def test_speech_backend_and_group_are_declared_choices(self) -> None:
        self.assert_errors([("E_CONFIG_VALUE", "speech.backend")], {"speech": {"backend": "system"}})
        self.assert_errors([("E_CONFIG_VALUE", "speech.group")], {"speech": {"group": "robot"}})
        resolved = self.load({"speech": {"enabled": True}})
        self.assertFalse(resolved["speech"]["enabled"] is False)

    def test_tones_default_to_silence(self) -> None:
        self.assertIsNone(self.load()["alerts"]["tones"])


class FixtureParityTests(ConfigTestCase):
    """One corpus, both loaders, one expectation per case."""

    def cases(self):
        return sorted(path for path in FIXTURES.iterdir() if path.is_dir())

    def python_result(self, directory: Path) -> dict:
        spec = json.loads((directory / "env.json").read_text(encoding="utf-8"))
        environ, kinds, platform = expand_fixture(directory, spec)
        try:
            resolved = load_config(environ=environ, probe=lambda path: kinds.get(path, "missing"),
                                   platform=platform)
        except ConfigError as failure:
            return {"errors": failure.errors}
        return {"config": resolved}

    def typescript_result(self, directory: Path, node: str) -> dict:
        completed = subprocess.run(
            [node, str(RUNNER), "--fixture", str(directory)],
            capture_output=True, text=True, check=False,
        )
        if completed.returncode != 0:
            self.fail("parity runner failed for {0}: {1}".format(directory.name, completed.stderr))
        return json.loads(completed.stdout)

    def expected(self, directory: Path) -> dict:
        """The fixture's statement merged onto the defaults the schema declares."""
        stated = json.loads((directory / "expected.json").read_text(encoding="utf-8"))
        if "errors" in stated:
            return stated
        return {"config": deep_merge(declared_baseline(self.schema), stated["config"])}

    def comparable(self, result: Any, directory: Path) -> Any:
        result = normalize_payload(result, self.schema, directory)
        if "errors" in result:
            return {"errors": [(entry["code"], entry["path"]) for entry in result["errors"]]}
        return result

    def test_python_loader_matches_every_fixture(self) -> None:
        for directory in self.cases():
            with self.subTest(case=directory.name):
                self.assertEqual(self.comparable(self.python_result(directory), directory),
                                 self.comparable(self.expected(directory), directory))

    def test_typescript_loader_matches_every_fixture_and_agrees_with_python(self) -> None:
        node, detail = node_runtime()
        if node is None:
            if os.environ.get("FLEET_CONFIG_REQUIRE_NODE"):
                self.fail("TypeScript parity required but unavailable: " + detail)
            self.skipTest("TypeScript loader not verified: " + detail)
        for directory in self.cases():
            with self.subTest(case=directory.name):
                from_typescript = self.typescript_result(directory, node)
                self.assertEqual(self.comparable(from_typescript, directory),
                                 self.comparable(self.expected(directory), directory))
                self.assertEqual(from_typescript, self.python_result(directory))


if __name__ == "__main__":
    unittest.main()
