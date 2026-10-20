"""Live rates: each model's rate card fetched from its provider and laid over the table.

`sources.rates.cards` names, per model generation, the page that prices it and
the parser that reads that page (`readers/rate_cards.py`). A page is fetched
over https only, within `timeouts.rateCardSeconds` and `limits.rateCardBytes`,
and what it says is kept under the state folder with the time it was read:

- a rate younger than `sources.rates.maxAgeSeconds` is used as it stands and
  its page is not asked again,
- an older one is still used when its page fails, drawn as cached with its age,
- a page that failed is not asked again for `sources.rates.retrySeconds`,
- a model no card has priced yet keeps the shipped table's rate.

Nothing about the person is sent: the request is a plain GET of a public page,
carrying no key, no cookie, and nothing read from a session.

A page that lists more than one rate for a model (peak and off-peak hours) is
drawn at the higher of each, so a cost is never stated below what it may be.
One process refreshes at a time; another that finds the lock reads what is kept.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, Callable, Mapping
import urllib.error
import urllib.request
import uuid

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers import rate_cards
from readers.rate_cards import RateError, number
from readers.runtime import CACHE_BYTES, child_environment, read_bounded_json, write_private_json


RECORDS = "records"
CACHE_NAME = "rate-cards.json"
LOCK_NAME = "rate-cards.lock"
# A lock older than this was left by a run that died, and is taken over.
LOCK_STALE_SECONDS = 120
FIELDS = ("input", "cacheRead", "output")
# The price maps each field lays over.
MAPS = {"input": "inputPricePerMTok", "cacheRead": "cacheReadPricePerMTok",
        "output": "outputPricePerMTok"}
AGENT = "llm-fleet rate-card reader"

Fetcher = Callable[[str, float, int], str]


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another https address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        if not str(newurl).startswith("https://"):
            raise RateError("a redirect left https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def read_bounded(stream: BinaryIO, limit: int) -> bytes:
    """A response body of at most `limit` bytes, or a refusal."""
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise RateError("the page is larger than {0} bytes".format(limit))
    return data


def fetch(url: str, timeout: float, limit: int) -> str:
    """A public page's text, fetched over https within the time and size bounds."""
    if not url.startswith("https://"):
        raise RateError("only https pages are fetched")
    request = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "*/*"})
    opener = urllib.request.build_opener(HttpsOnlyRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            data = read_bounded(response, limit)
    except RateError:
        raise
    except urllib.error.HTTPError as exc:
        raise RateError("the page answered {0}".format(exc.code)) from None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        # The reason is named by kind: a body or a network trace is not drawn.
        raise RateError("the page could not be fetched ({0})".format(type(exc).__name__)) from None
    return data.decode("utf-8-sig", errors="replace")


def card(generation: str, spec: Any) -> dict[str, str]:
    """A card's parts: `<parser> <https url> [model=<name on the page>] [host=<host>]`."""
    words = str(spec or "").split()
    if not words:
        raise RateError("no rate card is set")
    if words[0] not in rate_cards.PARSERS:
        raise RateError("no parser is named {0}".format(words[0]))
    if len(words) < 2:
        raise RateError("the card names no page")
    if not words[1].startswith("https://"):
        raise RateError("a card's page must be an https address")
    parts = {"parser": words[0], "url": words[1], "model": generation, "host": ""}
    for word in words[2:]:
        key, _, value = word.partition("=")
        if key not in ("model", "host") or not value:
            raise RateError("the card holds {0}, which is not model= or host=".format(word))
        parts[key] = value
    if parts["parser"] == "openrouter" and not parts["host"]:
        raise RateError("an OpenRouter card must name its host")
    return parts


def ceiling(found: list[dict[str, float]]) -> dict[str, float]:
    """The highest of each rate a page lists for one model."""
    return {field: max(number(rate[field]) for rate in found) for field in FIELDS}


def kept_rate(entry: Any) -> tuple[dict[str, float], float] | None:
    """A cached rate and the time it was read, or None for anything damaged."""
    if not isinstance(entry, Mapping) or not isinstance(entry.get("rates"), Mapping):
        return None
    try:
        rates = {field: number(entry["rates"][field]) for field in FIELDS}
        checked = number(entry.get("checkedAt"))
    except (RateError, KeyError):
        return None
    return rates, checked


def kept_try(entry: Any) -> tuple[float, str] | None:
    if not isinstance(entry, Mapping) or not isinstance(entry.get("reason"), str):
        return None
    try:
        return number(entry.get("at")), entry["reason"]
    except RateError:
        return None


def take_lock(path: Path, token: str) -> bool:
    """True when this process now holds the refresh lock, written with its own token.

    A stale lock is taken over by renaming it aside, which one process alone can
    do: two that both found it stale cannot each delete the other's new lock,
    and the one whose rename fails meets the winner's lock on its next try.
    """
    for _ in range(2):
        try:
            handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
            except OSError:
                continue
            if age < LOCK_STALE_SECONDS:
                return False
            aside = path.with_name(path.name + "." + token)
            try:
                os.replace(path, aside)
            except OSError:
                continue
            aside.unlink(missing_ok=True)
            continue
        except OSError:
            return False
        try:
            os.write(handle, token.encode("ascii"))
        finally:
            os.close(handle)
        return True
    return False


def release_lock(path: Path, token: str) -> None:
    """Remove the lock only while it is still this process's own."""
    try:
        if path.read_text(encoding="ascii", errors="replace") == token:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def hold_lock_until(path: Path, until: float) -> None:
    """Date the lock so it reads as held until `until`, which keeps every read from refreshing."""
    stamp = until - LOCK_STALE_SECONDS
    try:
        os.utime(path, (stamp, stamp))
    except OSError:
        pass


def fetch_all(urls: list[str], fetcher: Fetcher, timeout: float,
              limit: int) -> dict[str, str | RateError]:
    """Every page at once, each its text or the reason it failed, within one deadline."""
    results: dict[str, str | RateError] = {}

    def one(url: str) -> None:
        try:
            results[url] = fetcher(url, timeout, limit)
        except RateError as exc:
            results[url] = exc
        except Exception as exc:  # a fetcher that fails any other way is a failed page
            results[url] = RateError("the page could not be fetched ({0})".format(type(exc).__name__))

    # Daemon threads: a page that will not finish is abandoned at the deadline
    # rather than holding the read open.
    threads = [threading.Thread(target=one, args=(url,), daemon=True) for url in urls]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout + 1
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))
    return {url: results.get(url, RateError("the page did not answer in time")) for url in urls}


def _cards(source: Mapping[str, Any]) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    """Each set card's parts, and the reason for each one set wrong."""
    cards: dict[str, dict[str, str]] = {}
    wrong: dict[str, str] = {}
    for generation, spec in (source.get("cards") or {}).items():
        try:
            cards[generation] = card(generation, spec)
        except RateError as exc:
            wrong[generation] = str(exc)
    return cards, wrong


def _folder(config: Mapping[str, Any]) -> Path | None:
    state = config.get("stateDir")
    return Path(state) / RECORDS if state else None


def _kept(folder: Path) -> tuple[dict[str, tuple[dict[str, float], float]],
                                 dict[str, tuple[float, str]]]:
    """The rates kept and the failed tries kept, each entry checked; damage reads as absent."""
    document = read_bounded_json(folder / CACHE_NAME, CACHE_BYTES)
    document = document if isinstance(document, dict) else {}
    rates: dict[str, tuple[dict[str, float], float]] = {}
    tries: dict[str, tuple[float, str]] = {}
    if isinstance(document.get("cards"), dict):
        for generation, entry in document["cards"].items():
            found = kept_rate(entry)
            if found is not None:
                rates[generation] = found
    if isinstance(document.get("tries"), dict):
        for generation, entry in document["tries"].items():
            tried = kept_try(entry)
            if tried is not None:
                tries[generation] = tried
    return rates, tries


def _due(cards: Mapping[str, Any], rates: Mapping[str, Any], tries: Mapping[str, Any],
         source: Mapping[str, Any], now: float) -> list[str]:
    """The cards whose rate is older than allowed and whose page is not waiting out a failure."""
    max_age = float(source["maxAgeSeconds"])
    retry = float(source["retrySeconds"])
    due = []
    for generation in cards:
        if generation in rates and now - rates[generation][1] < max_age:
            continue
        if generation in tries and now - tries[generation][0] < retry:
            continue
        due.append(generation)
    return due


def _lock_held_elsewhere(folder: Path) -> bool:
    try:
        return time.time() - (folder / LOCK_NAME).stat().st_mtime < LOCK_STALE_SECONDS
    except OSError:
        return False


def due(config: Mapping[str, Any], now: float) -> bool:
    """True when some card wants its page read and no refresh is already reading."""
    source = config["sources"]["rates"]
    folder = _folder(config)
    if not source.get("enabled") or folder is None or _lock_held_elsewhere(folder):
        return False
    cards, _ = _cards(source)
    rates, tries = _kept(folder)
    return bool(_due(cards, rates, tries, source, now))


def refresh(config: Mapping[str, Any], now: float, fetcher: Fetcher = fetch) -> dict[str, Any]:
    """Read every card that is due, keep what each page said, and report what happened.

    The only part of the plugin that reaches the network. One process refreshes
    at a time: one that finds the lock held leaves the reading to it.
    """
    source = config["sources"]["rates"]
    folder = _folder(config)
    if not source.get("enabled"):
        return {"state": "disabled", "fetched": []}
    if folder is None:
        return {"state": "unavailable", "reason": "no state folder", "fetched": []}
    cards, _ = _cards(source)
    rates, tries = _kept(folder)
    if not _due(cards, rates, tries, source, now):
        return {"state": "fresh", "fetched": []}
    lock = folder / LOCK_NAME
    token = "{0}-{1}".format(os.getpid(), uuid.uuid4().hex)
    try:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        held = take_lock(lock, token)
    except OSError:
        held = False
    if not held:
        return {"state": "busy", "fetched": []}
    # Read again under the lock: a refresh that finished while this one waited
    # for it has already read the pages this one would fetch.
    keep_lock = False
    try:
        rates, tries = _kept(folder)
        wanted = _due(cards, rates, tries, source, now)
        if not wanted:
            return {"state": "fresh", "fetched": []}
        urls = sorted({cards[generation]["url"] for generation in wanted})
        pages = fetch_all(urls, fetcher, float(config["timeouts"]["rateCardSeconds"]),
                          int(config["limits"]["rateCardBytes"]))
        for generation, parts in cards.items():
            page = pages.get(parts["url"])
            if page is None:
                continue
            try:
                if isinstance(page, RateError):
                    raise page
                found = rate_cards.parse(parts["parser"], page, parts["model"], parts["host"])
                rates[generation] = (ceiling(found), now)
                tries.pop(generation, None)
            except RateError as exc:
                tries[generation] = (now, str(exc))
            except Exception as exc:  # a page whose shape broke the parser another way
                # Kept as a failed try like any other, so the page waits out its
                # retry rather than being fetched again by every read.
                tries[generation] = (now, "the page could not be read ({0})".format(
                    type(exc).__name__))
        document = {
            "cards": {generation: {"rates": rate, "checkedAt": checked}
                      for generation, (rate, checked) in rates.items()},
            "tries": {generation: {"at": at, "reason": reason}
                      for generation, (at, reason) in tries.items()},
        }
        try:
            write_private_json(folder / CACHE_NAME, document)
        except OSError as exc:
            # Nothing could be kept, so no try is on record to wait out. The
            # lock stays, dated to read as held for the retry interval, so the
            # reads that follow do not fetch every page again.
            keep_lock = True
            hold_lock_until(lock, time.time() + float(source["retrySeconds"]))
            return {"state": "failed", "reason": type(exc).__name__, "fetched": urls}
    finally:
        if not keep_lock:
            release_lock(lock, token)
    return {"state": "ready", "fetched": urls,
            "failed": sorted(generation for generation in cards if generation in tries)}


def priced(config: Mapping[str, Any], now: float) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """The agent price group with the kept rates laid over it, and what each model was priced from.

    Reads the state folder and nothing else: a read never waits on a page. The
    resolved configuration is left as it was; the returned group carries the
    per-model account under `rateCards` for the reader that draws it.
    """
    agents = config["sources"]["agents"]
    source = config["sources"]["rates"]
    prices: dict[str, Any] = dict(agents)
    for name in MAPS.values():
        prices[name] = dict(agents[name])
    cards, wrong = _cards(source)
    info: dict[str, dict[str, Any]] = {
        generation: {"state": "table", "checkedAt": None, "reason": reason}
        for generation, reason in wrong.items()}
    folder = _folder(config)
    if not source.get("enabled") or folder is None:
        reason = ("live rates are switched off" if not source.get("enabled")
                  else "no state folder to keep fetched rates in")
        for generation in list(cards) + list(wrong):
            info[generation] = {"state": "table", "checkedAt": None, "reason": reason}
        prices["rateCards"] = info
        return prices, info
    rates, tries = _kept(folder)
    max_age = float(source["maxAgeSeconds"])
    for generation in cards:
        reason = tries[generation][1] if generation in tries else None
        if generation in rates:
            rate, checked = rates[generation]
            for field, name in MAPS.items():
                prices[name][generation] = rate[field]
            entry: dict[str, Any] = {"state": "live" if now - checked < max_age else "cached",
                                     "checkedAt": checked}
            if reason:
                entry["reason"] = reason
        else:
            entry = {"state": "table", "checkedAt": None,
                     "reason": reason or "the card has not been read yet"}
        info[generation] = entry
    prices["rateCards"] = info
    return prices, info


def with_live_rates(config: Mapping[str, Any], now: float) -> dict[str, Any]:
    """The configuration with its agent prices replaced by the priced group, the original untouched."""
    prices, _ = priced(config, now)
    sources = dict(config["sources"])
    sources["agents"] = prices
    copy = dict(config)
    copy["sources"] = sources
    return copy


def refresh_command(config_path: str | None) -> list[str]:
    """How the refresh is started: this file, under the interpreter running now."""
    command = [sys.executable, str(Path(__file__).resolve()), "--refresh"]
    if config_path:
        command += ["--config", config_path]
    return command


def start_refresh(config: Mapping[str, Any], config_path: str | None, now: float) -> bool:
    """Start the refresh beside the read when a card is due, without waiting for it.

    The child holds none of the caller's streams, so the read that started it
    returns as soon as it has printed, and it carries no provider credential.
    True when a refresh was started.
    """
    if not due(config, now):
        return False
    environment = child_environment(config["runtime"]["childEnvironment"], os.environ)
    detached: dict[str, Any] = {"start_new_session": True}
    if os.name == "nt":
        detached = {"creationflags": getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    try:
        subprocess.Popen(refresh_command(config_path), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=environment, close_fds=True, **detached)
    except OSError:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read each model's rate card, or say what is kept")
    parser.add_argument("--config", default=None,
                        help="the configuration document; the declared default is used without it")
    parser.add_argument("--now", type=float, default=None, help="the clock to read against")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--refresh", action="store_true",
                        help="fetch every card that is due and keep what it says")
    action.add_argument("--status", action="store_true",
                        help="print what each model is priced from, reading nothing remote")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        json.dump({"configErrors": refusal.errors}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    now = args.now if args.now is not None else time.time()
    if args.refresh:
        result = refresh(config, now)
    else:
        _, info = priced(config, now)
        result = {"cards": info}
    json.dump(result, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
