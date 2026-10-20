#!/usr/bin/env python3
"""The pacer reader: the machine's run slots, read through pacer's own status.

Pacer gives a heavy run (a test suite, a mutation run, a build) one of a fixed
number of machine-wide slots, and a caller waits for one when all are taken.
Whether a slot is taken is decided by the lock pacer holds on it, so this
reader never looks at the locks itself: it runs the configured command with
`status --json` and reports what pacer says. The answer is someone else's
output, so it is bounded in time and bytes, every field is checked, and text
is cut before it is drawn.

Pacer's first version records neither the callers waiting for a slot nor the
runs that finished in its status. A field it did not send is reported as None,
never as an empty list: nobody waiting and nobody counted are different
answers.

The only write is `--set on|off`, which runs the same command with `on` or
`off` and then reads the status again.

Run with: python3 plugins/llm-fleet/readers/pacer.py --config <path>
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
import subprocess
import sys
import time
from typing import Any, Mapping

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.custom import run_bounded_json
from readers.runtime import child_environment, cut, resolve_command

SOURCE = "pacer"
STATUS = ("status", "--json")
# How pacer says where its switch's answer came from.
SWITCH_SOURCES = frozenset({"missing", "file", "corrupt", "env"})
# A slot list longer than this is not a machine's slots; it is drawn as failed.
MAX_SLOTS = 64
MAX_RUNS = 50
MAX_WAITING = 50
# The most of a refused switch's own words read before they are cut.
SAID_BYTES = 4096


def _source(config: Mapping[str, Any]) -> Mapping[str, Any]:
    sources = config.get("sources")
    declared = sources.get(SOURCE) if isinstance(sources, Mapping) else None
    return declared if isinstance(declared, Mapping) else {}


def _empty(state: str, reason: str | None = None) -> dict[str, Any]:
    """A document with nothing read, and the reason when there is one to give."""
    errors = [{"source": SOURCE, "reason": reason}] if reason else []
    return {"state": state, "enabled": None, "switchSource": None, "reason": None,
            "version": None, "slotCount": None, "workersPerRun": None, "slots": [],
            "waiting": None, "recent": None, "errors": errors}


def _count(value: Any) -> int | None:
    """A non-negative whole number, or None for anything else."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _seconds(value: Any) -> float | None:
    """A non-negative number of seconds, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return float(value)


def _moment(value: Any) -> float | None:
    """An ISO 8601 time that states its zone, as epoch seconds, or None.

    A time with no zone would be read as this machine's local time, which is a
    guess at what the writer meant, so it is refused rather than placed.
    """
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.timestamp() if moment.tzinfo is not None else None


def _slot(entry: Any, limit: int) -> dict[str, Any] | None:
    """One slot, or None when it carries no number or no busy flag.

    The holder is the text pacer wrote into the lock file, and the lock, not the
    text, says whether the slot is busy: a holder that cannot be read leaves the
    slot busy with nobody named.
    """
    if not isinstance(entry, Mapping):
        return None
    number = _count(entry.get("slot"))
    busy = entry.get("busy")
    if number is None or not isinstance(busy, bool):
        return None
    holder = entry.get("holder") if busy else None
    holder = holder if isinstance(holder, Mapping) else {}
    return {"slot": number, "busy": busy, "pid": _count(holder.get("pid")),
            "repo": cut(holder.get("repo"), limit),
            "startedAt": _moment(holder.get("started_at"))}


def _waiting(value: Any, limit: int) -> list[dict[str, Any]] | None:
    """The callers waiting for a slot, or None when pacer did not say."""
    if not isinstance(value, list):
        return None
    callers = []
    for entry in value[:MAX_WAITING]:
        if not isinstance(entry, Mapping):
            continue
        since = _moment(entry.get("since"))
        if since is None:
            continue
        callers.append({"pid": _count(entry.get("pid")), "repo": cut(entry.get("repo"), limit),
                        "since": since})
    return callers


def _recent(value: Any, limit: int) -> list[dict[str, Any]] | None:
    """The runs that finished, newest first, or None when pacer did not say.

    A record without its time or its exit code is dropped: an exit nobody wrote
    is not a pass, and a run with no time cannot be placed.
    """
    if not isinstance(value, list):
        return None
    runs = []
    for entry in value[:MAX_RUNS]:
        if not isinstance(entry, Mapping):
            continue
        at = _moment(entry.get("ts"))
        code = entry.get("exit")
        if at is None or isinstance(code, bool) or not isinstance(code, int):
            continue
        runs.append({"at": at, "repo": cut(entry.get("repo"), limit),
                     "waitSeconds": _seconds(entry.get("wait_s")),
                     "runSeconds": _seconds(entry.get("run_s")),
                     "exit": code, "slot": _count(entry.get("slot")),
                     "mode": cut(entry.get("mode"), 24), "reason": cut(entry.get("reason"), limit)})
    return runs


def parse_status(document: Any, limit: int) -> dict[str, Any]:
    """Pacer's status as the pane reads it, or a failed document naming what is wrong."""
    if not isinstance(document, Mapping):
        return _empty("failed", "the status is not an object")
    enabled = document.get("enabled")
    if not isinstance(enabled, bool):
        return _empty("failed", "the status has no enabled switch")
    settings = document.get("config")
    settings = settings if isinstance(settings, Mapping) else {}
    count = _count(settings.get("slots"))
    if count is None:
        return _empty("failed", "the status names no number of slots")
    listed = document.get("slots")
    if not isinstance(listed, list) or len(listed) > MAX_SLOTS:
        return _empty("failed", "the status has no slots list")
    slots = [slot for slot in (_slot(entry, limit) for entry in listed) if slot is not None]
    # A slot dropped or never listed would be counted as free in "N of M busy".
    if len(slots) != len(listed):
        return _empty("failed", "the status has a slot the pane cannot read")
    if len(slots) != count:
        return _empty("failed", "the status lists {0} of {1} slots".format(len(slots), count))
    source = document.get("source")
    version = document.get("version")
    return {
        "state": "ready", "enabled": enabled,
        "switchSource": source if source in SWITCH_SOURCES else None,
        "reason": cut(document.get("reason"), limit),
        "version": _count(version),
        "slotCount": count,
        "workersPerRun": _count(settings.get("workers_per_run")),
        "slots": sorted(slots, key=lambda slot: slot["slot"]),
        "waiting": _waiting(document.get("waiting"), limit),
        "recent": _recent(document.get("recent"), limit),
        "errors": [],
    }


def _command(config: Mapping[str, Any], environ: Mapping[str, str]
             ) -> tuple[list[str] | None, dict[str, Any] | None]:
    """The resolved command, or the document that says why there is none to run."""
    declared = _source(config)
    if declared.get("enabled") is False or declared.get("state") == "disabled":
        return None, _empty("disabled")
    command = declared.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(word, str)
                                                               for word in command):
        return None, _empty("unconfigured")
    resolved = resolve_command(command, environ)
    if resolved is None:
        return None, _empty("unavailable", command[0] + " is not on PATH")
    return resolved, None


def read_pacer(config: Mapping[str, Any], *,
               environ: Mapping[str, str] | None = None,
               timeout: float | None = None) -> dict[str, Any]:
    """What pacer says about its slots, or why nothing was read.

    `timeout` replaces the configured command limit, for a read that shares its
    time with a switch made just before it.
    """
    environment = dict(os.environ if environ is None else environ)
    child = child_environment(config["runtime"]["childEnvironment"], environment)
    resolved, refusal = _command(config, child)
    if refusal is not None:
        return refusal
    assert resolved is not None
    limit = int(config["limits"]["questionCharacters"])
    seconds = float(config["timeouts"]["commandSeconds"]) if timeout is None else timeout
    output, reason = run_bounded_json([*resolved, *STATUS], child, seconds,
                                      int(config["limits"]["jobStateBytes"]))
    if reason is not None:
        return _empty("failed", reason)
    return parse_status(output, limit)


def set_pacer(config: Mapping[str, Any], on: bool, *,
              environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Switch pacer on or off through its command, then read what it says now.

    The switch and the read after it share the one command limit, so the
    caller waiting on both is never left waiting longer than it was told. What
    the command printed is someone else's bytes: it is decoded with anything
    that is not text replaced, and cut, before it is said.
    """
    environment = dict(os.environ if environ is None else environ)
    child = child_environment(config["runtime"]["childEnvironment"], environment)
    resolved, refusal = _command(config, child)
    if refusal is not None:
        return refusal
    assert resolved is not None
    word = "on" if on else "off"
    seconds = float(config["timeouts"]["commandSeconds"])
    started = time.monotonic()
    try:
        finished = subprocess.run([*resolved, word], capture_output=True, env=child,
                                  stdin=subprocess.DEVNULL, timeout=seconds)
    except subprocess.TimeoutExpired:
        return _empty("failed", "the switch did not answer in time")
    except OSError as caught:
        return _empty("failed", caught.strerror or type(caught).__name__)
    if finished.returncode != 0:
        printed = finished.stderr or finished.stdout or b""
        said = printed[:SAID_BYTES].decode("utf-8", errors="replace").strip()
        return _empty("failed", cut(said, 200) or "the switch refused it")
    remaining = seconds - (time.monotonic() - started)
    if remaining <= 0:
        return _empty("failed", "pacer switched {0}; its status did not answer in time".format(word))
    answer = read_pacer(config, environ=environment, timeout=remaining)
    if answer["state"] == "failed" and answer["errors"]:
        answer["errors"][0]["reason"] = "pacer switched {0}; {1}".format(
            word, answer["errors"][0]["reason"])
    return answer


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read pacer's run slots, or move its switch")
    parser.add_argument("--config", default=None,
                        help="the configuration document; the declared default is used without it")
    parser.add_argument("--set", choices=("on", "off"), default=None,
                        help="switch pacer on or off, then print what it says")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as caught:
        print(json.dumps(_empty("failed", str(caught))))
        return 2
    document = read_pacer(config) if args.set is None else set_pacer(config, args.set == "on")
    print(json.dumps(document, indent=2 if args.pretty else None))
    return 0 if document["state"] != "failed" or args.set is None else 1


if __name__ == "__main__":
    sys.exit(main())
