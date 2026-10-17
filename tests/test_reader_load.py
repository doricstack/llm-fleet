#!/usr/bin/env python3
"""Load reader behavior, against a real process listing written by real commands.

The listing is a stub executable the configuration names, so the reader runs it
the way it runs the platform's own: resolved on the PATH the child receives,
bounded, and parsed from its stdout. The project lookup is exercised with a
stub lsof and with real `.git` directories and worktree files on disk.
"""

import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import time
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import load


NOW = 1_700_000_000.0


def script(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


LISTING = """\
  101 42.5 204800 01:02:03 /usr/bin/CompilingProgram thing
  202 4.0 1572864 2-03:04:05 /Applications/MemoryHog.app/Contents/MacOS/MemoryHog
  303 0.1 1024 00:12 python3 worker.py
"""


class LoadCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-load-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.output = self.root / "listing.txt"
        self.output.write_text(LISTING, encoding="utf-8")
        # A stub process list that prints a file, so a case can change what the
        # command says without rewriting the command.
        self.lister = script(self.root / "list.py", (
            "import sys\n"
            "print(open(sys.argv[1], 'r', encoding='utf-8').read(), end='')\n"))
        # The working-directory lookup is a stub lsof on the PATH the child gets,
        # so the lookup itself is the real call the reader makes.
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.cwds = self.root / "cwds.txt"
        self.cwds.write_text("", encoding="utf-8")
        script(self.bin / "lsof", (
            "#!/bin/sh\n"
            "cat '" + str(self.cwds) + "'\n"))

    def config(self, **load_overrides):
        source = {"enabled": True, "command": [sys.executable, str(self.lister),
                                               str(self.output)]}
        source.update(load_overrides)
        path = self.root / "config.json"
        path.write_text(json.dumps({"sources": {"load": source}}), encoding="utf-8")
        environment = sandbox.home_environment(self.root)
        environment["PATH"] = str(self.bin) + os.pathsep + environment.get("PATH", "")
        # The reader resolves its commands on the environment it is handed, and
        # the pane's own read hands it the one it was started with.
        self.environment = environment
        return load_config(path, environ=environment)

    def read(self, **load_overrides):
        return load.read_load(self.config(**load_overrides), now=NOW,
                              environ=self.environment)


class ListingTests(LoadCase):
    def test_a_line_carries_every_measurement_the_listing_gave(self):
        row = load.process_line("  101 42.5 204800 01:02:03 /usr/bin/CompilingProgram thing")
        self.assertEqual(row, {"pid": 101, "command": "/usr/bin/CompilingProgram thing",
                               "cpu_percent": 42.5, "memory_bytes": 204800 * 1024,
                               "elapsed_seconds": 3723.0})

    def test_an_age_with_days_reads_in_seconds(self):
        self.assertEqual(load.elapsed_seconds("2-03:04:05"), 183845.0)
        self.assertEqual(load.elapsed_seconds("03:04:05"), 11045.0)
        self.assertEqual(load.elapsed_seconds("03:04"), 184.0)
        self.assertEqual(load.elapsed_seconds("12"), 12.0)
        self.assertIsNone(load.elapsed_seconds("later"))

    def test_a_line_that_does_not_read_is_refused(self):
        for line in ("101 42.5 204800 01:02:03",
                     "abc 42.5 204800 01:02:03 command",
                     "101 hot 204800 01:02:03 command",
                     "101 42.5 -1 01:02:03 command",
                     "101 42.5 204800 later command"):
            self.assertIsNone(load.process_line(line), line)

    def test_nothing_recorded_is_not_a_process_at_nought(self):
        # Only lines that read count, and a listing of nothing is empty, not a
        # machine under no load.
        self.output.write_text("garbage\nmore garbage\n", encoding="utf-8")
        result = self.read()
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["processes"], [])
        self.assertEqual(result["errors"][0]["source"], "load")


class RankingTests(LoadCase):
    def test_the_heavy_process_either_way_is_drawn(self):
        result = self.read(top=1)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["total"], 3)
        # One from the top of the CPU list and one from the top of the memory
        # list, and the two happen to be different processes.
        self.assertEqual([row["pid"] for row in result["processes"]], [101, 202])

    def test_a_process_on_both_lists_is_sorted_by_cpu_and_drawn_once(self):
        self.output.write_text("  202 90.0 1572864 00:10 python3\n"
                               "  101 10.0 2048 00:10 python3\n", encoding="utf-8")
        result = self.read(top=2)
        self.assertEqual([row["pid"] for row in result["processes"]], [202, 101])

    def test_the_ceiling_is_the_top_of_each_list_not_of_the_union(self):
        result = self.read(top=1)
        self.assertLessEqual(len(result["processes"]), 2)


class ProjectTests(LoadCase):
    def repository(self, name="example-repo"):
        root = self.root / name
        root.mkdir()
        (root / ".git").mkdir()
        return root

    def test_a_folder_in_a_repository_names_it(self):
        root = self.repository()
        nested = root / "packages" / "app"
        nested.mkdir(parents=True)
        self.assertEqual(load.project_of(nested), ("example-repo", str(root)))
        self.assertEqual(load.project_of(root), ("example-repo", str(root)))

    def test_a_linked_worktree_names_the_repository_that_owns_it(self):
        root = self.repository()
        worktrees = root / ".git" / "worktrees" / "feature"
        worktrees.mkdir(parents=True)
        linked = self.root / "feature"
        linked.mkdir()
        (linked / ".git").write_text("gitdir: " + str(worktrees) + "\n", encoding="utf-8")
        # The gitdir a worktree names is resolved before the repository above it
        # is taken, because a temporary path can be a link to another one.
        self.assertEqual(load.project_of(linked), ("example-repo", str(root.resolve())))

    def test_a_folder_outside_every_repository_has_no_project(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.assertIsNone(load.project_of(outside))

    @unittest.skipIf(os.name == "nt",
                     "lsof is the working-directory tool this reader asks on POSIX; Windows has none")
    def test_the_drawn_rows_carry_the_project_their_process_works_in(self):
        root = self.repository()
        self.cwds.write_text("p101\nn" + str(root) + "\n", encoding="utf-8")
        result = self.read()
        rows = {row["pid"]: row for row in result["processes"]}
        self.assertEqual((rows[101]["project"], rows[101]["project_root"]),
                         ("example-repo", str(root)))
        # A process lsof did not name carries no project rather than a guess.
        self.assertNotIn("project", rows[202])

    def test_a_machine_that_cannot_read_folders_draws_no_projects(self):
        (self.bin / "lsof").unlink()
        result = self.read()
        self.assertEqual(result["state"], "ready")
        self.assertTrue(all("project" not in row for row in result["processes"]))


class FailureTests(LoadCase):
    def test_a_switched_off_source_reads_as_switched_off(self):
        result = self.read(enabled=False)
        self.assertEqual(result["state"], "disabled")
        self.assertEqual(result["processes"], [])

    def test_a_command_that_fails_names_its_exit(self):
        failing = script(self.root / "fail.py", "raise SystemExit(3)\n")
        result = self.read(command=[sys.executable, str(failing)])
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["errors"][0]["reason"], "exit 3")

    def test_a_command_that_is_not_there_reads_as_unavailable(self):
        result = self.read(command=[str(self.root / "missing-command")])
        self.assertEqual(result["state"], "unavailable")
        self.assertIn("not found", result["errors"][0]["reason"])

    def test_a_command_that_overruns_its_bound_fails_rather_than_hangs(self):
        slow = script(self.root / "slow.py", "import time\ntime.sleep(5)\n")
        path = self.root / "bound.json"
        path.write_text(json.dumps({"sources": {"load": {
            "enabled": True, "command": [sys.executable, str(slow)]}},
            "timeouts": {"commandSeconds": 1}}), encoding="utf-8")
        config = load_config(path, environ=sandbox.home_environment(self.root))
        started = time.monotonic()
        result = load.read_load(config, now=NOW)
        self.assertLess(time.monotonic() - started, 4.0)
        self.assertEqual(result["state"], "failed")
        self.assertIn("timed out", result["errors"][0]["reason"])

    def test_an_empty_listing_is_empty_rather_than_ready(self):
        self.output.write_text("", encoding="utf-8")
        result = self.read()
        self.assertEqual(result["state"], "empty")
        self.assertEqual(result["processes"], [])


if __name__ == "__main__":
    unittest.main()
