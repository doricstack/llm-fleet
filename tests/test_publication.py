#!/usr/bin/env python3
"""What a person installs is what this repository says it is.

The install line in each README names the plugin by its manifest name and the
published repository as its marketplace; the repository's marketplace file lists
that one plugin at the folder that holds it; and the manifest, both marketplace
entries and the release tag share one version. A rename or a version raised in
one file and not the others fails here, before anyone types a line that answers
`Plugin not found`.
"""

import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "fleet"
MANIFEST = PLUGIN / ".claude-plugin" / "plugin.json"
PUBLISHED = ROOT / ".claude-plugin" / "marketplace.json"
LOCAL = PLUGIN / ".claude-plugin" / "marketplace.json"
READMES = (ROOT / "README.md", PLUGIN / "README.md")
ALLOWLIST = ROOT / "public-export" / "allowlist.txt"
# The published half of the repository pair; the export is what writes it.
REPOSITORY = "doricstack/llm-fleet"
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
INSTALL = re.compile(r"^/plugin install (?P<name>\S+) --marketplace (?P<source>\S+)$", re.MULTILINE)


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def install_lines(text: str) -> list[tuple[str, str]]:
    """The install lines inside the fenced blocks of this text."""
    blocks = re.findall(r"^```[^\n]*\n(.*?)^```", text, flags=re.MULTILINE | re.DOTALL)
    found: list[tuple[str, str]] = []
    for body in blocks:
        for line in INSTALL.finditer(body):
            found.append((line.group("name"), line.group("source")))
    return found


class InstallLine(unittest.TestCase):
    def test_install_lines_are_read_only_from_code_blocks(self) -> None:
        text = "/plugin install a --marketplace o/r\n\n```\n/plugin install b --marketplace o/r\n```\n"
        self.assertEqual(install_lines(text), [("b", "o/r")])

    def test_each_readme_installs_the_manifest_name_from_the_published_repository(self) -> None:
        name = read(MANIFEST)["name"]
        for readme in READMES:
            with self.subTest(readme=readme.relative_to(ROOT).as_posix()):
                self.assertEqual(install_lines(readme.read_text(encoding="utf-8")),
                                 [(name, REPOSITORY)])


class Marketplaces(unittest.TestCase):
    def entry(self, path: Path) -> dict:
        document = read(path)
        self.assertEqual(len(document["plugins"]), 1, "a marketplace here lists one plugin")
        return document["plugins"][0]

    def test_the_published_marketplace_lists_the_plugin_at_its_folder(self) -> None:
        manifest = read(MANIFEST)
        document = read(PUBLISHED)
        self.assertEqual(document["name"], REPOSITORY.split("/")[1])
        entry = self.entry(PUBLISHED)
        self.assertEqual(entry["name"], manifest["name"])
        self.assertTrue(entry["source"].startswith("./"), "a marketplace source is relative")
        self.assertEqual((ROOT / entry["source"]).resolve(), PLUGIN.resolve())

    def test_the_local_marketplace_serves_the_same_plugin_from_its_own_folder(self) -> None:
        entry = self.entry(LOCAL)
        self.assertEqual(entry["name"], read(MANIFEST)["name"])
        self.assertEqual(entry["source"], "./")

    def test_one_version_everywhere(self) -> None:
        version = read(MANIFEST)["version"]
        self.assertRegex(version, SEMVER)
        self.assertEqual(self.entry(PUBLISHED)["version"], version)
        self.assertEqual(self.entry(LOCAL)["version"], version)

    def test_one_owner_and_one_description(self) -> None:
        manifest = read(MANIFEST)
        for path in (PUBLISHED, LOCAL):
            with self.subTest(marketplace=path.relative_to(ROOT).as_posix()):
                self.assertEqual(read(path)["owner"]["name"], manifest["author"]["name"])
                self.assertEqual(self.entry(path)["description"], manifest["description"])


class Export(unittest.TestCase):
    def test_the_published_tree_carries_what_an_install_reads(self) -> None:
        listed = set(ALLOWLIST.read_text(encoding="utf-8").splitlines())
        for path in (PUBLISHED, MANIFEST, PLUGIN / "README.md", ROOT / "README.md"):
            with self.subTest(path=path.relative_to(ROOT).as_posix()):
                self.assertIn(path.relative_to(ROOT).as_posix(), listed)


if __name__ == "__main__":
    unittest.main()
