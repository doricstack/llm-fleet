#!/usr/bin/env python3
"""The custom-section reader: sections a person adds by naming a command.

Each section declared under `pane.custom` runs its command once per reading and
draws the object the command prints. The command is someone else's program, so
its output is untrusted: it is bounded in time and in bytes, a row that does not
carry a title is skipped, a figure is published only when it is a whole number,
and a bar is drawn only when the command gave both its parts. Each section
answers for itself, so one command that fails leaves the others drawn.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
from typing import Any, Mapping

from .runtime import child_environment, cut, resolve_command

PREFIX = "custom:"
# A pane row per entry, and no more: a command that prints a thousand rows is
# drawn as the first of them, with the count it printed kept for the heading.
ROW_CAP = 50
# The states a row may name. Anything else draws plain rather than being guessed
# into a color it did not ask for.
STATES = frozenset({"working", "running", "active", "waiting", "blocked", "failed", "error",
                    "passed", "done"})


def _count(value: Any) -> int | None:
    """A non-negative whole number, or None for anything else."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def custom_row(entry: Any, limit: int) -> dict[str, Any] | None:
    """One printed row, or None when it has no title to draw."""
    if not isinstance(entry, Mapping):
        return None
    title = cut(entry.get("title"), limit)
    if title is None:
        return None
    state = entry.get("state")
    done = _count(entry.get("done"))
    total = _count(entry.get("total"))
    # A bar needs both its parts, and a whole that holds the part: a figure the
    # command did not give is not filled in, and one that cannot be drawn is
    # dropped rather than drawn past its own end.
    if done is None or not total or done > total:
        done = total = None
    failed = _count(entry.get("failed")) if total is not None else None
    if failed is not None and done is not None and failed > done:
        failed = None
    return {
        "title": title,
        "state": state.lower() if isinstance(state, str) and state.lower() in STATES else None,
        "detail": cut(entry.get("detail"), limit),
        "slot": cut(entry.get("slot"), limit),
        "done": done,
        "total": total,
        "failed": failed,
    }


def run_bounded_json(argv: list[str], environment: Mapping[str, str], timeout: float,
                     max_bytes: int) -> tuple[Any, str | None]:
    """The parsed output of one command, or the reason there is none."""
    try:
        completed = subprocess.run(argv, capture_output=True, env=dict(environment),
                                   timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "timed out after {0:g}s".format(timeout)
    except OSError as caught:
        return None, caught.strerror or type(caught).__name__
    if completed.returncode != 0:
        return None, "exit {0}".format(completed.returncode)
    if len(completed.stdout) > max_bytes:
        return None, "output over {0} bytes".format(max_bytes)
    try:
        return json.loads(completed.stdout.decode("utf-8")), None
    except (UnicodeDecodeError, ValueError):
        return None, "output was not JSON"


def read_section(key: str, section: Mapping[str, Any],
                 child: Mapping[str, str], limit: int, max_bytes: int) -> dict[str, Any]:
    """One section's document: its state, its rows, and why it has none."""
    document: dict[str, Any] = {
        "state": "unavailable", "title": section["title"], "legend": section["legend"],
        "visible": bool(section["visible"]), "collapsed": bool(section["collapsed"]),
        "hideWhenEmpty": bool(section["hideWhenEmpty"]),
        "maxRows": int(section["maxRows"]),
        "summary": None, "rows": [], "printed": 0, "errors": [],
    }
    source = PREFIX + key
    command = list(section["command"])
    resolved = resolve_command(command, child)
    if resolved is None:
        document["errors"].append({"source": source, "reason": command[0] + " is not on PATH"})
        return document
    output, reason = run_bounded_json(resolved, child, float(section["timeoutSeconds"]), max_bytes)
    if reason is None and (not isinstance(output, Mapping) or not isinstance(output.get("rows"), list)):
        reason = "output had no rows list"
    if reason is not None:
        document["state"] = "failed"
        document["errors"].append({"source": source, "reason": reason})
        return document
    rows = []
    for entry in output["rows"]:
        row = custom_row(entry, limit)
        if row is not None:
            rows.append(row)
    document["printed"] = len(rows)
    document["rows"] = rows[:ROW_CAP]
    document["summary"] = cut(output.get("summary"), limit)
    document["state"] = "ready" if rows else "empty"
    return document


def read_custom(config: Mapping[str, Any], *,
                environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Every declared custom section, in the order the document declares them."""
    declared = (config.get("pane") or {}).get("custom") or {}
    result: dict[str, Any] = {"state": "disabled", "sections": {}, "errors": []}
    if not declared:
        return result
    environment = dict(os.environ if environ is None else environ)
    child = child_environment(config["runtime"]["childEnvironment"], environment)
    limit = int(config["limits"]["questionCharacters"])
    max_bytes = int(config["limits"]["jobStateBytes"])
    keys = list(declared)
    with ThreadPoolExecutor(max_workers=min(len(keys), 8)) as pool:
        documents = list(pool.map(
            lambda key: read_section(key, declared[key], child, limit, max_bytes),
            keys))
    for key, document in zip(keys, documents):
        result["sections"][key] = document
        result["errors"].extend(document["errors"])
    result["state"] = "ready"
    return result
