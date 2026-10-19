#!/usr/bin/env python3
"""Transcript economics, driven through real files and a real command.

The cases that matter are the ones where the transcript is not what a reader would
like: absent, empty, half-written, damaged in the middle, holding records that are
not assistant turns, or longer than the byte limit. Each has to land in a state
that says which happened, and the arithmetic has to be the arithmetic.

Run with: python3 tests/test_reader_transcript.py -v
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from readers import transcript


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "llm-fleet" / "readers" / "transcript.py"
# The `sources.agents` group as the schema defaults it, for the current
# generation of each family: the session section prices its cache saving from
# the same rates the agent cards do. A key names a generation, which is what the
# shipped maps hold, so each entry here is a generation the tests read with.
PRICES = {"inputPricePerMTok": {"fable-5-1": 10, "opus-5-5": 4, "sonnet-5-5": 2,
                                "haiku-5-5": 0.1},
          "outputPricePerMTok": {"fable-5-1": 50, "opus-5-5": 20, "sonnet-5-5": 10,
                                 "haiku-5-5": 0.5},
          "cacheReadPricePerMTok": {"fable-5-1": 0.25, "opus-5-5": 0.2, "sonnet-5-5": 0.2,
                                    "haiku-5-5": 0.01},
          "cacheWrite5mMultiplier": 1.25, "cacheWrite1hMultiplier": 2}


def assistant(input_tokens=0, cache_creation=0, cache_read=0, extra=None, long_lived=None):
    usage = {"input_tokens": input_tokens,
             "cache_creation_input_tokens": cache_creation,
             "cache_read_input_tokens": cache_read}
    if long_lived is not None:
        usage["cache_creation"] = {"ephemeral_5m_input_tokens": cache_creation - long_lived,
                                   "ephemeral_1h_input_tokens": long_lived}
    if extra:
        usage.update(extra)
    return {"type": "assistant", "message": {"usage": usage}}


class TranscriptCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def transcript(self, records, name="session.jsonl"):
        path = self.root / name
        path.write_text("\n".join(
            record if isinstance(record, str) else json.dumps(record) for record in records
        ) + "\n")
        return path

    def read(self, path, model_id="claude-opus-5-5[1m]", max_bytes=1048576, prices=PRICES):
        return transcript.read_transcript(path, max_bytes=max_bytes, model_id=model_id,
                                          prices=prices)

    def test_the_arithmetic_is_the_arithmetic(self):
        # saved = read * (in - read rate) - write5m * in * 0.25 - write1h * in * 1, per million
        rates = transcript.rates_for("opus-5-5", PRICES)
        self.assertEqual(rates, {"input": 4.0, "cacheRead": 0.2, "write5m": 1.25, "write1h": 2.0})
        self.assertAlmostEqual(transcript.saved_usd(20_000, 0, 1_780_000, rates), 6.744)
        self.assertAlmostEqual(transcript.saved_usd(0, 20_000, 1_780_000, rates), 6.684)
        self.assertAlmostEqual(transcript.saved_usd(0, 0, 0, rates), 0.0)

    def test_a_summed_session_reports_its_economics(self):
        path = self.transcript([
            assistant(1_000, 20_000, 880_000),
            {"type": "user", "message": {"content": "next"}},
            assistant(500, 0, 900_000),
        ])
        document = self.read(path)
        self.assertEqual(document["state"], "ready")
        self.assertEqual(document["records"], 2)
        self.assertEqual(document["inputTokens"], 1_500)
        self.assertEqual(document["cacheCreationTokens"], 20_000)
        self.assertEqual(document["cacheReadTokens"], 1_780_000)
        self.assertEqual(document["cacheWrite1hTokens"], 0)
        self.assertEqual(document["rawTokens"], 1_801_500)
        self.assertEqual(document["savedTokens"], 1_686_000)
        self.assertEqual(document["priceFamily"], "opus-5-5")
        self.assertEqual(document["pricePerMTok"], 4)
        self.assertEqual(document["savedUsd"], 6.744)

    def test_a_long_lived_cache_write_is_priced_at_its_own_premium(self):
        # One million written, four hundred thousand of it for an hour:
        # 600k at a quarter of the input rate over, 400k at the whole of it.
        path = self.transcript([assistant(0, 1_000_000, 0, long_lived=400_000)])
        document = self.read(path)
        self.assertEqual(document["cacheCreationTokens"], 1_000_000)
        self.assertEqual(document["cacheWrite1hTokens"], 400_000)
        self.assertEqual(document["savedUsd"], -2.2)
        self.assertEqual(document["savedTokens"], -550_000)

    def test_an_unsplit_cache_write_is_taken_at_the_short_lived_premium(self):
        # The cheaper premium never overstates what the cache saved.
        split = self.read(self.transcript([assistant(0, 1_000_000, 0, long_lived=0)], "a.jsonl"))
        unsplit = self.read(self.transcript([assistant(0, 1_000_000, 0)], "b.jsonl"))
        self.assertEqual(split["savedUsd"], unsplit["savedUsd"])
        self.assertEqual(unsplit["savedUsd"], -1.0)

    def test_a_response_written_as_several_records_counts_once(self):
        # The host writes a record per content block, each with the whole
        # response's usage. A record without an identifier is still counted.
        first = assistant(100, 0, 1_000)
        first["message"]["id"] = "m1"
        second = assistant(50, 0, 500)
        second["message"]["id"] = "m2"
        document = self.read(self.transcript([first, first, first, second,
                                              assistant(1, 0, 0)]))
        self.assertEqual(document["records"], 3)
        self.assertEqual(document["inputTokens"], 151)
        self.assertEqual(document["cacheReadTokens"], 1_500)

    def test_the_price_comes_from_the_generation_the_model_names(self):
        path = self.transcript([assistant(0, 0, 1_000_000)])
        fable = self.read(path, model_id="claude-fable-5-1")
        opus = self.read(path, model_id="claude-opus-5-5")
        sonnet = self.read(path, model_id="claude-sonnet-5-5")
        haiku = self.read(path, model_id="claude-haiku-5-5")
        self.assertEqual((fable["priceFamily"], fable["pricePerMTok"], fable["savedUsd"]),
                         ("fable-5-1", 10, 9.75))
        self.assertEqual((opus["priceFamily"], opus["pricePerMTok"], opus["savedUsd"]),
                         ("opus-5-5", 4, 3.8))
        self.assertEqual((sonnet["priceFamily"], sonnet["pricePerMTok"], sonnet["savedUsd"]),
                         ("sonnet-5-5", 2, 1.8))
        self.assertEqual((haiku["priceFamily"], haiku["pricePerMTok"], haiku["savedUsd"]),
                         ("haiku-5-5", 0.1, 0.09))

    def test_a_model_outside_the_families_has_no_saving_rather_than_another_rate(self):
        path = self.transcript([assistant(0, 0, 1_000_000)])
        other = self.read(path, model_id="qwen3-coder")
        self.assertEqual(other["state"], "ready")
        self.assertEqual(other["priceFamily"], "other")
        self.assertEqual(other["prices"], "absent")
        self.assertNotIn("savedUsd", other)
        self.assertNotIn("savedTokens", other)
        self.assertNotIn("pricePerMTok", other)

    def test_a_family_rate_never_prices_a_model_of_another_family(self):
        # A map naming a family without a generation prices that family's own
        # models, and nothing else: a model outside every family has no saving
        # rather than whatever rate a fallback happened to reach.
        prices = json.loads(json.dumps(PRICES))
        prices["inputPricePerMTok"]["opus"] = 4
        prices["cacheReadPricePerMTok"]["opus"] = 0.2
        document = self.read(self.transcript([assistant(0, 0, 1_000_000)]),
                             model_id="qwen3-coder", prices=prices)
        self.assertEqual(document["priceFamily"], "other")
        self.assertEqual(document["prices"], "absent")
        self.assertNotIn("savedUsd", document)
        self.assertNotIn("savedTokens", document)
        self.assertNotIn("pricePerMTok", document)

    def test_a_configured_other_family_prices_a_model_outside_the_rest(self):
        prices = json.loads(json.dumps(PRICES))
        prices["inputPricePerMTok"]["other"] = 3
        prices["cacheReadPricePerMTok"]["other"] = 0.3
        other = self.read(self.transcript([assistant(0, 0, 1_000_000)]),
                          model_id="qwen3-coder", prices=prices)
        self.assertEqual((other["pricePerMTok"], other["savedUsd"]), (3, 2.7))

    def test_a_generation_the_configuration_adds_prices_its_model(self):
        # A vendor key names the generation, which is what the shipped maps
        # hold and what a key has to name to price anything.
        prices = json.loads(json.dumps(PRICES))
        prices["inputPricePerMTok"]["mythos-1"] = 3
        prices["cacheReadPricePerMTok"]["mythos-1"] = 0.3
        document = self.read(self.transcript([assistant(0, 0, 1_000_000)]),
                             model_id="mythos-1", prices=prices)
        self.assertEqual((document["priceFamily"], document["pricePerMTok"],
                          document["savedUsd"]), ("mythos-1", 3, 2.7))

    def test_a_key_naming_only_a_vendor_prices_no_model_of_it(self):
        # A vendor key without a generation is not a whole model, so it prices
        # nothing rather than every model the vendor ships.
        prices = json.loads(json.dumps(PRICES))
        prices["inputPricePerMTok"]["mythos"] = 3
        prices["cacheReadPricePerMTok"]["mythos"] = 0.3
        document = self.read(self.transcript([assistant(0, 0, 1_000_000)]),
                             model_id="mythos-1", prices=prices)
        self.assertEqual(document["prices"], "absent")
        self.assertNotIn("pricePerMTok", document)
        self.assertNotIn("savedUsd", document)

    def test_a_family_with_no_cache_read_rate_has_no_saving(self):
        prices = json.loads(json.dumps(PRICES))
        del prices["cacheReadPricePerMTok"]["opus-5-5"]
        document = self.read(self.transcript([assistant(0, 0, 1_000_000)]), prices=prices)
        self.assertEqual(document["prices"], "absent")
        self.assertNotIn("savedUsd", document)

    def test_a_missing_write_multiplier_has_no_saving(self):
        prices = json.loads(json.dumps(PRICES))
        del prices["cacheWrite1hMultiplier"]
        document = self.read(self.transcript([assistant(0, 0, 1_000_000)]), prices=prices)
        self.assertEqual(document["prices"], "absent")
        self.assertNotIn("savedUsd", document)

    def test_a_cold_session_reports_the_negative_saving_rather_than_clamping_it(self):
        # Nothing cached yet: the write premium is real, so the difference is
        # negative, and the renderer decides whether to draw it.
        path = self.transcript([assistant(0, 1_000_000, 0)])
        document = self.read(path)
        self.assertEqual(document["savedTokens"], -250_000)
        self.assertEqual(document["savedUsd"], -1.0)

    def test_records_that_are_not_assistant_turns_are_skipped_not_counted(self):
        path = self.transcript([
            {"type": "user", "message": {"content": "hello"}},
            {"type": "summary", "summary": "a summary"},
            {"type": "assistant", "message": {"content": [{"type": "text"}]}},
            assistant(10, 0, 0),
        ])
        document = self.read(path)
        self.assertEqual(document["records"], 1)
        self.assertEqual(document["damagedRecords"], 0)
        self.assertEqual(document["inputTokens"], 10)

    def test_a_damaged_record_is_counted_and_the_scan_continues(self):
        path = self.transcript([
            assistant(10, 0, 0),
            '{"type": "assistant", "message": {"usage":',  # written while read
            assistant(20, 0, 0),
        ])
        document = self.read(path)
        self.assertEqual(document["records"], 2)
        self.assertEqual(document["damagedRecords"], 1)
        self.assertEqual(document["inputTokens"], 30)
        self.assertEqual(document["state"], "ready")

    def test_a_record_whose_counts_are_not_counts_is_damaged(self):
        path = self.transcript([
            assistant(extra={"input_tokens": "ten"}),
            assistant(5, 0, 0),
        ])
        document = self.read(path)
        self.assertEqual(document["records"], 1)
        self.assertEqual(document["damagedRecords"], 1)
        self.assertEqual(document["inputTokens"], 5)

    def test_a_negative_count_is_damaged_rather_than_subtracted(self):
        path = self.transcript([assistant(-5, 0, 0), assistant(7, 0, 0)])
        document = self.read(path)
        self.assertEqual(document["inputTokens"], 7)
        self.assertEqual(document["damagedRecords"], 1)

    def test_a_cache_write_split_that_is_not_a_split_is_damaged(self):
        path = self.transcript([
            assistant(1, 10, 0, extra={"cache_creation": "ten"}),
            assistant(2, 10, 0, extra={"cache_creation": {"ephemeral_1h_input_tokens": -1}}),
            assistant(4, 10, 0, extra={"cache_creation": {"ephemeral_1h_input_tokens": 11}}),
            assistant(8, 10, 0, long_lived=10),
        ])
        document = self.read(path)
        self.assertEqual(document["damagedRecords"], 3)
        self.assertEqual(document["records"], 1)
        self.assertEqual(document["inputTokens"], 8)
        self.assertEqual(document["cacheWrite1hTokens"], 10)

    def test_a_boolean_count_is_damaged_rather_than_read_as_one(self):
        path = self.transcript([assistant(extra={"input_tokens": True}), assistant(3, 0, 0)])
        document = self.read(path)
        self.assertEqual(document["inputTokens"], 3)
        self.assertEqual(document["damagedRecords"], 1)

    def test_a_transcript_with_no_readable_record_is_empty_not_ready(self):
        path = self.transcript(['not json at all'])
        document = self.read(path)
        self.assertEqual(document["state"], "empty")
        self.assertEqual(document["damagedRecords"], 1)
        self.assertEqual(document["reason"], "no record in the transcript could be read")

    def test_a_transcript_holding_only_other_records_is_empty(self):
        path = self.transcript([{"type": "user", "message": {"content": "hi"}}])
        document = self.read(path)
        self.assertEqual(document["state"], "empty")
        self.assertEqual(document["records"], 0)
        self.assertNotIn("savedUsd", document)

    def test_a_missing_transcript_is_unavailable_and_says_so(self):
        document = self.read(self.root / "not-there.jsonl")
        self.assertEqual(document["state"], "unavailable")
        self.assertEqual(document["reason"], "the transcript is not there")

    def test_no_path_at_all_is_unavailable_rather_than_a_crash(self):
        document = self.read(None)
        self.assertEqual(document["state"], "unavailable")
        self.assertEqual(document["reason"], "the host named no transcript")

    def test_an_empty_file_is_empty(self):
        path = self.root / "empty.jsonl"
        path.write_text("")
        document = self.read(path)
        self.assertEqual(document["state"], "empty")
        self.assertEqual(document["bytes"], 0)

    def test_a_transcript_over_the_limit_is_truncated_and_says_so(self):
        path = self.transcript([assistant(1_000, 0, 0), assistant(2_000, 0, 0)])
        whole = self.read(path)
        self.assertEqual(whole["state"], "ready")
        self.assertEqual(whole["truncated"], False)
        self.assertEqual(whole["inputTokens"], 3_000)

        cut = self.read(path, max_bytes=120)
        self.assertEqual(cut["truncated"], True)
        self.assertIn("longer than 120 bytes", cut["reason"])
        self.assertLess(cut["inputTokens"], 3_000)
        self.assertLessEqual(cut["bytes"], 120)

    def test_a_half_written_final_line_is_not_counted_as_damage(self):
        # A cut read ends mid-record; the partial line is dropped rather than
        # reported as a damaged record that the transcript never contained.
        path = self.transcript([assistant(1_000, 0, 0), assistant(2_000, 0, 0)])
        cut = self.read(path, max_bytes=110)
        self.assertEqual(cut["truncated"], True)
        self.assertEqual(cut["damagedRecords"], 0)

    def test_a_limit_of_zero_is_refused(self):
        document = self.read(self.transcript([assistant(1, 0, 0)]), max_bytes=0)
        self.assertEqual(document["state"], "failed")
        self.assertIn("positive", document["reason"])

    def test_a_prices_map_without_the_family_reports_prices_absent(self):
        path = self.transcript([assistant(0, 0, 1_000_000)])
        document = transcript.read_transcript(path, max_bytes=1048576,
                                              model_id="claude-opus-4-6", prices={})
        self.assertEqual(document["state"], "ready")
        self.assertEqual(document["prices"], "absent")
        self.assertNotIn("savedUsd", document)

    def test_the_command_reads_the_prices_from_the_configuration(self):
        path = self.transcript([assistant(0, 0, 1_000_000)])
        result = subprocess.run([sys.executable, str(SCRIPT), "--path", str(path),
                                 "--model", "claude-sonnet-5-5"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual(document["pricePerMTok"], 2)
        self.assertEqual(document["savedUsd"], 1.8)

    def test_the_command_prices_a_fable_session_at_the_fable_rates(self):
        # The family the retired statusline map never had: priced at the
        # `other` rate of 5 there, at its own rates from the agents group here.
        # The key is the family and generation the rates were checked against.
        path = self.transcript([assistant(0, 0, 1_000_000)])
        result = subprocess.run([sys.executable, str(SCRIPT), "--path", str(path),
                                 "--model", "claude-fable-5-1"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual((document["priceFamily"], document["pricePerMTok"]), ("fable-5-1", 10))
        self.assertEqual(document["savedUsd"], 9.75)

    def test_the_command_prices_an_older_generation_at_the_generation_rates(self):
        # A session on an older generation of a family the packaged keys name:
        # priced at that generation's own rates, not at its family's, and the
        # generation key wins over the family key it also matches.
        path = self.transcript([assistant(0, 0, 1_000_000)])
        result = subprocess.run([sys.executable, str(SCRIPT), "--path", str(path),
                                 "--model", "claude-opus-4-7"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual((document["priceFamily"], document["pricePerMTok"]), ("opus-4-7", 5))
        self.assertEqual(document["savedUsd"], 4.5)

    def test_the_command_prices_a_generation_no_key_names_as_unpriced(self):
        # A generation the packaged keys do not name, of a family they do:
        # no cost rather than its family's rate, and no saving rather than one
        # priced at another generation's rate.
        path = self.transcript([assistant(0, 0, 1_000_000)])
        result = subprocess.run([sys.executable, str(SCRIPT), "--path", str(path),
                                 "--model", "claude-opus-4-6"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual((document["priceFamily"], document["prices"]), ("other", "absent"))
        self.assertNotIn("savedUsd", document)
        self.assertNotIn("pricePerMTok", document)

    def test_the_command_exits_nonzero_when_there_is_no_economics(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--path",
                                 str(self.root / "not-there.jsonl")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "unavailable")


if __name__ == "__main__":
    unittest.main()
