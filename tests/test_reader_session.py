#!/usr/bin/env python3
"""What this session spent, and what it is running under.

The payload behind these figures is written by a renderer this repository does
not run, so the cases here are about the two ways a figure can go wrong without
anybody noticing: a field the payload never carried drawn as a zero, and a
payload this layer could not read drawn as a session that spent nothing.
"""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import session as session_reader


PAYLOAD = {
    "session_id": "c9e47808-8e26",
    "session_name": "llm-fleet-DSK-Oct-12",
    "cwd": "/tmp/project",
    "version": "2.0.1",
    "model": {"id": "claude-opus-5-5", "display_name": "Opus 5.5"},
    "output_style": "concise",
    "effort": "high",
    "thinking": {"enabled": True},
    "worktree": {"path": "/tmp/worktrees/task"},
    "pr": None,
    "cost": {"total_cost_usd": 12.5, "total_duration_ms": 900000,
             "total_api_duration_ms": 300000, "total_lines_added": 420,
             "total_lines_removed": 88},
    "context_window": {"total_input_tokens": 180000, "total_output_tokens": 24000,
                       "remaining_percentage": 42.5, "context_window_size": 200000,
                       "current_usage": {"cache_read_input_tokens": 900000,
                                         "cache_creation_input_tokens": 20000}},
    "rate_limits": {"five_hour": {"used_percentage": 61, "resets_at": 1790009999},
                    "seven_day": {"used_percentage": 22},
                    "spend_limit": {"used_percentage": 8}},
}


class SessionCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-session-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.payload = self.root / "payload.json"

    def config(self, limits=None, **statusline):
        document = {"sources": {"statusline": {"enabled": True,
                                               "payload": str(self.payload)}}}
        document["sources"]["statusline"].update(statusline)
        if limits is not None:
            document["limits"] = limits
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(path, environ=sandbox.home_environment(self.root))

    def wrote(self, payload):
        self.payload.write_text(payload if isinstance(payload, str) else json.dumps(payload),
                                encoding="utf-8")

    def read(self, limits=None, **statusline):
        return session_reader.read_session(self.config(limits=limits, **statusline))


class FigureTests(SessionCase):
    def test_the_figures_the_payload_carries_are_the_ones_reported(self):
        self.wrote(PAYLOAD)
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["costUsd"], 12.5)
        self.assertEqual(result["durationMs"], 900000)
        self.assertEqual(result["windowSize"], 200000)
        self.assertEqual(result["remainingPercent"], 42.5)
        self.assertEqual(result["model"], "claude-opus-5-5")
        self.assertEqual(result["modelName"], "Opus 5.5")
        self.assertEqual(result["fiveHourUsedPercent"], 61)
        self.assertEqual(result["parameters"], {"effort": "high", "thinking": "present",
                                                "worktree": "present"})

    def test_a_field_the_payload_did_not_carry_stays_absent(self):
        # The whole point of this layer. A nought here is the pane stating that
        # the session has spent nothing, which is a claim about the machine made
        # from a field the host never sent.
        self.wrote({"session_id": "abc", "model": {"id": "claude-opus-5-5"}})
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertNotIn("costUsd", result)
        self.assertNotIn("remainingPercent", result)
        for name in ("costUsd", "remainingPercent", "windowSize", "effort"):
            self.assertIn(name, result["absent"], name)
        self.assertEqual(result["parameters"], {})

    def test_a_field_of_the_wrong_type_is_absent_rather_than_coerced(self):
        # The host changing a field's type is the host telling us nothing. A cost
        # read as a string, or a percentage read as a boolean, would be this
        # layer inventing a figure out of whatever was there.
        self.wrote({"cost": {"total_cost_usd": "12.50"},
                    "context_window": {"remaining_percentage": True},
                    "session_id": 7})
        result = self.read()
        for name in ("costUsd", "remainingPercent", "sessionId"):
            self.assertIn(name, result["absent"], name)
        self.assertNotIn("costUsd", result)

    def test_a_parameter_that_is_an_object_is_reported_as_present(self):
        # `{'enabled': True}` drawn on a row is this layer printing the shape of
        # an object at somebody. What a pane wants to know about a worktree is
        # that there is one.
        self.wrote({"worktree": {"path": "/tmp/wt"}, "thinking": {"enabled": False},
                    "pr": [1, 2, 3], "prompt_cache": {}})
        result = self.read()
        self.assertEqual(result["parameters"]["worktree"], "present")
        self.assertEqual(result["parameters"]["thinking"], "present")
        self.assertEqual(result["parameters"]["pullRequest"], "3 set")
        # An empty object is nothing to report, so it is absent rather than a row
        # saying a cache exists.
        self.assertNotIn("promptCache", result["parameters"])


class RefusalTests(SessionCase):
    def test_a_source_that_is_off_is_not_read(self):
        self.wrote(PAYLOAD)
        result = self.read(enabled=False)
        self.assertEqual(result["state"], "disabled")
        self.assertNotIn("costUsd", result)

    def test_a_payload_that_is_not_there_is_unavailable_not_empty(self):
        result = self.read()
        self.assertEqual(result["state"], "unavailable")
        self.assertIn("has not written", result["errors"][0]["reason"])
        self.assertNotIn("costUsd", result)

    def test_a_payload_holding_nothing_is_empty_not_a_session(self):
        self.wrote("")
        result = self.read()
        self.assertEqual(result["state"], "empty")
        self.assertNotIn("costUsd", result)

    def test_a_payload_that_is_not_json_is_failed_with_its_reason(self):
        self.wrote("{not json")
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertIn("JSONDecodeError", result["errors"][0]["reason"])

    def test_a_payload_over_the_limit_is_refused_rather_than_truncated(self):
        # A truncated payload is a different document, and the fields missing
        # from it are missing because of this layer rather than the host. So one
        # byte over is a refusal, and the reason says which limit.
        self.wrote({"session_id": "abc", "padding": "x" * 3000})
        result = self.read(limits={"hostPayloadBytes": 1024})
        self.assertEqual(result["state"], "failed")
        self.assertIn("larger than the configured limit", result["errors"][0]["reason"])
        self.assertNotIn("sessionId", result)

    def test_a_payload_that_is_not_an_object_is_empty(self):
        for written in ('"a string"', "[1, 2]", "7"):
            self.wrote(written)
            self.assertEqual(self.read()["state"], "empty", written)


class PayloadPathTests(SessionCase):
    def test_a_payload_path_naming_the_session_is_filled_with_it(self):
        # One renderer serves every session on the machine, so a single file
        # holds whichever session rendered last. A path naming the session
        # reads this session's own payload, not another one's figures.
        template = self.root / "payload-{session}.json"
        (self.root / "payload-aaa.json").write_text(
            json.dumps({"model": {"id": "claude-opus-5-5"},
                        "cost": {"total_cost_usd": 3.0}}), encoding="utf-8")
        (self.root / "payload-bbb.json").write_text(
            json.dumps({"model": {"id": "claude-opus-5-5"},
                        "cost": {"total_cost_usd": 9.0}}), encoding="utf-8")
        config = self.config(payload=str(template))
        first = session_reader.read_session(config, session_id="aaa", model="claude-opus-5-5")
        second = session_reader.read_session(config, session_id="bbb", model="claude-opus-5-5")
        self.assertEqual(first["state"], "ready")
        self.assertEqual(first["costUsd"], 3.0)
        self.assertEqual(second["costUsd"], 9.0)

    def test_a_payload_path_naming_the_session_reads_unavailable_without_one(self):
        # No identifier is not every identifier: reading whichever file exists
        # would draw another session's spend under this session's name.
        config = self.config(payload=str(self.root / "payload-{session}.json"))
        result = session_reader.read_session(config)
        self.assertEqual(result["state"], "unavailable")
        self.assertIn("session", result["errors"][0]["reason"])

    def test_a_session_identifier_that_could_climb_is_refused(self):
        config = self.config(payload=str(self.root / "payload-{session}.json"))
        result = session_reader.read_session(config, session_id="../payload")
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["errors"][0]["source"], "session")


class ProviderCostTests(SessionCase):
    """A routed session's spend, as the status line priced it per session."""

    def setUp(self):
        super().setUp()
        self.costs = self.root / "statusline"
        self.costs.mkdir()
        self.config_with = self.config

    def memo(self, session_id, cost, provider="deepseek"):
        path = self.costs / (provider + "-session-" + session_id + ".json")
        usage = None if cost is None else {"cost": cost, "turns": 3}
        path.write_text(json.dumps({"usage": usage, "key": {"model": "deepseek-flash"}}),
                        encoding="utf-8")
        return path

    def read_for(self, session_id, model):
        return session_reader.read_session(self.config(sessionCosts=str(self.costs)),
                                           session_id=session_id, model=model)

    def test_a_routed_session_reports_the_priced_figure_and_not_the_hosts(self):
        self.memo("46812183", 0.06474438)
        result = self.read_for("46812183", "deepseek-flash[1m]")
        self.assertEqual(result["state"], "ready")
        self.assertAlmostEqual(result["providerCostUsd"], 0.06474438)
        self.assertEqual(result["costSource"], "provider")
        # The host's table is not repeated under the same name.
        self.assertNotIn("costUsd", result)

    def test_a_claude_session_keeps_the_hosts_figure(self):
        self.memo("abc123", 9.99)
        self.assertNotIn("providerCostUsd", self.read_for("abc123", "claude-opus-5-5"))

    def test_nothing_is_read_for_a_session_with_no_memo_or_no_priced_usage(self):
        self.assertNotIn("providerCostUsd", self.read_for("missing1", "deepseek-flash"))
        self.memo("unpriced1", None)
        self.assertNotIn("providerCostUsd", self.read_for("unpriced1", "deepseek-flash"))

    def test_an_identifier_that_could_climb_out_of_the_folder_is_refused(self):
        outside = self.root / "deepseek-session-..json"
        outside.write_text(json.dumps({"usage": {"cost": 1.0}}), encoding="utf-8")
        self.assertNotIn("providerCostUsd", self.read_for("../x", "deepseek-flash"))
        self.assertNotIn("providerCostUsd", self.read_for("..", "deepseek-flash"))

    def test_two_providers_naming_one_session_price_nothing(self):
        self.memo("both1", 1.0, provider="deepseek")
        self.memo("both1", 2.0, provider="mimo")
        self.assertNotIn("providerCostUsd", self.read_for("both1", "deepseek-flash"))


class SpendWindowTests(SessionCase):
    """What the whole machine spent, from the status line's priced session files."""

    NOW = 1_800_000_000.0

    def setUp(self):
        super().setUp()
        self.costs = self.root / "statusline"
        self.costs.mkdir()
        # The session's own payload is present, so the figure under test is the
        # only thing that could make the document unavailable.
        self.wrote(PAYLOAD)

    def spend_file(self, name, cost, written):
        path = self.costs / ("deepseek-session-" + name + ".json")
        path.write_text(json.dumps({"usage": {"cost": cost}}), encoding="utf-8")
        os.utime(path, (written, written))
        return path

    def read_at(self, **statusline):
        return session_reader.read_session(self.config(sessionCosts=str(self.costs), **statusline),
                                           now=self.NOW)

    def test_files_inside_the_window_are_summed_and_older_ones_are_cut(self):
        self.spend_file("one", 1.25, self.NOW - 60)
        self.spend_file("two", 1.79, self.NOW - 3600)
        # Older than the configured day, so it is a session that spent outside
        # the stretch being asked about rather than a file this read lost.
        self.spend_file("old", 9.99, self.NOW - 86401)
        result = self.read_at()
        self.assertAlmostEqual(result["spendWindowUsd"], 3.04)
        self.assertEqual(result["spendWindowFiles"], 2)
        self.assertEqual(result["spendWindowSkipped"], 0)
        self.assertEqual(result["spendWindowState"], "ready")
        # The session's own figures still stand beside the machine's spend.
        self.assertEqual(result["costUsd"], 12.5)

    def test_a_file_that_cannot_be_read_or_priced_is_skipped_and_counted(self):
        self.spend_file("good", 0.5, self.NOW - 60)
        broken = self.costs / "deepseek-session-broken.json"
        broken.write_text("{not json", encoding="utf-8")
        os.utime(broken, (self.NOW - 60, self.NOW - 60))
        unpriced = self.costs / "deepseek-session-unpriced.json"
        unpriced.write_text(json.dumps({"usage": {"cost": None}}), encoding="utf-8")
        os.utime(unpriced, (self.NOW - 60, self.NOW - 60))
        result = self.read_at()
        self.assertAlmostEqual(result["spendWindowUsd"], 0.5)
        self.assertEqual(result["spendWindowFiles"], 1)
        self.assertEqual(result["spendWindowSkipped"], 2)

    def test_a_file_over_the_byte_bound_is_skipped_rather_than_read(self):
        self.spend_file("good", 0.5, self.NOW - 60)
        huge = self.costs / "deepseek-session-huge.json"
        huge.write_text(json.dumps({"usage": {"cost": 8.0}, "padding": "x" * 4096}),
                        encoding="utf-8")
        os.utime(huge, (self.NOW - 60, self.NOW - 60))
        result = session_reader.read_session(
            self.config(sessionCosts=str(self.costs), limits={"jobStateBytes": 1024}),
            now=self.NOW)
        self.assertAlmostEqual(result["spendWindowUsd"], 0.5)
        self.assertEqual(result["spendWindowFiles"], 1)
        self.assertEqual(result["spendWindowSkipped"], 1)

    def test_a_window_in_which_every_file_was_skipped_has_no_figure(self):
        # A sum that lost every file is not a machine that spent nothing. The
        # card says "not reported" rather than "$0.00", and the count says why.
        broken = self.costs / "deepseek-session-broken.json"
        broken.write_text("{not json", encoding="utf-8")
        os.utime(broken, (self.NOW - 60, self.NOW - 60))
        result = self.read_at()
        self.assertNotIn("spendWindowUsd", result)
        self.assertEqual(result["spendWindowFiles"], 0)
        self.assertEqual(result["spendWindowSkipped"], 1)

    def test_a_folder_that_is_not_there_is_unavailable_never_a_zero(self):
        absent = self.root / "no-statusline-here"
        result = session_reader.read_session(
            self.config(sessionCosts=str(absent)), now=self.NOW)
        self.assertEqual(result["spendWindowState"], "unavailable")
        self.assertNotIn("spendWindowUsd", result)

    def test_an_empty_folder_is_a_proven_zero(self):
        result = self.read_at()
        self.assertEqual(result["spendWindowState"], "ready")
        self.assertEqual(result["spendWindowUsd"], 0)
        self.assertEqual(result["spendWindowFiles"], 0)
        self.assertEqual(result["spendWindowSkipped"], 0)
class CodexLimitTests(SessionCase):
    """Codex's own rate-limit windows, from the rollout it is writing."""

    def setUp(self):
        super().setUp()
        self.sessions = self.root / "codex-sessions"
        self.sessions.mkdir()

    def rollout(self, lines, name="rollout-one.jsonl", at=None):
        path = self.sessions / name
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        if at is not None:
            os.utime(path, (at, at))
        return path

    def limits_line(self, primary=None, secondary=None, credits=None):
        limits = {"limit_id": "codex"}
        if primary is not None:
            limits["primary"] = primary
        if secondary is not None:
            limits["secondary"] = secondary
        if credits is not None:
            limits["credits"] = credits
        return json.dumps({"type": "event_msg",
                           "payload": {"type": "token_count", "rate_limits": limits}})

    def read_codex(self, model="gpt-5-codex", limits=None, **statusline):
        return session_reader.read_session(
            self.config(codexSessions=str(self.sessions), limits=limits, **statusline),
            model=model)

    def test_the_newest_rollout_supplies_the_windows_and_the_credit(self):
        self.rollout([self.limits_line(
            primary={"used_percent": 1.0, "window_minutes": 300, "resets_at": 1},
            secondary={"used_percent": 2.0, "window_minutes": 10080, "resets_at": 2})],
            name="rollout-old.jsonl", at=1_000_000)
        self.rollout([self.limits_line(
            primary={"used_percent": 100.0, "window_minutes": 300, "resets_at": 1792270988},
            secondary={"used_percent": 47.0, "window_minutes": 10080, "resets_at": 1792821767},
            credits={"has_credits": True, "unlimited": False, "balance": "60924.3421900000"})],
            name="rollout-new.jsonl", at=2_000_000)
        found = self.read_codex()["limits"]
        self.assertEqual(found["state"], "ready")
        self.assertEqual(found["provider"], "codex")
        self.assertEqual(found["windows"], [
            {"name": "primary", "usedPercent": 100.0, "windowMinutes": 300,
             "resetsAt": 1792270988},
            {"name": "secondary", "usedPercent": 47.0, "windowMinutes": 10080,
             "resetsAt": 1792821767},
        ])
        self.assertAlmostEqual(found["credits"], 60924.34219)

    def test_a_half_written_final_line_is_skipped_for_the_one_before_it(self):
        # A rollout is appended to while it is read, so the last line can end
        # mid-record. That line is not a reading, and the one before it is.
        path = self.rollout([self.limits_line(
            primary={"used_percent": 61, "window_minutes": 300, "resets_at": 50})])
        with path.open("a", encoding="utf-8") as handle:
            handle.write('{"type": "event_msg", "payload": {"type": "token_c')
        found = self.read_codex()["limits"]
        self.assertEqual(found["state"], "ready")
        self.assertEqual(found["windows"][0]["usedPercent"], 61)

    def test_a_percentage_outside_the_range_is_absent_rather_than_nought(self):
        self.rollout([self.limits_line(
            primary={"used_percent": 140, "window_minutes": 300, "resets_at": 50},
            secondary={"used_percent": 47, "window_minutes": 10080})])
        windows = self.read_codex()["limits"]["windows"]
        self.assertNotIn("usedPercent", windows[0])
        self.assertEqual(windows[0]["windowMinutes"], 300)
        self.assertEqual(windows[0]["resetsAt"], 50)
        self.assertEqual(windows[1]["usedPercent"], 47)

    def test_a_missing_window_is_absent_and_the_other_still_draws(self):
        self.rollout([self.limits_line(
            secondary={"used_percent": 47, "window_minutes": 10080})])
        windows = self.read_codex()["limits"]["windows"]
        self.assertEqual([window["name"] for window in windows], ["secondary"])

    def test_a_missing_folder_is_unavailable_not_a_zeroed_window(self):
        shutil.rmtree(self.sessions)
        found = self.read_codex()["limits"]
        self.assertEqual(found["state"], "unavailable")
        self.assertNotIn("windows", found)

    def test_a_rollout_with_no_rate_limits_is_unavailable(self):
        self.rollout([json.dumps({"type": "event_msg",
                                  "payload": {"type": "token_count"}})])
        self.assertEqual(self.read_codex()["limits"]["state"], "unavailable")

    def test_a_file_over_the_byte_bound_is_read_from_its_end(self):
        # The latest line is what matters, so the bound is spent on the tail.
        filler = [json.dumps({"type": "response_item", "payload": {"pad": "x" * 80}})] * 40
        path = self.rollout(filler + [self.limits_line(
            primary={"used_percent": 88, "window_minutes": 300, "resets_at": 60})])
        self.assertGreater(path.stat().st_size, 1024)
        self.assertEqual(self.read_codex(limits={"jobStateBytes": 1024})
                         ["limits"]["windows"][0]["usedPercent"], 88)

    def test_a_line_beyond_the_byte_bound_is_not_read(self):
        path = self.rollout([self.limits_line(
            primary={"used_percent": 88, "window_minutes": 300, "resets_at": 60})]
            + [json.dumps({"type": "response_item", "payload": {"pad": "x" * 80}})] * 40)
        self.assertGreater(path.stat().st_size, 1024)
        self.assertEqual(self.read_codex(limits={"jobStateBytes": 1024})
                         ["limits"]["state"], "unavailable")

    def test_only_the_last_two_thousand_lines_are_scanned(self):
        self.rollout([self.limits_line(
            primary={"used_percent": 88, "window_minutes": 300, "resets_at": 60})]
            + [json.dumps({"type": "response_item"})] * 2100)
        self.assertEqual(self.read_codex()["limits"]["state"], "unavailable")

    def test_only_a_codex_model_gets_codex_windows(self):
        self.rollout([self.limits_line(
            primary={"used_percent": 88, "window_minutes": 300, "resets_at": 60})])
        for model in ("claude-opus-5-5", "deepseek-flash[1m]", "kimi-k2", ""):
            self.assertIsNone(self.read_codex(model=model)["limits"], model)
        self.assertIsNotNone(self.read_codex(model="codex-5")["limits"])

    def test_a_credit_is_reported_only_when_it_is_a_balance(self):
        self.rollout([self.limits_line(
            primary={"used_percent": 10, "window_minutes": 300, "resets_at": 60},
            credits={"has_credits": False, "unlimited": False, "balance": "5"})])
        self.assertNotIn("credits", self.read_codex()["limits"])
        self.rollout([self.limits_line(
            primary={"used_percent": 10, "window_minutes": 300, "resets_at": 60},
            credits={"has_credits": True, "unlimited": True, "balance": "5"})])
        self.assertNotIn("credits", self.read_codex()["limits"])


if __name__ == "__main__":
    unittest.main()
