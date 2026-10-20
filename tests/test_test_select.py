#!/usr/bin/env python3
"""The file-level selection: which test files a change reaches, and why.

The impact plan used to select by language lane, so a change of one test file
and a README ran the whole Python suite. The selector reads the repository's
sources and names test files one at a time, and these cases hold each way a
test can be reached: an import chain, a path written in a test or in a helper
it imports, a folder a test walks, and the chains that cross from Python into
TypeScript. They also hold the three ways the selection widens, each of which
must name the file that forced it: the test harness, a file no test reaches,
and documentation, which never forces anything.

Each case builds a small repository on disk and reads the real script's answer,
and the last class reads this repository itself, so a selection that drifts
from the sources it reads is caught on the files it will meet.

Run with: python3 tests/test_test_select.py
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "test-select.py"
SPEC = importlib.util.spec_from_file_location("test_select", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
selector = importlib.util.module_from_spec(SPEC)
sys.modules["test_select"] = selector
SPEC.loader.exec_module(selector)


class FixtureRepository(unittest.TestCase):
    """A throwaway repository with the layout the selector reads."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fleet-select-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.write("tests/paths.py", """
            from pathlib import Path
            import sys
            ROOT = Path(__file__).resolve().parents[1]
            PLUGIN = ROOT / "plugins" / "llm-fleet"
            sys.path.insert(0, str(PLUGIN))
            """)
        self.write("plugins/llm-fleet/readers/__init__.py", "")
        self.write("plugins/llm-fleet/readers/load.py", """
            from readers import runtime
            """)
        self.write("plugins/llm-fleet/readers/runtime.py", "VALUE = 1\n")
        self.write("plugins/llm-fleet/readers/alone.py", "VALUE = 2\n")
        self.write("plugins/llm-fleet/config/schema.json", "{}\n")
        self.write("plugins/llm-fleet/README.md", "# plugin\n")
        self.write("README.md", "# repository\n")
        self.write("docs/notes.md", "notes\n")
        self.write("scripts/drift-check.py", "print('drift')\n")
        self.write("scripts/unread.py", "print('nobody runs me')\n")
        self.write("tests/test_load.py", """
            import paths
            from readers import load
            """)
        self.write("tests/test_drift.py", """
            '''Mentions scripts/unread.py in prose only.'''
            from pathlib import Path
            ROOT = Path(__file__).resolve().parent.parent
            SCRIPT = ROOT / "scripts" / "drift-check.py"
            """)
        self.write("tests/test_readme.py", """
            import paths
            README = paths.PLUGIN / "README.md"
            """)

    def write(self, relative: str, body: str) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(body).lstrip("\n"), encoding="utf-8")
        return path

    def lines(self, *changed: str) -> list[str]:
        return selector.select(self.root, list(changed)).lines()


class PythonReachTests(FixtureRepository):
    def test_a_changed_test_selects_itself_alone(self) -> None:
        self.assertEqual(self.lines("tests/test_drift.py"), ["python-test tests/test_drift.py"])

    def test_an_import_chain_reaches_through_every_module(self) -> None:
        # test_load imports readers.load, which imports readers.runtime: the
        # module two steps away is still the test's.
        self.assertEqual(self.lines("plugins/llm-fleet/readers/runtime.py"),
                         ["python-test tests/test_load.py"])

    def test_a_script_named_by_its_path_selects_only_the_test_that_names_it(self) -> None:
        self.assertEqual(self.lines("scripts/drift-check.py"), ["python-test tests/test_drift.py"])

    def test_a_path_read_through_a_helper_constant_is_the_helper_s_path(self) -> None:
        # `paths.PLUGIN / "README.md"` is the plugin's README, not every README:
        # the repository's own README is documentation no test reads.
        self.assertEqual(self.lines("plugins/llm-fleet/README.md"),
                         ["python-test tests/test_readme.py"])
        self.assertEqual(self.lines("README.md"), ["docs README.md"])

    def test_a_name_imported_from_a_helper_carries_its_value(self) -> None:
        self.write("tests/test_imported.py", """
            from paths import PLUGIN
            SCHEMA = PLUGIN / "config" / "schema.json"
            """)
        self.assertIn("python-test tests/test_imported.py",
                      self.lines("plugins/llm-fleet/config/schema.json"))

    def test_a_docstring_names_nothing(self) -> None:
        # test_drift mentions scripts/unread.py in its docstring; prose is not a
        # read, so the script reaches no test and falls back.
        self.assertEqual(self.lines("scripts/unread.py"), ["python-all scripts/unread.py"])

    def test_a_deleted_module_still_selects_the_test_that_imports_it(self) -> None:
        # `from readers import load` names a file that is gone: the test that
        # still imports it is the one the deletion breaks.
        (self.root / "plugins/llm-fleet/readers/load.py").unlink()
        self.assertEqual(self.lines("plugins/llm-fleet/readers/load.py"),
                         ["python-test tests/test_load.py"])

    def test_a_deleted_module_imported_relatively_still_selects_its_importer(self) -> None:
        self.write("plugins/llm-fleet/readers/near.py", "from . import gone\n")
        self.write("tests/test_near.py", """
            import paths
            from readers import near
            """)
        self.assertEqual(self.lines("plugins/llm-fleet/readers/gone.py"),
                         ["python-test tests/test_near.py"])

    def test_a_change_to_the_typescript_runner_runs_every_suite(self) -> None:
        # Every TypeScript suite starts through it, whether or not one names it.
        self.write("scripts/typescript-suite.py", "print('runner')\n")
        self.assertIn("ts-all scripts/typescript-suite.py",
                      self.lines("scripts/typescript-suite.py"))
        self.assertNotIn("python-all scripts/typescript-suite.py",
                         self.lines("scripts/typescript-suite.py"))

    def test_a_module_named_in_a_dotted_string_is_followed(self) -> None:
        self.write("tests/test_dynamic.py", """
            import importlib
            importlib.import_module("readers.alone")
            """)
        self.assertEqual(self.lines("plugins/llm-fleet/readers/alone.py"),
                         ["python-test tests/test_dynamic.py"])

    def test_a_walked_folder_reaches_every_file_inside_it(self) -> None:
        self.write("tests/test_walk.py", """
            import paths
            def scan():
                return sorted(paths.PLUGIN.rglob("*.py"))
            """)
        self.assertIn("python-test tests/test_walk.py",
                      self.lines("plugins/llm-fleet/readers/alone.py"))

    def test_a_walk_of_the_root_reaches_nothing_by_itself(self) -> None:
        # Counted, it would select the test for every change in the repository.
        self.write("tests/test_everything.py", """
            from pathlib import Path
            ROOT = Path(__file__).resolve().parents[1]
            def scan():
                return list(ROOT.glob("*"))
            """)
        self.assertEqual(self.lines("scripts/unread.py"), ["python-all scripts/unread.py"])

    def test_a_relative_import_inside_a_package_is_followed(self) -> None:
        self.write("plugins/llm-fleet/readers/relative.py", """
            from . import alone
            """)
        self.write("tests/test_relative.py", """
            import paths
            from readers import relative
            """)
        self.assertIn("python-test tests/test_relative.py",
                      self.lines("plugins/llm-fleet/readers/alone.py"))


class WideningTests(FixtureRepository):
    def test_a_file_no_test_reaches_falls_back_and_says_which(self) -> None:
        self.write("plugins/llm-fleet/assets/picture.svg", "<svg/>\n")
        self.assertEqual(self.lines("plugins/llm-fleet/assets/picture.svg"),
                         ["python-all plugins/llm-fleet/assets/picture.svg"])

    def test_the_harness_selects_the_whole_python_suite(self) -> None:
        # A helper every suite imports changes how each test runs, so the plan
        # runs them all and names the helper; the tests that import it are
        # still listed for a reader asking why.
        for harness in ("tests/paths.py", "tests/sandbox.py", "scripts/test-report.py",
                        "Makefile", "make/test.mk", ".cits/test-impact.sh"):
            self.write(harness, "# harness\n")
            with self.subTest(harness=harness):
                self.assertIn(f"python-all {harness}", self.lines(harness))

    def test_documentation_forces_nothing(self) -> None:
        self.assertEqual(self.lines("docs/notes.md", "TODO.md"),
                         ["docs docs/notes.md", "docs TODO.md"])

    def test_documentation_a_test_reads_selects_that_test(self) -> None:
        self.write("tests/test_notes.py", """
            from pathlib import Path
            NOTES = Path(__file__).resolve().parents[1] / "docs" / "notes.md"
            """)
        self.assertEqual(self.lines("docs/notes.md"), ["python-test tests/test_notes.py"])

    def test_a_path_the_declaration_calls_non_code_is_documentation(self) -> None:
        self.write(".test-impact.json", '{"nonCodePaths": ["personal/config.json"]}\n')
        self.write("personal/config.json", "{}\n")
        self.assertEqual(self.lines("personal/config.json"), ["docs personal/config.json"])

    def test_markdown_inside_the_plugin_is_not_documentation(self) -> None:
        # The plugin's README is what a person installing it reads, and suites
        # hold it to the install line; it falls back when nothing reads it.
        self.write("plugins/llm-fleet/NOTES.md", "notes\n")
        self.assertEqual(self.lines("plugins/llm-fleet/NOTES.md"),
                         ["python-all plugins/llm-fleet/NOTES.md"])

    def test_a_deleted_file_a_test_still_names_selects_that_test(self) -> None:
        (self.root / "scripts" / "drift-check.py").unlink()
        self.assertEqual(self.lines("scripts/drift-check.py"), ["python-test tests/test_drift.py"])

    def test_a_deleted_file_nothing_names_selects_nothing(self) -> None:
        (self.root / "scripts" / "unread.py").unlink()
        self.assertEqual(self.lines("scripts/unread.py"), [])

    def test_a_rename_is_read_as_both_of_its_paths(self) -> None:
        # The plan hands a rename over as the old path and the new one. The old
        # path is gone and named by nobody once the importer moves with it; the
        # new one is reached through the importer.
        (self.root / "plugins/llm-fleet/readers/runtime.py").rename(
            self.root / "plugins/llm-fleet/readers/engine.py")
        self.write("plugins/llm-fleet/readers/load.py", "from readers import engine\n")
        self.assertEqual(
            self.lines("plugins/llm-fleet/readers/runtime.py",
                       "plugins/llm-fleet/readers/engine.py",
                       "plugins/llm-fleet/readers/load.py"),
            ["python-test tests/test_load.py"])

    def test_the_host_kit_suite_is_named_not_run(self) -> None:
        self.write("plugins/llm-fleet/tests/pane.test.ts", "// host kit\n")
        self.assertEqual(self.lines("plugins/llm-fleet/tests/pane.test.ts"),
                         ["host-kit plugins/llm-fleet/tests/pane.test.ts"])

    def test_nothing_changed_selects_nothing(self) -> None:
        self.assertEqual(self.lines(), [])
        self.assertEqual(self.lines("", "  "), [])

    def test_a_path_that_climbs_out_of_the_root_is_ignored(self) -> None:
        self.assertEqual(self.lines("../elsewhere/test_x.py"), [])


class TypeScriptReachTests(FixtureRepository):
    def setUp(self) -> None:
        super().setUp()
        self.write("plugins/llm-fleet/components/layout.ts", """
            import { tone } from "./palette.ts";
            export const layout = tone;
            """)
        self.write("plugins/llm-fleet/components/palette.ts", 'export const tone = "x";\n')
        self.write("plugins/llm-fleet/components/lonely.ts", "export const lonely = 1;\n")
        self.write("components/layout.test.ts", """
            // reads "../plugins/llm-fleet/components/lonely.ts" in a comment only
            import { layout } from "../plugins/llm-fleet/components/layout.ts";
            """)
        self.write("components/other.test.ts", """
            /* nothing here */
            import { test } from "node:test";
            """)

    def test_a_relative_import_chain_selects_the_suite(self) -> None:
        self.assertEqual(self.lines("plugins/llm-fleet/components/palette.ts"),
                         ["ts-suite components/layout.test.ts"])

    def test_a_changed_suite_selects_itself(self) -> None:
        self.assertEqual(self.lines("components/other.test.ts"),
                         ["ts-suite components/other.test.ts"])

    def test_a_comment_names_nothing_and_an_unreached_module_runs_the_layer(self) -> None:
        self.assertEqual(self.lines("plugins/llm-fleet/components/lonely.ts"),
                         ["ts-all plugins/llm-fleet/components/lonely.ts"])

    def test_a_module_only_python_reads_still_runs_the_typescript_layer(self) -> None:
        # A Python suite reading a module's text does not execute it; the
        # layer that does is run whole, and says why.
        self.write("tests/test_text.py", """
            import paths
            SOURCE = paths.PLUGIN / "components" / "lonely.ts"
            """)
        self.assertEqual(self.lines("plugins/llm-fleet/components/lonely.ts"),
                         ["python-test tests/test_text.py",
                          "ts-all plugins/llm-fleet/components/lonely.ts"])

    def test_a_python_reader_a_suite_starts_by_path_is_followed(self) -> None:
        self.write("plugins/llm-fleet/components/entries.ts", """
            export const ENTRIES = { load: "readers/load.py" };
            """)
        self.write("components/entries.test.ts", """
            import { ENTRIES } from "../plugins/llm-fleet/components/entries.ts";
            """)
        self.assertEqual(self.lines("plugins/llm-fleet/readers/runtime.py"),
                         ["python-test tests/test_load.py", "ts-suite components/entries.test.ts"])

    def test_a_python_test_that_starts_a_typescript_runner_reaches_its_imports(self) -> None:
        self.write("config/parity-runner.ts", """
            import { layout } from "../plugins/llm-fleet/components/layout.ts";
            """)
        self.write("tests/test_parity.py", """
            from pathlib import Path
            RUNNER = Path(__file__).resolve().parents[1] / "config" / "parity-runner.ts"
            """)
        self.assertIn("python-test tests/test_parity.py",
                      self.lines("plugins/llm-fleet/components/palette.ts"))

    def test_a_declaration_file_is_not_typescript_to_run(self) -> None:
        self.write("plugins/llm-fleet/types/index.d.ts", "export interface X {}\n")
        self.assertEqual(self.lines("plugins/llm-fleet/types/index.d.ts"),
                         ["python-all plugins/llm-fleet/types/index.d.ts"])

    def test_a_string_holding_two_slashes_is_not_a_comment(self) -> None:
        self.write("components/url.test.ts", """
            const page = "https://example.invalid/x"; import { tone } from "../plugins/llm-fleet/components/palette.ts";
            """)
        self.assertIn("ts-suite components/url.test.ts",
                      self.lines("plugins/llm-fleet/components/palette.ts"))


class CommandTests(FixtureRepository):
    def run_script(self, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), *args],
                              input=stdin, capture_output=True, text=True, check=False)

    def test_paths_come_from_the_arguments(self) -> None:
        result = self.run_script("scripts/drift-check.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "python-test tests/test_drift.py\n")

    def test_paths_come_from_standard_input_when_none_are_given(self) -> None:
        result = self.run_script(stdin="scripts/drift-check.py\nREADME.md\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(),
                         ["python-test tests/test_drift.py", "docs README.md"])

    def test_a_root_that_is_not_there_is_refused(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--root",
                                 str(self.root / "absent"), "README.md"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("absent", result.stderr)

    def test_a_worktree_inside_the_root_is_not_read(self) -> None:
        # A second checkout under .claude/ holds a twin of every test; read, it
        # would select tests that are not this repository's.
        self.write(".claude/worktrees/twin/tests/test_twin.py", """
            from pathlib import Path
            SCRIPT = Path("scripts") / "unread.py"
            """)
        self.assertEqual(self.lines("scripts/unread.py"), ["python-all scripts/unread.py"])


class ThisRepositoryTests(unittest.TestCase):
    """The selection over the files it will meet, so drift is caught here."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repository = selector.Repository(ROOT)

    def lines(self, *changed: str) -> list[str]:
        # This file names the paths it asks about, so it is reached by them as
        # well; it is left out so each case reads the answer for the others.
        own = "python-test tests/test_test_select.py"
        return [line for line in selector.select(ROOT, list(changed)).lines() if line != own]

    def test_the_host_drift_script_selects_its_own_test_alone(self) -> None:
        self.assertEqual(self.lines("scripts/host-drift.py"),
                         ["python-test tests/test_host_drift.py"])

    def test_the_sandbox_helper_runs_the_whole_python_suite(self) -> None:
        self.assertIn("python-all tests/sandbox.py", self.lines("tests/sandbox.py"))

    def test_the_schema_reaches_both_loaders(self) -> None:
        lines = self.lines("plugins/llm-fleet/config/schema.json")
        self.assertIn("python-test tests/test_config_loader.py", lines)
        self.assertIn("ts-suite config/loader.test.ts", lines)

    def test_every_suite_and_test_file_is_known(self) -> None:
        tests = {path for path in self.repository.files if selector.PYTHON_TESTS.match(path)}
        on_disk = {f"tests/{path.name}" for path in (ROOT / "tests").glob("test_*.py")}
        self.assertEqual(tests, on_disk)
        self.assertIn("components/layout.test.ts", self.repository.files)


if __name__ == "__main__":
    unittest.main()
