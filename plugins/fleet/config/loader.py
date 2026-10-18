#!/usr/bin/env python3
"""Load, validate, and resolve the versioned llm-fleet configuration.

`schema.json`, beside this module, is the single source of truth read by it and
by the repository's `config/loader.ts`. This module and the schema sit in the
plugin folder because an install copies that folder alone. Neither loader
carries per-key policy, and neither reads a legacy environment override: the
override names are recorded in the schema for the migration row, and this
loader ignores them by design.

Resolution is pure apart from one injected path probe and the platform name.
Nothing here starts a process, reads a provider home, or contacts a network. A
resolved source or mod is described by one of the declared states, and an
unavailable group is never reported as an empty one.
"""

from __future__ import annotations

from functools import lru_cache
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, Callable


SCHEMA_NAME = "schema.json"
ROOT_PATH = ""

PROVIDER_STATES = ("disabled", "unavailable", "ready")
SOURCE_STATES = ("disabled", "unconfigured", "unavailable", "ready", "paused")
MOD_STATES = ("disabled", "unavailable", "ready")

CODE_VERSION = "E_CONFIG_VERSION"
CODE_FILE_NOT_FOUND = "E_CONFIG_FILE_NOT_FOUND"
CODE_FILE_NOT_REGULAR = "E_CONFIG_FILE_NOT_REGULAR"
CODE_UNREADABLE = "E_CONFIG_UNREADABLE"
CODE_MALFORMED = "E_CONFIG_MALFORMED"
CODE_ROOT_TYPE = "E_CONFIG_ROOT_TYPE"
CODE_UNKNOWN_KEY = "E_CONFIG_UNKNOWN_KEY"
CODE_TYPE = "E_CONFIG_TYPE"
CODE_VALUE = "E_CONFIG_VALUE"
CODE_REQUIRED = "E_CONFIG_REQUIRED"
CODE_UNRESOLVED_VAR = "E_CONFIG_UNRESOLVED_VAR"
CODE_RULE = "E_CONFIG_RULE"

INVALID = object()
SKIP = object()
Probe = Callable[[str], str]
_VARIABLE = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
# A percent-delimited name is another platform's expansion form. It is refused
# rather than passed through as a literal directory name.
_PERCENT_VARIABLE = re.compile(r"%[A-Za-z_][A-Za-z0-9_]*%")


class ConfigError(ValueError):
    """The configuration cannot be trusted to describe this machine.

    `errors` holds every refusal in a canonical order: sorted by field path,
    then by code. Message text is not part of the cross-language contract.
    """

    def __init__(self, errors: list[dict[str, str]]) -> None:
        self.errors = sorted(errors, key=lambda entry: (entry["path"], entry["code"]))
        detail = "; ".join(
            "{0}: {1}".format(entry["path"] or "(root)", entry["code"]) for entry in self.errors
        )
        super().__init__("configuration refused: " + detail)


def error(code: str, path: str) -> dict[str, str]:
    """Build one refusal entry."""
    return {"code": code, "path": path}


def schema_path() -> Path:
    """Location of the packaged schema beside this module."""
    return Path(__file__).resolve().parent / SCHEMA_NAME


@lru_cache(maxsize=4)
def load_schema(path: str = "") -> dict[str, Any]:
    """Read the schema. A broken schema is a packaging defect, not user error."""
    location = Path(path) if path else schema_path()
    try:
        data = json.loads(location.read_text(encoding="utf-8"))
    except OSError as caught:
        raise ConfigError([error(CODE_UNREADABLE, "schema")]) from caught
    except json.JSONDecodeError as caught:
        raise ConfigError([error(CODE_MALFORMED, "schema")]) from caught
    if not isinstance(data, dict):
        raise ConfigError([error(CODE_ROOT_TYPE, "schema")])
    return data


def filesystem_probe(path: str) -> str:
    """Report what a path is, without raising on permission or absence."""
    try:
        if os.path.isdir(path):
            return "directory"
        if os.path.exists(path):
            return "file"
    except OSError:
        return "missing"
    return "missing"


def _environment(environ: dict[str, str] | None) -> dict[str, str]:
    source = os.environ if environ is None else environ
    return {key: value for key, value in source.items() if isinstance(value, str)}


def _expand(value: str, environ: dict[str, str],
            variables: tuple[str, ...]) -> tuple[str | None, str | None]:
    """Expand declared variables only. Returns (text, None) or (None, code)."""
    if value.startswith("~") or _PERCENT_VARIABLE.search(value):
        return None, CODE_VALUE
    parts: list[str] = []
    index = 0
    for match in _VARIABLE.finditer(value):
        gap = value[index:match.start()]
        if "$" in gap:
            return None, CODE_VALUE
        name = match.group(1) or match.group(2)
        replacement = environ.get(name)
        if name not in variables or not replacement:
            return None, CODE_UNRESOLVED_VAR
        parts.append(gap)
        parts.append(replacement)
        index = match.end()
    tail = value[index:]
    if "$" in tail:
        return None, CODE_VALUE
    parts.append(tail)
    return "".join(parts), None


def _resolve_path(value: str, config_directory: str | None, environ: dict[str, str],
                  variables: tuple[str, ...]) -> tuple[str | None, str | None]:
    expanded, failure = _expand(value, environ, variables)
    if failure is not None or expanded is None:
        return None, failure or CODE_VALUE
    if not expanded:
        return None, CODE_VALUE
    if os.path.isabs(expanded):
        return os.path.normpath(expanded), None
    if config_directory is None:
        return None, CODE_VALUE
    return os.path.normpath(os.path.join(config_directory, expanded)), None


class _Context:
    """Shared resolution inputs for one load."""

    def __init__(self, schema: dict[str, Any], environ: dict[str, str],
                 config_directory: str | None, platform: str) -> None:
        self.schema = schema
        self.environ = environ
        self.variables = tuple(schema["environment"]["variables"])
        self.config_directory = config_directory
        self.platform = platform
        self.state_dir: str | None = None


def _default_value(field: dict[str, Any], context: _Context) -> tuple[Any, str | None]:
    """The declared default, (None, code) when unresolvable, or (SKIP, None).

    A default that depends on a value that already failed is skipped: the cause
    is reported once, at the field that owns it.
    """
    default = field.get("default")
    if isinstance(default, dict) and "firstResolvable" in default:
        for candidate in default["firstResolvable"]:
            if _expand(candidate, context.environ, context.variables)[1] is None:
                return candidate, None
        return None, CODE_UNRESOLVED_VAR
    if isinstance(default, dict) and "resolvedBy" in default:
        if default["resolvedBy"] == "systemTemp":
            return os.path.normpath(tempfile.gettempdir()), None
        if default["resolvedBy"] == "underStateDir":
            if context.state_dir is None:
                return SKIP, None
            return os.path.normpath(os.path.join(context.state_dir, default["relative"])), None
        return None, CODE_VALUE
    return default, None


def _scalar(field: dict[str, Any], value: Any, context: _Context, path: str,
            errors: list[dict[str, str]]) -> Any:
    kind = field["type"]
    if value is None:
        if field.get("nullable"):
            return None
        errors.append(error(CODE_TYPE, path))
        return INVALID
    if kind == "boolean":
        if not isinstance(value, bool):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        return value
    if kind == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        if "minimum" in field and value < field["minimum"]:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        if "maximum" in field and value > field["maximum"]:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        if field.get("version") and value not in context.schema["supportedSchemaVersions"]:
            errors.append(error(CODE_VERSION, path))
            return INVALID
        return value
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        if "minimum" in field and value < field["minimum"]:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        if "maximum" in field and value > field["maximum"]:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        return value
    if kind == "string":
        if not isinstance(value, str):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        if field.get("nonEmpty") and not value:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        if "values" in field and value not in field["values"]:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        return value
    if kind == "key":
        if not isinstance(value, str):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        if not value or any(character.isspace() for character in value):
            errors.append(error(CODE_VALUE, path))
            return INVALID
        return value
    if kind == "path":
        if not isinstance(value, str):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        if field.get("expandHome") and (value == "~" or value.startswith("~/")
                or (os.name == "nt" and value.startswith("~\\"))):
            value = "$HOME" + value[1:]
        resolved, failure = _resolve_path(value, context.config_directory,
                                          context.environ, context.variables)
        if failure is not None:
            errors.append(error(failure, path))
            return INVALID
        return resolved
    if kind == "argv":
        if not isinstance(value, list):
            errors.append(error(CODE_TYPE, path))
            return INVALID
        if not value:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        for index, item in enumerate(value):
            if not isinstance(item, str) or not item:
                errors.append(error(CODE_VALUE, "{0}[{1}]".format(path, index)))
                return INVALID
        return list(value)
    errors.append(error(CODE_VALUE, path))
    return INVALID


def _array(field: dict[str, Any], value: Any, context: _Context, path: str,
           errors: list[dict[str, str]]) -> Any:
    kind = field["type"]
    if not isinstance(value, list):
        errors.append(error(CODE_TYPE, path))
        return INVALID
    if kind == "rgb":
        if len(value) != 3:
            errors.append(error(CODE_VALUE, path))
            return INVALID
        for index, item in enumerate(value):
            if isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= 255:
                errors.append(error(CODE_VALUE, "{0}[{1}]".format(path, index)))
                return INVALID
        return list(value)
    if kind == "sectionArray":
        resolved: list[str] = []
        for index, item in enumerate(value):
            item_path = "{0}[{1}]".format(path, index)
            if not isinstance(item, str):
                errors.append(error(CODE_TYPE, item_path))
                continue
            # A custom section is named by its prefix here and checked against
            # the sections the document declares by a rule, which can see both.
            opened = field.get("openPrefix")
            if item not in context.schema["sections"] \
                    and not (opened and item.startswith(opened)):
                errors.append(error(CODE_VALUE, item_path))
                continue
            resolved.append(item)
        return resolved
    resolved = []
    for index, item in enumerate(value):
        item_path = "{0}[{1}]".format(path, index)
        if not isinstance(item, str):
            errors.append(error(CODE_TYPE, item_path))
            continue
        if kind == "stringArray":
            if not item:
                errors.append(error(CODE_VALUE, item_path))
                continue
            resolved.append(item)
            continue
        expanded, failure = _resolve_path(item, context.config_directory,
                                          context.environ, context.variables)
        if failure is not None or expanded is None:
            errors.append(error(failure or CODE_VALUE, item_path))
            continue
        resolved.append(expanded)
    required = field.get("mustInclude")
    if isinstance(required, list) and any(item not in resolved for item in required):
        errors.append(error(CODE_RULE, path))
    return resolved


def _map_field(field: dict[str, Any], value: Any, context: _Context, path: str,
               errors: list[dict[str, str]]) -> Any:
    if value is None and field.get("nullable"):
        return None
    if not isinstance(value, dict):
        errors.append(error(CODE_TYPE, path))
        return INVALID
    inner = {"type": field["valueType"]}
    if "valueValues" in field:
        inner["values"] = field["valueValues"]
    resolved: dict[str, Any] = {}
    for key, item in value.items():
        key_path = path + "." + key
        # A closed map names every key it may hold, so a key outside the list is
        # a typo and is refused. An open map lists the keys it ships a default
        # for and takes any other: a document adds what the packaged list cannot
        # name ahead of time, such as the family of another vendor's model.
        if "keyValues" in field and key not in field["keyValues"] and not field.get("openKeys"):
            errors.append(error(CODE_UNKNOWN_KEY, key_path))
            continue
        checked = _scalar(inner, item, context, key_path, errors)
        if checked is not INVALID:
            resolved[key] = checked
    fallback = field.get("default")
    if isinstance(fallback, dict):
        for key, item in fallback.items():
            resolved.setdefault(key, item)
    return resolved


def _inherited(fallback: dict[str, Any], key: str, item: Any) -> Any:
    """A record's own document, over the one the schema ships for that key.

    An object whose records are declared by descriptor also ships one of them per
    key, and that shipped record is the answer for every field the document does
    not name: a person who sets one field of a section means to change that field
    and not to blank the rest. Resolving a named record against the descriptor's
    own default instead made every unnamed field the schema's generic stand-in,
    so hiding one section renamed it "Section".
    """
    shipped = fallback.get(key)
    if not isinstance(shipped, dict) or not isinstance(item, dict):
        return item
    return {**shipped, **item}


def _record(fields: list[dict[str, Any]], value: Any, context: _Context, path: str,
            errors: list[dict[str, str]]) -> dict[str, Any]:
    """One record whose keys are declared by descriptor, not by the document."""
    if not isinstance(value, dict):
        errors.append(error(CODE_TYPE, path))
        return {}
    declared = {entry["name"]: entry for entry in fields}
    resolved: dict[str, Any] = {}
    for key, item in value.items():
        key_path = path + "." + key
        if key not in declared:
            errors.append(error(CODE_UNKNOWN_KEY, key_path))
            continue
        resolved[key] = _scalar(declared[key], item, context, key_path, errors)
    for name, field in declared.items():
        if name in resolved:
            continue
        if "default" in field:
            resolved[name] = field["default"]
        else:
            errors.append(error(CODE_REQUIRED, path + "." + name))
    return resolved


def _object_field(field: dict[str, Any], value: Any, context: _Context, path: str,
                  errors: list[dict[str, str]]) -> Any:
    if value is None and field.get("nullable"):
        return None
    if not isinstance(value, dict):
        errors.append(error(CODE_TYPE, path))
        return INVALID
    declared = {entry["name"]: entry for entry in field.get("valueFields", [])}
    fallback: dict[str, Any] = {}
    if isinstance(field.get("default"), dict):
        fallback = field["default"]
    resolved: dict[str, Any] = {}
    for key, item in value.items():
        key_path = path + "." + key
        if "keyValues" in field and key not in field["keyValues"]:
            errors.append(error(CODE_UNKNOWN_KEY, key_path))
            continue
        if "recordFields" in field:
            resolved[key] = _record(field["recordFields"], _inherited(fallback, key, item),
                                    context, key_path, errors)
            continue
        if "valueFields" in field:
            if key not in declared:
                continue
            resolved[key] = _scalar(declared[key], item, context, key_path, errors)
            continue
        inner = {"type": field["valueType"]}
        if field["valueType"] in ("stringArray", "pathArray"):
            resolved[key] = _array(inner, item, context, key_path, errors)
        else:
            resolved[key] = _scalar(inner, item, context, key_path, errors)
    for key in field.get("keyValues", []):
        if key in resolved:
            continue
        key_path = path + "." + key
        if key in fallback:
            resolved[key] = fallback[key]
            continue
        if "recordFields" in field:
            resolved[key] = _record(field["recordFields"], {}, context, key_path, errors)
            continue
        if "valueFields" in field and key in declared:
            if "default" in declared[key]:
                resolved[key] = declared[key]["default"]
            else:
                errors.append(error(CODE_REQUIRED, key_path))
            continue
        errors.append(error(CODE_REQUIRED, key_path))
    return resolved


def _field_value(field: dict[str, Any], value: Any, context: _Context, path: str,
                 errors: list[dict[str, str]], probe: Probe) -> Any:
    kind = field["type"]
    if kind == "providerArray":
        return _providers(value, context, path, errors, probe)
    if kind in ("stringArray", "pathArray", "sectionArray", "rgb"):
        return _array(field, value, context, path, errors)
    if kind == "map":
        return _map_field(field, value, context, path, errors)
    if kind == "object":
        return _object_field(field, value, context, path, errors)
    return _scalar(field, value, context, path, errors)


def _providers(value: Any, context: _Context, path: str, errors: list[dict[str, str]],
               probe: Probe) -> Any:
    if not isinstance(value, list):
        errors.append(error(CODE_TYPE, path))
        return INVALID
    declared = {field["name"]: field for field in context.schema["providerFields"]}
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        item_path = "{0}[{1}]".format(path, index)
        if not isinstance(item, dict):
            errors.append(error(CODE_TYPE, item_path))
            continue
        for key in item:
            if key not in declared:
                errors.append(error(CODE_UNKNOWN_KEY, item_path + "." + key))
        resolved: dict[str, Any] = {}
        for name, field in declared.items():
            key_path = item_path + "." + name
            if name not in item:
                resolved[name] = field.get("default")
                if field.get("required"):
                    errors.append(error(CODE_REQUIRED, key_path))
                continue
            resolved[name] = _scalar(field, item[name], context, key_path, errors)
        for name, field in declared.items():
            if field.get("requiredWhenEnabled") and name not in item and resolved.get("enabled") is True:
                errors.append(error(CODE_REQUIRED, item_path + "." + name))
        identifier = resolved.get("id")
        if not isinstance(identifier, str):
            continue
        if identifier in seen:
            errors.append(error(CODE_VALUE, item_path + ".id"))
            continue
        seen.add(identifier)
        if not isinstance(resolved.get("label"), str):
            resolved["label"] = identifier
        home = resolved.get("home")
        if resolved.get("enabled") is not True:
            resolved["state"] = "disabled"
        elif isinstance(home, str) and probe(home) == "directory":
            resolved["state"] = "ready"
        else:
            resolved["state"] = "unavailable"
        entries.append(resolved)
    return entries


def _lookup(source: dict[str, Any], path: str) -> tuple[bool, Any]:
    current: Any = source
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
    return True, current


def _unknown_keys(source: dict[str, Any], known: frozenset[str], prefix: str,
                  errors: list[dict[str, str]]) -> None:
    for key, value in source.items():
        path = prefix + "." + key if prefix else key
        if path in known:
            continue
        if any(candidate.startswith(path + ".") for candidate in known):
            if isinstance(value, dict):
                _unknown_keys(value, known, path, errors)
            else:
                errors.append(error(CODE_TYPE, path))
            continue
        errors.append(error(CODE_UNKNOWN_KEY, path))


def _group_state(group: dict[str, Any], values: dict[str, Any],
                 providers: list[dict[str, Any]], probe: Probe, platform: str,
                 errors: list[dict[str, str]]) -> str | None:
    if values.get("enabled") is not True:
        return "disabled"
    incomplete = False
    for rule in group.get("requires", []):
        if "anyPresent" in rule:
            # Some sources can be satisfied by either of two settings, and one
            # of them is enough: a status line hands over a recorded payload or
            # a folder of priced sessions, and either names what the source
            # reads. Neither present is the misconfiguration this refuses.
            names = rule["anyPresent"]
            if all(values.get(name) is None for name in names):
                incomplete = True
                errors.append(error(CODE_REQUIRED, group["path"]))
            continue
        name = rule["field"]
        value = values.get(name)
        empty = value is None or value == "" or (isinstance(value, list) and not value)
        unmet = empty if rule.get("nonEmpty") else value is None
        if unmet:
            incomplete = True
            errors.append(error(CODE_REQUIRED, "{0}.{1}".format(group["path"], name)))
    if incomplete:
        return None
    marker = values.get(group.get("pausedWhenExists"))
    if marker and probe(marker) != "missing":
        return "paused"
    if group.get("requiresReadyProvider") and not any(
            entry.get("state") == "ready" for entry in providers):
        return "unconfigured"
    platform_rule = group.get("platform")
    if platform_rule and values.get(platform_rule["field"]) in platform_rule["requires"] \
            and platform not in platform_rule["supported"]:
        return "unavailable"
    for target in group.get("targets", []):
        candidates = values.get(target["field"])
        if target.get("array"):
            paths = candidates if isinstance(candidates, list) else []
        else:
            paths = [candidates]
        for candidate in paths:
            # A target nobody configured is not a target to check: a source with
            # two ways in, one of them set, is satisfied by the one it has.
            if candidate is None:
                continue
            if not candidate or probe(candidate) != target["kind"]:
                return "unavailable"
    return "ready"


def _apply_rules(schema: dict[str, Any], flat: dict[str, Any],
                 errors: list[dict[str, str]]) -> None:
    """Cross-field checks the schema declares, so neither loader hardcodes them."""
    for rule in schema["rules"]:
        name = rule["rule"]
        if name == "memberOf":
            value = flat.get(rule["field"])
            container = flat.get(rule["container"])
            group = flat.get(rule["by"])
            if value is None or not isinstance(container, dict):
                continue
            allowed = container.get(group)
            if isinstance(allowed, list) and value not in allowed:
                errors.append(error(CODE_RULE, rule["field"]))
            continue
        if name == "distinct":
            seen: set[Any] = set()
            for path in rule["fields"]:
                value = flat.get(path)
                if value is None:
                    continue
                if value in seen:
                    errors.append(error(CODE_RULE, path))
                seen.add(value)
            continue
        if name == "reserved":
            # Values another part of the system already binds, such as the
            # digits the pane folds its sections with: a field holding one
            # loads as a control that never fires.
            for path in rule["fields"]:
                if flat.get(path) in rule["values"]:
                    errors.append(error(CODE_RULE, path))
            continue
        if name == "distinctValues":
            value = flat.get(rule["field"])
            if isinstance(value, list) and len(set(value)) != len(value):
                errors.append(error(CODE_RULE, rule["field"]))
            continue
        if name == "sectionsDeclared":
            # Each declared section's name is plain enough to address, and each
            # one the order names is declared.
            container = flat.get(rule["container"])
            names = list(container) if isinstance(container, dict) else []
            pattern = re.compile(rule["keyPattern"])
            for key in names:
                if not pattern.fullmatch(key):
                    errors.append(error(CODE_RULE, rule["container"] + "." + key))
            order = flat.get(rule["field"])
            if isinstance(order, list):
                for index, item in enumerate(order):
                    if isinstance(item, str) and item.startswith(rule["prefix"]) \
                            and item[len(rule["prefix"]):] not in names:
                        errors.append(error(CODE_RULE, "{0}[{1}]".format(rule["field"], index)))
    return None


ORIGIN_ARGUMENT = "argument"
ORIGIN_ENVIRONMENT = "environment"
ORIGIN_DEFAULT = "default"
ORIGIN_NONE = "none"


def _default_place(environment: dict[str, str], schema: dict[str, Any]) -> str | None:
    """The first default place whose variables resolve here: where a file is looked for."""
    variables = tuple(schema["environment"]["variables"])
    for candidate in schema["configFile"]["firstResolvable"]:
        expanded, failure = _expand(candidate, environment, variables)
        if failure is None and expanded:
            return expanded
    return None


def _select_config(selector_path: str | None, environment: dict[str, str],
                   schema: dict[str, Any],
                   errors: list[dict[str, str]]) -> tuple[str | None, str]:
    """Return (the file to read, why that one). None with no refusal means defaults."""
    selector = schema["environment"]["selector"]
    variables = tuple(schema["environment"]["variables"])
    if selector_path is not None:
        return selector_path, ORIGIN_ARGUMENT
    if selector in environment:
        expanded, failure = _expand(environment[selector], environment, variables)
        if failure is not None:
            errors.append(error(failure, "$" + selector))
            return None, ORIGIN_ENVIRONMENT
        if expanded is None or not os.path.isabs(expanded):
            errors.append(error(CODE_VALUE, "$" + selector))
            return None, ORIGIN_ENVIRONMENT
        return expanded, ORIGIN_ENVIRONMENT
    place = _default_place(environment, schema)
    if place is not None and os.path.isfile(place):
        return place, ORIGIN_DEFAULT
    return None, ORIGIN_NONE


def config_location(config_path: str | None = None, environ: dict[str, str] | None = None,
                    schema_file: str | None = None) -> dict[str, Any]:
    """Where the configuration is read from, and why, without reading it.

    `path` is the file a load reads, or with origin `none` the default place a
    file would be looked for, which is where a starter file belongs. `errors` holds
    a refusal of the selector itself, such as a relative path in it.
    """
    schema = load_schema(schema_file or "")
    environment = _environment(environ)
    errors: list[dict[str, str]] = []
    selected, origin = _select_config(config_path, environment, schema, errors)
    if selected is None and origin == ORIGIN_NONE:
        selected = _default_place(environment, schema)
    if selected is not None and origin in (ORIGIN_DEFAULT, ORIGIN_NONE):
        # The schema writes its default places with forward slashes; on Windows
        # that leaves a mixed path, shown to a person and written to by setup.
        selected = os.path.normpath(selected)
    return {"path": selected, "origin": origin, "errors": errors}


def _read_config(selector_path: str | None, environment: dict[str, str],
                 schema: dict[str, Any],
                 errors: list[dict[str, str]]) -> tuple[str | None, dict[str, Any]]:
    """Return (config directory, raw document). An absent file means defaults."""
    selector = schema["environment"]["selector"]
    selected, _ = _select_config(selector_path, environment, schema, errors)
    if selected is None:
        return None, {}
    location = Path(selected)
    if not location.exists():
        errors.append(error(CODE_FILE_NOT_FOUND, "$" + selector))
        return None, {}
    if not location.is_file():
        errors.append(error(CODE_FILE_NOT_REGULAR, "$" + selector))
        return None, {}
    try:
        text = location.read_text(encoding="utf-8")
    except OSError:
        errors.append(error(CODE_UNREADABLE, "$" + selector))
        return None, {}
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        errors.append(error(CODE_MALFORMED, ROOT_PATH))
        return None, {}
    if not isinstance(document, dict):
        errors.append(error(CODE_ROOT_TYPE, ROOT_PATH))
        return None, {}
    return os.path.dirname(os.path.abspath(selected)), document


def _assemble(schema: dict[str, Any], flat: dict[str, Any], probe: Probe, platform: str,
              errors: list[dict[str, str]]) -> dict[str, Any]:
    """Build the resolved tree and annotate every enabled group with its state."""
    resolved: dict[str, Any] = {}
    for path, value in flat.items():
        node = resolved
        parts = path.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    providers = flat.get("providers", [])
    for group in schema["sources"] + schema["mods"]:
        node = resolved
        for part in group["path"].split("."):
            node = node[part]
        values = dict(node)
        annotated: dict[str, Any] = {"enabled": values.get("enabled")}
        annotated["state"] = _group_state(group, values, providers, probe, platform, errors)
        for name in group["fields"]:
            if name != "enabled":
                annotated[name] = values.get(name)
        if group.get("requiresReadyProvider"):
            annotated["providers"] = [entry["id"] for entry in providers
                                      if entry.get("state") == "ready"]
        node.clear()
        node.update(annotated)
    return resolved


def load_config(config_path: str | None = None, environ: dict[str, str] | None = None,
                probe: Probe | None = None, schema_file: str | None = None,
                platform: str | None = None) -> dict[str, Any]:
    """Resolve the configuration, or raise ConfigError carrying every refusal.

    `schema_file` and `platform` exist so a test can prove the loader follows the
    contract it is given, and resolve a platform rule, without editing this module.
    """
    schema = load_schema(schema_file or "")
    environment = _environment(environ)
    path_probe = filesystem_probe if probe is None else probe
    errors: list[dict[str, str]] = []
    config_directory, document = _read_config(config_path, environment, schema, errors)
    context = _Context(schema, environment, config_directory,
                       sys.platform if platform is None else platform)
    known = frozenset(field["path"] for field in schema["fields"])
    _unknown_keys(document, known, ROOT_PATH, errors)
    flat: dict[str, Any] = {}
    for field in schema["fields"]:
        path = field["path"]
        present, raw = _lookup(document, path)
        if not present:
            raw, failure = _default_value(field, context)
            if raw is SKIP:
                continue
            if failure is not None:
                errors.append(error(failure, path))
                continue
        value = _field_value(field, raw, context, path, errors, path_probe)
        if value is not INVALID:
            flat[path] = value
        if path == "stateDir" and isinstance(value, str):
            context.state_dir = value
    _apply_rules(schema, flat, errors)
    if errors:
        raise ConfigError(errors)
    resolved = _assemble(schema, flat, path_probe, context.platform, errors)
    if errors:
        raise ConfigError(errors)
    return resolved
