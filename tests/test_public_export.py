"""Exporter journeys use disposable trees and real subprocesses, never Git writes."""

from pathlib import Path
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "public-export.py"


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.destination = self.base / "public"
        self.source.mkdir()
        self.write("public-export/allowlist.txt", "README.md\ndocs/*.md\n")
        self.write("public-export/denylist.txt", "FORBIDDEN_VALUE\n")
        self.write("README.md", "Public project\n")
        self.write("docs/intro.md", "Introduction\n")

    def write(self, name, content):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def run_export(self, *args, source=None, destination=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--source", str(source or self.source),
             "--destination", str(destination or self.destination), *args],
            capture_output=True, text=True, check=False,
        )

    def test_dry_run_lists_files_and_diff_without_creating_destination(self):
        result = self.run_export("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("README.md", result.stdout)
        self.assertIn("+Public project", result.stdout)
        self.assertFalse(self.destination.exists())

    def test_export_copies_only_allowed_files_and_preserves_git(self):
        self.write("private-notes.txt", "Private notes\n")
        self.destination.mkdir()
        metadata = self.destination / ".git"
        metadata.mkdir()
        (metadata / "sentinel").write_text("unchanged")
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.destination / "README.md").read_text(), "Public project\n")
        self.assertFalse((self.destination / "private-notes.txt").exists())
        self.assertEqual((metadata / "sentinel").read_text(), "unchanged")

    def test_an_executable_script_is_written_executable(self):
        # The exported tree runs its own suites, and one of them executes a
        # script from the tree. A copy that drops the bit fails a check the
        # source tree passes, over a property of the copy rather than of the
        # source, and the failure reads as a machine that cannot run a script
        # instead of one that was never given permission to.
        if os.name == "nt":
            self.skipTest("this platform carries no executable bit to carry over")
        script = self.write("scripts/run.sh", "#!/usr/bin/env bash\nexit 0\n")
        script.chmod(0o755)
        self.write("public-export/allowlist.txt", "README.md\ndocs/*.md\nscripts/*.sh\n")
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)
        exported = self.destination / "scripts" / "run.sh"
        self.assertEqual(exported.read_bytes(), script.read_bytes())
        self.assertTrue(exported.stat().st_mode & 0o111,
                        "the exported script lost its executable bit")

    def test_a_file_that_is_not_a_program_is_written_without_the_bit(self):
        # The other direction, so the rule is about the file rather than about
        # everything sitting beside a script.
        if os.name == "nt":
            self.skipTest("this platform carries no executable bit to carry over")
        self.write("docs/notes.md", "Notes\n")
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.destination / "docs" / "notes.md").stat().st_mode & 0o111, 0)

    def test_leak_refuses_before_writes_without_echoing_value(self):
        self.write("README.md", "FORBIDDEN_VALUE\n")
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("denylist", result.stderr)
        self.assertNotIn("FORBIDDEN_VALUE", result.stdout + result.stderr)
        self.assertFalse(self.destination.exists())

    def test_filename_leak_is_blocked(self):
        self.write("docs/FORBIDDEN_VALUE.md", "safe")
        result = self.run_export("--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("denylist", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_update_diff_and_removal_of_previous_export_only(self):
        self.write("docs/old.md", "old page\n")
        first = self.run_export()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.write("README.md", "Revised project\n")
        (self.source / "docs/old.md").unlink()
        self.write("docs/new.md", "new page\n")
        before = (self.destination / "README.md").read_bytes()
        preview = self.run_export("--dry-run")
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn("-old page", preview.stdout)
        self.assertIn("+Revised project", preview.stdout)
        self.assertEqual((self.destination / "README.md").read_bytes(), before)
        applied = self.run_export()
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertFalse((self.destination / "docs/old.md").exists())
        self.assertEqual((self.destination / "docs/new.md").read_text(), "new page\n")

    def test_unmanaged_destination_is_untouched(self):
        self.destination.mkdir()
        note = self.destination / "notes.txt"
        note.write_text("keep")
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(note.read_text(), "keep")
        self.assertFalse((self.destination / "README.md").exists())

    def test_overlap_is_rejected(self):
        for destination in (self.source, self.source / "out", self.base):
            with self.subTest(destination=destination.name):
                result = self.run_export(destination=destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("non-nested", result.stderr)
                self.assertEqual((self.source / "README.md").read_text(), "Public project\n")

    def test_selected_symlink_is_rejected(self):
        target = self.base / "target.md"
        target.write_text("outside")
        link = self.source / "docs/link.md"
        link.parent.mkdir(exist_ok=True)
        link.symlink_to(target)
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "outside")
        self.assertFalse(self.destination.exists())

    def test_symlinked_destination_parent_is_rejected(self):
        real = self.base / "real"
        real.mkdir()
        link = self.base / "link"
        link.symlink_to(real, target_is_directory=True)
        result = self.run_export(destination=link / "public")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink", result.stderr)
        self.assertEqual(list(real.iterdir()), [])

    def test_destination_file_symlink_is_rejected(self):
        self.assertEqual(self.run_export().returncode, 0)
        target = self.base / "outside.txt"
        target.write_text("keep")
        public_file = self.destination / "README.md"
        public_file.unlink()
        public_file.symlink_to(target)
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "keep")
        self.assertTrue(public_file.is_symlink())

    def test_binary_is_rejected(self):
        (self.source / "README.md").write_bytes(b"hello\x00binary")
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("binary", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_invalid_policy_and_missing_allowlist_match_are_rejected(self):
        for policy in ("", "../outside.md\n", "missing.md\n"):
            with self.subTest(policy=policy):
                self.write("public-export/allowlist.txt", policy)
                result = self.run_export()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("refused", result.stderr)
                self.assertFalse(self.destination.exists())

    def test_invalid_deny_regex_fails_closed(self):
        self.write("public-export/denylist.txt", "[\n")
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.destination.exists())
        self.assertNotIn("Public project", result.stdout)

    def test_old_leak_is_redacted_from_diff(self):
        self.assertEqual(self.run_export().returncode, 0)
        (self.destination / "README.md").write_text("FORBIDDEN_VALUE\n")
        result = self.run_export("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("redacted", result.stdout)
        self.assertNotIn("FORBIDDEN_VALUE", result.stdout + result.stderr)

    def test_manifest_cannot_authorize_path_traversal(self):
        self.destination.mkdir()
        (self.destination / ".fleet-export.json").write_text(
            '{"format": 1, "files": ["../outside.md"]}')
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest", result.stderr)
        self.assertFalse((self.destination / "README.md").exists())

    def test_real_tree_exports_without_private_handoff(self):
        result = self.run_export(source=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.destination / "AGENTS.md").is_file())
        self.assertTrue((self.destination / "scripts/public-export.py").is_file())
        self.assertFalse((self.destination / "SNAPSHOT.md").exists())
        self.assertFalse((self.destination / ".advisor-context.md").exists())

    def test_real_policy_blocks_private_shapes(self):
        policy = (ROOT / "public-export/denylist.txt").read_text()
        self.write("public-export/denylist.txt", policy)
        samples = ["/" + "Users/example-owner/project", ".claude-" + "personal",
                   "owner-" + "MacBook", "internal-" + "private",
                   "~/." + "secrets" + "/key", "ghp_" + "X" * 24]
        for sample in samples:
            with self.subTest(kind=samples.index(sample)):
                self.write("README.md", sample)
                result = self.run_export("--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("denylist", result.stderr)
                self.assertNotIn(sample, result.stdout + result.stderr)

    def test_repeated_export_has_no_diff(self):
        self.assertEqual(self.run_export().returncode, 0)
        result = self.run_export("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No changes.", result.stdout)
        self.assertEqual((self.destination / "README.md").read_text(), "Public project\n")


class MakeGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.source.mkdir()
        policy = (ROOT / "public-export/allowlist.txt").read_text()
        for pattern in policy.splitlines():
            if not pattern or pattern.startswith("#"):
                continue
            for path in ROOT.glob(pattern):
                destination = self.source / path.relative_to(ROOT)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)

    def make_binary(self):
        # A development machine may put a wrapper ahead of make on PATH; this
        # suite drives the chain with a stub, so it must not claim that lane.
        for candidate in ("/usr/bin/make", "/bin/make"):
            if os.path.exists(candidate):
                return candidate
        return shutil.which("make") or "make"

    def run_make(self, *args):
        env = os.environ.copy()
        for name in ("MAKEFLAGS", "MFLAGS", "MAKELEVEL"):
            env.pop(name, None)
        return subprocess.run(
            [self.make_binary(), "--no-print-directory", ".SHELLFLAGS=-c", *args],
            cwd=self.source, env=env, capture_output=True, text=True,
            check=False, timeout=30,
        )

    def test_quality_fails_when_export_refuses(self):
        agents = self.source / "AGENTS.md"
        original = agents.read_text()
        forbidden = "llm-" + "shared"
        agents.write_text(original + "\nInternal repository: ~/" + forbidden + "/\n")
        result = self.run_make("quality")
        output = result.stdout + result.stderr
        self.assertIn("Doc format passed:", output)
        self.assertIn("Export refused: denylist rule 6", output)
        self.assertNotIn(forbidden, output)
        self.assertNotEqual(result.returncode, 0, output)
        self.assertNotIn("Export leak check passed.", output)

    def test_ci_chain_stops_after_failed_command(self):
        driver = self.base / "make-driver"
        calls = self.source / "calls.txt"
        driver.write_text(
            "#!/bin/bash\n"
            "printf '%s\\n' \"$1\" >> calls.txt\n"
            "if [ \"$1\" = export-check ]; then\n"
            "  echo 'Injected preview failure' >&2\n"
            "  exit 7\n"
            "fi\n"
        )
        driver.chmod(0o755)
        # The driver runs through an explicit shell: make runs a recipe that
        # names MAKE directly, and Windows has no association for an extension
        # free script.
        result = self.run_make("test-ci", f"MAKE=sh '{driver}'")
        output = result.stdout + result.stderr
        self.assertIn("Injected preview failure", output)
        self.assertNotEqual(result.returncode, 0, output)
        self.assertEqual(calls.read_text().splitlines(),
                         ["quality", "test", "test-readers", "test-components",
                          "test-components-drift", "test-engine", "test-typescript",
                          "test-config-parity", "build", "export-check"])
        self.assertNotIn("Isolated export and round-trip validation passed.", output)


class HardeningTests(unittest.TestCase):
    """A rule that reads only the text as written is a rule anyone can walk past.

    Each case below spells the denied value a different way and requires the same
    refusal, with a control proving the plain spelling was already refused, and a
    case proving ordinary content that merely looks encoded is left alone.
    """

    DENIED = "FORBIDDEN_VALUE"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.destination = self.base / "public"
        self.source.mkdir()
        self.write("public-export/allowlist.txt", "sample.txt\n")
        self.write("public-export/denylist.txt", self.DENIED + "\n")

    def write(self, name, content):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def run_export(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--source", str(self.source),
             "--destination", str(self.destination), *args],
            capture_output=True, text=True, check=False,
        )

    def refuses(self, line):
        self.write("sample.txt", line + "\n")
        result = self.run_export("--dry-run")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Export refused", result.stderr)
        return result

    def test_the_plain_spelling_is_the_control(self):
        self.refuses("a line naming " + self.DENIED)

    def test_a_zero_width_character_inside_the_value_does_not_hide_it(self):
        self.refuses("a line naming " + self.DENIED.replace("_", "\u200b_"))

    def test_a_soft_hyphen_inside_the_value_does_not_hide_it(self):
        self.refuses("a line naming " + self.DENIED.replace("_", "\u00ad_"))

    def test_the_value_in_fullwidth_letters_does_not_hide_it(self):
        fullwidth = "".join(chr(ord(char) + 0xFEE0) if char.isalpha() else char
                            for char in self.DENIED)
        self.refuses("a line naming " + fullwidth)

    def test_a_percent_encoded_value_does_not_hide_it(self):
        encoded = self.DENIED.replace("_", "%5F")
        self.refuses("a line naming " + encoded)

    def test_a_base64_encoded_value_does_not_hide_it(self):
        encoded = base64.b64encode(self.DENIED.encode()).decode()
        self.refuses("a line naming " + encoded)

    def test_a_value_spelled_with_percent_escapes_does_not_hide_it(self):
        self.write("public-export/denylist.txt", "MARKER-9\n")
        self.refuses("a line naming MARKER-%39")

    def test_ordinary_content_that_only_looks_encoded_is_left_alone(self):
        self.write("sample.txt", "\n".join([
            "commit 4f3a9c1e7b2d8f5061a4c3e9b7d2f8013569acde",
            "a paragraph with punctuation, and a long word: internationalization",
            "digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ]) + "\n")
        result = self.run_export("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_private_identity_term_is_refused_without_being_echoed(self):
        term = "OWNER" + "MARKER" + "9"
        self.write("public-export/owner-identity.txt", "# a comment\n" + term + "\n")
        self.write("sample.txt", "an allowed line mentioning " + term + "\n")
        result = self.run_export("--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("private identity term", result.stderr)
        self.assertNotIn(term, result.stderr)
        self.assertNotIn(term, result.stdout)

    def test_an_identity_term_split_by_an_invisible_character_is_still_refused(self):
        term = "OWNER" + "MARKER" + "9"
        self.write("public-export/owner-identity.txt", term + "\n")
        self.write("sample.txt", "an allowed line mentioning "
                    + term.replace("OWNER", "OWN\u200bER") + "\n")
        result = self.run_export("--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(term, result.stderr)

    def test_an_empty_identity_file_refuses_nothing(self):
        self.write("public-export/owner-identity.txt", "")
        self.write("sample.txt", "an ordinary line\n")
        result = self.run_export("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_identity_inventory_is_never_exportable(self):
        term = "OWNER" + "MARKER" + "9"
        self.write("public-export/owner-identity.txt", term + "\n")
        self.write("public-export/allowlist.txt", "public-export/*\n")
        self.write("sample.txt", "an ordinary line\n")
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        if self.destination.exists():
            self.assertFalse((self.destination / "public-export" / "owner-identity.txt").exists())

    def test_the_owners_personal_configuration_is_never_exportable(self):
        # The private checkout keeps its owner's own configuration and sections in
        # personal/, so an allowlist that reaches it refuses the whole export
        # rather than publishing one file of it.
        self.write("personal/config.json", '{"pane": {"custom": {}}}\n')
        self.write("sample.txt", "an ordinary line\n")
        for pattern in ("personal/*", "personal/config.json", "*/config.json"):
            with self.subTest(pattern=pattern):
                self.write("public-export/allowlist.txt", pattern + "\nsample.txt\n")
                result = self.run_export()
                self.assertNotEqual(result.returncode, 0, pattern)
                self.assertFalse((self.destination / "personal").exists(), pattern)

    def test_the_engines_manifest_directory_is_not_a_provider_home(self):
        # Every plugin carries .claude-plugin/plugin.json; the rule that keeps a
        # personal provider home out of the export matches the same prefix.
        self.write("plugins/fleet/.claude-plugin/plugin.json", '{"name": "fleet"}\n')
        self.write("public-export/allowlist.txt", "plugins/fleet/.claude-plugin/plugin.json\n")
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.destination / "plugins" / "fleet" / ".claude-plugin" / "plugin.json").read_text(),
            '{"name": "fleet"}\n')

    def test_the_engines_environment_noun_is_not_an_environment_file(self):
        # The plugin reads which terminal it runs in through the engine's
        # environment noun; the rule that keeps an environment file out of the
        # export matches the same shape. Assembled from parts, since this file
        # is exported too.
        policy = (ROOT / "public-export/denylist.txt").read_text()
        self.write("public-export/denylist.txt", policy)
        call = "await $" + ".env" + ".get(\"TERM_PROGRAM\")\n"
        self.write("sample.ts", call)
        self.write("public-export/allowlist.txt", "sample.ts\n")
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.destination / "sample.ts").read_text(), call)

    def test_an_environment_file_is_still_refused(self):
        policy = (ROOT / "public-export/denylist.txt").read_text()
        self.write("public-export/denylist.txt", policy)
        # The exception is the engine's method call alone: the same noun naming
        # any file, or the call's name with no call, is still an environment file.
        for sample in ("cp " + ".env" + ".local here", "source config" + ".env" + ".production",
                       "x" + ".env" + ".get", "$" + ".env" + ".production", "$" + ".env" + ".local",
                       "$." + "netrc", "$." + "npmrc", "$" + ".env" + ".get without a call"):
            with self.subTest(sample=sample):
                self.write("README.md", sample + "\n")
                self.write("public-export/allowlist.txt", "README.md\n")
                result = self.run_export("--dry-run")
                self.assertNotEqual(result.returncode, 0, sample)
                self.assertIn("denylist", result.stderr)

    def test_an_environment_file_named_with_the_engines_noun_is_refused_by_path(self):
        policy = (ROOT / "public-export/denylist.txt").read_text()
        self.write("public-export/denylist.txt", policy)
        name = "config/fixtures/example/$" + ".env" + ".production.json"
        self.write("sample.txt", "an ordinary line\n")
        self.write(name, "{}\n")
        self.write("public-export/allowlist.txt", "sample.txt\n" + name + "\n")
        result = self.run_export("--dry-run")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("denylist", result.stderr)

    def test_a_provider_home_is_still_refused(self):
        # Assembled from parts: this file is exported, and a provider home spelled
        # out here is a provider home the export would have to refuse.
        rule = "\\.(?:claude|codex|gemini)-(?!plugin\\b)[A-Za-z0-9_-]+"
        self.write("public-export/denylist.txt", rule + "\n")
        for suffix in ("-dsk/jobs/state.json", "-kimi/settings.json"):
            name = "homes/." + "claude" + suffix
            with self.subTest(suffix=suffix):
                self.write("sample.txt", "an ordinary line\n")
                self.write(name, "a value\n")
                self.write("public-export/allowlist.txt", "sample.txt\n" + name + "\n")
                result = self.run_export("--dry-run")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("Export refused", result.stderr)

    def test_a_held_destination_refuses_the_write(self):
        self.write("sample.txt", "an ordinary line\n")
        self.destination.mkdir()
        (self.destination / ".fleet-export.lock").write_text("1")
        result = self.run_export()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("another export holds this destination", result.stderr)
        self.assertFalse((self.destination / "sample.txt").exists())

    def test_a_dry_run_takes_no_lock(self):
        self.write("sample.txt", "an ordinary line\n")
        self.destination.mkdir()
        result = self.run_export("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.destination / ".fleet-export.lock").exists())

    def test_an_abandoned_lock_is_taken_over_and_released(self):
        self.write("sample.txt", "an ordinary line\n")
        self.destination.mkdir()
        lock = self.destination / ".fleet-export.lock"
        lock.write_text("1")
        old = time.time() - 3600
        os.utime(lock, (old, old))
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.destination / "sample.txt").read_text(), "an ordinary line\n")
        self.assertFalse(lock.exists())

    def test_a_console_that_cannot_encode_the_plan_does_not_refuse_the_export(self):
        # Windows console encoding is not a reason to refuse an export that is
        # safe: the plan is a preview, and a character it cannot draw is not a leak.
        self.write("sample.txt", "a line with an em dash " + chr(0x2014) + " inside it\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--source", str(self.source),
             "--destination", str(self.destination), "--dry-run"],
            capture_output=True, text=True, check=False,
            env={**os.environ, "PYTHONIOENCODING": "ascii"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Export refused", result.stderr)

    def test_a_released_lock_leaves_a_writable_destination(self):
        self.write("sample.txt", "an ordinary line\n")
        first = self.run_export()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.write("sample.txt", "a changed line\n")
        second = self.run_export()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((self.destination / "sample.txt").read_text(), "a changed line\n")

    def test_an_abandoned_lock_is_not_reported_as_an_unmanaged_file(self):
        self.write("sample.txt", "an ordinary line\n")
        first = self.run_export()
        self.assertEqual(first.returncode, 0, first.stderr)
        lock = self.destination / ".fleet-export.lock"
        lock.write_text("1")
        old = time.time() - 3600
        os.utime(lock, (old, old))
        (self.destination / "sample.txt").write_text("an edited line\n")
        result = self.run_export()
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
