#!/usr/bin/env python3
"""The impact selection: what it plans, and what it refuses to plan.

The selector this repository used to run could see the Python suites and not the
TypeScript ones, because those run through scripts/typescript-suite.py rather
than through a framework adapter. A run that named eight suites and executed
four reported success over a change nothing had exercised, so the contract under
test is a plan that carries the work that changed, prints it under one header,
and names only suites that are there.

Two properties hold the whole file together and each has a case of its own: the
option contracts (tier, argument, help), and the refusal to depend on the
machine. A selection that reads a path from the checkout it was written in is
not a selection anyone else can run.

The plans are read in dry-run, so no case here needs a suite to pass to pass.
The selection cases drive a throwaway repository, which keeps them independent
of this working tree's own changes.

Run with: python3 tests/test_impact_override.py
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SELECTOR = ROOT / ".cits" / "test-impact.sh"
PLAN_HEADER = "--- plan ---"
NONE_AFFECTED = "nothing affected -> no tests to run"

# Anything that ties the script to one machine: a home directory spelled out, a
# Windows profile, or the variable that expands to either.
MACHINE_PATHS = (
    r"/(?:Users|home)/[A-Za-z0-9._-]+",
    r"[A-Z]:[\\/]Users[\\/]",
    r"\$(?:HOME|\{HOME\})",
    # An interpreter named by where it sits rather than by its name on the
    # path: it is the same fault as a home directory, one step harder to see,
    # and a selection that carries it runs on one machine's layout.
    r"/(?:usr/)?(?:local/)?bin/(?:python|node|bash)",
)


def recorder_makefile() -> str:
    """The throwaway Makefile the recording cases drive.

    The interpreter running this case, not the name `python3`: Windows installs
    `python`, and a recipe naming the other one is a command that does not exist
    there, so the target fails before it records anything.
    """
    interpreter = shlex.quote(sys.executable)
    return (f"test-report:\n\t@{interpreter} scripts/record.py test-report\n"
            f"test-ci:\n\t@{interpreter} scripts/record.py test-ci\n"
            f"\t@{interpreter} scripts/typescript-suite.py --suite components/one.test.ts\n")


def shell_environment(base: dict[str, str], platform: str,
                      shell: str | None) -> dict[str, str]:
    """The environment a case hands make, with the shell make must use.

    GNU make on Windows starts cmd.exe unless `SHELL` names a POSIX shell, and
    a recipe written for sh then answers 9009 as a command it cannot find. A
    Windows machine with Git for Windows installed has the shell; naming it is
    what makes the recipe run. A platform that already starts sh is left alone,
    because there make ignores the variable and a nested build should inherit
    nothing this suite invented.
    """
    env = dict(base)
    if platform == "nt" and shell:
        env["SHELL"] = shell
    return env


def clean_environment(**overrides: str) -> dict[str, str]:
    """The environment a case runs in: this machine's, less what a case sets.

    A report destination is inherited like any other variable, and the selector
    reads it. Left in place, a run started from inside another selection would
    change the plan under the case that is reading it, which is how a case comes
    to pass on one machine and fail on the next.
    """
    env = {key: value for key, value in os.environ.items()
           if key not in ("CITS_JUNIT_DIR", "CITS_JUNIT", "FLEET_TS_JUNIT_DIR",
                          "FLEET_JUNIT_XML")}
    env.update(overrides)
    shell = working_shell() if os.name == "nt" else None
    return shell_environment(env, os.name, shell)


def shell_candidates() -> list[str]:
    """Where this platform keeps a shell, in the order worth trying.

    Nothing here is a path from one machine: these are the names a platform
    keeps a shell under, and searching the path for them is what `command -v`
    does inside a shell.
    """
    names = ["bash.exe", "sh.exe"] if os.name == "nt" else ["bash", "sh"]
    candidates: list[str] = []
    if os.name == "nt":
        # Git for Windows, which is what provides the POSIX shell the make
        # targets need on this platform. Named first because it is the one that
        # works, not because the path is special.
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        for where in ("bin", str(Path("usr") / "bin")):
            candidates += [str(Path(program_files) / "Git" / where / name) for name in names]
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if directory:
            candidates += [str(Path(directory) / name) for name in names]
    return candidates


def working_shell(candidates: list[str] | None = None) -> str:
    """A shell that can actually run the selector on this platform.

    Asking for `bash` by name is not enough on Windows. The name resolves to the
    launcher in the system directory before it reaches the one that ships with
    Git, and that launcher answers every command with a message about installing
    a distribution, in UTF-16, on standard output. A case reading that result
    sees a failure it cannot explain rather than a machine that cannot run the
    script.

    So every candidate is asked to run something trivial first, and the first
    one that answers is the one used. A candidate that is present, named right,
    and still unable to run a command is not the shell.
    """
    for candidate in shell_candidates() if candidates is None else candidates:
        if not Path(candidate).is_file():
            continue
        probe = subprocess.run([candidate, "-c", "exit 0"], capture_output=True, check=False)
        if probe.returncode == 0:
            return candidate
    raise unittest.SkipTest(
        "no working POSIX shell on this platform: every candidate was tried and none of "
        "them ran a command")


def run_selector(*args: str, cwd: Path | None = None,
                 env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([working_shell(), str(SELECTOR), *args], cwd=str(cwd or ROOT),
                          capture_output=True, text=True, check=False,
                          env=env or clean_environment())


class SelectorContractTests(unittest.TestCase):
    """The option contracts, none of which needs a repository to be read."""

    def test_the_selector_is_executable(self) -> None:
        # A file without the executable bit is ignored by everything that would
        # delegate to it, and ignored in silence.
        self.assertTrue(SELECTOR.is_file(), SELECTOR)
        self.assertTrue(os.access(SELECTOR, os.X_OK), "the selector is not executable")

    def test_the_selector_reads_no_path_from_this_machine(self) -> None:
        # The repository is published and cloned elsewhere. A selection that
        # reaches into the directory it was written in works for exactly one
        # person, and fails for everyone else with a message about a missing
        # file rather than about a missing selection.
        source = SELECTOR.read_text(encoding="utf-8")
        for pattern in MACHINE_PATHS:
            self.assertIsNone(re.search(pattern, source), pattern)

    def test_an_unknown_tier_is_refused(self) -> None:
        result = run_selector("--tier", "sometimes")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("commit|push|ci", result.stderr)

    def test_a_missing_tier_is_refused(self) -> None:
        result = run_selector("--repo", str(ROOT), "--dry-run")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("--tier must be", result.stderr)

    def test_an_unknown_argument_is_refused(self) -> None:
        result = run_selector("--tier", "push", "--depth", "2")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("--depth", result.stderr)

    def test_help_prints_the_usage_and_exits_clean(self) -> None:
        result = run_selector("--help")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--tier commit|push|ci", result.stdout)

    def test_the_blanket_tier_plans_the_whole_suite_and_runs_nothing(self) -> None:
        # The blanket tier is the one tier allowed to run everything, and a plan
        # is not a run: nothing here may touch the working tree.
        before = _tree_fingerprint()
        result = run_selector("--tier", "ci", "--repo", str(ROOT), "--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count(PLAN_HEADER), 1)
        self.assertIn("$ make test-ci", result.stdout)
        self.assertNotIn("JUNIT_XML", result.stdout)
        self.assertEqual(before, _tree_fingerprint())

    def test_the_blanket_tier_passes_a_report_destination_to_the_whole_suite(self) -> None:
        # The full run is what a change that selects nothing falls back to, and
        # a full run that writes no report is one the gate cannot count: it
        # passed, and no receipt could say so.
        destination = Path(tempfile.gettempdir()) / "fleet-reports-case"
        result = run_selector("--tier", "ci", "--repo", str(ROOT), "--dry-run",
                              env=clean_environment(CITS_JUNIT_DIR=str(destination)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # The plan names no path: the run is handed its destinations in the
        # environment, where nothing expands them.
        self.assertIn("  $ make test-ci\n", result.stdout)
        self.assertNotIn(str(destination), result.stdout)
        self.assertIn("reports go to the folder the gate named", result.stdout)

    def test_the_exported_tree_run_writes_no_report_over_the_main_one(self) -> None:
        # A destination given on the command line reaches every make the full
        # run starts, the exported tree's included. That tree's suite would
        # write the same file last, and the receipt would count the copy rather
        # than the repository it was asked about.
        recipe = (ROOT / "make" / "test.mk").read_text(encoding="utf-8")
        exported = [line for line in recipe.splitlines()
                    if '-C "$$trial/public"' in line and " test " in line]
        self.assertEqual(len(exported), 1, exported)
        # Both destinations reach a run through the environment, so the
        # exported tree's make is started with both emptied.
        self.assertIn("FLEET_TS_JUNIT_DIR= FLEET_JUNIT_XML= $(MAKE) -C", exported[0])
        # A person may still name the destination on the command line, which
        # reaches every make the run starts; the exported tree's is emptied too.
        self.assertRegex(exported[0], r"\bJUNIT_XML=(\s|;|$)")


class ShellTests(unittest.TestCase):
    """The shell every case runs the selector through.

    The selector is a POSIX script, so a case that wants to read its plan needs
    a shell that runs one. Windows keeps a launcher under the name `bash` that
    is not a shell at all, and a suite that takes the first name it finds
    reports a machine problem in place of the contract it meant to check.
    """

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def script(self, name: str, body: str, mode: int = 0o755) -> str:
        path = self.root / name
        path.write_text(body, encoding="utf-8")
        path.chmod(mode)
        return str(path)

    def good_candidate(self) -> str:
        """A shell that really does run a command, to sit beside a broken one.

        Named rather than assumed, because the stand-in has to answer the same
        probe the resolver uses, and an interpreter does not: `-c "exit 0"` is a
        syntax error to Python, so a case built on one skips and reads as a case
        that passed.
        """
        for name in ("sh", "bash"):
            located = shutil.which(name)
            if located:
                return located
        self.skipTest("this platform has no shell to stand in as the working candidate")

    def test_a_candidate_that_cannot_run_a_command_is_passed_over(self) -> None:
        # The shape of the Windows trap: present, executable, named right, and
        # unable to run anything. It answers with a message and a failure, and
        # the resolver has to keep looking rather than take it.
        if os.name == "nt":
            self.skipTest("a shebang script is not a runnable candidate on this platform")
        good = self.good_candidate()
        broken = self.script("broken", "#!/bin/sh\nexit 3\n")
        self.assertEqual(working_shell([broken, good]), good)

    def test_a_candidate_that_is_not_there_is_passed_over(self) -> None:
        good = self.good_candidate()
        absent = str(self.root / "not-installed")
        self.assertEqual(working_shell([absent, good]), good)

    def test_no_working_candidate_says_so_rather_than_reading_as_a_failure(self) -> None:
        # A skip says the suite did not run here. A failure says the selector is
        # broken, which is a different claim and not one this machine can make.
        if os.name == "nt":
            self.skipTest("a shebang script is not a runnable candidate on this platform")
        broken = self.script("broken", "#!/bin/sh\nexit 3\n")
        with self.assertRaises(unittest.SkipTest):
            working_shell([broken, str(self.root / "not-installed")])

    def test_the_shell_the_cases_use_is_the_one_the_selector_runs_under(self) -> None:
        chosen = working_shell()
        probe = subprocess.run([chosen, str(SELECTOR), "--help"], capture_output=True,
                               text=True, check=False)
        self.assertEqual(probe.returncode, 0, probe.stdout + probe.stderr)
        self.assertIn("Usage:", probe.stdout)


class MakeShellTests(unittest.TestCase):
    """The shell make is told to use.

    Found is not the same as used: a Windows machine with Git for Windows has a
    POSIX shell and make still starts cmd.exe unless the variable names it, so
    the recipe answers 9009 and the suite reports a product failure that is the
    harness. These cases pin the handover, which no machine-specific run can.
    """

    def test_windows_is_handed_the_shell_it_has(self) -> None:
        env = shell_environment({}, "nt", "C:/Program Files/Git/bin/bash.exe")
        self.assertEqual(env.get("SHELL"), "C:/Program Files/Git/bin/bash.exe")

    def test_windows_with_no_shell_is_handed_nothing(self) -> None:
        # Nothing to name: the skip guard is what keeps this honest, and an
        # invented path would only move the failure somewhere harder to read.
        env = shell_environment({"PATH": "/usr/bin"}, "nt", None)
        self.assertNotIn("SHELL", env)
        self.assertEqual(env["PATH"], "/usr/bin")

    def test_a_platform_that_already_runs_sh_is_left_alone(self) -> None:
        env = shell_environment({}, "posix", "/bin/sh")
        self.assertNotIn("SHELL", env)

    def test_what_a_case_set_still_wins(self) -> None:
        env = shell_environment({"SHELL": "/chosen/sh"}, "nt", "/found/sh")
        self.assertEqual(env["SHELL"], "/found/sh")

    def test_the_recorder_makefile_names_the_running_interpreter(self) -> None:
        # A recipe naming `python3` on Windows is a command that does not exist,
        # and the target fails before it records what it was handed.
        recipe = recorder_makefile()
        self.assertIn(shlex.quote(sys.executable), recipe)
        # The name alone, not the path: an interpreter may itself be called
        # `python3`, and what is refused here is a recipe that trusts the name
        # to resolve on the machine that runs it.
        self.assertNotIn("@python3 ", recipe)
        self.assertNotIn("@python ", recipe)


class SelectionTests(unittest.TestCase):
    """The plan a real change produces, driven against a throwaway repository."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fleet-impact-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / ".cits").mkdir()
        shutil.copy2(SELECTOR, self.root / ".cits" / "test-impact.sh")
        os.chmod(self.root / ".cits" / "test-impact.sh", 0o755)
        for made in ("components", "config", "scripts", "docs", "tests",
                     "plugins/fleet/components"):
            (self.root / made).mkdir(parents=True, exist_ok=True)
        (self.root / "components" / "one.test.ts").write_text("// suite\n", encoding="utf-8")
        (self.root / "config" / "loader.test.ts").write_text("// suite\n", encoding="utf-8")
        (self.root / "scripts" / "typescript-suite.py").write_text("", encoding="utf-8")
        (self.root / "tests" / "test_thing.py").write_text("", encoding="utf-8")
        (self.root / "docs" / "notes.md").write_text("notes\n", encoding="utf-8")
        (self.root / "Makefile").write_text("test:\n\t@true\n", encoding="utf-8")
        (self.root / "plugins" / "fleet" / "components" / "widget.ts").write_text(
            "export const widget = 1;\n", encoding="utf-8")
        self.git("init", "-q")
        self.git("config", "user.email", "impact@example.invalid")
        self.git("config", "user.name", "Impact Test")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "fixture")

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-C", str(self.root), *args],
                              capture_output=True, text=True, check=False)

    def stage_change(self, path: str) -> None:
        target = self.root / path
        target.write_text(target.read_text(encoding="utf-8") + "// changed\n",
                          encoding="utf-8")
        self.git("add", "--", path)

    def plan_for(self, path: str) -> subprocess.CompletedProcess[str]:
        self.stage_change(path)
        return run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                            cwd=self.root)

    def planned_commands(self, output: str) -> list[str]:
        return [line[4:] for line in output.splitlines() if line.startswith("  $ ")]

    def test_a_changed_source_plans_the_whole_typescript_layer(self) -> None:
        result = self.plan_for("plugins/fleet/components/widget.ts")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count(PLAN_HEADER), 1, result.stdout)
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertIn("--suite components/one.test.ts", planned)
        self.assertIn("--suite config/loader.test.ts", planned)

    def test_a_changed_suite_is_planned_alongside_the_rest(self) -> None:
        # A suite that changed and is not named is the exact failure this file
        # exists to prevent, so a changed suite is planned even in a change set
        # that carries nothing else.
        result = self.plan_for("components/one.test.ts")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertIn("--suite components/one.test.ts", planned)

    def test_a_change_to_the_plugin_names_the_suite_it_cannot_run(self) -> None:
        # The plugin's own suite loads the host's test kit, which plain node
        # cannot. Leaving it out in silence is how a run comes to report success
        # over a change nothing exercised; naming it is the whole difference.
        result = self.plan_for("plugins/fleet/components/widget.ts")
        self.assertIn("plugins/fleet runs through the host's test kit", result.stdout)

    def test_an_unstaged_change_is_selected_at_the_commit_tier(self) -> None:
        # The commit tier is what `make test-impacted` runs, and the work in a
        # tree is usually unstaged when a person runs it. A selection that read
        # only the index would answer "nothing affected" over an edit sitting
        # right there, which is worse than not offering the command.
        target = self.root / "plugins" / "fleet" / "components" / "widget.ts"
        target.write_text(target.read_text(encoding="utf-8") + "// uncommitted\n",
                          encoding="utf-8")
        result = run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                              cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertIn("--suite components/one.test.ts", planned)

    def test_a_new_file_that_is_not_added_yet_is_selected(self) -> None:
        # A test written before the code it covers is a file that is not staged
        # yet, and that is the first thing a person runs the selection against.
        # A change set built from the index and the tracked diff cannot see it,
        # so the command answers "nothing affected" over the one file the whole
        # exercise is about.
        (self.root / "tests" / "test_new.py").write_text("", encoding="utf-8")
        result = run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                              cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("make test-report", " ".join(self.planned_commands(result.stdout)))

    def test_a_new_typescript_suite_that_is_not_added_yet_is_selected(self) -> None:
        (self.root / "components" / "two.test.ts").write_text("// new\n", encoding="utf-8")
        result = run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                              cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertIn("--suite components/two.test.ts", planned)

    def test_a_change_to_the_selection_plans_the_suite_that_covers_it(self) -> None:
        # The selector is code, and a suite exists to cover it. A change to it
        # that selected nothing would be this file's own failure mode, aimed at
        # itself.
        result = self.plan_for(".cits/test-impact.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("make test-report", " ".join(self.planned_commands(result.stdout)))

    def test_a_changed_schema_in_the_plugin_plans_both_config_suites(self) -> None:
        # The schema lives in the plugin folder, which an install copies, and
        # both loaders read it: a contract change there that planned neither
        # loader's suite would land unchecked.
        schema = self.root / "plugins" / "fleet" / "config" / "schema.json"
        schema.parent.mkdir(parents=True)
        schema.write_text("{}\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "schema")
        result = self.plan_for("plugins/fleet/config/schema.json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertIn("make test-report", planned)
        self.assertIn("--suite config/loader.test.ts", planned)

    def test_a_changed_python_file_plans_the_python_suite(self) -> None:
        result = self.plan_for("tests/test_thing.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("make test-report", self.planned_commands(result.stdout))

    def test_a_report_destination_is_passed_to_the_python_run(self) -> None:
        # A gate reads a report, and a report is only written where it is asked
        # for. A selection that ran the suite and wrote nothing would hand the
        # gate an exit code, which is the one thing it cannot use.
        self.stage_change("tests/test_thing.py")
        destination = self.root / "reports"
        result = run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                              cwd=self.root,
                              env=clean_environment(CITS_JUNIT_DIR=str(destination)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        planned = " ".join(self.planned_commands(result.stdout))
        # The plan runs the suite plainly; the destination travels in the
        # environment, which the recording cases below read.
        self.assertIn("make test-report", planned)
        self.assertNotIn(str(destination), result.stdout)

    def install_recorders(self) -> Path:
        """Stand-ins that write down what they were started with, and nothing else.

        The runner and the make targets are replaced by scripts that append the
        arguments and the report folder they received to one log, so a case reads
        what the selection really ran rather than the text of its plan.
        """
        log = self.root / "ran.log"
        recorder = (
            "import json, os, sys\n"
            "with open(os.environ['STUB_LOG'], 'a', encoding='utf-8') as handle:\n"
            "    handle.write(json.dumps({'argv': sys.argv[1:],\n"
            "        'folder': os.environ.get('FLEET_TS_JUNIT_DIR', ''),\n"
            "        'report': os.environ.get('FLEET_JUNIT_XML', '')}) + '\\n')\n")
        (self.root / "scripts" / "typescript-suite.py").write_text(recorder, encoding="utf-8")
        (self.root / "scripts" / "record.py").write_text(recorder, encoding="utf-8")
        (self.root / "Makefile").write_text(recorder_makefile(), encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "recorders")
        return log

    def ran(self, log: Path) -> list[dict]:
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    @unittest.skipUnless(working_shell(), "the selection needs a POSIX shell to run make")
    def test_every_typescript_suite_is_handed_the_report_folder(self) -> None:
        # A change to the TypeScript side alone runs no Python suite, so a
        # report only the Python run writes leaves the gate nothing to count.
        # The folder reaches each suite whole, a space and a semicolon in it
        # included: it is one folder, and nothing after the semicolon runs.
        log = self.install_recorders()
        self.stage_change("plugins/fleet/components/widget.ts")
        folder = self.root / "rep orts; touch pwned #"
        result = run_selector("--tier", "commit", "--repo", str(self.root), cwd=self.root,
                              env=clean_environment(CITS_JUNIT_DIR=str(folder),
                                                    STUB_LOG=str(log)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        suites = [entry for entry in self.ran(log) if "--suite" in entry["argv"]]
        self.assertEqual(len(suites), 2, self.ran(log))
        self.assertEqual({entry["folder"] for entry in suites}, {str(folder)})
        # No path is spliced into the runner's arguments any more.
        self.assertTrue(all("--junit" not in entry["argv"] for entry in suites))
        self.assertFalse((self.root / "pwned").exists())

    @unittest.skipUnless(working_shell(), "the selection needs a POSIX shell to run make")
    def test_the_python_report_path_stays_one_word(self) -> None:
        log = self.install_recorders()
        self.stage_change("tests/test_thing.py")
        # A space, a semicolon, a quote and a command substitution: a shell, or
        # make expanding a variable, would split it or run something.
        folder = Path(str(self.root) + "/rep orts; touch pwned # \" $(touch pwned2)")
        result = run_selector("--tier", "commit", "--repo", str(self.root), cwd=self.root,
                              env=clean_environment(CITS_JUNIT_DIR=str(folder),
                                                    STUB_LOG=str(log)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        reports = [entry for entry in self.ran(log) if entry["argv"][:1] == ["test-report"]]
        self.assertEqual([entry["argv"] for entry in reports], [["test-report"]])
        self.assertEqual([entry["report"] for entry in reports],
                         [str(folder) + "/fleet-python.xml"])
        self.assertFalse((self.root / "pwned").exists())
        self.assertFalse((self.root / "pwned2").exists())

    def test_the_whole_run_hands_the_folder_to_its_typescript_suites(self) -> None:
        # The full run starts its TypeScript suites from make targets the
        # selection never sees; the folder still reaches them, so a full run's
        # receipt counts them rather than the Python run alone.
        log = self.install_recorders()
        folder = self.root / "reports"
        # A recording make stands first on the path: a machine may route the
        # real `make test-ci` through a queue for whole runs, and this case is
        # about what the run is handed, not about waiting for a turn.
        tools = self.root / "tools"
        tools.mkdir()
        make = tools / "make"
        # The interpreter running this case, not the name `python3`: Windows
        # installs `python`, so a stub that spells the other name is a command
        # that does not exist there.
        interpreter = shlex.quote(sys.executable)
        make.write_text("#!/bin/sh\n"
                        + interpreter + " scripts/record.py \"$@\"\n"
                        + "exec " + interpreter + " scripts/typescript-suite.py"
                          " --suite components/one.test.ts\n",
                        encoding="utf-8")
        make.chmod(0o755)
        path = str(tools) + os.pathsep + os.environ.get("PATH", "")
        result = run_selector("--tier", "ci", "--repo", str(self.root), cwd=self.root,
                              env=clean_environment(CITS_JUNIT_DIR=str(folder),
                                                    STUB_LOG=str(log), PATH=path))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        entries = self.ran(log)
        self.assertEqual(entries[0]["argv"], ["test-ci"])
        self.assertEqual(entries[0]["report"], str(folder) + "/fleet-python.xml")
        self.assertEqual([entry["folder"] for entry in entries if "--suite" in entry["argv"]],
                         [str(folder)])

    @unittest.skipUnless(working_shell(), "the selection needs a POSIX shell to run make")
    def test_no_report_folder_hands_none_to_any_suite(self) -> None:
        # A person running the selection by hand asked for no report, and a
        # file written where nobody looks is litter.
        log = self.install_recorders()
        self.stage_change("plugins/fleet/components/widget.ts")
        result = run_selector("--tier", "commit", "--repo", str(self.root), cwd=self.root,
                              env=clean_environment(STUB_LOG=str(log)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        suites = [entry for entry in self.ran(log) if "--suite" in entry["argv"]]
        self.assertEqual(len(suites), 2)
        self.assertEqual({entry["folder"] for entry in suites}, {""})

    @unittest.skipUnless(working_shell(), "the selection needs a POSIX shell to run make")
    def test_a_stub_interpreter_is_passed_over_for_one_that_answers(self) -> None:
        # Windows keeps a `python3` on the path that answers every call with a
        # message about the Microsoft Store and exits 49. A name that resolves
        # is not an interpreter, and a selection that believes it fails every
        # TypeScript suite with 49 as though the suite were broken.
        log = self.install_recorders()
        tools = self.root / "tools"
        tools.mkdir()
        stub = tools / "python3"
        stub.write_text("#!/bin/sh\nexit 49\n", encoding="utf-8")
        stub.chmod(0o755)
        answering = tools / "python"
        answering.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " \"$@\"\n",
                             encoding="utf-8")
        answering.chmod(0o755)
        self.stage_change("plugins/fleet/components/widget.ts")
        path = str(tools) + os.pathsep + os.environ.get("PATH", "")
        result = run_selector("--tier", "commit", "--repo", str(self.root), cwd=self.root,
                              env=clean_environment(STUB_LOG=str(log), PATH=path))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        suites = [entry for entry in self.ran(log) if "--suite" in entry["argv"]]
        self.assertEqual(len(suites), 2, self.ran(log))

    @unittest.skipUnless(working_shell(), "the selection needs a POSIX shell to run make")
    def test_no_interpreter_that_answers_is_named_rather_than_run(self) -> None:
        # Nothing to fall back to: the selection says so once, by name, rather
        # than starting suites that cannot run and reporting them as failures.
        self.install_recorders()
        tools = self.root / "tools"
        tools.mkdir()
        for name in ("python3", "python"):
            stub = tools / name
            stub.write_text("#!/bin/sh\nexit 49\n", encoding="utf-8")
            stub.chmod(0o755)
        self.stage_change("plugins/fleet/components/widget.ts")
        # The stubs come first, so both names resolve to one that answers 49;
        # the rest of the path stays, because git still has to be found.
        path = str(tools) + os.pathsep + os.environ.get("PATH", "")
        result = run_selector("--tier", "commit", "--repo", str(self.root), cwd=self.root,
                              env=clean_environment(PATH=path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no Python interpreter answers", result.stderr)

    def test_a_changed_python_file_plans_no_typescript_suite(self) -> None:
        # The two layers are selected by what changed, not by what exists: a
        # plan that ran the TypeScript layer for a Python edit would spend the
        # minutes this file exists to save.
        result = self.plan_for("tests/test_thing.py")
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertNotIn("typescript-suite.py", planned)

    def test_every_planned_suite_exists(self) -> None:
        # A plan naming a file that is not there fails at run time, after the
        # gate has already been reported as ready to pass.
        result = self.plan_for("plugins/fleet/components/widget.ts")
        commands = self.planned_commands(result.stdout)
        suites = [part.split("--suite ", 1)[1] for part in commands if "--suite " in part]
        self.assertTrue(suites, result.stdout)
        for suite in suites:
            self.assertTrue((self.root / suite).is_file(), suite)

    def test_a_suite_deleted_from_disk_is_not_planned(self) -> None:
        # `git ls-files` reads the index, and a file removed with `rm` is still
        # listed there. Planning it would hand the runner a path that is not
        # there, and the runner reports that as an unavailable runtime rather
        # than as a missing suite, which reads as a machine problem.
        (self.root / "components" / "one.test.ts").unlink()
        result = self.plan_for("plugins/fleet/components/widget.ts")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        planned = " ".join(self.planned_commands(result.stdout))
        self.assertNotIn("--suite components/one.test.ts", planned)
        self.assertIn("--suite config/loader.test.ts", planned)

    def test_a_change_no_suite_covers_plans_nothing(self) -> None:
        # A note is not code. What is left is a stated empty selection rather
        # than a suite run to fill the silence.
        self.stage_change("docs/notes.md")
        result = run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                              cwd=self.root)
        self._assert_nothing_planned(result)

    def test_nothing_staged_plans_nothing(self) -> None:
        result = run_selector("--tier", "commit", "--repo", str(self.root), "--dry-run",
                              cwd=self.root)
        self._assert_nothing_planned(result)

    def _assert_nothing_planned(self, result: subprocess.CompletedProcess[str]) -> None:
        """An empty selection is stated, and is not dressed as a plan.

        A run that prints the header and then names no command reads as a plan
        that came out empty, which is a different claim from a selection that
        found nothing to run. The reader of a log is owed the second one.
        """
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(NONE_AFFECTED, result.stdout)
        self.assertNotIn(PLAN_HEADER, result.stdout)
        self.assertEqual(self.planned_commands(result.stdout), [])


def _tree_fingerprint() -> int:
    """A cheap reading of the tracked tree, so a plan can prove it wrote nothing.

    Read through the index rather than by walking the directory: a walk reaches
    into Git's own object store, which holds tens of thousands of files, and a
    helper that slow turns every case that uses it into a slow one.
    """
    listed = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"],
                            capture_output=True, text=True, check=False)
    total = 0
    for name in listed.stdout.split("\0"):
        if not name:
            continue
        path = ROOT / name
        if path.is_file():
            total += path.stat().st_mtime_ns % 1_000_000
    return total


if __name__ == "__main__":
    unittest.main()
