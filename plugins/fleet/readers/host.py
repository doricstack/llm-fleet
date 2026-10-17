#!/usr/bin/env python3
"""The host payload: what the session host hands the statusline on stdin.

The host is a separate program, so its payload is untrusted input. It can be
empty, truncated, shaped differently than the last version, or larger than
anything worth reading. Every read here is bounded in bytes, and a field the host
did not send stays absent rather than becoming a zero: a statusline that reports
0% of a window nobody measured is worse than one that reports nothing.

Absent fields are named in `absent`. The renderer decides what to do about them,
and it cannot do that if this layer quietly fills them in.

Run with: python3 plugins/fleet/readers/host.py < payload.json
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, IO

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config

STATE_READY = "ready"
STATE_EMPTY = "empty"
STATE_FAILED = "failed"

# The fields this layer reads, as paths into the payload. A path that is not
# present is reported absent; a path present with the wrong type is also absent,
# because the host changing a field's type is the host telling us nothing.
NUMBER_PATHS = (
    ("cost", "total_cost_usd", "cost.totalCostUsd"),
    ("cost", "total_duration_ms", "cost.durationMs"),
    ("cost", "total_api_duration_ms", "cost.apiDurationMs"),
    ("cost", "total_lines_added", "cost.linesAdded"),
    ("cost", "total_lines_removed", "cost.linesRemoved"),
    ("context_window", "total_input_tokens", "context.inputTokens"),
    ("context_window", "total_output_tokens", "context.outputTokens"),
    ("context_window", "remaining_percentage", "context.remainingPercent"),
    ("context_window", "context_window_size", "context.windowSize"),
    ("context_window", "current_usage", "context.currentUsage"),
)
TEXT_PATHS = (
    ("session_id", "session.id"),
    ("session_name", "session.name"),
    ("cwd", "session.cwd"),
    ("version", "session.version"),
)
MODEL_PATHS = (
    ("model", "id", "model.id"),
    ("model", "display_name", "model.displayName"),
)
LIMIT_PATHS = (
    ("rate_limits", "five_hour", "rateLimits.fiveHour"),
    ("rate_limits", "seven_day", "rateLimits.sevenDay"),
    ("rate_limits", "spend_limit", "rateLimits.spendLimit"),
)
PASSTHROUGH = (("effort", "effort"), ("thinking", "thinking"), ("prompt_cache", "promptCache"),
               ("pr", "pr"), ("worktree", "worktree"), ("output_style", "outputStyle"))


class HostPayloadError(ValueError):
    """The payload cannot be read as what the host claims it is."""


def read_payload(stream: IO[bytes], max_bytes: int) -> bytes:
    """Read at most `max_bytes`; one byte more is a refusal, never a truncation."""
    if max_bytes < 1:
        raise HostPayloadError("the byte limit must be positive")
    data = stream.read(max_bytes + 1)
    if data is None:
        raise HostPayloadError("the stream returned no bytes")
    if len(data) > max_bytes:
        # Never parse a payload that was cut off: a truncated read is a different
        # document, and the fields missing from it are missing because of us.
        raise HostPayloadError(f"the payload exceeded {max_bytes} bytes")
    return data


def number(value: Any) -> float | int | None:
    """A number, or nothing. A boolean is not a number, however Python counts it."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def at(payload: dict[str, Any], *path: str) -> Any:
    node: Any = payload
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def usage_block(payload: dict[str, Any]) -> dict[str, Any]:
    """Cache token counts, each read on its own so a missing one stays missing."""
    result: dict[str, Any] = {}
    for key, name in (("cache_read_input_tokens", "cacheReadTokens"),
                      ("cache_creation_input_tokens", "cacheCreationTokens")):
        value = number(at(payload, "context_window", "current_usage", key))
        if value is not None:
            result[name] = value
    return result


def limit_block(payload: dict[str, Any], *path: str) -> dict[str, Any]:
    node = at(payload, *path)
    if not isinstance(node, dict):
        return {}
    result: dict[str, Any] = {}
    for key, name in (("used_percentage", "usedPercent"), ("resets_at", "resetsAt"),
                      ("remaining_percentage", "remainingPercent")):
        value = number(node.get(key))
        if value is not None:
            result[name] = value
    return result


def read_statusline(stream: IO[bytes], *, max_bytes: int) -> dict[str, Any]:
    """The host payload as a document, with every absent field named."""
    try:
        data = read_payload(stream, max_bytes)
    except HostPayloadError as error:
        return {"state": STATE_FAILED, "reason": str(error), "absent": []}
    if not data.strip():
        # The host ran the command without a session behind it. That is a state,
        # not a failure, and it is not an empty session either.
        return {"state": STATE_EMPTY, "absent": []}
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return {"state": STATE_FAILED, "reason": type(error).__name__, "absent": []}
    if not isinstance(payload, dict):
        return {"state": STATE_FAILED, "reason": "the payload is not an object", "absent": []}

    document: dict[str, Any] = {"state": STATE_READY, "bytes": len(data), "absent": []}
    for key in ("cost", "context", "model", "session", "rateLimits"):
        document[key] = {}

    for source, name in TEXT_PATHS:
        value = text(payload.get(source))
        if value is None:
            document["absent"].append(name)
        else:
            target = document[name.split(".")[0]]
            target[name.split(".")[1]] = value

    for parent, source, name in MODEL_PATHS:
        value = text(at(payload, parent, source))
        if value is None:
            document["absent"].append(name)
        else:
            document["model"][name.split(".")[1]] = value

    for parent, source, name in NUMBER_PATHS:
        if name == "context.currentUsage":
            block = usage_block(payload)
            if block:
                document["context"]["currentUsage"] = block
            else:
                document["absent"].append(name)
            continue
        value = number(at(payload, parent, source))
        if value is None:
            document["absent"].append(name)
        else:
            document[name.split(".")[0]][name.split(".")[1]] = value

    for parent, source, name in LIMIT_PATHS:
        block = limit_block(payload, parent, source)
        if block:
            document["rateLimits"][name.split(".")[1]] = block
        else:
            document["absent"].append(name)

    for source, name in PASSTHROUGH:
        value = payload.get(source)
        if isinstance(value, dict) and value:
            document[name] = value
        else:
            document["absent"].append(name)
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read the host statusline payload")
    parser.add_argument("--config", default=None,
                        help="the configuration document; the declared default is used without it")
    parser.add_argument("--max-bytes", type=int, default=None,
                        help="override the configured byte limit, for a test with a small payload")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    if args.max_bytes is not None:
        limit = args.max_bytes
    else:
        try:
            config = load_config(args.config)
        except ConfigError as refusal:
            json.dump({"configErrors": refusal.errors}, sys.stdout, indent=2)
            sys.stdout.write("\n")
            return 2
        limit = config["limits"]["hostPayloadBytes"]
    document = read_statusline(sys.stdin.buffer, max_bytes=limit)
    json.dump(document, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")
    return 0 if document["state"] == STATE_READY else 1


if __name__ == "__main__":
    raise SystemExit(main())
