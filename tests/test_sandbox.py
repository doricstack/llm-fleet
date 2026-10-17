#!/usr/bin/env python3
"""The environment every reader case builds, and what it has to cover.

The case that matters here is the one no reader suite can make for itself: the
loader is asked where it keeps state and which file it reads, and both answers
have to be inside the case's own tree. Where an answer is the machine's, a case
reads and writes a real user's folder and passes or fails by the order it ran
in, which is what two roster cases did on a Windows runner.
"""

from pathlib import Path
import tempfile
import unittest
from unittest import mock

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from config.loader import load_config


class CoverageTests(unittest.TestCase):
    def test_every_variable_the_contract_reads_has_a_place_under_the_case(self):
        # The list comes from the contract, so a variable the loader learns to
        # read fails here rather than quietly reaching the machine it runs on.
        missing = sorted(name for name in sandbox.contract_variables()
                         if name not in sandbox.PLACES)
        self.assertEqual(missing, [])

    def test_every_root_the_environment_sets_points_inside_the_case(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory).resolve()
            where = sandbox.home_environment(case)
            for name in sandbox.contract_variables():
                self.assertIn(name, where)
                self.assertTrue(Path(where[name]).is_relative_to(case), name)

    def test_a_variable_with_no_place_is_refused_rather_than_passed_through(self):
        # Passing it through is the leak this module exists to close, so an
        # unknown name is an error and not a variable left pointing outward.
        with mock.patch.object(sandbox, "contract_variables", return_value=["HOME", "NEW_ROOT"]):
            with self.assertRaises(AssertionError) as caught:
                sandbox.home_environment(Path("/nowhere"))
        self.assertIn("NEW_ROOT", str(caught.exception))

    def test_the_selector_and_the_legacy_name_are_removed(self):
        # A developer who has set either one would otherwise have every reader
        # case read the configuration on their own machine.
        with mock.patch.dict("os.environ", {"FLEET_CONFIG": "/elsewhere/config.json",
                                            "FLEET_STATE_DIR": "/elsewhere/state"}):
            where = sandbox.home_environment(Path("/case"))
        self.assertNotIn("FLEET_CONFIG", where)
        self.assertNotIn("FLEET_STATE_DIR", where)


class ResolutionTests(unittest.TestCase):
    def test_the_loader_resolves_no_root_outside_the_case(self):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory).resolve()
            resolved = load_config(None, environ=sandbox.home_environment(case))
            self.assertTrue(Path(resolved["stateDir"]).is_relative_to(case),
                            resolved["stateDir"])
            # Nothing was read from outside either: a case handed this
            # environment resolves the packaged defaults, never the file on the
            # machine, which is the other half of the same leak.
            self.assertEqual(resolved["providers"], [])


if __name__ == "__main__":
    unittest.main()
