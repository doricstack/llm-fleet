"""The statusline preview, run as `make statusline-demo` runs it: a real script, a real
configuration file and a real Node render, in a temporary directory of its own."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "statusline-demo.py"


@unittest.skipIf(shutil.which("node") is None, "no Node on PATH to draw the lines")
class StatuslineDemoCase(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="statusline-demo-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.config = self.root / "config.json"
        self.config.write_bytes(b"{}\n")

    def demo(self, *argv: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--config", str(self.config),
             "--scratch", str(self.root), *argv],
            capture_output=True, text=True, timeout=120, cwd=str(self.root))

    def test_the_sample_is_drawn_through_node_and_named_as_a_sample(self) -> None:
        result = self.demo("--width", "100")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.rstrip("\n").split("\n")
        self.assertTrue(lines[0].startswith("# statusline preview, built-in samples"), lines[0])
        self.assertTrue(lines[0].endswith("width 100"), lines[0])
        self.assertIn("Opus 4.6 (1M context)", lines[1])
        self.assertTrue(any(line.startswith("CTX:") for line in lines[1:]), lines)
        self.assertTrue(any(line.startswith("COST:") for line in lines[1:]), lines)

    def test_the_request_names_the_sample_project_and_the_width(self) -> None:
        result = self.demo("--width", "80", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        request = json.loads(result.stdout)
        self.assertEqual(request["width"], 80)
        self.assertEqual(request["project"], "llm-fleet-private")
        self.assertEqual(request["branch"], "task/statusline-core")
        self.assertIn("host", request)
        self.assertTrue((self.root / "statusline-sample.jsonl").is_file())

    def test_a_recorded_payload_is_named_as_recorded(self) -> None:
        transcript = self.root / "session.jsonl"
        transcript.write_bytes(b"")
        payload = self.root / "payload.json"
        payload.write_bytes(json.dumps({
            "session_id": "recorded", "cwd": str(self.root),
            "transcript_path": str(transcript),
            "model": {"id": "claude-opus-4-6", "display_name": "Recorded Model"},
        }).encode("utf-8"))
        result = self.demo("--payload", str(payload), "--width", "100")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.rstrip("\n").split("\n")
        self.assertIn("a payload recorded from a real session", lines[0])
        self.assertNotIn("built-in samples", lines[0])
        self.assertIn("Recorded Model", "\n".join(lines[1:]))

    def test_a_refused_configuration_exits_two_and_names_the_key(self) -> None:
        self.config.write_bytes(b'{"notASetting": 1}\n')
        result = self.demo()
        self.assertEqual(result.returncode, 2)
        self.assertIn("The configuration was refused:", result.stderr)
        self.assertIn("notASetting", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_a_missing_payload_file_fails_without_drawing(self) -> None:
        result = self.demo("--payload", str(self.root / "absent.json"))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("# statusline preview", result.stdout)
        self.assertIn("absent.json", result.stderr)


if __name__ == "__main__":
    unittest.main()
