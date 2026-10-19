#!/usr/bin/env python3
"""Host payload behavior, driven through a real stream and a real command.

The host is another program, so the cases that matter are the ones where it sends
something other than what this layer expects: nothing at all, a document that is
not an object, a field with the wrong type, and more bytes than the limit allows.
Each one has to land in a state the renderer can act on, and none of them may turn
into a zero on screen.

Run with: python3 tests/test_reader_host.py -v
"""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import paths  # noqa: F401  (puts the plugin root on the path)
import sandbox

from readers import host


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins" / "llm-fleet" / "readers" / "host.py"


def payload(**overrides):
    """A payload shaped like the one the host sends, from a real recorded shape."""
    document = {
        "session_id": "abc123",
        "cwd": "/tmp/project",
        "session_name": "statusline",
        "version": "2.1.105",
        "output_style": {"name": "default"},
        "model": {"id": "claude-opus-4-6[1m]", "display_name": "Opus 4.6 (1M context)"},
        "cost": {"total_cost_usd": 1.25, "total_duration_ms": 60000,
                 "total_api_duration_ms": 12000, "total_lines_added": 40,
                 "total_lines_removed": 7},
        "context_window": {"total_input_tokens": 902437, "total_output_tokens": 5120,
                           "remaining_percentage": 9.7, "context_window_size": 1000000,
                           "exceeds_200k_tokens": True,
                           "current_usage": {"cache_read_input_tokens": 880000,
                                             "cache_creation_input_tokens": 20000}},
        "rate_limits": {"five_hour": {"used_percentage": 41.5, "resets_at": 1790000000},
                        "seven_day": {"used_percentage": 12, "resets_at": 1790500000},
                        "spend_limit": {"used_percentage": 3.5, "resets_at": 1791000000}},
        "effort": {"level": "high"},
        "thinking": {"enabled": True},
        "prompt_cache": {"warm": True, "hit_ratio": 0.93},
        "pr": {"number": 412, "state": "OPEN"},
        "worktree": {"branch": "task/statusline-core"},
    }
    document.update(overrides)
    return document


def as_stream(value) -> "object":
    import io
    if isinstance(value, bytes):
        return io.BytesIO(value)
    return io.BytesIO(json.dumps(value).encode("utf-8"))


class HostPayloadCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-host-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def environment(self):
        """The child's environment, with no configuration of this machine's.

        The command is run as a program, so it inherits whatever this machine
        has exported. A FLEET_CONFIG naming a file here would be read by the
        case below that takes its limit from the configuration, and the limit
        would be somebody else's.
        """
        return sandbox.home_environment(self.root)

    def read(self, value, max_bytes=1048576):
        return host.read_statusline(as_stream(value), max_bytes=max_bytes)

    def test_a_real_payload_reads_field_by_field(self):
        document = self.read(payload())
        self.assertEqual(document["state"], "ready")
        self.assertEqual(document["session"]["id"], "abc123")
        self.assertEqual(document["session"]["name"], "statusline")
        self.assertEqual(document["model"]["displayName"], "Opus 4.6 (1M context)")
        self.assertEqual(document["cost"]["totalCostUsd"], 1.25)
        self.assertEqual(document["cost"]["linesRemoved"], 7)
        self.assertEqual(document["context"]["inputTokens"], 902437)
        self.assertEqual(document["context"]["windowSize"], 1000000)
        self.assertEqual(document["context"]["remainingPercent"], 9.7)
        self.assertEqual(document["context"]["currentUsage"],
                         {"cacheReadTokens": 880000, "cacheCreationTokens": 20000})
        self.assertEqual(document["rateLimits"]["fiveHour"],
                         {"usedPercent": 41.5, "resetsAt": 1790000000})
        self.assertEqual(document["rateLimits"]["sevenDay"]["usedPercent"], 12)
        self.assertEqual(document["promptCache"], {"warm": True, "hit_ratio": 0.93})
        self.assertEqual(document["absent"], [])

    def test_the_token_count_is_read_rather_than_reconstructed(self):
        # The payload says 902437. Deriving it from the percentage would give
        # 903000, and a figure nobody measured does not belong on the line.
        document = self.read(payload())
        self.assertEqual(document["context"]["inputTokens"], 902437)
        self.assertNotEqual(document["context"]["inputTokens"],
                            document["context"]["windowSize"] * 10 // 100)

    def test_a_field_the_host_did_not_send_is_named_absent_not_zeroed(self):
        document = payload()
        del document["context_window"]["context_window_size"]
        del document["rate_limits"]["spend_limit"]
        del document["cost"]["total_cost_usd"]
        read = self.read(document)
        self.assertEqual(read["state"], "ready")
        self.assertIn("context.windowSize", read["absent"])
        self.assertIn("rateLimits.spendLimit", read["absent"])
        self.assertIn("cost.totalCostUsd", read["absent"])
        self.assertNotIn("windowSize", read["context"])
        self.assertNotIn("totalCostUsd", read["cost"])

    def test_a_field_with_the_wrong_type_is_absent_rather_than_coerced(self):
        document = payload()
        document["context_window"]["total_input_tokens"] = "902437"
        document["cost"]["total_cost_usd"] = None
        document["model"]["display_name"] = 7
        read = self.read(document)
        self.assertIn("context.inputTokens", read["absent"])
        self.assertIn("cost.totalCostUsd", read["absent"])
        self.assertIn("model.displayName", read["absent"])
        self.assertEqual(read["model"]["id"], "claude-opus-4-6[1m]")

    def test_a_boolean_is_not_a_number(self):
        document = payload()
        document["cost"]["total_cost_usd"] = True
        read = self.read(document)
        self.assertIn("cost.totalCostUsd", read["absent"])

    def test_an_empty_stream_is_empty_rather_than_failed(self):
        for value in (b"", b"\n", b"   \n"):
            read = self.read(value)
            self.assertEqual(read["state"], "empty", value)
            self.assertNotIn("reason", read)

    def test_a_document_that_is_not_an_object_is_failed(self):
        for value in ([1, 2], "text", 7, None, True):
            read = self.read(value)
            self.assertEqual(read["state"], "failed", value)
            self.assertEqual(read["reason"], "the payload is not an object")

    def test_bytes_that_are_not_json_are_failed_and_named_by_class(self):
        read = self.read(b'{"session_id": "abc"')
        self.assertEqual(read["state"], "failed")
        self.assertEqual(read["reason"], "JSONDecodeError")
        self.assertEqual(self.read(b"\xff\xfe\x00bad")["state"], "failed")

    def test_a_payload_over_the_limit_is_refused_rather_than_truncated(self):
        # One byte over is the whole point: a truncated payload parses, and the
        # fields missing from it would look like fields the host did not send.
        body = json.dumps(payload()).encode("utf-8")
        exact = self.read(body, max_bytes=len(body))
        self.assertEqual(exact["state"], "ready")
        over = self.read(body, max_bytes=len(body) - 1)
        self.assertEqual(over["state"], "failed")
        self.assertIn("exceeded", over["reason"])

    def test_a_limit_of_zero_is_refused_by_the_reader_itself(self):
        read = self.read(payload(), max_bytes=0)
        self.assertEqual(read["state"], "failed")
        self.assertIn("positive", read["reason"])

    def test_unknown_keys_are_ignored_rather_than_carried(self):
        document = payload()
        document["something_new"] = {"unexpected": True}
        read = self.read(document)
        self.assertEqual(read["state"], "ready")
        self.assertNotIn("something_new", read)

    def test_a_payload_with_nothing_this_layer_reads_is_ready_and_all_absent(self):
        read = self.read({"hostAddedThis": 1})
        self.assertEqual(read["state"], "ready")
        # Sorted once over every name: concatenating sorted runs is not sorted.
        every_name = sorted([name for _, _, name in host.NUMBER_PATHS]
                            + [name for _, name in host.TEXT_PATHS]
                            + [name for _, _, name in host.MODEL_PATHS]
                            + [name for _, _, name in host.LIMIT_PATHS]
                            + [name for _, name in host.PASSTHROUGH])
        self.assertEqual(sorted(read["absent"]), every_name)

    def test_the_command_reads_stdin_and_says_what_it_found(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "payload.json"
            target.write_text(json.dumps(payload()))
            result = subprocess.run([sys.executable, str(SCRIPT), "--pretty"],
                                    stdin=target.open("rb"), capture_output=True, text=True,
                                    env=self.environment())
            self.assertEqual(result.returncode, 0, result.stderr)
            document = json.loads(result.stdout)
            self.assertEqual(document["state"], "ready")
            self.assertEqual(document["session"]["id"], "abc123")

    def test_the_command_exits_nonzero_when_the_host_sent_nothing(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input="",
                                capture_output=True, text=True, env=self.environment())
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "empty")

    def test_the_command_takes_its_limit_from_the_configuration(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload()),
                                capture_output=True, text=True, env=self.environment())
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual(document["state"], "ready")
        self.assertLess(document["bytes"], 1048576)

    def test_a_configuration_holding_an_error_is_reported_rather_than_guessed(self):
        with tempfile.TemporaryDirectory() as temporary:
            document = Path(temporary) / "config.json"
            document.write_text(json.dumps({"limits": {"hostPayloadBytes": 0}}))
            result = subprocess.run([sys.executable, str(SCRIPT), "--config", str(document)],
                                    input=json.dumps(payload()), capture_output=True, text=True,
                                    env=self.environment())
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertIn("configErrors", result.stdout)

    def test_the_command_refuses_a_payload_over_its_own_limit(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--max-bytes", "40"],
                                input=json.dumps(payload()),
                                capture_output=True, text=True, env=self.environment())
        self.assertEqual(result.returncode, 1, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual(document["state"], "failed")
        self.assertIn("exceeded", document["reason"])


if __name__ == "__main__":
    unittest.main()
