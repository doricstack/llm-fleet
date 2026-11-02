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
from unittest import mock

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


class SystemLoadTests(unittest.TestCase):
    """The machine's own figures, parsed from what each platform actually printed.

    A process's percentage says what one program costs; the summary a person
    reads needs what the machine has left, and a platform that does not state it
    has to answer nothing rather than nought.
    """

    # One real `top -l 1 -n 0` sample from macOS, kept as it printed.
    TOP = """\
Processes: 900 total, 3 running, 897 sleeping, 4500 threads
Load Avg: 39.26, 34.60, 33.93
CPU usage: 55.49% user, 19.89% sys, 24.61% idle
PhysMem: 126G used (9887M wired, 0B compressor), 1634M unused.
"""

    def test_macos_reports_the_cpu_share_the_load_and_the_memory(self):
        system = load.parse_top_system(self.TOP)
        self.assertIsNotNone(system)
        assert system is not None
        self.assertAlmostEqual(system["cpuPercent"], 75.39, places=2)
        self.assertEqual(system["loadAverage"], [39.26, 34.60, 33.93])
        self.assertEqual(system["memoryUsedBytes"], 126 * 1024 ** 3)
        self.assertEqual(system["memoryTotalBytes"], 126 * 1024 ** 3 + 1634 * 1024 ** 2)

    def test_macos_is_read_from_the_last_sample_not_the_one_since_boot(self):
        # `top` is asked for two samples: the first covers the machine's whole
        # uptime and says nothing about now, so the second is the reading.
        first = self.TOP.replace("24.61% idle", "10.00% idle")
        system = load.parse_top_system(first + self.TOP)
        self.assertIsNotNone(system)
        assert system is not None
        self.assertAlmostEqual(system["cpuPercent"], 75.39, places=2)

    def test_a_sample_with_no_figures_is_not_a_reading(self):
        for output in ("", "Processes: 900 total\n", "CPU usage: half\n"):
            with self.subTest(output=output):
                self.assertIsNone(load.parse_top_system(output))

    def test_linux_reports_the_busy_share_between_two_samples(self):
        first = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\n"
        second = "cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0 0 0\n"
        system = load.parse_proc_system(
            first, second, "0.47 0.34 0.28 1/1234 5678",
            "MemTotal:       16000000 kB\nMemFree:         2000000 kB\n"
            "MemAvailable:    4000000 kB\n")
        self.assertIsNotNone(system)
        assert system is not None
        # 100 busy ticks of 200 total, idle and waiting counted as neither.
        self.assertAlmostEqual(system["cpuPercent"], 50.0)
        self.assertEqual(system["loadAverage"], [0.47, 0.34, 0.28])
        self.assertEqual(system["memoryTotalBytes"], 16000000 * 1024)
        self.assertEqual(system["memoryUsedBytes"], (16000000 - 4000000) * 1024)

    def test_a_linux_sample_that_did_not_move_says_nothing_about_cpu(self):
        same = "cpu  100 0 100 800 0 0 0 0 0 0\n"
        system = load.parse_proc_system(same, same, "", "")
        self.assertIsNone(system)

    def test_guest_time_is_not_charged_twice(self):
        # Guest ticks are already inside user and nice, so counting the later
        # fields as well would make a machine running virtual machines read as
        # busier than it is.
        first = "cpu  100 0 100 800 0 0 0 300 0 200\n"
        second = "cpu  200 0 200 1000 0 0 0 600 0 400\n"
        self.assertEqual(load.parse_proc_stat(first), (1300, 800))
        self.assertEqual(load.parse_proc_stat(second), (2000, 1000))

    def test_windows_reports_its_load_and_its_memory_in_kilobytes(self):
        system = load.parse_wmic_system(
            "FreePhysicalMemory=2000000\nTotalVisibleMemorySize=16000000\n",
            "LoadPercentage=42\n")
        self.assertIsNotNone(system)
        assert system is not None
        self.assertEqual(system["cpuPercent"], 42.0)
        self.assertEqual(system["memoryTotalBytes"], 16000000 * 1024)
        self.assertEqual(system["memoryUsedBytes"], (16000000 - 2000000) * 1024)
        self.assertIsNone(system["loadAverage"])

    def test_a_windows_rate_is_the_busy_share_of_two_samples(self):
        # GetSystemTimes counts idle, kernel and user ticks, and the kernel
        # total already holds the idle ones. Between the samples the kernel
        # gained 100 ticks and user 100, of which 50 were idle: three quarters
        # of the machine was busy.
        first = (100, 300, 200)
        second = (150, 400, 300)
        self.assertEqual(load.windows_cpu_percent(first, second), 75.0)
        # A machine that gave nothing between the samples states no figure
        # rather than a measured zero.
        self.assertIsNone(load.windows_cpu_percent(first, first))
        self.assertEqual(load.windows_cpu_percent((0, 0, 0), (100, 100, 0)), 0.0)

    def test_a_machine_with_two_processor_packages_reports_the_whole_machine(self):
        # wmic prints one block per processor instance. Keeping the last one
        # drew one package's share as the machine's: 3 percent while the other
        # package sat at 97. The meter is the mean of what was printed.
        system = load.parse_wmic_system(
            "FreePhysicalMemory=2000000\nTotalVisibleMemorySize=16000000\n",
            "LoadPercentage=3\n\n\nLoadPercentage=97\n")
        self.assertIsNotNone(system)
        assert system is not None
        self.assertEqual(system["cpuPercent"], 50.0)

    def test_a_windows_machine_that_states_no_processor_draws_no_cpu_meter(self):
        # PowerShell prints no LoadPercentage line when the processor query
        # answers nothing, which is what the command is written to do rather
        # than casting the empty answer to a measured zero.
        system = load.parse_wmic_system(
            "FreePhysicalMemory=2000000\nTotalVisibleMemorySize=16000000\n", "")
        self.assertIsNotNone(system)
        assert system is not None
        self.assertIsNone(system["cpuPercent"])
        self.assertEqual(system["memoryUsedBytes"], (16000000 - 2000000) * 1024)

    def test_a_size_a_platform_printed_is_read_in_its_own_unit(self):
        self.assertEqual(load._size_of("126G"), 126 * 1024 ** 3)
        self.assertEqual(load._size_of("9887M"), 9887 * 1024 ** 2)
        self.assertEqual(load._size_of("1634MB"), 1634 * 1024 ** 2)
        self.assertEqual(load._size_of("512"), 512)
        self.assertIsNone(load._size_of("a lot"))

    @unittest.skipUnless(sys.platform == "darwin", "macOS is what states these in top")
    def test_the_machine_this_runs_on_reports_its_own_load(self):
        system = load.system_load(dict(os.environ), 10.0)
        self.assertIsNotNone(system, "top printed nothing this parser could read")
        assert system is not None
        self.assertGreaterEqual(system["cpuPercent"], 0.0)
        self.assertLessEqual(system["cpuPercent"], 100.0)
        self.assertEqual(len(system["loadAverage"]), 3)
        self.assertLessEqual(system["memoryUsedBytes"], system["memoryTotalBytes"])

    @unittest.skipUnless(os.name == "nt", "Windows is where the kernel32 read runs")
    def test_a_windows_machine_answers_its_own_figures_without_a_command(self):
        # wmic is gone on Windows 11 24H2 and PowerShell takes longer to start
        # than a read may wait, so the platform's own interface is asked first.
        # This is the live check: the counters come from the running machine.
        system = load.windows_system()
        self.assertIsNotNone(system)
        assert system is not None
        self.assertIsNotNone(system["cpuPercent"], system)
        self.assertGreaterEqual(system["cpuPercent"], 0.0)
        self.assertLessEqual(system["cpuPercent"], 100.0)
        self.assertGreater(system["memoryTotalBytes"], 0)
        self.assertLessEqual(system["memoryUsedBytes"], system["memoryTotalBytes"])

    @unittest.skipUnless(os.name == "nt", "Windows is where the PowerShell fallback runs")
    def test_a_windows_machine_without_wmic_is_asked_through_powershell(self):
        # Windows 11 24H2 turns `wmic` off by default, so the reader asks the
        # interface it points people at instead. The stub prints what the real
        # command prints, in the shape the wmic parser already reads.
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / "powershell.cmd"
            script.write_text("@echo off\r\n"
                              "echo TotalVisibleMemorySize=16000000\r\n"
                              "echo FreePhysicalMemory=2000000\r\n"
                              "echo LoadPercentage=42\r\n")
            # The platform's own interface is answered with nothing, which is
            # what a machine that refuses that call looks like: the command
            # behind it is the subject here.
            with mock.patch.object(load, "windows_system", lambda: None):
                system = load.system_load({"PATH": folder}, 10.0)
        self.assertIsNotNone(system, "the PowerShell answer was not read")
        assert system is not None
        self.assertEqual(system["cpuPercent"], 42.0)
        self.assertEqual(system["memoryTotalBytes"], 16000000 * 1024)
        self.assertEqual(system["memoryUsedBytes"], (16000000 - 2000000) * 1024)

    def test_the_powershell_fallback_is_asked_with_the_query_it_needs(self):
        # A stub that prints fixed lines proves the reader parses an answer and
        # nothing about what it asked. This records the argv the reader hands to
        # the command it runs, so a fallback that stopped naming the processor
        # query, or that passed it as anything but -Command, fails here. The
        # command is not run: what is under test is what would be run.
        asked: list[list[str]] = []

        def record(_environment, command, _seconds):
            asked.append(list(command))
            return ""

        with mock.patch.object(load, "_print", record), \
                mock.patch.object(load, "windows_system", lambda: None), \
                mock.patch.object(load, "PLATFORM", "nt"):
            load.system_load({"PATH": ""}, 3.0)
        powershell = [command for command in asked if command[0] == "powershell"]
        self.assertEqual(len(powershell), 1)
        command = powershell[0]
        self.assertIn("-Command", command)
        script = command[command.index("-Command") + 1]
        self.assertIn("Get-CimInstance Win32_Processor", script)
        self.assertIn("TotalVisibleMemorySize", script)
        # The share is the mean of the packages the query returns, not the last.
        self.assertIn("Measure-Object -Property LoadPercentage -Average", script)

    def test_a_command_the_machine_does_not_have_answers_nothing(self):
        # Every call this reader makes is bounded and optional: one the machine
        # cannot make answers None, which the pane draws as no meter at all.
        with tempfile.TemporaryDirectory() as empty:
            self.assertIsNone(load._print({"PATH": empty}, ["not-a-command"], 1.0))


class UnreadableProcessListTests(LoadCase):
    """What the section still says when the process list is the part that failed.

    The two readings are separate: the process table comes from a command a
    person configures, and the machine's own shares come from the platform. A
    platform with no process command, which is every Windows machine until one
    is named, still draws its meters.
    """

    def test_a_missing_process_command_leaves_the_section_unavailable(self):
        result = self.read(command=["not-a-command"])
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["errors"][0]["source"], "load")
        self.assertIn("system", result)

    @unittest.skipUnless(sys.platform == "darwin", "top is what states these on this Mac")
    def test_the_machine_still_states_its_own_figures(self):
        result = self.read(command=["not-a-command"])
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNotNone(result["system"], "the meters went with the process list")
        assert result["system"] is not None
        self.assertLessEqual(result["system"]["cpuPercent"], 100.0)


if __name__ == "__main__":
    unittest.main()
