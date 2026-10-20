#!/usr/bin/env python3
"""Agent figures: what one roster session has spent, and where it stands.

The roster command reports a session's name, state and start, and nothing it
spent. The figures on an agent card come from two places the host writes for
every session, read and never written here:

- the transcript, append-only JSONL under the provider home's project folders:
  the model and effort of each turn, its token usage, the session's title, and
  the cost the host records when a session ends;
- the task list, one small JSON file per task under the provider home's task
  folder for the session, which is the only plan a session states. A step count
  is drawn from it and from nothing else: a session that keeps no list has no
  denominator, and none is made up for it.

Each subagent a session runs writes its own turns to
`<session id>/subagents/*.jsonl` beside the session's transcript, and the host
counts them in the cost it records. They are read under the bound and the
one-price-per-response rule the session's own transcript is read under, and what
they add is summed into the session's figures: the same response is priced once
across every transcript the session wrote.

The host writes one API response as several transcript records, one per content
block, each repeating the same usage. Summing records counts a response once per
block, so usage is taken once per message identifier.

A transcript longer than the configured bound is read from its tail. Usage only
adds, so the totals of a tail are lower bounds on the whole, and the document
says so rather than drawing them as the session's spend. A subagent transcript
the read cannot cover whole is named the same way, never passed over: a total
that leaves one out is a smaller number than the session spent.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from typing import Any, Mapping

from .runtime import cut, read_bounded_json, valid_job_id

STATE_READY = "ready"
STATE_EMPTY = "empty"
STATE_UNAVAILABLE = "unavailable"
STATE_FAILED = "failed"

# A session identifier names a file under the provider home, so only the shape
# the host writes may reach a path.
SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# A bound on how many task files one read opens. Like every read bound it is an
# invariant rather than a setting: a folder another process fills must not
# decide how long a snapshot takes.
MAX_TASK_FILES = 500
# A bound on how many subagent transcripts one read opens, for the reason every
# read bound exists: a folder another process fills must not decide how long a
# snapshot takes. A session holding more than this has its totals stated as a
# floor, since a figure that leaves the rest out is smaller than what was spent.
MAX_SUBAGENT_FILES = 64
STEP_STATES = ("pending", "in_progress", "completed")
# The model name the host gives a record it wrote itself, with no call behind it.
PLACEHOLDER_MODEL = "<synthetic>"
WORDS = 80

_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
# Windows opens a descriptor in text mode unless told otherwise, which turns
# every CRLF into LF as it reads: byte counts stop matching the file, and a
# bound measured in bytes stops meaning what it says.
_BINARY = getattr(os, "O_BINARY", 0)
_NON_BLOCKING = getattr(os, "O_NONBLOCK", 0)


def transcript_of(home: Path, session_id: Any) -> Path | None:
    """The session's transcript under the home's project folders, or None.

    The project folder is named after the directory the session started in, and
    a session can move after it starts, so the file is found by its name rather
    than by working out the folder. Where two folders hold one, the newer wins.
    """
    if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
        return None
    found: list[tuple[float, Path]] = []
    for candidate in (Path(home) / "projects").glob("*/" + session_id + ".jsonl"):
        try:
            info = candidate.lstat()
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode):
            found.append((info.st_mtime, candidate))
    if not found:
        return None
    return max(found)[1]


def read_tail(path: Path, max_bytes: int) -> tuple[bytes, bool]:
    """The file's bytes, or its last `max_bytes` from a line start, and whether cut.

    Refuses anything but a regular file and never follows a link, because the
    folder is written by the session being read.
    """
    handle = os.open(path, os.O_RDONLY | _BINARY | _NO_FOLLOW | _NON_BLOCKING)
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode):
            raise OSError("not a regular file")
        cut_short = info.st_size > max_bytes
        if cut_short:
            os.lseek(handle, info.st_size - max_bytes, os.SEEK_SET)
        chunks: list[bytes] = []
        # One byte past the bound tells a file that grew after the size check
        # from one that is exactly the bound long.
        left = max_bytes if cut_short else max_bytes + 1
        while left > 0:
            chunk = os.read(handle, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
    finally:
        os.close(handle)
    data = b"".join(chunks)
    if cut_short:
        # The first line of a tail starts mid-record.
        data = data.split(b"\n", 1)[-1]
    elif len(data) > max_bytes:
        # The file grew past the bound between the size check and the read, so
        # this is a start without its end: its totals are floors as a tail's are.
        data, cut_short = data[:max_bytes], True
    if data and not data.endswith(b"\n"):
        # The last line is still being written. It is not damage, and counted
        # as damage it would make a session one turn old read as failed.
        data = data[:data.rfind(b"\n") + 1]
    return data, cut_short


# What may follow a key inside a model identifier for that key to be the model's
# own: nothing, or the eight-digit date the host stamps a generation with and
# nothing after it. A date only starts a longer identifier, so a suffix past the
# date is another model rather than the same one released on that day.
MODEL_DATE = re.compile(r"^-\d{8}$")
# The context marker the host appends to a model it runs with a larger window.
MODEL_CONTEXT = re.compile(r"\[[^\]]*\]$")


def names_this_model(name: str, key: str) -> bool:
    """Whether `key` is the whole generation `name` holds, not a prefix of one.

    A plain substring test prices a generation nobody checked: `claude-opus-5-1`
    contains `opus-5`, so an Opus 5 rate would answer for it. A key matches only
    where what follows it is the end of the identifier or the date the host
    stamps onto a generation, so `claude-haiku-4-5-20251001` is Haiku 4.5 and
    `claude-opus-5-1` is nothing the configuration names.
    """
    start = name.find(key)
    while start >= 0:
        rest = name[start + len(key):]
        if not rest or MODEL_DATE.match(rest):
            return True
        start = name.find(key, start + 1)
    return False


def family_of(model: str | None, families: list[str]) -> str:
    """The configured key a model identifier belongs to, or "other" for none.

    The longest key that names the whole identifier prices it, and the key's
    place in the map does not decide it. Two keys can both name one identifier:
    a model called `claude-mythos-5` is named whole by `mythos-5` and by
    `claude-mythos-5`, and the more particular of the two is the one somebody
    configured on purpose. A key naming a family is not a whole generation of
    every model under it, so it prices none of them: that is what keeps a
    generation nobody checked from borrowing the rates of the one beside it.
    """
    name = MODEL_CONTEXT.sub("", (model or "").lower())
    matched = ""
    for family in families:
        if (family and family != "other" and len(family) > len(matched)
                and names_this_model(name, family)):
            matched = family
    return matched or "other"


def _is_count(value: Any) -> bool:
    """Whether a value is a token count as the host writes one."""
    return not isinstance(value, bool) and isinstance(value, int) and value >= 0


def _count(value: Any) -> int:
    """A token count as the host wrote it, or nought for anything that is not one."""
    return value if _is_count(value) else 0


def _seconds(stamp: Any) -> float | None:
    """An ISO timestamp as epoch seconds, or None."""
    if not isinstance(stamp, str):
        return None
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# The counts a response must state to be measured. A count the host left out is
# not a count of zero: read as one, it prices the response below what it cost.
USAGE_COUNTS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
                "output_tokens")


def _usage(message: Mapping[str, Any]) -> dict[str, int] | None:
    """A response's token counts, or None where any count is absent or not a count."""
    usage = message.get("usage")
    if not isinstance(usage, Mapping):
        return None
    counts = {key: usage.get(key) for key in USAGE_COUNTS}
    if not all(_is_count(value) for value in counts.values()):
        return None
    written = _count(counts["cache_creation_input_tokens"])
    split = usage.get("cache_creation")
    long_lived = 0
    if isinstance(split, Mapping):
        long_lived = min(written, _count(split.get("ephemeral_1h_input_tokens")))
    return {"input": _count(counts["input_tokens"]),
            "cacheWrite5m": written - long_lived,
            "cacheWrite1h": long_lived,
            "cacheRead": _count(counts["cache_read_input_tokens"]),
            "output": _count(counts["output_tokens"])}


def estimate(usage: Mapping[str, int], family: str,
             prices: Mapping[str, Any]) -> float | None:
    """One response's cost at the configured rates, or None where a rate is missing."""
    rates = []
    for key in ("inputPricePerMTok", "outputPricePerMTok", "cacheReadPricePerMTok"):
        table = prices[key]
        rate = table.get(family, table.get("other"))
        if isinstance(rate, bool) or not isinstance(rate, (int, float)):
            return None
        rates.append(float(rate))
    rate_in, rate_out, rate_read = rates
    total = (usage["input"] * rate_in
             + usage["cacheWrite5m"] * rate_in * float(prices["cacheWrite5mMultiplier"])
             + usage["cacheWrite1h"] * rate_in * float(prices["cacheWrite1hMultiplier"])
             + usage["cacheRead"] * rate_read
             + usage["output"] * rate_out)
    return total / 1_000_000


def is_claude(model: str | None) -> bool:
    """True for a model the host prices from its own table."""
    return "claude" in str(model or "").lower()


def cost_figures(turns: int, priced: bool, cost: float, host_cost: float | None,
                 covers: bool, host_guessed: bool = False) -> dict[str, Any]:
    """The cost a session's figures draw, and the word for where it came from.

    The host records what a session cost when it ends, and that figure counts
    what a transcript cannot see, such as the models a session called on the
    side, so it outranks an estimate, but only when it provably covers the
    session. Otherwise the larger of the two is drawn as the floor it is, since
    each figure counts part of the spend. A turn no configured rate prices
    leaves the total unpriced rather than drawn without it.

    `host_guessed` says the host could not price the session's model and the
    model is not Claude: the host's figure is then its own table applied to
    another vendor's model, which on a DeepSeek session read about eighty-eight
    times the bill, so a full estimate at the model's own rates stands instead.
    """
    estimated = round(cost, 4) if turns and priced else None
    if covers:
        return {"costUsd": round(float(host_cost), 4), "costSource": "host"}
    if host_guessed and estimated is not None:
        return {"costUsd": estimated, "costSource": "estimate"}
    if host_cost is not None:
        return {"costUsd": round(max(float(host_cost), estimated or 0.0), 4),
                "costSource": "floor"}
    if estimated is not None:
        return {"costUsd": estimated, "costSource": "estimate"}
    return {}


class Folded:
    """A transcript's figures, and the timed facts a series and a timeline are built from.

    `spend` holds one entry per response, priced once by its identifier as the
    figures are: its time, or None where the record states none, and its
    estimate, or None where a rate is missing or the response cannot be
    measured (no identifier, or no record of it stating its usage whole). A
    response that no record measures has one entry per record, each at that
    record's time, since any of them may be when it was spent. `stamps` holds the time of every
    assistant record that is a turn, in the order written.

    The four cost ingredients are kept beside the figures they were folded into,
    so a session's own transcript and its subagents' can be summed and priced
    once: `estimate` is usage at the configured rates before any host record was
    weighed against it, `priced` says every response was measurable, `hostCost`
    is the figure the host recorded, or None, and `covers` says that figure
    provably counts the whole session.
    """

    __slots__ = ("figures", "spend", "stamps", "estimate", "priced", "hostCost", "covers",
                 "hostUnknown", "models")

    def __init__(self, figures: dict[str, Any], spend: list[tuple[float | None, float | None]],
                 stamps: list[float], estimate: float = 0.0, priced: bool = True,
                 hostCost: float | None = None, covers: bool = False,
                 hostUnknown: bool = False,
                 models: dict[str, dict[str, Any]] | None = None) -> None:
        self.figures = figures
        self.spend = spend
        self.stamps = stamps
        self.estimate = estimate
        self.priced = priced
        self.hostCost = hostCost
        self.covers = covers
        self.hostUnknown = hostUnknown
        self.models = {} if models is None else models


def add_model_turn(models: dict[str, dict[str, Any]], model: str | None,
                   spent: float | None) -> None:
    """Count one priced turn against the model that ran it.

    A session can change model between turns, and a subagent can run another
    model than its session, so each turn is kept under its own model's name. A
    turn no rate prices leaves that model's cost unknown rather than short.
    """
    entry = models.setdefault(model or "", {"turns": 0, "costUsd": 0.0})
    entry["turns"] += 1
    if spent is None or entry["costUsd"] is None:
        entry["costUsd"] = None
    else:
        entry["costUsd"] += spent


def merge_models(into: dict[str, dict[str, Any]], more: Mapping[str, Mapping[str, Any]]) -> None:
    """Add one transcript's per-model counts to another's."""
    for name, entry in more.items():
        target = into.setdefault(name, {"turns": 0, "costUsd": 0.0})
        target["turns"] += entry["turns"]
        if target["costUsd"] is None or entry["costUsd"] is None:
            target["costUsd"] = None
        else:
            target["costUsd"] += entry["costUsd"]


def host_guessed(host_unknown: bool, models: Mapping[str, Any]) -> bool:
    """Whether the host's figure is its own table applied to another vendor's model.

    The host flags a session holding a model it has no rate for, and then
    prices that model's tokens from its own table anyway. Any model the session
    ran that is not Claude makes the figure a guess, whichever model ran last.
    """
    return host_unknown and any(name and not is_claude(name) for name in models)


def model_split(models: Mapping[str, Mapping[str, Any]],
                accounts: Mapping[str, Any] | None,
                families: list[str]) -> list[dict[str, Any]]:
    """Each model the session ran, with its turns, its cost, and where its rate came from.

    Dearest first, an unpriced model last. A turn whose record names no model
    is counted under no name, so the split still adds up to the session.
    """
    split: list[dict[str, Any]] = []
    for name, entry in models.items():
        row: dict[str, Any] = {"model": name or None, "turns": entry["turns"],
                               "costUsd": None if entry["costUsd"] is None
                               else round(entry["costUsd"], 4)}
        if isinstance(accounts, Mapping) and name:
            family = family_of(name, families)
            if family in accounts:
                row["rates"] = dict(accounts[family])
        split.append(row)
    split.sort(key=lambda row: (row["costUsd"] is None, -(row["costUsd"] or 0.0)))
    return split


def settle_unmeasured(spend: list[tuple[float | None, float | None]],
                      unmeasured: Mapping[str, list[float | None]]) -> bool:
    """Place every record of a response nobody measured at its own time.

    Every record keeps its own time, so the window holds unknown spend if any
    of them falls inside it. Called once, by the read, after every transcript
    of the session has been folded. True when a response was settled.
    """
    for times in unmeasured.values():
        spend.extend((stamp, None) for stamp in times)
    return bool(unmeasured)


def fold(data: bytes, prices: Mapping[str, Any], limit: int, whole: bool = True,
         seen: set[str] | None = None,
         unmeasured: dict[str, list[float | None]] | None = None) -> Folded:
    """One transcript's records, keeping each turn's time and price beside the totals.

    `seen` holds the message identifiers already priced. One set shared across
    every transcript a session wrote means a response the host wrote into two of
    them is priced once, which is the rule this read has always applied within
    one file.

    `unmeasured` holds the times of the records of each response no record has
    yet measured. It is not settled here: a response the session's own
    transcript states without usage may be measured by a subagent transcript
    read after it, so the caller reads every transcript of the session before
    calling `settle_unmeasured` once.
    """
    spend: list[tuple[float | None, float | None]] = []
    stamps: list[float] = []
    families = list(prices["inputPricePerMTok"].keys())
    # A window belongs to the family a model belongs to, not to one generation
    # of it, so the window map's own keys answer for it.
    windows = list(prices["contextWindowTokens"].keys())
    totals = {"input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0}
    seen = set() if seen is None else seen
    # The times of the records of each response no record has yet measured. A
    # caller reading several transcripts a session wrote passes one map, so a
    # response one of them measures is not left unknown by another.
    unmeasured = {} if unmeasured is None else unmeasured
    cost = 0.0
    priced = True
    turns = damaged = 0
    models: dict[str, dict[str, Any]] = {}
    model = effort = title = None
    context: dict[str, int] | None = None
    context_model = None
    first_activity = last_activity = first_usage = None
    host_start = None
    host_partial = False
    host_unknown = False
    host_cost = None
    host_cost_at = -1
    last_usage_at = -1
    for index, raw in enumerate(data.split(b"\n")):
        # Only three record kinds carry a figure, and a transcript is mostly
        # tool output: parsing every line to throw most of them away is the
        # cost a refresh pays for each agent.
        if (b'"assistant"' not in raw and b'"custom-title"' not in raw
                and b'"cost-state"' not in raw):
            continue
        try:
            record = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            damaged += 1
            continue
        if not isinstance(record, dict):
            damaged += 1
            continue
        kind = record.get("type")
        if kind == "custom-title":
            title = cut(record.get("customTitle"), limit) or title
            continue
        if kind == "cost-state":
            spent = record.get("totalCostUSD")
            if isinstance(spent, (int, float)) and not isinstance(spent, bool) and spent >= 0:
                host_cost, host_cost_at = float(spent), index
                started = record.get("startTime")
                host_start = started / 1000 if isinstance(started, (int, float)) \
                    and not isinstance(started, bool) else None
                host_partial = record.get("hasUnknownModelCost") is not False
                host_unknown = record.get("hasUnknownModelCost") is True
            continue
        if kind != "assistant":
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            damaged += 1
            continue
        usage = _usage(message)
        # A record the host wrote itself carries a placeholder model and no
        # usage. Taken as a turn it names the session's model as the
        # placeholder, empties its context, and, being in no priced family,
        # drops its cost.
        if message.get("model") == PLACEHOLDER_MODEL or (
                usage is not None and not any(usage.values())):
            continue
        stamp = _seconds(record.get("timestamp"))
        if stamp is not None:
            first_activity = stamp if first_activity is None else first_activity
            last_activity = stamp
            stamps.append(stamp)
        if isinstance(record.get("effort"), str):
            effort = cut(record["effort"], 16)
        if isinstance(message.get("model"), str):
            model = cut(message["model"], WORDS)
        identifier = message.get("id")
        named = isinstance(identifier, str)
        if named and identifier in seen:
            continue
        last_usage_at = index
        if first_usage is None:
            first_usage = stamp
        if named and usage is None:
            # A record of a response that states no usage, or one count of it
            # short, claims nothing yet: another record of the same response
            # may state it, before this one or after.
            unmeasured.setdefault(identifier, []).append(stamp)
            continue
        if named:
            seen.add(identifier)
            unmeasured.pop(identifier, None)
        if not named:
            # A response with no identifier to price it once by cost something
            # nobody can read. It is kept as a response of unknown price, so
            # neither the card nor the series states a sum that leaves it out.
            spent = None
        else:
            turns += 1
            totals["input"] += usage["input"]
            totals["cacheWrite"] += usage["cacheWrite5m"] + usage["cacheWrite1h"]
            totals["cacheRead"] += usage["cacheRead"]
            totals["output"] += usage["output"]
            if record.get("isSidechain") is not True:
                context = usage
                context_model = model
            spent = estimate(usage, family_of(model, families), prices)
            add_model_turn(models, model, spent)
        spend.append((stamp, spent))
        if spent is None:
            priced = False
        else:
            cost += spent
    # A response no record of which states its usage is of unknown price, and
    # the caller settles it once every transcript of the session is read.
    figures: dict[str, Any] = {
        "turns": turns, "damagedRecords": damaged, "title": title, "model": model,
        "effort": effort, "tokens": totals, "firstActivity": first_activity,
        "lastActivity": last_activity,
    }
    if context is not None:
        figures["contextTokens"] = context["input"] + context["cacheWrite5m"] \
            + context["cacheWrite1h"] + context["cacheRead"]
        window = prices["contextWindowTokens"].get(family_of(context_model, windows))
        if isinstance(window, int) and not isinstance(window, bool) and window > 0:
            figures["contextWindow"] = window
    # The host records what a session cost when it ends. That figure is drawn by
    # `cost_figures`, and only when it provably covers the session: nothing
    # spent after it, its own start no later than the first turn read from the
    # transcript's start, and no model the host could not price. A resumed or
    # forked session can carry a record that counts only part of what the
    # transcript holds, and drawn as exact it would understate it.
    covers = (host_cost is not None and host_cost_at > last_usage_at and whole
              and not host_partial and host_start is not None
              and (first_usage is None or host_start <= first_usage + 1))
    guessed = host_guessed(host_unknown, models)
    figures.update(cost_figures(turns, priced, cost, host_cost, covers, guessed))
    return Folded(figures, spend, stamps, cost, priced, host_cost, covers, host_unknown, models)


def subagent_files(transcript: Path) -> list[Path]:
    """The session's subagent transcripts beside its own transcript, or none.

    The host writes each subagent's turns to `<session id>/subagents/*.jsonl`,
    the session's own folder being named for its identifier and sitting beside
    its transcript. Only a folder that is not there at all is a session that ran
    no subagent: a folder that is a link, or that cannot be looked at, raises,
    and the caller names it rather than reading it as a session with none, which
    would draw a smaller figure in silence.

    Every `.jsonl` entry is listed, including one that is a link or not a
    regular file, since refusing those is `read_tail`'s work and a refusal there
    is a name the caller draws rather than a file quietly passed over.
    """
    folder = transcript.parent / transcript.stem / "subagents"
    try:
        info = os.lstat(folder)
    except FileNotFoundError:
        return []
    if not stat.S_ISDIR(info.st_mode):
        raise OSError("the subagents path is not a folder")
    with os.scandir(folder) as entries:
        return sorted(Path(entry.path) for entry in entries
                      if entry.name.endswith(".jsonl"))


def subagent_count(count: int) -> str:
    """`1 subagent transcript`, or `3 subagent transcripts`, for a named reason."""
    return "{0} subagent transcript{1}".format(count, "" if count == 1 else "s")


def read_subagents(transcript: Path, bound: int, prices: Mapping[str, Any], limit: int,
                   seen: set[str], unmeasured: dict[str, list[float | None]]) -> dict[str, Any]:
    """What the session's subagent transcripts add to its own figures.

    The host writes each subagent's turns beside the session's transcript and
    counts them in the cost it records, so a figure that sums the session's own
    transcript alone is low for exactly the sessions that ran one. Every file is
    read under the bound the session's own transcript is read under, and shares
    its set of priced responses, so a response is priced once for the session.

    A file the bound cut, one that could not be read, and a folder holding more
    files than one read opens are each counted here rather than passed over. The
    caller names them: a total that quietly leaves one out is a smaller number
    than the session spent, and a smaller number drawn as the spend is a wrong
    one.
    """
    totals = {"input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0}
    result: dict[str, Any] = {"turns": 0, "tokens": totals, "damaged": 0, "cost": 0.0,
                              "priced": True, "spend": [], "unreadable": 0, "cut": 0,
                              "over": 0, "models": {}}
    try:
        listed = subagent_files(transcript)
    except OSError:
        result["unreadable"] = 1
        return result
    result["over"] = max(0, len(listed) - MAX_SUBAGENT_FILES)
    for path in listed[:MAX_SUBAGENT_FILES]:
        try:
            data, cut = read_tail(path, bound)
        except OSError:
            result["unreadable"] += 1
            continue
        if cut:
            result["cut"] += 1
        # Not the last read of the session: a response none of these files
        # measures may still be settled by the caller.
        folded = fold(data, prices, limit, whole=not cut, seen=seen,
                      unmeasured=unmeasured)
        result["turns"] += folded.figures["turns"]
        result["damaged"] += folded.figures["damagedRecords"]
        result["cost"] += folded.estimate
        result["priced"] = result["priced"] and folded.priced
        for key, value in folded.figures["tokens"].items():
            totals[key] += value
        result["spend"].extend(folded.spend)
        merge_models(result["models"], folded.models)
    return result


def read_steps(home: Path, job_id: Any, max_bytes: int, limit: int) -> dict[str, Any] | None:
    """The session's task list as done of total, with the step in hand, or None."""
    if not valid_job_id(job_id):
        return None
    folder = Path(home) / "tasks" / ("session-" + str(job_id))
    if folder.is_symlink() or not folder.is_dir():
        return None
    tasks: list[tuple[int, dict[str, Any]]] = []
    try:
        names = sorted(entry.name for entry in os.scandir(folder)
                       if entry.name.endswith(".json"))[:MAX_TASK_FILES]
    except OSError:
        return None
    for name in names:
        task = read_bounded_json(folder / name, max_bytes)
        if not isinstance(task, dict) or task.get("status") not in STEP_STATES:
            continue
        stem = name[:-len(".json")]
        tasks.append((int(stem) if stem.isdigit() else 0, task))
    if not tasks:
        return None
    tasks.sort(key=lambda pair: pair[0])
    done = sum(1 for _, task in tasks if task["status"] == "completed")
    phase = None
    for _, task in tasks:
        if task["status"] == "in_progress":
            phase = cut(task.get("activeForm"), limit) or cut(task.get("subject"), limit)
            break
    return {"done": done, "total": len(tasks), "phase": phase}


def iso_time(seconds: float) -> str:
    """Epoch seconds as an ISO 8601 time in UTC, to the second."""
    moment = datetime.fromtimestamp(seconds, timezone.utc)
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def bucket_layout(history: Mapping[str, Any]) -> tuple[int, int]:
    """The configured bucket length in seconds and the bucket count.

    The window is rounded up to whole buckets, so every bucket is as long as
    every other and the last one ends at the clock.
    """
    minutes = int(history["spendBucketMinutes"])
    count = -(-int(history["spendWindowHours"]) * 60 // minutes)
    return minutes * 60, count


def spend_series(folded: Folded, history: Mapping[str, Any], now: float, truncated: bool,
                 unread: bool = False) -> dict[str, Any]:
    """What one transcript spent per bucket of the window, oldest first.

    Each response is priced once, by `estimate`, the function and the rates the
    card's own cost uses. A host-recorded session cost states no times, so it
    cannot be placed in a bucket and the series never draws it.

    A bucket holding nothing is a measured zero only because this transcript
    was read. The series is not complete when a figure it should hold could be
    missing: a response with no readable time, a response in the window that no
    configured rate prices or that could not be measured, a damaged record that
    may have been a response, a tail whose first record is not older than the
    window, so the cut-off start may hold spend inside it, or a transcript the
    session's spend is in that `unread` says nobody read whole, whose spend has
    no bucket anybody could place it in.

    Dollars are not rounded here. A bucket rounded on its own drops spend that
    the sum of the buckets keeps, so the buckets would disagree with the total
    and the roster's sum with the cards'. The total is the exact sum of the
    buckets, and the drawing rounds what it shows.
    """
    length, count = bucket_layout(history)
    span = length * count
    buckets = [0.0] * count
    complete = folded.figures["damagedRecords"] == 0 and not unread
    for stamp, spent in folded.spend:
        if stamp is None:
            complete = False
            continue
        age = now - stamp
        if not math.isfinite(age) or age < 0 or age >= span:
            continue
        if spent is None:
            complete = False
            continue
        buckets[count - 1 - int(age // length)] += spent
    if truncated:
        earliest = min(folded.stamps) if folded.stamps else None
        if earliest is None or earliest > now - span:
            complete = False
    return {"bucket_minutes": length // 60,
            "buckets": buckets,
            "total": math.fsum(buckets),
            "complete": complete}


def timeline(stamps: list[float], history: Mapping[str, Any], now: float) -> list[dict[str, str]]:
    """Working and idle stretches over the window, oldest first.

    A session is working from one record to the next while they come no
    further apart than the idle threshold; a longer gap is an idle stretch
    between two working ones. The transcript writes nothing while a tool runs,
    so a tool call longer than the threshold reads as idle. The timeline ends
    at the last record: whether the session is still at work after it is the
    row's own state.

    Past the configured limit the oldest idle gaps fold into the work around
    them, so the newest stretches keep their detail and the oldest read as one
    longer working stretch rather than being dropped.
    """
    window = int(history["spendWindowHours"]) * 3600
    idle = int(history["timelineIdleMinutes"]) * 60
    cap = int(history["timelineSegmentLimit"])
    placed = sorted(stamp for stamp in stamps
                    if math.isfinite(stamp) and 0 <= now - stamp <= window)
    runs: list[list[float]] = []
    for stamp in placed:
        if runs and stamp - runs[-1][1] <= idle:
            runs[-1][1] = stamp
        else:
            runs.append([stamp, stamp])
    segments: list[list[Any]] = []
    for start, end in runs:
        if segments:
            segments.append([segments[-1][1], start, "idle"])
        segments.append([start, end, "working"])
    while len(segments) > cap:
        # The oldest two become one working stretch, and a working stretch it
        # now touches joins it, so working and idle still take turns.
        first, second = segments[0], segments[1]
        merged = [first[0], second[1], "working"]
        segments[:2] = [merged]
        if len(segments) > 1 and segments[1][2] == "working":
            segments[:2] = [[merged[0], segments[1][1], "working"]]
    return [{"start": iso_time(start), "end": iso_time(end), "state": state}
            for start, end, state in segments]


def read_agent(home: Path, session_id: Any, job_id: Any,
               config: Mapping[str, Any], *, now: float | None = None) -> dict[str, Any]:
    """One roster session's figures, or the state that says why there are none.

    A session's own transcript and every subagent transcript beside it are
    summed into one reading, since the host counts them all in the cost it
    records. A subagent transcript the bound cut, one that could not be read,
    and a folder holding more of them than one read opens are each named in
    `reason` and leave the totals a floor: the figure drawn is what was read,
    said to be at least, never a smaller number drawn as the session's spend.

    A session whose transcript was not read has no spend series and no
    timeline, both None: an empty list or a zero would say it was idle and
    spent nothing, which nobody measured.
    """
    clock = float(now) if now is not None else time.time()
    limits = config["limits"]
    limit = int(limits["questionCharacters"])
    steps = read_steps(home, job_id, int(limits["jobStateBytes"]), limit)
    document: dict[str, Any] = {"steps": steps, "spend_series": None, "timeline": None}
    path = transcript_of(home, session_id)
    if path is None:
        document.update({"state": STATE_UNAVAILABLE, "reason": "no transcript for the session"})
        return document
    bound = int(limits["agentTranscriptBytes"])
    try:
        data, truncated = read_tail(path, bound)
    except OSError as error:
        document.update({"state": STATE_FAILED, "reason": type(error).__name__})
        return document
    prices = config["sources"]["agents"]
    # One set of identifiers for every transcript this session wrote, so a
    # response the host wrote into two of them is priced once.
    seen: set[str] = set()
    # Every transcript this session wrote is read before any of them is settled,
    # so a response one of them measures is priced rather than left unknown.
    unresolved: dict[str, list[float | None]] = {}
    folded = fold(data, prices, limit, whole=not truncated, seen=seen,
                  unmeasured=unresolved)
    figures = folded.figures
    # The host writes each subagent's turns beside the session's transcript and
    # counts them in the cost it records, so a figure that sums the session's
    # own transcript alone is low for exactly the sessions that ran one.
    extra = read_subagents(path, bound, prices, limit, seen, unresolved)
    # A subagent transcript nobody could read a record of is a gap whatever else
    # was read: merged only where some turn was readable it would disappear, and
    # a session whose subagent files are all damaged would draw an exact figure
    # that is short by everything they held.
    gaps = extra["cut"] + extra["unreadable"] + extra["over"] + extra["damaged"]
    figures["damagedRecords"] += extra["damaged"]
    # A response no transcript of this session states the usage of: unknown
    # spend, at each of the times its records carry.
    settled = settle_unmeasured(folded.spend, unresolved)
    priced = folded.priced and extra["priced"] and not settled
    if extra["turns"] or extra["spend"]:
        figures["turns"] += extra["turns"]
        for name, count in extra["tokens"].items():
            figures["tokens"][name] += count
        # The series is drawn from the same responses the cost is, so the
        # subagent turns are placed in the buckets they were spent in. The times
        # the series is checked against stay the session's own records: whether
        # a tail reaches back past the window is a fact about its transcript.
        folded.spend.extend(extra["spend"])
    # Every transcript the session wrote is priced as one, and only once all of
    # them are read: a subagent turn no configured rate prices leaves the
    # session unpriced rather than drawn without it, a response no transcript
    # states the usage of leaves it unpriced too, and the host's record stands
    # where it covers the session, subagents included, rather than being added
    # to.
    figures.pop("costUsd", None)
    figures.pop("costSource", None)
    models = dict(folded.models)
    merge_models(models, extra["models"])
    figures.update(cost_figures(figures["turns"], priced,
                                folded.estimate + extra["cost"], folded.hostCost,
                                folded.covers, host_guessed(folded.hostUnknown, models)))
    # Where each model's rates came from, when live rates were laid over the
    # table for this read: its card read now, a card kept from before, or the
    # shipped table, with the reason a card was not used.
    accounts = prices.get("rateCards")
    families = list(prices["inputPricePerMTok"].keys())
    figures["models"] = model_split(models, accounts, families)
    if isinstance(accounts, Mapping) and figures.get("model"):
        family = family_of(figures["model"], families)
        if family in accounts:
            figures["rates"] = dict(accounts[family])
    document.update(figures)
    history = config["history"]
    document["spend_series"] = spend_series(folded, history, clock, truncated, gaps > 0)
    document["timeline"] = timeline(folded.stamps, history, clock)
    document["lowerBound"] = truncated or gaps > 0
    reasons: list[str] = []
    if truncated:
        # The first turn of a tail is not the session's first turn.
        document["firstActivity"] = None
        reasons.append("the transcript is longer than {0} bytes".format(bound))
    if extra["cut"]:
        reasons.append("{0} {1} longer than {2} bytes".format(
            subagent_count(extra["cut"]), "is" if extra["cut"] == 1 else "are", bound))
    if extra["unreadable"]:
        reasons.append("{0} could not be read".format(subagent_count(extra["unreadable"])))
    if extra["damaged"]:
        reasons.append("{0} holding a record nobody could read".format(
            subagent_count(extra["damaged"])))
    if extra["over"]:
        reasons.append("more than {0} subagent transcripts are in the folder".format(
            MAX_SUBAGENT_FILES))
    if reasons:
        document["reason"] = "; ".join(reasons)
    if figures["turns"] or folded.spend:
        # A response nobody could measure is still a response: the session
        # spent something, so it is not drawn as empty.
        document["state"] = STATE_READY
    elif figures["damagedRecords"]:
        document.update({"state": STATE_FAILED,
                         "reason": "no record in the transcript could be read"})
    else:
        document["state"] = STATE_EMPTY
    return document
