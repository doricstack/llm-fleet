#!/usr/bin/env python3
"""Pull-request and skill reader behavior, against real commands and files.

The PR cases run a stub command on a controlled PATH, so the argument list, the
per-repository failure, and the cache are all observed rather than assumed. The
skill cases write the scan folder the way the other tool writes it, including
the malformed lines a real file carries.
"""

import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import prs, skills


STUB = '''\
import json, os, sys, time
from pathlib import Path

root = Path(os.environ["FLEET_STUB_DIR"])
argv = sys.argv[1:]
# One file per invocation: two readers run at once, and a shared append can lose
# a line on a platform that does not make it atomic.
calls = root / "calls"
calls.mkdir(exist_ok=True)
(calls / (str(os.getpid()) + "-" + str(time.time_ns()) + ".txt")).write_text(
    " ".join(argv), encoding="utf-8")
if argv[0] == "search":
    mode_file = root / "search.mode"
    if mode_file.exists() and mode_file.read_text(encoding="utf-8").strip() == "fail":
        sys.exit(5)
    document = root / "search.json"
    print(document.read_text(encoding="utf-8") if document.exists() else "[]")
    sys.exit(0)
repo = argv[argv.index("--repo") + 1]
mode = (root / (repo.replace("/", "_") + ".mode")).read_text(encoding="utf-8").strip() \\
    if (root / (repo.replace("/", "_") + ".mode")).exists() else "rows"
if mode == "fail":
    sys.exit(4)
if mode == "garbage":
    print("not json")
    sys.exit(0)
document = root / (repo.replace("/", "_") + ".json")
print(document.read_text(encoding="utf-8") if document.exists() else "[]")
'''

NOW = 1_700_000_000.0


class StubCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-stubs-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.stub = self.root / "stub.py"
        self.stub.write_text(STUB, encoding="utf-8")
        self.state = self.root / "state"

    def environment(self):
        return sandbox.home_environment(self.root, FLEET_STUB_DIR=str(self.root))

    def answer(self, repository, rows, mode=None):
        name = repository.replace("/", "_")
        (self.root / (name + ".json")).write_text(json.dumps(rows), encoding="utf-8")
        if mode is not None:
            (self.root / (name + ".mode")).write_text(mode, encoding="utf-8")

    def calls(self):
        folder = self.root / "calls"
        if not folder.is_dir():
            return []
        return sorted(path.read_text(encoding="utf-8") for path in folder.glob("*.txt"))

    def config(self, **document):
        body = {"stateDir": str(self.state),
                "commands": {"github": [sys.executable, str(self.stub)]}}
        body.update(document)
        path = self.root / "config.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        return load_config(path, environ=self.environment())


class PullRequestTests(StubCase):
    def repositories(self, *names):
        return {"sources": {"prs": {"enabled": True, "repositories": list(names)}}}

    def test_each_repository_is_read_with_its_own_arguments(self):
        self.answer("owner/one", [{"number": 7, "title": "Fix it", "headRefName": "fix/one",
                                   "headRefOid": "0123456789abcdef", "isDraft": False,
                                   "statusCheckRollup": [{"conclusion": "SUCCESS"}]}])
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["prs"], [{"repo": "owner/one", "number": 7, "title": "Fix it",
                                          "branch": "fix/one", "head": "0123456789ab",
                                          "is_draft": False, "checks": "pass",
                                          "check_runs": [{"name": "", "state": "pass"}],
                                          "check_runs_more": 0, "opened_at": None,
                                          "mine": False}])
        call = self.calls()[0]
        self.assertIn("pr list --repo owner/one --state open", call)
        self.assertIn("--limit 30", call)
        self.assertIn("statusCheckRollup", call)

    def test_at_me_reads_each_repository_holding_the_persons_own_pull_requests(self):
        (self.root / "search.json").write_text(json.dumps([
            {"repository": {"nameWithOwner": "owner/two"}},
            {"repository": {"nameWithOwner": "owner/two"}},
            {"repository": {"nameWithOwner": "owner/one"}},
            {"repository": {"nameWithOwner": "--repo"}},
            {"repository": {"nameWithOwner": "a/b/c"}},
            {"repository": None}]), encoding="utf-8")
        self.answer("owner/one", [{"number": 3, "title": "Listed", "headRefOid": "a"}])
        self.answer("owner/two", [{"number": 9, "title": "Mine", "headRefOid": "b"}])
        result = prs.read_prs(self.config(**self.repositories("owner/one", "@me")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready", result["errors"])
        self.assertEqual([(row["repo"], row["number"]) for row in result["prs"]],
                         [("owner/one", 3), ("owner/two", 9)])
        calls = self.calls()
        self.assertTrue(any(call.startswith("search prs --author=@me --state=open") for call in calls))
        # A repository named outright shows every open pull request; one found
        # only through the search shows the person's own, and each is read once.
        one = [call for call in calls if "--repo owner/one" in call]
        two = [call for call in calls if "--repo owner/two" in call]
        self.assertEqual(len(one), 1)
        self.assertEqual(len(two), 1)
        self.assertNotIn("--author", one[0])
        self.assertIn("--author @me", two[0])
        # Nothing that is not owner/project became an argument.
        self.assertFalse(any("--repo --repo" in call or "a/b/c" in call for call in calls))
        # The row says which read found it. A repository named outright shows
        # every open pull request, so its owner is what tells it apart from
        # another of the same name; one found through the search is the
        # person's own and is drawn by its project alone.
        self.assertEqual([(row["repo"], row["mine"]) for row in result["prs"]],
                         [("owner/one", False), ("owner/two", True)])

    def test_a_search_that_fails_is_named_and_the_named_repositories_still_answer(self):
        (self.root / "search.mode").write_text("fail", encoding="utf-8")
        self.answer("owner/one", [{"number": 3, "title": "Listed", "headRefOid": "a"}])
        result = prs.read_prs(self.config(**self.repositories("owner/one", "@me")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["errors"], [{"source": "prs:@me", "reason": "exit 5"}])
        self.assertEqual([row["number"] for row in result["prs"]], [3])

    def test_the_search_is_cached_like_any_read(self):
        (self.root / "search.json").write_text(json.dumps([
            {"repository": {"nameWithOwner": "owner/two"}}]), encoding="utf-8")
        self.answer("owner/two", [])
        config = self.config(**self.repositories("@me"))
        prs.read_prs(config, environ=self.environment(), now=NOW)
        prs.read_prs(config, environ=self.environment(), now=NOW + 1)
        self.assertEqual(sum(call.startswith("search") for call in self.calls()), 1)

    def test_a_cap_other_than_the_default_is_used(self):
        self.answer("owner/one", [])
        config = self.config(**{"sources": {"prs": {"enabled": True,
                                                    "repositories": ["owner/one"], "limit": 3}}})
        prs.read_prs(config, environ=self.environment(), now=NOW)
        self.assertIn("--limit 3", self.calls()[0])

    def test_a_failed_rollup_is_a_failure(self):
        self.answer("owner/one", [{"number": 1, "statusCheckRollup": [
            {"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]}])
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["prs"][0]["checks"], "fail")

    def test_an_unfinished_check_is_pending(self):
        self.answer("owner/one", [{"number": 1, "statusCheckRollup": [
            {"conclusion": "SUCCESS"}, {"status": "IN_PROGRESS", "state": "PENDING"}]}])
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["prs"][0]["checks"], "pending")

    def test_a_state_this_reader_does_not_know_is_pending(self):
        self.assertEqual(prs.checks_state([{"conclusion": "WEIRD"}]), "pending")
        self.assertEqual(prs.checks_state([{"conclusion": "NEUTRAL"}, {"state": "SKIPPED"}]),
                         "pass")
        self.assertEqual(prs.checks_state([]), "none")
        self.assertEqual(prs.checks_state(None), "none")

    def test_a_draft_pull_request_is_marked(self):
        self.answer("owner/one", [{"number": 1, "isDraft": True, "title": "WIP"}])
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["prs"][0]["is_draft"], True)

    def test_a_row_without_a_usable_number_is_kept_without_one(self):
        self.answer("owner/one", [{"title": "No number"}, "not a row", 5])
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(len(result["prs"]), 1)
        self.assertEqual(result["prs"][0]["number"], None)

    def test_rows_are_sorted_by_repository_and_number(self):
        self.answer("owner/one", [{"number": 2}, {"number": 9}])
        self.answer("owner/two", [{"number": 5}])
        result = prs.read_prs(self.config(**self.repositories("owner/one", "owner/two")),
                              environ=self.environment(), now=NOW)
        self.assertEqual([(row["repo"], row["number"]) for row in result["prs"]],
                         [("owner/one", 9), ("owner/one", 2), ("owner/two", 5)])

    def test_one_repository_failing_leaves_the_other_answering(self):
        self.answer("owner/one", [{"number": 1}])
        self.answer("owner/two", [], mode="fail")
        result = prs.read_prs(self.config(**self.repositories("owner/one", "owner/two")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual([row["repo"] for row in result["prs"]], ["owner/one"])
        self.assertEqual(result["errors"], [{"source": "prs:owner/two", "reason": "exit 4"}])

    def test_output_that_is_not_json_is_a_failure_for_that_repository(self):
        self.answer("owner/one", [], mode="garbage")
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["errors"],
                         [{"source": "prs:owner/one", "reason": "output was not JSON"}])

    def test_a_command_that_is_not_on_the_path_reads_unavailable(self):
        config = self.config(**{"commands": {"github": ["fleet-absent-gh"]},
                                "sources": {"prs": {"enabled": True,
                                                    "repositories": ["owner/one"]}}})
        result = prs.read_prs(config, environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["errors"],
                         [{"source": "prs", "reason": "fleet-absent-gh is not on PATH"}])
        self.assertEqual(self.calls(), [])

    def test_a_disabled_source_is_not_read(self):
        config = self.config(**{"sources": {"prs": {"enabled": False,
                                                    "repositories": ["owner/one"]}}})
        result = prs.read_prs(config, environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(self.calls(), [])

    def test_no_open_pull_requests_is_empty_rather_than_failed(self):
        self.answer("owner/one", [])
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["errors"], [])

    def test_a_result_inside_the_cache_window_is_served_without_running_the_command(self):
        self.answer("owner/one", [{"number": 1}])
        config = self.config(**self.repositories("owner/one"))
        first = prs.read_prs(config, environ=self.environment(), now=NOW)
        second = prs.read_prs(config, environ=self.environment(), now=NOW + 1)
        self.assertEqual(second["prs"], first["prs"])
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(second["errors"], [])

    def test_a_result_past_the_cache_window_is_read_again(self):
        self.answer("owner/one", [{"number": 1}])
        config = self.config(**self.repositories("owner/one"))
        prs.read_prs(config, environ=self.environment(), now=NOW)
        prs.read_prs(config, environ=self.environment(), now=NOW + 121)
        self.assertEqual(len(self.calls()), 2)

    def test_a_failed_repository_is_not_cached_as_an_answer(self):
        self.answer("owner/one", [], mode="fail")
        config = self.config(**self.repositories("owner/one"))
        prs.read_prs(config, environ=self.environment(), now=NOW)
        (self.root / "owner_one.mode").unlink()
        self.answer("owner/one", [{"number": 3}])
        second = prs.read_prs(config, environ=self.environment(), now=NOW + 1)
        self.assertEqual([row["number"] for row in second["prs"]], [3])
        self.assertEqual(second["errors"], [])

    def test_a_cached_repository_keeps_answering_while_another_is_read(self):
        self.answer("owner/one", [{"number": 1}])
        self.answer("owner/two", [{"number": 2}])
        config = self.config(**self.repositories("owner/one", "owner/two"))
        prs.read_prs(config, environ=self.environment(), now=NOW)
        prs.read_prs(config, environ=self.environment(), now=NOW + 121)
        self.assertEqual(len(self.calls()), 4)

    def test_a_cache_that_cannot_be_read_is_ignored(self):
        self.answer("owner/one", [{"number": 1}])
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / prs.CACHE_NAME).write_text("{ not json", encoding="utf-8")
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["prs"][0]["number"], 1)

    def test_a_cache_an_older_reader_wrote_is_never_served(self):
        # An installed copy from before check runs shares the state folder and
        # keeps writing fresh rows that hold none; served, they drew no dots.
        self.answer("owner/one", [{"number": 1}])
        self.state.mkdir(parents=True, exist_ok=True)
        older = {"owner/one": {"at": NOW, "prs": [{"repo": "owner/one", "number": 9}]}}
        (self.state / "prs.json").write_text(json.dumps(older), encoding="utf-8")
        result = prs.read_prs(self.config(**self.repositories("owner/one")),
                              environ=self.environment(), now=NOW + 1)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual([row["number"] for row in result["prs"]], [1])
        self.assertIn("check_runs", result["prs"][0])
        # The older reader's file is left as it was, so it has no reason to refetch either.
        self.assertEqual(json.loads((self.state / "prs.json").read_text(encoding="utf-8")), older)

    @unittest.skipIf(not hasattr(os, "O_NOFOLLOW"), "this platform has no link-refusing open")
    def test_the_cache_is_this_users_alone_and_never_read_or_written_through_a_link(self):
        self.answer("owner/one", [{"number": 1}])
        config = self.config(**self.repositories("owner/one"))
        prs.read_prs(config, environ=self.environment(), now=NOW)
        cache = self.state / prs.CACHE_NAME
        self.assertEqual(stat.S_IMODE(cache.stat().st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode) & 0o077, 0)
        # A fresh cache planted elsewhere and linked in is neither served nor written through.
        planted = self.root / "planted.json"
        planted.write_text(cache.read_text(encoding="utf-8"), encoding="utf-8")
        before = planted.read_text(encoding="utf-8")
        cache.unlink()
        os.symlink(planted, cache)
        prs.read_prs(config, environ=self.environment(), now=NOW + 1)
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(planted.read_text(encoding="utf-8"), before)
        self.assertFalse(cache.is_symlink())

    def test_a_cache_that_cannot_be_written_is_reported(self):
        self.answer("owner/one", [{"number": 1}])
        blocked = self.root / "blocked"
        blocked.write_text("not a directory", encoding="utf-8")
        config = self.config(**{"stateDir": str(blocked / "state"),
                                "sources": {"prs": {"enabled": True,
                                                    "repositories": ["owner/one"]}}})
        result = prs.read_prs(config, environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["errors"], [{"source": "prs", "reason": "cache was not written"}])


class CheckRunTests(StubCase):
    """One dot per check: named, ordered, deduplicated, capped, never invented."""

    def runs(self, rollup, limit=12):
        return prs.check_runs(rollup, limit)

    def test_each_check_is_named_and_ordered_by_name(self):
        runs, more = self.runs([
            {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED",
             "conclusion": "SUCCESS"},
            {"__typename": "StatusContext", "context": "deploy", "state": "FAILURE"},
            {"__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS",
             "conclusion": ""}])
        self.assertEqual(runs, [{"name": "build", "state": "pending"},
                                {"name": "deploy", "state": "fail"},
                                {"name": "lint", "state": "pass"}])
        self.assertEqual(more, 0)

    def test_a_rerun_keeps_the_latest_and_an_undated_tie_keeps_the_worst(self):
        runs, _ = self.runs([
            {"name": "test", "conclusion": "FAILURE", "completedAt": "2026-10-12T10:00:00Z"},
            {"name": "test", "conclusion": "SUCCESS", "completedAt": "2026-10-12T11:00:00Z"},
            {"name": "lint", "conclusion": "SUCCESS"},
            {"name": "lint", "conclusion": "TIMED_OUT"},
            {"name": "lint", "status": "QUEUED"}])
        self.assertEqual(runs, [{"name": "lint", "state": "fail"},
                                {"name": "test", "state": "pass"}])

    def both_orders(self, rollup):
        """The runs a rollup gives, checked to be the same read forward and backward."""
        forward, _ = self.runs(rollup)
        backward, _ = self.runs(list(reversed(rollup)))
        self.assertEqual(forward, backward)
        return forward

    def test_two_runs_finished_at_one_time_keep_the_failure_in_either_order(self):
        runs = self.both_orders([
            {"name": "test", "conclusion": "SUCCESS", "completedAt": "2026-10-12T10:00:00Z"},
            {"name": "test", "conclusion": "FAILURE", "completedAt": "2026-10-12T10:00:00Z"}])
        self.assertEqual(runs, [{"name": "test", "state": "fail"}])

    def test_an_undated_failure_is_never_replaced_by_a_later_dated_pass(self):
        # The undated failure must not take the first pass's time and then lose
        # to the second, later pass: a run that cannot be ordered never hides a
        # failure.
        runs = self.both_orders([
            {"name": "test", "conclusion": "SUCCESS", "completedAt": "2026-10-12T10:00:00Z"},
            {"name": "test", "conclusion": "FAILURE"},
            {"name": "test", "conclusion": "SUCCESS", "completedAt": "2026-10-12T11:00:00Z"}])
        self.assertEqual(runs, [{"name": "test", "state": "fail"}])

    def test_a_dated_failure_rerun_as_a_later_pass_keeps_the_pass_in_either_order(self):
        runs = self.both_orders([
            {"name": "test", "conclusion": "FAILURE", "completedAt": "2026-10-12T10:00:00Z"},
            {"name": "test", "conclusion": "SUCCESS", "completedAt": "2026-10-12T11:00:00Z"}])
        self.assertEqual(runs, [{"name": "test", "state": "pass"}])

    def test_two_checks_sharing_the_shown_part_of_their_name_stay_two_dots(self):
        shared = "integration / " + "x" * (prs.CHECK_NAME_LENGTH - len("integration / "))
        runs = self.both_orders([
            {"name": shared + " linux", "conclusion": "FAILURE",
             "completedAt": "2026-10-12T10:00:00Z"},
            {"name": shared + " windows", "conclusion": "SUCCESS",
             "completedAt": "2026-10-12T11:00:00Z"}])
        # Each dot keeps its own verdict; only the label is cut.
        self.assertEqual(sorted(run["state"] for run in runs), ["fail", "pass"])
        self.assertEqual([run["name"] for run in runs], [shared, shared])

    def test_unnamed_and_malformed_checks_stay_countable_as_pending(self):
        runs, more = self.runs([{"conclusion": "SUCCESS"}, "not a check", 7,
                                {"name": 5, "conclusion": "WEIRD"},
                                {"name": "ok", "conclusion": "NEUTRAL"}])
        self.assertEqual(runs, [{"name": "", "state": "pass"},
                                {"name": "", "state": "pending"},
                                {"name": "", "state": "pending"},
                                {"name": "", "state": "pending"},
                                {"name": "ok", "state": "pass"}])
        self.assertEqual(more, 0)

    def test_a_rollup_that_is_not_a_list_has_no_checks(self):
        self.assertEqual(self.runs(None), ([], 0))
        self.assertEqual(self.runs({"name": "x"}), ([], 0))
        self.assertEqual(self.runs([]), ([], 0))

    def test_the_cap_keeps_failures_first_and_counts_the_rest(self):
        rollup = [{"name": name, "conclusion": "SUCCESS"} for name in ("a", "b", "c", "d")]
        rollup.append({"name": "z", "conclusion": "FAILURE"})
        rollup.append({"name": "y", "status": "QUEUED"})
        runs, more = self.runs(rollup, limit=3)
        self.assertEqual(runs, [{"name": "a", "state": "pass"},
                                {"name": "y", "state": "pending"},
                                {"name": "z", "state": "fail"}])
        self.assertEqual(more, 3)
        self.assertEqual(self.runs(rollup, limit=0), ([], 6))

    def test_a_name_is_printable_text(self):
        runs, _ = self.runs([{"name": "bad\x1b[31mname", "conclusion": "SUCCESS"}])
        self.assertNotIn("\x1b", runs[0]["name"])

    def test_the_reader_carries_the_runs_beside_the_unchanged_verdict(self):
        self.answer("owner/one", [{"number": 1, "createdAt": "2026-10-12T09:30:00Z",
                                   "statusCheckRollup": [
                                       {"name": "b", "conclusion": "SUCCESS"},
                                       {"name": "a", "conclusion": "FAILURE"},
                                       {"name": "c", "conclusion": "SUCCESS"}]}])
        config = self.config(**{"sources": {"prs": {"enabled": True, "checkRunLimit": 2,
                                                    "repositories": ["owner/one"]}}})
        row = prs.read_prs(config, environ=self.environment(), now=NOW)["prs"][0]
        self.assertEqual(row["checks"], "fail")
        self.assertEqual(row["check_runs"], [{"name": "a", "state": "fail"},
                                             {"name": "b", "state": "pass"}])
        self.assertEqual(row["check_runs_more"], 1)
        self.assertEqual(row["opened_at"], "2026-10-12T09:30:00Z")
        self.assertIn("createdAt", self.calls()[0])

    def test_a_missing_or_malformed_open_time_is_none(self):
        self.answer("owner/one", [{"number": 1}, {"number": 2, "createdAt": "yesterday"},
                                  {"number": 3, "createdAt": 1700000000}])
        rows = prs.read_prs(self.config(**{"sources": {"prs": {
            "enabled": True, "repositories": ["owner/one"]}}}),
            environ=self.environment(), now=NOW)["prs"]
        self.assertEqual([row["opened_at"] for row in rows], [None, None, None])
        self.assertEqual([row["check_runs"] for row in rows], [[], [], []])


class SkillTests(StubCase):
    def setUp(self):
        super().setUp()
        self.folder = self.root / "scan"
        self.folder.mkdir()

    def summary(self, document):
        (self.folder / "summary.json").write_text(json.dumps(document), encoding="utf-8")

    def progress(self, document, age=0.0):
        path = self.folder / "progress.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        if age:
            stamp = NOW - age
            os.utime(path, (stamp, stamp))

    def notices(self, lines):
        (self.folder / "notices.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def config(self, **overrides):
        document = {"sources": {"skills": {"enabled": True, "directory": str(self.folder)}}}
        document.update(overrides)
        path = self.root / "config.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return load_config(path, environ=self.environment())

    def read(self, home=None):
        return skills.read_skills(self.config(), now=NOW, home=home)

    def test_findings_are_rows_and_clean_targets_are_left_out(self):
        self.summary({"generated_at": NOW - 10, "counts": {"scanned": 4},
                      "targets": [
                          {"target": "/fixture/runner/skills/one", "verdict": "clean"},
                          {"target": "/fixture/runner/skills/two", "verdict": "reviewed",
                           "reviewed": True},
                          {"target": "/fixture/runner/skills/three", "verdict": "issues",
                           "score": 0.5, "hash": "abc1234",
                           "issues": [{"severity": "high", "category": "secret",
                                       "finding": "looks like a key", "file": "a.py",
                                       "line": 4}]}]})
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["generated_at"], NOW - 10)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0], {"name": "three", "target": "/fixture/runner/skills/three",
                                              "verdict": "issues", "score": 0.5,
                                              "hash": "abc1234",
                                              "issue": "high secret: looks like a key (a.py:4)"})

    def test_a_target_under_the_user_directory_is_shortened(self):
        self.summary({"targets": [{"target": str(self.root / "skills" / "one"),
                                   "verdict": "issues"}]})
        result = self.read(home=self.root)
        self.assertEqual(result["items"][0]["target"],
                         os.path.join("~", "skills", "one"))

    def test_a_versioned_target_is_named_after_its_parent(self):
        self.assertEqual(skills.skill_name("/x/skills/one/v1.2.3"), "one@v1.2.3")
        self.assertEqual(skills.skill_name("/x/skills/one/deadbeef1234"), "one@deadbeef1234")
        self.assertEqual(skills.skill_name("/x/skills/one/main"), "main")

    def test_only_the_configured_number_of_items_is_kept(self):
        self.summary({"targets": [{"target": "/t/%d" % index, "verdict": "issues"}
                                  for index in range(14)]})
        config = self.config()
        config = dict(config)
        config["limits"] = dict(config["limits"], skillItems=3)
        result = skills.read_skills(config, now=NOW)
        self.assertEqual(len(result["items"]), 3)

    def test_a_fresh_running_scan_reports_its_counts(self):
        self.summary({"targets": []})
        self.progress({"running": True, "done": 12, "total": 40})
        self.assertEqual(self.read()["running"], {"done": 12, "total": 40})

    def test_a_stale_running_scan_reports_nothing(self):
        self.summary({"targets": []})
        self.progress({"running": True, "done": 12, "total": 40}, age=901)
        self.assertEqual(self.read()["running"], None)

    def test_progress_that_is_not_running_reports_nothing(self):
        self.summary({"targets": []})
        self.progress({"running": False, "done": 12, "total": 40})
        self.assertEqual(self.read()["running"], None)

    def test_a_newly_noticed_target_is_listed_separately(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"},
                                  {"target": "/t/two", "verdict": "issues"}]})
        self.notices([json.dumps({"target": "/t/one", "verdict": "issues", "at": NOW - 60})])
        result = self.read()
        self.assertEqual([item["name"] for item in result["new"]], ["one"])

    def test_an_old_notice_is_not_new(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"}]})
        self.notices([json.dumps({"target": "/t/one", "verdict": "issues", "at": NOW - 604801})])
        self.assertEqual(self.read()["new"], [])

    def test_malformed_notice_lines_are_skipped_and_do_not_stop_the_reader(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"}]})
        self.notices(["{ not json", json.dumps(["not", "an", "object"]),
                      json.dumps({"target": "/t/one", "verdict": "issues", "at": "later"}),
                      json.dumps({"target": ["not", "a", "string"], "at": NOW}),
                      json.dumps({"target": "/t/one", "verdict": "issues", "at": NOW - 5})])
        self.assertEqual([item["name"] for item in self.read()["new"]], ["one"])

    def test_a_notice_file_that_is_a_pipe_does_not_block_the_reader(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"}]})
        if not hasattr(os, "mkfifo"):
            self.skipTest("this platform cannot make a pipe")
        os.mkfifo(self.folder / "notices.jsonl")
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["new"], [])

    def test_a_notice_file_that_is_a_link_is_not_followed(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"}]})
        target = self.root / "outside.jsonl"
        target.write_text(json.dumps({"target": "/t/one", "verdict": "issues", "at": NOW}) + "\n",
                          encoding="utf-8")
        link = self.folder / "notices.jsonl"
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("this platform does not allow creating a symbolic link here")
        self.assertEqual(self.read()["new"], [])

    def test_a_notice_file_larger_than_its_bound_keeps_its_newest_lines(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"},
                                  {"target": "/t/two", "verdict": "issues"}]})
        filler = json.dumps({"target": "/t/filler", "verdict": "issues", "at": NOW})
        lines = [filler for _ in range(4000)]
        lines.append(json.dumps({"target": "/t/one", "verdict": "issues", "at": NOW - 5}))
        self.notices(lines)
        config = self.config()
        config = dict(config)
        config["limits"] = dict(config["limits"], jobStateBytes=600)
        result = skills.read_skills(config, now=NOW)
        self.assertEqual([item["name"] for item in result["new"]], ["one"])

    def test_a_notice_names_the_target_the_scan_wrote_even_when_the_row_shortens_it(self):
        target = str(self.root / "skills" / "one")
        self.summary({"targets": [{"target": target, "verdict": "issues"}]})
        self.notices([json.dumps({"target": target, "verdict": "issues", "at": NOW - 5})])
        result = self.read(home=self.root)
        self.assertEqual(result["items"][0]["target"], os.path.join("~", "skills", "one"))
        self.assertEqual([item["name"] for item in result["new"]], ["one"])

    def test_a_running_scan_without_a_total_reports_no_denominator(self):
        self.summary({"targets": []})
        self.progress({"running": True, "done": 5})
        self.assertEqual(self.read()["running"], None)

    def test_a_malformed_target_row_is_refused_without_stopping_the_reader(self):
        self.summary({"targets": [{"verdict": "issues"}, "not a row",
                                  {"target": "/t/one", "verdict": "issues"}]})
        result = self.read()
        self.assertEqual([item["name"] for item in result["items"]], ["one"])

    def test_a_scan_folder_without_a_summary_is_empty_rather_than_failed(self):
        result = self.read()
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["generated_at"], None)
        self.assertEqual(result["counts"], {})
        self.assertEqual(result["items"], [])

    def test_a_summary_that_is_not_an_object_is_reported_rather_than_read(self):
        (self.folder / "summary.json").write_text("[1, 2]", encoding="utf-8")
        result = self.read()
        self.assertEqual(result["items"], [])
        # A summary that is there and cannot be read is a failed read, named, and
        # not a scan that has not run.
        self.assertEqual(result["state"], "failed")
        self.assertEqual([error["source"] for error in result["errors"]], ["skills"])
        self.assertIn("limits.skillScanBytes", result["errors"][0]["reason"])

    def test_a_summary_larger_than_a_job_state_file_is_still_read(self):
        # The live summary lists every folder the scan saw and runs to hundreds of
        # kilobytes; it was once bounded by the job-state limit and read as nothing.
        targets = [{"target": "/t/skill-{0:04d}".format(index), "verdict": "clean",
                    "padding": "x" * 200} for index in range(400)]
        self.summary({"generated_at": NOW - 30, "counts": {"clean": 400}, "targets": targets})
        self.assertGreater((self.folder / "summary.json").stat().st_size, 65536)
        result = self.read()
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["generated_at"], NOW - 30)
        self.assertEqual(result["counts"], {"clean": 400})

    def test_a_summary_past_its_own_bound_is_named_not_read(self):
        self.summary({"generated_at": NOW - 30, "counts": {"clean": 1},
                      "targets": [{"target": "/t/one", "verdict": "clean"}]})
        config = self.config(limits={"skillScanBytes": 16})
        result = skills.read_skills(config, now=NOW)
        self.assertEqual(result["generated_at"], None)
        self.assertEqual(result["state"], "failed")
        self.assertIn("could not be read", result["errors"][0]["reason"])

    def test_the_report_command_is_quoted_for_a_shell_or_absent(self):
        self.summary({"generated_at": NOW - 30, "counts": {}, "targets": []})
        self.assertEqual(self.read()["report_command"], None)
        config = self.config(commands={"skillReport": ["python3", "$HOME/scan tool.py", "report"]})
        result = skills.read_skills(config, now=NOW)
        # The home is left for the pasting shell to expand, and the space quoted.
        self.assertEqual(result["report_command"], "python3 \"$HOME\"/'scan tool.py' report")
        # A source switched off still says how its report is printed.
        off = self.config(commands={"skillReport": ["report"]},
                          sources={"skills": {"enabled": False}})
        self.assertEqual(skills.read_skills(off, now=NOW)["report_command"], "report")

    def test_a_target_without_a_finding_has_no_issue_line(self):
        self.summary({"targets": [{"target": "/t/one", "verdict": "issues"}]})
        self.assertEqual(self.read()["items"][0]["issue"], "")

    def test_a_scan_folder_that_is_not_there_reads_unavailable(self):
        config = self.config(**{"sources": {"skills": {
            "enabled": True, "directory": str(self.root / "absent")}}})
        result = skills.read_skills(config, now=NOW)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["errors"],
                         [{"source": "skills", "reason": "no scan folder"}])

    def test_a_disabled_source_is_not_read(self):
        config = self.config(**{"sources": {"skills": {"enabled": False,
                                                       "directory": str(self.folder)}}})
        self.assertEqual(skills.read_skills(config, now=NOW)["state"], "disabled")


if __name__ == "__main__":
    unittest.main()
