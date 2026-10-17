#!/usr/bin/env python3
"""Plugin boundary check behavior, driven by plugin folders the test writes.

The check exists because the host refuses an import that reaches outside a
plugin folder, and a surface that never loads is the only sign of it. Both
directions are asserted: an import that escapes is refused and named, and every
import shape that stays inside - a sibling, a parent that returns, a bare engine
module - passes. A run with nothing to read is refused rather than reported as
clean.
"""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "plugin-boundary.py"
MANIFEST = '{"name": "sample", "version": "0.1.0"}'


class BoundaryCase(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fleet-boundary-"))
        self.plugins = self.root / "plugins"
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def plugin(self, name: str = "sample") -> Path:
        folder = self.plugins / name
        (folder / ".claude-plugin").mkdir(parents=True, exist_ok=True)
        (folder / ".claude-plugin" / "plugin.json").write_text(MANIFEST, encoding="utf-8")
        return folder

    def write(self, folder: Path, relative: str, text: str) -> None:
        path = folder / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def outside(self, relative: str, text: str) -> None:
        path = self.plugins.parent / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def run_check(self) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(SCRIPT), "--plugins", str(self.plugins)],
                              capture_output=True, text=True, check=False)

    def test_an_import_that_escapes_the_plugin_is_refused_by_name(self) -> None:
        folder = self.plugin()
        self.outside("shared/layout.ts", "export const layout = 1;\n")
        self.write(folder, "hooks/entry.ts", 'import { layout } from "../../shared/layout.ts";\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("hooks/entry.ts:1", result.stderr)
        self.assertIn("../../shared/layout.ts", result.stderr)

    def test_an_import_of_a_sibling_module_passes(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/logic.ts", "export const logic = 1;\n")
        self.write(folder, "hooks/entry.ts", 'import { logic } from "./logic.ts";\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 modules", result.stdout)

    def test_a_parent_import_that_returns_inside_the_plugin_passes(self) -> None:
        folder = self.plugin()
        self.write(folder, "components/layout.ts", "export const layout = 1;\n")
        self.write(folder, "hooks/entry.ts", 'import { layout } from "../components/layout.ts";\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_bare_engine_module_is_left_alone(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts",
                   "import { atom } from 'claude-code';\nexport const entry = atom;\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_dynamic_import_that_escapes_is_refused(self) -> None:
        folder = self.plugin()
        self.outside("shared/render.ts", "export const render = 1;\n")
        self.write(folder, "hooks/entry.ts",
                   'const loaded = import("../../shared/render.ts");\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("../../shared/render.ts", result.stderr)

    def test_a_generated_declaration_tree_is_not_read(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts", "export const entry = 1;\n")
        self.write(folder, ".claude-plugin/types/index.d.ts",
                   'import type { Engine } from "../../../../elsewhere";\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 modules", result.stdout)

    def test_a_plugin_with_nothing_to_read_is_refused(self) -> None:
        self.plugin()
        result = self.run_check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("no TypeScript module", result.stderr)

    def test_a_node_global_is_refused(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts",
                   'const width = Number(process.argv[2] ?? 100);\nexport const entry = width;\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("hooks/entry.ts:1", result.stderr)
        self.assertIn("node global", result.stderr)

    def test_a_node_builtin_import_is_refused(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts", "import { readFile } from 'node:fs/promises';\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("node:fs/promises", result.stderr)

    def test_a_buffer_use_is_refused(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts",
                   'export const read = (chunks: Buffer[]) => Buffer.concat(chunks);\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("Buffer", result.stderr)

    def test_the_hosts_own_process_runner_is_not_mistaken_for_the_global(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts",
                   'export const run = ($: { process: { run: (a: string[]) => unknown } }) =>\n'
                   '  $.process.run(["tmux", "show-options"]);\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_an_event_named_in_quotes_is_not_mistaken_for_the_global(self) -> None:
        # A host-kit test answers the engine's `process.run` call beneath the
        # plugin by naming the event, which is a string, not the node global.
        folder = self.plugin()
        self.write(folder, "tests/kit.test.ts",
                   "on(\"process.run\", () => ({ value: null }));\n"
                   "on('process.exit', () => ({ value: null }));\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # The global itself is still refused on the same line shape.
        self.write(folder, "tests/kit.test.ts", "on(\"x\", () => process.exit(1));\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_a_tree_with_no_plugin_folder_is_refused(self) -> None:
        self.plugins.mkdir(parents=True)
        self.write(self.plugins / "loose", "hooks/entry.ts", "export const entry = 1;\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("no plugin folder", result.stderr)

    # The entry table. The plugin names a Python script it starts in one module,
    # components/entries.ts, and builds the command there; a script named or an
    # interpreter started anywhere else is a spawn the standalone proof cannot see.

    TABLE = ('export const PYTHON = "python3";\n'
             "export const ENTRIES = {\n"
             '  snapshot: "readers/snapshot.py",\n'
             "} as const;\n")

    def test_the_entry_table_may_name_scripts_and_the_interpreter(self) -> None:
        folder = self.plugin()
        self.write(folder, "components/entries.ts", self.TABLE)
        self.write(folder, "hooks/entry.ts",
                   'import { entryArgv } from "../components/entries.ts";\n'
                   "// The read command, readers/snapshot.py, answers with JSON.\n"
                   "/** It runs `readers/snapshot.py --pretty`. */\n"
                   'export const run = ($: any) => $.process.run(entryArgv($.plugin.root, "snapshot"));\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_script_named_outside_the_entry_table_is_refused(self) -> None:
        forms = ['export const READER = "readers/snapshot.py";',
                 "const run = ($: any) => $.process.run([PY, `${$.plugin.root}/readers/new.py`]);",
                 "const script = ['readers', 'new'].join('/') + '.py';",
                 "const script = ['readers', 'new', '.py'].join('');",
                 "const pattern = /snapshot\\.py$/;"]
        for form in forms:
            with self.subTest(form=form):
                self.setUp()
                folder = self.plugin()
                self.write(folder, "components/entries.ts", self.TABLE)
                self.write(folder, "hooks/entry.ts", "export const a = 1;\n" + form + "\n")
                result = self.run_check()
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("hooks/entry.ts:2", result.stderr)
                self.assertIn("entry table", result.stderr)

    def test_a_script_named_in_a_tsx_component_is_refused(self) -> None:
        folder = self.plugin()
        self.write(folder, "components/view.tsx", 'export const S = "readers/view.py";\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("components/view.tsx:1", result.stderr)

    def test_an_interpreter_started_outside_the_entry_table_is_refused(self) -> None:
        forms = ['const run = ($: any) => $.process.run(["python3", "-c", "print(1)"]);',
                 "const argv = ['python', '-m', 'readers.snapshot'];",
                 "const argv = [`python3.12`, script];"]
        for form in forms:
            with self.subTest(form=form):
                self.setUp()
                folder = self.plugin()
                self.write(folder, "hooks/entry.ts", "export const a = 1;\n" + form + "\n")
                result = self.run_check()
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("hooks/entry.ts:2", result.stderr)

    def test_a_host_kit_suite_may_name_the_scripts_it_answers_for(self) -> None:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts", "export const entry = 1;\n")
        self.write(folder, "tests/kit.test.ts",
                   'const isReader = (argv: string[]) => argv[1]?.endsWith("snapshot.py");\n')
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # The Python side, read from each module's syntax tree. An install copies
    # the plugin folder alone, so a module may import only the standard library
    # and the plugin's own packages, may not touch the import path except in
    # readers/plugin_root.py, and may not climb more than one level from its own
    # file anywhere else.

    def python_plugin(self, relative: str, text: str) -> Path:
        folder = self.plugin()
        self.write(folder, "hooks/entry.ts", "export const entry = 1;\n")
        self.write(folder, relative, text)
        return folder

    def refused(self, relative: str, text: str, *lines: int) -> str:
        self.python_plugin(relative, text)
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for line in lines:
            self.assertIn("{0}:{1}:".format(relative, line), result.stderr)
        return result.stderr

    def passes(self, relative: str, text: str) -> str:
        self.python_plugin(relative, text)
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_parents_counted_past_the_plugin_are_refused(self) -> None:
        stderr = self.refused("readers/tool.py",
                              "from pathlib import Path\n"
                              "ROOT = Path(__file__).resolve().parents[2]\n", 2)
        self.assertIn("above the plugin folder", stderr)

    def test_a_module_at_the_plugin_root_may_not_climb_at_all(self) -> None:
        self.refused("tool.py", "from pathlib import Path\n"
                                "UP = Path(__file__).resolve().parents[1]\n", 2)

    def test_the_helper_may_climb_to_the_root_and_set_the_path(self) -> None:
        stdout = self.passes("readers/plugin_root.py",
                             "from pathlib import Path\n"
                             "import sys\n"
                             "ROOT = Path(__file__).resolve().parents[1]\n"
                             "HERE = Path(__file__).resolve().parent.parent\n"
                             "if str(ROOT) not in sys.path:\n"
                             "    sys.path.insert(0, str(ROOT))\n")
        self.assertIn("2 modules", stdout)
        self.assertIn("1 Python", stdout)

    def test_the_helper_may_not_climb_past_the_root(self) -> None:
        self.refused("readers/plugin_root.py",
                     "from pathlib import Path\n"
                     "import sys\n"
                     "sys.path.insert(0, str(Path(__file__).resolve().parents[2]))\n", 3)

    def test_a_helper_of_the_same_name_elsewhere_is_not_sanctioned(self) -> None:
        self.refused("hooks/plugin_root.py",
                     "from pathlib import Path\n"
                     "import sys\n"
                     "sys.path.insert(0, str(Path(__file__).resolve().parents[1]))\n", 3)

    def test_an_entry_that_imports_the_helper_passes(self) -> None:
        folder = self.python_plugin("readers/plugin_root.py",
                                    "from pathlib import Path\n"
                                    "import sys\n"
                                    "sys.path.insert(0, str(Path(__file__).resolve().parents[1]))\n")
        self.write(folder, "readers/entry.py",
                   "if __package__ in (None, \"\"):\n"
                   "    import plugin_root  # noqa: F401\n"
                   "from readers.runtime import cut\n"
                   "from .runtime import cut as again\n"
                   "from config.loader import load_config\n")
        self.write(folder, "readers/runtime.py", "def cut(value):\n    return value\n")
        self.write(folder, "config/loader.py",
                   "from pathlib import Path\n"
                   "SCHEMA = Path(__file__).resolve().parent / 'schema.json'\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # Climbing is counted on one expression chain that starts at `__file__`,
    # through simple names assigned from one.

    def test_a_climb_of_two_from_the_file_is_refused_outside_the_helper(self) -> None:
        for chain in ("Path(__file__).resolve().parents[1]",
                      "Path(__file__).parent.parent",
                      "os.path.dirname(os.path.dirname(__file__))",
                      "os.path.dirname(Path(__file__).parent)",
                      "Path(os.path.abspath(__file__)).parent.parent"):
            with self.subTest(chain=chain):
                self.setUp()
                stderr = self.refused("readers/tool.py",
                                      "import os\nfrom pathlib import Path\nUP = " + chain + "\n",
                                      3)
                self.assertIn("2 levels", stderr)

    def test_one_level_from_the_file_passes(self) -> None:
        self.passes("readers/tool.py",
                    "import os\nfrom pathlib import Path\n"
                    "HERE = Path(__file__).resolve().parent\n"
                    "ALSO = Path(__file__).resolve().parents[0]\n"
                    "DIR = os.path.dirname(os.path.abspath(__file__))\n"
                    "SCHEMA = HERE / 'schema.json'\n")

    def test_two_independent_dirnames_on_one_line_are_two_climbs_of_one(self) -> None:
        self.passes("readers/tool.py",
                    "import os\n"
                    "PAIR = (os.path.dirname(__file__), os.path.dirname(__file__))\n")

    def test_a_climb_through_a_name_assigned_from_the_file_is_refused(self) -> None:
        self.refused("readers/tool.py",
                     "from pathlib import Path\n"
                     "HERE = Path(__file__).resolve().parent\n"
                     "REPO = HERE.parent\n", 3)

    def test_a_climb_through_two_names_is_refused(self) -> None:
        stderr = self.refused("readers/tool.py",
                              "from pathlib import Path\n"
                              "HERE = Path(__file__).resolve().parent\n"
                              "SAME = HERE\n"
                              "REPO = SAME.parents[1]\n", 4)
        self.assertIn("3 levels", stderr)
        self.assertNotIn("readers/tool.py:2:", stderr)
        self.assertNotIn("readers/tool.py:3:", stderr)

    def test_a_climb_inside_a_function_is_refused(self) -> None:
        self.refused("readers/tool.py",
                     "from pathlib import Path\n"
                     "def root():\n"
                     "    here = Path(__file__).parent\n"
                     "    return here.parent\n", 4)

    # A name has the height it holds where it is used, in its own scope.

    def test_a_name_climbed_one_step_by_reassignment_passes(self) -> None:
        self.passes("readers/tool.py",
                    "from pathlib import Path\n"
                    "p = Path(__file__)\n"
                    "p = p.parent\n"
                    "SCHEMA = p / 'schema.json'\n")

    def test_a_second_climb_from_a_climbed_name_is_refused(self) -> None:
        stderr = self.refused("readers/tool.py",
                              "from pathlib import Path\n"
                              "p = Path(__file__).parent\n"
                              "q = p.parent\n", 3)
        self.assertNotIn("readers/tool.py:2:", stderr)

    def test_a_reassignment_climbed_again_is_refused(self) -> None:
        self.refused("readers/tool.py",
                     "from pathlib import Path\n"
                     "p = Path(__file__)\n"
                     "p = p.parent\n"
                     "p = p.parent\n", 4)

    def test_a_name_rebound_to_another_path_no_longer_climbs(self) -> None:
        self.passes("readers/tool.py",
                    "from pathlib import Path\n"
                    "p = Path(__file__).parent\n"
                    "p = Path('/data')\n"
                    "UP = p.parent.parent\n")

    def test_a_same_named_variable_in_another_function_does_not_inherit(self) -> None:
        self.passes("readers/tool.py",
                    "from pathlib import Path\n"
                    "def here():\n"
                    "    p = Path(__file__).parent\n"
                    "    return p\n"
                    "def data(p):\n"
                    "    return p.parent.parent\n"
                    "def other():\n"
                    "    p = Path('/data')\n"
                    "    return p.parent.parent\n")

    def test_a_function_reading_a_module_name_sees_its_height(self) -> None:
        self.refused("readers/tool.py",
                     "from pathlib import Path\n"
                     "HERE = Path(__file__).parent\n"
                     "def root():\n"
                     "    return HERE.parent\n", 4)

    def test_a_module_name_does_not_take_a_function_s_height(self) -> None:
        self.passes("readers/tool.py",
                    "from pathlib import Path\n"
                    "p = Path('/data')\n"
                    "def here():\n"
                    "    p = Path(__file__).parent\n"
                    "    return p\n"
                    "UP = p.parent.parent\n")

    def test_a_path_that_does_not_come_from_the_file_may_climb(self) -> None:
        self.passes("readers/tool.py",
                    "import os\nfrom pathlib import Path\n"
                    "def places(config):\n"
                    "    data = Path(config['sources']['progress']['directory'])\n"
                    "    top = data.parent.parent\n"
                    "    up = data.parents[3]\n"
                    "    return top, up, os.path.dirname(os.path.dirname(str(data)))\n")

    # The import path is touched only by the helper, through whatever name.

    def test_every_form_of_import_path_manipulation_is_refused(self) -> None:
        forms = ["import sys\nsys.path.append('x')",
                 "import sys\nsys.path += ['x']",
                 "import sys\nsys . path[0:0] = ['x']",
                 "import sys as s\ns.path.insert(0, 'x')",
                 "import sys\ns = sys\ns.path.insert(0, 'x')",
                 "from sys import path\npath.insert(0, 'x')",
                 "from sys import path as p\np.append('x')",
                 "import importlib\nimportlib.import_module('x')",
                 "import importlib.util as u\nu.find_spec('x')",
                 "from importlib import import_module as load\nload('x')",
                 "import builtins\nbuiltins.__import__('x')",
                 "__import__('x')",
                 "import runpy\nrunpy.run_path('x')"]
        for form in forms:
            with self.subTest(form=form):
                self.setUp()
                stderr = self.refused("readers/tool.py", form + "\n")
                self.assertIn("import path", stderr)

    def test_reading_the_platform_from_sys_passes(self) -> None:
        self.passes("readers/tool.py",
                    "import sys\nPLATFORM = sys.platform\n"
                    "def out(text):\n    sys.stdout.write(text)\n")

    # Imports anywhere in the tree are read, each name on its own.

    def test_an_import_from_outside_the_plugin_and_the_standard_library_is_refused(self) -> None:
        stderr = self.refused("readers/tool.py",
                              "import json\n"
                              "import pluginsupport\n"
                              "def late():\n"
                              "    from scripts.render import draw\n"
                              "    import os, components\n"
                              "if True:\n"
                              "    import yaml\n"
                              "try:\n"
                              "    import requests\n"
                              "except ImportError:\n"
                              "    pass\n"
                              "class Thing:\n"
                              "    def method(self):\n"
                              "        import tests.paths\n",
                              2, 4, 5, 7, 9, 14)
        self.assertNotIn("readers/tool.py:1:", stderr)
        self.assertIn("standard library", stderr)

    def test_an_import_through_the_plugins_package_is_named(self) -> None:
        stderr = self.refused("readers/tool.py",
                              "from plugins.fleet.readers.runtime import cut\n"
                              "import plugins.fleet\n", 1, 2)
        self.assertIn("plugins package", stderr)

    def test_a_relative_import_past_the_plugin_is_refused(self) -> None:
        self.refused("readers/tool.py", "from ...shared import thing\n", 1)

    def test_imports_from_the_plugin_and_the_standard_library_pass(self) -> None:
        folder = self.python_plugin("readers/tool.py",
                                    "from __future__ import annotations\n"
                                    "from .runtime import cut\n"
                                    "from . import runtime\n"
                                    "from readers.runtime import cut as again\n"
                                    "from config.loader import load_config\n"
                                    "import json, os.path as osp\n"
                                    "WAIT = 'still reading...'\n"
                                    "# a comment may say ../ without reaching anywhere\n")
        self.write(folder, "readers/runtime.py", "def cut(value):\n    return value\n")
        self.write(folder, "config/loader.py", "VALUE = 1\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("4 modules", result.stdout)
        self.assertIn("3 Python", result.stdout)

    # A `..` path segment in a string, or os.pardir, climbs by joining.

    def test_a_dotdot_segment_is_refused(self) -> None:
        for text in ("import os\nSHARED = os.path.join(os.path.dirname(__file__), '..', 'x')\n",
                     "from pathlib import Path\nSHARED = Path(__file__).parent / '../../x.py'\n",
                     "import os\nUP = os.path.join(os.path.dirname(__file__), os.pardir)\n",
                     "from os import pardir\nUP = pardir\n"):
            with self.subTest(text=text):
                self.setUp()
                self.refused("readers/tool.py", text, 2)

    def test_a_docstring_may_say_dotdot(self) -> None:
        self.passes("readers/tool.py", '"""Never join a ../ onto this file."""\nVALUE = 1\n')

    def test_a_module_that_does_not_parse_is_refused(self) -> None:
        stderr = self.refused("readers/tool.py", "def broken(:\n")
        self.assertIn("does not parse", stderr)

    def test_the_plugins_in_this_repository_stay_inside_their_folders(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--plugins", str(ROOT / "plugins")],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("inside their folders", result.stdout)


if __name__ == "__main__":
    unittest.main()
