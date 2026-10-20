#!/usr/bin/env python3
"""The pacer reader: the machine's run slots, read through pacer's own status.

Every case runs a real stub command that prints what `pacer.py status --json`
prints, so the reader is held to the same contract the tool keeps: the switch,
each slot and who holds it, and, from the version that records them, the
callers waiting for a slot and the runs that finished. A field the tool did not
send is reported as not sent rather than as nothing, and a command that fails
in any way is a failed source, never an idle machine.
"""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from config.loader import load_config
from readers import pacer

# A stand-in for pacer.py: prints the scenario file's status, records the words
# it was given, and for `on` or `off` writes the switch into the scenario first.
STUB = """\
import json, sys
scenario_path, words = sys.argv[1], sys.argv[2:]
with open(scenario_path + ".calls", "a", encoding="utf-8") as calls:
    calls.write(json.dumps(words) + "\\n")
scenario = json.load(open(scenario_path, encoding="utf-8"))
if scenario.get("exit"):
    if scenario.get("stderr_hex"):
        sys.stderr.buffer.write(bytes.fromhex(scenario["stderr_hex"]))
    else:
        sys.stderr.write(scenario.get("stderr", "pacer: refused"))
    sys.exit(scenario["exit"])
if scenario.get("sleep"):
    import time
    time.sleep(scenario["sleep"])
if words and words[0] in ("on", "off"):
    scenario["status"]["enabled"] = words[0] == "on"
    json.dump(scenario, open(scenario_path, "w", encoding="utf-8"))
sys.stdout.write(scenario.get("raw") or json.dumps(scenario["status"]))
"""

HOLDER = {"pid": 4242, "repo": "llm-fleet-private", "started_at": "2026-10-20T10:00:00Z"}
STARTED = 1792490400.0  # 2026-10-20T10:00:00Z


def status(**overrides) -> dict:
    document = {
        "enabled": True, "source": "missing", "reason": "no switch file",
        "path": "/state/pacer-switch.json",
        "config": {"slots": 4, "workers_per_run": 6, "qos": "utility", "nice": 10},
        "slots": [{"slot": 0, "busy": True, "holder": HOLDER},
                  {"slot": 1, "busy": False, "holder": None},
                  {"slot": 2, "busy": False, "holder": None},
                  {"slot": 3, "busy": False, "holder": None}],
    }
    document.update(overrides)
    return document


class PacerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.stub = self.root / "pacer_stub.py"
        self.stub.write_text(STUB, encoding="utf-8")
        self.scenario = self.root / "scenario.json"

    def tearDown(self) -> None:
        self.directory.cleanup()

    def given(self, **scenario) -> None:
        scenario.setdefault("status", status())
        self.scenario.write_text(json.dumps(scenario), encoding="utf-8")

    def calls(self) -> list[list[str]]:
        log = Path(str(self.scenario) + ".calls")
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    def config(self, enabled: bool = True, command: object = "stub", seconds: int = 8) -> dict:
        document: dict = {"stateDir": str(self.root / "state"),
                          "timeouts": {"commandSeconds": seconds},
                          "sources": {"pacer": {"enabled": enabled}}}
        if command == "stub":
            command = [sys.executable, str(self.stub), str(self.scenario)]
        if command is not None:
            document["sources"]["pacer"]["command"] = command
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(str(path), environ={**os.environ, "HOME": str(self.root / "user")})

    def read(self, **options) -> dict:
        return pacer.read_pacer(self.config(**options))


class StateTests(PacerCase):
    def test_a_source_switched_off_reads_nothing_and_runs_nothing(self):
        self.given()
        result = self.read(enabled=False)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(result["slots"], [])
        self.assertEqual(self.calls(), [])

    def test_a_source_switched_on_without_a_command_is_refused_by_name(self):
        # Like every other source, switching it on means naming what to read.
        from config.loader import ConfigError
        with self.assertRaises(ConfigError) as caught:
            self.config(command=None)
        self.assertIn("sources.pacer.command", str(caught.exception))

    def test_the_packaged_default_reads_nothing(self):
        # Pacer is tooling a person may not run, so the stock install has it off.
        config = load_config(None, environ={"HOME": str(self.root / "user")})
        result = pacer.read_pacer(config)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(result["slots"], [])

    def test_a_document_that_names_no_command_is_unconfigured(self):
        # A caller that hands over a source with no command gets nothing run.
        config = dict(self.config())
        config["sources"] = dict(config["sources"], pacer={"enabled": True, "command": None})
        result = pacer.read_pacer(config)
        self.assertEqual(result["state"], "unconfigured")
        self.assertEqual(result["errors"], [])

    def test_a_command_that_is_not_on_the_path_is_unavailable_and_named(self):
        result = self.read(command=["pacer-that-is-not-installed-anywhere"])
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["slots"], [])
        self.assertIn("not on PATH", result["errors"][0]["reason"])

    def test_the_status_is_asked_for_as_json(self):
        self.given()
        self.read()
        self.assertEqual(self.calls(), [["status", "--json"]])


class ReadyTests(PacerCase):
    def test_each_slot_is_read_with_who_holds_it_and_since_when(self):
        self.given()
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["slotCount"], 4)
        self.assertEqual(result["workersPerRun"], 6)
        self.assertEqual(result["slots"][0], {"slot": 0, "busy": True, "pid": 4242,
                                              "repo": "llm-fleet-private",
                                              "startedAt": STARTED})
        self.assertEqual(result["slots"][1], {"slot": 1, "busy": False, "pid": None,
                                              "repo": None, "startedAt": None})
        self.assertEqual(sum(1 for slot in result["slots"] if slot["busy"]), 1)

    def test_the_switch_is_read_with_where_its_answer_came_from(self):
        self.given(status=status(enabled=False, source="file", reason="switched off"))
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertIs(result["enabled"], False)
        self.assertEqual(result["switchSource"], "file")
        self.assertEqual(result["reason"], "switched off")

    def test_waiting_and_recent_runs_not_sent_are_named_as_not_sent(self):
        # The first pacer keeps no record of a caller waiting for a slot. A
        # count of nought would say nobody waits, which nobody measured.
        self.given()
        result = self.read()
        self.assertIsNone(result["waiting"])
        self.assertIsNone(result["recent"])
        self.assertIsNone(result["version"])

    def test_waiting_callers_and_recent_runs_are_read_when_sent(self):
        self.given(status=status(
            version=1,
            waiting=[{"pid": 7, "repo": "shared-tools", "since": "2026-10-20T10:05:00Z"}],
            recent=[{"ts": "2026-10-20T09:59:00Z", "repo": "shared-tools", "wait_s": 12.5,
                     "run_s": 300.0, "exit": 0, "slot": 2, "mode": "on"},
                    {"ts": "2026-10-20T09:50:00Z", "repo": "web-app", "wait_s": 0.0,
                     "run_s": None, "exit": 75, "slot": None, "mode": "refused",
                     "reason": "memory pressure"}]))
        result = self.read()
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["waiting"], [{"pid": 7, "repo": "shared-tools",
                                              "since": STARTED + 300}])
        self.assertEqual(result["recent"][0], {
            "at": STARTED - 60, "repo": "shared-tools", "waitSeconds": 12.5,
            "runSeconds": 300.0, "exit": 0, "slot": 2, "mode": "on", "reason": None})
        self.assertEqual(result["recent"][1]["mode"], "refused")
        self.assertEqual(result["recent"][1]["reason"], "memory pressure")
        self.assertIsNone(result["recent"][1]["runSeconds"])

    def test_a_run_record_missing_its_exit_or_time_is_dropped_not_guessed(self):
        self.given(status=status(recent=[
            {"ts": "2026-10-20T09:59:00Z", "repo": "a", "wait_s": 1, "run_s": 2, "mode": "on"},
            {"repo": "b", "wait_s": 1, "run_s": 2, "exit": 0, "mode": "on"},
            {"ts": "yesterday", "repo": "c", "wait_s": 1, "run_s": 2, "exit": 0, "mode": "on"},
            {"ts": "2026-10-20T09:59:00Z", "repo": "d", "wait_s": 1, "run_s": 2, "exit": 1,
             "mode": "on"}]))
        result = self.read()
        self.assertEqual([run["repo"] for run in result["recent"]], ["d"])
        self.assertEqual(result["recent"][0]["exit"], 1)

    def test_a_busy_slot_whose_holder_is_damaged_stays_busy_with_no_holder(self):
        # The lock decides busy, not the file text: a holder that cannot be read
        # leaves the slot taken by somebody nobody can name.
        self.given(status=status(slots=[
            {"slot": 0, "busy": True, "holder": "garbage"},
            {"slot": 1, "busy": True, "holder": {"pid": "x", "repo": 5, "started_at": "soon"}}],
            config={"slots": 2, "workers_per_run": 6}))
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertEqual([slot["busy"] for slot in result["slots"]], [True, True])
        self.assertEqual([slot["repo"] for slot in result["slots"]], [None, None])
        self.assertEqual([slot["startedAt"] for slot in result["slots"]], [None, None])

    def test_a_free_slot_names_no_holder_even_when_one_was_left_behind(self):
        self.given(status=status(slots=[
            {"slot": 0, "busy": False, "holder": HOLDER},
            {"slot": 1, "busy": False, "holder": None}],
            config={"slots": 2, "workers_per_run": 6}))
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertEqual([(slot["pid"], slot["repo"], slot["startedAt"]) for slot in result["slots"]],
                         [(None, None, None), (None, None, None)])

    def test_slots_listed_out_of_order_come_back_in_order(self):
        self.given(status=status(slots=[
            {"slot": 2, "busy": False, "holder": None},
            {"slot": 0, "busy": True, "holder": HOLDER},
            {"slot": 1, "busy": False, "holder": None}],
            config={"slots": 3, "workers_per_run": 6}))
        result = self.read()
        self.assertEqual([slot["slot"] for slot in result["slots"]], [0, 1, 2])
        self.assertEqual([slot["busy"] for slot in result["slots"]], [True, False, False])

    def test_a_time_with_no_zone_is_not_placed(self):
        self.given(status=status(slots=[
            {"slot": 0, "busy": True, "holder": {**HOLDER, "started_at": "2026-10-20T10:00:00"}}],
            config={"slots": 1, "workers_per_run": 6}))
        result = self.read()
        self.assertEqual(result["slots"][0]["repo"], HOLDER["repo"])
        self.assertIsNone(result["slots"][0]["startedAt"])

    def test_a_switch_source_pacer_does_not_name_is_not_passed_on(self):
        self.given(status=status(source="somewhere"))
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertIsNone(result["switchSource"])

    def test_a_waiter_with_no_time_is_dropped_not_placed(self):
        self.given(status=status(waiting=[{"pid": 1, "repo": "a"},
                                          {"pid": 2, "repo": "b", "since": "2026-10-20T10:00:00Z"}]))
        result = self.read()
        self.assertEqual([caller["repo"] for caller in result["waiting"]], ["b"])

    def test_text_the_tool_sends_is_cut_and_masked_like_any_command_output(self):
        long_repo = "r" * 500
        self.given(status=status(slots=[{"slot": 0, "busy": True,
                                         "holder": {**HOLDER, "repo": long_repo}}],
                                 config={"slots": 1, "workers_per_run": 6}))
        result = self.read()
        self.assertLessEqual(len(result["slots"][0]["repo"]), 200)


class FailureTests(PacerCase):
    def test_a_command_that_exits_nonzero_is_failed_with_its_exit(self):
        self.given(exit=3)
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["slots"], [])
        self.assertIn("exit 3", result["errors"][0]["reason"])

    def test_output_that_is_not_json_is_failed(self):
        self.given(raw="pacer: waiting for a slot")
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertIn("not JSON", result["errors"][0]["reason"])

    def test_a_document_without_slots_or_switch_is_failed_by_name(self):
        for broken, word in ((status(slots="none"), "slots"),
                             (status(enabled="yes"), "enabled"),
                             (status(config={"slots": "four"}), "slots"),
                             ([1, 2], "object")):
            with self.subTest(word=word):
                self.given(status=broken)
                result = self.read()
                self.assertEqual(result["state"], "failed")
                self.assertIn(word, result["errors"][0]["reason"])

    def test_a_slot_the_reader_cannot_read_fails_the_count_rather_than_freeing_it(self):
        # A dropped slot would read as one more free slot than the machine has.
        damaged = status()
        damaged["slots"][2] = {"slot": "two", "busy": True}
        unlisted = status()
        unlisted["slots"] = unlisted["slots"][:3]
        for broken, word in ((damaged, "cannot read"), (unlisted, "3 of 4")):
            with self.subTest(word=word):
                self.given(status=broken)
                result = self.read()
                self.assertEqual(result["state"], "failed")
                self.assertIn(word, result["errors"][0]["reason"])
                self.assertEqual(result["slots"], [])

    def test_more_slots_than_a_machine_has_is_failed(self):
        many = [{"slot": number, "busy": False, "holder": None}
                for number in range(pacer.MAX_SLOTS + 1)]
        self.given(status=status(slots=many, config={"slots": pacer.MAX_SLOTS + 1}))
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertIn("slots", result["errors"][0]["reason"])

    def test_a_command_that_overruns_its_timeout_is_failed_not_waited_on(self):
        self.given(sleep=5)
        result = self.read(seconds=1)
        self.assertEqual(result["state"], "failed")
        self.assertIn("timed out", result["errors"][0]["reason"])


class SwitchTests(PacerCase):
    def test_switching_off_runs_the_command_with_off_and_reads_the_answer(self):
        self.given()
        result = pacer.set_pacer(self.config(), False)
        self.assertEqual(result["state"], "ready")
        self.assertIs(result["enabled"], False)
        self.assertEqual(self.calls()[0], ["off"])

    def test_switching_on_says_on(self):
        self.given(status=status(enabled=False, source="file"))
        result = pacer.set_pacer(self.config(), True)
        self.assertIs(result["enabled"], True)
        self.assertEqual(self.calls()[0], ["on"])

    def test_a_switch_the_command_refuses_is_failed_with_its_words(self):
        self.given(exit=1, stderr="cannot write the switch file")
        result = pacer.set_pacer(self.config(), False)
        self.assertEqual(result["state"], "failed")
        self.assertIn("cannot write the switch file", result["errors"][0]["reason"])

    def test_a_refusal_in_bytes_that_are_not_text_is_still_said(self):
        self.given(exit=2, stderr_hex="ff6e6f207772697465")
        result = pacer.set_pacer(self.config(), False)
        self.assertEqual(result["state"], "failed")
        self.assertIn("no write", result["errors"][0]["reason"])
        self.assertEqual(self.calls()[0], ["off"])

    def test_the_switch_and_the_read_after_it_share_one_time_limit(self):
        # Each call takes most of the limit, so a read given a limit of its own
        # would answer after the caller stopped waiting for the switch.
        self.given(sleep=1.2)
        result = pacer.set_pacer(self.config(seconds=2), False)
        self.assertEqual(result["state"], "failed")
        self.assertIn("switched off", result["errors"][0]["reason"])
        self.assertEqual(self.calls(), [["off"], ["status", "--json"]])

    def test_a_switch_that_never_answers_is_failed_in_time(self):
        self.given(sleep=5)
        result = pacer.set_pacer(self.config(seconds=1), False)
        self.assertEqual(result["state"], "failed")
        self.assertIn("did not answer in time", result["errors"][0]["reason"])

    def test_a_refusal_that_says_nothing_is_still_a_refusal(self):
        self.given(exit=1, stderr="")
        result = pacer.set_pacer(self.config(), False)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["errors"][0]["reason"], "the switch refused it")

    def test_the_command_line_exits_nonzero_only_when_a_switch_failed(self):
        path = self.root / "config.json"
        self.config()
        self.given(exit=1, stderr="cannot write the switch file")
        self.assertEqual(pacer.main(["--config", str(path), "--set", "off"]), 1)
        # A read that failed is a document to draw, not a failed command.
        self.assertEqual(pacer.main(["--config", str(path)]), 0)
        self.given()
        self.assertEqual(pacer.main(["--config", str(path), "--set", "off"]), 0)

    def test_a_source_switched_off_moves_no_switch(self):
        self.given()
        result = pacer.set_pacer(self.config(enabled=False), False)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
