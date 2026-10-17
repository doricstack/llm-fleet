#!/usr/bin/env python3
"""Draw the statusline lines from a host payload, so they can be looked at.

The statusline command runs inside a session and writes to the host's line, which
is a poor place to review a change. This reads a payload the way the command does,
sums the transcript the same way, and prints the lines to a terminal or a page.

The payload is either recorded from a real session (`--payload`) or built here in
the shape a real one has. The output says which, because a preview drawn from a
made-up payload is a drawing of the idea and not of the session.

Run with: python3 scripts/statusline-demo.py [--payload payload.json] [--width 120]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# The plugin's modules import one another from the plugin root, which is the
# folder an install copies, so that root is what goes on the import path.
PLUGIN = ROOT / "plugins" / "fleet"
if str(PLUGIN) not in sys.path:
    sys.path.insert(0, str(PLUGIN))

from config.loader import ConfigError, load_config  # noqa: E402
from readers.host import read_statusline  # noqa: E402
from readers.transcript import read_transcript  # noqa: E402

RUNNER = ROOT / "components" / "statusline-run.ts"

# A payload in the shape the host sends, taken from a recorded one. The session
# name, the paths and the cost are invented; the field names and their nesting
# are not.
SAMPLE = {
    "session_id": "sample-session",
    "session_name": "llm-fleet",
    "cwd": "$HOME/Projects/apps/llm-fleet-private",
    "version": "2.1.105",
    "model": {"id": "claude-opus-4-6[1m]", "display_name": "Opus 4.6 (1M context)"},
    "cost": {"total_cost_usd": 12.5, "total_duration_ms": 7_200_000,
             "total_api_duration_ms": 900_000},
    "context_window": {"total_input_tokens": 902_437, "total_output_tokens": 5_120,
                       "remaining_percentage": 9.7, "context_window_size": 1_000_000,
                       "current_usage": {"cache_read_input_tokens": 880_000,
                                         "cache_creation_input_tokens": 20_000}},
    "rate_limits": {"five_hour": {"used_percentage": 41.5},
                    "seven_day": {"used_percentage": 12}},
    "effort": {"level": "high"},
    "thinking": {"enabled": True},
    "prompt_cache": {"warm": True, "hit_ratio": 0.93},
}


def branch_of(directory: Path) -> str | None:
    """The branch of a checkout, read through one bounded command."""
    try:
        result = subprocess.run(["git", "-C", str(directory), "rev-parse",
                                 "--abbrev-ref", "HEAD"],
                                capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return None
    name = result.stdout.strip()
    return name if result.returncode == 0 and name and name != "HEAD" else None


def project_of(cwd: str | None) -> str | None:
    if not cwd:
        return None
    name = Path(cwd).expanduser().name
    return name or None


# A transcript in the shape the host writes: one assistant record per line, each
# with its own usage block. The tokens are invented; the shape is not.
SAMPLE_TRANSCRIPT = [
    {"type": "assistant", "message": {"usage": {"input_tokens": 1_500,
                                                "cache_creation_input_tokens": 20_000,
                                                "cache_read_input_tokens": 880_000}}},
    {"type": "assistant", "message": {"usage": {"input_tokens": 700,
                                                "cache_creation_input_tokens": 0,
                                                "cache_read_input_tokens": 900_000}}},
]


def sample_transcript(directory: Path) -> str:
    """Write the sample transcript and return where it is."""
    path = directory / "statusline-sample.jsonl"
    path.write_text("\n".join(json.dumps(record) for record in SAMPLE_TRANSCRIPT) + "\n",
                    encoding="utf-8")
    return str(path)


def transcript_path(payload: dict, home: Path) -> str | None:
    named = payload.get("transcript_path")
    if isinstance(named, str) and named:
        return named
    session = payload.get("session_id")
    cwd = payload.get("cwd")
    if not isinstance(session, str) or not isinstance(cwd, str):
        return None
    # The host slugs a working directory by replacing every run of characters
    # that is not alphanumeric with one dash, which is not the same as replacing
    # the separators.
    slug = "".join(char if char.isalnum() else "-" for char in cwd)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return str(home / ".claude" / "projects" / slug / (session + ".jsonl"))


def render(request: dict, width: int) -> list[str]:
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps(request),
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise SystemExit("the render failed: " + result.stderr.strip())
    return result.stdout.rstrip("\n").split("\n")


def build_request(config: dict, payload: bytes, recorded: bool,
                  home: Path, width: int, sample: Path) -> tuple[dict, bool]:
    """The request the renderer takes, and whether the payload was recorded."""
    from io import BytesIO
    document = read_statusline(BytesIO(payload), max_bytes=config["limits"]["hostPayloadBytes"])
    raw = json.loads(payload.decode("utf-8")) if payload.strip() else {}
    limit = config["limits"]["hostPayloadBytes"]
    prices = config["sources"]["agents"]
    source = transcript_path(raw, home) if recorded and raw else sample_transcript(sample)
    economics = read_transcript(source,
                                max_bytes=max(limit, 8 * 1024 * 1024),
                                model_id=(raw.get("model") or {}).get("id"), prices=prices)
    cwd = (raw.get("cwd") or "") if raw else ""
    request = {"host": document, "transcript": economics, "width": width,
               "project": project_of(cwd) if recorded else "llm-fleet-private",
               "branch": branch_of(Path(cwd).expanduser()) if recorded and cwd
               else "task/statusline-core"}
    return request, recorded


def main() -> int:
    parser = argparse.ArgumentParser(description="Draw the statusline lines")
    parser.add_argument("--payload", default=None,
                        help="a payload recorded from a real session; the sample is used without it")
    parser.add_argument("--config", default=None)
    parser.add_argument("--width", type=int, default=120)
    parser.add_argument("--home", default=None)
    parser.add_argument("--json", action="store_true", help="print the request instead of the lines")
    parser.add_argument("--scratch", default=None,
                        help="where a sample transcript may be written")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        print("The configuration was refused:", file=sys.stderr)
        for entry in refusal.errors:
            print("  " + entry["code"] + " " + entry["path"], file=sys.stderr)
        return 2
    if args.payload:
        payload = Path(args.payload).expanduser().read_bytes()
    else:
        payload = json.dumps(SAMPLE).encode("utf-8")
    home = Path(args.home).expanduser() if args.home else Path.home()
    scratch = Path(args.scratch).expanduser() if args.scratch else Path(
        tempfile.mkdtemp(prefix="statusline-sample-"))
    request, recorded = build_request(config, payload, args.payload is not None, home,
                                      args.width, scratch)
    if args.json:
        print(json.dumps(request, indent=2))
        return 0
    source = ("a payload recorded from a real session" if recorded
              else "built-in samples: the payload in the shape the host sends, and a "
                   "transcript in the shape it writes, with invented values")
    print(f"# statusline preview, {source}; width {args.width}")
    for line in render(request, args.width):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
