#!/usr/bin/env python3
"""A starter configuration, written once where the loader will look for it.

A new person has a plugin that draws an empty pane until it knows where their
sessions live. This finds the provider homes on this machine, the one
`CLAUDE_CONFIG_DIR` names and the default one in the home directory, and writes
a configuration holding them and nothing else: every other setting keeps the
default the schema declares, so the file says only what is particular to this
machine. A path under the home directory is written as `$HOME/...`, so the file
still reads right after the home moves.

It never overwrites. A file already at the destination, or a link there, is left
exactly as it is and the command says so: a person's own configuration is
theirs, and a starter written over it would lose it.

The destination is the one a load would read: the file `$FLEET_CONFIG` names,
otherwise the default place. The starter is read back through the loader before
it is written, so a file this writes is one the loader takes.

Run with: python3 plugins/fleet/readers/setup.py [--path <file>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, Mapping

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, config_location, load_config

EXIT_WRITTEN = 0
EXIT_REFUSED = 2
EXIT_EXISTS = 3


def _home_form(path: str, home: str | None) -> str:
    """A path under the home directory as `$HOME/...`, any other as written."""
    if home:
        base = home.rstrip(os.sep)
        if path == base:
            return "$HOME"
        if path.startswith(base + os.sep):
            return "$HOME/" + path[len(base) + 1:].replace(os.sep, "/")
    return path


def _user_home(environ: Mapping[str, str]) -> str | None:
    """The person's home: `HOME`, or on Windows, where it may be unset, `USERPROFILE`."""
    return environ.get("HOME") or environ.get("USERPROFILE")


def provider_homes(environ: Mapping[str, str]) -> list[str]:
    """The provider homes on this machine, the configured one first, each once.

    A machine that points Claude Code at more than one model gives each route its
    own `CLAUDE_CONFIG_DIR`, because the base URL and the token belong to the
    route: those homes sit beside the default one, each named after its route.
    Each is found here so a person adding or removing a route re-runs setup
    rather than editing a list by hand. A directory beside them that is a tool's
    own folder rather than a home is left out: Claude Code writes `settings.json`
    into a home and nothing else does.
    """
    candidates: list[str] = []
    configured = environ.get("CLAUDE_CONFIG_DIR")
    if configured:
        candidates.append(os.path.expanduser(configured))
    home = _user_home(environ)
    if home:
        candidates.append(os.path.join(home, ".claude"))
        try:
            beside = sorted(os.listdir(home)) if os.path.isdir(home) else []
        except OSError:
            # A home a person cannot read is a machine problem, not a reason for
            # the first-run command to fail; the homes already named still count.
            beside = []
        for child in beside:
            if not child.startswith(".claude"):
                continue
            path = os.path.join(home, child)
            if os.path.isdir(path) and os.path.isfile(os.path.join(path, "settings.json")):
                candidates.append(path)
    homes: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not os.path.isabs(candidate) or not os.path.isdir(candidate):
            continue
        real = os.path.realpath(candidate)
        if real in seen:
            continue
        seen.add(real)
        homes.append(candidate)
    return homes


def starter(environ: Mapping[str, str]) -> dict[str, Any]:
    """The starter document: the schema version and the providers found, nothing else.

    A path is written in `$HOME` form only when `HOME` is set, because that is the
    variable the loader expands: a home found through `USERPROFILE` alone is
    written as the full path.
    """
    home = environ.get("HOME")
    providers: list[dict[str, Any]] = []
    for index, path in enumerate(provider_homes(environ)):
        # The first home found is `claude`, the configured one when there is
        # one; any after it is numbered, so every id is distinct.
        suffix = "" if index == 0 else "-" + str(index + 1)
        providers.append({"id": "claude" + suffix,
                          "label": "Claude" + suffix.replace("-", " "),
                          "home": _home_form(path, home)})
    return {"schemaVersion": 1, "providers": providers}


def _loads(document: Mapping[str, Any], environ: Mapping[str, str]) -> list[dict[str, str]]:
    """The loader's refusals of a document, read from a file of its own; none when it loads."""
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        try:
            load_config(str(path), dict(environ))
        except ConfigError as refusal:
            return list(refusal.errors)
    return []


def run(environ: Mapping[str, str], path: str | None = None, dry_run: bool = False) -> dict[str, Any]:
    """Write the starter, or say why not. Never overwrites anything."""
    if path is not None:
        destination: str | None = path
        errors: list[dict[str, str]] = [] if os.path.isabs(path) else [
            {"code": "E_CONFIG_VALUE", "path": "--path"}]
    else:
        location = config_location(None, dict(environ))
        destination, errors = location["path"], list(location["errors"])
    if errors or not destination:
        return {"state": "refused", "path": destination,
                "errors": errors or [{"code": "E_CONFIG_VALUE", "path": "$HOME"}]}
    document = starter(environ)
    refusals = _loads(document, environ)
    if refusals:
        return {"state": "refused", "path": destination, "errors": refusals}
    if dry_run:
        return {"state": "dry-run", "path": destination, "document": document}
    if os.path.lexists(destination):
        return {"state": "exists", "path": destination}
    text = json.dumps(document, indent=2) + "\n"
    try:
        os.makedirs(os.path.dirname(destination), exist_ok=True)
    except OSError as failure:
        return _unwritable(destination, failure)
    try:
        # Created, never truncated: a file that appeared since the look above is
        # left alone rather than written over.
        with open(destination, "x", encoding="utf-8") as handle:
            handle.write(text)
    except FileExistsError:
        return {"state": "exists", "path": destination}
    except OSError as failure:
        return _unwritable(destination, failure)
    return {"state": "written", "path": destination, "document": document}


def _unwritable(destination: str, failure: OSError) -> dict[str, Any]:
    """A destination this user cannot write, named with what the system said."""
    return {"state": "refused", "path": destination,
            "errors": [{"code": "E_SETUP_WRITE", "path": destination,
                        "detail": failure.strerror or type(failure).__name__}]}


def _shown(path: str | None, home: str | None) -> str:
    if not path:
        return "(none)"
    form = _home_form(path, home)
    return "~" + form[len("$HOME"):] if form.startswith("$HOME") else form


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a starter configuration where a load reads it")
    parser.add_argument("--path", default=None, help="write here instead of where a load would read")
    parser.add_argument("--dry-run", action="store_true", help="print the starter and write nothing")
    args = parser.parse_args(argv)
    environ = dict(os.environ)
    home = environ.get("HOME")
    result = run(environ, args.path, args.dry_run)
    shown = _shown(result.get("path"), home)
    if result["state"] == "dry-run":
        sys.stdout.write(json.dumps(result["document"], indent=2) + "\n")
        return EXIT_WRITTEN
    if result["state"] == "exists":
        sys.stdout.write("A configuration is already at {0}; it was left as it is. "
                         "Run /fleet doctor to see what it is missing.\n".format(shown))
        return EXIT_EXISTS
    if result["state"] == "refused":
        unwritable = [entry for entry in result["errors"] if entry.get("code") == "E_SETUP_WRITE"]
        if unwritable:
            sys.stdout.write("No starter was written: {0} could not be written ({1}). Set the "
                             "plugin's Configuration file option to a place you can write.\n"
                             .format(unwritable[0]["path"], unwritable[0].get("detail")))
            return EXIT_REFUSED
        named = ", ".join("{0} ({1})".format(entry.get("path"), entry.get("code"))
                          for entry in result["errors"])
        sys.stdout.write("No starter was written: {0}.\n".format(named))
        return EXIT_REFUSED
    providers = result["document"]["providers"]
    found = ", ".join(entry["home"] for entry in providers) or "no provider home"
    sys.stdout.write("Wrote a starter configuration at {0} with {1}. "
                     "Run /fleet doctor to see what else you can switch on.\n".format(shown, found))
    return EXIT_WRITTEN


if __name__ == "__main__":
    raise SystemExit(main())
