#!/usr/bin/env python3
"""The governance reader: the machine's governor and controller switch.

One file says whether the governor and the controller are on, and the tool that
owns it writes a small document: a boolean per scope, who moved it and when. A
legacy marker beside it means both off, and a file that cannot be read leaves
both on. This reader reports that answer and never writes it on its own: the
only write is the `--set` command, which runs the switch command the
configuration names.

A machine whose configuration names no switch is `unconfigured`, and the pane
draws nothing: the switch belongs to tooling that person may not run.

Run with: python3 plugins/llm-fleet/readers/governance.py --config <path>
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
import sys
from typing import Any, Mapping

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.runtime import cut, printable, resolve_command

SCOPES = ("governor", "controller")
LEGACY_NAME = "governor-controller.off"


def _source(config: Mapping[str, Any]) -> Mapping[str, Any]:
    sources = config.get("sources")
    declared = sources.get("governance") if isinstance(sources, Mapping) else None
    return declared if isinstance(declared, Mapping) else {}


def _path(declared: Mapping[str, Any]) -> Path | None:
    raw = declared.get("switchPath")
    if not isinstance(raw, str) or not raw:
        return None
    return Path(raw).expanduser()


def read_governance(config: Mapping[str, Any], *, limit: int = 65536) -> dict[str, Any]:
    """What the switch says, or that there is no switch here to read."""
    declared = _source(config)
    if declared.get("enabled") is False:
        return {"state": "disabled", "errors": []}
    path = _path(declared)
    if path is None:
        return {"state": "unconfigured", "errors": []}
    if (path.parent / LEGACY_NAME).exists():
        return {"state": "ready", "governor": False, "controller": False,
                "source": "legacy", "path": str(path), "errors": []}
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # The tool says a missing switch means both on, and saying so is the
        # difference between "gates are on" and "nobody knows".
        return {"state": "ready", "governor": True, "controller": True,
                "source": "missing", "path": str(path), "errors": []}
    except OSError as caught:
        return {"state": "failed", "errors": [{"source": "governance",
                                               "reason": cut(str(caught), 200) or "unreadable"}]}
    if len(raw.encode("utf-8")) > limit:
        return {"state": "failed", "errors": [{"source": "governance",
                                               "reason": "switch file is over the read bound"}]}
    try:
        document = json.loads(raw)
    except ValueError:
        return {"state": "failed", "errors": [{"source": "governance",
                                               "reason": "switch file is not JSON"}]}
    if not isinstance(document, dict):
        return {"state": "failed", "errors": [{"source": "governance",
                                               "reason": "switch file is not an object"}]}
    single = document.get("enabled")
    default = True if single is None else single
    values: dict[str, bool] = {}
    for scope in SCOPES:
        value = document.get(scope, default)
        if not isinstance(value, bool):
            return {"state": "failed", "errors": [
                {"source": "governance", "reason": scope + " is not a boolean"}]}
        values[scope] = value
    return {"state": "ready", "governor": values["governor"], "controller": values["controller"],
            "source": "config", "path": str(path),
            "updated_at": printable(document.get("updated_at")) or None,
            "by": printable(document.get("by")) or None,
            "errors": []}


def set_governance(config: Mapping[str, Any], scope: str, on: bool, *, timeout: float = 10.0) -> dict:
    """Move one scope through the switch command, then report what it says."""
    declared = _source(config)
    command = declared.get("switchCommand")
    if not isinstance(command, list) or not command or not all(isinstance(w, str) for w in command):
        return {"state": "unconfigured", "errors": [
            {"source": "governance", "reason": "no switch command is configured"}]}
    word = "on" if on else "off"
    resolved = resolve_command(command, os.environ)
    if resolved is None:
        return {"state": "unavailable", "errors": [
            {"source": "governance", "reason": "the switch command was not found"}]}
    try:
        finished = subprocess.run([*resolved, word, scope], capture_output=True,
                                  text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as caught:
        return {"state": "failed", "errors": [
            {"source": "governance", "reason": cut(str(caught), 200) or "the switch did not run"}]}
    if finished.returncode != 0:
        reason = (finished.stderr or finished.stdout or "").strip() or "the switch refused it"
        return {"state": "failed", "errors": [
            {"source": "governance", "reason": cut(reason, 200) or "the switch refused it"}]}
    return read_governance(config)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None,
                        help="the configuration document; the declared default is used without it")
    parser.add_argument("--set", dest="set", choices=(*SCOPES, "both"))
    parser.add_argument("--on", action="store_true")
    parser.add_argument("--off", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as caught:
        print(json.dumps({"state": "failed", "errors": [
            {"source": "governance", "reason": str(caught)}]}))
        return 0
    if args.set is not None:
        if args.on == args.off:
            print(json.dumps({"state": "failed", "errors": [
                {"source": "governance", "reason": "name exactly one of --on or --off"}]}))
            return 2
        document = set_governance(config, args.set, args.on)
    else:
        document = read_governance(config)
    print(json.dumps(document, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main())
