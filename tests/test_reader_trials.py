#!/usr/bin/env python3
"""Trial reader behavior, against a real controller store built by the test.

The store here is created from scratch with the tables the reader queries, so a
change to the SQL fails the test rather than passing against a fixture that
happens to match it.
"""

import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import trials


SCHEMA = """
CREATE TABLE repos (repo_id INTEGER PRIMARY KEY, remote_url TEXT, root_oid TEXT);
CREATE TABLE changes (change_id INTEGER PRIMARY KEY, repo_id INTEGER, branch TEXT,
                      state TEXT, worktree_path TEXT);
CREATE TABLE leases (change_id INTEGER, tool TEXT, expires_at REAL, session TEXT);
CREATE TABLE receipts (receipt_id TEXT, change_id INTEGER, evidence TEXT, created_at REAL);
CREATE TABLE milestones (change_id INTEGER, to_state TEXT, created_at REAL);
"""

NOW = 1_700_000_000.0


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-trials-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.database = self.root / "changes.db"
        with sqlite3.connect(self.database) as connection:
            connection.executescript(SCHEMA)
            connection.execute("INSERT INTO repos VALUES (1, ?, ?)",
                               ("https://example.invalid/owner/example-repo.git", "abc"))
            connection.execute("INSERT INTO changes VALUES (1, 1, ?, ?, ?)",
                               ("feat/one", "TRYING", str(self.root / "worktrees" / "example-repo")))
            connection.execute("INSERT INTO changes VALUES (2, 1, ?, ?, ?)",
                               ("feat/two", "CLEANED", None))

    def store(self, sql, values=()):
        with sqlite3.connect(self.database) as connection:
            connection.execute(sql, values)

    def lease(self, branch_change=1, tool="codex", expires=NOW + 600, session="abcdef12-rest"):
        self.store("INSERT INTO leases VALUES (?, ?, ?, ?)",
                   (branch_change, tool, expires, session))

    def receipt(self, receipt_id, evidence, created_at=NOW - 60, change=1, state=None):
        if state is not None:
            self.store("UPDATE changes SET state=? WHERE change_id=?", (state, change))
        document = evidence if isinstance(evidence, str) else json.dumps(evidence)
        self.store("INSERT INTO receipts VALUES (?, ?, ?, ?)",
                   (receipt_id, change, document, created_at))

    def config(self, **sources):
        document = {"sources": {"trials": {"enabled": True, "database": str(self.database)}}}
        for name, value in sources.items():
            document["sources"][name] = value
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(path, environ=sandbox.home_environment(self.root))


class RunningTests(StoreCase):
    def test_pause_marker_is_checked_on_every_read_and_removal_resumes(self):
        self.lease()
        config = self.config()
        marker = self.root / "paused"
        config["sources"]["trials"]["paused_when_exists"] = str(marker)
        self.assertEqual(trials.read_trials(config, now=NOW)["state"], "ready")
        marker.touch()
        self.assertEqual(trials.read_trials(config, now=NOW),
                         {"state": "paused", "running": [], "recent": [],
                          "changes": [], "history": None, "errors": []})
        self.assertEqual(trials.lease_sessions(config, NOW), [])
        marker.unlink()
        self.assertEqual(len(trials.read_trials(config, now=NOW)["running"]), 1)
        self.assertEqual(len(trials.lease_sessions(config, NOW)), 1)

    def test_paused_source_does_not_inspect_or_open_the_database(self):
        from unittest.mock import patch
        config = self.config()
        marker = self.root / "paused"
        marker.touch()
        config["sources"]["trials"]["paused_when_exists"] = str(marker)
        with patch.object(Path, "is_file", side_effect=AssertionError("database inspected")):
            self.assertEqual(trials.read_trials(config, now=NOW)["state"], "paused")
            self.assertEqual(trials.lease_sessions(config, NOW), [])
        config["sources"]["trials"]["enabled"] = False
        self.assertEqual(trials.read_trials(config, now=NOW)["state"], "disabled")

    def test_a_live_lease_is_a_running_trial(self):
        self.lease()
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["running"],
                         [{"repo": "example-repo", "branch": "feat/one", "tool": "codex",
                           "expires_at": NOW + 600, "session": "abcdef12-rest"}])

    def test_an_expired_lease_is_not_running(self):
        self.lease(expires=NOW - 1)
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(result["running"], [])
        self.assertEqual(result["state"], "empty")

    def test_a_store_with_nothing_live_or_recent_is_empty(self):
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["errors"], [])

    def test_live_sessions_are_reported_for_progress_association(self):
        self.lease()
        rows = trials.lease_sessions(self.config(), NOW)
        self.assertEqual(rows, [{"session": "abcdef12-rest", "repo": "example-repo",
                                 "branch": "feat/one", "worktree_repo": "example-repo"}])


class VerdictTests(StoreCase):
    def green(self, evidence, **kwargs):
        self.receipt("r1", evidence, **kwargs)
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(len(result["recent"]), 1, result["errors"])
        return result["recent"][0]

    def test_a_clean_run_is_green_with_its_four_counts(self):
        row = self.green({"passed": 12, "failed": 0, "errors": 0, "skipped": 1,
                          "executed": 13, "selected": 13, "selector_rc": 0})
        self.assertEqual(row["is_green"], True)
        self.assertEqual((row["passed"], row["failed"], row["errors"], row["skipped"]),
                         (12, 0, 0, 1))
        self.assertEqual((row["repo"], row["branch"], row["change_state"]),
                         ("example-repo", "feat/one", "TRYING"))
        self.assertEqual(row["key"], "r1")

    def test_a_failure_is_not_green(self):
        self.assertEqual(self.green({"failed": 2, "executed": 4, "selector_rc": 0})["is_green"],
                         False)

    def test_an_error_is_not_green(self):
        self.assertEqual(self.green({"errors": 1, "executed": 4, "selector_rc": 0})["is_green"],
                         False)

    def test_a_missing_selector_result_is_not_green(self):
        self.assertEqual(self.green({"executed": 4})["is_green"], False)

    def test_a_selector_that_did_not_succeed_is_not_green(self):
        self.assertEqual(self.green({"executed": 4, "selector_rc": 1})["is_green"], False)

    def test_collection_errors_are_not_green(self):
        self.assertEqual(self.green({"executed": 4, "selector_rc": 0,
                                     "collection_errors": ["bad"]})["is_green"], False)

    def test_a_run_that_selected_but_executed_nothing_is_not_green(self):
        self.assertEqual(self.green({"executed": 0, "selected": 5,
                                     "selector_rc": 0})["is_green"], False)

    def test_evidence_that_is_not_readable_counts_as_zero(self):
        row = self.green("{ not json")
        self.assertEqual((row["passed"], row["failed"], row["errors"], row["skipped"]),
                         (0, 0, 0, 0))
        self.assertEqual(row["is_green"], False)

    def test_counts_written_as_lists_are_their_length(self):
        row = self.green({"passed": ["a", "b"], "failed": [], "executed": 2, "selector_rc": 0})
        self.assertEqual(row["passed"], 2)
        self.assertEqual(row["is_green"], True)

    def test_only_the_newest_receipt_per_branch_is_kept(self):
        self.receipt("old", {"executed": 1, "selector_rc": 1}, created_at=NOW - 600)
        self.receipt("new", {"executed": 1, "selector_rc": 0}, created_at=NOW - 60)
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual([row["key"] for row in result["recent"]], ["new"])

    def test_a_read_without_a_clock_uses_the_wall_clock(self):
        # A lease that expired in 1970 is not a running trial, and a receipt
        # written then is not a recent verdict: an absent clock must not turn
        # every window into "always fresh".
        self.lease(expires=1000.0)
        self.receipt("old", {"executed": 1, "selector_rc": 0}, created_at=1000.0)
        result = trials.read_trials(self.config())
        self.assertEqual(result["running"], [])
        self.assertEqual(result["recent"], [])
        self.assertEqual(result["state"], "empty")

    def test_a_receipt_older_than_the_window_is_left_out(self):
        self.receipt("stale", {"executed": 1, "selector_rc": 0}, created_at=NOW - 43201)
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(result["recent"], [])

    def test_the_window_is_one_bucket_per_hour_oldest_first(self):
        # The strip the pane draws is one cell per bucket, so a bucket has to
        # mean a stretch of the clock rather than a share of however many trials
        # happened to land. Two hours ago and one hour ago are two cells.
        self.receipt("a", {"executed": 1, "selector_rc": 0}, created_at=NOW - 60)
        self.receipt("b", {"executed": 1, "selector_rc": 0}, created_at=NOW - 3660)
        self.receipt("c", {"executed": 1, "selector_rc": 1}, created_at=NOW - 7320)
        history = trials.read_trials(self.config(), now=NOW)["history"]
        self.assertEqual(history["label"], "Last 12 hours")
        self.assertEqual(history["hours"], 12)
        self.assertEqual(len(history["cells"]), 12)
        # The oldest bucket is the one twelve hours back, so the newest receipt
        # is in the last cell and not the first.
        self.assertEqual(history["cells"][-1], {"outcomes": 1, "failed": 0})
        self.assertEqual(history["cells"][-2], {"outcomes": 1, "failed": 0})
        self.assertEqual(history["cells"][-3], {"outcomes": 1, "failed": 1})
        self.assertEqual(history["cells"][0], {"outcomes": 0, "failed": 0})
        self.assertEqual((history["outcomes"], history["failed"]), (3, 1))

    def test_the_strip_counts_every_receipt_rather_than_one_per_branch(self):
        # One cell per branch would answer "how did the branches do" while being
        # read as "how did the day go", so both receipts of one branch land in
        # the strip even though only one of them is a row.
        self.receipt("old", {"executed": 1, "selector_rc": 0}, created_at=NOW - 300)
        self.receipt("new", {"executed": 1, "selector_rc": 1}, created_at=NOW - 60)
        history = trials.read_trials(self.config(), now=NOW)["history"]
        self.assertEqual(history["outcomes"], 2)
        self.assertEqual(history["failed"], 1)
        self.assertEqual(len(trials.read_trials(self.config(), now=NOW)["recent"]), 1)

    def test_a_receipt_whose_time_is_not_a_number_is_left_out_of_the_strip(self):
        # A stamp that cannot be placed in an hour belongs in no bucket. Dropped
        # into the oldest one it would be a trial reported in an hour it did not
        # happen, and an age that is not a finite number would raise at the
        # index, taking the whole trials document down with it.
        for stamp in (float("nan"), float("inf"), float("-inf"), "an hour ago", None):
            row = {"at": stamp, "is_green": True}
            history = trials.history_of([row], NOW, 43200.0)
            self.assertEqual(history["outcomes"], 0, repr(stamp))
            self.assertEqual(history["cells"], [{"outcomes": 0, "failed": 0}] * 12, repr(stamp))

    def test_a_window_that_was_not_read_carries_no_buckets(self):
        # A fold of empty cells is a claim about twelve hours, and a source
        # nobody read has measured none of them.
        for result in (trials.read_trials(self.config(trials={"enabled": False,
                                                              "database": str(self.database)}),
                                          now=NOW),
                       trials.read_trials(self.config(trials={"enabled": True,
                                                              "database": str(self.root / "no.db")}),
                                          now=NOW)):
            self.assertIsNone(result["history"], result["state"])


class RefusalTests(StoreCase):
    def test_a_disabled_source_is_not_read(self):
        self.lease()
        config = self.config(trials={"enabled": False, "database": str(self.database)})
        result = trials.read_trials(config, now=NOW)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(result["running"], [])

    def test_a_store_that_is_not_there_reads_unavailable(self):
        config = self.config(trials={"enabled": True,
                                     "database": str(self.root / "absent.db")})
        result = trials.read_trials(config, now=NOW)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["errors"],
                         [{"source": "trials", "reason": "no controller store"}])

    def test_a_store_that_is_not_a_store_is_failed_with_a_reason(self):
        broken = self.root / "broken.db"
        broken.write_text("this is not a database", encoding="utf-8")
        config = self.config(trials={"enabled": True, "database": str(broken)})
        result = trials.read_trials(config, now=NOW)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["source"], "trials")
        self.assertEqual(bool(result["errors"][0]["reason"]), True)

    def test_a_reason_is_cut_to_the_configured_length(self):
        broken = self.root / "broken.db"
        broken.write_text("this is not a database", encoding="utf-8")
        config = self.config(trials={"enabled": True, "database": str(broken)})
        config = dict(config)
        config["limits"] = dict(config["limits"], questionCharacters=4)
        result = trials.read_trials(config, now=NOW)
        self.assertEqual(len(result["errors"][0]["reason"]), 4)

    def test_associations_cannot_be_proved_from_a_store_that_cannot_be_read(self):
        broken = self.root / "broken.db"
        broken.write_text("this is not a database", encoding="utf-8")
        config = self.config(trials={"enabled": True, "database": str(broken)})
        self.assertEqual(trials.lease_sessions(config, NOW), [])

    def test_a_repository_name_comes_from_the_remote_url(self):
        self.assertEqual(trials.repository_name("https://example.invalid/o/p.git"), "p")
        self.assertEqual(trials.repository_name("git@example.invalid:o/p"), "p")
        self.assertEqual(trials.repository_name(None), "")


if __name__ == "__main__":
    unittest.main()


class ChangeTests(StoreCase):
    """Changes in flight, read from the milestones the controller appends."""

    def moved(self, change, at, state=None):
        if state is not None:
            self.store("UPDATE changes SET state=? WHERE change_id=?", (state, change))
        self.store("INSERT INTO milestones VALUES (?, ?, ?)", (change, state or "", at))

    def test_a_change_that_moved_in_the_window_carries_its_place_on_the_path(self):
        self.moved(1, NOW - 120, "TRIALED")
        self.moved(1, NOW - 60)
        self.lease(tool="claude")
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["changes"], [{
            "repo": "example-repo", "branch": "feat/one", "state": "TRIALED", "stage": 3,
            "stages": 9, "moved_at": NOW - 60, "held_by": "claude"}])

    def test_a_finished_change_a_change_that_never_moved_and_an_old_one_are_left_out(self):
        self.moved(2, NOW - 60)  # CLEANED: the last stage
        self.store("INSERT INTO changes VALUES (3, 1, 'feat/never', 'NEW', '/tmp/x')")
        self.store("INSERT INTO changes VALUES (4, 1, 'feat/old', 'PUSHED', '/tmp/y')")
        self.moved(4, NOW - 43200 - 1)
        self.assertEqual(trials.read_trials(self.config(), now=NOW)["changes"], [])

    def test_an_abandoned_change_is_history_and_not_in_flight(self):
        # The section counts "in flight". A change the person closed deliberately
        # is not moving through the controller any more, and a count that adds it
        # to the ones still moving claims work that nobody is doing.
        self.moved(1, NOW - 60, "ABANDONED")
        self.assertEqual(trials.read_trials(self.config(), now=NOW)["changes"], [])

    def test_a_state_the_path_does_not_name_keeps_its_row_without_a_place(self):
        self.moved(1, NOW - 60)  # TRYING is not on the default path
        change = trials.read_trials(self.config(), now=NOW)["changes"][0]
        self.assertEqual((change["state"], change["stage"]), ("TRYING", None))

    def test_an_expired_lease_holds_nothing(self):
        self.moved(1, NOW - 60, "PUSHED")
        self.lease(expires=NOW - 1)
        self.assertIsNone(trials.read_trials(self.config(), now=NOW)["changes"][0]["held_by"])

    def test_a_configured_path_decides_the_places_and_the_last_stage(self):
        self.moved(1, NOW - 60, "REVIEW")
        config = self.config(trials={"enabled": True, "database": str(self.database),
                                     "stages": ["DRAFT", "REVIEW", "DONE"]})
        change = trials.read_trials(config, now=NOW)["changes"][0]
        self.assertEqual((change["stage"], change["stages"]), (2, 3))
        self.moved(1, NOW - 30, "DONE")
        self.assertEqual(trials.read_trials(config, now=NOW)["changes"], [])

    def test_a_store_without_milestones_names_the_gap_and_still_answers(self):
        self.store("DROP TABLE milestones")
        self.lease()
        result = trials.read_trials(self.config(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(len(result["running"]), 1)
        self.assertEqual(result["changes"], [])
        self.assertEqual([error["source"] for error in result["errors"]], ["trials:changes"])
        self.assertIn("milestones", result["errors"][0]["reason"])


class SwitchTests(StoreCase):
    """The change controller's switch, as the marker file states it."""

    def test_a_marker_that_is_there_reads_off_and_one_that_is_not_reads_on(self):
        marker = self.root / "governor-controller.off"
        document = {"sources": {"trials": {"enabled": True, "database": str(self.database),
                                           "offSwitch": str(marker)}}}
        path = self.root / "switch-config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        config = load_config(path, environ=sandbox.home_environment(self.root))
        self.assertEqual(trials.read_trials(config, now=NOW)["switch"], "on")
        marker.write_text("", encoding="utf-8")
        self.assertEqual(trials.read_trials(config, now=NOW)["switch"], "off")


if __name__ == "__main__":
    unittest.main()

