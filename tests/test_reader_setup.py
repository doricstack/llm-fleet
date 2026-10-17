#!/usr/bin/env python3
"""The starter configuration: what it finds, where it goes, and what it never touches.

Each case runs against a temporary home with real directories, and every file
written is read back through the loader: a starter the loader refuses would
leave a new person worse off than no file at all.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from config.loader import load_config
from readers import setup


class SetupCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.environ = {"HOME": str(self.home), "PATH": ""}
        self.default = self.home / ".config" / "llm-fleet" / "config.json"

    def tearDown(self) -> None:
        self.directory.cleanup()


class StarterTests(SetupCase):
    def test_the_default_home_is_found_and_written_in_home_form(self):
        (self.home / ".claude").mkdir()
        document = setup.starter(self.environ)
        self.assertEqual(document["providers"],
                         [{"id": "claude", "label": "Claude", "home": "$HOME/.claude"}])

    def test_a_configured_home_outside_home_is_kept_as_written_and_both_are_found(self):
        (self.home / ".claude").mkdir()
        other = self.root / "work-claude"
        other.mkdir()
        document = setup.starter({**self.environ, "CLAUDE_CONFIG_DIR": str(other)})
        self.assertEqual([entry["home"] for entry in document["providers"]],
                         [str(other), "$HOME/.claude"])
        self.assertEqual(len({entry["id"] for entry in document["providers"]}), 2)

    def test_the_same_home_named_twice_is_one_provider(self):
        (self.home / ".claude").mkdir()
        document = setup.starter({**self.environ, "CLAUDE_CONFIG_DIR": str(self.home / ".claude")})
        self.assertEqual(len(document["providers"]), 1)

    def test_no_home_found_writes_no_provider_rather_than_inventing_one(self):
        document = setup.starter({**self.environ, "CLAUDE_CONFIG_DIR": str(self.root / "gone")})
        self.assertEqual(document["providers"], [])

    def test_a_home_known_only_as_the_user_profile_is_found_and_written_whole(self):
        # Windows sets USERPROFILE and may set no HOME. The loader expands $HOME
        # only, so a home found this way is written as the full path.
        (self.home / ".claude").mkdir()
        document = setup.starter({"USERPROFILE": str(self.home), "PATH": ""})
        self.assertEqual(document["providers"],
                         [{"id": "claude", "label": "Claude", "home": str(self.home / ".claude")}])

    def test_the_starter_carries_only_what_differs_from_the_defaults(self):
        (self.home / ".claude").mkdir()
        self.assertEqual(sorted(setup.starter(self.environ)), ["providers", "schemaVersion"])


class WriteTests(SetupCase):
    def test_a_written_starter_loads_and_its_provider_is_ready(self):
        (self.home / ".claude").mkdir()
        result = setup.run(self.environ)
        self.assertEqual(result["state"], "written")
        self.assertEqual(result["path"], str(self.default))
        resolved = load_config(None, environ=self.environ)
        self.assertEqual([entry["state"] for entry in resolved["providers"]], ["ready"])
        self.assertEqual(resolved["sources"]["jobs"]["state"], "ready")

    def test_a_file_already_there_is_left_exactly_as_it_was(self):
        self.default.parent.mkdir(parents=True)
        self.default.write_text('{"keep": "me"}', encoding="utf-8")
        result = setup.run(self.environ)
        self.assertEqual(result["state"], "exists")
        self.assertEqual(self.default.read_text(encoding="utf-8"), '{"keep": "me"}')

    def test_the_selector_names_where_the_starter_goes(self):
        chosen = self.root / "elsewhere" / "fleet.json"
        result = setup.run({**self.environ, "FLEET_CONFIG": str(chosen)})
        self.assertEqual(result["state"], "written")
        self.assertTrue(chosen.is_file())
        self.assertFalse(self.default.exists())

    def test_a_relative_selector_is_refused_and_nothing_is_written(self):
        result = setup.run({**self.environ, "FLEET_CONFIG": "fleet.json"})
        self.assertEqual(result["state"], "refused")
        self.assertFalse((self.root / "fleet.json").exists())
        self.assertFalse(self.default.exists())

    def test_a_dry_run_prints_the_document_and_writes_nothing(self):
        (self.home / ".claude").mkdir()
        result = setup.run(self.environ, dry_run=True)
        self.assertEqual(result["state"], "dry-run")
        self.assertEqual(result["document"]["providers"][0]["id"], "claude")
        self.assertFalse(self.default.exists())

    def test_a_destination_that_cannot_be_written_is_refused_by_name(self):
        # A file where the parent folder should be, then a folder this user may
        # not write: each is a refusal naming the destination, never a crash
        # that reads as an interpreter that could not start.
        blocked = self.root / "blocked"
        blocked.write_text("a file, not a folder", encoding="utf-8")
        result = setup.run(self.environ, path=str(blocked / "config.json"))
        self.assertEqual(result["state"], "refused")
        self.assertEqual(result["errors"][0]["code"], "E_SETUP_WRITE")
        self.assertEqual(result["errors"][0]["path"], str(blocked / "config.json"))
        if os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0):
            return
        locked = self.root / "locked"
        locked.mkdir(mode=0o500)
        try:
            refused = setup.run(self.environ, path=str(locked / "config.json"))
        finally:
            locked.chmod(0o700)
        self.assertEqual(refused["state"], "refused")
        self.assertEqual(refused["errors"][0]["code"], "E_SETUP_WRITE")
        self.assertFalse((locked / "config.json").exists())

    def test_a_link_at_the_destination_is_not_followed(self):
        target = self.root / "target.json"
        self.default.parent.mkdir(parents=True)
        try:
            os.symlink(target, self.default)
        except (OSError, NotImplementedError):
            self.skipTest("this platform makes no symbolic link here")
        result = setup.run(self.environ)
        self.assertEqual(result["state"], "exists")
        self.assertFalse(target.exists())


class CommandLineTests(SetupCase):
    def run_setup(self, *arguments: str, environ=None):
        return subprocess.run([sys.executable, str(Path(setup.__file__)), *arguments],
                              env={**(environ or self.environ),
                                   "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")},
                              cwd=str(self.root), capture_output=True, text=True, check=False)

    def test_written_exits_zero_and_says_where_and_what_next(self):
        (self.home / ".claude").mkdir()
        completed = self.run_setup()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("~/.config/llm-fleet/config.json", completed.stdout)
        self.assertIn("/fleet doctor", completed.stdout)

    def test_an_existing_file_exits_three(self):
        self.default.parent.mkdir(parents=True)
        self.default.write_text("{}", encoding="utf-8")
        completed = self.run_setup()
        self.assertEqual(completed.returncode, 3)
        self.assertIn("left as it is", completed.stdout)

    def test_a_named_path_is_written_there(self):
        chosen = self.root / "named.json"
        completed = self.run_setup("--path", str(chosen))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(chosen.read_text(encoding="utf-8"))["schemaVersion"], 1)

    def test_a_refusal_exits_two(self):
        completed = self.run_setup(environ={**self.environ, "FLEET_CONFIG": "relative.json"})
        self.assertEqual(completed.returncode, 2)

    def test_a_write_that_fails_exits_two_and_says_why(self):
        blocked = self.root / "blocked"
        blocked.write_text("a file, not a folder", encoding="utf-8")
        completed = self.run_setup("--path", str(blocked / "config.json"))
        self.assertEqual(completed.returncode, 2)
        self.assertIn("could not be written", completed.stdout)
        self.assertIn(str(blocked / "config.json"), completed.stdout)


if __name__ == "__main__":
    unittest.main()
