#!/usr/bin/env python3
"""Reader behavior, driven through real commands and real files.

Every case here runs the reader against a stub executable and a real job folder
on disk, so the assertions are about observed behavior rather than about a
mock's idea of it. Provider homes are directories the test creates, which is
what makes a provider ready in the first place.
"""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import ConfigError, load_config
from readers import jobs, runtime, roster


STUB = '''\
import json, os, sys, time
from pathlib import Path

home = Path(os.environ.get("CLAUDE_CONFIG_DIR", ""))
(home / "seen.json").write_text(json.dumps({
    "argv": sys.argv[1:],
    "environment": sorted(os.environ),
}), encoding="utf-8")
mode = (home / "mode.txt").read_text(encoding="utf-8").strip() \\
    if (home / "mode.txt").exists() else "rows"
if mode == "fail":
    sys.exit(3)
if mode == "garbage":
    print("{ not json")
    sys.exit(0)
if mode == "notalist":
    print(json.dumps({"rows": []}))
    sys.exit(0)
if mode == "sleep":
    time.sleep(30)
rows = home / "rows.json"
print(rows.read_text(encoding="utf-8") if rows.exists() else "[]")
'''

CREDENTIALS = {"ANTHROPIC_API_KEY": "sentinel-not-a-key", "ANTHROPIC_BASE_URL": "http://example.invalid",
               "DEEPSEEK_API_KEY": "sentinel-not-a-key", "KIMI_API_KEY": "sentinel-not-a-key",
               "OPENAI_API_KEY": "sentinel-not-a-key"}


def provider_row(identifier, kind="background", state="working", **extra):
    row = {"id": identifier, "kind": kind, "name": identifier, "state": state,
           "cwd": "/tmp/work", "startedAt": 1_700_000_000_000, "sessionId": "s-" + identifier}
    row.update(extra)
    return row


class ReaderCase(unittest.TestCase):
    """A temporary tree with two provider homes, a stub command, and a config."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-readers-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.stub = self.root / "stub.py"
        self.stub.write_text(STUB, encoding="utf-8")
        self.primary = self.home("primary")
        self.secondary = self.home("secondary")

    def home(self, name):
        directory = self.root / "homes" / name
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def rows(self, home, rows, mode=None):
        (home / "rows.json").write_text(json.dumps(rows), encoding="utf-8")
        if mode is not None:
            (home / "mode.txt").write_text(mode, encoding="utf-8")
        return home

    def config(self, document, environ=None):
        path = self.root / "config.json"
        document = {"commands": {"claude": [sys.executable, str(self.stub)]}, **document}
        path.write_text(json.dumps(document), encoding="utf-8")
        if environ is None:
            environ = sandbox.home_environment(self.root)
        return load_config(path, environ=environ)

    def environment(self, **extra):
        return sandbox.home_environment(self.root, **extra)

    def homes(self, *names):
        return [{"id": name, "home": str(getattr(self, name))} for name in names]

    def seen(self, home):
        return json.loads((home / "seen.json").read_text(encoding="utf-8"))


class RosterWindowTests(ReaderCase):
    """How long one roster answer may stand, and what is never kept.

    The roster is nearly the whole cost of a steady read: one command per
    provider home, and there is no cheaper way to ask. A person may say how
    long an answer may stand; the packaged default says not at all.
    """

    def test_a_kept_roster_answers_the_next_read_until_its_window_passes(self):
        self.rows(self.primary, [provider_row("one", state="working")])
        config = self.config({"providers": self.homes("primary"),
                              "cache": {"rosterSeconds": 60}})
        first = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        self.assertEqual([job["id"] for job in first["jobs"]], ["one"])
        # The machine answers differently. Inside the window the kept answer is
        # still the one drawn, and the command is not run again.
        self.rows(self.primary, [provider_row("two", state="working")])
        kept = roster.read_providers(config, environ=self.environment(), now=1_700_000_130.0)
        self.assertEqual([job["id"] for job in kept["jobs"]], ["one"])
        self.assertEqual(kept["state"], "ready")
        # Past the window the read runs again and the new answer is drawn.
        after = roster.read_providers(config, environ=self.environment(), now=1_700_000_161.0)
        self.assertEqual([job["id"] for job in after["jobs"]], ["two"])

    def test_the_packaged_window_keeps_no_roster_at_all(self):
        self.rows(self.primary, [provider_row("one", state="working")])
        config = self.config({"providers": self.homes("primary")})
        roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        self.rows(self.primary, [provider_row("two", state="working")])
        again = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.5)
        self.assertEqual([job["id"] for job in again["jobs"]], ["two"])
        # Nothing was written to be looked at either: a record no read will
        # read is a cost with no answer bought by it.
        self.assertEqual(list(Path(config["stateDir"]).glob("roster.json")), [])

    def test_a_failed_read_is_never_the_kept_answer(self):
        # A failure kept for a minute is a session told its machine is broken
        # long after it stopped being: only an answer is kept.
        self.rows(self.primary, [], mode="fail")
        config = self.config({"providers": self.homes("primary"),
                              "cache": {"rosterSeconds": 60}})
        broken = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        self.assertEqual(broken["state"], "failed")
        # The command answers again a second later, and the read asks it rather
        # than serving the failure out of the window.
        self.rows(self.primary, [provider_row("two", state="working")], mode="rows")
        again = roster.read_providers(config, environ=self.environment(), now=1_700_000_101.0)
        self.assertEqual(again["state"], "ready")
        self.assertEqual([job["id"] for job in again["jobs"]], ["two"])

    def test_a_kept_answer_never_outlives_a_clock_that_stepped_back(self):
        # A kept answer dated after the read that finds it is not fresh: the
        # clock moved, and the window is measured forward from what was kept.
        self.rows(self.primary, [provider_row("one", state="working")])
        config = self.config({"providers": self.homes("primary"),
                              "cache": {"rosterSeconds": 60}})
        roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        self.rows(self.primary, [provider_row("two", state="working")])
        back = roster.read_providers(config, environ=self.environment(), now=1_700_000_099.0)
        self.assertEqual([job["id"] for job in back["jobs"]], ["two"])


class ReadingTests(ReaderCase):
    def test_rows_are_read_sorted_and_labeled(self):
        self.rows(self.primary, [provider_row("idle-one", state="idle"),
                                 provider_row("blocked-one", state="blocked"),
                                 provider_row("working-one", state="working")])
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        self.assertEqual(result["state"], "ready")
        self.assertEqual([job["id"] for job in result["jobs"]],
                         ["blocked-one", "working-one", "idle-one"])
        self.assertEqual(result["jobs"][0]["label"], "primary")
        self.assertEqual(result["providers"]["primary"], {"state": "ready", "reason": None})
        self.assertEqual(result["sources"], {"jobs": "ready", "interactive": "ready"})

    def test_a_waiting_job_carries_the_hash_of_its_whole_question(self):
        self.rows(self.primary, [provider_row("asks", state="blocked"),
                                 provider_row("works", state="working")])
        whole = "Which of these should go first? " + "x" * 300
        for job_id in ("asks", "works"):
            folder = self.primary / "jobs" / job_id
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "state.json").write_text(json.dumps({"needs": whole}), encoding="utf-8")
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        hashes = {job["id"]: job["needs_hash"] for job in result["jobs"]}
        self.assertEqual(hashes["asks"], jobs.question_digest(whole))
        # Only a waiting job is asked anything.
        self.assertEqual(hashes["works"], None)

    def test_a_waiting_job_carries_where_its_reply_stands(self):
        from readers import alerts
        self.rows(self.primary, [provider_row("asks", state="blocked"),
                                 provider_row("quiet", state="blocked")])
        for job_id in ("asks", "quiet"):
            folder = self.primary / "jobs" / job_id
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "state.json").write_text(
                json.dumps({"needs": "Go?", "sessionId": "s-" + job_id}), encoding="utf-8")
        config = self.config({"providers": self.homes("primary"),
                              "stateDir": str(self.root / "state")})
        asked = alerts.question(config, "primary", "asks", holder="pane-a", now=1_700_000_050.0)
        self.assertEqual(asked["held"], True)

        def replies():
            result = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
            return {job["id"]: job["reply"] for job in result["jobs"]}

        self.assertEqual(replies(), {"asks": {"state": "pending", "at": 1_700_000_050.0},
                                     "quiet": None})
        state = alerts.state_root(Path(config["stateDir"]))
        self.assertTrue(alerts.confirm_reply(state, "primary", "asks", "s-asks",
                                             jobs.question_digest("Go?"), "pane-a", 1_700_000_060.0))
        self.assertEqual(replies()["asks"], {"state": "sent", "at": 1_700_000_050.0})
        # A marker cut short, by a disk or by an older helper killed mid-write,
        # is a state of its own, never no reply.
        marker = alerts.reply_marker_path(state, "primary", "asks", "s-asks", jobs.question_digest("Go?"))
        marker.write_text('{"state": "pen')
        seen = replies()
        self.assertEqual(seen["quiet"], None)
        self.assertEqual((seen["asks"]["state"], seen["asks"]["at"]), ("unreadable", None))
        # It names that very file, so a pane that cleared one still shows the next.
        info = marker.stat()
        self.assertEqual(seen["asks"]["id"], "{0}-{1}".format(info.st_ino, info.st_mtime_ns))

    def test_each_job_carries_the_line_that_opens_it_in_its_own_home(self):
        spaced = self.home("with space")
        self.rows(self.primary, [provider_row("one")])
        self.rows(spaced, [provider_row("it's")])
        config = self.config({"providers": [{"id": "primary", "home": str(self.primary)},
                                            {"id": "spaced", "home": str(spaced)}]})
        result = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        commands = {job["id"]: job["attach_command"] for job in result["jobs"]}
        launcher = " ".join(shlex.quote(part) for part in (sys.executable, str(self.stub)))
        self.assertEqual(commands["one"], "CLAUDE_CONFIG_DIR={0} {1} attach one".format(
            shlex.quote(str(self.primary)), launcher))
        # A home and an identifier holding a space or a quote stay one word each.
        self.assertEqual(commands["it's"], "CLAUDE_CONFIG_DIR={0} {1} attach {2}".format(
            shlex.quote(str(spaced)), launcher, shlex.quote("it's")))
        self.assertEqual(shlex.split(commands["it's"])[-1], "it's")
        self.assertEqual(roster.attach_command(["claude"], self.primary, ""), None)

    def test_every_ready_home_is_read_once_with_its_own_configuration_directory(self):
        self.rows(self.primary, [provider_row("one")])
        self.rows(self.secondary, [provider_row("two")])
        config = self.config({"providers": self.homes("primary", "secondary")})
        result = roster.read_providers(config, environ=self.environment(), now=1_700_000_100.0)
        self.assertEqual(sorted(job["id"] for job in result["jobs"]), ["one", "two"])
        self.assertEqual(self.seen(self.primary)["argv"], ["agents", "--json", "--all"])
        self.assertEqual((self.secondary / "seen.json").exists(), True)

    def test_an_empty_read_is_empty_and_not_failed(self):
        self.rows(self.primary, [])
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["jobs"], [])
        self.assertEqual(result["errors"], [])

    def test_a_failed_read_is_reported_as_failed_with_its_reason(self):
        self.rows(self.primary, [], mode="fail")
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["providers"]["primary"],
                         {"state": "failed", "reason": "exit 3"})
        self.assertEqual(result["errors"], [{"source": "jobs:primary", "reason": "exit 3"}])

    def test_a_failing_home_does_not_hide_a_home_that_answered(self):
        self.rows(self.primary, [], mode="fail")
        self.rows(self.secondary, [provider_row("two")])
        config = self.config({"providers": self.homes("primary", "secondary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "ready")
        self.assertEqual([job["id"] for job in result["jobs"]], ["two"])
        self.assertEqual(len(result["errors"]), 1)

    def test_output_that_is_not_json_is_a_failure(self):
        self.rows(self.primary, [], mode="garbage")
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["providers"]["primary"]["reason"], "output was not JSON")

    def test_output_that_is_not_a_list_of_rows_is_a_failure(self):
        self.rows(self.primary, [], mode="notalist")
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["providers"]["primary"]["reason"], "not a list")

    def test_a_read_that_overruns_its_timeout_is_a_failure(self):
        self.rows(self.primary, [], mode="sleep")
        config = self.config({"providers": self.homes("primary"),
                              "timeouts": {"commandSeconds": 1}})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["providers"]["primary"]["reason"], "timed out after 1s")

    def test_interactive_sessions_are_counted_by_provider(self):
        self.rows(self.primary, [provider_row("one", kind="interactive"),
                                 provider_row("two", kind="interactive"),
                                 provider_row("three")])
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["interactive"], {"primary": 2})
        self.assertEqual([job["id"] for job in result["jobs"]], ["three"])

    def test_a_working_directory_under_the_provider_home_is_folded(self):
        self.rows(self.primary, [provider_row("one", cwd=str(self.primary / "work" / "app"))])
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["jobs"][0]["cwd"], os.path.join("~", "work", "app"))

    def test_a_provider_row_without_a_usable_identity_still_reads(self):
        self.rows(self.primary, [{"kind": "background", "cwd": None},
                                 "not a row", 17])
        config = self.config({"providers": self.homes("primary")})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(len(result["jobs"]), 1)
        self.assertEqual(result["jobs"][0]["name"], "unnamed")


class StateTests(ReaderCase):
    def test_a_disabled_source_is_never_probed(self):
        self.rows(self.primary, [provider_row("one")])
        config = self.config({"providers": self.homes("primary"),
                              "sources": {"jobs": {"enabled": False},
                                          "interactive": {"enabled": False}}})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(result["sources"], {"jobs": "disabled", "interactive": "disabled"})
        self.assertEqual((self.primary / "seen.json").exists(), False)

    def test_one_disabled_source_does_not_disable_the_other(self):
        self.rows(self.primary, [provider_row("one")])
        config = self.config({"providers": self.homes("primary"),
                              "sources": {"jobs": {"enabled": False}}})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["sources"], {"jobs": "disabled", "interactive": "ready"})

    def test_a_command_that_is_not_on_the_path_reads_unavailable(self):
        self.rows(self.primary, [provider_row("one")])
        config = self.config({"providers": self.homes("primary"),
                              "commands": {"claude": ["fleet-absent-command"]}})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["errors"],
                         [{"source": "jobs", "reason": "fleet-absent-command is not on PATH"}])
        self.assertEqual((self.primary / "seen.json").exists(), False)

    def test_no_ready_home_reads_unavailable(self):
        config = self.config({"providers": [{"id": "primary",
                                             "home": str(self.root / "homes" / "absent")}]})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["providers"]["primary"]["state"], "unavailable")
        self.assertEqual(result["errors"],
                         [{"source": "jobs", "reason": "no provider home is ready to read"}])

    def test_a_disabled_provider_is_reported_without_being_read(self):
        config = self.config({"providers": [{"id": "off", "enabled": False,
                                             "home": str(self.secondary)}]})
        result = roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(result["providers"]["off"]["state"], "disabled")
        self.assertEqual((self.secondary / "seen.json").exists(), False)


class EnvironmentTests(ReaderCase):
    def test_a_child_never_inherits_a_provider_credential(self):
        self.rows(self.primary, [])
        config = self.config({"providers": self.homes("primary")})
        environ = self.environment(**CREDENTIALS)
        roster.read_providers(config, environ=environ, now=1.0)
        seen = set(self.seen(self.primary)["environment"])
        self.assertEqual(seen & set(CREDENTIALS), set())
        self.assertIn("CLAUDE_CONFIG_DIR", seen)

    def test_the_stripped_sets_may_be_extended_by_configuration(self):
        self.rows(self.primary, [])
        config = self.config({"providers": self.homes("primary"),
                              "runtime": {"childEnvironment": {
                                  "stripNames": ["DEEPSEEK_API_KEY", "KIMI_API_KEY",
                                                 "OPENAI_API_KEY", "FLEET_EXTRA"]}}})
        roster.read_providers(config, environ=self.environment(FLEET_EXTRA="sentinel",
                                                               OTHER="kept"), now=1.0)
        seen = set(self.seen(self.primary)["environment"])
        self.assertNotIn("FLEET_EXTRA", seen)
        self.assertIn("OTHER", seen)

    def test_the_credential_baseline_cannot_be_weakened(self):
        with self.assertRaises(ConfigError) as caught:
            self.config({"runtime": {"childEnvironment": {"stripNames": ["ONLY_THIS"]}}})
        self.assertEqual([(entry["code"], entry["path"]) for entry in caught.exception.errors],
                         [("E_CONFIG_RULE", "runtime.childEnvironment.stripNames")])

    def test_an_unknown_environment_key_is_refused(self):
        with self.assertRaises(ConfigError) as caught:
            self.config({"runtime": {"childEnvironment": {"strip": []}}})
        self.assertEqual([entry["path"] for entry in caught.exception.errors],
                         ["runtime.childEnvironment.strip"])


class JobFileTests(ReaderCase):
    def state(self, home, job_id, document):
        folder = Path(home) / "jobs" / job_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").write_text(json.dumps(document), encoding="utf-8")
        return folder

    def limits(self, characters=200, state_bytes=65536):
        return {"questionCharacters": characters, "jobStateBytes": state_bytes}

    def test_a_waiting_job_carries_its_question_and_suggested_reply(self):
        self.state(self.primary, "waiting", {"needs": "Deploy?\x07", "suggestedReply": " yes "})
        question, reply, digest = jobs.job_question(self.primary, "waiting", self.limits())
        self.assertEqual(question, "Deploy?")
        self.assertEqual(reply, "yes")
        self.assertEqual(digest, hashlib.sha256("Deploy?\x07".encode("utf-8")).hexdigest())

    def test_the_question_is_known_by_a_hash_of_all_of_it(self):
        # Two questions that share the part a row draws are still two questions.
        shared = "q" * 200
        self.state(self.primary, "first", {"needs": shared + " merge the first branch?"})
        self.state(self.primary, "second", {"needs": shared + " merge the second branch?"})
        first = jobs.job_question(self.primary, "first", self.limits(characters=200))
        second = jobs.job_question(self.primary, "second", self.limits(characters=200))
        self.assertEqual(first[0], second[0])
        self.assertNotEqual(first[2], second[2])
        self.assertEqual(first[2], hashlib.sha256(
            (shared + " merge the first branch?").encode("utf-8")).hexdigest())
        # Line endings are the one thing made alike; nothing else is.
        self.assertEqual(jobs.question_digest("a\r\nb"), jobs.question_digest("a\nb"))
        self.assertEqual(jobs.question_digest("a\rb"), jobs.question_digest("a\nb"))
        self.assertNotEqual(jobs.question_digest("a b"), jobs.question_digest("a  b"))
        self.assertNotEqual(jobs.question_digest(" a"), jobs.question_digest("a"))
        self.assertEqual(jobs.question_digest(None), None)
        self.assertEqual(jobs.question_digest(12), None)
        # A question holding a lone surrogate still has a hash rather than an error.
        self.assertEqual(len(jobs.question_digest("\ud800 odd") or ""), 64)

    def test_a_question_longer_than_the_limit_is_cut(self):
        self.state(self.primary, "waiting", {"needs": "abcdefghij"})
        question, _, _ = jobs.job_question(self.primary, "waiting", self.limits(characters=4))
        self.assertEqual(question, "abcd")

    def test_detail_and_fan_entries_are_kept_and_malformed_entries_dropped(self):
        self.state(self.primary, "busy", {
            "detail": "reading config",
            "fan": [{"kind": "tool", "label": "Read", "startedAt": 1, "doneAt": 2},
                    {"kind": "tool"}, {"label": "no kind"}, "not an entry",
                    {"kind": "tool", "label": "Bash", "startedAt": True}]})
        detail, fan = jobs.job_activity(self.primary, "busy", self.limits())
        self.assertEqual(detail, "reading config")
        self.assertEqual(fan, [{"kind": "tool", "label": "Read", "startedAt": 1, "doneAt": 2},
                               {"kind": "tool", "label": "Bash"}])

    def test_an_identifier_that_could_climb_out_of_the_home_is_refused(self):
        self.assertEqual(jobs.state_file(self.primary, "../escape"), None)
        self.assertEqual(jobs.state_file(self.primary, "with/slash"), None)
        self.assertEqual(jobs.state_file(self.primary, "ok-1_A"), self.primary / "jobs" / "ok-1_A"
                         / "state.json")
        self.assertEqual(jobs.read_job_state(self.primary, "../escape", 1024), None)
        self.assertEqual(jobs.job_question(self.primary, None, self.limits()),
                         (None, None, None))

    def test_a_state_file_that_is_not_a_regular_file_is_not_read(self):
        folder = Path(self.primary) / "jobs" / "odd"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").mkdir()
        self.assertEqual(jobs.read_job_state(self.primary, "odd", 1024), None)

    def test_a_state_file_larger_than_its_bound_is_not_read(self):
        self.state(self.primary, "big", {"needs": "x" * 400})
        self.assertEqual(jobs.read_job_state(self.primary, "big", 64), None)
        self.assertEqual(jobs.read_job_state(self.primary, "big", 4096), {"needs": "x" * 400})

    def test_a_linked_state_file_is_not_followed(self):
        target = self.root / "outside.json"
        target.write_text(json.dumps({"needs": "escape"}), encoding="utf-8")
        folder = Path(self.primary) / "jobs" / "linked"
        folder.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(target, folder / "state.json")
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("this platform does not allow creating a symbolic link here")
        self.assertEqual(jobs.read_job_state(self.primary, "linked", 4096), None)

    def test_a_state_file_that_is_not_json_is_not_read(self):
        folder = Path(self.primary) / "jobs" / "broken"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").write_text("{ not json", encoding="utf-8")
        self.assertEqual(jobs.read_job_state(self.primary, "broken", 4096), None)


class SinceTests(ReaderCase):
    def read(self, rows, previous=None, now=1000.0):
        self.rows(self.primary, rows)
        config = self.config({"providers": self.homes("primary")})
        return roster.read_providers(config, environ=self.environment(), previous=previous,
                                     now=now)

    def test_a_state_that_did_not_change_keeps_the_time_it_had(self):
        first = self.read([provider_row("one")], now=1000.0)
        second = self.read([provider_row("one")], previous=first, now=1060.0)
        self.assertEqual(first["jobs"][0]["since"], 1000.0)
        self.assertEqual(second["jobs"][0]["since"], 1000.0)

    def test_a_changed_state_starts_now(self):
        first = self.read([provider_row("one")], now=1000.0)
        second = self.read([provider_row("one", state="blocked")], previous=first, now=1060.0)
        self.assertEqual(second["jobs"][0]["since"], 1060.0)

    def test_a_job_no_read_saw_before_finished_no_later_than_it_started(self):
        rows = [provider_row("done-one", state="done")]
        result = self.read(rows, now=1_700_001_000.0)
        self.assertEqual(result["jobs"][0]["since"], 1_700_000_000.0)

    def test_a_finished_job_outside_the_window_is_dropped(self):
        rows = [provider_row("done-one", state="done")]
        result = self.read(rows, now=1_700_000_000.0 + 86400 + 1)
        self.assertEqual(result["jobs"], [])

    def test_finished_jobs_are_capped_and_newest_first(self):
        rows = [provider_row("done-{0}".format(index), state="done",
                             startedAt=1_700_000_000_000 + index * 1000)
                for index in range(12)]
        result = self.read(rows, now=1_700_000_500.0)
        self.assertEqual(len(result["jobs"]), 8)
        self.assertEqual(result["jobs"][0]["id"], "done-11")


class MachineTests(ReaderCase):
    def test_a_configured_command_may_carry_its_own_arguments(self):
        self.rows(self.primary, [])
        config = self.config({"providers": self.homes("primary"),
                              "commands": {"claude": [sys.executable, str(self.stub), "--wrapper"]}})
        roster.read_providers(config, environ=self.environment(), now=1.0)
        self.assertEqual(self.seen(self.primary)["argv"], ["--wrapper", "agents", "--json", "--all"])

    def test_a_bare_name_is_resolved_inside_the_child_environment(self):
        self.assertEqual(runtime.resolve_command(["claude"], {"PATH": ""}), None)
        located = runtime.resolve_command(["python3"], {"PATH": "/usr/bin:/bin"})
        if located is None:
            self.skipTest("python3 is not on the searched path")
        self.assertTrue(Path(located[0]).is_absolute())

    def test_a_dotted_name_is_taken_as_a_path(self):
        self.assertEqual(runtime.resolve_command(["./absent-command"], {"PATH": ""}), None)
        self.assertEqual(runtime.resolve_command([], {"PATH": ""}), None)

    def test_text_is_made_printable_and_cut(self):
        self.assertEqual(runtime.printable("two\n\n lines\t"), "two lines")
        # A line break or a tab between two words keeps them two words; a control
        # character that is not spacing is dropped without leaving a gap.
        self.assertEqual(runtime.printable("line\nbreak\tand\r\ntab"), "line break and tab")
        self.assertEqual(runtime.printable("a\x07b\x1b[31mc"), "ab[31mc")
        self.assertEqual(runtime.printable(None), "")
        self.assertEqual(runtime.cut("   ", 10), None)
        self.assertEqual(runtime.cut("abcdef", 3), "abc")

    def test_a_copied_word_is_quoted_and_a_home_prefix_left_to_expand(self):
        self.assertEqual(runtime.shell_word("plain-word_1.2/x"), "plain-word_1.2/x")
        self.assertEqual(runtime.shell_word("two words"), "'two words'")
        self.assertEqual(runtime.shell_word("it's"), "'it'\"'\"'s'")
        self.assertEqual(runtime.shell_word("$HOME/bin/tool"), "\"$HOME\"/bin/tool")
        self.assertEqual(runtime.shell_word("$HOME/my tool"), "\"$HOME\"/'my tool'")
        self.assertEqual(runtime.shell_word("~/bin/tool"), "~/bin/tool")
        # A bare prefix names no file under it, and is quoted like any word.
        self.assertEqual(runtime.shell_word("$HOME/"), "'$HOME/'")
        self.assertEqual(runtime.shell_word("$HOMEWORK"), "'$HOMEWORK'")
        self.assertEqual(runtime.shell_word(""), "''")
        self.assertEqual(runtime.shell_command(["claude", "attach", "a b"],
                                               environment={"CLAUDE_CONFIG_DIR": "/h/o me"}),
                         "CLAUDE_CONFIG_DIR='/h/o me' claude attach 'a b'")

    def test_a_job_identifier_is_matched_whole(self):
        self.assertEqual(runtime.valid_job_id("ok-1_A"), True)
        self.assertEqual(runtime.valid_job_id("has space"), False)
        self.assertEqual(runtime.valid_job_id("dots.are.out"), False)
        self.assertEqual(runtime.valid_job_id(7), False)


if __name__ == "__main__":
    unittest.main()
