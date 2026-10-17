#!/usr/bin/env python3
"""Custom-section reader behavior, against real commands.

Each case writes a small program and names it as a section's command, so the
argument list, the stripped environment, the timeout, the byte bound and every
refusal are observed from a real child process rather than assumed.
"""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config
from readers import custom, snapshot


class CustomCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-custom-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def environment(self, **extra):
        return sandbox.home_environment(self.root, **extra)

    def program(self, name, body):
        path = self.root / (name + ".py")
        path.write_text("import json, os, sys, time\n" + body, encoding="utf-8")
        return [sys.executable, str(path)]

    def printing(self, name, document):
        return self.program(name, "print(json.dumps({0!r}))\n".format(document))

    def config(self, sections, order=None, **document):
        pane = {"custom": sections}
        if order is not None:
            pane["sectionOrder"] = order
        body = {"stateDir": str(self.root / "state"), "pane": pane}
        body.update(document)
        path = self.root / "config.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        return load_config(path, environ=self.environment())

    def read(self, sections, environ=None, **document):
        return custom.read_custom(self.config(sections, **document),
                                  environ=environ or self.environment())


class CustomReaderTests(CustomCase):
    def test_no_declared_section_is_switched_off_rather_than_empty(self):
        result = self.read({})
        self.assertEqual(result, {"state": "disabled", "sections": {}, "errors": []})

    def test_a_section_draws_the_rows_its_command_prints(self):
        command = self.printing("deploys", {"summary": "1 running", "rows": [
            {"title": "web to staging", "state": "Running", "detail": "migrating",
             "done": 3, "total": 5, "failed": 1, "slot": "4m"},
            {"title": "api", "state": "sideways"},
        ]})
        result = self.read({"deploys": {"title": "Deploys", "command": command,
                                        "legend": "What is deploying."}})
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["errors"], [])
        section = result["sections"]["deploys"]
        self.assertEqual(section["state"], "ready")
        self.assertEqual(section["title"], "Deploys")
        self.assertEqual(section["legend"], "What is deploying.")
        self.assertEqual(section["summary"], "1 running")
        self.assertEqual(section["printed"], 2)
        self.assertEqual(section["rows"], [
            {"title": "web to staging", "state": "running", "detail": "migrating", "slot": "4m",
             "done": 3, "total": 5, "failed": 1},
            # A state the pane has no color for draws plain instead of guessed.
            {"title": "api", "state": None, "detail": None, "slot": None,
             "done": None, "total": None, "failed": None},
        ])
        self.assertEqual((section["visible"], section["collapsed"], section["hideWhenEmpty"]),
                         (True, False, False))

    def test_a_bar_is_drawn_only_from_figures_the_command_gave(self):
        command = self.printing("bars", {"rows": [
            {"title": "no total", "done": 2},
            {"title": "zero total", "done": 0, "total": 0},
            {"title": "past its end", "done": 6, "total": 5},
            {"title": "negative", "done": -1, "total": 5},
            {"title": "true is not one", "done": True, "total": 5},
            {"title": "fraction", "done": 1.5, "total": 5},
            {"title": "failed past done", "done": 2, "total": 5, "failed": 3},
            {"title": "whole", "done": 0, "total": 4},
        ]})
        rows = self.read({"bars": {"command": command}})["sections"]["bars"]["rows"]
        figures = {row["title"]: (row["done"], row["total"], row["failed"]) for row in rows}
        for title in ("no total", "zero total", "past its end", "negative", "true is not one",
                      "fraction"):
            self.assertEqual(figures[title], (None, None, None), title)
        self.assertEqual(figures["failed past done"], (2, 5, None))
        self.assertEqual(figures["whole"], (0, 4, None))

    def test_rows_without_a_title_are_skipped_and_text_is_made_printable_and_cut(self):
        command = self.printing("text", {"summary": "s\x1b[31mum", "rows": [
            {"detail": "no title"}, "not an object", {"title": "   "},
            {"title": "a\x07b " + "x" * 400, "detail": "line\nbreak"},
        ]})
        section = self.read({"text": {"command": command}},
                            limits={"questionCharacters": 20})["sections"]["text"]
        self.assertEqual(section["printed"], 1)
        row = section["rows"][0]
        self.assertEqual(row["title"], "ab " + "x" * 17)
        self.assertEqual(row["detail"], "line break")
        self.assertNotIn("\x1b", section["summary"])

    def test_rows_past_the_cap_are_counted_but_not_drawn(self):
        command = self.printing("many", {"rows": [{"title": "row " + str(index)}
                                                  for index in range(custom.ROW_CAP + 7)]})
        section = self.read({"many": {"command": command}})["sections"]["many"]
        self.assertEqual(len(section["rows"]), custom.ROW_CAP)
        self.assertEqual(section["printed"], custom.ROW_CAP + 7)

    def test_a_command_that_prints_no_rows_is_empty(self):
        section = self.read({"quiet": {"command": self.printing("quiet", {"rows": []}),
                                       "hideWhenEmpty": True}})["sections"]["quiet"]
        self.assertEqual(section["state"], "empty")
        self.assertTrue(section["hideWhenEmpty"])
        self.assertEqual(section["errors"], [])

    def test_a_command_not_on_the_path_is_unavailable_and_named(self):
        result = self.read({"gone": {"command": ["fleet-no-such-command-anywhere"]}})
        section = result["sections"]["gone"]
        self.assertEqual(section["state"], "unavailable")
        self.assertEqual(result["errors"], [{"source": "custom:gone",
                                             "reason": "fleet-no-such-command-anywhere is not on PATH"}])

    def test_each_way_a_command_can_fail_is_named_and_leaves_the_others_drawn(self):
        sections = {
            "exits": {"command": self.program("exits", "sys.exit(3)\n")},
            "garbage": {"command": self.program("garbage", "print('not json')\n")},
            "shape": {"command": self.printing("shape", ["a", "list"])},
            "norows": {"command": self.printing("norows", {"rows": "many"})},
            "slow": {"command": self.program("slow", "time.sleep(10)\n"), "timeoutSeconds": 1},
            "bytes": {"command": self.program("bytes", "print(json.dumps({'rows': [], 'x': 'y' * 4000}))\n")},
            "fine": {"command": self.printing("fine", {"rows": [{"title": "still here"}]})},
        }
        result = self.read(sections, limits={"jobStateBytes": 1024})
        reasons = {error["source"]: error["reason"] for error in result["errors"]}
        self.assertEqual(reasons, {
            "custom:exits": "exit 3",
            "custom:garbage": "output was not JSON",
            "custom:shape": "output had no rows list",
            "custom:norows": "output had no rows list",
            "custom:slow": "timed out after 1s",
            "custom:bytes": "output over 1024 bytes",
        })
        for name in ("exits", "garbage", "shape", "norows", "slow", "bytes"):
            self.assertEqual(result["sections"][name]["state"], "failed", name)
            self.assertEqual(result["sections"][name]["rows"], [], name)
        self.assertEqual(result["sections"]["fine"]["state"], "ready")

    def test_a_command_never_sees_a_provider_credential(self):
        command = self.program("env", "print(json.dumps({'rows': [{'title': k} for k in "
                                      "sorted(os.environ) if k.startswith('ANTHROPIC_') "
                                      "or k == 'FLEET_KEPT']}))\n")
        environ = self.environment(ANTHROPIC_API_KEY_TEST="secret-value", FLEET_KEPT="1")
        section = self.read({"env": {"command": command}}, environ=environ)["sections"]["env"]
        self.assertEqual([row["title"] for row in section["rows"]], ["FLEET_KEPT"])

    def test_sections_keep_the_order_the_document_declares_them_in(self):
        sections = {name: {"command": self.printing(name, {"rows": []})}
                    for name in ("zeta", "alpha", "mid")}
        self.assertEqual(list(self.read(sections)["sections"]), ["zeta", "alpha", "mid"])


EXAMPLES = Path(__file__).resolve().parent.parent / "config" / "examples"


class ShippedExampleTests(CustomCase):
    def test_the_shipped_example_configuration_loads_and_places_its_section(self):
        document = json.loads((EXAMPLES / "custom-section.json").read_text(encoding="utf-8"))
        config = self.config(document["pane"]["custom"], order=document["pane"]["sectionOrder"])
        self.assertIn("custom:disk", config["pane"]["sectionOrder"])
        disk = config["pane"]["custom"]["disk"]
        self.assertEqual((disk["title"], disk["timeoutSeconds"], disk["collapsed"]), ("Disk", 5, True))
        self.assertFalse(disk["hideWhenEmpty"])

    def test_the_shipped_example_command_draws_a_bar_per_disk(self):
        command = [sys.executable, str(EXAMPLES / "disk_section.py")]
        section = self.read({"disk": {"title": "Disk", "command": command}})["sections"]["disk"]
        self.assertEqual(section["state"], "ready", section["errors"])
        self.assertGreaterEqual(len(section["rows"]), 1)
        self.assertRegex(section["summary"], r"^\d+ disks?$")
        for row in section["rows"]:
            self.assertIn(row["title"], ("home", "temp"))
            self.assertIsInstance(row["total"], int)
            self.assertGreater(row["total"], 0)
            self.assertLessEqual(row["done"], row["total"])
            self.assertRegex(row["slot"], r"^\d+ GiB free$")


class CustomSnapshotTests(CustomCase):
    def test_the_reading_carries_custom_sections_beside_the_built_in_ones(self):
        command = self.printing("deploys", {"rows": [{"title": "web"}]})
        config = self.config({"deploys": {"command": command}},
                             order=["prs", "custom:deploys", "sessions"])
        reading = snapshot.read_snapshot(config, now=1_700_000_000.0)
        self.assertEqual(reading["pane"]["order"], ["prs", "custom:deploys", "sessions"])
        self.assertEqual(reading["custom"]["sections"]["deploys"]["rows"][0]["title"], "web")


if __name__ == "__main__":
    unittest.main()
