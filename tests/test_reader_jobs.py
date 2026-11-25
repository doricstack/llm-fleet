#!/usr/bin/env python3
"""A job's project: the repository a run belongs to, not the folder it sits in.

The pane draws it as a column, so the reader is the only place that can tell a
worktree from the repository that owns it: a worktree folder holds a `.git` file
naming its repository, and a folder no repository holds is called by its own
name.
"""

from pathlib import Path
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from readers import jobs


class ProjectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_a_worktree_names_the_repository_that_owns_it(self):
        project = self.root / "workbench"
        project.mkdir()
        (project / ".git").mkdir()
        worktree = self.root / "elsewhere" / "perf-zod"
        worktree.mkdir(parents=True)
        (worktree / ".git").write_text(
            "gitdir: " + str(project / ".git" / "worktrees" / "perf-zod") + "\n",
            encoding="utf-8")
        self.assertEqual(jobs.project_name(str(worktree), 200), "workbench")

    def test_a_folder_outside_a_repository_is_its_own_name(self):
        scratch = self.root / "scratch" / "copy-one"
        scratch.mkdir(parents=True)
        self.assertEqual(jobs.project_name(str(scratch), 200), "copy-one")

    def test_a_job_with_no_folder_names_no_project(self):
        # Nothing to read is not a project called nothing.
        self.assertIsNone(jobs.project_name("", 200))
        self.assertIsNone(jobs.project_name(None, 200))
        self.assertIsNone(jobs.project_name(17, 200))

    def test_a_long_name_reaches_the_pane_bounded(self):
        # A folder name the filesystem allows, past the limit the reader keeps.
        odd = self.root / ("p" * 250)
        odd.mkdir()
        self.assertLessEqual(len(jobs.project_name(str(odd), 100) or ""), 100)


if __name__ == "__main__":
    unittest.main()
