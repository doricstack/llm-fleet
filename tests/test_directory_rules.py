#!/usr/bin/env python3
"""The plugin passes the directory's source reading, which `claude plugin validate` does not run.

The directory reads the hooks module as written. Once the module names the
first parameter of `register` (`on`) and a hook's parameters (`$`, the event and
`next`), it reads those names as the same thing everywhere in the file, so a
local variable or a parameter elsewhere that reuses one is a blocking finding:
the directory cannot tell that use from a registration or a capability call. A
reused event or `next` name also keeps a `command.run` hook from reading as one
that passes its event on, which holds the version for review.

The README is the listing's description and the place every policy hold is
answered, so it names each script the plugin starts and each fixed program the
readers run; a script added to the entry table without a line there fails here.
"""

import json
from pathlib import Path
import re
import unittest

from test_plugin_contract import code_positions


ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "llm-fleet"
HOOKS = PLUGIN / "hooks" / "llm-fleet.ts"
README = PLUGIN / "README.md"
ENTRIES = PLUGIN / "components" / "entries.ts"
REGISTER = re.compile(r"export const register: Register = \((?P<on>\w+),")
HOOK = re.compile(r"\bon\(\s*\"[\w.]+\"\s*,(?:\s*\{[^}]*\}\s*,)?\s*async\s*\((?P<params>[^)]*)\)\s*=>")
DECLARED = re.compile(r"\b(?:const|let|var)\s+(?P<name>[\w$]+)\b")
DESTRUCTURED = re.compile(r"\b(?:const|let|var)\s*[\[{](?P<names>[^\]}=]*)[\]}]")
SIGNATURE = re.compile(r"\bfunction\s*[\w$]*\s*\((?P<params>[^)]*)\)")
ARROW = re.compile(r"\((?P<params>[^()]*)\)\s*(?::\s*[^=]+)?=>")
ENTRY = re.compile(r"^\s+\w+:\s*\"(?P<path>readers/\w+\.py)\",$", re.MULTILINE)
FIXED_PROGRAMS = ("claude", "ps", "git", "lsof", "gh", "tmux")
PRIVACY_URL = "https://doricstack.com/privacy"


def code_only(text: str) -> str:
    """The source with comments, strings and template text blanked to spaces."""
    code, _ = code_positions(text)
    return "".join(char if code[index] or char == "\n" else " " for index, char in enumerate(text))


def names_in(params: str) -> list[str]:
    """The plain parameter names in a parameter list, types and defaults dropped."""
    names = []
    for part in params.split(","):
        name = part.split(":")[0].split("=")[0].strip().rstrip("?")
        if name:
            names.append(name)
    return names


def reserved_names(source: str) -> set[str]:
    """The names the directory reads as `on`, `$`, an event or `next` in this module."""
    found = REGISTER.search(source)
    names = {found.group("on")} if found else set()
    for hook in HOOK.finditer(source):
        names.update(names_in(hook.group("params")))
    return names


def reuses(source: str) -> list[str]:
    """Each place the module gives a reserved name to something other than a hook's own parameter."""
    # Blanking keeps every position, so a hook found in the source sits at the
    # same place in the code; the hooks are read from the source because their
    # event names are strings.
    code = code_only(source)
    reserved = reserved_names(source)
    hook_lists = {match.start("params") for match in HOOK.finditer(source)}
    register = REGISTER.search(source)
    found = []
    for match in DECLARED.finditer(code):
        if match.group("name") in reserved:
            found.append("{0}: declares {1}".format(code.count("\n", 0, match.start()) + 1, match.group("name")))
    for match in DESTRUCTURED.finditer(code):
        for name in names_in(match.group("names")):
            if name in reserved:
                found.append("{0}: destructures {1}".format(code.count("\n", 0, match.start()) + 1, name))
    for pattern in (SIGNATURE, ARROW):
        for match in pattern.finditer(code):
            if match.start("params") in hook_lists:
                continue
            if register is not None and match.start() <= register.end() <= match.end():
                continue
            for name in names_in(match.group("params")):
                # A top-level helper takes the engine whole as `$`, which the directory allows.
                if name in reserved and name != "$":
                    found.append("{0}: takes {1} as a parameter".format(
                        code.count("\n", 0, match.start()) + 1, name))
    return found


class ReservedNameReading(unittest.TestCase):
    """The reading itself, on small modules with a known answer."""

    MODULE = (
        'export const register: Register = (on, options) => {\n'
        '  on("session.start", async ($, event, next) => {\n'
        '    return next(event);\n'
        '  });\n'
        '};\n'
    )

    def test_a_clean_module_reuses_nothing(self):
        self.assertEqual(reuses(self.MODULE), [])

    def test_a_local_named_on_is_found(self):
        source = "function flip(state) {\n  const on = state.on;\n  return !on;\n}\n" + self.MODULE
        self.assertEqual(reuses(source), ["2: declares on"])

    def test_a_parameter_named_next_is_found(self):
        source = "function step(next: number) {\n  return next;\n}\n" + self.MODULE
        self.assertEqual(reuses(source), ["1: takes next as a parameter"])

    def test_a_loop_variable_named_event_is_found(self):
        source = "function all(list) {\n  for (const event of list) {}\n}\n" + self.MODULE
        self.assertEqual(reuses(source), ["2: declares event"])

    def test_a_destructured_name_is_found(self):
        source = "function pick(pair) {\n  const { on, off } = pair;\n}\n" + self.MODULE
        self.assertEqual(reuses(source), ["2: destructures on"])

    def test_names_in_comments_and_strings_are_not_code(self):
        source = '// const on = 1\nconst said = "const next = 2";\n' + self.MODULE
        self.assertEqual(reuses(source), [])

    def test_a_helper_taking_the_engine_as_dollar_is_allowed(self):
        source = "async function look($: Engine, state: State) {\n  return state;\n}\n" + self.MODULE
        self.assertEqual(reuses(source), [])


class FleetDirectoryRules(unittest.TestCase):
    """The plugin as it ships."""

    def test_the_hooks_module_reuses_no_reserved_name(self):
        self.assertEqual(reuses(HOOKS.read_text(encoding="utf-8")), [])

    def test_the_reserved_names_were_read(self):
        # A reading that found no names would pass every module, so it must find these.
        self.assertTrue({"on", "$", "event", "next"} <= reserved_names(HOOKS.read_text(encoding="utf-8")))

    def test_the_readme_names_every_script_the_plugin_starts(self):
        readme = README.read_text(encoding="utf-8")
        scripts = ENTRY.findall(ENTRIES.read_text(encoding="utf-8"))
        self.assertTrue(scripts)
        missing = [script for script in scripts if "`" + script + "`" not in readme]
        self.assertEqual(missing, [])

    def test_the_readme_names_every_fixed_program(self):
        readme = README.read_text(encoding="utf-8")
        missing = [program for program in FIXED_PROGRAMS if "`" + program not in readme]
        self.assertEqual(missing, [])

    def test_the_readme_says_nothing_leaves_the_machine(self):
        self.assertIn("Nothing about you or your sessions leaves your machine through the plugin.",
                      README.read_text(encoding="utf-8"))

    def test_the_readme_discloses_the_rate_card_fetch_and_its_switch(self):
        # The one request the plugin makes of its own is named, with what it
        # sends and the setting that stops it, so nobody learns of it from a
        # firewall prompt.
        readme = README.read_text(encoding="utf-8")
        self.assertIn("one network request of its own", readme)
        self.assertIn("`sources.rates.enabled: false` turns it off", readme)
        self.assertIn("`records/rate-cards.json`", readme)

    def test_the_listing_links_are_https_pages(self):
        # The submit form warns without a privacy policy, and the listing reads
        # these three from the manifest alone.
        manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        for key in ("privacyPolicyUrl", "documentationUrl", "supportUrl"):
            self.assertRegex(manifest.get(key, ""), r"^https://[^\s]+$", key)
        self.assertEqual(manifest["privacyPolicyUrl"], PRIVACY_URL)

    def test_the_readme_links_the_privacy_policy(self):
        readme = README.read_text(encoding="utf-8")
        self.assertRegex(readme, r"\[[^\]]*Privacy[^\]]*\]\(" + re.escape(PRIVACY_URL) + r"\)")

    def test_no_module_reads_an_object_kind_by_reflection(self):
        found = []
        for path in sorted(PLUGIN.rglob("*.ts")):
            if ".claude-plugin" in path.parts:
                continue
            code = code_only(path.read_text(encoding="utf-8"))
            for word in ("getPrototypeOf", "Reflect.", "new Proxy", "eval(", "new Function"):
                if word in code:
                    found.append("{0}: {1}".format(path.relative_to(PLUGIN), word))
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
