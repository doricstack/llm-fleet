#!/usr/bin/env python3
"""Keep every Claude Code home's installed copy on the version this tree holds.

The host installs a plugin by recording a version, and it does not notice a
version the tree raised behind it: a home that installed 0.3.1 keeps loading
0.3.1, or nothing at all, while `plugins/fleet/.claude-plugin/plugin.json` says
0.4.0. The host's own repair is `claude plugin update <plugin>@<marketplace>`
and a restart, and nothing runs it after a bump, so a release silently leaves
the machine on the previous build.

This script closes that gap. It reads this tree's version, reads the installed
record in every home it is pointed at, and either reports the drift or runs the
host's own update for each stale home and reads the record again to prove it
took. A home that has never installed the plugin is reported as absent and is
not a failure: nothing is stale there.

Homes come from `--config-dir` (repeatable), or from every `~/.claude*`
directory holding a `plugins/installed_plugins.json`. `--write` runs the
update; the default checks and exits non-zero on drift.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "plugins" / "fleet" / ".claude-plugin" / "plugin.json"
INSTALLED = Path("plugins") / "installed_plugins.json"
# How long the host's own update may take before it is treated as not answering.
UPDATE_TIMEOUT_SECONDS = 120


def manifest() -> tuple[str, str]:
    """This tree's plugin name and version."""
    document = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return str(document["name"]), str(document["version"])


def installed_entries(home: Path, name: str) -> list[tuple[str, str]]:
    """Every `<name>@<marketplace>` this home records, with the version it holds."""
    path = home / INSTALLED
    if not path.is_file():
        return []
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    plugins = document.get("plugins", document)
    if not isinstance(plugins, dict):
        return []
    found = []
    for key, value in plugins.items():
        if not isinstance(key, str) or not key.startswith(name + "@"):
            continue
        # One key can hold more than one install, a scope each: the first is not
        # the record. A project-scope copy left on an older version is exactly
        # the kind of stale entry this check exists to find, and reading only the
        # first would report a home current while another scope was not.
        records = value if isinstance(value, list) else [value]
        for record in records:
            if not isinstance(record, dict):
                continue
            found.append((key, str(record.get("version", ""))))
    return found


def homes_named(options: argparse.Namespace) -> list[Path]:
    """The homes to check, each once, in the order they were named or found."""
    if options.config_dir:
        return [Path(value).expanduser() for value in options.config_dir]
    found = []
    for child in sorted(Path.home().glob(".claude*")):
        # A home that turns the plugin on but never fetched it holds settings and
        # no record, and that home is the one worth naming.
        if child.is_dir() and ((child / INSTALLED).is_file() or (child / "settings.json").exists()):
            found.append(child)
    return found


def enabled_ids(home: Path, name: str) -> list[str]:
    """Every `<name>@<marketplace>` this home's settings turn on.

    Settings are usually one file shared by every home through a link, so this
    says what the person asked for; whether the home has the plugin on disk is a
    different question, and the one that decides whether a session loads it.
    """
    try:
        data = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = data.get("enabledPlugins")
    if not isinstance(entries, dict):
        return []
    return [key for key, value in entries.items()
            if isinstance(key, str) and key.startswith(name + "@") and value is True]


def marketplace_source(home: Path, marketplace: str) -> str | None:
    """A marketplace's source as the host adds it again: `owner/repo`, or a path."""
    try:
        data = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    marks = data.get("extraKnownMarketplaces")
    if not isinstance(marks, dict) or not isinstance(marks.get(marketplace), dict):
        return None
    source = marks[marketplace].get("source")
    if not isinstance(source, dict):
        return None
    if source.get("source") == "github" and isinstance(source.get("repo"), str):
        return source["repo"]
    if isinstance(source.get("path"), str):
        return source["path"]
    return None


def setting(document: Path, marketplace: str) -> bool | None:
    """Whether a settings or marketplace record turns auto-update on or off."""
    try:
        data = json.loads(document.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    for section in ("extraKnownMarketplaces",):
        entries = data.get(section)
        if isinstance(entries, dict) and isinstance(entries.get(marketplace), dict):
            value = entries[marketplace].get("autoUpdate")
            if isinstance(value, bool):
                return value
    entries = data.get(marketplace)
    if isinstance(entries, dict) and isinstance(entries.get("autoUpdate"), bool):
        return entries["autoUpdate"]
    return None


def auto_updates(home: Path, marketplace: str) -> bool | None:
    """Whether this home's host keeps the installed copy current by itself.

    Settings decide first and the marketplace record second, as the host reads
    them, and a marketplace added from a local path is off unless one of them
    says otherwise. None is a home that says nothing at all, which is off.
    """
    declared = setting(home / "settings.json", marketplace)
    if declared is not None:
        return declared
    return setting(home / INSTALLED.parent / "known_marketplaces.json", marketplace)


def run_update(claude: str, claude_args: list[str], home: Path,
               words: list[str]) -> tuple[bool, str]:
    """Ask the host to do one thing in one home, and say whether it did."""
    environment = dict(os.environ)
    environment["CLAUDE_CONFIG_DIR"] = str(home)
    try:
        result = subprocess.run([claude, *claude_args, *words],
                                capture_output=True, text=True, env=environment,
                                timeout=UPDATE_TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report or repair a home whose installed copy is not this tree's version.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--write", action="store_true",
                       help="run the host's update for each stale home")
    group.add_argument("--check", action="store_true",
                       help="report drift and exit non-zero; the default")
    parser.add_argument("--config-dir", action="append", default=[],
                        help="a Claude Code home to check; repeatable, default every ~/.claude*")
    parser.add_argument("--claude", default="claude",
                        help="the host executable the update runs through")
    parser.add_argument("--claude-arg", action="append", default=[],
                        help="an argument the host command needs before its own, "
                             "such as an interpreter for a script; repeatable")
    options = parser.parse_args(argv)

    name, version = manifest()
    homes = homes_named(options)
    stale: list[tuple[Path, str, str]] = []
    absent: list[Path] = []
    missing: list[tuple[Path, str, str | None]] = []
    auto_off: list[tuple[Path, str]] = []
    for home in homes:
        entries = installed_entries(home, name)
        recorded = {identifier for identifier, _held in entries}
        # Turned on in settings and absent from this home is a session with no
        # plugin: the enabled flag alone fetches nothing, so the fix is an
        # install here, not an update.
        for identifier in enabled_ids(home, name):
            if identifier not in recorded:
                marketplace = identifier.split("@", 1)[1] if "@" in identifier else ""
                missing.append((home, identifier, marketplace_source(home, marketplace)
                                if marketplace else None))
        if not entries:
            absent.append(home)
            continue
        for identifier, held in entries:
            if held == version:
                print(str(home) + ": " + identifier + " at " + held + ", current")
            else:
                stale.append((home, identifier, held or "an unstated version"))
            marketplace = identifier.split("@", 1)[1] if "@" in identifier else ""
            if marketplace and auto_updates(home, marketplace) is not True:
                auto_off.append((home, marketplace))
    # A home that leaves auto-update off stays current only until the next
    # release, which is the failure this check exists to catch; say so in the
    # same run rather than let it come back as a surprise. Homes usually share
    # one settings file through a link, so the same gap is said once.
    told: set[tuple[str, str]] = set()
    for home, marketplace in auto_off:
        key = (str((home / "settings.json").resolve()), marketplace)
        if key in told:
            continue
        told.add(key)
        print(str(home) + ": auto-update is off for " + marketplace
              + ", so the next release will need this step again"
              + " (in /plugin, Marketplaces, turn on Enable auto-update)")
    # A machine can hold a home per provider, most of which never installed the
    # plugin; listing each by name buries the homes that did. One line says how
    # many there are, and names them only when the caller asked for them by name.
    if absent:
        if options.config_dir:
            for home in absent:
                print(str(home) + ": not installed, nothing to bring up to date")
        else:
            print(str(len(absent)) + " other home"
                  + ("" if len(absent) == 1 else "s") + " have not installed " + name)
    if not stale and not missing:
        if len(absent) == len(homes):
            print("No home has installed " + name + "; nothing to check.")
        else:
            print("Every home that has installed " + name + " is on " + version + ".")
        return 0

    if not options.write:
        for home, identifier, _source in missing:
            print(str(home) + ": " + identifier + " is enabled and not installed here,"
                  " so a session in this home loads nothing", file=sys.stderr)
        for home, identifier, held in stale:
            print(str(home) + ": " + identifier + " holds " + held
                  + ", this tree is " + version, file=sys.stderr)
        print("Run `make host-update` to install it where it is missing and bring"
              " each home up to " + version + ", then restart the sessions that need it.",
              file=sys.stderr)
        return 1

    failures = []
    for home, identifier, source in missing:
        marketplace = identifier.split("@", 1)[1] if "@" in identifier else ""
        if marketplace and source:
            # `plugin marketplace add` rather than a bare `marketplace add`: the
            # host's command tree has no top-level marketplace, and an
            # already-added source answers success, so a failure here is real.
            added, output = run_update(options.claude, options.claude_arg, home,
                                       ["plugin", "marketplace", "add", source])
            if output:
                print(output)
            if not added:
                failures.append((home, identifier,
                                 "the host's marketplace add exited unsatisfied"))
                continue
        ok, output = run_update(options.claude, options.claude_arg, home,
                                ["plugin", "install", identifier])
        if output:
            print(output)
        if not ok:
            failures.append((home, identifier, "the host's install exited unsatisfied"))
            continue
        if dict(installed_entries(home, name)).get(identifier, "") != version:
            failures.append((home, identifier, "the install left no record"))
    for home, identifier, held in stale:
        ok, output = run_update(options.claude, options.claude_arg, home,
                                ["plugin", "update", identifier])
        if output:
            print(output)
        if not ok:
            failures.append((home, identifier, "the host's update exited unsatisfied"))
            continue
        again = dict(installed_entries(home, name)).get(identifier, "")
        if again != version:
            failures.append((home, identifier,
                             "the record still holds " + (again or "no version")))
    if failures:
        for home, identifier, reason in failures:
            print(str(home) + ": " + identifier + " did not reach " + version
                  + ": " + reason, file=sys.stderr)
        return 1
    print("Every home is on " + version + "; restart the sessions that need it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
