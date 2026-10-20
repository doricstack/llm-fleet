#!/usr/bin/env python3
"""Live rates: rate cards fetched, kept on disk, and laid over the starter table.

The network is the one boundary these tests stand in for, with a fetcher that
answers from the captured pages and counts its calls; everything else is real:
the state folder, the cache file, the lock, the clock the caller passes in. The
cases that matter are the ones where the network does not cooperate: a page that
fails, a page that changed shape, a card set wrong, another process refreshing at
the same moment, and a host that answers over plain HTTP or past the size bound.
Each must leave the pane on a rate it can name the age and origin of.

Set FLEET_LIVE_RATE_CARDS=1 to fetch every shipped card for real as well.

Run with: python3 tests/test_reader_rates.py -v
"""

import copy
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
import urllib.request

import paths  # noqa: F401  (puts the plugin root on the path)

from config.loader import load_config
from readers import rates
from readers.rate_cards import RateError


CARDS = Path(__file__).resolve().parent / "fixtures" / "rate-cards"
ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing.md"
DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing/"
PAGES = {ANTHROPIC: "anthropic.md", DEEPSEEK: "deepseek.html"}
NOW = 1_800_000_000.0
DAY = 86400


class Fetcher:
    """Answers a URL with its captured page, or raises what it is told to."""

    def __init__(self, fail: set[str] | None = None, pages: dict[str, str] | None = None):
        self.calls: list[str] = []
        self.fail = fail or set()
        self.pages = pages if pages is not None else {
            url: (CARDS / name).read_text(encoding="utf-8") for url, name in PAGES.items()}

    def __call__(self, url: str, timeout: float, limit: int) -> str:
        self.calls.append(url)
        if url in self.fail:
            raise RateError("source request failed")
        return self.pages[url]


class RatesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = Path(tempfile.mkdtemp(prefix="fleet-rates-"))
        self.addCleanup(shutil.rmtree, self.state, True)
        self.config = load_config(None, environ={"HOME": str(self.state / "user")})
        self.config["stateDir"] = str(self.state)
        self.config["sources"]["rates"]["cards"] = {
            "opus-5-5": "anthropic " + ANTHROPIC,
            "sonnet-5-5": "anthropic " + ANTHROPIC,
            "deepseek-flash": "deepseek " + DEEPSEEK,
        }

    def priced(self, fetcher: Fetcher, now: float = NOW):
        """A refresh, as the background process runs one, then a read, as the pane does."""
        rates.refresh(self.config, now, fetcher=fetcher)
        return rates.priced(self.config, now)

    def test_a_read_alone_prices_from_the_table_until_a_refresh_has_run(self) -> None:
        prices, info = rates.priced(self.config, NOW)
        self.assertEqual(info["opus-5-5"], {"state": "table", "checkedAt": None,
                                            "reason": "the card has not been read yet"})
        self.assertEqual(prices["cacheReadPricePerMTok"]["sonnet-5-5"],
                         self.config["sources"]["agents"]["cacheReadPricePerMTok"]["sonnet-5-5"])
        self.assertFalse((self.state / "records").exists())

    def test_due_says_when_a_refresh_is_wanted(self) -> None:
        self.assertTrue(rates.due(self.config, NOW))
        self.priced(Fetcher())
        self.assertFalse(rates.due(self.config, NOW + 60))
        self.assertTrue(rates.due(self.config, NOW + DAY))
        # A refresh another process is running is not asked for twice.
        (self.state / "records" / "rate-cards.lock").write_text("")
        self.assertFalse(rates.due(self.config, NOW + DAY))
        self.config["sources"]["rates"]["enabled"] = False
        (self.state / "records" / "rate-cards.lock").unlink()
        self.assertFalse(rates.due(self.config, NOW + DAY))

    def test_the_refresh_reports_what_it_did(self) -> None:
        self.assertEqual(rates.refresh(self.config, NOW, fetcher=Fetcher(fail={DEEPSEEK})),
                         {"state": "ready", "fetched": sorted([ANTHROPIC, DEEPSEEK]),
                          "failed": ["deepseek-flash"]})
        self.assertEqual(rates.refresh(self.config, NOW + 1, fetcher=Fetcher()),
                         {"state": "fresh", "fetched": []})

    def cache(self) -> dict:
        return json.loads((self.state / "records" / "rate-cards.json").read_text())

    def test_a_cold_read_fetches_each_page_once_and_lays_its_rates_over_the_table(self) -> None:
        fetcher = Fetcher()
        prices, info = self.priced(fetcher)
        # Two generations share one page, and the page is fetched once.
        self.assertEqual(sorted(fetcher.calls), sorted([ANTHROPIC, DEEPSEEK]))
        self.assertEqual(prices["cacheReadPricePerMTok"]["sonnet-5-5"], 0.1)
        self.assertEqual(info["sonnet-5-5"], {"state": "live", "checkedAt": NOW})
        # A page listing peak and off-peak rates is drawn at the higher of each.
        self.assertEqual(prices["inputPricePerMTok"]["deepseek-flash"], 0.3)
        self.assertEqual(prices["outputPricePerMTok"]["deepseek-flash"], 1.2)
        self.assertEqual(prices["cacheReadPricePerMTok"]["deepseek-flash"], 0.006)
        self.assertEqual(self.cache()["cards"]["opus-5-5"]["rates"],
                         {"input": 4.0, "cacheRead": 0.2, "output": 20.0})

    def test_the_resolved_configuration_is_not_changed(self) -> None:
        before = copy.deepcopy(self.config)
        self.priced(Fetcher())
        self.assertEqual(self.config, before)

    def test_a_fresh_cache_is_read_without_the_network(self) -> None:
        self.priced(Fetcher())
        fetcher = Fetcher()
        prices, info = self.priced(fetcher, NOW + DAY - 1)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(info["opus-5-5"], {"state": "live", "checkedAt": NOW})
        self.assertEqual(prices["inputPricePerMTok"]["opus-5-5"], 4.0)

    def test_a_stale_cache_is_fetched_again(self) -> None:
        self.priced(Fetcher())
        fetcher = Fetcher()
        _, info = self.priced(fetcher, NOW + DAY)
        self.assertEqual(sorted(fetcher.calls), sorted([ANTHROPIC, DEEPSEEK]))
        self.assertEqual(info["opus-5-5"]["checkedAt"], NOW + DAY)

    def test_a_failed_fetch_keeps_the_last_good_rate_and_says_how_old_it_is(self) -> None:
        self.priced(Fetcher())
        _, info = self.priced(Fetcher(fail={ANTHROPIC}), NOW + DAY)
        self.assertEqual(info["opus-5-5"]["state"], "cached")
        self.assertEqual(info["opus-5-5"]["checkedAt"], NOW)
        self.assertEqual(info["opus-5-5"]["reason"], "source request failed")
        # The page that answered is live; one failure does not drop the other.
        self.assertEqual(info["deepseek-flash"]["state"], "live")

    def test_a_failed_page_is_not_asked_again_inside_the_retry_window(self) -> None:
        self.priced(Fetcher(fail={ANTHROPIC, DEEPSEEK}))
        fetcher = Fetcher()
        _, info = self.priced(fetcher, NOW + 60)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(info["opus-5-5"], {"state": "table", "checkedAt": None,
                                            "reason": "source request failed"})
        retry = self.config["sources"]["rates"]["retrySeconds"]
        fetcher = Fetcher()
        self.priced(fetcher, NOW + retry)
        self.assertEqual(sorted(fetcher.calls), sorted([ANTHROPIC, DEEPSEEK]))

    def test_a_page_that_changed_shape_leaves_the_table_rate_and_names_why(self) -> None:
        broken = Fetcher()
        broken.pages[ANTHROPIC] = broken.pages[ANTHROPIC].replace("| Output tokens ", "| Out ")
        prices, info = self.priced(broken)
        self.assertEqual(info["opus-5-5"]["state"], "table")
        self.assertIn("column moved", info["opus-5-5"]["reason"])
        self.assertEqual(prices["inputPricePerMTok"]["opus-5-5"],
                         self.config["sources"]["agents"]["inputPricePerMTok"]["opus-5-5"])

    def test_switched_off_reads_the_table_and_touches_nothing(self) -> None:
        self.config["sources"]["rates"]["enabled"] = False
        fetcher = Fetcher()
        prices, info = self.priced(fetcher)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(info["opus-5-5"], {"state": "table", "checkedAt": None,
                                            "reason": "live rates are switched off"})
        self.assertFalse((self.state / "records").exists())
        self.assertEqual(prices, self.config["sources"]["agents"] | {"rateCards": info})

    def test_no_state_folder_fetches_nothing(self) -> None:
        self.config["stateDir"] = None
        fetcher = Fetcher()
        _, info = self.priced(fetcher)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(info["opus-5-5"]["state"], "table")
        self.assertIn("state folder", info["opus-5-5"]["reason"])

    def test_another_refresh_in_flight_is_not_doubled(self) -> None:
        records = self.state / "records"
        records.mkdir()
        (records / "rate-cards.lock").write_text("")
        fetcher = Fetcher()
        _, info = self.priced(fetcher, time.time())
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(info["opus-5-5"]["state"], "table")

    def test_a_lock_left_by_a_run_that_died_is_taken_over(self) -> None:
        records = self.state / "records"
        records.mkdir()
        lock = records / "rate-cards.lock"
        lock.write_text("")
        old = time.time() - 600
        os.utime(lock, (old, old))
        fetcher = Fetcher()
        self.priced(fetcher, time.time())
        self.assertEqual(sorted(fetcher.calls), sorted([ANTHROPIC, DEEPSEEK]))
        self.assertFalse(lock.exists())

    def test_a_page_that_breaks_its_parser_is_a_failed_try_that_waits(self) -> None:
        # A table row shorter than its header makes the parser raise something
        # other than a refusal. The run still keeps every other card and records
        # this one as tried, so the next read does not fetch every page again.
        lines = (CARDS / "anthropic.md").read_text(encoding="utf-8").split("\n")
        row = next(index for index, line in enumerate(lines)
                   if line.startswith("| Claude Opus 5.5 "))
        lines[row] = "| Claude Opus 5.5 | $4 / MTok |"
        pages = dict(Fetcher().pages, **{ANTHROPIC: "\n".join(lines)})
        result = rates.refresh(self.config, NOW, fetcher=Fetcher(pages=pages))
        self.assertEqual(result["state"], "ready")
        _, info = rates.priced(self.config, NOW)
        self.assertEqual(info["deepseek-flash"]["state"], "live")
        self.assertEqual(info["opus-5-5"]["state"], "table")
        self.assertIn("IndexError", info["opus-5-5"]["reason"])
        self.assertFalse(rates.due(self.config, NOW + 60))

    def test_a_cache_that_cannot_be_written_holds_off_the_next_refresh(self) -> None:
        records = self.state / "records"
        records.mkdir()
        (records / "rate-cards.json").mkdir()  # a folder where the file goes: no write lands
        result = rates.refresh(self.config, time.time(), fetcher=Fetcher())
        self.assertEqual(result["state"], "failed")
        self.assertTrue((records / "rate-cards.lock").exists())
        self.assertFalse(rates.due(self.config, time.time()))
        fetcher = Fetcher()
        self.assertEqual(rates.refresh(self.config, time.time(), fetcher=fetcher)["state"], "busy")
        self.assertEqual(fetcher.calls, [])

    def test_a_run_never_removes_a_lock_another_run_holds(self) -> None:
        records = self.state / "records"
        records.mkdir()
        lock = records / "rate-cards.lock"
        self.assertTrue(rates.take_lock(lock, "first"))
        self.assertFalse(rates.take_lock(lock, "second"))
        rates.release_lock(lock, "second")
        self.assertTrue(lock.exists())
        rates.release_lock(lock, "first")
        self.assertFalse(lock.exists())

    def test_a_stale_lock_is_taken_over_by_one_run_alone(self) -> None:
        records = self.state / "records"
        records.mkdir()
        lock = records / "rate-cards.lock"
        lock.write_text("dead")
        old = time.time() - 600
        os.utime(lock, (old, old))
        self.assertTrue(rates.take_lock(lock, "first"))
        # A second run that also judged the lock stale finds the new one fresh.
        self.assertFalse(rates.take_lock(lock, "second"))
        self.assertEqual(lock.read_text(), "first")
        self.assertEqual(sorted(path.name for path in records.iterdir()), ["rate-cards.lock"])

    def test_a_refresh_that_waited_behind_another_fetches_nothing_already_read(self) -> None:
        # The first run reads every card; a second that decided before the first
        # finished reads the cache again under the lock and fetches nothing.
        rates.refresh(self.config, NOW, fetcher=Fetcher())
        fetcher = Fetcher()
        self.assertEqual(rates.refresh(self.config, NOW + 1, fetcher=fetcher)["state"], "fresh")
        self.assertEqual(fetcher.calls, [])

    def test_a_card_set_wrong_is_named_and_never_fetched(self) -> None:
        self.config["sources"]["rates"]["cards"] = {
            "opus-5-5": "anthropic http://example.com/pricing",
            "sonnet-5-5": "guesswork " + ANTHROPIC,
            "deepseek-flash": "openrouter https://openrouter.ai/api/v1/models/x/endpoints",
            "haiku-5-5": "anthropic",
        }
        fetcher = Fetcher()
        _, info = self.priced(fetcher)
        self.assertEqual(fetcher.calls, [])
        self.assertIn("https", info["opus-5-5"]["reason"])
        self.assertIn("no parser", info["sonnet-5-5"]["reason"])
        self.assertIn("host", info["deepseek-flash"]["reason"])
        self.assertIn("names no page", info["haiku-5-5"]["reason"])

    def test_a_card_can_name_the_model_and_host_on_the_page(self) -> None:
        url = "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints"
        self.config["sources"]["rates"]["cards"] = {
            "deepseek-flash": "openrouter " + url + " model=deepseek/deepseek-v4.1-flash host=Together"}
        fetcher = Fetcher(pages={url: (CARDS / "openrouter.json").read_text(encoding="utf-8")})
        prices, info = self.priced(fetcher)
        self.assertEqual(info["deepseek-flash"]["state"], "live")
        self.assertEqual(prices["inputPricePerMTok"]["deepseek-flash"], 0.3)

    def test_a_damaged_cache_is_read_as_none(self) -> None:
        records = self.state / "records"
        records.mkdir()
        (records / "rate-cards.json").write_text('{"cards": {"opus-5-5": {"rates": "x"}}}')
        fetcher = Fetcher()
        _, info = self.priced(fetcher)
        self.assertEqual(info["opus-5-5"]["state"], "live")
        self.assertIn(ANTHROPIC, fetcher.calls)


SCRIPT = Path(__file__).resolve().parent.parent / "plugins" / "llm-fleet" / "readers" / "rates.py"


class ProcessTests(unittest.TestCase):
    """The refresh as the read starts it: a real process, against a page that refuses at once."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fleet-rates-run-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        defaults = load_config(None, environ={"HOME": str(self.root / "user")})
        # Every shipped card is pointed at a local port nothing listens on, so
        # the run reaches no one and fails at once.
        cards = {generation: "anthropic https://127.0.0.1:9/pricing.md"
                 for generation in defaults["sources"]["rates"]["cards"]}
        self.path = self.root / "config.json"
        self.path.write_text(json.dumps({"stateDir": str(self.root / "state"),
                                         "sources": {"rates": {"cards": cards}}}),
                             encoding="utf-8")
        self.config = load_config(str(self.path), environ={"HOME": str(self.root / "user")})

    def test_the_command_is_this_file_under_the_running_interpreter(self) -> None:
        import sys
        self.assertEqual(rates.refresh_command(str(self.path)),
                         [sys.executable, str(SCRIPT), "--refresh", "--config", str(self.path)])
        self.assertEqual(rates.refresh_command(None)[-1], "--refresh")

    def test_a_started_refresh_runs_beside_the_read_and_records_the_failure(self) -> None:
        self.assertTrue(rates.start_refresh(self.config, str(self.path), time.time()))
        cache = self.root / "state" / "records" / "rate-cards.json"
        deadline = time.monotonic() + 20
        while not cache.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        tries = json.loads(cache.read_text())["tries"]
        self.assertEqual(set(tries), set(self.config["sources"]["rates"]["cards"]))
        self.assertIn("could not be fetched", tries["opus-5-5"]["reason"])
        # The failure is waited out rather than asked again on the next read.
        self.assertFalse(rates.due(self.config, time.time()))
        self.assertFalse(rates.start_refresh(self.config, str(self.path), time.time()))

    def read(self, *flags: str):
        import subprocess
        import sys
        snapshot = SCRIPT.with_name("snapshot.py")
        return subprocess.run([sys.executable, str(snapshot), "--config", str(self.path),
                               "--only", "load", *flags],
                              capture_output=True, text=True, timeout=60,
                              env={**os.environ, "HOME": str(self.root / "user")})

    def test_a_read_asked_to_refresh_rates_starts_one_and_does_not_wait(self) -> None:
        started = time.monotonic()
        run = self.read("--refresh-rates")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("load", json.loads(run.stdout))
        cache = self.root / "state" / "records" / "rate-cards.json"
        deadline = time.monotonic() + 20
        while not cache.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertIn("opus-5-5", json.loads(cache.read_text())["tries"])
        self.assertLess(time.monotonic() - started, 20)

    def test_a_read_not_asked_starts_no_refresh(self) -> None:
        run = self.read()
        self.assertEqual(run.returncode, 0, run.stderr)
        time.sleep(1.5)
        self.assertFalse((self.root / "state" / "records" / "rate-cards.json").exists())
        self.assertFalse((self.root / "state" / "records" / "rate-cards.lock").exists())

    def test_status_prints_what_each_model_is_priced_from(self) -> None:
        import subprocess
        import sys
        run = subprocess.run([sys.executable, str(SCRIPT), "--config", str(self.path), "--status"],
                             capture_output=True, text=True, timeout=30,
                             env={**os.environ, "HOME": str(self.root / "user")})
        self.assertEqual(run.returncode, 0, run.stderr)
        cards = json.loads(run.stdout)["cards"]
        self.assertEqual(cards["opus-5-5"]["state"], "table")
        self.assertFalse((self.root / "state" / "records").exists())


class FetchTests(unittest.TestCase):
    def test_plain_http_is_refused_before_any_connection(self) -> None:
        with self.assertRaisesRegex(RateError, "https"):
            rates.fetch("http://example.com/", 1, 1000)

    def test_a_redirect_off_https_is_refused(self) -> None:
        handler = rates.HttpsOnlyRedirect()
        request = urllib.request.Request("https://example.com/")
        with self.assertRaisesRegex(RateError, "https"):
            handler.redirect_request(request, io.BytesIO(), 302, "Found", {},
                                     "http://example.com/next")
        moved = handler.redirect_request(request, io.BytesIO(), 302, "Found", {},
                                         "https://example.com/next")
        self.assertEqual(moved.full_url, "https://example.com/next")

    def test_a_body_past_the_bound_is_refused(self) -> None:
        self.assertEqual(rates.read_bounded(io.BytesIO(b"x" * 10), 10), b"x" * 10)
        with self.assertRaisesRegex(RateError, "larger"):
            rates.read_bounded(io.BytesIO(b"x" * 11), 10)


@unittest.skipUnless(os.environ.get("FLEET_LIVE_RATE_CARDS") == "1",
                     "set FLEET_LIVE_RATE_CARDS=1 to fetch the shipped cards")
class LiveCardTests(unittest.TestCase):
    def test_every_shipped_card_prices_its_model_today(self) -> None:
        config = load_config(None, environ={"HOME": tempfile.gettempdir()})
        cards = config["sources"]["rates"]["cards"]
        failures = {}
        for generation, spec in cards.items():
            card = rates.card(generation, spec)
            try:
                page = rates.fetch(card["url"], 10, config["limits"]["rateCardBytes"])
                found = rates.rate_cards.parse(card["parser"], page, card["model"], card["host"])
                self.assertTrue(found)
            except RateError as exc:
                failures[generation] = str(exc)
        self.assertEqual(failures, {})
        self.assertGreaterEqual(len(cards), 10)


if __name__ == "__main__":
    unittest.main()
