#!/usr/bin/env python3
"""What this session has spent, and the parameters it is running under.

The host hands its payload to the statusline command on stdin, and that command
is the only process that ever sees it. So the payload this reads is the one a
renderer recorded, at the path the configuration names, and this layer reads it
rather than asking the host for a second copy.

Two rules hold it together, and both are about not inventing a figure:

- a field the payload did not carry stays absent. A session whose context window
  the host never reported is not a session at 0% of it, and the pane cannot tell
  the difference unless this layer keeps them apart;
- a payload that is not there is a state rather than a zero. The renderer may
  never have run, or the session may be the first one since it did, and both are
  "nobody has told us" rather than "spent nothing".

The machine-wide spend is read from the folder the status line keeps its
priced session files in, bounded by the same byte limit as the payload: a file
older than the configured window is not counted, and a file that cannot be read
or priced is counted as skipped rather than drawn as spend.

Read-only by design: this opens files and reports what they hold.

Run with: python3 plugins/fleet/readers/session.py --config <path>
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Mapping

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.runtime import read_bounded_json

# A session identifier names a file in the status line's own folder. Nothing
# that could climb out of it is accepted, which is the same rule the job reader
# applies to an identifier that names its folder.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
# The name the status line gives each priced session's file.
SPEND_FILE = "*-session-*.json"
# A window the resolved configuration cannot have produced still has to draw
# something, and the declared default is the one the schema documents.
DEFAULT_SPEND_SECONDS = 86400

STATE_READY = "ready"
STATE_EMPTY = "empty"
STATE_UNAVAILABLE = "unavailable"
STATE_FAILED = "failed"
STATE_DISABLED = "disabled"

# Every field this layer reads, as a path into the payload. The name is what the
# pane draws, so the two stay in step by construction rather than by memory.
FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("costUsd", ("cost", "total_cost_usd")),
    ("durationMs", ("cost", "total_duration_ms")),
    ("apiDurationMs", ("cost", "total_api_duration_ms")),
    ("linesAdded", ("cost", "total_lines_added")),
    ("linesRemoved", ("cost", "total_lines_removed")),
    ("inputTokens", ("context_window", "total_input_tokens")),
    ("outputTokens", ("context_window", "total_output_tokens")),
    ("remainingPercent", ("context_window", "remaining_percentage")),
    ("windowSize", ("context_window", "context_window_size")),
    ("cacheReadTokens", ("context_window", "current_usage", "cache_read_input_tokens")),
    ("cacheCreationTokens", ("context_window", "current_usage",
                             "cache_creation_input_tokens")),
    ("fiveHourUsedPercent", ("rate_limits", "five_hour", "used_percentage")),
    ("fiveHourResetsAt", ("rate_limits", "five_hour", "resets_at")),
    ("sevenDayUsedPercent", ("rate_limits", "seven_day", "used_percentage")),
    ("weekResetsAt", ("rate_limits", "seven_day", "resets_at")),
    ("spendUsedPercent", ("rate_limits", "spend_limit", "used_percentage")),
)
TEXTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("sessionId", ("session_id",)),
    ("sessionName", ("session_name",)),
    ("cwd", ("cwd",)),
    ("version", ("version",)),
    ("model", ("model", "id")),
    ("modelName", ("model", "display_name")),
    ("outputStyle", ("output_style",)),
)
# The parameters a session runs under, which the payload may carry as a value or
# as an object. They are reported as written rather than interpreted: this layer
# does not know what an effort level means, and a word it guessed at would be one
# the pane draws as a fact.
PARAMETERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("effort", ("effort",)),
    ("thinking", ("thinking",)),
    ("promptCache", ("prompt_cache",)),
    ("worktree", ("worktree",)),
    ("pullRequest", ("pr",)),
)


def number(value: Any) -> float | int | None:
    """A number, or nothing. A boolean is not a number, however Python counts it."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def at(payload: Mapping[str, Any], *path: str) -> Any:
    node: Any = payload
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def named(value: Any) -> Any:
    """A payload value as a pane can draw it: a scalar, or nothing at all.

    A dict or a list is reported by whether it holds anything rather than by its
    own text, because `{'used': 3}` drawn on a row is the pane printing the shape
    of an object at somebody. What the pane wants to know about a worktree or a
    pull request is that there is one.
    """
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return value
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, dict):
        return "present" if value else None
    if isinstance(value, list):
        return str(len(value)) + " set" if value else None
    return None


def priced_cost(document: Any) -> float | None:
    """The cost a status line file holds, or nothing when it holds no usable one.

    The same rule serves one session's file and the machine-wide sum: a figure
    that is absent, not a number, not finite or negative is money this layer
    cannot prove, and a guess would be a bill nobody sent.
    """
    usage = document.get("usage") if isinstance(document, dict) else None
    cost = usage.get("cost") if isinstance(usage, dict) else None
    if isinstance(cost, bool) or not isinstance(cost, (int, float)):
        return None
    if not math.isfinite(cost) or cost < 0:
        return None
    return float(cost)


def spend_in_window(source: Mapping[str, Any], limit: int, *,
                    now: float | None = None) -> dict[str, Any] | None:
    """What every routed session spent inside the window, as the status line priced it.

    One file per routed session, each written when its session last spent. Only
    a file written inside the window counts; a file that cannot be read, is over
    the byte bound, or holds no usable cost is counted as skipped rather than
    summed as nothing. A folder that is not there is a state, never a zero: the
    machine did not spend `$0.00`, nobody could see what it spent.

    The figure is absent when every file inside the window was skipped: a sum of
    nothing that lost something is not the same claim as a machine that spent
    nothing, and only the second one may be drawn as a cost.
    """
    folder = source.get("sessionCosts")
    if not folder:
        return None
    directory = Path(str(folder))
    try:
        if not directory.is_dir():
            return {"spendWindowState": STATE_UNAVAILABLE}
        candidates = sorted(directory.glob(SPEND_FILE))
    except OSError:
        return {"spendWindowState": STATE_UNAVAILABLE}
    window = source.get("spendSeconds")
    if isinstance(window, bool) or not isinstance(window, int) or window < 1:
        window = DEFAULT_SPEND_SECONDS
    clock = time.time() if now is None else float(now)
    cutoff = clock - window
    total = 0.0
    counted = 0
    skipped = 0
    for candidate in candidates:
        try:
            written = candidate.stat().st_mtime
        except OSError:
            skipped += 1
            continue
        # A file older than the window is not counted and is not a refusal: it
        # is a session that spent nothing inside the stretch being asked about.
        if written < cutoff:
            continue
        cost = priced_cost(read_bounded_json(candidate, limit))
        if cost is None:
            skipped += 1
            continue
        total += cost
        counted += 1
    document: dict[str, Any] = {"spendWindowState": STATE_READY,
                                "spendWindowFiles": counted,
                                "spendWindowSkipped": skipped}
    if counted or not skipped:
        document["spendWindowUsd"] = round(total, 6)
    return document


# Where a declared payload path names the session it belongs to.
SESSION_PLACEHOLDER = "{session}"


def payload_path(declared: str, session_id: str) -> Path | None:
    """The file this session's payload is in, or None when it cannot be named.

    One renderer serves every session on the machine, so a single file holds
    whichever session rendered last. A declared path holding the placeholder is
    filled with the identifier this read was asked about, and an identifier that
    is absent or could climb out of its folder names nothing at all.
    """
    if SESSION_PLACEHOLDER not in declared:
        return Path(declared)
    if not session_id or not SESSION_ID.fullmatch(str(session_id)):
        return None
    return Path(declared.replace(SESSION_PLACEHOLDER, str(session_id)))


def provider_cost(source: Mapping[str, Any], session_id: str, model: str,
                  limit: int) -> float | None:
    """What a routed session spent, as the status line priced it.

    The host's own cost is an Anthropic-table figure: on a session routed to
    another provider it is not that provider's money, and on this machine it has
    read about eighty-eight times the real spend. The status line prices a routed
    session from its transcript at the provider's rates and keeps the answer in
    one file per session, which this reads rather than recomputing.

    Nothing is reported for a Claude model, whose host figure is the right one,
    and nothing for a file that is absent, ambiguous or does not hold a cost.
    """
    folder = source.get("sessionCosts")
    if not folder or not session_id or not SESSION_ID.fullmatch(str(session_id)):
        return None
    if str(model).lower().startswith("claude"):
        return None
    directory = Path(str(folder))
    try:
        candidates = sorted(directory.glob("*-session-" + str(session_id) + ".json"))
    except OSError:
        return None
    # One file per provider, and a session runs under one provider. Two files
    # naming one session is a state this cannot price, and a guess would be the
    # wrong provider's money.
    if len(candidates) != 1:
        return None
    return priced_cost(read_bounded_json(candidates[0], limit))


# A session running under Codex is the one whose own rate-limit windows this
# layer can read; the host's payload and the priced-spend memo are not where
# Codex keeps them.
CODEX_MODELS = ("codex", "gpt-")
# A rollout is a transcript of the whole session and grows to megabytes. The
# last rate-limit line is what this reads, so it reads the end of the file and
# never more than the byte bound the caller names.
ROLLOUT_SCAN_LINES = 2000
ROLLOUT = "rollout-*.jsonl"


def read_tail(path: Path, limit: int) -> str | None:
    """The last `limit` bytes of a file, as text, or nothing it could not read.

    A tail that starts mid-line drops that partial line: it is not a record, and
    parsing half a record is how a figure gets invented.
    """
    try:
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            start = max(0, size - limit)
            handle.seek(start)
            data = handle.read(limit)
    except (OSError, ValueError):
        return None
    if start > 0:
        cut = data.find(b"\n")
        data = data[cut + 1:] if cut >= 0 else b""
    return data.decode("utf-8", errors="replace")


def codex_window(name: str, entry: Any) -> dict[str, Any] | None:
    """One window as the pane can draw it: every unusable figure left out.

    A percentage outside nought to a hundred, a non-number, or a value JSON's
    own parser let through as infinity is absent rather than drawn as nought,
    which would be this layer stating a spend the rollout never reported.
    """
    if not isinstance(entry, dict):
        return None
    window: dict[str, Any] = {"name": name}
    used = number(entry.get("used_percent"))
    if used is not None and math.isfinite(used) and 0 <= used <= 100:
        window["usedPercent"] = used
    minutes = number(entry.get("window_minutes"))
    if minutes is not None and math.isfinite(minutes) and minutes > 0:
        window["windowMinutes"] = minutes
    resets = number(entry.get("resets_at"))
    if resets is not None and math.isfinite(resets):
        window["resetsAt"] = resets
    return window


def codex_credit(credits: Any) -> float | None:
    """The credit balance Codex reports, or nothing when there is none to report.

    The rollout writes the balance as a decimal string, so a string that parses
    as a finite number is a balance and anything else is not one.
    """
    if not isinstance(credits, dict) or credits.get("has_credits") is not True \
            or credits.get("unlimited") is True:
        return None
    balance = number(credits.get("balance"))
    if balance is None and isinstance(credits.get("balance"), str):
        try:
            balance = number(float(credits["balance"]))
        except ValueError:
            return None
    return float(balance) if balance is not None and math.isfinite(balance) else None


def codex_limits(folder: str | Path | None, limit: int) -> dict[str, Any]:
    """The rate-limit windows the newest Codex rollout reports, or unavailable.

    Codex writes one rollout per session under `~/.codex/sessions`, and the last
    `token_count` event in it carries the windows the person is metered by. A
    folder that is not there, or a rollout whose tail holds no parseable limits,
    is a state that says so: nothing here is reported as a nought.
    """
    def unavailable(reason: str) -> dict[str, Any]:
        return {"state": STATE_UNAVAILABLE,
                "errors": [{"source": "session", "reason": reason}]}

    if not folder:
        return unavailable("no folder is configured for Codex sessions")
    directory = Path(str(folder))
    if not directory.is_dir():
        return unavailable("the Codex sessions folder is not there")
    newest: Path | None = None
    newest_at = -1.0
    try:
        for candidate in directory.rglob(ROLLOUT):
            if not candidate.is_file():
                continue
            modified = candidate.stat().st_mtime
            if modified > newest_at:
                newest, newest_at = candidate, modified
    except OSError:
        return unavailable("the Codex sessions folder could not be read")
    if newest is None:
        return unavailable("the Codex sessions folder holds no rollout")
    tail = read_tail(newest, limit)
    if tail is None:
        return unavailable("the newest rollout could not be read")
    for line in reversed(tail.splitlines()[-ROLLOUT_SCAN_LINES:]):
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            # A rollout is appended to while it is read, so its final line can
            # be half written. That line is skipped, never drawn.
            continue
        if not isinstance(record, dict) or record.get("type") != "event_msg":
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "token_count":
            continue
        limits = payload.get("rate_limits")
        if not isinstance(limits, dict):
            continue
        windows = [window for name in ("primary", "secondary")
                   if (window := codex_window(name, limits.get(name))) is not None]
        if not windows:
            continue
        found: dict[str, Any] = {"state": STATE_READY, "provider": "codex",
                                 "windows": windows}
        balance = codex_credit(limits.get("credits"))
        if balance is not None:
            found["creditsBalance"] = balance
        return found
    return unavailable("the newest rollout carries no rate limits")


def codex_folder(source: Mapping[str, Any]) -> Path | None:
    """Where Codex keeps its rollouts: the configured folder, or the default."""
    declared = source.get("codexSessions")
    if declared:
        return Path(str(declared))
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if not home:
        return None
    return Path(home) / ".codex" / "sessions"


def session_limits(source: Mapping[str, Any], model: str, limit: int) -> Any:
    """Codex's own windows for a Codex session, and nothing for any other.

    A session routed to DeepSeek or running a Claude model has no Codex windows,
    and drawing one machine's limits on another provider's session would be a
    figure that session never reported.
    """
    if not source.get("enabled"):
        return None
    if not str(model).lower().startswith(CODEX_MODELS):
        return None
    found = codex_limits(codex_folder(source), limit)
    if found.get("state") == STATE_READY and "creditsBalance" in found:
        found["credits"] = found.pop("creditsBalance")
    return found


def read_session(config: Mapping[str, Any], *, session_id: str = "",
                 model: str = "", now: float | None = None) -> dict[str, Any]:
    """This session's figures and the machine's window spend.

    The spend crosses every routed session on the machine rather than this one
    alone, so it is attached to whatever the session's own figures report. A
    session whose payload is missing still has a machine behind it, and the
    card beside its cost has a figure to draw while the rest waits for the
    engine. A switched-off source has no figure of either kind.
    """
    document = session_figures(config, session_id=session_id, model=model)
    source = config["sources"]["statusline"]
    if source["enabled"]:
        spend = spend_in_window(source, int(config["limits"]["jobStateBytes"]), now=now)
        if spend is not None:
            document.update(spend)
    return document


def session_figures(config: Mapping[str, Any], *, session_id: str = "",
                    model: str = "") -> dict[str, Any]:
    """This session's figures, or the state that says why there are none."""
    document = figures(config, session_id=session_id, model=model)
    document["limits"] = session_limits(config["sources"]["statusline"], model,
                                        int(config["limits"]["jobStateBytes"]))
    return document


def figures(config: Mapping[str, Any], *, session_id: str = "",
            model: str = "") -> dict[str, Any]:
    """The payload's figures, or the state that says why there are none."""
    source = config["sources"]["statusline"]
    if not source["enabled"]:
        return {"state": STATE_DISABLED, "errors": []}
    priced = provider_cost(source, session_id, model, int(config["limits"]["jobStateBytes"]))
    document = payload_figures(config, session_id)
    if priced is not None:
        # The provider's own figure replaces the host's: both are costs, and one
        # of them is the money this session actually spends. The payload's other
        # figures are kept beside it, so a routed session still knows its model
        # and its context from what the renderer recorded.
        if document.get("state") == STATE_READY:
            document["providerCostUsd"] = priced
            document["costSource"] = "provider"
            return document
        return {"state": STATE_READY, "errors": [], "absent": [], "parameters": {},
                "providerCostUsd": priced, "costSource": "provider"}
    return document


def payload_figures(config: Mapping[str, Any], session_id: str) -> dict[str, Any]:
    """What the renderer recorded for this session, or the state saying why not."""
    source = config["sources"]["statusline"]
    declared = source.get("payload")
    if not declared:
        return {"state": STATE_UNAVAILABLE, "errors": [
            {"source": "session", "reason": "no payload path is configured"}]}
    path = payload_path(str(declared), session_id)
    if path is None:
        # A path naming the session says which file to read; with no identifier
        # there is no file, and reading whichever one exists would draw another
        # session's figures under this session's name.
        return {"state": STATE_UNAVAILABLE, "errors": [
            {"source": "session", "reason": "the payload path names a session and none is known"}]}
    if not path.is_file():
        return {"state": STATE_UNAVAILABLE, "errors": [
            {"source": "session", "reason": "the renderer has not written a payload"}]}
    limit = int(config["limits"]["hostPayloadBytes"])
    try:
        size = path.stat().st_size
    except OSError:
        return {"state": STATE_FAILED, "errors": [
            {"source": "session", "reason": "the payload could not be read"}]}
    if size > limit:
        # One byte over is a refusal, never a truncation: a payload cut off is a
        # different document, and the fields missing from it are missing because
        # of this layer rather than because the host did not send them.
        return {"state": STATE_FAILED, "errors": [
            {"source": "session",
             "reason": "the payload is larger than the configured limit"}]}
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as caught:
        return {"state": STATE_FAILED, "errors": [
            {"source": "session", "reason": type(caught).__name__}]}
    if not raw.strip():
        # The renderer ran without a session behind it and wrote nothing. That is
        # the state the statusline command already reports for an empty payload,
        # and it is not a failure: nothing was refused, there was nothing to say.
        return {"state": STATE_EMPTY, "errors": []}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as caught:
        return {"state": STATE_FAILED, "errors": [
            {"source": "session", "reason": type(caught).__name__}]}
    return document_of(payload)


def document_of(payload: Any) -> dict[str, Any]:
    """The payload as the pane's own document, with every absent field named."""
    if not isinstance(payload, dict) or not payload:
        # A file holding nothing is a renderer that ran without a session behind
        # it, which is a state rather than a failure and not an empty one either.
        return {"state": STATE_EMPTY, "errors": []}
    document: dict[str, Any] = {"state": STATE_READY, "errors": [], "absent": []}
    for name, path in FIELDS:
        value = number(at(payload, *path))
        if value is None:
            document["absent"].append(name)
        else:
            document[name] = value
    for name, path in TEXTS:
        value = at(payload, *path)
        if isinstance(value, str) and value:
            document[name] = value
        else:
            document["absent"].append(name)
    parameters: dict[str, Any] = {}
    for name, path in PARAMETERS:
        value = named(at(payload, *path))
        if value is None:
            document["absent"].append(name)
        else:
            parameters[name] = value
    document["parameters"] = parameters
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read this session's cost and parameters")
    parser.add_argument("--config", default=None)
    parser.add_argument("--session", default="", help="this session's identifier")
    parser.add_argument("--model", default="", help="the model this session runs")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        json.dump({"configErrors": refusal.errors}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2
    document = read_session(config, session_id=args.session, model=args.model)
    json.dump(document, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")
    return 0 if document["state"] == STATE_READY else 1


if __name__ == "__main__":
    raise SystemExit(main())
