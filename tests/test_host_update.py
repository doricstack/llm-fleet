#!/usr/bin/env python3
"""Host install check behavior, driven by homes the test writes itself.

The script exists because a version the tree raises is not a version the host
installs: a home keeps loading the one it recorded until someone asks it to
update. So the behavior worth proving is the drift it finds and the repair it
verifies, not the reading of a JSON file.

Every case runs the real script against a home on disk. The host is a stub
executable written here, which records how it was called and does what the case
needs: the repair, or nothing at all so the check after it fails.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "host-update.py"
MANIFEST = ROOT / "plugins" / "fleet" / ".claude-plugin" / "plugin.json"

# The stub stands in for the host's own `claude plugin update`. It writes what
# it was asked for beside the argv it was called with, then does what the case
# says: in "repair" it records the version the tree holds, in "ignore" it writes
# nothing, so the script's read-back is the thing that fails.
#
# It is a Python module rather than a shell script, and the cases start it with
# the interpreter running them: a `/bin/sh` file is not executable on Windows, so
# a shell stub passes here and fails on the runner.
STUB = """\
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
home = os.environ["CLAUDE_CONFIG_DIR"]
with open(os.path.join(here, "home"), "w", encoding="utf-8") as written:
    written.write(home)
with open(os.path.join(here, "argv"), "a", encoding="utf-8") as written:
    written.write(" ".join(sys.argv[1:]) + "\\n")
if os.environ.get("STUB_MODE") == "refuse-market" and sys.argv[1:3] == ["plugin", "marketplace"]:
    sys.exit(1)
if os.environ.get("STUB_MODE") == "repair":
    record = {"plugins": {"NAME@MARKET": [
        {"scope": "user", "version": os.environ["STUB_VERSION"]}]}}
    with open(os.path.join(home, "plugins", "installed_plugins.json"), "w",
              encoding="utf-8") as written:
        json.dump(record, written)
"""


def manifest() -> tuple[str, str]:
    document = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return str(document["name"]), str(document["version"])


class HostUpdateCase(unittest.TestCase):
    def setUp(self) -> None:
        self.home_of = tempfile.TemporaryDirectory()
        self.addCleanup(self.home_of.cleanup)
        self.temporary = self.home_of.name
        self.home = Path(self.temporary) / "home"
        (self.home / "plugins").mkdir(parents=True)
        self.stub_dir = Path(self.temporary) / "stub"
        self.stub_dir.mkdir()
        self.stub = self.stub_dir / "claude.py"
        name = manifest()[0]
        self.stub.write_text(STUB.replace("NAME", name).replace("MARKET", "local"),
                             encoding="utf-8")

    def install(self, version: str, marketplace: str = "local") -> None:
        name = manifest()[0]
        record = {"plugins": {name + "@" + marketplace: [
            {"scope": "user", "version": version}]}}
        (self.home / "plugins" / "installed_plugins.json").write_text(
            json.dumps(record), encoding="utf-8")

    def run_script(self, *arguments: str, mode: str = "repair") -> subprocess.CompletedProcess:
        environment = dict(os.environ)
        environment["STUB_DIR"] = str(self.stub_dir)
        environment["STUB_MODE"] = mode
        environment["STUB_VERSION"] = manifest()[1]
        return subprocess.run([sys.executable, "-I", str(SCRIPT),
                               "--config-dir", str(self.home), "--claude", sys.executable,
                               "--claude-arg", str(self.stub),
                               *arguments],
                              capture_output=True, text=True, env=environment, check=False)

    def test_a_current_home_passes(self) -> None:
        version = manifest()[1]
        self.install(version)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("current", result.stdout)

    def test_a_stale_home_is_refused_and_names_both_versions(self) -> None:
        version = manifest()[1]
        self.install("0.0.1-old")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("0.0.1-old", result.stderr)
        self.assertIn(version, result.stderr)
        self.assertIn("host-update", result.stderr)

    def test_a_home_that_never_installed_is_not_a_failure(self) -> None:
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not installed", result.stdout)

    def enable(self, identifier: str, source: str = "owner/repo") -> None:
        """Turn the plugin on in this home's settings, the way a person does."""
        marketplace = identifier.split("@", 1)[1]
        (self.home / "settings.json").write_text(
            json.dumps({"enabledPlugins": {identifier: True},
                        "extraKnownMarketplaces": {marketplace: {
                            "source": {"source": "github", "repo": source},
                            "autoUpdate": True}}}),
            encoding="utf-8")

    def test_enabled_with_no_install_is_refused_and_names_the_home(self) -> None:
        name = manifest()[0]
        self.enable(name + "@local")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("enabled and not installed", result.stderr)
        self.assertIn(name + "@local", result.stderr)

    def calls(self) -> list[str]:
        """Every host command the run asked for, one per line, in order."""
        path = self.stub_dir / "argv"
        if not path.exists():
            return []
        return path.read_text(encoding="utf-8").splitlines()

    def test_write_installs_where_it_is_enabled_and_absent(self) -> None:
        name = manifest()[0]
        version = manifest()[1]
        self.enable(name + "@local")
        result = self.run_script("--write")
        self.assertEqual(result.returncode, 0, result.stderr)
        # The whole line, not a fragment: `marketplace add` is not a command the
        # host has, and a substring check cannot tell it from the one that is.
        self.assertEqual(self.calls(), ["plugin marketplace add owner/repo",
                                        "plugin install " + name + "@local"])
        record = json.loads((self.home / "plugins" / "installed_plugins.json")
                            .read_text(encoding="utf-8"))
        held = list(record["plugins"].values())[0][0]["version"]
        self.assertEqual(held, version)

    def test_a_marketplace_that_will_not_add_stops_before_the_install(self) -> None:
        name = manifest()[0]
        self.enable(name + "@local")
        result = self.run_script("--write", mode="refuse-market")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("marketplace add exited unsatisfied", result.stderr)
        self.assertEqual(self.calls(), ["plugin marketplace add owner/repo"],
                         "the install was asked for over a marketplace that is not there")

    def test_a_disabled_plugin_is_not_asked_for(self) -> None:
        name = manifest()[0]
        self.enable(name + "@local")
        (self.home / "settings.json").write_text(
            json.dumps({"enabledPlugins": {name + "@local": False}}), encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("enabled and not installed", result.stderr)

    def test_a_damaged_record_is_absent_rather_than_a_crash(self) -> None:
        (self.home / "plugins" / "installed_plugins.json").write_text("{not json",
                                                                      encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not installed", result.stdout)

    def test_write_repairs_a_stale_home_and_proves_it(self) -> None:
        version = manifest()[1]
        self.install("0.0.1-old")
        result = self.run_script("--write")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.stub_dir / "home").read_text(encoding="utf-8").strip(),
                         str(self.home))
        self.assertIn("plugin update", (self.stub_dir / "argv").read_text(encoding="utf-8"))
        record = json.loads((self.home / "plugins" / "installed_plugins.json")
                            .read_text(encoding="utf-8"))
        held = list(record["plugins"].values())[0][0]["version"]
        self.assertEqual(held, version)

    def test_an_update_that_changes_nothing_is_a_failure(self) -> None:
        self.install("0.0.1-old")
        result = self.run_script("--write", mode="ignore")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("did not reach", result.stderr)

    def test_write_asks_nothing_of_a_current_home(self) -> None:
        version = manifest()[1]
        self.install(version)
        result = self.run_script("--write")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.stub_dir / "argv").exists(),
                         "the host was asked to update a home that was already current")

    def test_a_second_scope_on_an_older_version_is_still_a_drift(self) -> None:
        name = manifest()[0]
        version = manifest()[1]
        record = {"plugins": {name + "@local": [
            {"scope": "user", "version": version},
            {"scope": "project", "version": "0.0.1-old"}]}}
        (self.home / "plugins" / "installed_plugins.json").write_text(
            json.dumps(record), encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("0.0.1-old", result.stderr)

    def test_auto_update_off_is_named_so_next_release_is_no_surprise(self) -> None:
        self.install(manifest()[1])
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("auto-update is off", result.stdout)

    def test_auto_update_declared_in_settings_keeps_the_note_quiet(self) -> None:
        self.install(manifest()[1])
        (self.home / "settings.json").write_text(
            json.dumps({"extraKnownMarketplaces": {"local": {"autoUpdate": True}}}),
            encoding="utf-8")
        result = self.run_script()
        self.assertNotIn("auto-update is off", result.stdout)

    def test_auto_update_declared_in_the_marketplace_record_is_read_too(self) -> None:
        self.install(manifest()[1])
        (self.home / "plugins" / "known_marketplaces.json").write_text(
            json.dumps({"local": {"autoUpdate": True}}), encoding="utf-8")
        result = self.run_script()
        self.assertNotIn("auto-update is off", result.stdout)


if __name__ == "__main__":
    unittest.main()
