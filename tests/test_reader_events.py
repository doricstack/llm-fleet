#!/usr/bin/env python3
"""The digest's events, from documents and from a whole reading of real sources.

The unit cases hand the event builder documents in the shape the readers write
them, including the rows that must not become an event: a time that is missing,
not a number, or not a time. The reading cases run the read itself against a
controller store on disk, a stub pull-request command, a stub roster command
and a transcript, so the events are the ones a real read produces.

Run with: python3 tests/test_reader_events.py -v
"""

import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import events, snapshot


NOW = 1_700_000_000.0
SESSION = "0123abcd-0000-4000-8000-00000000beef"

STORES = """
CREATE TABLE repos (repo_id INTEGER PRIMARY KEY, remote_url TEXT, root_oid TEXT);
CREATE TABLE changes (change_id INTEGER PRIMARY KEY, repo_id INTEGER, branch TEXT,
                      state TEXT, worktree_path TEXT);
CREATE TABLE leases (change_id INTEGER, tool TEXT, expires_at REAL, session TEXT);
CREATE TABLE receipts (receipt_id TEXT, change_id INTEGER, evidence TEXT, created_at REAL);
CREATE TABLE milestones (change_id INTEGER, session TEXT, created_at REAL, to_state TEXT);
"""

GITHUB_STUB = """import json, os, sys
argv = sys.argv[1:]
if os.environ.get("FLEET_GITHUB_MODE") == "fail":
    sys.exit(4)
print(open(os.environ["FLEET_GITHUB_ROWS"]).read())
"""

ROSTER_STUB = """import sys
print(open(sys.argv[1]).read())
"""

GREEN = {"failed": 0, "errors": 0, "selector_rc": 0, "executed": 3, "selected": 3}
RED = {"failed": 2, "errors": 0, "selector_rc": 0, "executed": 3, "selected": 3}


def configured(limit=50):
    # The probe answers for every path, so no configuration on the machine the
    # suite runs on can be read here even if one sits at the fixture home.
    config = load_config(None, environ={"HOME": "/nonexistent-fleet-home"},
                         probe=lambda path: "missing")
    config["history"]["eventLimit"] = limit
    return config


class EventTests(unittest.TestCase):
    """Each kind, its time, and what is left out."""

    def test_each_kind_comes_from_its_own_document_newest_first(self):
        reading = {
            "trials": {"state": "ready", "recent": [
                {"key": "r1", "repo": "example", "branch": "feat/one", "at": NOW - 300,
                 "is_green": True},
                {"key": "r2", "repo": "example", "branch": "feat/two", "at": NOW - 100,
                 "is_green": False}]},
            "prs": {"state": "ready", "prs": [
                {"repo": "owner/one", "number": 7, "title": "Fix it",
                 "opened_at": "2023-11-14T22:10:00Z"}]},
            "roster": {"state": "ready", "jobs": [
                {"provider": "primary", "id": "a1", "name": "Builder", "state": "done",
                 "since": NOW - 50, "entered_at": NOW - 200},
                {"provider": "primary", "id": "b2", "name": "Asker", "state": "blocked",
                 "since": NOW - 20, "entered_at": NOW - 20},
                {"provider": "primary", "id": "c3", "name": "Busy", "state": "working",
                 "since": NOW - 10}]},
        }
        document = events.read_events(reading, configured())
        self.assertEqual(document["state"], "ready")
        self.assertEqual(document["events"], [
            {"at": "2023-11-14T22:13:00Z", "kind": "job-waiting", "title": "Asker",
             "ref": "primary:b2"},
            {"at": "2023-11-14T22:11:40Z", "kind": "trial-failed", "title": "example feat/two",
             "ref": "r2"},
            # One time, two events: the kind breaks the tie, so the order holds
            # from one read to the next.
            {"at": "2023-11-14T22:10:00Z", "kind": "job-finished", "title": "Builder",
             "ref": "primary:a1"},
            {"at": "2023-11-14T22:10:00Z", "kind": "pr-opened", "title": "Fix it",
             "ref": "owner/one#7"},
            {"at": "2023-11-14T22:08:20Z", "kind": "trial-passed", "title": "example feat/one",
             "ref": "r1"}])
        self.assertEqual(document["sources"], {"trials": "ready", "prs": "ready",
                                               "roster": "ready"})

    def test_no_pull_request_is_ever_reported_merged(self):
        reading = {"prs": {"state": "ready", "prs": [
            {"repo": "owner/one", "number": 1, "title": "x", "opened_at": "2023-11-14T22:10:00Z",
             "merged": True, "state": "MERGED"}]}}
        kinds = {event["kind"] for event in events.read_events(reading, configured())["events"]}
        self.assertEqual(kinds, {"pr-opened"})

    def test_a_row_without_a_real_time_makes_no_event(self):
        reading = {
            "trials": {"recent": [
                {"key": "r1", "at": None, "is_green": True},
                {"key": "r2", "at": "2023-11-14T22:10:00Z", "is_green": True},
                {"key": "r3", "at": True, "is_green": True},
                {"key": "r4", "at": float("nan"), "is_green": False},
                {"key": "r5", "at": -5, "is_green": False},
                # A real time with no verdict is neither a pass nor a failure.
                {"key": "r6", "at": NOW},
                {"key": "r7", "at": NOW, "is_green": "yes"},
                "not a row"]},
            "prs": {"prs": [{"repo": "o/p", "number": 1, "opened_at": None},
                            {"repo": "o/p", "number": 2, "opened_at": "yesterday"},
                            {"repo": "o/p", "number": 3, "opened_at": "2023-11-14T22:10:00"},
                            {"repo": "o/p", "number": 4, "opened_at": NOW}]},
            "roster": {"jobs": [
                # A finished job with no transcript time: its `since` may be its
                # start, so it is not a finish time.
                {"provider": "p", "id": "a", "state": "done", "since": NOW},
                {"provider": "p", "id": "b", "state": "done", "since": NOW,
                 "agent": {"state": "unavailable", "lastActivity": None}},
                {"provider": "p", "id": "c", "state": "blocked", "since": None},
                {"provider": "p", "id": "d", "state": "blocked", "since": "now"}]},
        }
        document = events.read_events(reading, configured())
        self.assertEqual((document["state"], document["events"]), ("empty", []))

    def test_a_finished_job_is_dated_by_its_finish_not_its_last_turn(self):
        # The last turn comes before the job writes itself finished; the
        # transition is the time the job's own record states.
        reading = {"roster": {"jobs": [
            {"provider": "p", "id": "a", "name": "Builder", "state": "done", "since": NOW - 900,
             "entered_at": NOW - 120, "agent": {"lastActivity": NOW - 200}}]}}
        self.assertEqual(events.read_events(reading, configured())["events"], [
            {"at": "2023-11-14T22:11:20Z", "kind": "job-finished", "title": "Builder",
             "ref": "p:a"}])

    def test_a_job_first_seen_waiting_with_no_transition_time_makes_no_event(self):
        # `since` is the read that first saw it waiting, not when it began to:
        # dated by it, a job waiting for a day would read as new.
        reading = {"roster": {"jobs": [
            {"provider": "p", "id": "b", "name": "Asker", "state": "blocked", "since": NOW - 20,
             "entered_at": None},
            {"provider": "p", "id": "c", "name": "Done", "state": "done", "since": NOW - 20,
             "agent": {"lastActivity": NOW - 30}}]}}
        document = events.read_events(reading, configured())
        self.assertEqual((document["state"], document["events"]), ("empty", []))

    def test_documents_that_are_not_documents_make_no_events(self):
        reading = {"trials": None, "prs": [], "roster": {"jobs": "many"}}
        document = events.read_events(reading, configured())
        self.assertEqual(document["events"], [])
        self.assertEqual(document["sources"], {"trials": "absent", "prs": "absent",
                                               "roster": "absent"})

    def test_the_newest_events_are_kept_up_to_the_limit(self):
        reading = {"trials": {"recent": [
            {"key": "r{0}".format(index), "repo": "x", "branch": "b", "at": NOW + index,
             "is_green": True} for index in range(10)]}}
        document = events.read_events(reading, configured(limit=3))
        self.assertEqual([event["ref"] for event in document["events"]], ["r9", "r8", "r7"])

    def test_a_pull_request_without_a_number_is_named_by_its_repository(self):
        reading = {"prs": {"prs": [{"repo": "o/p", "number": None, "title": "t",
                                    "opened_at": "2023-11-14T22:10:00+00:00"}]}}
        self.assertEqual(events.read_events(reading, configured())["events"][0]["ref"], "o/p")


class ReadingTests(unittest.TestCase):
    """The events of a whole read, against a store, two commands and a transcript."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-events-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.database = self.root / "changes.db"
        with sqlite3.connect(self.database) as connection:
            connection.executescript(STORES)
            connection.execute("INSERT INTO repos VALUES (1, ?, ?)",
                               ("https://example.invalid/owner/example-repo.git", "abc"))
            connection.execute("INSERT INTO changes VALUES (1, 1, 'feat/one', 'TRIALED', NULL)")
            connection.execute("INSERT INTO changes VALUES (2, 1, 'feat/two', 'TRIALED', NULL)")
            connection.execute("INSERT INTO receipts VALUES ('old', 1, ?, ?)",
                               (json.dumps(RED), NOW - 900))
            connection.execute("INSERT INTO receipts VALUES ('new', 1, ?, ?)",
                               (json.dumps(GREEN), NOW - 600))
            connection.execute("INSERT INTO receipts VALUES ('two', 2, ?, ?)",
                               (json.dumps(RED), NOW - 30))
        self.home = self.root / "home"
        transcript = self.home / "projects" / "-work" / (SESSION + ".jsonl")
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({
            "type": "assistant", "timestamp": "2023-11-14T22:05:00Z",
            "message": {"id": "m1", "model": "claude-opus-5-5",
                        "usage": {"input_tokens": 10, "output_tokens": 5}}}) + "\n",
            encoding="utf-8")
        (self.root / "gh.py").write_text(GITHUB_STUB, encoding="utf-8")
        (self.root / "claude.py").write_text(ROSTER_STUB, encoding="utf-8")
        self.github_rows = self.root / "prs.json"
        self.github_rows.write_text(json.dumps([
            {"number": 4, "title": "Add dots", "createdAt": "2023-11-14T22:12:00Z",
             "statusCheckRollup": []}]), encoding="utf-8")
        self.roster_rows = self.root / "roster.json"
        self.roster_rows.write_text(json.dumps([
            {"id": "job1", "kind": "background", "name": "Finisher", "state": "done",
             "cwd": "/tmp", "startedAt": (NOW - 3000) * 1000, "sessionId": SESSION}]),
            encoding="utf-8")
        # The job wrote itself finished three minutes after its last turn.
        job_file = self.home / "jobs" / "job1" / "state.json"
        job_file.parent.mkdir(parents=True)
        job_file.write_text(json.dumps({"state": "done",
                                        "lastTerminalAt": "2023-11-14T22:08:00.000Z",
                                        "updatedAt": "2023-11-14T22:08:00.000Z"}),
                            encoding="utf-8")

    def environment(self, **extra):
        return sandbox.home_environment(self.root, FLEET_GITHUB_ROWS=str(self.github_rows), **extra)

    def config_file(self):
        path = self.root / "config.json"
        path.write_text(json.dumps({
            "stateDir": str(self.root / "state"),
            "commands": {"github": [sys.executable, str(self.root / "gh.py")],
                         "claude": [sys.executable, str(self.root / "claude.py"),
                                    str(self.roster_rows)]},
            "providers": [{"id": "primary", "home": str(self.home)}],
            "sources": {"trials": {"enabled": True, "database": str(self.database)},
                        "prs": {"enabled": True, "repositories": ["owner/one"]}},
        }), encoding="utf-8")
        return path

    def read(self, **extra):
        environment = self.environment(**extra)
        config = load_config(self.config_file(), environ=environment)
        with mock.patch.dict(os.environ, environment, clear=True):
            return snapshot.read_snapshot(config, now=NOW)

    def test_a_whole_read_carries_the_events_of_every_source(self):
        reading = self.read()
        self.assertEqual(reading["events"]["state"], "ready", reading["events"])
        self.assertEqual(reading["events"]["events"], [
            {"at": "2023-11-14T22:12:50Z", "kind": "trial-failed",
             "title": "example-repo feat/two", "ref": "two"},
            {"at": "2023-11-14T22:12:00Z", "kind": "pr-opened", "title": "Add dots",
             "ref": "owner/one#4"},
            {"at": "2023-11-14T22:08:00Z", "kind": "job-finished", "title": "Finisher",
             "ref": "primary:job1"},
            {"at": "2023-11-14T22:03:20Z", "kind": "trial-passed",
             "title": "example-repo feat/one", "ref": "new"}])

    def test_a_source_that_failed_is_named_and_the_rest_still_answer(self):
        reading = self.read(FLEET_GITHUB_MODE="fail")
        document = reading["events"]
        self.assertEqual(document["sources"]["prs"], "failed")
        self.assertEqual({event["kind"] for event in document["events"]},
                         {"trial-failed", "trial-passed", "job-finished"})

    def test_a_reader_that_raised_leaves_its_events_out(self):
        original = dict(snapshot.READERS)

        def explode(config, **_):
            raise RuntimeError("the store moved")

        snapshot.READERS["trials"] = explode
        try:
            document = self.read()["events"]
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)
        self.assertEqual(document["sources"]["trials"], "failed")
        self.assertNotIn("trial-passed", {event["kind"] for event in document["events"]})

    def test_an_event_build_that_raises_keeps_its_slot_as_failed(self):
        with mock.patch.object(snapshot, "read_events", side_effect=RuntimeError("boom")):
            document = self.read()["events"]
        self.assertEqual((document["state"], document["events"]), ("failed", []))
        self.assertIn("boom", document["errors"][0]["reason"])

    def test_a_partial_read_carries_no_events(self):
        environment = self.environment()
        config = load_config(self.config_file(), environ=environment)
        reading = snapshot.read_snapshot(config, now=NOW, only=["trials"])
        self.assertNotIn("events", reading)

    def test_the_read_command_prints_the_events(self):
        completed = subprocess.run(
            [sys.executable, str(Path(snapshot.__file__)), "--config", str(self.config_file()),
             "--now", str(NOW)],
            capture_output=True, text=True, check=False, env=self.environment(),
            cwd=str(self.root))
        self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        document = json.loads(completed.stdout)["events"]
        self.assertEqual([event["kind"] for event in document["events"]],
                         ["trial-failed", "pr-opened", "job-finished", "trial-passed"])


if __name__ == "__main__":
    unittest.main()
