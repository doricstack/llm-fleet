"""Format checker journeys use disposable trees and real CLI calls."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check-doc-format.py"


class DocFormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write("AGENTS.md", "# Rules\n\n| ID | Action |\n| --- | --- |\n| A-1 | Read |\n")
        self.write("Makefile", ".DEFAULT_GOAL := help\n.PHONY: help\nhelp: ## Help\n\t@echo help\n")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def check(self, root=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(root or self.root)],
            capture_output=True, text=True, check=False,
        )

    def test_an_invisible_character_in_source_is_rejected(self):
        # Written as a code point: this file must not carry the character it bans.
        self.write("notes.md", "a value with a hidden " + chr(0x200B) + "character\n")
        self.assert_rejected("FMT-2 invisible character", "notes.md")

    def test_a_soft_hyphen_in_source_is_rejected(self):
        self.write("notes.md", "a value with a soft" + chr(0x00AD) + "hyphen\n")
        self.assert_rejected("FMT-2 invisible character", "notes.md")

    def test_an_ordinary_source_tree_is_accepted(self):
        self.write("notes.md", "ordinary text, with punctuation and a tab\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_rejected(self, rule, path):
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(rule, result.stderr)
        self.assertIn(path, result.stderr)
        self.assertNotIn("passed", result.stdout)

    def test_three_line_paragraph_passes(self):
        self.write("AGENTS.md", "First\nsecond\nthird\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 files", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_tables_headings_lists_and_fences_are_not_paragraphs(self):
        self.write("AGENTS.md", "# Rules\n" + "| A | B |\n" * 6 +
                   "\n- a\n- b\n- c\n- d\n\n```text\n" + "code\n" * 6 + "```\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("passed", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_blank_line_resets_paragraph(self):
        self.write("TODO.md", "one\ntwo\nthree\n\nfour\nfive\nsix\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("3 files", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_human_design_paragraphs_are_allowed(self):
        self.write("docs/architecture.md", "design\n" * 5)
        self.write("docs/pane-design.md", "design\n" * 5)
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("4 files", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_fragment_targets_are_allowed(self):
        self.write("make/test.mk", "test: ## Test\n\t@echo test\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("3 files", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_root_make_assignments_are_allowed(self):
        self.write("Makefile", "A := x\nB ::= x\nC ?= x\nD += x\nE != echo x\nF = x:y\nhelp: ## Help\n\t@echo 'x:y'\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("passed", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_recipe_cannot_hide_behind_phony_metadata(self):
        self.write("Makefile", ".PHONY: help\n\t@echo forbidden\nhelp: ## Help\n")
        self.assert_rejected("FMT-3", "Makefile:2")

    def test_punctuation_in_hidden_extensionless_file_is_rejected(self):
        self.write(".notes", "bad\u2014text\n")
        self.assert_rejected("FMT-2", ".notes:1")

    def test_git_and_generated_caches_are_excluded(self):
        self.write(".git/logs/HEAD", "\u2014")
        self.write(".state/build/cache", "\u2014")
        self.write("tests/__pycache__/cache", "\u2014")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 files", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_invalid_root_fails_closed(self):
        result = self.check(self.root / "absent")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FMT-0", result.stderr)
        self.assertNotIn("passed", result.stdout)

    def test_empty_scope_fails_closed(self):
        empty = self.root / "empty"
        empty.mkdir()
        result = self.check(empty)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FMT-0", result.stderr)
        self.assertNotIn("passed", result.stdout)

    def test_symlink_is_not_followed(self):
        self.write("outside", "\u2014")
        (self.root / "linked").symlink_to(self.root / "outside")
        self.assert_rejected("FMT-0", "linked")


def paragraph_test(name):
    def test(self):
        self.write(name, "one\ntwo\nthree\nfour\n")
        self.assert_rejected("FMT-1", name + ":1")
    return test


for filename in ("AGENTS.md", "PROJECT_CONTEXT.md", "TODO.md", "SNAPSHOT.md", "HANDOFF.md"):
    setattr(DocFormatTests, "test_long_paragraph_in_" + filename.replace(".", "_"), paragraph_test(filename))


def punctuation_test(character):
    def test(self):
        self.write("source.py", "# forbidden " + character + "\n")
        self.assert_rejected("FMT-2", "source.py:1")
    return test


for codepoint in (0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D):
    setattr(DocFormatTests, f"test_punctuation_{codepoint:x}", punctuation_test(chr(codepoint)))


def target_test(declaration):
    def test(self):
        self.write("Makefile", "help: ## Help\n" + declaration + "\n\t@echo forbidden\n")
        self.assert_rejected("FMT-3", "Makefile:2")
    return test


for index, declaration in enumerate(("build:", "help build:", "%.o: %.c", "build::", "$(TASK):", "build: \\\n other", ".DEFAULT:")):
    setattr(DocFormatTests, f"test_root_target_{index}", target_test(declaration))


if __name__ == "__main__":
    unittest.main()
