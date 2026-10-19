#!/usr/bin/env python3
"""Session economics: what this session's transcript says it spent and saved.

A transcript is append-only JSONL, one record per line, written by the host while
the session runs. The cache saving is summed directly from it rather than sampled
per render: the statusline only runs on interaction, so an accumulator folded at
render time misses every API call between two renders and undercounts badly.

The prices are the ones the agent cards use, `sources.agents`, so a session is
priced once. In dollars, at the model family's rates:

    saved = cache_read * (input_rate - cache_read_rate)
            - cache_write_5m * input_rate * (5m_multiplier - 1)
            - cache_write_1h * input_rate * (1h_multiplier - 1)

that is, what the cached tokens would have cost at the input rate, less what was
paid to read and write them. A write whose lifetime the host did not split is
taken at the five-minute premium, which never overstates the saving. The token
figure is the same saving in input tokens at the family's input rate.

Both figures are reported as read. A cold session can show a negative difference,
and this layer states it rather than clamping it: the renderer suppresses a
negative saving from the line, and it cannot do that if the number never arrives.

Run with: python3 plugins/llm-fleet/readers/transcript.py --path <transcript.jsonl>
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Mapping

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.agents import family_of

STATE_READY = "ready"
STATE_EMPTY = "empty"
STATE_UNAVAILABLE = "unavailable"
STATE_FAILED = "failed"

USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
LONG_LIVED_KEY = "ephemeral_1h_input_tokens"


class TranscriptError(ValueError):
    """The transcript cannot be read at all."""


def _rate(value: Any) -> float | None:
    """A configured rate, or None for anything that is not a number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def rates_for(family: str, prices: Mapping[str, Any]) -> dict[str, float] | None:
    """The four figures a saving is priced from, or None when one is missing.

    The family's rate and no other: a model outside the configured families
    has no saving rather than one priced at another family's rate.
    """
    figures = {}
    for name, key in (("input", "inputPricePerMTok"), ("cacheRead", "cacheReadPricePerMTok")):
        table = prices.get(key)
        rate = _rate(table.get(family)) if isinstance(table, Mapping) else None
        if rate is None:
            return None
        figures[name] = rate
    for name, key in (("write5m", "cacheWrite5mMultiplier"),
                      ("write1h", "cacheWrite1hMultiplier")):
        multiplier = _rate(prices.get(key))
        if multiplier is None:
            return None
        figures[name] = multiplier
    return figures


def saved_usd(cache_write_5m: int, cache_write_1h: int, cache_read: int,
              rates: Mapping[str, float]) -> float:
    """What the cache saved, in dollars, against paying the input rate for every token.

    Negative when the write premium outweighs the reads, as a cold session's does.
    """
    scaled = (cache_read * (rates["input"] - rates["cacheRead"])
              - cache_write_5m * rates["input"] * (rates["write5m"] - 1)
              - cache_write_1h * rates["input"] * (rates["write1h"] - 1))
    return scaled / 1_000_000


def message_id(record: Any) -> str | None:
    """The identifier of the response an assistant record belongs to, if it names one."""
    message = record.get("message") if isinstance(record, dict) else None
    identifier = message.get("id") if isinstance(message, dict) else None
    return identifier if isinstance(identifier, str) else None


def _counted(value: Any, key: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TranscriptError(f"the {key} count is not a count")
    return value


def usage_of(record: Any) -> tuple[int, int, int, int] | None:
    """Input, cache writes, the long-lived part of them, and cache reads, or None.

    None is a record that carries no usage. The host splits a cache write by
    its lifetime in a nested block; where it does not, the write is all
    short-lived, and a long-lived count larger than the writes is damage.
    """
    if not isinstance(record, dict):
        raise TranscriptError("the record is not an object")
    if record.get("type") != "assistant":
        return None
    message = record.get("message")
    if message is None:
        return None
    if not isinstance(message, dict):
        raise TranscriptError("the message is not an object")
    usage = message.get("usage")
    if usage is None:
        return None
    if not isinstance(usage, dict):
        raise TranscriptError("the usage block is not an object")
    counts = [_counted(usage.get(key, 0), key) for key in USAGE_KEYS]
    split = usage.get("cache_creation")
    long_lived = 0
    if split is not None:
        if not isinstance(split, dict):
            raise TranscriptError("the cache write split is not an object")
        long_lived = _counted(split.get(LONG_LIVED_KEY, 0), LONG_LIVED_KEY)
        if long_lived > counts[1]:
            raise TranscriptError("the long-lived cache writes exceed the cache writes")
    return counts[0], counts[1], long_lived, counts[2]


def read_bounded(path: Path, max_bytes: int) -> tuple[bytes, bool]:
    """The bytes of a file, and whether the limit cut the read short."""
    with path.open("rb") as handle:
        data = handle.read(max_bytes + 1)
    return data[:max_bytes], len(data) > max_bytes


def scan(data: bytes, truncated: bool) -> dict[str, Any]:
    """Sum every assistant usage record in the bytes that were read."""
    lines = data.split(b"\n")
    if truncated and lines:
        # A cut read ends mid-record. Dropping the partial line keeps a damaged
        # count out of the sum, and the truncation is named by the caller.
        lines = lines[:-1]
    input_tokens = cache_creation = long_lived = cache_read = 0
    records = damaged = 0
    # The host writes one response as a record per content block, each carrying
    # the response's whole usage. Counting records counts a response once per
    # block, so a response is counted once, by its identifier.
    seen: set[str] = set()
    for raw in lines:
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
            usage = usage_of(record)
        except (TranscriptError, UnicodeDecodeError, json.JSONDecodeError):
            # A transcript is written while it is read, so a damaged record is
            # expected and counted rather than treated as the end of the file.
            damaged += 1
            continue
        if usage is None:
            continue
        identifier = message_id(record)
        if identifier is not None:
            if identifier in seen:
                continue
            seen.add(identifier)
        records += 1
        input_tokens += usage[0]
        cache_creation += usage[1]
        long_lived += usage[2]
        cache_read += usage[3]
    return {"records": records, "damagedRecords": damaged, "inputTokens": input_tokens,
            "cacheCreationTokens": cache_creation, "cacheWrite1hTokens": long_lived,
            "cacheReadTokens": cache_read}


def read_transcript(path: str | Path | None, *, max_bytes: int, model_id: str | None,
                    prices: Mapping[str, Any]) -> dict[str, Any]:
    """This session's economics, or the state that says why there are none.

    `prices` is the `sources.agents` group: the family rates and the cache
    write multipliers the agent cards price a session at.
    """
    if max_bytes < 1:
        return {"state": STATE_FAILED, "reason": "the byte limit must be positive"}
    if not path:
        return {"state": STATE_UNAVAILABLE, "reason": "the host named no transcript"}
    target = Path(path).expanduser()
    if not target.is_file():
        return {"state": STATE_UNAVAILABLE, "reason": "the transcript is not there",
                "path": str(target)}
    try:
        data, truncated = read_bounded(target, max_bytes)
    except OSError as error:
        return {"state": STATE_FAILED, "reason": type(error).__name__, "path": str(target)}
    if not data.strip():
        return {"state": STATE_EMPTY, "reason": "the transcript holds no records",
                "path": str(target), "bytes": len(data), "truncated": False}
    totals = scan(data, truncated)
    families = prices.get("inputPricePerMTok")
    price_family = family_of(model_id, list(families) if isinstance(families, Mapping) else [])
    rates = rates_for(price_family, prices)
    document: dict[str, Any] = {
        "state": STATE_READY if totals["records"] else STATE_EMPTY,
        "path": str(target),
        "bytes": len(data),
        "truncated": truncated,
        "rawTokens": (totals["inputTokens"] + totals["cacheCreationTokens"]
                      + totals["cacheReadTokens"]),
        "priceFamily": price_family,
    }
    document.update(totals)
    if rates is None:
        document["prices"] = "absent"
    else:
        document["pricePerMTok"] = rates["input"]
        # A price applied to nothing is not a saving of zero. With no assistant
        # record read, the figure is absent and the state says why.
        if totals["records"]:
            saving = saved_usd(totals["cacheCreationTokens"] - totals["cacheWrite1hTokens"],
                               totals["cacheWrite1hTokens"], totals["cacheReadTokens"], rates)
            document["savedUsd"] = round(saving, 4)
            if rates["input"] > 0:
                document["savedTokens"] = int(round(saving * 1_000_000 / rates["input"]))
    if truncated:
        document["reason"] = f"the transcript is longer than {max_bytes} bytes"
    if totals["records"] == 0 and totals["damagedRecords"]:
        document["reason"] = "no record in the transcript could be read"
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sum a session transcript's economics")
    parser.add_argument("--config", default=None)
    parser.add_argument("--path", default=None, help="the transcript to read")
    parser.add_argument("--model", default=None, help="the model identifier the session runs")
    parser.add_argument("--max-bytes", type=int, default=None)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        json.dump({"configErrors": refusal.errors}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2
    limit = args.max_bytes if args.max_bytes is not None else config["limits"]["hostPayloadBytes"]
    prices = config["sources"]["agents"]
    document = read_transcript(args.path, max_bytes=limit, model_id=args.model, prices=prices)
    json.dump(document, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")
    return 0 if document["state"] == STATE_READY else 1


if __name__ == "__main__":
    raise SystemExit(main())
