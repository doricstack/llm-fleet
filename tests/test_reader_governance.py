#!/usr/bin/env python3
"""The governance reader: what the switch says, and the one way to move it.

Every case is a real file in a temporary directory, so a reader that draws a
switch is reading the same document the tool writes. The write case runs a real
stub command and checks the words it was given, because the scope is the whole
difference between turning the queue off and turning the controller off.
"""

import json
from pathlib import Path
import stat
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)

from readers import governance


class GovernanceCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.switch = self.root / "state" / "governor-switch.json"
        self.switch.parent.mkdir(parents=True)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def config(self, **declared) -> dict:
        return {"sources": {"governance": declared}}

    def write_switch(self, document: object) -> None:
        self.switch.write_text(json.dumps(document), encoding="utf-8")

    def test_a_machine_that_names_no_switch_reads_as_unconfigured(self):
        # The switch belongs to tooling a person may not run. Nothing is drawn,
        # and nothing is guessed into looking configured.
        assert governance.read_governance({"sources": {}})["state"] == "unconfigured"
        assert governance.read_governance({})["state"] == "unconfigured"
        assert governance.read_governance(
            {"sources": {"governance": {}}})["state"] == "unconfigured"

    def test_a_switch_that_is_switched_off_in_configuration_is_disabled(self):
        # Readiness is the configuration's word, like every other source: a
        # person may leave a path in place and still leave the source off.
        result = governance.read_governance(
            self.config(enabled=False, switchPath=str(self.switch)))
        self.assertEqual(result["state"], "disabled")

    def test_a_missing_file_is_both_on_because_that_is_what_the_tool_says(self):
        result = governance.read_governance(self.config(switchPath=str(self.switch)))
        self.assertEqual(result["state"], "ready")
        self.assertEqual((result["governor"], result["controller"]), (True, True))
        self.assertEqual(result["source"], "missing")

    def test_each_scope_is_read_as_the_document_states_it(self):
        self.write_switch({"governor": False, "controller": True,
                           "updated_at": "2026-10-19T10:00:00Z", "by": "someone"})
        result = governance.read_governance(self.config(switchPath=str(self.switch)))
        self.assertEqual(result["state"], "ready")
        self.assertEqual((result["governor"], result["controller"]), (False, True))
        self.assertEqual(result["source"], "config")
        self.assertEqual(result["by"], "someone")
        self.assertEqual(result["updated_at"], "2026-10-19T10:00:00Z")

    def test_the_single_enabled_flag_still_moves_both(self):
        # An older writer sent one flag for both scopes, and the tool still
        # honours it; a reader that knew only the two-scope form would draw a
        # switched-off machine as fully on.
        self.write_switch({"enabled": False})
        result = governance.read_governance(self.config(switchPath=str(self.switch)))
        self.assertEqual((result["governor"], result["controller"]), (False, False))
        self.write_switch({"enabled": True})
        result = governance.read_governance(self.config(switchPath=str(self.switch)))
        self.assertEqual((result["governor"], result["controller"]), (True, True))

    def test_the_legacy_marker_turns_both_off(self):
        self.write_switch({"governor": True, "controller": True})
        (self.switch.parent / governance.LEGACY_NAME).write_text("", encoding="utf-8")
        result = governance.read_governance(self.config(switchPath=str(self.switch)))
        self.assertEqual((result["governor"], result["controller"]), (False, False))
        self.assertEqual(result["source"], "legacy")

    def test_a_file_that_cannot_be_read_is_failed_and_never_both_on(self):
        # The tool leaves the gates on for an invalid document, but a pane that
        # drew that as "on" would be reporting a state it never read.
        self.switch.write_text("{not json", encoding="utf-8")
        result = governance.read_governance(self.config(switchPath=str(self.switch)))
        self.assertEqual(result["state"], "failed")
        self.assertNotIn("governor", result)
        self.assertTrue(result["errors"])
        self.switch.write_text(json.dumps({"governor": "no"}), encoding="utf-8")
        self.assertEqual(
            governance.read_governance(self.config(switchPath=str(self.switch)))["state"],
            "failed")

    def test_a_scope_moves_through_the_configured_command(self):
        recorder = self.root / "argv.txt"
        stub = self.root / "switch.py"
        stub.write_text(
            "#!/usr/bin/env python3\n"
            "import json, pathlib, sys\n"
            "pathlib.Path(sys.argv[0]).with_name('argv.txt').write_text(' '.join(sys.argv[1:]))\n"
            "target = pathlib.Path(" + repr(str(self.switch)) + ")\n"
            "target.write_text(json.dumps({'governor': sys.argv[1] == 'on',\n"
            "                              'controller': True}))\n",
            encoding="utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
        config = self.config(switchPath=str(self.switch),
                             switchCommand=[str(stub)])
        result = governance.set_governance(config, "governor", False)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["governor"], False)
        self.assertEqual(recorder.read_text(encoding="utf-8"), "off governor")

    def test_a_write_with_no_command_says_so_and_writes_nothing(self):
        self.write_switch({"governor": True, "controller": True})
        before = self.switch.read_text(encoding="utf-8")
        result = governance.set_governance(self.config(switchPath=str(self.switch)),
                                           "controller", False)
        self.assertEqual(result["state"], "unconfigured")
        self.assertEqual(self.switch.read_text(encoding="utf-8"), before)

    def test_a_command_that_fails_keeps_its_reason(self):
        stub = self.root / "refuse.py"
        stub.write_text("#!/usr/bin/env python3\nimport sys\nsys.stderr.write('refused')\n"
                        "sys.exit(3)\n", encoding="utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
        result = governance.set_governance(
            self.config(switchPath=str(self.switch), switchCommand=[str(stub)]),
            "governor", False)
        self.assertEqual(result["state"], "failed")
        self.assertIn("refused", result["errors"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
