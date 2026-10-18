#!/usr/bin/env python3
"""Progress reader behavior, against real run records and count files.

Liveness is exercised with a real process identifier: the test's own for a live
run, and a child it starts and reaps for a dead one. Count trust is exercised by
moving a count file's modification time, not by mocking a stat call.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sqlite3
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import progress


STORES = """
CREATE TABLE repos (repo_id INTEGER PRIMARY KEY, remote_url TEXT, root_oid TEXT);
CREATE TABLE changes (change_id INTEGER PRIMARY KEY, repo_id INTEGER, branch TEXT,
                      state TEXT, worktree_path TEXT);
CREATE TABLE leases (change_id INTEGER, tool TEXT, expires_at REAL, session TEXT);
"""

NOW = 1_700_000_000.0


class ProgressCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-progress-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.directory = self.root / "progress"
        self.directory.mkdir()

    def record(self, stem, document, started=NOW - 60, mtime=None, kind="run"):
        body = {"session": stem, "kind": kind, "pid": os.getpid(), "started_at": started,
                "phase": "verify", "command_class": "full", "repo": "example-repo"}
        body.update(document)
        path = self.directory / (stem + ".json")
        path.write_text(json.dumps(body), encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def steps(self, stem, document, mtime=None):
        path = self.directory / (stem + ".progress.json")
        path.write_text(json.dumps(document), encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def store(self, leases=(), branch="feat/one"):
        database = self.root / "changes.db"
        with sqlite3.connect(database) as connection:
            connection.executescript(STORES)
            connection.execute("INSERT INTO repos VALUES (1, ?, ?)",
                               ("https://example.invalid/owner/example-repo.git", "abc"))
            connection.execute("INSERT INTO changes VALUES (1, 1, ?, ?, ?)",
                               (branch, "TRYING", str(self.root / "worktrees" / "example-repo")))
            for tool, expires, lease_session in leases:
                connection.execute("INSERT INTO leases VALUES (1, ?, ?, ?)",
                                   (tool, expires, lease_session))
        return database

    def config(self, trials_database=None, **overrides):
        sources = {"progress": {"enabled": True, "directory": str(self.directory)}}
        if trials_database is not None:
            sources["trials"] = {"enabled": True, "database": str(trials_database)}
        document = {"sources": sources}
        for group, value in overrides.items():
            document[group] = value
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(path, environ=sandbox.home_environment(self.root))

    def read(self, **kwargs):
        return progress.read_progress(self.config(**kwargs.pop("config", {})), now=NOW, **kwargs)


class RowTests(ProgressCase):
    def test_a_live_run_carries_its_measured_counts(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 7, "total": 20, "label": "suite", "failed": 1,
                                    "first_failure": "test_one"})
        result = self.read()
        self.assertEqual(result["state"], "ready")
        row = result["runs"][0]
        self.assertEqual((row["key"], row["done"], row["total"], row["label"]),
                         ("abcdef12", 7, 20, "suite"))
        self.assertEqual((row["failed"], row["first_failure"]), (1, "test_one"))
        self.assertEqual(row["elapsed"], 60.0)
        self.assertEqual(row["phase"], "verify")

    def test_a_run_without_a_count_file_reports_zero_and_no_label(self):
        self.record("abcdef12", {})
        row = self.read()["runs"][0]
        self.assertEqual((row["done"], row["total"], row["label"], row["failed"]),
                         (0, 0, "", 0))

    def test_a_count_above_the_total_is_clamped_to_it(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 30, "total": 20})
        self.assertEqual(self.read()["runs"][0]["done"], 20)

    def test_an_estimate_appears_only_after_the_configured_minimum(self):
        config = {"progress": {"etaMinimumOutcomes": 20}}
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 19, "total": 40})
        self.assertEqual(self.read(config=config)["runs"][0]["eta_minutes"], None)
        self.steps("abcdef12", {"done": 20, "total": 40})
        # 60 seconds for 20 of 40 leaves 20 to go: one minute.
        self.assertEqual(self.read(config=config)["runs"][0]["eta_minutes"], 1)

    def test_a_label_that_is_not_a_token_is_dropped(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 1, "total": 2, "label": "two words"})
        self.assertEqual(self.read()["runs"][0]["label"], "")


class LivenessTests(ProgressCase):
    def dead_pid(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        return child.pid

    def test_a_run_whose_process_is_gone_is_left_out(self):
        # An identifier the reader cannot confirm as a live process is not a live
        # run, on any platform.
        for identifier in (-1, 0, 2147483648, 1e18):
            self.record("abcdef12", {"pid": identifier})
            self.steps("abcdef12", {"done": 3, "total": 10})
            result = self.read()
            self.assertEqual(result["runs"], [], repr(identifier))
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["state"], "empty")

    def test_a_run_whose_reaped_child_is_gone_is_left_out(self):
        identifier = self.dead_pid()
        if progress.process_is_alive(identifier):
            self.skipTest("this platform still reports a just-reaped process as present")
        self.record("abcdef12", {"pid": identifier})
        self.steps("abcdef12", {"done": 3, "total": 10})
        result = self.read()
        self.assertEqual(result["runs"], [])
        self.assertEqual(result["state"], "empty")

    def test_a_run_past_its_age_ceiling_is_left_out(self):
        self.record("abcdef12", {"started_at": NOW - 6 * 3600 - 1})
        self.assertEqual(self.read()["runs"], [])

    def test_a_stale_waiting_run_is_left_out_and_a_fresh_one_is_kept(self):
        self.record("abcdef12", {"kind": "wait", "started_at": NOW - 50,
                                     "updated_at": NOW - 76})
        self.assertEqual(self.read()["runs"], [])
        self.record("abcdef12", {"kind": "wait", "started_at": NOW - 50,
                                     "updated_at": NOW - 10})
        self.assertEqual(len(self.read()["runs"]), 1)

    def test_a_held_command_carries_its_place_in_the_queue_and_its_wait(self):
        self.record("abcdef12", {"kind": "wait", "started_at": NOW - 50, "updated_at": NOW - 5,
                                 "phase": "global", "command_class": "mutation",
                                 "queue_position": 4, "queue_total": 6,
                                 "total_seconds": 300, "remaining_seconds": 258})
        run = self.read()["runs"][0]
        self.assertEqual((run["kind"], run["command_class"], run["queue_position"],
                          run["queue_total"], run["wait_total"], run["wait_left"]),
                         ("wait", "mutation", 4, 6, 300, 258))

    def test_a_running_command_carries_no_wait_and_a_missing_place_stays_missing(self):
        self.record("abcdef12", {"total_seconds": 300, "remaining_seconds": 10,
                                 "queue_position": -1})
        run = self.read()["runs"][0]
        self.assertEqual((run["kind"], run["wait_total"], run["wait_left"],
                          run["queue_position"], run["queue_total"]),
                         ("run", None, None, None, None))

    def test_a_record_without_a_usable_identifier_is_not_live(self):
        self.record("abcdef12", {"pid": "not a pid"})
        self.assertEqual(self.read()["runs"], [])
        self.assertEqual(progress.process_is_alive(None), False)
        self.assertEqual(progress.process_is_alive(True), False)
        self.assertEqual(progress.process_is_alive(os.getpid()), True)

    def test_an_identifier_outside_the_range_the_system_call_takes_is_not_live(self):
        for identifier in (1e18, 2147483648, 2.5, -1):
            self.assertEqual(progress.process_is_alive(identifier), False, repr(identifier))
        self.record("abcdef12", {"pid": 1e18})
        result = self.read()
        self.assertEqual(result["runs"], [])
        self.assertEqual(result["state"], "empty")

    def test_a_record_whose_clock_is_ahead_reports_no_negative_elapsed_time(self):
        # The count file is newer than the run, as it would be in reality, so the
        # only oddity under test is the run's own clock.
        self.record("abcdef12", {"started_at": NOW + 600})
        self.steps("abcdef12", {"done": 20, "total": 40}, mtime=NOW + 600)
        row = self.read()["runs"][0]
        self.assertEqual(row["elapsed"], 0.0)
        self.assertEqual(row["eta_minutes"], 0)

    def test_a_read_without_a_clock_uses_the_wall_clock(self):
        self.record("abcdef12", {"started_at": 1000.0})
        result = progress.read_progress(self.config())
        self.assertEqual(result["runs"], [])

    def test_a_kind_this_reader_does_not_run_is_left_out(self):
        self.record("abcdef12", {"kind": "sweep"})
        self.assertEqual(self.read()["runs"], [])


class CountTrustTests(ProgressCase):
    def test_a_count_file_older_than_its_run_is_not_this_run_s_counts(self):
        # An earlier run's leftover: this run has not counted yet, which is not
        # a fault, so nothing is raised as a warning and nothing is borrowed.
        self.record("abcdef12", {"started_at": NOW - 60})
        self.steps("abcdef12", {"done": 5, "total": 10}, mtime=NOW - 120)
        result = self.read()
        self.assertEqual(result["errors"], [])
        self.assertEqual((result["runs"][0]["done"], result["runs"][0]["total"]), (0, 0))
        self.assertEqual(result["state"], "ready")

    def test_a_total_of_zero_is_refused_rather_than_shown(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 0, "total": 0}, mtime=NOW)
        result = self.read()
        self.assertEqual([entry["reason"] for entry in result["errors"]],
                         ["invalid counts abcdef12"])
        self.assertEqual(result["runs"][0]["total"], 0)

    def test_counts_that_are_not_numbers_are_refused(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": "seven", "total": 10}, mtime=NOW)
        self.assertEqual(len(self.read()["errors"]), 1)

    def test_a_failure_count_that_is_not_positive_is_reported_as_zero(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 1, "total": 2, "failed": -3}, mtime=NOW)
        self.assertEqual(self.read()["runs"][0]["failed"], 0)


class RecordRefusalTests(ProgressCase):
    def test_a_record_whose_session_does_not_match_its_name_is_refused(self):
        self.record("abcdef12", {"session": "other"})
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["errors"],
                         [{"source": "progress", "reason": "invalid record abcdef12"}])

    def test_a_record_without_a_repository_is_refused(self):
        self.record("abcdef12", {"repo": ""})
        self.assertEqual([entry["reason"] for entry in self.read()["errors"]],
                         ["invalid record abcdef12"])

    def test_a_record_that_is_not_an_object_is_refused(self):
        (self.directory / "abcdef12.json").write_text("[1, 2]", encoding="utf-8")
        self.assertEqual([entry["reason"] for entry in self.read()["errors"]],
                         ["invalid record abcdef12"])


class AssociationTests(ProgressCase):
    def test_a_single_live_lease_names_the_branch(self):
        self.record("abcdef12", {})
        self.steps("abcdef12", {"done": 1, "total": 2}, mtime=NOW)
        result = progress.read_progress(
            self.config(trials_database=self.store(leases=[("codex", NOW + 600, "abcdef12-rest")])),
            now=NOW)
        row = result["runs"][0]
        self.assertEqual((row["repo"], row["branch"]), ("example-repo", "feat/one"))
        self.assertEqual(row["display"], "feat/one@example-repo")

    def test_two_claiming_leases_leave_the_branch_unlinked(self):
        self.record("abcdef12", {})
        result = progress.read_progress(
            self.config(trials_database=self.store(
                leases=[("codex", NOW + 600, "abcdef12-rest"),
                        ("claude", NOW + 600, "abcdef12-other")])),
            now=NOW)
        row = result["runs"][0]
        self.assertEqual(row["branch"], None)
        self.assertEqual(row["repo"], "example-repo")
        # A run nothing else names is still named by what it is and where.
        self.assertEqual(row["display"], "full in example-repo")

    def test_a_record_that_names_its_branch_and_command_is_drawn_by_them(self):
        self.record("abcdef12", {"branch": "fix/one", "cwd": "/work/example-repo",
                                 "label": "make test-impacted"})
        row = progress.read_progress(self.config(), now=NOW)["runs"][0]
        self.assertEqual(row["branch"], "fix/one")
        self.assertEqual(row["label"], "make test-impacted")
        self.assertEqual(row["display"], "make test-impacted")
        # The record's own branch stands over a lease's guess.
        self.record("abcdef13", {"branch": "fix/two"})
        guessed = progress.read_progress(
            self.config(trials_database=self.store(leases=[("codex", NOW + 600, "abcdef13-rest")])),
            now=NOW)
        rows = {entry["key"]: entry for entry in guessed["runs"]}
        self.assertEqual(rows["abcdef13"]["branch"], "fix/two")
        self.assertEqual(rows["abcdef13"]["display"], "fix/two@example-repo")

    def test_a_record_s_own_words_are_made_printable_and_cut(self):
        self.record("abcdef12", {"branch": "fix/\x1b[31mred", "label": "x" * 400})
        row = progress.read_progress(self.config(), now=NOW)["runs"][0]
        self.assertNotIn("\x1b", row["branch"])
        self.assertLessEqual(len(row["label"]), 120)

    def test_a_lease_for_a_different_session_is_not_claimed(self):
        self.record("abcdef12", {})
        result = progress.read_progress(
            self.config(trials_database=self.store(leases=[("codex", NOW + 600, "99999999-x")])),
            now=NOW)
        self.assertEqual(result["runs"][0]["branch"], None)


class SourceStateTests(ProgressCase):
    def test_pause_marker_is_checked_on_every_read_and_removal_resumes(self):
        self.record("abcdef12", {})
        config = self.config()
        marker = self.root / "paused"
        config["sources"]["progress"]["paused_when_exists"] = str(marker)
        self.assertEqual(progress.read_progress(config, now=NOW)["state"], "ready")
        marker.touch()
        self.assertEqual(progress.read_progress(config, now=NOW),
                         {"state": "paused", "runs": [], "errors": []})
        marker.unlink()
        self.assertEqual(len(progress.read_progress(config, now=NOW)["runs"]), 1)

    def test_paused_source_does_not_inspect_its_directory(self):
        from unittest.mock import patch
        config = self.config()
        marker = self.root / "paused"
        marker.touch()
        config["sources"]["progress"]["paused_when_exists"] = str(marker)
        with patch.object(Path, "is_dir", side_effect=AssertionError("directory inspected")):
            self.assertEqual(progress.read_progress(config, now=NOW),
                             {"state": "paused", "runs": [], "errors": []})
        config["sources"]["progress"]["enabled"] = False
        self.assertEqual(progress.read_progress(config, now=NOW)["state"], "disabled")

    def test_a_disabled_source_is_not_read(self):
        config = self.config(**{"sources": {"progress": {"enabled": False,
                                                        "directory": str(self.directory)}}})
        result = progress.read_progress(config, now=NOW)
        self.assertEqual(result["state"], "disabled")

    def test_a_directory_that_is_not_there_reads_unavailable(self):
        config = self.config(**{"sources": {"progress": {
            "enabled": True, "directory": str(self.root / "absent")}}})
        self.assertEqual(progress.read_progress(config, now=NOW)["state"], "unavailable")

    def test_an_empty_directory_is_empty_rather_than_failed(self):
        result = self.read()
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["errors"], [])

    def test_a_reader_that_failed_never_reports_an_empty_source(self):
        self.record("abcdef12", {"repo": ""})
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertNotEqual(result["state"], "empty")


class SwitchTests(ProgressCase):
    """The machine switch, as the marker file states it."""

    def config_with_switch(self, marker):
        document = {"sources": {"progress": {"enabled": False, "offSwitch": str(marker)}}}
        path = self.root / "switch-config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(path, environ=sandbox.home_environment(self.root))

    def test_a_marker_that_is_there_reads_off_and_one_that_is_not_reads_on(self):
        marker = self.root / "governor-controller.off"
        self.assertEqual(progress.read_progress(self.config_with_switch(marker), now=NOW)["switch"],
                         "on")
        marker.write_text("", encoding="utf-8")
        self.assertEqual(progress.read_progress(self.config_with_switch(marker), now=NOW)["switch"],
                         "off")
        # The file is a flag, not a document: what is written in it is not policy.
        marker.write_text('{"enabled": true}', encoding="utf-8")
        self.assertEqual(progress.read_progress(self.config_with_switch(marker), now=NOW)["switch"],
                         "off")

    def test_a_source_with_no_switch_configured_reports_no_state(self):
        # An unconfigured switch is not "on": a person who set none has not said
        # which way the machine is set.
        self.assertNotIn("switch", progress.read_progress(self.config(), now=NOW))


if __name__ == "__main__":
    unittest.main()
