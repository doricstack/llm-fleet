#!/usr/bin/env python3
"""Read-command behavior: every reader's document is present, whatever happens.

The command is what a view layer calls, so the cases here are about its contract
rather than about any one reader: a source that fails keeps its slot with a
reason, and a configuration that is refused comes back as a result with every
error rather than as a traceback.
"""

import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import roster, snapshot


STORES = """
CREATE TABLE repos (repo_id INTEGER PRIMARY KEY, remote_url TEXT, root_oid TEXT);
CREATE TABLE changes (change_id INTEGER PRIMARY KEY, repo_id INTEGER, branch TEXT,
                      state TEXT, worktree_path TEXT);
CREATE TABLE leases (change_id INTEGER, tool TEXT, expires_at REAL, session TEXT);
CREATE TABLE receipts (receipt_id TEXT, change_id INTEGER, evidence TEXT, created_at REAL);
CREATE TABLE milestones (change_id INTEGER, session TEXT, created_at REAL, to_state TEXT);
"""


class SnapshotCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-snapshot-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.config_file = self.root / "config.json"

    def config(self, document):
        self.config_file.write_text(json.dumps(document), encoding="utf-8")
        return load_config(self.config_file, environ=sandbox.home_environment(self.root))

    def run_command(self, *arguments, cwd=None):
        completed = __import__("subprocess").run(
            [sys.executable, str(Path(snapshot.__file__)), *arguments],
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True, text=True, check=False)
        return completed.returncode, completed.stdout

    def test_the_command_reads_the_machine_from_a_working_directory_of_its_own(self):
        # The host runs this command by path, from a working directory that has
        # nothing to do with the tree. A reader that leans on the working
        # directory dies with an import error, and the pane reports a machine it
        # could not read, which is exactly what happened in a live session.
        self.config({"providers": []})
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        completed = __import__("subprocess").run(
            [sys.executable, str(Path(snapshot.__file__)), "--config", str(self.config_file),
             "--now", "1700000000"],
            cwd=str(elsewhere), capture_output=True, text=True, check=False)
        self.assertNotIn("Traceback", completed.stderr)
        self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        document = json.loads(completed.stdout)
        for name in ("generated_at", "roster", "trials", "progress", "prs", "skills", "worktrees",
                     "load"):
            self.assertIn(name, document)
        self.assertEqual(document["generated_at"], 1_700_000_000.0)

    def test_every_document_is_present_when_everything_is_off(self):
        result = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)
        self.assertEqual(sorted(result), ["alerts", "band", "custom", "events", "generated_at",
                                          "load", "pane", "progress", "prs", "roster",
                                          "session", "skills", "trials", "worktrees"])
        # Nothing was read, so the digest holds nothing and says which sources
        # it could not see.
        self.assertEqual(result["events"], {
            "state": "empty", "events": [], "errors": [],
            "sources": {"trials": "disabled", "prs": "disabled", "roster": "unavailable"}})
        # The job roster is on by default, so with no provider home configured it
        # is unavailable rather than switched off; the rest are off by default.
        self.assertEqual(result["roster"]["state"], "unavailable")
        for name in ("trials", "progress", "prs", "skills", "worktrees", "load", "custom"):
            self.assertEqual(result[name]["state"], "disabled", name)
            self.assertEqual(result[name]["errors"], [], name)

    def test_the_pane_configuration_travels_with_the_reading(self):
        # The plugin has no configuration file of its own to read, so these are
        # the only values that can decide what it draws. A pane that never sees
        # them draws the packaged default over whatever a person configured.
        result = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)
        pane = result["pane"]
        self.assertEqual(pane["state"], "ready")
        # Pull requests lead, and the rest follow by how much they need a
        # person; the warnings come last and keep out of sight while empty.
        self.assertEqual(pane["order"],
                         ["load", "prs", "sessions", "trials", "running", "session",
                          "worktrees", "skills", "warnings", "keys"])
        self.assertEqual(pane["sections"]["warnings"]["hideWhenEmpty"], True)
        self.assertEqual(pane["sections"]["prs"]["hideWhenEmpty"], False)
        worktrees = pane["sections"]["worktrees"]
        self.assertEqual((worktrees["visible"], worktrees["collapsed"]), (True, True))
        sessions = pane["sections"]["sessions"]
        self.assertEqual((sessions["visible"], sessions["collapsed"]), (True, False))
        # The legend travels too. It is prose the pane draws under a heading, and
        # a section whose legend stayed in the configuration draws its counts
        # with nothing saying what they count.
        self.assertEqual(worktrees["legend"],
                         "Worktree preservation state. A cleanup command can be copied; "
                         "fleet does not run it.")
        self.assertIn("sessions", sessions["legend"])

    def test_a_person_s_own_pane_choices_are_the_ones_that_travel(self):
        config = self.config({"pane": {
            "sectionOrder": ["warnings", "sessions"],
            "sections": {"sessions": {"visible": False, "collapsed": True},
                         "warnings": {"visible": True, "collapsed": True}}}})
        pane = snapshot.read_snapshot(config, now=1_700_000_000.0)["pane"]
        # The order a person chose, not the packaged one: the pane reads its
        # sections out of this list.
        self.assertEqual(pane["order"], ["warnings", "sessions"])
        for name, collapsed in (("sessions", True), ("warnings", True)):
            self.assertEqual(pane["sections"][name]["visible"], name != "sessions")
            self.assertEqual(pane["sections"][name]["collapsed"], collapsed)

    def test_a_configuration_carrying_no_pane_section_still_travels(self):
        # `pane` with nothing under it is a document a view layer can read, not
        # a missing key: a pane that found nothing here would fall back to the
        # packaged defaults, which is a different answer from "nothing is set".
        pane = snapshot.pane_document({})
        self.assertEqual(pane["state"], "ready")
        self.assertEqual(pane["order"], [])
        self.assertEqual(pane["sections"], {})
        # The keys travel as their own block, and a configuration carrying none
        # names none: the pane's fallback for an unnamed key is its packaged
        # default, so a value invented here would be one it could not tell from
        # a person's own choice.
        self.assertEqual(pane["keys"],
                         {"tipsEnabled": True, "tips": [], "close": None,
                          "collapse": None, "expand": None})
        # The measurements travel as their own block for the same reason: the
        # surface takes the width from them, and a pane drawing at its own
        # numbers is one whose declared settings nobody honours.
        self.assertEqual(pane["geometry"],
                         {"minimumColumns": None, "horizontalReserve": None,
                          "progressCells": None, "skillRows": None, "fanLines": None})

    def test_the_measurements_and_titles_the_pane_draws_with_travel(self):
        config = self.config({"pane": {"minimumColumns": 30, "horizontalReserve": 4,
                                       "progressCells": 24, "skillRows": 2,
                                       "sections": {"sessions": {"title": "Sessions",
                                                                 "visible": True,
                                                                 "collapsed": False}}}})
        pane = snapshot.read_snapshot(config, now=1_700_000_000.0)["pane"]
        self.assertEqual(pane["geometry"], {"minimumColumns": 30, "horizontalReserve": 4,
                                            "progressCells": 24, "skillRows": 2, "fanLines": 4})
        self.assertEqual(pane["sections"]["sessions"]["title"], "Sessions")

    def test_how_alerts_are_raised_travels_with_the_reading(self):
        # The plugin has no configuration file to read, so a toast switched off
        # here is switched off there only if the reading carries it.
        config = self.config({"alerts": {"toast": False, "notify": False, "toastMs": 1500},
                              "refresh": {"snapshotMs": 45000},
                              "timeouts": {"synthesisMs": 9000}})
        alerts = snapshot.read_snapshot(config, now=1_700_000_000.0)["alerts"]
        self.assertEqual(alerts, {"state": "ready", "toast": False, "notify": False,
                                  "toastMs": 1500, "snapshotMs": 45000, "synthesisMs": 9000,
                                  "snapshotSeconds": 20, "progressMs": 1000,
                                  "copyToastMs": 6000,
                                  "tabTint": {"enabled": True, "staleSeconds": 120},
                                  "tabCommandMs": 5000, "keyTipMs": 30000,
                                  "helperMs": 25000, "worktreeHelperMs": 60000,
                                  "clockMs": 1000, "streamStepMs": 150})
        defaults = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)["alerts"]
        # Each session looks at the shared reading every few seconds; the machine
        # is read when that reading is older than its cache allows.
        self.assertEqual((defaults["toast"], defaults["notify"], defaults["toastMs"],
                          defaults["snapshotMs"], defaults["synthesisMs"],
                          defaults["snapshotSeconds"], defaults["progressMs"]),
                         (True, True, 8000, 3000, 30000, 20, 1000))
        tuned = snapshot.read_snapshot(self.config({"cache": {"snapshotSeconds": 45},
                                                    "refresh": {"progressMs": 2500}}),
                                       now=1_700_000_000.0)["alerts"]
        self.assertEqual((tuned["snapshotSeconds"], tuned["progressMs"]), (45, 2500))
        # How often an open pane is drawn so its ages count, and how far apart a
        # new reading's changed sections land, reach the plugin only this way.
        paced = snapshot.read_snapshot(self.config({"refresh": {"clockMs": 500,
                                                                "streamStepMs": 90}}),
                                       now=1_700_000_000.0)["alerts"]
        self.assertEqual((paced["clockMs"], paced["streamStepMs"]), (500, 90))

    def test_the_tab_tint_and_the_key_tip_interval_travel_with_the_reading(self):
        # The plugin decides when to tell the tab helper its level and moves the
        # key tip on, with no configuration file of its own: what is set here
        # reaches it only in the reading. The colors are the helper's, which
        # reads the configuration itself, so the reading does not carry them.
        config = self.config({"alerts": {"tabTint": {"enabled": False, "failureRgb": [1, 2, 3],
                                                     "waitingRgb": [4, 5, 6], "staleSeconds": 300}},
                              "timeouts": {"tabCommandMs": 750},
                              "refresh": {"keyTipMs": 4500}})
        alerts = snapshot.read_snapshot(config, now=1_700_000_000.0)["alerts"]
        self.assertEqual(alerts["tabTint"], {"enabled": False, "staleSeconds": 300})
        self.assertEqual((alerts["tabCommandMs"], alerts["keyTipMs"]), (750, 4500))

    def test_the_read_times_travel_with_the_reading(self):
        # The plugin runs the read of the whole machine, and the slower one that
        # probes every worktree now, with no configuration file of its own: the
        # times it gives each come only in the reading.
        config = self.config({"timeouts": {"helperMs": 4000, "worktreeHelperMs": 90000}})
        alerts = snapshot.read_snapshot(config, now=1_700_000_000.0)["alerts"]
        self.assertEqual((alerts["helperMs"], alerts["worktreeHelperMs"]), (4000, 90000))
        defaults = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)["alerts"]
        self.assertEqual((defaults["helperMs"], defaults["worktreeHelperMs"]), (25000, 60000))

    def test_the_theme_travels_with_the_pane(self):
        # The pane and the band draw inside a plugin with no configuration file
        # of their own, so the tones reach them only in the reading.
        config = self.config({"theme": {"working": "claude", "worktrees": {"held": "failure"}}})
        theme = snapshot.read_snapshot(config, now=1_700_000_000.0)["pane"]["theme"]
        self.assertEqual(theme["working"], "claude")
        self.assertEqual(theme["failure"], "error")
        self.assertEqual(theme["worktrees"]["held"], "failure")
        self.assertEqual(theme["worktrees"]["active"], "working")
        self.assertEqual(sorted(theme), ["failure", "idle", "waiting", "working", "worktrees"])

    def test_the_settings_read_runs_no_reader(self):
        # A session that never held a reading learns its read times from this
        # answer first, so it must come back without waiting on any source.
        original = dict(snapshot.READERS)

        def refuses(config, **_):
            raise AssertionError("a reader ran during the settings read")

        snapshot.READERS.clear()
        snapshot.READERS.update({"worktrees": refuses, "trials": refuses})
        try:
            config = self.config({"timeouts": {"helperMs": 4000, "worktreeHelperMs": 90000}})
            read = snapshot.read_snapshot(config, now=1_700_000_000.0, settings=True)
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)
        self.assertEqual(sorted(read), ["alerts", "band", "generated_at", "pane"])
        self.assertEqual((read["alerts"]["helperMs"], read["alerts"]["worktreeHelperMs"]),
                         (4000, 90000))

    def test_the_command_prints_the_settings_alone_and_refuses_a_reader_with_them(self):
        self.config({"providers": []})
        code, output = self.run_command("--config", str(self.config_file), "--now", "1700000000",
                                        "--settings")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(json.loads(output)), ["alerts", "band", "generated_at", "pane"])
        for extra in (["--only", "worktrees"], ["--refresh-worktrees"]):
            code, output = self.run_command("--config", str(self.config_file), "--settings", *extra)
            self.assertEqual(code, 2)
            self.assertEqual(output, "")

    def test_worktrees_are_probed_now_only_when_asked(self):
        # `/worktrees` asks how the worktrees stand now, so the read it runs
        # passes the worktree reader its refresh; every other read leaves the
        # cache to decide, and no other reader is handed a refresh it never took.
        original = dict(snapshot.READERS)
        seen: dict[str, dict] = {}

        def worktrees(config, *, now=None, refresh=False):
            seen["worktrees"] = {"refresh": refresh}
            return {"state": "empty", "worktrees": []}

        def other(config, *, now=None, refresh=False):
            seen["other"] = {"refresh": refresh}
            return {"state": "empty"}

        snapshot.READERS.clear()
        snapshot.READERS.update({"worktrees": worktrees, "trials": other})
        try:
            snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)
            self.assertEqual(seen, {"worktrees": {"refresh": False}, "other": {"refresh": False}})
            snapshot.read_snapshot(self.config({}), now=1_700_000_000.0, refresh_worktrees=True)
            self.assertEqual(seen, {"worktrees": {"refresh": True}, "other": {"refresh": False}})
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)

    def test_the_command_takes_the_worktree_probe_flag(self):
        self.config({"providers": []})
        code, output = self.run_command("--config", str(self.config_file), "--now", "1700000000",
                                        "--only", "worktrees", "--refresh-worktrees")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(json.loads(output)), ["generated_at", "worktrees"])
    def test_what_the_band_shows_and_keeps_travels_with_the_reading(self):
        # The band draws inside a plugin with no configuration file of its own,
        # so how long a waiting job stays on it and how many dismissals it keeps
        # reach it only through the reading.
        band = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)["band"]
        self.assertEqual(band, {"state": "ready", "hiddenLimit": 200,
                                "waitingJobSeconds": 86400})
        tuned = snapshot.read_snapshot(
            self.config({"band": {"hiddenLimit": 7, "waitingJobSeconds": 600}}),
            now=1_700_000_000.0)["band"]
        self.assertEqual((tuned["hiddenLimit"], tuned["waitingJobSeconds"]), (7, 600))
        # A read of one source alone is merged into a whole reading and carries
        # no configuration, as the pane's and the alerts' do not.
        alone = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0, only=["progress"])
        self.assertNotIn("band", alone)

    def test_an_empty_section_order_travels_as_the_empty_order_it_is(self):
        # The schema resolves an empty subset, so this is a configuration
        # somebody can write. What the pane draws from it is no sections at all
        # rather than all eight: the document is present and it says nothing is
        # placed, which is not the same document as an absent one.
        pane = snapshot.pane_document({"pane": {"sectionOrder": [],
                                                "sections": {"sessions": {"visible": True,
                                                                          "collapsed": False}}}})
        self.assertEqual(pane["order"], [])
        self.assertEqual(pane["sections"]["sessions"],
                         {"title": None, "visible": True, "collapsed": False,
                          "legend": None, "hideWhenEmpty": False, "maxRows": None})

    def test_a_section_s_row_limit_travels_with_the_reading(self):
        pane = snapshot.pane_document(self.config({"pane": {"sections": {"trials": {"maxRows": 3}}}}))
        self.assertEqual(pane["sections"]["trials"]["maxRows"], 3)
        # Every other section keeps the declared default.
        self.assertEqual(pane["sections"]["prs"]["maxRows"], 8)
        self.assertEqual(pane["sections"]["warnings"]["maxRows"], 8)

    def test_the_reply_memory_and_the_copy_toast_travel_with_the_reading(self):
        # The plugin has no file of its own to read, so these two settings reach
        # it with the reading or not at all.
        defaults = self.config({})
        self.assertEqual(snapshot.pane_document(defaults)["repliedLimit"], 50)
        self.assertEqual(snapshot.alerts_document(defaults)["copyToastMs"], 6000)
        chosen = self.config({"pane": {"repliedLimit": 3}, "alerts": {"copyToastMs": 1500}})
        self.assertEqual(snapshot.pane_document(chosen)["repliedLimit"], 3)
        self.assertEqual(snapshot.alerts_document(chosen)["copyToastMs"], 1500)

    def test_the_reply_bounds_and_the_task_lines_travel_with_the_reading(self):
        defaults = snapshot.pane_document(self.config({}))
        self.assertEqual((defaults["replyMaxChars"], defaults["replyPendingSeconds"],
                          defaults["geometry"]["fanLines"]), (4000, 120, 4))
        chosen = snapshot.pane_document(self.config({"pane": {"replyMaxChars": 12, "fanLines": 0,
                                                               "replyPendingSeconds": 30}}))
        self.assertEqual((chosen["replyMaxChars"], chosen["replyPendingSeconds"],
                          chosen["geometry"]["fanLines"]), (12, 30, 0))

    def test_the_keys_the_pane_honours_travel_with_the_reading(self):
        # The pane's own section lists these beside the controls that carry
        # them, so a reading that dropped them would draw a keys section
        # describing the packaged bindings over a configuration that changed
        # them, which is a pane telling a person the wrong key.
        config = self.config({"keys": {"tipsEnabled": False, "tips": [],
                                       "close": "q", "collapse": "z", "expand": "a"}})
        keys = snapshot.read_snapshot(config, now=1_700_000_000.0)["pane"]["keys"]
        self.assertEqual(keys, {"tipsEnabled": False, "tips": [], "close": "q",
                                "collapse": "z", "expand": "a"})

    def test_a_reader_is_handed_only_what_its_own_signature_takes(self):
        # A reader with no clock in its work, or none of it reading the filesystem
        # a home shortens, was being handed both and failing on the argument it
        # never wanted. Its slot then read as a source that broke rather than as
        # one nobody asked, which is the difference between a pane saying "could
        # not read this" and a pane saying "this was switched off".
        original = dict(snapshot.READERS)
        seen: list[dict] = []

        def plain(config):
            seen.append({})
            return {"state": "ready"}

        def clocked(config, *, now=None):
            seen.append({"now": now})
            return {"state": "ready"}

        def located(config, *, now=None, home=None):
            seen.append({"now": now, "home": str(home)})
            return {"state": "ready"}

        snapshot.READERS.clear()
        snapshot.READERS.update({"roster": plain, "trials": clocked, "skills": located})
        try:
            result = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)
        self.assertEqual(seen, [{}, {"now": 1_700_000_000.0},
                                {"now": 1_700_000_000.0, "home": "None"}])
        for name in ("roster", "trials", "skills"):
            self.assertEqual(result[name]["state"], "ready", name)
        # A home the caller named is the one the reader receives, so the path a
        # row displays is shortened against what the caller asked for rather than
        # against whatever this command happens to run under.
        seen.clear()
        snapshot.READERS.clear()
        snapshot.READERS.update({"skills": located})
        named = Path("some-home")
        try:
            snapshot.read_snapshot(self.config({}), now=1_700_000_000.0, home=named)
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)
        # Compared against the shape this platform puts a path in rather than
        # against a literal: a separator written into the expectation is a case
        # that passes where it was written and fails on the other runner.
        self.assertEqual(seen, [{"now": 1_700_000_000.0, "home": str(named)}])

    def test_a_reader_that_raises_keeps_its_slot_and_names_itself(self):
        original = dict(snapshot.READERS)

        def explode(config, **kwargs):
            raise RuntimeError("the store moved")

        snapshot.READERS["trials"] = explode
        try:
            result = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0)
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)
        self.assertEqual(result["trials"]["state"], "failed")
        self.assertEqual(result["trials"]["running"], [])
        self.assertEqual(result["trials"]["errors"],
                         [{"source": "trials", "reason": "RuntimeError: the store moved"}])
        # The other documents are untouched by one reader failing.
        self.assertEqual(result["prs"]["state"], "disabled")

    def test_a_failing_document_still_carries_the_keys_a_view_model_reads(self):
        for name in ("roster", "trials", "progress", "prs", "skills", "worktrees", "custom"):
            body = snapshot.failed(name, "for this test")
            self.assertEqual(body["state"], "failed", name)
            self.assertEqual(body["errors"], [{"source": name, "reason": "for this test"}], name)
        self.assertEqual(snapshot.failed("roster", "x")["interactive"], {})
        self.assertEqual(snapshot.failed("skills", "x")["running"], None)
        self.assertIsNone(snapshot.failed("worktrees", "x")["cleaned"])
        # A custom document holds its sections by name, so a failed one holds none.
        self.assertEqual(snapshot.failed("custom", "x")["sections"], {})

    def test_a_real_bad_store_fails_the_source_without_taking_the_document_away(self):
        broken = self.root / "changes.db"
        broken.write_text("this is not a database", encoding="utf-8")
        config = self.config({"sources": {"trials": {"enabled": True, "database": str(broken)}}})
        result = snapshot.read_snapshot(config, now=1_700_000_000.0)
        self.assertEqual(result["trials"]["state"], "failed")
        self.assertEqual(len(result["trials"]["errors"]), 1)
        self.assertEqual(result["prs"]["state"], "disabled")

    def test_a_readable_machine_reports_rows(self):
        database = self.root / "changes.db"
        with sqlite3.connect(database) as connection:
            connection.executescript(STORES)
            connection.execute("INSERT INTO repos VALUES (1, ?, ?)",
                               ("https://example.invalid/owner/example-repo.git", "abc"))
            connection.execute("INSERT INTO changes VALUES (1, 1, 'feat/one', 'TRYING', NULL)")
            connection.execute("INSERT INTO leases VALUES (1, 'codex', ?, 'abcdef12-rest')",
                               (1_700_000_100.0,))
        config = self.config({"sources": {"trials": {"enabled": True, "database": str(database)}}})
        result = snapshot.read_snapshot(config, now=1_700_000_000.0)
        self.assertEqual(result["trials"]["state"], "ready")
        self.assertEqual([lease["branch"] for lease in result["trials"]["running"]], ["feat/one"])

    def test_the_command_prints_one_object_and_succeeds(self):
        self.config({"providers": []})
        code, output = self.run_command("--config", str(self.config_file), "--now", "1700000000")
        self.assertEqual(code, 0)
        document = json.loads(output)
        self.assertIn("roster", document)
        self.assertEqual(document["generated_at"], 1_700_000_000.0)

    def test_a_read_of_one_source_runs_that_reader_alone(self):
        # The pane asks for the governor's counts every few seconds while a run
        # is live. A read that ran every reader for that would ask the pull
        # request host and every worktree each time, so the other readers are
        # not run at all: a reader that would raise is never reached.
        original = dict(snapshot.READERS)
        called: list[str] = []

        def explode(config, **kwargs):
            raise AssertionError("a reader nobody asked for was run")

        for name in snapshot.READERS:
            if name != "progress":
                snapshot.READERS[name] = explode
        real = original["progress"]

        def progress(config, **kwargs):
            called.append("progress")
            return real(config, **kwargs)

        snapshot.READERS["progress"] = progress
        try:
            result = snapshot.read_snapshot(self.config({}), now=1_700_000_000.0,
                                            only=["progress"])
        finally:
            snapshot.READERS.clear()
            snapshot.READERS.update(original)
        self.assertEqual(sorted(result), ["generated_at", "progress"])
        self.assertEqual(called, ["progress"])
        self.assertEqual(result["generated_at"], 1_700_000_000.0)

    def test_the_command_reads_one_source_when_asked(self):
        self.config({"providers": []})
        code, output = self.run_command("--config", str(self.config_file), "--now", "1700000000",
                                        "--only", "progress")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(json.loads(output)), ["generated_at", "progress"])

    def test_a_source_nobody_reads_is_refused_rather_than_read_as_nothing(self):
        # An empty document under a misspelled name would draw as a source with
        # nothing in it.
        self.config({"providers": []})
        code, output = self.run_command("--config", str(self.config_file), "--only", "progres")
        self.assertEqual(code, 2)
        self.assertEqual(output, "")

    def test_a_refused_configuration_is_a_result_and_exits_two(self):
        path = self.root / "bad.json"
        path.write_text(json.dumps({"stateDirr": "/quiet/state"}), encoding="utf-8")
        code, output = self.run_command("--config", str(path))
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output)["configErrors"],
                         [{"code": "E_CONFIG_UNKNOWN_KEY", "path": "stateDirr"}])

    def test_a_configuration_that_is_not_there_is_reported_the_same_way(self):
        code, output = self.run_command("--config", str(self.root / "absent.json"))
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output)["configErrors"][0]["code"], "E_CONFIG_FILE_NOT_FOUND")

    def test_the_home_a_displayed_path_is_shortened_against_can_be_named(self):
        config = self.config({"sources": {"skills": {"enabled": True,
                                                     "directory": str(self.root)}}})
        (self.root / "summary.json").write_text(json.dumps({"targets": [
            {"target": str(self.root / "skills" / "one"), "verdict": "issues"}]}), encoding="utf-8")
        result = snapshot.read_snapshot(config, now=1_700_000_000.0, home=self.root)
        self.assertEqual(result["skills"]["items"][0]["target"],
                         os.path.join("~", "skills", "one"))


ROSTER_STUB = """\
import os
from pathlib import Path
rows = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "rows.json"
print(rows.read_text(encoding="utf-8") if rows.exists() else "[]")
"""

FIRST = 1_700_000_000.0


def iso(seconds, digits=3):
    """Epoch seconds as UTC ISO text: with milliseconds as a job file holds a time,
    or to the second as an event states one."""
    from datetime import datetime, timezone
    moment = datetime.fromtimestamp(seconds, timezone.utc)
    spec = "milliseconds" if digits else "seconds"
    return moment.isoformat(timespec=spec).replace("+00:00", "Z")


class KeptEntryTests(unittest.TestCase):
    """A kept job state is read from a file anything could have written."""

    NOW = 1_700_000_000.0

    def kept(self, **overrides):
        value = {"provider": "claude", "id": "job-1", "state": "blocked",
                 "since": self.NOW - 60, "entered_at": self.NOW - 30}
        value.update(overrides)
        return roster._entry(value, self.NOW)

    def test_a_number_too_large_for_a_float_is_no_kept_state(self):
        # Four hundred digits pass a type check and then fail the conversion a
        # finite check makes: raised, that failed the whole roster on every read.
        huge = 10 ** 400
        self.assertIsNone(self.kept(since=huge))
        self.assertIsNone(self.kept(since=-huge))
        entry = self.kept(entered_at=huge)
        self.assertIsNotNone(entry)
        self.assertIsNone(entry["entered_at"])
        self.assertEqual(entry["since"], self.NOW - 60)

    def test_a_good_entry_keeps_both_times(self):
        entry = self.kept()
        self.assertEqual((entry["since"], entry["entered_at"]), (self.NOW - 60, self.NOW - 30))
        self.assertIsNone(self.kept(since=float("inf")))
        self.assertIsNone(self.kept(entered_at=float("nan"))["entered_at"])


class JobStateTests(unittest.TestCase):
    """When a job entered its state outlives the process that read it.

    The read command is a fresh process every time a session reads the machine,
    so what an earlier read saw can only reach the next one through the state
    directory. Without it, every whole read dated each live job from that read:
    a waiting job's alert key changed every twenty seconds, so it was raised
    again, a dismissal of it did not hold, and its age never showed.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-job-states-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.home = self.root / "homes" / "one"
        self.home.mkdir(parents=True)
        self.stub = self.root / "stub.py"
        self.stub.write_text(ROSTER_STUB, encoding="utf-8")
        self.state = self.root / "state"
        self.record = self.state / roster.RECORDS / roster.JOB_STATES_NAME

    def config(self, **document):
        body = {"stateDir": str(self.state),
                "providers": [{"id": "one", "home": str(self.home)}],
                "commands": {"claude": [sys.executable, str(self.stub)]},
                "sources": {"agents": {"enabled": False}}}
        body.update(document)
        path = self.root / "config.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        return load_config(path, environ=sandbox.home_environment(self.root))

    def rows(self, *states):
        rows = [{"id": "job-" + str(index), "kind": "background", "name": "Job " + str(index),
                 "state": state, "cwd": "/tmp/work", "startedAt": 1_699_999_000_000,
                 "sessionId": "s-" + str(index)} for index, state in enumerate(states)]
        (self.home / "rows.json").write_text(json.dumps(rows), encoding="utf-8")

    def since(self, now, config=None):
        result = snapshot.read_snapshot(config or self.config(), now=now)
        self.assertEqual(result["roster"]["state"], "ready", result["roster"]["errors"])
        return {job["id"]: job["since"] for job in result["roster"]["jobs"]}

    def job_file(self, job_id, **state):
        """The job's own state file, its times written as the host writes them."""
        body = {key: (iso(value) if isinstance(value, float) else value)
                for key, value in state.items()}
        folder = self.home / "jobs" / job_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").write_text(json.dumps(body), encoding="utf-8")

    def entered(self, now, config=None):
        """Each job's transition time, and the job events the same read's digest holds."""
        result = snapshot.read_snapshot(config or self.config(), now=now)
        self.assertEqual(result["roster"]["state"], "ready", result["roster"]["errors"])
        times = {job["id"]: job["entered_at"] for job in result["roster"]["jobs"]}
        found = {event["ref"]: (event["kind"], event["at"])
                 for event in result["events"]["events"] if event["kind"].startswith("job-")}
        return times, found

    def test_a_job_first_seen_waiting_is_dated_by_its_own_file(self):
        self.rows("blocked")
        self.job_file("job-0", state="blocked", updatedAt=FIRST - 300)
        times, found = self.entered(FIRST)
        self.assertEqual(times, {"job-0": FIRST - 300})
        self.assertEqual(found, {"one:job-0": ("job-waiting", iso(FIRST - 300, 0))})

    def test_a_job_first_seen_waiting_with_no_recorded_time_has_none(self):
        # Nobody saw it begin to wait, so the read that first saw it is no time
        # for the digest to call new, on this read or any later one.
        self.rows("blocked")
        for now in (FIRST, FIRST + 20):
            times, found = self.entered(now)
            self.assertEqual(times, {"job-0": None})
            self.assertEqual(found, {})

    def test_a_job_seen_to_begin_waiting_is_dated_by_that_read_across_reads(self):
        self.rows("working")
        self.entered(FIRST)
        self.rows("blocked")
        self.assertEqual(self.entered(FIRST + 20)[0], {"job-0": FIRST + 20})
        times, found = self.entered(FIRST + 40)
        self.assertEqual(times, {"job-0": FIRST + 20})
        self.assertEqual(found, {"one:job-0": ("job-waiting", iso(FIRST + 20, 0))})

    def test_a_finished_job_is_dated_by_its_files_finish(self):
        self.rows("done")
        self.job_file("job-0", state="done", lastTerminalAt=FIRST - 100, updatedAt=FIRST - 90)
        times, found = self.entered(FIRST)
        self.assertEqual(times, {"job-0": FIRST - 100})
        self.assertEqual(found, {"one:job-0": ("job-finished", iso(FIRST - 100, 0))})

    def test_a_dated_wait_keeps_its_date_while_the_file_is_rewritten(self):
        self.rows("blocked")
        self.job_file("job-0", state="blocked", updatedAt=FIRST - 300)
        self.assertEqual(self.entered(FIRST)[0], {"job-0": FIRST - 300})
        # The job writes its file again and is still waiting: the same wait is
        # not news a second time.
        self.job_file("job-0", state="blocked", updatedAt=FIRST + 10)
        times, found = self.entered(FIRST + 20)
        self.assertEqual(times, {"job-0": FIRST - 300})
        self.assertEqual(found, {"one:job-0": ("job-waiting", iso(FIRST - 300, 0))})

    def test_a_wait_first_seen_undated_is_not_dated_by_a_later_rewrite(self):
        self.rows("blocked")
        self.assertEqual(self.entered(FIRST)[0], {"job-0": None})
        # Written after a read already saw the job waiting, so it is not when
        # the wait began.
        self.job_file("job-0", state="blocked", updatedAt=FIRST + 10)
        times, found = self.entered(FIRST + 20)
        self.assertEqual(times, {"job-0": None})
        self.assertEqual(found, {})

    def test_a_new_wait_after_working_takes_a_new_date(self):
        self.rows("blocked")
        self.job_file("job-0", state="blocked", updatedAt=FIRST - 300)
        self.entered(FIRST)
        self.rows("working")
        self.job_file("job-0", state="working", updatedAt=FIRST + 15)
        self.entered(FIRST + 20)
        self.rows("blocked")
        self.job_file("job-0", state="blocked", updatedAt=FIRST + 30)
        self.assertEqual(self.entered(FIRST + 40)[0], {"job-0": FIRST + 30})

    def test_a_file_older_than_the_change_a_read_saw_does_not_date_the_new_wait(self):
        # The file still holds an earlier wait; a read saw the job working
        # since, so that wait is over and the new one began after it.
        self.job_file("job-0", state="blocked", updatedAt=FIRST - 300)
        self.rows("working")
        self.entered(FIRST)
        self.rows("blocked")
        times, found = self.entered(FIRST + 20)
        self.assertEqual(times, {"job-0": FIRST + 20})
        self.assertEqual(found, {"one:job-0": ("job-waiting", iso(FIRST + 20, 0))})

    def test_a_job_first_seen_finished_is_kept_by_its_finish_not_its_start(self):
        # Started 1000 seconds ago, past a 600-second finished window, but it
        # finished a minute ago: it is a recent finish.
        config = self.config(history={"finishedJobSeconds": 600})
        self.rows("done")
        self.job_file("job-0", state="done", lastTerminalAt=FIRST - 60)
        times, found = self.entered(FIRST, config)
        self.assertEqual(times, {"job-0": FIRST - 60})
        self.assertEqual(found, {"one:job-0": ("job-finished", iso(FIRST - 60, 0))})

    def test_a_file_that_disagrees_with_the_registry_or_the_clock_dates_nothing(self):
        self.rows("blocked", "blocked", "blocked")
        # The file still says working: its times are not when the job began to wait.
        self.job_file("job-0", state="working", updatedAt=FIRST - 300)
        # A time well past the read was not written by this machine's clock.
        self.job_file("job-1", state="blocked", updatedAt=FIRST + 3600)
        self.job_file("job-2", state="blocked", updatedAt="yesterday")
        times, found = self.entered(FIRST)
        self.assertEqual(times, {"job-0": None, "job-1": None, "job-2": None})
        self.assertEqual(found, {})

    def test_a_state_that_holds_keeps_the_time_it_began_across_reads(self):
        self.rows("blocked", "working")
        self.assertEqual(self.since(FIRST), {"job-0": FIRST, "job-1": FIRST})
        self.assertEqual(self.since(FIRST + 20), {"job-0": FIRST, "job-1": FIRST})
        self.assertEqual(self.since(FIRST + 40), {"job-0": FIRST, "job-1": FIRST})

    def test_a_changed_state_starts_at_the_read_that_saw_it_change(self):
        self.rows("working")
        self.since(FIRST)
        self.rows("blocked")
        self.assertEqual(self.since(FIRST + 20), {"job-0": FIRST + 20})
        self.assertEqual(self.since(FIRST + 40), {"job-0": FIRST + 20})

    def test_states_are_kept_across_processes_by_the_read_command(self):
        self.rows("blocked")
        self.config()
        for now in (FIRST, FIRST + 20):
            completed = __import__("subprocess").run(
                [sys.executable, str(Path(snapshot.__file__)), "--config",
                 str(self.root / "config.json"), "--now", str(now), "--only", "roster"],
                capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        self.assertEqual(json.loads(completed.stdout)["roster"]["jobs"][0]["since"], FIRST)

    def test_a_read_of_other_sources_alone_leaves_the_record_alone(self):
        self.rows("blocked")
        self.since(FIRST)
        before = self.record.read_bytes()
        snapshot.read_snapshot(self.config(), now=FIRST + 20, only=["progress"])
        self.assertEqual(self.record.read_bytes(), before)

    def test_a_corrupt_record_is_ignored_and_written_over(self):
        self.record.parent.mkdir(parents=True)
        self.record.write_text("{ not json", encoding="utf-8")
        self.rows("blocked")
        self.assertEqual(self.since(FIRST), {"job-0": FIRST})
        self.assertEqual(self.since(FIRST + 20), {"job-0": FIRST})

    def test_a_record_of_the_wrong_shape_is_ignored(self):
        self.record.parent.mkdir(parents=True)
        self.rows("blocked")
        for document in ([1, 2], {"jobs": "no"}, {"jobs": [None, 3, "x"]}):
            self.record.write_text(json.dumps(document), encoding="utf-8")
            self.assertEqual(self.since(FIRST + 5), {"job-0": FIRST + 5}, document)
            self.record.unlink()

    def test_an_entry_that_could_not_have_been_written_is_ignored(self):
        # A time not yet reached, a time that is a flag, and an identifier that
        # could climb out of a home are each refused one by one, not believed.
        self.record.parent.mkdir(parents=True)
        self.rows("blocked", "blocked", "blocked")
        self.record.write_text(json.dumps({"jobs": [
            {"provider": "one", "id": "job-0", "state": "blocked", "since": FIRST + 999},
            {"provider": "one", "id": "job-1", "state": "blocked", "since": True},
            {"provider": "one", "id": "../job-2", "state": "blocked", "since": FIRST - 50},
            {"provider": "one", "id": "job-2", "state": "blocked", "since": FIRST - 60},
            # A provider this read did not reach keeps its entries, and only
            # the ones a read could have written.
            {"provider": "away", "id": "../climb", "state": "blocked", "since": FIRST - 70},
            {"provider": "away", "id": "stays", "state": "blocked", "since": FIRST - 80},
        ]}), encoding="utf-8")
        self.assertEqual(self.since(FIRST),
                         {"job-0": FIRST, "job-1": FIRST, "job-2": FIRST - 60})
        kept = json.loads(self.record.read_text(encoding="utf-8"))["jobs"]
        self.assertEqual(sorted((entry["provider"], entry["id"]) for entry in kept),
                         [("away", "stays"), ("one", "job-0"), ("one", "job-1"), ("one", "job-2")])

    def test_an_oversized_record_is_ignored(self):
        self.record.parent.mkdir(parents=True)
        entry = {"provider": "one", "id": "job-0", "state": "blocked", "since": FIRST - 600}
        self.record.write_text(json.dumps({"jobs": [entry], "pad": "x" * 2048}), encoding="utf-8")
        self.rows("blocked")
        config = self.config(limits={"jobStateBytes": 1024})
        self.assertEqual(self.since(FIRST, config), {"job-0": FIRST})

    def test_a_linked_record_is_not_followed(self):
        self.record.parent.mkdir(parents=True)
        elsewhere = self.root / "elsewhere.json"
        planted = json.dumps({"jobs": [
            {"provider": "one", "id": "job-0", "state": "blocked", "since": FIRST - 600}]})
        elsewhere.write_text(planted, encoding="utf-8")
        try:
            os.symlink(elsewhere, self.record)
        except (OSError, NotImplementedError):
            self.skipTest("this platform will not make a link here")
        self.rows("blocked")
        self.assertEqual(self.since(FIRST), {"job-0": FIRST})
        # The link is replaced, never written through.
        self.assertEqual(elsewhere.read_text(encoding="utf-8"), planted)
        self.assertFalse(self.record.is_symlink())

    @unittest.skipIf(not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "getuid"),
                     "this platform has no link-refusing open or no file owner to check")
    def test_the_record_is_this_users_alone_and_its_folder_is_never_a_link(self):
        self.rows("blocked")
        self.since(FIRST)
        self.assertEqual(stat.S_IMODE(self.record.stat().st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE(self.record.parent.stat().st_mode) & 0o077, 0)
        # A folder planted as a link is refused: a record where it leads is not
        # read, and nothing is written there.
        shutil.rmtree(self.record.parent)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        planted = json.dumps({"jobs": [
            {"provider": "one", "id": "job-0", "state": "blocked", "since": FIRST - 600}]})
        (elsewhere / roster.JOB_STATES_NAME).write_text(planted, encoding="utf-8")
        os.symlink(elsewhere, self.record.parent)
        self.assertEqual(self.since(FIRST + 20), {"job-0": FIRST + 20})
        self.assertEqual([path.name for path in elsewhere.iterdir()], [roster.JOB_STATES_NAME])
        self.assertEqual((elsewhere / roster.JOB_STATES_NAME).read_text(encoding="utf-8"), planted)

    def test_the_record_written_stays_inside_its_bound(self):
        config = self.config(limits={"jobStateBytes": 1024})
        self.rows(*(["blocked"] * 40))
        self.since(FIRST, config)
        self.assertLessEqual(self.record.stat().st_size, 1024)
        kept = json.loads(self.record.read_text(encoding="utf-8"))["jobs"]
        self.assertGreater(len(kept), 0)
        self.assertLess(len(kept), 40)

    def test_a_record_that_cannot_be_written_never_fails_the_read(self):
        # The state directory is a file, so nothing can be written under it.
        self.state.write_text("in the way", encoding="utf-8")
        self.rows("blocked")
        result = snapshot.read_snapshot(self.config(), now=FIRST)
        self.assertEqual(result["roster"]["state"], "ready")
        self.assertEqual([job["since"] for job in result["roster"]["jobs"]], [FIRST])
        self.assertIn({"source": "jobs", "reason": "job states were not kept"},
                      result["roster"]["errors"])

    def test_a_command_that_could_not_be_run_keeps_every_provider_s_states(self):
        # The roster reports a provider whose command never ran as configured
        # ready, which is not the same as a read that answered: its saved
        # states must outlive the read that could not ask.
        self.rows("blocked")
        self.since(FIRST)
        absent = self.config(commands={"claude": [str(self.root / "absent-claude")]})
        result = snapshot.read_snapshot(absent, now=FIRST + 20)
        self.assertEqual(result["roster"]["state"], "unavailable")
        self.assertEqual(self.since(FIRST + 40), {"job-0": FIRST})

    def test_a_clock_stepped_back_a_little_keeps_the_kept_time(self):
        self.rows("blocked")
        self.since(FIRST)
        self.assertEqual(self.since(FIRST - 1), {"job-0": FIRST})

    def test_a_kept_time_beyond_the_configured_skew_is_refused(self):
        self.rows("blocked")
        self.since(FIRST)
        config = self.config(limits={"jobStateClockSkewSeconds": 30})
        self.assertEqual(self.since(FIRST - 31, config), {"job-0": FIRST - 31})
        self.assertEqual(self.since(FIRST - 31 + 20, config), {"job-0": FIRST - 31})
        # Thirty seconds of skew still holds a time thirty seconds ahead.
        self.rows("working")
        self.since(FIRST, config)
        self.assertEqual(self.since(FIRST - 30, config), {"job-0": FIRST})

    def test_a_provider_that_did_not_answer_keeps_its_jobs_states(self):
        self.rows("blocked")
        self.since(FIRST)
        (self.home / "rows.json").write_text("not json", encoding="utf-8")
        result = snapshot.read_snapshot(self.config(), now=FIRST + 20)
        self.assertEqual(result["roster"]["state"], "failed")
        self.rows("blocked")
        self.assertEqual(self.since(FIRST + 40), {"job-0": FIRST})


if __name__ == "__main__":
    unittest.main()
