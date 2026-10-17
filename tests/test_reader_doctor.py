#!/usr/bin/env python3
"""What the doctor says about a machine, and the setting it names for each fix.

Every case is a real configuration file and real directories in a temporary
home, read through the loader, so a hint the doctor gives is one the loader
would act on: a fix that names a key the schema does not have is the failure
this suite exists to catch.
"""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from config.loader import load_schema
from readers import doctor


class DoctorCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.environ = {"HOME": str(self.home), "PATH": str(self.bin)}

    def tearDown(self) -> None:
        self.directory.cleanup()

    def tool(self, name: str) -> Path:
        # Windows finds a command by the extensions in PATHEXT, so the stub
        # there is a batch file; elsewhere it is an executable script.
        if os.name == "nt":
            path = self.bin / (name + ".cmd")
            path.write_text("@exit /b 0\r\n", encoding="utf-8")
            return path
        path = self.bin / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def config(self, document: dict) -> Path:
        path = self.home / ".config" / "llm-fleet" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def source(self, diagnosis: dict, name: str) -> dict:
        return next(entry for entry in diagnosis["sources"] if entry["id"] == name)


class ConfigurationTests(DoctorCase):
    def test_no_file_is_the_defaults_and_names_where_one_would_go(self):
        diagnosis = doctor.diagnose(environ=self.environ)
        self.assertEqual(diagnosis["config"]["state"], "absent")
        self.assertEqual(diagnosis["config"]["path"],
                         str(self.home / ".config" / "llm-fleet" / "config.json"))
        text = "\n".join(doctor.render(diagnosis))
        self.assertIn("/fleet setup", text)

    def test_a_refused_file_names_every_error_and_counts_as_a_problem(self):
        self.config({"providers": "none", "sources": {"jobs": {"enabled": "yes"}}})
        diagnosis = doctor.diagnose(environ=self.environ)
        self.assertEqual(diagnosis["config"]["state"], "refused")
        self.assertEqual(len(diagnosis["config"]["errors"]), 2)
        self.assertGreaterEqual(diagnosis["problems"], 1)
        text = "\n".join(doctor.render(diagnosis))
        self.assertIn("providers", text)
        self.assertIn("sources.jobs.enabled", text)

    def test_a_relative_selector_is_refused_by_name(self):
        diagnosis = doctor.diagnose(environ={**self.environ, "FLEET_CONFIG": "fleet.json"})
        self.assertEqual(diagnosis["config"]["origin"], "environment")
        self.assertEqual(diagnosis["config"]["state"], "refused")
        self.assertIn("$FLEET_CONFIG", "\n".join(doctor.render(diagnosis)))


class SourceTests(DoctorCase):
    def test_a_source_waiting_on_a_provider_names_the_providers_list(self):
        diagnosis = doctor.diagnose(environ=self.environ)
        jobs = self.source(diagnosis, "jobs")
        self.assertEqual(jobs["state"], "unconfigured")
        self.assertTrue(jobs["problem"])
        self.assertIn("providers", jobs["hint"])

    def test_an_enabled_source_without_its_field_names_that_field(self):
        self.config({"sources": {"prs": {"enabled": True}}})
        diagnosis = doctor.diagnose(environ=self.environ)
        self.assertEqual(diagnosis["config"]["state"], "refused")
        # The loader refuses this rather than leaving it unconfigured, and the
        # doctor reports the refusal with the loader's own path.
        self.assertIn("sources.prs.repositories",
                      [entry["path"] for entry in diagnosis["config"]["errors"]])

    def test_a_missing_target_is_unavailable_and_names_the_field_and_its_kind(self):
        self.config({"sources": {"trials": {"enabled": True,
                                            "database": str(self.root / "gone.db")}}})
        trials = self.source(doctor.diagnose(environ=self.environ), "trials")
        self.assertEqual(trials["state"], "unavailable")
        self.assertTrue(trials["problem"])
        self.assertIn("sources.trials.database", trials["hint"])
        self.assertIn("file", trials["hint"])

    def test_a_source_switched_off_is_not_a_problem_and_says_how_to_switch_it_on(self):
        worktrees = self.source(doctor.diagnose(environ=self.environ), "worktrees")
        self.assertEqual(worktrees["state"], "disabled")
        self.assertFalse(worktrees["problem"])
        self.assertIn("sources.worktrees.enabled", worktrees["hint"])

    def test_every_hint_names_a_key_the_schema_declares(self):
        declared = {field["path"] for field in load_schema("")["fields"]} | {"providers"}
        self.config({"sources": {"trials": {"enabled": True, "database": str(self.root / "x")}}})
        diagnosis = doctor.diagnose(environ=self.environ)
        for entry in diagnosis["sources"]:
            for key in doctor.hint_keys(entry["hint"] or ""):
                self.assertIn(key, declared, entry["id"])


class ProviderAndCommandTests(DoctorCase):
    def test_a_provider_whose_home_exists_is_ready_and_one_without_is_named(self):
        (self.home / ".claude").mkdir()
        self.config({"providers": [{"id": "claude", "home": "$HOME/.claude"},
                                   {"id": "gone", "home": str(self.root / "gone")}]})
        diagnosis = doctor.diagnose(environ=self.environ)
        states = {entry["id"]: entry["state"] for entry in diagnosis["providers"]}
        self.assertEqual(states["claude"], "ready")
        self.assertNotEqual(states["gone"], "ready")
        self.assertEqual(self.source(diagnosis, "jobs")["state"], "ready")
        text = "\n".join(doctor.render(diagnosis))
        self.assertIn(os.path.join("~", ".claude"), text)
        self.assertIn("gone", text)

    def test_a_command_on_the_path_is_found_and_a_missing_one_names_its_setting(self):
        found = self.tool("claude")
        diagnosis = doctor.diagnose(environ=self.environ)
        self.assertEqual(os.path.normcase(diagnosis["commands"]["claude"]["found"]),
                         os.path.normcase(str(found)))
        self.assertIsNone(diagnosis["commands"]["github"]["found"])
        text = "\n".join(doctor.render(diagnosis))
        self.assertIn("commands.github", text)

    def test_a_missing_claude_is_a_problem_only_while_jobs_are_read(self):
        on = doctor.diagnose(environ=self.environ)
        self.assertTrue(on["commands"]["claude"]["problem"])
        self.config({"sources": {"jobs": {"enabled": False}, "interactive": {"enabled": False}}})
        off = doctor.diagnose(environ=self.environ)
        self.assertFalse(off["commands"]["claude"]["problem"])

    def test_claude_is_needed_whenever_the_roster_runs_it(self):
        # The roster starts claude for jobs or for interactive sessions; agents
        # read transcripts and start nothing.
        self.config({"sources": {"jobs": {"enabled": False}, "agents": {"enabled": False},
                                 "interactive": {"enabled": True}}})
        self.assertTrue(doctor.diagnose(environ=self.environ)["commands"]["claude"]["problem"])
        self.config({"sources": {"jobs": {"enabled": False}, "interactive": {"enabled": False},
                                 "agents": {"enabled": True}}})
        self.assertFalse(doctor.diagnose(environ=self.environ)["commands"]["claude"]["problem"])

    def test_the_interpreter_is_reported_with_its_version(self):
        diagnosis = doctor.diagnose(environ=self.environ)
        self.assertEqual(diagnosis["python"]["executable"], sys.executable)
        self.assertTrue(diagnosis["python"]["ok"])
        self.assertFalse(doctor.python_check((3, 10, 9), "/usr/bin/python3")["ok"])


class CommandLineTests(DoctorCase):
    def run_doctor(self, *arguments: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(Path(doctor.__file__)), *arguments],
                              env={**self.environ, "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                                   "PATHEXT": os.environ.get("PATHEXT", "")},
                              cwd=str(self.root), capture_output=True, text=True, check=False)

    def test_problems_exit_one_and_print_the_count_first(self):
        completed = self.run_doctor()
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertRegex(completed.stdout.splitlines()[0], r"^Fleet doctor: \d+ things? to fix$")

    def test_json_is_the_same_diagnosis(self):
        completed = self.run_doctor("--json")
        document = json.loads(completed.stdout)
        self.assertEqual(sorted(document), ["commands", "config", "problems", "providers",
                                            "python", "sources"])

    def test_a_clean_machine_exits_zero(self):
        (self.home / ".claude").mkdir()
        self.tool("claude")
        self.config({"providers": [{"id": "claude", "home": "$HOME/.claude"}]})
        completed = self.run_doctor()
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(completed.stdout.splitlines()[0], "Fleet doctor: nothing to fix")


if __name__ == "__main__":
    unittest.main()
