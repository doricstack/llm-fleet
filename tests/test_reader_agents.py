#!/usr/bin/env python3
"""Agent figures, driven through real transcripts and task files on disk.

The cases that matter are the ones a card can get wrong: a response written as
several records, a transcript longer than the bound, a session resumed after the
host recorded its cost, a model nobody priced, a task folder holding something
that is not a task, and a session identifier that could climb out of its home.

Run with: python3 tests/test_reader_agents.py -v
"""

import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from config.loader import load_config
from readers import agents, roster


SESSION = "0123abcd-0000-4000-8000-00000000beef"
JOB = SESSION[:8]


def turn(message_id, model="claude-opus-5-5", input_tokens=10, write=0, write_1h=0,
         read=0, output=5, effort="high", stamp="2026-10-12T10:00:00Z", sidechain=False):
    usage = {"input_tokens": input_tokens, "cache_creation_input_tokens": write,
             "cache_read_input_tokens": read, "output_tokens": output,
             "cache_creation": {"ephemeral_1h_input_tokens": write_1h,
                                "ephemeral_5m_input_tokens": write - write_1h}}
    return {"type": "assistant", "effort": effort, "timestamp": stamp, "isSidechain": sidechain,
            "message": {"id": message_id, "model": model, "usage": usage}}


# The host's record of a session's cost, as it writes one that covers the whole
# session: started before the first turn, every model priced.
def cost_state(total, start="2026-10-12T09:00:00Z", unknown=False):
    from datetime import datetime
    started = datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp() * 1000
    return {"type": "cost-state", "totalCostUSD": total, "startTime": started,
            "hasUnknownModelCost": unknown}


class AgentCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-agents-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.home = self.root / "home"
        (self.home / "projects" / "-work-project").mkdir(parents=True)
        environment = {"HOME": str(self.root / "user")}
        self.config = load_config(None, environ=environment)

    def transcript(self, records, folder="-work-project", session=SESSION):
        path = self.home / "projects" / folder / (session + ".jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(
            record if isinstance(record, str) else json.dumps(record) for record in records)
            + "\n", encoding="utf-8")
        return path

    def task(self, number, status, subject="Do a thing", active=None):
        folder = self.home / "tasks" / ("session-" + JOB)
        folder.mkdir(parents=True, exist_ok=True)
        body = {"id": str(number), "subject": subject, "status": status}
        if active is not None:
            body["activeForm"] = active
        (folder / (str(number) + ".json")).write_text(json.dumps(body), encoding="utf-8")

    def read(self, config=None):
        return agents.read_agent(self.home, SESSION, JOB, config or self.config)

    def configured(self, document):
        """A resolved configuration from a document, for the cases about a person's own settings."""
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(str(path), environ={"HOME": str(self.root / "user")})


class FiguresTests(AgentCase):
    def test_a_response_written_as_several_records_counts_once(self):
        self.transcript([turn("m1", read=1000), turn("m1", read=1000), turn("m1", read=1000),
                         turn("m2", read=2000)])
        figures = self.read()
        self.assertEqual(figures["state"], "ready")
        self.assertEqual(figures["turns"], 2)
        self.assertEqual(figures["tokens"]["cacheRead"], 3000)

    def test_the_estimate_is_the_configured_rates_applied_to_each_kind(self):
        # Opus at 4 in, 20 out, 0.2 read; a five-minute write at 1.25 and an
        # hour write at 2 times the input rate.
        self.transcript([turn("m1", input_tokens=1_000_000, write=3_000_000, write_1h=1_000_000,
                              read=1_000_000, output=1_000_000)])
        figures = self.read()
        expected = 4 + 2_000_000 * 4 * 1.25 / 1e6 + 1_000_000 * 4 * 2 / 1e6 + 0.2 + 20
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], round(expected, 4))

    def test_the_host_cost_outranks_the_estimate_when_it_covers_the_session(self):
        self.transcript([turn("m1"), cost_state(1.5)])
        figures = self.read()
        self.assertEqual((figures["costUsd"], figures["costSource"]), (1.5, "host"))

    def test_a_session_resumed_after_its_cost_was_recorded_is_a_floor(self):
        # 20 dollars of output after a record of 1.5: the larger figure stands,
        # as the least the session spent.
        self.transcript([turn("m1", output=1_000_000), cost_state(1.5),
                         turn("m2", output=1_000_000)])
        figures = self.read()
        self.assertEqual(figures["costSource"], "floor")
        self.assertAlmostEqual(figures["costUsd"], 40.0, places=2)

    def test_a_host_record_started_after_the_first_turn_is_a_floor(self):
        self.transcript([turn("m1", output=1_000_000, stamp="2026-10-12T08:00:00Z"),
                         cost_state(1.5, start="2026-10-12T09:00:00Z")])
        figures = self.read()
        self.assertEqual(figures["costSource"], "floor")
        self.assertAlmostEqual(figures["costUsd"], 20.0, places=2)

    def test_a_host_record_with_an_unpriced_model_is_a_floor(self):
        self.transcript([turn("m1"), cost_state(1.5, unknown=True)])
        self.assertEqual(self.read()["costSource"], "floor")

    def test_a_non_claude_session_priced_from_its_card_does_not_take_the_hosts_figure(self):
        # The host prices a model it does not know at a table of its own and
        # says so; for a DeepSeek session that read about eighty-eight times the
        # bill. A rate for the model's own card is the better figure.
        self.transcript([turn("m1", model="deepseek-flash", input_tokens=1_000_000,
                              output=1_000_000), cost_state(6.47, unknown=True)])
        figures = self.read()
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 0.3 + 1.2)

    def test_a_claude_model_under_a_cloud_prefix_is_still_claude(self):
        # A gateway's identifier for a Claude model is Claude: the host's figure
        # for it is not a guess at another vendor's tokens, so it is not set aside.
        self.transcript([turn("m1", model="anthropic/claude-opus-5-5",
                              input_tokens=1_000_000, output=0),
                         cost_state(50.0, unknown=True)])
        figures = self.read()
        self.assertEqual((figures["costUsd"], figures["costSource"]), (50.0, "floor"))

    def test_a_non_claude_session_with_no_rate_keeps_the_hosts_floor(self):
        self.transcript([turn("m1", model="vendorx-large"), cost_state(2.0, unknown=True)])
        figures = self.read()
        self.assertEqual((figures["costUsd"], figures["costSource"]), (2.0, "floor"))

    def test_a_non_claude_session_the_host_priced_whole_keeps_the_hosts_figure(self):
        # Only a figure the host says it could not price is set aside.
        self.transcript([turn("m1", model="deepseek-flash"), cost_state(1.5)])
        figures = self.read()
        self.assertEqual((figures["costUsd"], figures["costSource"]), (1.5, "host"))

    def test_the_card_names_where_its_rates_came_from(self):
        self.transcript([turn("m1", model="deepseek-flash")])
        agents_group = dict(self.config["sources"]["agents"])
        agents_group["rateCards"] = {"deepseek-flash": {"state": "live", "checkedAt": 1.8e9},
                                     "opus-5-5": {"state": "table", "checkedAt": None,
                                                  "reason": "the card has not been read yet"}}
        config = dict(self.config)
        config["sources"] = dict(self.config["sources"], agents=agents_group)
        self.assertEqual(self.read(config)["rates"], {"state": "live", "checkedAt": 1.8e9})
        self.transcript([turn("m1")])
        self.assertEqual(self.read(config)["rates"]["state"], "table")

    def test_a_card_with_no_rate_account_says_nothing_about_its_rates(self):
        self.transcript([turn("m1", model="deepseek-flash")])
        self.assertNotIn("rates", self.read())

    def test_a_host_record_without_its_start_is_a_floor(self):
        self.transcript([turn("m1"), {"type": "cost-state", "totalCostUSD": 1.5,
                                      "hasUnknownModelCost": False}])
        self.assertEqual(self.read()["costSource"], "floor")

    def test_a_host_record_in_a_tail_is_a_floor(self):
        records = [turn("m{0}".format(index)) for index in range(200)] + [cost_state(99.0)]
        path = self.transcript(records)
        config = json.loads(json.dumps(self.config))
        config["limits"]["agentTranscriptBytes"] = path.stat().st_size // 2
        figures = self.read(config)
        self.assertEqual((figures["costUsd"], figures["costSource"]), (99.0, "floor"))

    def test_a_record_the_host_wrote_itself_is_not_a_turn(self):
        placeholder = turn("m2", model="<synthetic>", input_tokens=0, output=0)
        zeros = turn("m3", input_tokens=0, output=0)
        self.transcript([turn("m1", read=500_000), placeholder, zeros])
        figures = self.read()
        self.assertEqual(figures["model"], "claude-opus-5-5")
        self.assertEqual(figures["turns"], 1)
        self.assertEqual(figures["contextTokens"], 500_010)
        self.assertEqual(figures["costSource"], "estimate")

    def test_a_last_line_still_being_written_is_not_damage(self):
        path = self.transcript([turn("m1")])
        with path.open("a", encoding="utf-8") as handle:
            handle.write('{"type": "assistant", "message": {"id": "m2", "us')
        figures = self.read()
        self.assertEqual((figures["state"], figures["damagedRecords"]), ("ready", 0))

    def test_a_session_whose_only_line_is_half_written_is_empty_not_failed(self):
        path = self.transcript([])
        path.write_text('{"type": "assistant", "message": {"id": "m1"', encoding="utf-8")
        self.assertEqual(self.read()["state"], "empty")

    def test_a_model_outside_the_priced_families_has_no_cost(self):
        self.transcript([turn("m1", model="vendorx-large")])
        figures = self.read()
        self.assertEqual(figures["state"], "ready")
        self.assertNotIn("costUsd", figures)
        self.assertNotIn("contextWindow", figures)
        self.assertEqual(figures["contextTokens"], 10)

    def test_a_generation_the_configuration_adds_prices_its_model(self):
        # The generation is the person's own: the packaged list has none for it,
        # and the added rates reach the card's figures. The key names the
        # generation, which is what a key has to name to price anything.
        config = self.configured({"sources": {"agents": {
            "inputPricePerMTok": {"mythos-1": 2},
            "outputPricePerMTok": {"mythos-1": 8},
            "cacheReadPricePerMTok": {"mythos-1": 0.2}}}})
        self.transcript([turn("m1", model="mythos-1", input_tokens=1_000_000, output=0)])
        figures = self.read(config)
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 2.0)

    def test_a_key_naming_only_a_family_prices_nothing(self):
        # A vendor key without its generation is not a whole model: it prices no
        # model of that vendor rather than all of them at one rate. This is the
        # rule that keeps an unchecked generation from borrowing a checked one's
        # rates, and it is why a person adding a vendor names the generation.
        config = self.configured({"sources": {"agents": {
            "inputPricePerMTok": {"mythos": 2},
            "outputPricePerMTok": {"mythos": 8},
            "cacheReadPricePerMTok": {"mythos": 0.2}}}})
        self.transcript([turn("m1", model="mythos-1", input_tokens=1_000_000, output=0)])
        figures = self.read(config)
        self.assertEqual(figures["state"], "ready")
        self.assertNotIn("costUsd", figures)

    def test_a_model_matching_no_family_stays_unpriced(self):
        # Adding a family prices its own models and nothing else: a model no
        # family matches draws no cost, which is not a cost of zero.
        config = self.configured({"sources": {"agents": {"inputPricePerMTok": {"mythos": 2}}}})
        self.transcript([turn("m1", model="unknown-model-x")])
        figures = self.read(config)
        self.assertEqual(figures["state"], "ready")
        self.assertNotIn("costUsd", figures)

    def test_a_generation_key_prices_its_generation_over_the_family_key(self):
        # Two keys a model matches, one naming its family and one its
        # generation: the longer key prices it, whatever order the map holds.
        config = self.configured({"sources": {"agents": {
            "inputPricePerMTok": {"mythos": 1, "mythos-5": 3},
            "outputPricePerMTok": {"mythos": 1, "mythos-5": 3},
            "cacheReadPricePerMTok": {"mythos": 1, "mythos-5": 3}}}})
        self.transcript([turn("m1", model="mythos-5-20250101", input_tokens=1_000_000,
                              output=0)])
        figures = self.read(config)
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 3.0)

    def test_a_generation_sharing_a_shipped_prefix_stays_unpriced(self):
        # The trap a substring match falls into: `mythos-5-1` holds `mythos-5`,
        # so a key naming one generation would answer for the next one, which
        # nobody priced. What follows a key has to be the end of the identifier
        # or a date, and a generation number is neither.
        config = self.configured({"sources": {"agents": {
            "inputPricePerMTok": {"mythos": 1, "mythos-5": 3},
            "outputPricePerMTok": {"mythos": 1, "mythos-5": 3},
            "cacheReadPricePerMTok": {"mythos": 1, "mythos-5": 3}}}})
        self.transcript([turn("m1", model="mythos-5-1", input_tokens=1_000_000, output=0)])
        figures = self.read(config)
        self.assertEqual(figures["state"], "ready")
        self.assertNotIn("costUsd", figures)

    def test_a_suffix_past_the_release_date_is_another_model(self):
        # The date is the last thing the host stamps on. Anything after it is a
        # different model, so the key before the date does not price it.
        config = self.configured({"sources": {"agents": {
            "inputPricePerMTok": {"opus-5": 3},
            "outputPricePerMTok": {"opus-5": 3},
            "cacheReadPricePerMTok": {"opus-5": 3}}}})
        self.transcript([turn("m1", model="claude-opus-5-20260101-v2",
                              input_tokens=1_000_000, output=0)])
        figures = self.read(config)
        self.assertEqual(figures["state"], "ready")
        self.assertNotIn("costUsd", figures)

    def test_the_longest_key_naming_the_whole_model_prices_it(self):
        # Two keys can name one identifier whole, and which one wins is the
        # longer, whatever order the map holds them in: the more particular key
        # is the one somebody configured on purpose.
        for order in ({"mythos-5": 3, "claude-mythos-5": 9},
                      {"claude-mythos-5": 9, "mythos-5": 3}):
            with self.subTest(order=list(order)):
                config = self.configured({"sources": {"agents": {
                    "inputPricePerMTok": order,
                    "outputPricePerMTok": order,
                    "cacheReadPricePerMTok": order}}})
                self.transcript([turn("m1", model="claude-mythos-5",
                                      input_tokens=1_000_000, output=0)])
                figures = self.read(config)
                self.assertEqual(figures["costSource"], "estimate")
                self.assertAlmostEqual(figures["costUsd"], 9.0)

    def test_a_date_stamped_identifier_prices_its_generation(self):
        # The host stamps a release date onto some identifiers. The date is not
        # a generation, so it does not stop the key before it from matching.
        self.transcript([turn("m1", model="claude-haiku-4-5-20251001",
                              input_tokens=1_000_000, output=0)])
        figures = self.read()
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 1.0)

    def test_a_context_marker_is_not_part_of_the_generation(self):
        # The host marks a larger context window on the identifier itself. The
        # marker is not a generation either, so the model it marks still prices.
        self.transcript([turn("m1", model="claude-opus-5[1m]", input_tokens=1_000_000,
                              output=0)])
        figures = self.read()
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 5.0)

    def test_a_generation_the_rates_do_not_name_stays_unpriced(self):
        # A family key prices no generation of its family on its own: a model
        # whose generation no key names draws no cost, never its family's rate.
        config = self.configured({"sources": {"agents": {
            "inputPricePerMTok": {"mythos-5": 3},
            "outputPricePerMTok": {"mythos-5": 3},
            "cacheReadPricePerMTok": {"mythos-5": 3}}}})
        self.transcript([turn("m1", model="mythos-4", input_tokens=1_000_000, output=0)])
        figures = self.read(config)
        self.assertEqual(figures["state"], "ready")
        self.assertNotIn("costUsd", figures)

    def test_the_window_comes_from_the_window_maps_own_keys(self):
        # A model priced by a generation key draws the window that key names.
        self.transcript([turn("m1", model="claude-opus-4-7", input_tokens=5, read=400_000)])
        figures = self.read()
        self.assertEqual((figures["costSource"], figures["contextWindow"]),
                         ("estimate", 1_000_000))

    def test_a_window_key_without_a_rate_still_draws_the_window(self):
        # The window map's own keys answer for the window, not the ones the
        # rates are read by: a person who names a model's window and prices it
        # nowhere draws the context share and no cost.
        config = self.configured({"sources": {"agents": {
            "contextWindowTokens": {"mythos-1": 200000}}}})
        self.transcript([turn("m1", model="mythos-1", input_tokens=5, read=100_000)])
        figures = self.read(config)
        self.assertEqual(figures["contextWindow"], 200000)
        self.assertNotIn("costUsd", figures)

    def test_one_unpriced_turn_leaves_the_whole_session_unpriced(self):
        self.transcript([turn("m1"), turn("m2", model="vendorx-large")])
        self.assertNotIn("costUsd", self.read())

    def test_context_is_the_last_main_turn_against_the_family_window(self):
        self.transcript([turn("m1", input_tokens=5, write=100, read=400_000),
                         turn("m2", input_tokens=1, read=9, sidechain=True)])
        figures = self.read()
        self.assertEqual(figures["contextTokens"], 400_105)
        self.assertEqual(figures["contextWindow"], 1_000_000)

    def test_title_model_effort_and_times_come_from_the_records(self):
        self.transcript([{"type": "custom-title", "customTitle": "First"},
                         turn("m1", effort="low", stamp="2026-10-12T10:00:00Z"),
                         {"type": "custom-title", "customTitle": "Renamed\x07 later"},
                         turn("m2", model="claude-sonnet-5-5", effort="max",
                              stamp="2026-10-12T11:00:00Z")])
        figures = self.read()
        self.assertEqual(figures["title"], "Renamed later")
        self.assertEqual((figures["model"], figures["effort"]), ("claude-sonnet-5-5", "max"))
        self.assertEqual(figures["lastActivity"] - figures["firstActivity"], 3600)

    def test_damaged_records_are_counted_and_the_rest_still_read(self):
        self.transcript(['{"type": "assistant", "message": ', "[1, 2]", turn("m1")])
        figures = self.read()
        self.assertEqual(figures["state"], "ready")
        self.assertEqual(figures["damagedRecords"], 1)

    def test_a_transcript_of_only_damage_is_a_failed_read(self):
        self.transcript(['{"type": "assistant", "message": '])
        figures = self.read()
        self.assertEqual(figures["state"], "failed")
        self.assertIn("could be read", figures["reason"])

    def test_a_transcript_with_no_turns_is_empty(self):
        self.transcript([{"type": "user", "message": {"content": "hello"}}])
        self.assertEqual(self.read()["state"], "empty")

    def test_a_long_transcript_is_read_from_its_tail_as_a_lower_bound(self):
        records = [turn("m{0}".format(index), output=7, stamp="2026-10-12T10:00:00Z")
                   for index in range(400)]
        path = self.transcript(records)
        config = json.loads(json.dumps(self.config))
        # Cut five bytes into a record, so the fragment the tail starts with
        # still carries the marker that would make it read as a damaged turn.
        data = path.read_bytes()
        start = 0
        for _ in range(300):
            start = data.index(b"\n", start) + 1
        config["limits"]["agentTranscriptBytes"] = len(data) - (start + 5)
        figures = self.read(config)
        self.assertTrue(figures["lowerBound"])
        self.assertIsNone(figures["firstActivity"])
        self.assertIn("longer than", figures["reason"])
        # The tail starts mid-record, and that fragment is the cut, not damage.
        self.assertEqual(figures["damagedRecords"], 0)
        self.assertLess(figures["turns"], 400)
        self.assertGreater(figures["turns"], 0)
        self.assertEqual(figures["tokens"]["output"], figures["turns"] * 7)

    def test_a_transcript_that_grows_past_the_bound_mid_read_is_a_floor(self):
        from unittest import mock
        path = self.transcript([turn("m{0}".format(index)) for index in range(50)])
        bound = path.stat().st_size // 2
        real = os.fstat

        def stale(handle):
            # The size the check saw, from before the session wrote more.
            info = real(handle)
            values = list(info[:10])
            values[6] = bound
            return os.stat_result(values)

        with mock.patch.object(agents.os, "fstat", stale):
            data, cut = agents.read_tail(path, bound)
        self.assertTrue(cut)
        self.assertLessEqual(len(data), bound)

    def test_a_transcript_exactly_the_bound_long_is_whole(self):
        path = self.transcript([turn("m1")])
        data, cut = agents.read_tail(path, path.stat().st_size)
        self.assertFalse(cut)
        self.assertEqual(data, path.read_bytes())

    def test_a_transcript_within_the_bound_is_whole(self):
        self.transcript([turn("m1")])
        figures = self.read()
        self.assertFalse(figures["lowerBound"])
        self.assertNotIn("reason", figures)


class SubagentTests(AgentCase):
    """A session's subagent transcripts, which the host counts and this read did not.

    The host writes each subagent's turns to `<session id>/subagents/*.jsonl`
    beside the session's transcript and counts them in the cost it records, so a
    live card that sums the session's own transcript alone is low. What matters
    is that they are added, priced once each, and that anything the read cannot
    cover whole is named rather than passed over: a total quietly missing a file
    is a smaller number, and drawn as the spend it is a wrong one.
    """

    def subagent(self, name, records, session=SESSION, folder="-work-project"):
        path = self.home / "projects" / folder / session / "subagents" / (name + ".jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(
            record if isinstance(record, str) else json.dumps(record) for record in records)
            + "\n", encoding="utf-8")
        return path

    def test_each_model_a_session_ran_is_priced_and_shown_at_its_own_rate(self):
        # A session that moved from DeepSeek to Opus and ran a Haiku subagent:
        # every turn at the rate of the model that ran it, and the card says
        # how much each model spent, dearest first.
        self.transcript([turn("m1", model="deepseek-flash", input_tokens=1_000_000, output=0),
                         turn("m2", model="claude-opus-5-5", input_tokens=1_000_000,
                              output=0)])
        self.subagent("a1", [turn("s1", model="claude-haiku-5-5", input_tokens=1_000_000,
                                  output=0)])
        figures = self.read()
        self.assertEqual(figures["model"], "claude-opus-5-5")
        self.assertAlmostEqual(figures["costUsd"], 0.3 + 4 + 0.1)
        self.assertEqual(figures["models"], [
            {"model": "claude-opus-5-5", "turns": 1, "costUsd": 4.0},
            {"model": "deepseek-flash", "turns": 1, "costUsd": 0.3},
            {"model": "claude-haiku-5-5", "turns": 1, "costUsd": 0.1}])

    def test_a_model_no_rate_prices_is_unpriced_in_the_split_and_listed_last(self):
        self.transcript([turn("m1", model="vendorx-large"),
                         turn("m2", model="claude-opus-5-5", input_tokens=1_000_000,
                              output=0)])
        figures = self.read()
        self.assertNotIn("costUsd", figures)
        self.assertEqual(figures["models"], [
            {"model": "claude-opus-5-5", "turns": 1, "costUsd": 4.0},
            {"model": "vendorx-large", "turns": 1, "costUsd": None}])

    def test_the_host_guess_is_set_aside_when_any_model_was_not_claude(self):
        # The session ended on Opus, but a DeepSeek turn earlier is what the
        # host could not price: its figure is still a guess at that turn.
        self.transcript([turn("m1", model="deepseek-flash", input_tokens=1_000_000, output=0),
                         turn("m2", model="claude-opus-5-5", input_tokens=1_000_000,
                              output=0),
                         cost_state(80.0, unknown=True)])
        figures = self.read()
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 4.3)

    def test_a_subagent_on_another_vendor_makes_the_host_figure_a_guess(self):
        self.transcript([turn("m1", input_tokens=1_000_000, output=0),
                         cost_state(50.0, unknown=True)])
        self.subagent("a1", [turn("s1", model="deepseek-flash", input_tokens=1_000_000,
                                  output=0)])
        figures = self.read()
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 4.3)

    def test_each_model_in_the_split_names_where_its_rate_came_from(self):
        self.transcript([turn("m1", model="deepseek-flash"), turn("m2")])
        agents_group = dict(self.config["sources"]["agents"])
        agents_group["rateCards"] = {"deepseek-flash": {"state": "live", "checkedAt": 1.8e9}}
        config = dict(self.config)
        config["sources"] = dict(self.config["sources"], agents=agents_group)
        split = {row["model"]: row for row in self.read(config)["models"]}
        self.assertEqual(split["deepseek-flash"]["rates"], {"state": "live", "checkedAt": 1.8e9})
        self.assertNotIn("rates", split["claude-opus-5-5"])

    def test_a_subagent_s_turns_are_added_to_the_session_s_figures(self):
        self.transcript([turn("m1", input_tokens=1_000_000, output=0)])
        self.subagent("agent-a1", [turn("s1", input_tokens=1_000_000, output=0)])
        figures = self.read()
        self.assertEqual(figures["turns"], 2)
        self.assertEqual(figures["tokens"]["input"], 2_000_000)
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 8.0)
        self.assertFalse(figures["lowerBound"])
        self.assertNotIn("reason", figures)

    def test_a_response_written_into_two_of_a_session_s_transcripts_is_priced_once(self):
        self.transcript([turn("m1", input_tokens=1_000_000, output=0)])
        self.subagent("agent-a1", [turn("m1", input_tokens=1_000_000, output=0)])
        figures = self.read()
        self.assertEqual(figures["turns"], 1)
        self.assertEqual(figures["tokens"]["input"], 1_000_000)
        self.assertAlmostEqual(figures["costUsd"], 4.0)

    def test_a_session_whose_only_turns_are_a_subagent_s_is_ready(self):
        self.transcript([{"type": "user", "message": {"content": "hello"}}])
        self.subagent("agent-a1", [turn("s1")])
        figures = self.read()
        self.assertEqual(figures["state"], "ready")
        self.assertEqual(figures["turns"], 1)
        self.assertEqual(figures["costSource"], "estimate")

    def test_a_subagent_turn_no_rate_prices_leaves_the_session_unpriced(self):
        self.transcript([turn("m1")])
        self.subagent("agent-a1", [turn("s1", model="vendorx-large")])
        self.assertNotIn("costUsd", self.read())

    def test_the_subagent_turns_are_in_the_spend_series_the_cost_is_taken_from(self):
        self.transcript([turn("m1", input_tokens=1_000_000, output=0,
                              stamp="2026-10-12T11:00:00Z")])
        self.subagent("agent-a1", [turn("s1", input_tokens=0, output=1_000_000,
                                        stamp="2026-10-12T11:30:00Z")])
        document = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
        series = document["spend_series"]
        self.assertTrue(series["complete"])
        self.assertAlmostEqual(series["buckets"][22], 4.0)
        self.assertAlmostEqual(series["buckets"][23], 20.0)
        self.assertAlmostEqual(series["total"], document["costUsd"], places=4)

    def test_a_finished_session_with_subagents_still_draws_the_host_s_figure(self):
        # The host's record covers the whole session, subagents included, so it
        # stands as it is rather than having the subagent turns added to it.
        self.transcript([turn("m1", input_tokens=1_000_000, output=0), cost_state(278.4)])
        self.subagent("agent-a1", [turn("s1", input_tokens=1_000_000, output=0)])
        figures = self.read()
        self.assertEqual((figures["costUsd"], figures["costSource"]), (278.4, "host"))
        self.assertEqual(figures["turns"], 2)

    def test_a_subagent_transcript_longer_than_the_bound_leaves_a_named_floor(self):
        self.transcript([turn("m1", input_tokens=1_000_000, output=0)])
        path = self.subagent("agent-a1", [turn("s{0}".format(index), input_tokens=0,
                                               output=1_000_000)
                                          for index in range(400)])
        config = json.loads(json.dumps(self.config))
        config["limits"]["agentTranscriptBytes"] = path.stat().st_size // 2
        figures = agents.read_agent(self.home, SESSION, JOB, config, now=NOON)
        self.assertTrue(figures["lowerBound"])
        self.assertIn("subagent transcript", figures["reason"])
        self.assertIn("longer than", figures["reason"])
        # What was read is still drawn, and drawn as a floor: what the tail left
        # out is named rather than dropped into a smaller sum.
        self.assertGreater(figures["tokens"]["output"], 0)
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 4.0 + figures["tokens"]["output"] * 20 / 1e6)

    def test_a_subagent_transcript_that_cannot_be_read_is_named_not_passed_over(self):
        self.transcript([turn("m1", input_tokens=1_000_000, output=0)])
        # A folder where a transcript should be: read as a file it is refused.
        folder = self.home / "projects" / "-work-project" / SESSION / "subagents"
        (folder / "agent-a1.jsonl").mkdir(parents=True)
        figures = self.read()
        self.assertTrue(figures["lowerBound"])
        self.assertIn("1 subagent transcript could not be read", figures["reason"])
        # The figure is the session's own turns exactly, said to be at least.
        self.assertEqual(figures["tokens"]["input"], 1_000_000)
        self.assertAlmostEqual(figures["costUsd"], 4.0)
        self.assertFalse(figures["spend_series"]["complete"])

    def test_a_subagents_path_that_cannot_be_listed_is_named(self):
        self.transcript([turn("m1")])
        # A file where the session's subagent folder should be.
        folder = self.home / "projects" / "-work-project" / SESSION
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "subagents").write_text("not a folder", encoding="utf-8")
        figures = self.read()
        self.assertTrue(figures["lowerBound"])
        self.assertIn("1 subagent transcript could not be read", figures["reason"])

    def test_more_subagent_transcripts_than_one_read_opens_are_named(self):
        self.transcript([turn("m1")])
        for index in range(agents.MAX_SUBAGENT_FILES + 1):
            self.subagent("agent-{0:04d}".format(index), [turn("s{0}".format(index))])
        figures = self.read()
        self.assertTrue(figures["lowerBound"])
        self.assertIn("more than {0} subagent transcripts".format(agents.MAX_SUBAGENT_FILES),
                      figures["reason"])
        self.assertEqual(figures["turns"], 1 + agents.MAX_SUBAGENT_FILES)

    def test_a_subagent_line_still_being_written_is_not_damage(self):
        self.transcript([turn("m1")])
        path = self.subagent("agent-a1", [turn("s1")])
        with path.open("a", encoding="utf-8") as handle:
            handle.write('{"type": "assistant", "message": {"id": "s2", "us')
        figures = self.read()
        self.assertEqual(figures["damagedRecords"], 0)
        self.assertFalse(figures["lowerBound"])
        self.assertNotIn("reason", figures)
        self.assertEqual(figures["turns"], 2)

    def test_a_session_that_ran_no_subagent_is_read_as_before(self):
        self.transcript([turn("m1")])
        figures = self.read()
        self.assertEqual((figures["turns"], figures["costSource"]), (1, "estimate"))
        self.assertFalse(figures["lowerBound"])
        self.assertNotIn("reason", figures)

    def test_a_subagent_folder_with_no_transcript_in_it_is_not_a_gap(self):
        # The host writes a subagent's sidecar beside its transcript, so a
        # folder holding nothing but one is a session with nothing to add. Read
        # as a gap it would floor a card nothing was missing from.
        self.transcript([turn("m1")])
        folder = self.home / "projects" / "-work-project" / SESSION / "subagents"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "agent-a1.meta.json").write_text("{}", encoding="utf-8")
        figures = self.read()
        self.assertEqual(figures["turns"], 1)
        self.assertFalse(figures["lowerBound"])
        self.assertNotIn("reason", figures)
        self.assertTrue(figures["spend_series"]["complete"])

    def test_the_subagent_a_session_ran_is_not_read_as_its_own_model_or_context(self):
        self.transcript([turn("m1", model="claude-opus-5-5", input_tokens=5, read=400_000)])
        self.subagent("agent-a1", [turn("s1", model="claude-haiku-4-5", input_tokens=9,
                                        read=900_000)])
        figures = self.read()
        self.assertEqual(figures["model"], "claude-opus-5-5")
        self.assertEqual(figures["contextTokens"], 400_005)
        self.assertEqual(figures["tokens"]["cacheRead"], 1_300_000)

    def test_a_subagent_transcript_nobody_can_read_leaves_the_figures_a_floor(self):
        # Every subagent record damaged, so no turn and no spend comes out of
        # them. Merged only where something was readable, the damage would
        # vanish and the card would draw an exact figure that is short by
        # everything those files held.
        self.transcript([turn("m1", input_tokens=1_000_000, output=0)])
        self.subagent("agent-a1", ['{"type": "assistant", "message": '])
        figures = self.read()
        self.assertEqual(figures["damagedRecords"], 1)
        self.assertTrue(figures["lowerBound"])
        self.assertIn("nobody could read", figures["reason"])

    def test_a_session_whose_only_subagent_records_are_damaged_is_not_empty(self):
        # The session's own transcript holds no turn and its subagent's records
        # cannot be read. It spent something nobody could measure, which is not
        # a session that spent nothing.
        self.transcript([{"type": "user", "message": {"content": "hello"}}])
        self.subagent("agent-a1", ['{"type": "assistant", "message": '])
        figures = self.read()
        self.assertNotEqual(figures["state"], "empty")
        self.assertTrue(figures["lowerBound"])

    def test_a_usage_a_subagent_states_prices_a_response_the_session_left_open(self):
        # The session's own record of the response states no usage and the
        # subagent's states it. Settled file by file, the session drew no cost
        # and an incomplete series although the usage had been read.
        record = turn("m1", input_tokens=1_000_000, output=0)
        record["message"].pop("usage")
        self.transcript([record])
        self.subagent("agent-a1", [turn("m1", input_tokens=1_000_000, output=0)])
        figures = self.read()
        self.assertEqual(figures["turns"], 1)
        self.assertEqual(figures["costSource"], "estimate")
        self.assertAlmostEqual(figures["costUsd"], 4.0)

    def test_a_response_no_transcript_states_the_usage_of_leaves_no_cost(self):
        # The same shape with neither file stating the usage: nothing priced it,
        # so the card states no estimate rather than one that leaves it out.
        record = turn("m1", input_tokens=1_000_000, output=0)
        record["message"].pop("usage")
        self.transcript([record])
        self.subagent("agent-a1", [turn("m2", input_tokens=1_000_000, output=0)])
        # Read against a clock the turn is inside the window of, so the series
        # has somewhere to hold the response nobody priced.
        figures = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
        self.assertNotIn("costUsd", figures)
        self.assertFalse(figures["spend_series"]["complete"])


def at(stamp):
    """An ISO time as the epoch seconds a read is handed as its clock."""
    from datetime import datetime
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


NOON = at("2026-10-12T12:00:00Z")


class SpendSeriesTests(AgentCase):
    """Spend per bucket from the same estimate the card's cost uses."""

    def series(self, config=None, now=NOON):
        return agents.read_agent(self.home, SESSION, JOB, config or self.config,
                                 now=now)["spend_series"]

    def tuned(self, **history):
        config = json.loads(json.dumps(self.config))
        config["history"].update(history)
        return config

    def test_each_turn_lands_in_the_bucket_of_its_time(self):
        self.transcript([turn("m1", input_tokens=1_000_000, stamp="2026-10-12T10:00:00Z"),
                         turn("m2", output=1_000_000, stamp="2026-10-12T11:30:00Z")])
        series = self.series()
        self.assertEqual(series["bucket_minutes"], 60)
        self.assertEqual(len(series["buckets"]), 24)
        # Opus at 4 in and 20 out: the 10:00 turn is two hours old, the 11:30
        # turn sits in the hour that ends now.
        self.assertAlmostEqual(series["buckets"][21], 4 + 5 * 20 / 1e6)
        self.assertAlmostEqual(series["buckets"][23], 10 * 4 / 1e6 + 20)
        self.assertEqual(sum(1 for value in series["buckets"] if value), 2)
        self.assertTrue(series["complete"])

    def test_the_total_is_the_card_estimate_when_every_turn_is_in_the_window(self):
        self.transcript([turn("m1", read=50_000, write=20_000, write_1h=5_000,
                              stamp="2026-10-12T09:00:00Z"),
                         turn("m2", model="claude-sonnet-5-5", output=900,
                              stamp="2026-10-12T11:00:00Z")])
        document = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
        self.assertEqual(document["costSource"], "estimate")
        self.assertAlmostEqual(document["spend_series"]["total"], document["costUsd"], places=4)

    def test_a_response_written_as_several_records_is_priced_once(self):
        self.transcript([turn("m1", output=1_000_000, stamp="2026-10-12T11:00:00Z"),
                         turn("m1", output=1_000_000, stamp="2026-10-12T11:00:01Z")])
        self.assertAlmostEqual(self.series()["total"], 10 * 4 / 1e6 + 20)

    def test_a_turn_older_than_the_window_is_not_counted_and_leaves_it_whole(self):
        self.transcript([turn("m1", output=1_000_000, stamp="2026-10-10T12:00:00Z"),
                         turn("m2", output=1_000_000, stamp="2026-10-12T11:00:00Z")])
        series = self.series()
        self.assertAlmostEqual(series["total"], 10 * 4 / 1e6 + 20)
        self.assertTrue(series["complete"])

    def test_a_turn_after_the_clock_is_not_counted(self):
        self.transcript([turn("m1", output=1_000_000, stamp="2026-10-12T12:00:05Z")])
        self.assertEqual(self.series()["total"], 0)

    def test_buckets_and_window_follow_the_configuration(self):
        self.transcript([turn("m1", stamp="2026-10-12T11:50:00Z")])
        series = self.series(self.tuned(spendWindowHours=1, spendBucketMinutes=45))
        # One hour in 45-minute buckets is rounded up to two whole buckets.
        self.assertEqual((series["bucket_minutes"], len(series["buckets"])), (45, 2))
        self.assertGreater(series["buckets"][1], 0)
        self.assertEqual(series["buckets"][0], 0)

    def test_a_session_with_no_turns_is_a_measured_zero(self):
        self.transcript([{"type": "user", "message": {"content": "hello"}}])
        series = self.series()
        self.assertEqual((series["total"], series["complete"]), (0, True))
        self.assertEqual(series["buckets"], [0] * 24)

    def test_an_unpriced_turn_in_the_window_leaves_the_series_incomplete(self):
        self.transcript([turn("m1", stamp="2026-10-12T11:00:00Z"),
                         turn("m2", model="vendorx-large", stamp="2026-10-12T11:10:00Z")])
        series = self.series()
        self.assertFalse(series["complete"])
        self.assertAlmostEqual(series["total"], 10 * 4 / 1e6 + 5 * 20 / 1e6)

    def test_a_turn_with_no_time_leaves_the_series_incomplete(self):
        self.transcript([turn("m1", stamp="2026-10-12T11:00:00Z"), turn("m2", stamp=None),
                         turn("m3", stamp="not a time")])
        self.assertFalse(self.series()["complete"])

    def test_a_damaged_record_leaves_the_series_incomplete(self):
        self.transcript(['{"type": "assistant", "message": ', turn("m1")])
        self.assertFalse(self.series()["complete"])

    def unmeasured(self, change):
        """A transcript of one measured turn and one response the read cannot measure."""
        record = turn("m2", output=1_000_000, stamp="2026-10-12T11:10:00Z")
        change(record["message"])
        self.transcript([turn("m1", stamp="2026-10-12T11:00:00Z"), record])
        return agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)

    def test_a_response_with_no_usage_leaves_the_series_and_the_cost_incomplete(self):
        document = self.unmeasured(lambda message: message.pop("usage"))
        self.assertFalse(document["spend_series"]["complete"])
        # The card states no estimate that leaves the response out.
        self.assertNotIn("costUsd", document)

    def test_a_response_with_no_identifier_leaves_the_series_and_the_cost_incomplete(self):
        document = self.unmeasured(lambda message: message.pop("id"))
        self.assertFalse(document["spend_series"]["complete"])
        self.assertNotIn("costUsd", document)

    def test_a_missing_token_count_is_not_read_as_zero(self):
        document = self.unmeasured(lambda message: message["usage"].pop("output_tokens"))
        self.assertFalse(document["spend_series"]["complete"])
        self.assertNotIn("costUsd", document)
        # The response's other counts are not summed as if it were whole.
        self.assertEqual(document["tokens"]["input"], 10)

    def test_a_measured_record_of_a_response_wins_over_an_unmeasured_one_in_either_order(self):
        # The record without usage falls before the window and the one with it
        # inside: the response is measured, and its spend is in the window.
        bare = turn("m2", stamp="2026-10-10T11:00:00Z")
        del bare["message"]["usage"]
        measured = turn("m2", output=1_000_000, stamp="2026-10-12T11:30:00Z")
        for records in ([bare, measured], [measured, bare]):
            self.transcript(records)
            document = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
            series = document["spend_series"]
            self.assertAlmostEqual(series["total"], 10 * 4 / 1e6 + 20)
            self.assertTrue(series["complete"])
            self.assertAlmostEqual(document["costUsd"], 20.0, places=3)
            self.assertEqual(document["turns"], 1)

    def test_a_response_never_measured_is_unknown_wherever_its_records_fall(self):
        # Two records of one response, neither with usage: the first before the
        # window, the second inside it. The window holds spend nobody measured.
        records = []
        for stamp in ("2026-10-10T11:00:00Z", "2026-10-12T11:30:00Z"):
            record = turn("m2", stamp=stamp)
            del record["message"]["usage"]
            records.append(record)
        self.transcript(records)
        self.assertFalse(self.series()["complete"])

    def test_a_session_of_unmeasured_responses_is_not_empty(self):
        record = turn("m1", stamp="2026-10-12T11:00:00Z")
        del record["message"]["usage"]
        self.transcript([record])
        document = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
        self.assertEqual(document["state"], "ready")
        self.assertFalse(document["spend_series"]["complete"])
        self.assertNotIn("costUsd", document)

    def test_an_unmeasured_response_older_than_the_window_leaves_it_whole(self):
        record = turn("m0", stamp="2026-10-10T11:00:00Z")
        del record["message"]["usage"]
        self.transcript([record, turn("m1", stamp="2026-10-12T11:00:00Z")])
        self.assertTrue(self.series()["complete"])

    def test_the_buckets_add_up_to_the_total_below_a_micro_dollar(self):
        # Four haiku input tokens at 0.1 a million are four tenths of a
        # micro-dollar: two such turns in two hours must still add up.
        self.transcript([turn("m1", model="claude-haiku-5-5", input_tokens=4, output=0,
                              stamp="2026-10-12T10:30:00Z"),
                         turn("m2", model="claude-haiku-5-5", input_tokens=4, output=0,
                              stamp="2026-10-12T11:30:00Z")])
        series = self.series()
        self.assertAlmostEqual(series["buckets"][22], 4e-7, places=15)
        self.assertAlmostEqual(series["buckets"][23], 4e-7, places=15)
        self.assertEqual(math.fsum(series["buckets"]), series["total"])
        self.assertAlmostEqual(series["total"], 8e-7, places=15)

    def test_a_tail_that_starts_inside_the_window_is_incomplete(self):
        records = [turn("m{0}".format(index), stamp="2026-10-12T11:00:00Z")
                   for index in range(200)]
        path = self.transcript(records)
        config = json.loads(json.dumps(self.config))
        config["limits"]["agentTranscriptBytes"] = path.stat().st_size // 2
        self.assertFalse(self.series(config)["complete"])

    def test_a_tail_that_reaches_back_past_the_window_is_complete(self):
        records = [turn("old{0}".format(index), stamp="2026-10-10T11:00:00Z")
                   for index in range(200)]
        records.append(turn("new", stamp="2026-10-12T11:00:00Z"))
        path = self.transcript(records)
        config = json.loads(json.dumps(self.config))
        config["limits"]["agentTranscriptBytes"] = path.stat().st_size // 2
        series = self.series(config)
        self.assertTrue(series["complete"])
        self.assertAlmostEqual(series["total"], 10 * 4 / 1e6 + 5 * 20 / 1e6)

    def test_a_missing_transcript_has_no_series_and_no_timeline(self):
        document = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
        self.assertEqual(document["state"], "unavailable")
        self.assertIsNone(document["spend_series"])
        self.assertIsNone(document["timeline"])

    def test_an_unreadable_transcript_has_no_series(self):
        from unittest import mock
        self.transcript([turn("m1")])
        with mock.patch.object(agents, "read_tail", side_effect=PermissionError("denied")):
            document = agents.read_agent(self.home, SESSION, JOB, self.config, now=NOON)
        self.assertEqual(document["state"], "failed")
        self.assertIsNone(document["spend_series"])
        self.assertIsNone(document["timeline"])


class TimelineTests(AgentCase):
    """Working and idle stretches from the times the transcript records."""

    def timeline(self, config=None, now=NOON):
        return agents.read_agent(self.home, SESSION, JOB, config or self.config,
                                 now=now)["timeline"]

    def test_a_gap_past_the_idle_threshold_splits_the_work(self):
        self.transcript([turn("m1", stamp="2026-10-12T10:00:00Z"),
                         turn("m2", stamp="2026-10-12T10:02:00Z"),
                         turn("m3", stamp="2026-10-12T10:05:00Z"),
                         turn("m4", stamp="2026-10-12T10:10:00Z"),
                         turn("m5", stamp="2026-10-12T10:40:00Z"),
                         turn("m6", stamp="2026-10-12T10:41:30Z")])
        self.assertEqual(self.timeline(), [
            {"start": "2026-10-12T10:00:00Z", "end": "2026-10-12T10:10:00Z", "state": "working"},
            {"start": "2026-10-12T10:10:00Z", "end": "2026-10-12T10:40:00Z", "state": "idle"},
            {"start": "2026-10-12T10:40:00Z", "end": "2026-10-12T10:41:30Z", "state": "working"}])

    def test_the_threshold_follows_the_configuration(self):
        self.transcript([turn("m1", stamp="2026-10-12T10:00:00Z"),
                         turn("m2", stamp="2026-10-12T10:02:00Z")])
        config = json.loads(json.dumps(self.config))
        config["history"]["timelineIdleMinutes"] = 1
        self.assertEqual([segment["state"] for segment in self.timeline(config)],
                         ["working", "idle", "working"])

    def test_records_outside_the_window_are_left_out(self):
        self.transcript([turn("m1", stamp="2026-10-10T10:00:00Z"),
                         turn("m2", stamp="2026-10-12T11:00:00Z"),
                         turn("m3", stamp="2026-10-12T12:30:00Z")])
        self.assertEqual(self.timeline(), [
            {"start": "2026-10-12T11:00:00Z", "end": "2026-10-12T11:00:00Z", "state": "working"}])

    def test_a_record_with_no_time_is_not_placed(self):
        self.transcript([turn("m1", stamp=None), turn("m2", stamp="2026-10-12T11:00:00Z")])
        self.assertEqual(len(self.timeline()), 1)

    def test_a_session_with_no_turns_has_an_empty_timeline(self):
        self.transcript([{"type": "user", "message": {"content": "hello"}}])
        self.assertEqual(self.timeline(), [])

    def test_past_the_limit_the_oldest_segments_merge_into_one(self):
        stamps = ["2026-10-12T{0:02d}:00:00Z".format(hour) for hour in range(5, 10)]
        self.transcript([turn("m{0}".format(index), stamp=stamp)
                         for index, stamp in enumerate(stamps)])
        config = json.loads(json.dumps(self.config))
        config["history"]["timelineSegmentLimit"] = 4
        # Nine segments, working and idle in turn, start and end working, so the
        # most four can hold is three: the oldest idle gaps fold into the work
        # around them and the newest stretches keep their detail.
        self.assertEqual(self.timeline(config), [
            {"start": "2026-10-12T05:00:00Z", "end": "2026-10-12T08:00:00Z", "state": "working"},
            {"start": "2026-10-12T08:00:00Z", "end": "2026-10-12T09:00:00Z", "state": "idle"},
            {"start": "2026-10-12T09:00:00Z", "end": "2026-10-12T09:00:00Z", "state": "working"}])
        config["history"]["timelineSegmentLimit"] = 48
        self.assertEqual(len(self.timeline(config)), 9)

    def test_a_limit_of_one_is_one_working_stretch(self):
        self.transcript([turn("m1", stamp="2026-10-12T05:00:00Z"),
                         turn("m2", stamp="2026-10-12T09:00:00Z")])
        config = json.loads(json.dumps(self.config))
        config["history"]["timelineSegmentLimit"] = 1
        self.assertEqual(self.timeline(config), [
            {"start": "2026-10-12T05:00:00Z", "end": "2026-10-12T09:00:00Z", "state": "working"}])


class LocationTests(AgentCase):
    def test_the_transcript_is_found_in_whichever_project_folder_holds_it(self):
        self.transcript([turn("m1")], folder="-somewhere-else")
        self.assertEqual(self.read()["state"], "ready")

    def test_a_missing_transcript_is_unavailable_not_empty(self):
        figures = self.read()
        self.assertEqual(figures["state"], "unavailable")
        self.assertIn("no transcript", figures["reason"])

    def test_an_identifier_that_is_not_a_session_identifier_never_reaches_a_path(self):
        for bad in ("../" + SESSION, "*", SESSION + "/x", "", None, 7):
            self.assertIsNone(agents.transcript_of(self.home, bad), bad)
            self.assertEqual(agents.read_agent(self.home, bad, JOB, self.config)["state"],
                             "unavailable")

    @unittest.skipIf(os.name == "nt", "symbolic links need privileges on Windows")
    def test_a_linked_transcript_is_not_followed(self):
        target = self.root / "elsewhere.jsonl"
        target.write_text(json.dumps(turn("m1")) + "\n", encoding="utf-8")
        link = self.home / "projects" / "-work-project" / (SESSION + ".jsonl")
        link.symlink_to(target)
        self.assertEqual(self.read()["state"], "unavailable")

    def test_a_folder_named_like_a_transcript_is_not_read(self):
        (self.home / "projects" / "-work-project" / (SESSION + ".jsonl")).mkdir()
        self.assertEqual(self.read()["state"], "unavailable")


class StepTests(AgentCase):
    def test_steps_are_done_of_total_with_the_step_in_hand(self):
        self.transcript([turn("m1")])
        self.task(1, "completed")
        self.task(2, "in_progress", subject="Write it", active="Writing it")
        self.task(3, "pending")
        self.assertEqual(self.read()["steps"], {"done": 1, "total": 3, "phase": "Writing it"})

    def test_the_subject_names_the_step_when_it_has_no_active_form(self):
        self.task(1, "in_progress", subject="Write it")
        self.assertEqual(self.read()["steps"]["phase"], "Write it")

    def test_a_session_without_a_task_list_has_no_steps(self):
        self.transcript([turn("m1")])
        self.assertIsNone(self.read()["steps"])

    def test_files_that_are_not_tasks_are_not_counted(self):
        self.task(1, "completed")
        folder = self.home / "tasks" / ("session-" + JOB)
        (folder / "2.json").write_text("{ not json", encoding="utf-8")
        (folder / "3.json").write_text(json.dumps({"status": "deleted"}), encoding="utf-8")
        (folder / ".lock").write_text("", encoding="utf-8")
        self.assertEqual(self.read()["steps"], {"done": 1, "total": 1, "phase": None})

    def test_an_oversized_task_file_is_not_read(self):
        self.task(1, "completed")
        folder = self.home / "tasks" / ("session-" + JOB)
        (folder / "2.json").write_text(json.dumps({"status": "pending", "subject": "x" * 70000}),
                                       encoding="utf-8")
        self.assertEqual(self.read()["steps"]["total"], 1)

    def test_steps_stand_when_the_transcript_is_missing(self):
        self.task(1, "completed")
        figures = self.read()
        self.assertEqual(figures["state"], "unavailable")
        self.assertEqual(figures["steps"]["done"], 1)

    def test_a_job_identifier_that_could_climb_out_is_refused(self):
        self.assertIsNone(agents.read_steps(self.home, "../x", 65536, 200))


class RosterTests(AgentCase):
    """The roster carries each card's figures, and one bad card stays one bad card."""

    def stub_config(self, rows, enabled=True):
        stub = self.root / "stub.py"
        stub.write_text("import sys\nprint(open(sys.argv[1]).read())\n", encoding="utf-8")
        rows_file = self.root / "rows.json"
        rows_file.write_text(json.dumps(rows), encoding="utf-8")
        path = self.root / "config.json"
        # The state folder is named here: from the environment it follows the
        # platform's own variable (LOCALAPPDATA, XDG_STATE_HOME), not the HOME
        # set below, and a kept rate card would leak between tests and runs.
        path.write_text(json.dumps({
            "stateDir": str(self.root / "state"),
            "commands": {"claude": [sys.executable, str(stub), str(rows_file)]},
            "providers": [{"id": "primary", "home": str(self.home)}],
            "sources": {"agents": {"enabled": enabled}},
        }), encoding="utf-8")
        return load_config(str(path), environ={**os.environ, "HOME": str(self.root / "user")})

    def row(self):
        return {"id": JOB, "kind": "background", "name": "job", "state": "working",
                "cwd": "/tmp", "startedAt": 1_700_000_000_000, "sessionId": SESSION}

    def test_each_job_carries_its_figures(self):
        self.transcript([turn("m1")])
        result = roster.read_providers(self.stub_config([self.row()]))
        self.assertEqual(result["jobs"][0]["agent"]["state"], "ready")

    def test_finished_rows_the_history_limit_drops_are_never_read(self):
        self.transcript([turn("m1")])
        rows = [{**self.row(), "id": "done{0}".format(index), "state": "done",
                 "startedAt": 1_700_000_000_000 + index} for index in range(12)]
        config = self.stub_config(rows)
        calls = []
        original = roster.read_agent

        def counted(home, session_id, job_id, config, **extra):
            calls.append(job_id)
            return original(home, session_id, job_id, config, **extra)

        roster.read_agent = counted
        self.addCleanup(setattr, roster, "read_agent", original)
        result = roster.read_providers(config, now=1_700_000_100)
        self.assertEqual(len(calls), len(result["jobs"]))
        self.assertLess(len(calls), 12)

    def test_the_roster_prices_each_card_at_the_rates_kept_for_its_model(self):
        # A refresh kept a DeepSeek rate a third of the shipped one; the card is
        # drawn at it and says so, and a read reaches no network to get it.
        self.transcript([turn("m1", model="deepseek-flash", input_tokens=1_000_000,
                              output=0)])
        config = self.stub_config([self.row()])
        records = Path(config["stateDir"]) / "records"
        records.mkdir(parents=True)
        (records / "rate-cards.json").write_text(json.dumps({"cards": {"deepseek-flash": {
            "rates": {"input": 0.1, "cacheRead": 0.002, "output": 0.4},
            "checkedAt": 1_700_000_000}}}), encoding="utf-8")
        agent = roster.read_providers(config, now=1_700_000_100)["jobs"][0]["agent"]
        self.assertAlmostEqual(agent["costUsd"], 0.1)
        self.assertEqual(agent["rates"], {"state": "live", "checkedAt": 1_700_000_000})
        # The configuration the caller holds still names the shipped rate.
        self.assertEqual(config["sources"]["agents"]["inputPricePerMTok"]["deepseek-flash"], 0.3)

    def test_a_roster_read_with_nothing_kept_prices_from_the_table(self):
        self.transcript([turn("m1", model="deepseek-flash", input_tokens=1_000_000, output=0)])
        agent = roster.read_providers(self.stub_config([self.row()]),
                                      now=1_700_000_100)["jobs"][0]["agent"]
        self.assertAlmostEqual(agent["costUsd"], 0.3)
        self.assertEqual(agent["rates"]["state"], "table")
        self.assertEqual(agent["rates"]["reason"], "the card has not been read yet")

    def test_a_disabled_source_reads_no_transcript(self):
        self.transcript([turn("m1")])
        result = roster.read_providers(self.stub_config([self.row()], enabled=False))
        self.assertNotIn("agent", result["jobs"][0])

    def test_a_reader_that_raises_fails_its_own_card_only(self):
        config = self.stub_config([self.row(), {**self.row(), "id": "other"}])
        original = roster.read_agent

        def explode(home, session_id, job_id, config, **extra):
            if job_id == JOB:
                raise RuntimeError("boom")
            return original(home, session_id, job_id, config, **extra)

        roster.read_agent = explode
        self.addCleanup(setattr, roster, "read_agent", original)
        result = roster.read_providers(config)
        self.assertEqual(result["state"], "ready")
        states = {job["id"]: job["agent"]["state"] for job in result["jobs"]}
        self.assertEqual(states, {JOB: "failed", "other": "unavailable"})
        failed = [job for job in result["jobs"] if job["id"] == JOB][0]
        self.assertIn("boom", failed["agent"]["reason"])
        self.assertIsNone(failed["agent"]["timeline"])
        # A card whose read raised measured nothing, so the roster's series
        # cannot claim it covered every session.
        self.assertFalse(result["spend_series"]["complete"])


SECOND = "0123abcd-0000-4000-8000-00000000cafe"
# A roster command that fails for the provider whose home is named "broken" and
# prints the rows file for every other.
ROSTER_STUB = """import os, sys
if os.environ.get("CLAUDE_CONFIG_DIR", "").endswith("broken"):
    sys.exit(3)
print(open(sys.argv[1]).read())
"""


class RosterSeriesTests(AgentCase):
    """The roster's spend series is every card's, summed, and says when one is missing."""

    def config_for(self, rows, enabled=True, broken=False, absent=False):
        stub = self.root / "stub.py"
        stub.write_text(ROSTER_STUB, encoding="utf-8")
        rows_file = self.root / "rows.json"
        rows_file.write_text(json.dumps(rows), encoding="utf-8")
        providers = [{"id": "primary", "home": str(self.home)}]
        if broken:
            (self.root / "broken").mkdir(exist_ok=True)
            providers.append({"id": "spare", "home": str(self.root / "broken")})
        if absent:
            # Enabled, but its home is not there: no read reaches it.
            providers.append({"id": "gone", "home": str(self.root / "no-such-home")})
        path = self.root / "config.json"
        # The state folder is named here: from the environment it follows the
        # platform's own variable (LOCALAPPDATA, XDG_STATE_HOME), not the HOME
        # set below, and a kept rate card would leak between tests and runs.
        path.write_text(json.dumps({
            "stateDir": str(self.root / "state"),
            "commands": {"claude": [sys.executable, str(stub), str(rows_file)]},
            "providers": providers,
            "sources": {"agents": {"enabled": enabled}},
        }), encoding="utf-8")
        return load_config(str(path), environ={**os.environ, "HOME": str(self.root / "user")})

    def row(self, job_id=JOB, session=SESSION):
        return {"id": job_id, "kind": "background", "name": "job", "state": "working",
                "cwd": "/tmp", "startedAt": 1_700_000_000_000, "sessionId": session}

    def test_the_series_sums_every_card(self):
        self.transcript([turn("m1", output=1_000_000, stamp="2026-10-12T11:30:00Z")])
        self.transcript([turn("m1", input_tokens=1_000_000, stamp="2026-10-12T10:30:00Z"),
                         turn("m2", output=1_000_000, stamp="2026-10-12T11:40:00Z")],
                        session=SECOND)
        result = roster.read_providers(
            self.config_for([self.row(), self.row("other", SECOND)]), now=NOON)
        series = result["spend_series"]
        cards = [job["agent"]["spend_series"] for job in result["jobs"]]
        self.assertEqual(series["sessions"], 2)
        self.assertTrue(series["complete"])
        self.assertEqual(series["bucket_minutes"], 60)
        for index in range(24):
            self.assertAlmostEqual(series["buckets"][index],
                                   sum(card["buckets"][index] for card in cards))
        self.assertAlmostEqual(series["total"], sum(card["total"] for card in cards))
        self.assertAlmostEqual(series["buckets"][23], 2 * (10 * 4 / 1e6 + 20))
        self.assertAlmostEqual(series["buckets"][22], 4 + 5 * 20 / 1e6)
        self.assertIsInstance(result["jobs"][0]["agent"]["timeline"], list)

    def test_a_card_without_a_transcript_leaves_the_series_incomplete(self):
        self.transcript([turn("m1")])
        result = roster.read_providers(
            self.config_for([self.row(), self.row("other", SECOND)]), now=NOON)
        self.assertFalse(result["spend_series"]["complete"])
        self.assertEqual(result["spend_series"]["sessions"], 1)

    def test_a_provider_that_failed_leaves_the_series_incomplete(self):
        self.transcript([turn("m1")])
        result = roster.read_providers(self.config_for([self.row()], broken=True), now=NOON)
        self.assertEqual(result["providers"]["spare"]["state"], "failed")
        self.assertFalse(result["spend_series"]["complete"])

    def test_a_provider_whose_home_is_unavailable_leaves_the_series_incomplete(self):
        self.transcript([turn("m1", stamp="2026-10-12T11:00:00Z")])
        result = roster.read_providers(self.config_for([self.row()], absent=True), now=NOON)
        self.assertEqual(result["providers"]["primary"]["state"], "ready")
        self.assertEqual(result["providers"]["gone"]["state"], "unavailable")
        self.assertEqual(result["spend_series"]["sessions"], 1)
        self.assertFalse(result["spend_series"]["complete"])

    def test_the_total_is_every_card_total_below_a_micro_dollar(self):
        cheap = turn("m1", model="claude-haiku-5-5", input_tokens=4, output=0,
                     stamp="2026-10-12T11:30:00Z")
        self.transcript([cheap])
        self.transcript([cheap], session=SECOND)
        result = roster.read_providers(
            self.config_for([self.row(), self.row("other", SECOND)]), now=NOON)
        series = result["spend_series"]
        cards = [job["agent"]["spend_series"] for job in result["jobs"]]
        self.assertEqual(series["total"], math.fsum(card["total"] for card in cards))
        self.assertEqual(series["buckets"][23],
                         math.fsum(card["buckets"][23] for card in cards))
        self.assertAlmostEqual(series["total"], 8e-7, places=15)
        self.assertTrue(series["complete"])

    def test_no_session_read_is_a_measured_empty_series(self):
        result = roster.read_providers(self.config_for([]), now=NOON)
        self.assertEqual(result["state"], "empty")
        series = result["spend_series"]
        self.assertEqual((series["total"], series["complete"], series["sessions"]), (0, True, 0))
        self.assertEqual(series["buckets"], [0] * 24)

    def test_a_disabled_agent_source_has_no_series(self):
        self.transcript([turn("m1")])
        result = roster.read_providers(self.config_for([self.row()], enabled=False), now=NOON)
        self.assertIsNone(result["spend_series"])

    def test_a_roster_that_read_nothing_has_no_series(self):
        config = self.config_for([self.row()])
        config["commands"]["claude"] = ["fleet-absent-claude"]
        result = roster.read_providers(config, now=NOON)
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNone(result["spend_series"])


if __name__ == "__main__":
    unittest.main()
