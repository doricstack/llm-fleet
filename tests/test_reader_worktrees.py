#!/usr/bin/env python3
"""Worktree reader behavior, against real Git repositories and worktrees.

Every case builds the repository it reads: a branch, a merged branch, an archive
ref, a detached checkout. A fact this reader cannot prove on a platform is
asserted as unknown there, which is what the row is required to say.
"""

import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shlex
import shutil
import stat
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import worktrees


STORES = """
CREATE TABLE repos (repo_id INTEGER PRIMARY KEY, remote_url TEXT, root_oid TEXT);
CREATE TABLE changes (change_id INTEGER PRIMARY KEY, repo_id INTEGER, branch TEXT,
                      state TEXT, worktree_path TEXT);
CREATE TABLE milestones (change_id INTEGER, session TEXT, created_at REAL, to_state TEXT);
"""

NOW = 1_700_000_000.0
REMOTE = "https://example.invalid/owner/example-repo.git"

# How long each bound in a probe may run in a case that wants the probe to
# finish. Every probe here is real git, and under a load average of 40 a git
# call took longer than the two seconds the schema gives it: the probe was cut
# off, and a case that read a field of the row failed on that field's fallback
# rather than on anything the reader decided. The probe budget stays above the
# git bound so a slow call is never reported as the budget. The cases that test
# a cut-off set their own short bounds.
HEADROOM = {"gitSeconds": 30, "worktreeProbeSeconds": 120, "liveHoldersSeconds": 30,
            "trialDatabaseSeconds": 30}


def run(argv, cwd=None):
    return subprocess.run(argv, cwd=str(cwd) if cwd else None, capture_output=True, text=True,
                          timeout=60)


class WorktreeCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-worktrees-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.origin = self.root / "origin"
        self.origin.mkdir()
        self.git("init", "-b", "main", cwd=self.origin)
        self.git("config", "user.email", "reader@example.invalid", cwd=self.origin)
        self.git("config", "user.name", "Reader", cwd=self.origin)
        (self.origin / "file.txt").write_text("one\n", encoding="utf-8")
        self.git("add", "file.txt", cwd=self.origin)
        self.git("commit", "-m", "first", cwd=self.origin)
        self.git("remote", "add", "origin", REMOTE, cwd=self.origin)
        self.root_oid = self.git("rev-list", "--max-parents=0", "HEAD", cwd=self.origin).stdout.strip()
        self.roots = self.root / "worktrees"
        self.roots.mkdir()
        self.state = self.root / "state"

    def git(self, *argv, cwd=None):
        completed = run(["git", *argv], cwd=cwd or self.origin)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed

    def worktree(self, name, branch=None, detach=False, commit=False):
        path = self.roots / name
        if detach:
            self.git("worktree", "add", "--detach", str(path), "HEAD")
        else:
            self.git("worktree", "add", "-b", branch or name, str(path), "main")
        if commit:
            (path / (name + ".txt")).write_text("work\n", encoding="utf-8")
            self.git("add", name + ".txt", cwd=path)
            self.git("commit", "-m", "work on " + name, cwd=path)
        return path

    def merge(self, branch):
        self.git("merge", "--no-ff", "-m", "merge " + branch, branch)

    def environment(self):
        return sandbox.home_environment(self.root)

    def store(self, branch, path, state="TRYING", owner="abcdef12-rest", updated=NOW - 30):
        database = self.root / "changes.db"
        with sqlite3.connect(database) as connection:
            connection.executescript(STORES)
            connection.execute("INSERT INTO repos VALUES (1, ?, ?)", (REMOTE, self.root_oid))
            connection.execute("INSERT INTO changes VALUES (1, 1, ?, ?, ?)",
                               (branch, state, str(path)))
            connection.execute("INSERT INTO milestones VALUES (1, ?, ?, ?)",
                               (owner, updated, "TRYING"))
        return database

    def config(self, database=None, base_ref="main", timeouts=None, **document):
        sources = {"worktrees": {"enabled": True, "roots": [str(self.roots)],
                                 "baseRef": base_ref}}
        if database is not None:
            sources["trials"] = {"enabled": True, "database": str(database)}
        body = {"stateDir": str(self.state), "sources": sources,
                "timeouts": dict(HEADROOM if timeouts is None else timeouts)}
        body.update(document)
        path = self.root / "config.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        return load_config(path, environ=self.environment())

    def read(self, **kwargs):
        config = kwargs.pop("config", None) or self.config()
        kwargs.setdefault("now", NOW)
        return worktrees.read_worktrees(config, environ=self.environment(), **kwargs)

    def row(self, result, name):
        # A probe that did not finish says so, rather than as the fallback value
        # of whichever field the case reads next.
        failed = [entry["reason"] for entry in result["errors"]
                  if entry["source"] == "worktrees:" + name]
        self.assertEqual(failed, [], "the probe of " + name + " did not finish")
        for row in result["worktrees"]:
            if row["name"] == name:
                return row
        self.fail("no row for " + name)

    def holders_free(self):
        # A case about the cleanup line itself needs a row that may be offered
        # one, and a row is offered one only when its live holders were checked.
        # Windows has no lsof, so the check is answered here as "nothing holds
        # it" rather than left to the platform; the cases about an unanswered
        # check drive a real PATH and a real lsof below.
        return mock.patch.object(worktrees, "_inspect_holders", return_value=([], ""))

    def without_lsof(self):
        """The environment with a PATH that reaches git and no lsof."""
        environment = self.environment()
        if shutil.which("lsof", path=environment.get("PATH")) is None:
            return environment
        real = shutil.which("git")
        self.assertIsNotNone(real)
        tools = self.root / "tools"
        tools.mkdir()
        wrapper = tools / "git"
        wrapper.write_text("#!/bin/sh\nexec {0} \"$@\"\n".format(shlex.quote(real)),
                           encoding="utf-8")
        wrapper.chmod(0o755)
        environment["PATH"] = str(tools)
        return environment

    def with_lsof(self, label, script):
        """The environment with a stub lsof running a shell script first on the PATH."""
        tools = self.root / ("lsof-" + label)
        tools.mkdir()
        stub = tools / "lsof"
        stub.write_text("#!/bin/sh\n" + script + "\n", encoding="utf-8")
        stub.chmod(0o755)
        environment = self.environment()
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
        return environment

    def failing_archive_lookup(self):
        """Real git for every call but the archive lookup, which exits as git does on an error.

        No repository state makes for-each-ref fail while merge-base still
        answers: a broken ref is skipped with a warning and exit 0, and a broken
        packed-refs file stops every git call alike. The unborn-branch case below
        is the real failure; this one isolates the archive rule from the merge.
        """
        original = worktrees.git

        def answer(argv, where, seconds, env):
            if argv[0] == "for-each-ref":
                return 128, "", "fatal: the archive lookup failed"
            return original(argv, where, seconds, env)

        return mock.patch.object(worktrees, "git", answer)


class ProbeTests(WorktreeCase):
    def test_a_branch_that_is_not_in_the_base_ref_is_active(self):
        self.worktree("one", "feat/one", commit=True)
        result = self.read()
        row = self.row(result, "one")
        self.assertEqual(row["branch"], "feat/one")
        self.assertEqual((row["merged"], row["archived"]), (False, False))
        self.assertEqual(row["held"], False if row["held"] is not None else None)
        self.assertEqual(row["state"], "active" if row["held"] is not None else "unknown")

    def test_a_row_names_the_project_the_worktree_belongs_to(self):
        # Asked of git, so a checkout named under another project's folder still
        # names the repository it holds.
        self.worktree("one", "feat/one", commit=True)
        row = self.row(self.read(), "one")
        self.assertEqual(row["project"], self.origin.name)
        # git answers with the resolved path, which on macOS spells the temporary
        # folder through /private; the two names one folder either way.
        self.assertEqual(Path(row["project_root"]).resolve(), self.origin.resolve())

    def test_a_branch_contained_in_the_base_ref_is_merged(self):
        self.worktree("one", "feat/one")
        self.merge("feat/one")
        row = self.row(self.read(), "one")
        self.assertEqual(row["merged"], True)
        expected = "merged" if row["held"] is not None else "unknown"
        self.assertEqual(row["state"], expected)

    def test_an_archive_ref_preserves_a_branch(self):
        path = self.worktree("one", "feat/one", commit=True)
        self.git("-C", str(path), "update-ref", "refs/archive/one", "HEAD")
        row = self.row(self.read(), "one")
        self.assertEqual((row["merged"], row["archived"]), (False, True))
        expected = "preserved" if row["held"] is not None else "unknown"
        self.assertEqual(row["state"], expected)

    def test_a_detached_worktree_has_no_cleanup_branch(self):
        self.worktree("one", detach=True)
        row = self.row(self.read(), "one")
        self.assertEqual(row["branch"], "")
        self.assertEqual(row["state"], "unknown")
        self.assertEqual(row["cleanup_command"], "")
        self.assertEqual(row["error"], "detached worktree has no cleanup branch")
        # With no branch there is nothing to compare, so whether it is merged is unknown.
        self.assertIsNone(row["merged"])

    def test_a_base_ref_that_is_not_there_is_reported_rather_than_assumed(self):
        self.worktree("one", "feat/one", commit=True)
        row = self.row(self.read(config=self.config(base_ref="origin/absent")), "one")
        # Nothing was compared, so the row cannot say the branch is not merged.
        self.assertIsNone(row["merged"])
        self.assertEqual(row["state"], "unknown")
        self.assertEqual(row["error"], "cannot compare with origin/absent")

    def test_a_merge_base_that_fails_is_unknown_rather_than_not_merged(self):
        # git merge-base --is-ancestor exits 0 for an ancestor, 1 for not one,
        # and 128 when it cannot answer. A base ref naming a tree resolves, so
        # the probe gets as far as merge-base, and merge-base then refuses it:
        # a git error, which is not a claim that the branch is unmerged.
        path = self.worktree("one", "feat/one", commit=True)
        self.git("tag", "tree-base", "HEAD^{tree}")
        # An archive ref too: a branch whose merge is unknown is not "preserved",
        # since that state says it is unmerged with a copy kept.
        self.git("-C", str(path), "update-ref", "refs/archive/one", "HEAD")
        config = self.config(base_ref="tree-base", **{"commands": {"cleanup": ["fleet-clean"]}})
        with mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=self.environment(), now=NOW),
                           "one")
        self.assertIsNone(row["merged"])
        self.assertEqual(row["state"], "unknown")
        self.assertIn("cannot tell whether feat/one is merged into tree-base", row["error"])
        self.assertIn("git merge-base exited 128", row["error"])
        # An unknown is never offered for cleanup.
        self.assertEqual(row["cleanup_command"], "")
        self.assertIsNone(row.get("cleanup_note"))

    def test_merge_base_exit_one_alone_means_not_merged_and_zero_means_merged(self):
        self.worktree("open", "feat/open", commit=True)
        self.worktree("done", "feat/done", commit=True)
        self.merge("feat/done")
        result = self.read()
        self.assertIs(self.row(result, "open")["merged"], False)
        self.assertIs(self.row(result, "done")["merged"], True)
        for name in ("open", "done"):
            self.assertNotIn("merge-base", self.row(result, name).get("error") or "")

    def test_an_unborn_branch_leaves_its_merge_and_its_archive_unknown(self):
        # A branch with no commit yet: symbolic-ref names it, and every git call
        # that has to resolve HEAD to a commit, merge-base and the archive lookup
        # both, fails rather than answers.
        version = run(["git", "version"]).stdout.split()[2]
        if tuple(int(part) for part in version.split(".")[:2] if part.isdigit()) < (2, 42):
            self.skipTest("git " + version + " cannot add an orphan worktree")
        path = self.roots / "empty"
        self.git("worktree", "add", "--orphan", "-b", "feat/empty", str(path))
        config = self.config(**{"commands": {"cleanup": ["fleet-clean"]}})
        with self.holders_free(), mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=self.environment(), now=NOW),
                           "empty")
        self.assertEqual(row["branch"], "feat/empty")
        self.assertIsNone(row["merged"])
        self.assertIsNone(row["archived"])
        self.assertEqual(row["state"], "unknown")
        self.assertIn("cannot tell whether feat/empty is archived: git for-each-ref exited",
                      row["error"])
        self.assertEqual(row["cleanup_command"], "")

    def test_an_archive_lookup_that_fails_is_unknown_rather_than_not_archived(self):
        self.worktree("open", "feat/open", commit=True)
        self.worktree("done", "feat/done", commit=True)
        self.merge("feat/done")
        config = self.config(**{"commands": {"cleanup": ["fleet-clean"]}})
        with (self.holders_free(), self.failing_archive_lookup(),
              mock.patch.object(worktrees, "PLATFORM", "posix")):
            result = worktrees.read_worktrees(config, environ=self.environment(), now=NOW)
        for name, branch, merged in (("open", "feat/open", False), ("done", "feat/done", True)):
            row = self.row(result, name)
            # The merge was answered and stays a fact; the archive was not.
            self.assertIs(row["merged"], merged)
            self.assertIsNone(row["archived"])
            # Neither "active" (unmerged, no copy kept) nor "merged" with a line
            # to delete it: an unknown archive is no ground for either.
            self.assertEqual(row["state"], "unknown")
            self.assertEqual(row["error"],
                             "cannot tell whether " + branch + " is archived: "
                             "git for-each-ref exited 128")
            self.assertEqual(row["cleanup_command"], "")
            self.assertIsNone(row.get("cleanup_note"))

    def test_an_archive_lookup_that_warns_is_unknown_rather_than_archived(self):
        # An archive ref naming a commit whose parent is missing: for-each-ref
        # walks into the hole, writes "could not parse commit" to stderr, lists
        # the damaged ref as one holding HEAD, and still exits 0. Its answer is
        # not a fact about the branch.
        self.worktree("one", "feat/one", commit=True)
        tree = self.git("rev-parse", "HEAD^{tree}").stdout.strip()
        body = ("tree {0}\nparent {1}\nauthor A <a@example.invalid> 1999999999 +0000\n"
                "committer A <a@example.invalid> 1999999999 +0000\n\ndamaged\n").format(tree, "2" * 40)
        written = subprocess.run(["git", "hash-object", "-t", "commit", "-w", "--literally", "--stdin"],
                                 cwd=str(self.origin), input=body, capture_output=True, text=True,
                                 timeout=60)
        self.assertEqual(written.returncode, 0, written.stderr)
        # Written as a loose ref file rather than through update-ref, which some
        # git builds (the Windows runner's among them) refuse for a commit whose
        # parent is missing: the damage is the case, not something to repair.
        git_dir = Path(self.origin, self.git("rev-parse", "--git-dir").stdout.strip())
        ref = git_dir / "refs" / "archive" / "damaged"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_text(written.stdout.strip() + "\n", encoding="ascii")
        self.assertEqual(self.git("for-each-ref", "--format=%(refname)", "refs/archive/").stdout.strip(),
                         "refs/archive/damaged")
        config = self.config(**{"commands": {"cleanup": ["fleet-clean"]}})
        with self.holders_free(), mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=self.environment(), now=NOW),
                           "one")
        self.assertIs(row["merged"], False)
        self.assertIsNone(row["archived"])
        self.assertEqual(row["state"], "unknown")
        self.assertIn("cannot tell whether feat/one is archived: git for-each-ref reported: ",
                      row["error"])
        # What git names in its complaint differs by build: the missing parent
        # here, the damaged commit on the Windows runner. Either is the damage.
        damaged = written.stdout.strip()
        self.assertTrue("2" * 40 in row["error"] or damaged in row["error"], row["error"])
        self.assertEqual(row["cleanup_command"], "")

    def test_an_archive_lookup_that_answers_nothing_is_not_archived(self):
        self.worktree("one", "feat/one", commit=True)
        with self.holders_free():
            row = self.row(self.read(), "one")
        self.assertIs(row["archived"], False)
        self.assertEqual(row["state"], "active")

    def test_a_worktree_row_carries_what_was_checked(self):
        self.worktree("one", "feat/one")
        row = self.row(self.read(), "one")
        self.assertEqual(row["path"], str(self.roots / "one"))
        self.assertEqual(row["checked_at"], NOW)

    def test_roots_that_hold_nothing_are_empty_rather_than_failed(self):
        result = self.read()
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["errors"], [])

    def test_a_root_that_is_not_there_is_simply_absent(self):
        config = self.config(**{"sources": {"worktrees": {
            "enabled": True, "roots": [str(self.root / "absent")]}}})
        result = worktrees.read_worktrees(config, environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["errors"], [])

    def test_a_disabled_source_is_not_read(self):
        config = self.config(**{"sources": {"worktrees": {
            "enabled": False, "roots": [str(self.roots)]}}})
        result = worktrees.read_worktrees(config, environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(result["worktrees"], [])


class CleanupCommandTests(WorktreeCase):
    def test_a_configured_cleanup_command_is_offered_with_the_worktree_and_branch(self):
        path = self.worktree("one", "feat/one")
        config = self.config(**{"commands": {"cleanup": ["fleet-clean", "--quiet"]}})
        with self.holders_free(), mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=self.environment(), now=NOW),
                           "one")
        self.assertEqual(shlex.split(row["cleanup_command"]),
                         ["fleet-clean", "--quiet", "cleanup", "--worktree", str(path),
                          "--branch", "feat/one"])

    def test_the_argument_template_places_the_path_and_branch_where_the_command_wants_them(self):
        # A closer that takes the worktree alone, as `worktree-close.py <path>`.
        config = {"commands": {"cleanup": ["python3", "$HOME/bin/worktree-close.py"],
                               "cleanupArgs": ["{path}"]}}
        line = worktrees.cleanup_command(config, PurePosixPath("/w/two words"), "feat/x",
                                         platform="posix")
        self.assertEqual(shlex.split(line)[1:], ["$HOME/bin/worktree-close.py", "/w/two words"])
        # A template that names no branch offers the line for a worktree with none.
        self.assertNotEqual(worktrees.cleanup_command(config, PurePosixPath("/w/x"), "",
                                                      platform="posix"), "")
        # Only a whole word is a placeholder: text around one is left as written.
        config["commands"]["cleanupArgs"] = ["--at={path}", "{branch}", "{path}"]
        line = worktrees.cleanup_command(config, PurePosixPath("/w/a"), "feat/b", platform="posix")
        self.assertEqual(shlex.split(line)[2:], ["--at={path}", "feat/b", "/w/a"])
        # A template that uses the branch still needs one.
        self.assertEqual(worktrees.cleanup_command(config, PurePosixPath("/w/a"), "",
                                                   platform="posix"), "")

    def test_a_template_that_never_names_the_worktree_offers_nothing(self):
        # A line that would act on no worktree in particular is not offered.
        config = {"commands": {"cleanup": ["closer"], "cleanupArgs": ["--sweep"]}}
        self.assertEqual(worktrees.cleanup_command(config, PurePosixPath("/w/a"), "feat/b",
                                                   platform="posix"), "")

    def test_without_a_template_the_line_keeps_its_old_shape(self):
        config = {"commands": {"cleanup": ["fleet-clean"]}}
        self.assertEqual(shlex.split(worktrees.cleanup_command(
            config, PurePosixPath("/w/a"), "feat/b", platform="posix")),
            ["fleet-clean", "cleanup", "--worktree", "/w/a", "--branch", "feat/b"])

    def test_the_offered_line_keeps_each_argument_whole_when_pasted(self):
        config = self.config(**{"commands": {"cleanup": ["python3", "$HOME/bin/clean tool.py"]}})
        line = worktrees.cleanup_command(config, PurePosixPath("/w/two words"), "feat/it's",
                                         platform="posix")
        # The configured home is left for the shell to expand; every other word is
        # one argument however it is spelled.
        self.assertEqual(line, "python3 \"$HOME\"/'bin/clean tool.py' cleanup --worktree '/w/two words'"
                               " --branch 'feat/it'\"'\"'s'")
        self.assertEqual(shlex.split(line)[1:],
                         ["$HOME/bin/clean tool.py", "cleanup", "--worktree", "/w/two words",
                          "--branch", "feat/it's"])
        self.assertEqual(worktrees.cleanup_command(config, PurePosixPath("/w/x"), "",
                                                   platform="posix"), "")

    def test_a_path_with_a_space_or_a_quote_stays_one_argument_when_the_command_is_pasted(self):
        # The command is copied into a shell. A worktree folder named with a
        # space would split into two arguments there, and a quote or a semicolon
        # would end the argument and run whatever followed it.
        path = self.worktree("it's one; touch pwned", "feat/one")
        config = self.config(**{"commands": {"cleanup": ["fleet clean", "--quiet"]}})
        with self.holders_free(), mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=self.environment(), now=NOW),
                           "it's one; touch pwned")
        self.assertEqual(shlex.split(row["cleanup_command"]),
                         ["fleet clean", "--quiet", "cleanup", "--worktree", str(path),
                          "--branch", "feat/one"])

    def test_a_branch_a_shell_would_read_as_code_is_quoted_too(self):
        # Git allows a semicolon, a dollar sign and a backtick in a branch name.
        command = worktrees.cleanup_command({"commands": {"cleanup": ["fleet-clean"]}},
                                            PurePosixPath("/tmp/work tree"),
                                            "feat/$(touch x);`y`", platform="posix")
        self.assertEqual(shlex.split(command),
                         ["fleet-clean", "cleanup", "--worktree", "/tmp/work tree",
                          "--branch", "feat/$(touch x);`y`"])
        self.assertIn("'feat/$(touch x);`y`'", command)

    def test_on_windows_a_command_is_offered_only_when_every_argument_is_plain(self):
        # cmd reads its own quoting, not a POSIX shell's, so a quoted argument
        # protects nothing there: a hostile name gets no command at all.
        config = {"commands": {"cleanup": ["fleet-clean"]}}
        plain = worktrees.cleanup_command(config, PureWindowsPath("C:\\work\\tree-1"), "feat/one",
                                          platform="nt")
        self.assertEqual(plain, "fleet-clean cleanup --worktree C:\\work\\tree-1 --branch feat/one")
        for path, branch in ((PureWindowsPath("C:\\work\\it's one; touch pwned"), "feat/one"),
                             (PureWindowsPath("C:\\work\\tree"), "feat/$(touch x);`y`"),
                             (PureWindowsPath("C:\\work\\a b"), "feat/one"),
                             (PureWindowsPath("C:\\work\\a&b"), "feat/one"),
                             (PureWindowsPath("C:\\work\\%PATH%"), "feat/one")):
            self.assertEqual(worktrees.cleanup_command(config, path, branch, platform="nt"), "",
                             (str(path), branch))
        # A configured command whose own words are not plain is refused there too.
        self.assertEqual(worktrees.cleanup_command({"commands": {"cleanup": ["fleet clean"]}},
                                                   PureWindowsPath("C:\\work\\tree"), "feat/one",
                                                   platform="nt"), "")
        # On a POSIX shell the same hostile names are quoted, not refused.
        posix = worktrees.cleanup_command(config, PurePosixPath("/w/it's one; touch pwned"),
                                          "feat/$(touch x);`y`", platform="posix")
        self.assertEqual(shlex.split(posix), ["fleet-clean", "cleanup", "--worktree",
                                              "/w/it's one; touch pwned", "--branch",
                                              "feat/$(touch x);`y`"])

    def test_on_windows_a_short_name_is_plain(self):
        # Windows writes a long folder name in its 8.3 form with a tilde, as in
        # a runner's own temporary folder, and cmd reads a tilde as itself. A
        # set that refused it offered no command for any worktree under such a
        # folder, the plain ones included.
        config = {"commands": {"cleanup": ["fleet-clean"]}}
        path = PureWindowsPath("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\tmp1\\plain")
        self.assertEqual(worktrees.cleanup_command(config, path, "feat/plain", platform="nt"),
                         "fleet-clean cleanup --worktree {0} --branch feat/plain".format(path))
        self.assertEqual(worktrees.cleanup_command(config, PureWindowsPath("C:\\w\\a~b c"),
                                                   "feat/plain", platform="nt"), "")
        self.assertEqual(worktrees.cleanup_command(config, PureWindowsPath("C:\\w\\%T%~1"),
                                                   "feat/plain", platform="nt"), "")

    def test_a_worktree_offered_no_command_says_to_clean_it_up_by_hand(self):
        self.worktree("it's one; touch pwned", "feat/one")
        self.worktree("plain", "feat/plain")
        config = self.config(**{"commands": {"cleanup": ["fleet-clean"]}})
        with self.holders_free(), mock.patch.object(worktrees, "PLATFORM", "nt"):
            result = worktrees.read_worktrees(config, environ=self.environment(), now=NOW)
        hostile = self.row(result, "it's one; touch pwned")
        self.assertEqual(hostile["cleanup_command"], "")
        self.assertEqual(hostile["cleanup_note"], worktrees.CLEANUP_BY_HAND)
        # A plain name is not given the note; on POSIX nothing is.
        self.assertIsNone(self.row(result, "plain").get("cleanup_note"))
        with self.holders_free(), mock.patch.object(worktrees, "PLATFORM", "posix"):
            posix = worktrees.read_worktrees(config, environ=self.environment(), now=NOW,
                                             refresh=True)
        self.assertIsNone(self.row(posix, "it's one; touch pwned").get("cleanup_note"))

    def test_without_a_configured_command_there_is_nothing_to_offer(self):
        self.worktree("one", "feat/one")
        self.assertEqual(self.row(self.read(), "one")["cleanup_command"], "")


class StoreTests(WorktreeCase):
    def test_a_probe_that_has_spent_its_budget_is_refused(self):
        # One second of budget cannot cover the four git calls a probe makes, so
        # the declared bound has to end the probe rather than be decoration.
        path = self.worktree("one", "feat/one", commit=True)
        config = self.config(**{"timeouts": {"worktreeProbeSeconds": 1, "gitSeconds": 1}})
        environment = self.environment()
        original = worktrees.git
        calls: list[str] = []

        def slow(argv, where, seconds, env):
            calls.append(argv[0])
            time.sleep(0.35)
            return original(argv, where, seconds, env)

        worktrees.git = slow
        try:
            with self.assertRaises(worktrees.ReaderFailure) as caught:
                worktrees.probe_worktree(config, path, environment)
        finally:
            worktrees.git = original
        # The refusal names the bound that stopped it, whichever of the probe's
        # calls ran into it.
        self.assertIn("probe budget", str(caught.exception))
        # And it stopped because of the budget rather than because the work
        # finished: a whole probe is four git calls, and a third of a second a
        # call is more than the second this one was given, so the last of them
        # never happens. Counted rather than timed, because the clock on a loaded
        # runner is the thing this case is here to stop depending on.
        self.assertLess(len(calls), 4)

    def test_a_git_call_given_the_last_of_the_budget_names_the_budget(self):
        # The call that runs into the end of a probe's budget is handed what is
        # left of it, which can be a sliver far below what a git call needs. It
        # then times out, and the refusal says "timed out after 0.001s", which
        # reads as git being slow rather than as the probe being out of time:
        # which bound applied is the one thing the row exists to say.
        #
        # The clock is stood still rather than slept on, so the sliver is the
        # same size on every runner. The remaining microsecond is then handed
        # to a real git call: below what starting any process takes. A
        # millisecond was not, and a fast Linux runner answered inside it.
        path = self.worktree("one", "feat/one", commit=True)
        config = self.config(**{"timeouts": {"worktreeProbeSeconds": 1, "gitSeconds": 60}})
        environment = self.environment()
        original_clock = worktrees.time.monotonic
        readings = iter([0.0, 0.0, 0.999999])
        worktrees.time.monotonic = lambda: next(readings, 0.999999)
        try:
            with self.assertRaises(worktrees.ReaderFailure) as caught:
                worktrees.probe_worktree(config, path, environment)
        finally:
            worktrees.time.monotonic = original_clock
        self.assertIn("probe budget", str(caught.exception))
        self.assertNotIn("timed out", str(caught.exception))

    def test_a_cut_off_probe_leaves_whether_it_is_merged_unknown(self):
        # A probe the budget ended never got an answer from merge-base, so its
        # row may claim neither merged nor not merged, and says which bound
        # stopped it.
        self.worktree("one", "feat/one", commit=True)
        config = self.config(**{"timeouts": {"worktreeProbeSeconds": 1, "gitSeconds": 1}})
        original = worktrees.git

        def slow(argv, where, seconds, env):
            time.sleep(0.35)
            return original(argv, where, seconds, env)

        worktrees.git = slow
        try:
            result = worktrees.read_worktrees(config, environ=self.environment(), now=NOW)
        finally:
            worktrees.git = original
        [row] = result["worktrees"]
        self.assertIsNone(row["merged"])
        self.assertEqual(row["state"], "unknown")
        self.assertEqual(row["cleanup_command"], "")
        self.assertIn("probe budget", row["error"])
        self.assertEqual([entry["source"] for entry in result["errors"]], ["worktrees:one"])

    def test_a_change_for_this_worktree_names_its_state_and_owner(self):
        path = self.worktree("one", "feat/one")
        row = self.row(self.read(config=self.config(database=self.store("feat/one", path))), "one")
        self.assertEqual(row["change_state"], "TRYING")
        self.assertEqual(row["change_owner"], "abcdef12-rest")
        self.assertEqual(row["change_updated_at"], NOW - 30)

    def test_a_change_for_another_worktree_of_the_same_branch_is_not_borrowed(self):
        self.worktree("one", "feat/one")
        database = self.store("feat/one", self.roots / "somewhere-else")
        row = self.row(self.read(config=self.config(database=database)), "one")
        self.assertEqual(row["change_state"], None)
        self.assertEqual(row["change_owner"], None)

    def test_two_repositories_under_one_root_keep_their_own_change(self):
        # The remote and root commit a repository answers are kept for its other
        # worktrees, so a tree in a second repository must not be handed them.
        other = self.root / "other-origin"
        other.mkdir()
        self.git("init", "-b", "main", cwd=other)
        self.git("config", "user.email", "reader@example.invalid", cwd=other)
        self.git("config", "user.name", "Reader", cwd=other)
        (other / "file.txt").write_text("two\n", encoding="utf-8")
        self.git("add", "file.txt", cwd=other)
        self.git("commit", "-m", "first", cwd=other)
        other_remote = "https://example.invalid/owner/other-repo.git"
        self.git("remote", "add", "origin", other_remote, cwd=other)
        other_root = self.git("rev-list", "--max-parents=0", "HEAD",
                              cwd=other).stdout.strip()
        self.git("worktree", "add", "-b", "feat/other", str(self.roots / "two"), "main",
                 cwd=other)
        self.worktree("one", "feat/one", commit=True)
        database = self.root / "changes.db"
        with sqlite3.connect(database) as connection:
            connection.executescript(STORES)
            connection.execute("INSERT INTO repos VALUES (1, ?, ?)", (REMOTE, self.root_oid))
            connection.execute("INSERT INTO repos VALUES (2, ?, ?)", (other_remote, other_root))
            connection.execute("INSERT INTO changes VALUES (1, 1, ?, ?, ?)",
                               ("feat/one", "TRYING", str(self.roots / "one")))
            connection.execute("INSERT INTO changes VALUES (2, 2, ?, ?, ?)",
                               ("feat/other", "READY", str(self.roots / "two")))
        result = self.read(config=self.config(database=database))
        self.assertEqual(self.row(result, "one")["change_state"], "TRYING")
        self.assertEqual(self.row(result, "two")["change_state"], "READY")

    def test_a_store_that_is_not_there_leaves_the_change_fields_empty(self):
        self.worktree("one", "feat/one")
        config = self.config(database=self.root / "absent.db")
        row = self.row(worktrees.read_worktrees(config, environ=self.environment(), now=NOW), "one")
        self.assertEqual(row["change_state"], None)

    def test_cleaned_worktrees_inside_the_window_are_counted(self):
        path = self.worktree("one", "feat/one")
        database = self.store("feat/one", path)
        with sqlite3.connect(database) as connection:
            connection.execute("INSERT INTO milestones VALUES (1, ?, ?, ?)",
                               ("abcdef12-rest", NOW - 100, "CLEANED"))
            connection.execute("INSERT INTO milestones VALUES (1, ?, ?, ?)",
                               ("abcdef12-rest", NOW - 604801, "CLEANED"))
        config = self.config(database=database)
        self.assertEqual(worktrees.read_worktrees(config, environ=self.environment(),
                                                  now=NOW)["cleaned"], 1)

    def test_no_configured_store_reports_no_count_rather_than_zero(self):
        self.assertEqual(self.read()["cleaned"], None)


class CacheTests(WorktreeCase):
    def test_a_fresh_cache_answers_without_probing_again(self):
        self.worktree("one", "feat/one")
        first = self.read()
        self.worktree("two", "feat/two")
        second = self.read()
        self.assertEqual([row["name"] for row in second["worktrees"]],
                         [row["name"] for row in first["worktrees"]])
        third = self.read(now=NOW + 301)
        self.assertEqual(sorted(row["name"] for row in third["worktrees"]), ["one", "two"])

    def test_a_refresh_ignores_a_fresh_cache(self):
        self.worktree("one", "feat/one")
        self.read()
        self.worktree("two", "feat/two")
        again = self.read(refresh=True)
        self.assertEqual(sorted(row["name"] for row in again["worktrees"]), ["one", "two"])

    def test_a_cache_that_is_not_readable_is_ignored(self):
        self.worktree("one", "feat/one")
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / worktrees.CACHE_NAME).write_text("{ not json", encoding="utf-8")
        self.assertEqual([row["name"] for row in self.read()["worktrees"]], ["one"])

    @unittest.skipIf(not hasattr(os, "O_NOFOLLOW"), "this platform has no link-refusing open")
    def test_the_cache_and_lock_are_this_users_alone_and_never_followed_through_a_link(self):
        self.worktree("one", "feat/one")
        self.read()
        cache = self.state / worktrees.CACHE_NAME
        self.assertEqual(stat.S_IMODE(cache.stat().st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode) & 0o077, 0)
        # A fresh cache planted elsewhere and linked in is neither served nor written through.
        planted = self.root / "planted.json"
        planted.write_text(json.dumps({"at": NOW + 1, "worktrees": [], "cleaned": None,
                                       "errors": []}), encoding="utf-8")
        before = planted.read_text(encoding="utf-8")
        cache.unlink()
        os.symlink(planted, cache)
        self.worktree("two", "feat/two")
        result = self.read(now=NOW + 2)
        self.assertEqual(sorted(row["name"] for row in result["worktrees"]), ["one", "two"])
        self.assertEqual(planted.read_text(encoding="utf-8"), before)
        self.assertFalse(cache.is_symlink())
        # A lock linked to a file holding a fresh time is not read as a live lock.
        taken = self.root / "taken"
        taken.write_text("{0:.6f}".format(NOW + 400), encoding="utf-8")
        os.symlink(taken, self.state / worktrees.LOCK_NAME)
        self.worktree("three", "feat/three")
        again = self.read(now=NOW + 401)
        self.assertEqual(sorted(row["name"] for row in again["worktrees"]), ["one", "three", "two"])
        self.assertEqual(taken.read_text(encoding="utf-8"), "{0:.6f}".format(NOW + 400))

    def test_an_inspection_already_running_returns_the_rows_it_has(self):
        self.worktree("one", "feat/one")
        self.read()
        self.state.mkdir(parents=True, exist_ok=True)
        # A stale cache plus a lock taken a moment ago: this is the case where a
        # second reader must serve what it has instead of probing at the same time.
        (self.state / worktrees.LOCK_NAME).write_text("{0:.6f}".format(NOW + 300), encoding="utf-8")
        result = self.read(now=NOW + 301)
        self.assertEqual(result["state"], "ready")
        self.assertEqual([row["name"] for row in result["worktrees"]], ["one"])
        # Another session's inspection is how most reads on a busy machine go,
        # not a fault: rows on hand are served without a warning.
        self.assertEqual(result["errors"], [])
        (self.state / worktrees.LOCK_NAME).unlink()

    def test_an_inspection_already_running_with_nothing_on_hand_says_so(self):
        self.worktree("one", "feat/one")
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / worktrees.LOCK_NAME).write_text("{0:.6f}".format(NOW), encoding="utf-8")
        result = self.read(now=NOW + 1)
        # No rows to serve: the section cannot say what is there, so it is
        # unavailable with the reason, never an empty list.
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["worktrees"], [])
        self.assertEqual(result["errors"],
                         [{"source": "worktrees", "reason": "inspection in progress"}])
        (self.state / worktrees.LOCK_NAME).unlink()

    def test_a_lock_left_behind_by_a_dead_reader_is_taken_again(self):
        self.worktree("one", "feat/one")
        self.state.mkdir(parents=True, exist_ok=True)
        # A lock with no timestamp, and one older than a whole probe budget, are
        # both abandoned: an interrupted run must not stop every later read.
        (self.state / worktrees.LOCK_NAME).write_text("", encoding="utf-8")
        unreadable = self.read()
        self.assertEqual(unreadable["errors"], [])
        self.assertEqual([row["name"] for row in unreadable["worktrees"]], ["one"])
        (self.state / worktrees.LOCK_NAME).write_text("0", encoding="utf-8")
        reclaimed = self.read(now=NOW + 3600)
        self.assertEqual(reclaimed["errors"], [])
        self.worktree("two", "feat/two")
        # Past the cache window, so the reclamation is proved by a real probe.
        self.assertEqual(sorted(row["name"] for row in self.read(now=NOW + 3901)["worktrees"]),
                         ["one", "two"])

    def test_a_lock_taken_just_now_is_respected(self):
        self.worktree("one", "feat/one")
        self.state.mkdir(parents=True, exist_ok=True)
        # A stale cache plus a lock taken a moment ago: this is the case where a
        # second reader must serve what it has instead of probing at the same time.
        (self.state / worktrees.LOCK_NAME).write_text("{0:.6f}".format(NOW + 300), encoding="utf-8")
        result = self.read(now=NOW + 301)
        self.assertEqual(result["errors"],
                         [{"source": "worktrees", "reason": "inspection in progress"}])
        self.assertEqual((self.state / worktrees.LOCK_NAME).exists(), True)

    def test_a_lock_this_caller_did_not_take_is_never_removed(self):
        path = self.state / worktrees.LOCK_NAME
        self.state.mkdir(parents=True, exist_ok=True)
        path.write_text("someone else", encoding="utf-8")
        worktrees._unlock(path, -1)
        self.assertEqual(path.exists(), True)

    def test_a_cache_that_cannot_be_written_is_reported(self):
        self.worktree("one", "feat/one")
        blocked = self.root / "blocked"
        blocked.write_text("not a directory", encoding="utf-8")
        config = self.config(**{"stateDir": str(blocked / "state")})
        result = worktrees.read_worktrees(config, environ=self.environment(), now=NOW)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["errors"],
                         [{"source": "worktrees", "reason": "cache was not written"}])


class ProbeReuseTests(WorktreeCase):
    """A sweep asks a tree again only when something its row was read against moved.

    A tree's merge, its archive and its project are facts about where its branch
    and commit stand. While those stand still, and the repository's base ref and
    archive refs stand still, the row is re-answered from what the sweep read
    once for the whole machine instead of four git calls per worktree.
    """

    def record_git(self):
        """Every git subcommand the sweep runs, counted, with the call left real."""
        seen: list[str] = []
        original = worktrees.git

        def recording(argv, where, seconds, env):
            seen.append(argv[0])
            return original(argv, where, seconds, env)

        return seen, mock.patch.object(worktrees, "git", recording)

    def test_a_tree_that_has_not_moved_is_not_asked_again(self):
        self.worktree("one", "feat/one", commit=True)
        before = self.row(self.read(), "one")
        seen, recording = self.record_git()
        with recording:
            after = self.row(self.read(refresh=True), "one")
        # The per-worktree calls are gone: one `rev-parse` for where the tree
        # stands, and the repository's refs asked once for the sweep.
        self.assertEqual(seen.count("symbolic-ref"), 0)
        self.assertEqual(seen.count("merge-base"), 0)
        self.assertLessEqual(seen.count("for-each-ref"), 1)
        for key in ("branch", "merged", "archived", "state", "cleanup_command",
                    "project", "project_root"):
            self.assertEqual(after[key], before[key])

    def test_a_base_ref_that_moved_is_asked_again(self):
        # A branch merged while its worktree sits still is the case a kept row
        # would get wrong forever: the tree never moves, so nothing would ever
        # ask again.
        self.worktree("one", "feat/one", commit=True)
        self.assertIs(self.row(self.read(), "one")["merged"], False)
        self.merge("feat/one")
        row = self.row(self.read(refresh=True), "one")
        self.assertIs(row["merged"], True)
        self.assertIn(row["state"], {"merged", "unknown"})

    def test_an_archive_ref_that_appeared_is_asked_again(self):
        path = self.worktree("one", "feat/one", commit=True)
        self.assertIs(self.row(self.read(), "one")["archived"], False)
        self.git("-C", str(path), "update-ref", "refs/archive/one", "HEAD")
        row = self.row(self.read(refresh=True), "one")
        self.assertIs(row["archived"], True)

    def test_a_commit_on_the_branch_is_asked_again(self):
        # Only the checkout moves here: the base ref and the archive refs stand
        # still, so the commit on the branch is the one thing that says the row
        # has to be compared again.
        path = self.worktree("one", "feat/one", commit=True)
        self.read()
        (path / "again.txt").write_text("more\n", encoding="utf-8")
        self.git("add", "again.txt", cwd=path)
        self.git("commit", "-m", "more", cwd=path)
        seen, recording = self.record_git()
        with recording:
            row = self.row(self.read(refresh=True), "one")
        self.assertEqual(seen.count("merge-base"), 1)
        self.assertIs(row["merged"], False)

    def test_an_unknown_merge_is_asked_again_though_the_refs_stand_still(self):
        # A base ref that resolves but cannot be compared against leaves the
        # merge unknown. Nothing moves between the two sweeps, so a row kept on
        # where the tree stands would repeat the unknown for as long as it sits.
        self.worktree("one", "feat/one", commit=True)
        self.git("tag", "tree-base", "HEAD^{tree}")
        first = self.read(config=self.config(base_ref="tree-base"))
        self.assertIsNone(self.row(first, "one")["merged"])
        seen, recording = self.record_git()
        with recording:
            self.row(self.read(config=self.config(base_ref="tree-base"), refresh=True), "one")
        self.assertEqual(seen.count("merge-base"), 1)

    @unittest.skipIf(os.name == "nt", "lsof is not on Windows, so no pass answers it")
    def test_a_holder_that_appeared_is_drawn_though_the_tree_stands_still(self):
        # A row kept from the last sweep still asks who holds the folder now:
        # the holder answer is read fresh for every tree on every sweep.
        path = self.worktree("one", "feat/one", commit=True)
        free = self.with_lsof("free", "exit 1")
        first = worktrees.read_worktrees(self.config(), environ=free, now=NOW)
        self.assertIs(self.row(first, "one")["held"], False)
        busy = self.with_lsof(
            "busy", "printf 'p12\\ncvim\\nn{0}\\n'; exit 0".format(path / "again.txt"))
        row = self.row(worktrees.read_worktrees(self.config(), environ=busy, now=NOW,
                                                refresh=True), "one")
        self.assertIs(row["held"], True)
        self.assertEqual(row["state"], "held")

    def test_a_damaged_probe_cache_is_asked_again_rather_than_failing_the_section(self):
        # A cache written by another version, or by a run that died, may hold
        # anything under the probes key. Read as a mapping, a shape that is not
        # one would take the whole section down and every row with it.
        self.worktree("one", "feat/one", commit=True)
        self.read()
        cache = self.state / "worktrees.json"
        document = json.loads(cache.read_text(encoding="utf-8"))
        document["probes"] = [1]
        cache.write_text(json.dumps(document), encoding="utf-8")
        row = self.row(self.read(refresh=True), "one")
        self.assertIs(row["merged"], False)
        self.assertEqual(row["state"], "active" if row["held"] is not None else "unknown")

    def test_an_uncertainty_is_asked_again_rather_than_repeated(self):
        # Only a settled answer is carried forward; a row that could not prove
        # its merge last time is asked again, not published as unknown forever.
        self.worktree("one", "feat/one", commit=True)
        self.assertIsNone(self.row(self.read(config=self.config(base_ref="origin/absent")),
                                   "one")["merged"])
        row = self.row(self.read(config=self.config(), refresh=True), "one")
        self.assertIs(row["merged"], False)


class StaleRowTests(WorktreeCase):
    def previous(self, state):
        return {"name": "one", "path": str(self.roots / "one"), "branch": "feat/one",
                "merged": True, "archived": False, "held": False, "state": state,
                "cleanup_command": "clean", "checked_at": NOW - 100}

    def test_a_row_that_was_read_before_is_kept_with_a_note_when_a_probe_fails(self):
        kept = worktrees._keep_previous(self.previous("merged"), str(self.roots / "one"), "one",
                                        "timed out after 2s", NOW)
        self.assertEqual(kept["state"], "merged")
        self.assertEqual(kept["checked_at"], NOW - 100)
        self.assertEqual(kept["recheck_error"], "timed out after 2s")

    def test_an_unknown_row_is_not_reused(self):
        kept = worktrees._keep_previous(self.previous("unknown"), str(self.roots / "one"), "one",
                                        "timed out after 2s", NOW)
        self.assertEqual(kept["state"], "unknown")
        self.assertEqual(kept["error"], "timed out after 2s")
        self.assertEqual(kept["checked_at"], NOW)

    def test_a_first_probe_failure_has_nothing_to_keep(self):
        kept = worktrees._keep_previous(None, str(self.roots / "one"), "one", "exit 1", NOW)
        self.assertEqual(kept["state"], "unknown")
        self.assertIsNone(kept["merged"])
        self.assertEqual(kept["error"], "exit 1")


class HolderTests(WorktreeCase):
    def test_a_working_folder_counts_for_the_folder_it_holds_and_no_sibling(self):
        # The folder itself and anything inside it. A sibling whose name starts
        # with the same letters is a different folder: matching on the text
        # alone would read one worktree's process as another's.
        folders = [("claude", "/w/one"), ("vim", "/w/one/src/deep"), ("bash", "/w/one-other"),
                   ("sleep", "/elsewhere"), ("node", "/w/one")]
        self.assertEqual(worktrees._held_by(folders, Path("/w/one")), ["claude", "node", "vim"])
        self.assertEqual(worktrees._held_by(folders, Path("/w/one-other")), ["bash"])
        self.assertEqual(worktrees._held_by(folders, Path("/w")), ["bash", "claude", "node", "vim"])

    def test_a_folder_spelled_with_the_other_separator_is_the_same_folder(self):
        # Windows spells a folder either way, and the text was compared as it
        # was written: a folder somebody is working in read as free, and free
        # is the answer that offers a cleanup over live work. The separators
        # are set here rather than taken from the platform, so the case runs
        # everywhere and fails wherever the folding is removed.
        with mock.patch.object(os, "sep", "\\"), mock.patch.object(os, "altsep", "/"):
            self.assertEqual(worktrees._held_by([("claude", "/w/one/src")], Path("/w/one")),
                             ["claude"])
            self.assertEqual(worktrees._held_by([("vim", "/w/one")], Path("/w/one-other")), [])
            self.assertEqual(worktrees._held_by([("node", "\\w\\one")], Path("\\w\\one")),
                             ["node"])

    @unittest.skipIf(os.name == "nt", "a symbolic link needs a privilege a Windows test does not have")
    def test_a_root_reached_through_a_link_is_matched_under_either_spelling(self):
        # A tool reports what the kernel has, which is the resolved path, so a
        # root configured through a link would match nothing if only the
        # configured text were compared. Nothing is the answer that offers a
        # cleanup over live work.
        real = self.root / "real-root"
        real.mkdir()
        link = self.root / "linked-root"
        os.symlink(real, link)
        spellings = worktrees._roots_as_written([link])
        self.assertIn(str(real.resolve()), spellings)
        self.assertIn(str(link), spellings)

    def test_a_row_is_answered_from_the_paths_read_once_for_the_sweep(self):
        # The recursive walk costs half a second per worktree and was most of
        # what a cold read spent. The path here reaches no lsof at all: a call
        # that had gone looking for one would have answered None with the reason.
        environment = self.without_lsof()
        held, why = worktrees._inspect_holders(self.config(), Path("/w/one"), environment,
                                               [("claude", "/w/one/src")])
        self.assertEqual((held, why), (["claude"], ""))
        free, _ = worktrees._inspect_holders(self.config(), Path("/w/one"), environment, [])
        self.assertEqual(free, [])

    @unittest.skipIf(os.name == "nt", "a symbolic link needs a privilege a Windows test does not have")
    def test_a_worktree_that_is_a_link_is_matched_at_its_target(self):
        # A worktree folder can itself be a link. The old walk followed it, so a
        # folder reached through one was still somebody's; the pass reports the
        # target's path, which the row has to match or it reads free and offers
        # a cleanup over live work.
        target = self.root / "elsewhere" / "one"
        target.parent.mkdir(parents=True)
        self.git("worktree", "add", "-b", "feat/one", str(target), "main")
        os.symlink(target, self.roots / "one")
        # A tool reports what the kernel has, which is the resolved path: on
        # macOS a temporary folder is spelled through /private there.
        environment = self.with_lsof(
            "linked", "printf 'p12\\ncvim\\nn{0}/file.txt\\n'; exit 0".format(target.resolve()))
        row = self.row(worktrees.read_worktrees(self.config(), environ=environment, now=NOW),
                       "one")
        self.assertIs(row["held"], True)
        self.assertEqual(row["state"], "held")

    def test_an_open_file_inside_the_tree_is_a_holder_too(self):
        # An editor holding a file under a folder it does not sit in was the one
        # thing the working folders could not show, and the one reason a row
        # that offers a cleanup paid for the walk. The sweep's pass reads open
        # files, so the row that offers a cleanup is answered like the rest.
        environment = self.without_lsof()
        paths = [("vim", "/w/one/src/main.ts")]
        held, why = worktrees._inspect_holders(self.config(), Path("/w/one"), environment, paths)
        self.assertEqual((held, why), (["vim"], ""))

    def test_a_sweep_without_the_open_paths_falls_back_to_the_walk(self):
        # No paths were read, so every row is answered the way it always was.
        environment = self.without_lsof()
        held, why = worktrees._inspect_holders(self.config(), Path("/w/one"), environment)
        self.assertIsNone(held)
        self.assertEqual(why, "lsof is not on the PATH")

    def test_live_holders_answer_only_when_the_platform_can_be_asked(self):
        answer = worktrees.live_holders(self.config(), self.roots, self.environment())
        if shutil.which("lsof") is None:
            self.assertIsNone(answer)
        else:
            self.assertIsInstance(answer, list)

    def test_without_lsof_on_the_path_no_cleanup_is_offered_and_the_row_says_why(self):
        # Windows has no lsof, so there every row is in this state: it says why
        # rather than offering a line that could delete a folder in use.
        self.worktree("one", "feat/one")
        config = self.config(**{"commands": {"cleanup": ["fleet-clean"]}})
        with mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=self.without_lsof(), now=NOW),
                           "one")
        self.assertIsNone(row["held"])
        self.assertEqual(row["state"], "unknown")
        self.assertEqual(row["error"], "live process inspection unavailable: lsof is not on the PATH")
        self.assertEqual(row["cleanup_command"], "")
        self.assertIsNone(row.get("cleanup_note"))

    @unittest.skipIf(os.name == "nt", "a shell-script lsof cannot run without a POSIX shell")
    def test_an_lsof_that_does_not_answer_offers_no_cleanup(self):
        self.worktree("one", "feat/one")
        tools = self.root / "slow-lsof"
        tools.mkdir()
        lsof = tools / "lsof"
        lsof.write_text("#!/bin/sh\nexec sleep 30\n", encoding="utf-8")
        lsof.chmod(0o755)
        environment = self.environment()
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
        config = self.config(timeouts={**HEADROOM, "liveHoldersSeconds": 1},
                             **{"commands": {"cleanup": ["fleet-clean"]}})
        with mock.patch.object(worktrees, "PLATFORM", "posix"):
            row = self.row(worktrees.read_worktrees(config, environ=environment, now=NOW), "one")
        self.assertIsNone(row["held"])
        self.assertEqual(row["state"], "unknown")
        self.assertEqual(row["error"], "live process inspection unavailable: lsof did not answer within 1s")
        self.assertEqual(row["cleanup_command"], "")

    @unittest.skipIf(os.name == "nt", "a shell-script lsof cannot run without a POSIX shell")
    def test_only_a_silent_exit_one_from_lsof_means_nothing_holds_the_folder(self):
        # The real lsof answers "nothing open" with exit 1 and no output at all,
        # and a directory it cannot read with exit 1 and a warning on stderr.
        # Only the first is a fact; every other answer that is not exit 0 is a
        # failed check, and a failed check never reads as free.
        self.worktree("one", "feat/one", commit=True)
        config = self.config(**{"commands": {"cleanup": ["fleet-clean"]}})
        # The sweep now asks for every open path on the machine first and only
        # walks a tree when that pass could not be read, so each stub answers
        # both forms: the sweep's pass for a held row, and the walk otherwise.
        folder = self.roots / "one"
        held_paths = "printf 'p12\\ncvim\\nn{0}\\n'; exit 0".format(folder)
        cases = [
            ("silent", "exit 1", False, "active", ""),
            ("warned", "echo \"lsof: WARNING: can't stat() /w\" >&2; exit 1", None, "unknown",
             "live process inspection unavailable: lsof exited 1: lsof: WARNING: can't stat() /w"),
            ("broken", "printf 'p12\\ncvim\\n'; exit 2", None, "unknown",
             "live process inspection unavailable: lsof exited 2"),
            ("held", "printf 'p12\\ncvim\\n'; exit 0", True, "held", "held by vim"),
            ("noisy-held", "printf 'p12\\ncvim\\n'; echo 'lsof: WARNING: x' >&2; exit 0", True,
             "held", "held by vim"),
        ]
        for label, walked, held, state, error in cases:
            with self.subTest(label):
                # A case that ends held answers the sweep's pass with the folder
                # somebody is working in; every other case answers it the way it
                # answers the walk, so no paths are read and the walk decides.
                environment = self.with_lsof(
                    label, "case \"$*\" in *+D*) {0} ;; *) {1} ;; esac"
                           .format(walked, held_paths if held else walked))
                with mock.patch.object(worktrees, "PLATFORM", "posix"):
                    row = self.row(worktrees.read_worktrees(config, environ=environment, now=NOW,
                                                            refresh=True), "one")
                self.assertIs(row["held"], held)
                self.assertEqual(row["state"], state)
                self.assertEqual(row.get("error", ""), error)
                if held is None:
                    self.assertEqual(row["cleanup_command"], "")
                else:
                    self.assertNotEqual(row["cleanup_command"], "")

    @unittest.skipIf(os.name == "nt", "lsof is not on Windows")
    def test_a_real_process_inside_a_worktree_is_seen_by_the_sweep(self):
        # The pass once asked lsof for the process and its command and nothing
        # else, so the paths it looked for were never printed and every sweep
        # read the machine as if nobody was anywhere. A real process, put in a
        # real worktree, is the only thing that catches that: a stub prints
        # whatever the case tells it to.
        path = self.worktree("one", "feat/one", commit=True)
        holder = subprocess.Popen(["sleep", "30"], cwd=str(path))

        def stop():
            holder.kill()
            holder.wait(timeout=30)

        self.addCleanup(stop)
        folders: list[tuple[str, str]] = []
        why = "the pass never ran"
        for _ in range(50):
            folders, why = worktrees.open_paths(self.config(), self.environment(), [self.roots])
            if any(name == "sleep" for name, _ in folders):
                break
            time.sleep(0.1)
        self.assertEqual(why, "")
        self.assertIn("sleep", [name for name, _ in folders])

    @unittest.skipIf(os.name == "nt", "lsof is not on Windows")
    def test_a_real_process_inside_a_linked_worktree_is_seen_by_the_sweep(self):
        # The same proof for a worktree folder that is itself a link: the pass
        # keeps what it reports at the target, and the row is matched there.
        target = self.root / "elsewhere" / "one"
        target.parent.mkdir(parents=True)
        self.git("worktree", "add", "-b", "feat/one", str(target), "main")
        link = self.roots / "one"
        os.symlink(target, link)
        holder = subprocess.Popen(["sleep", "30"], cwd=str(target))

        def stop():
            holder.kill()
            holder.wait(timeout=30)

        self.addCleanup(stop)
        folders: list[tuple[str, str]] = []
        why = "the pass never ran"
        for _ in range(50):
            folders, why = worktrees.open_paths(self.config(), self.environment(), [self.roots],
                                                [link])
            if any(name == "sleep" for name, _ in folders):
                break
            time.sleep(0.1)
        self.assertEqual(why, "")
        self.assertEqual(worktrees._held_by(folders, link), ["sleep"])

    def test_the_holder_list_does_not_call_a_sleeping_holder_a_user(self):
        self.assertEqual(sorted(worktrees.INERT_HOLDERS), ["caffeinat", "caffeinate"])


if __name__ == "__main__":
    unittest.main()
