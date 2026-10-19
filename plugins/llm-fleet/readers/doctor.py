#!/usr/bin/env python3
"""What stands between this machine and a working pane, and the setting that fixes each.

A person who installs the plugin and sees an empty pane has one question: what
is missing. This answers it from the same places the pane reads, in the same
order: the interpreter, the configuration file and whether the loader took it,
each provider and source with the state the loader gave it, and the commands
the readers start. Every fix it names is a key the schema declares, taken from
the schema's own rules for that source, so a hint cannot drift from what the
loader would act on.

Read-only by design: this loads the configuration and looks for commands on the
PATH. It starts nothing and writes nothing.

Run with: python3 plugins/llm-fleet/readers/doctor.py [--config <path>] [--json]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from typing import Any, Mapping, Sequence

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, config_location, load_config, load_schema

MINIMUM_PYTHON = (3, 11)

# The states a source is in when something has to be set before it reads.
NEEDS_SETTING = ("unconfigured", "unavailable")


def python_check(version: Sequence[int] = tuple(sys.version_info[:3]),
                 executable: str = sys.executable) -> dict[str, Any]:
    """The interpreter this runs under, and whether it is new enough."""
    shown = ".".join(str(part) for part in version[:3])
    return {"version": shown, "executable": executable,
            "ok": tuple(version[:2]) >= MINIMUM_PYTHON}


def command_check(argv: Sequence[str] | None, environ: Mapping[str, str]) -> dict[str, Any]:
    """Where a configured command resolves, on the PATH the readers give it."""
    if not argv:
        return {"argv": None, "found": None}
    name = argv[0]
    if os.sep in name or (os.altsep and os.altsep in name):
        found = name if os.path.isfile(name) and os.access(name, os.X_OK) else None
    else:
        found = shutil.which(name, path=environ.get("PATH", ""))
    return {"argv": list(argv), "found": found}


def source_hint(group: Mapping[str, Any], state: str) -> str | None:
    """The setting a source in this state waits on, in the schema's own words."""
    path = group["path"]
    if state == "disabled":
        return "off; set `{0}.enabled` to true to read it".format(path)
    if state == "unconfigured":
        if group.get("requiresReadyProvider"):
            return "add a provider whose home exists under `providers`"
        fields = ["`{0}.{1}`".format(path, rule["field"]) for rule in group.get("requires", [])]
        return "set " + " and ".join(fields) if fields else None
    if state == "unavailable":
        targets = ["`{0}.{1}` to an existing {2}".format(path, target["field"], target["kind"])
                   for target in group.get("targets", [])]
        if targets:
            return "point " + " and ".join(targets)
        if group.get("requiresReadyProvider"):
            return "add a provider whose home exists under `providers`"
    return None


def hint_keys(hint: str) -> list[str]:
    """Every configuration key a hint names."""
    return re.findall(r"`([^`]+)`", hint)


def diagnose(config_path: str | None = None,
             environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The whole diagnosis, as data; `render` writes it for a person."""
    environment = dict(os.environ if environ is None else environ)
    schema = load_schema("")
    location = config_location(config_path, environment)
    # The home travels with the diagnosis, so a path is shortened against the
    # home it was read under rather than the one the renderer runs in.
    config: dict[str, Any] = {"path": location["path"], "origin": location["origin"],
                              "errors": list(location["errors"]),
                              "home": environment.get("HOME")}
    try:
        resolved: dict[str, Any] | None = load_config(config_path, environment)
    except ConfigError as refusal:
        resolved = None
        config["errors"] = list(refusal.errors)
    if resolved is None:
        config["state"] = "refused"
    elif location["origin"] == "none":
        config["state"] = "absent"
    else:
        config["state"] = "loaded"

    providers: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    commands: dict[str, dict[str, Any]] = {}
    if resolved is not None:
        for entry in resolved.get("providers", []):
            providers.append({"id": entry.get("id"), "home": entry.get("home"),
                              "enabled": entry.get("enabled"), "state": entry.get("state")})
        for group in schema["sources"]:
            body = resolved["sources"][group["id"]]
            state = str(body.get("state"))
            sources.append({"id": group["id"], "state": state,
                            "hint": source_hint(group, state),
                            "problem": bool(body.get("enabled")) and state in NEEDS_SETTING})
        # The roster starts claude for jobs and for interactive sessions; the
        # agents source reads transcripts and starts nothing.
        reads_jobs = any(entry["id"] in ("jobs", "interactive") and entry["state"] != "disabled"
                         for entry in sources)
        reads_prs = any(entry["id"] == "prs" and entry["state"] != "disabled" for entry in sources)
        for key, needed in (("claude", reads_jobs), ("github", reads_prs)):
            check = command_check(resolved["commands"].get(key), environment)
            check["problem"] = needed and check["found"] is None
            commands[key] = check

    python = python_check()
    problems = (0 if python["ok"] else 1) + (1 if config["state"] == "refused" else 0)
    problems += sum(1 for entry in providers if entry["enabled"] and entry["state"] != "ready")
    problems += sum(1 for entry in sources if entry["problem"])
    problems += sum(1 for check in commands.values() if check["problem"])
    return {"python": python, "config": config, "providers": providers,
            "sources": sources, "commands": commands, "problems": problems}


def _shown(path: str | None, home: str | None) -> str:
    """A path as a person reads it: the home directory as `~`."""
    if not path:
        return "(none)"
    home = home or ""
    if home and (path == home or path.startswith(home.rstrip(os.sep) + os.sep)):
        return "~" + path[len(home.rstrip(os.sep)):]
    return path


def _plain(hint: str) -> str:
    return hint.replace("`", "")


def render(diagnosis: Mapping[str, Any]) -> list[str]:
    """The diagnosis for a person: the count first, then one line per thing checked."""
    home = diagnosis["config"].get("home")
    count = diagnosis["problems"]
    lines = ["llm-fleet doctor: " + ("nothing to fix" if count == 0
                                 else "{0} thing{1} to fix".format(count, "" if count == 1 else "s"))]
    python = diagnosis["python"]
    lines.append("  Python {0} ({1}): {2}".format(
        python["version"], python["executable"],
        "ok" if python["ok"] else "too old; set the plugin's Python interpreter option to 3.11 or newer"))
    config = diagnosis["config"]
    origin = {"argument": "named on the command line", "environment": "from $FLEET_CONFIG",
              "default": "default place", "none": "default place"}[config["origin"]]
    lines.append("  Configuration {0} ({1}): {2}".format(_shown(config["path"], home),
                                                         origin, config["state"]))
    for refusal in config["errors"]:
        lines.append("    refused {0}: {1}".format(refusal.get("path") or "(document)",
                                                   refusal.get("code")))
    for entry in diagnosis["providers"]:
        state = entry["state"] if entry["enabled"] else "off"
        note = "" if state in ("ready", "off") else "; fix: make the home a directory, or set enabled to false"
        lines.append("  Provider {0} at {1}: {2}{3}".format(entry["id"], _shown(entry["home"], home),
                                                           state, note))
    for entry in diagnosis["sources"]:
        line = "  Source {0}: {1}".format(entry["id"], entry["state"])
        if entry["hint"]:
            line += ("; fix: " if entry["problem"] else " (") + _plain(entry["hint"]) \
                + ("" if entry["problem"] else ")")
        lines.append(line)
    names = {"claude": "commands.claude", "github": "commands.github"}
    for key, check in diagnosis["commands"].items():
        shown = check["argv"][0] if check["argv"] else key
        if check["found"]:
            lines.append("  Command {0}: {1}".format(shown, _shown(check["found"], home)))
        else:
            needed = "; fix: install it, or set " if check["problem"] else " (not needed now; set "
            closing = "" if check["problem"] else ")"
            lines.append("  Command {0}: not found on PATH{1}{2}{3}".format(shown, needed, names[key],
                                                                             closing))
    if config["state"] == "absent":
        lines.append("Run /llm-fleet setup to write a starter configuration at "
                     + _shown(config["path"], home) + ".")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Say what the pane is missing on this machine")
    parser.add_argument("--config", default=None,
                        help="the configuration document; the one a load would read without it")
    parser.add_argument("--json", action="store_true", help="print the diagnosis as JSON")
    args = parser.parse_args(argv)
    diagnosis = diagnose(args.config)
    if args.json:
        json.dump(diagnosis, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write("\n".join(render(diagnosis)) + "\n")
    return 0 if diagnosis["problems"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
