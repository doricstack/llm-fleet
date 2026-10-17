#!/usr/bin/env python3
"""Write a review page for the pane, so a change can be read before it ships.

The pane has no terminal to draw in yet, so the way to look at it is to read the
machine for real, render the layout's own tree as text, and put that text on a
page a person can open and argue with. This script is that pipeline:

    read the machine  ->  render the tree  ->  write a page

It writes where you tell it and prints the path. Nothing here reads a value the
layout did not already decide; the only choice it makes is what to hide, and it
hides by pattern so a figure that looks like an account identifier, a location
identifier or a login does not travel into a file that outlives the session.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
READER = ROOT / "plugins" / "fleet" / "readers" / "snapshot.py"
RENDERER = ROOT / "components" / "review.ts"
DEFAULT_OUT = Path.home() / "Desktop" / "fleet-review"
# Below this the pane has no room for a title and a right-hand slot on one row.
MINIMUM_COLUMNS = 40

# Shapes that identify an account or a credential. The pane masks the fields it
# prints, so finding one of these in the rendered text means the masker missed a
# field: this is the check that says so, not a second masker. Hiding it here
# would erase the evidence that the pane let it through.
LEAK_SHAPES = (
    ("an organization identifier", re.compile(r"\borg_[A-Za-z0-9]+\b", re.IGNORECASE)),
    ("a location identifier", re.compile(r"\bloc_[A-Za-z0-9]+\b", re.IGNORECASE)),
    # Upper case with a value: "mid-turn" is a word, not a merchant identifier.
    ("a merchant identifier", re.compile(r"\bMID\b[\s:=#-]*\d{4,}")),
    ("an account number", re.compile(r"\b(?:account|acct|card|pan)\b[\s:=#-]*\d{6,}",
                                     re.IGNORECASE)),
    ("a sign-in", re.compile(r"\b(?:login|password|passwd|pwd)\s+(?=\S*\d)\S{6,}",
                             re.IGNORECASE)),
    ("key material", re.compile(r"\b(?:token|secret|api[_-]?key|access[_-]?key)[:=]\s*\S{8,}",
                                re.IGNORECASE)),
    ("a key prefix", re.compile(r"\bsk-(?:proj-|ant-|live_)[A-Za-z0-9_-]{8,}")),
    ("a github token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}")),
    ("an aws key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("a private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("a credentialed url", re.compile(r"://[^\s/:]+:[^\s/@]+@")),
)


def leaked(text: str) -> list[str]:
    """The shapes the pane should have masked and did not, named not repeated."""
    return [name for name, pattern in LEAK_SHAPES if pattern.search(text)]


def read_machine(config: str | None, now: float | None, timeout: float,
                 width: int) -> tuple[dict, str]:
    """Run the readers once and return the snapshot and the rendered pane."""
    command = [sys.executable, str(READER)]
    if config:
        command += ["--config", config]
    if now is not None:
        command += ["--now", str(now)]
    completed = subprocess.run(command, capture_output=True, text=True, check=False,
                               timeout=timeout)
    if completed.returncode != 0:
        return json.loads(completed.stdout or "{}"), ""
    snapshot = json.loads(completed.stdout)
    rendered = subprocess.run(["node", str(RENDERER), str(width)], input=completed.stdout,
                              capture_output=True, text=True, check=False, timeout=timeout,
                              cwd=str(ROOT))
    if rendered.returncode != 0:
        return snapshot, ""
    return snapshot, rendered.stdout


def draw_vectors(snapshot: dict, width: int, timeout: float) -> list[dict] | None:
    """The drawings a desktop would put in the pane, or None when the renderer failed.

    The same tree the text is rendered from, so a bar on the page is the bar the
    text draws as glyphs: the desktop draws these where a terminal draws cells.
    """
    rendered = subprocess.run(["node", str(RENDERER), str(width), "--vectors"],
                              input=json.dumps(snapshot), capture_output=True, text=True,
                              check=False, timeout=timeout, cwd=str(ROOT))
    if rendered.returncode != 0:
        return None
    try:
        drawn = json.loads(rendered.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(drawn, list):
        return None
    vectors = []
    for entry in drawn:
        if (not isinstance(entry, dict) or not isinstance(entry.get("source"), str)
                or not isinstance(entry.get("alt"), str)):
            return None
        vectors.append(entry)
    return vectors


def vector_text(vectors: list[dict]) -> str:
    """Every word a drawing carries, for the same leak check the text passes."""
    return "\n".join(entry["alt"] + "\n" + entry["source"] for entry in vectors)


def vector_plates(vectors: list[dict]) -> str:
    """Each drawing as an isolated image, the way the desktop draws one, in light and dark.

    An image cannot run anything it holds, and the colors are the drawing's own:
    it carries its dark palette in a color-scheme block, and each plate sets the
    scheme it is drawn under.
    """
    if not vectors:
        return '<p class="note">The pane drew no vector at this reading.</p>'
    plates = []
    for scheme in ("light", "dark"):
        images = []
        for entry in vectors:
            data = base64.b64encode(entry["source"].encode("utf-8")).decode("ascii")
            cells = entry.get("cells")
            width = int(cells) * 10 if isinstance(cells, (int, float)) and cells > 0 else None
            sized = ' width="{0}"'.format(width) if width else ""
            images.append('<figure><img src="data:image/svg+xml;base64,{0}" alt="{1}"{2}>'
                          '<figcaption>{1}</figcaption></figure>'.format(
                              data, html.escape(entry["alt"], quote=True), sized))
        plates.append('<div class="vectors {0}"><div class="eyebrow">{0}</div>{1}</div>'.format(
            scheme, "".join(images)))
    return "".join(plates)


def counts(snapshot: dict) -> list[tuple[str, str]]:
    """One line per source: its state and how many rows it brought back."""
    rows: list[tuple[str, str]] = []
    for name in ("roster", "trials", "progress", "prs", "skills", "worktrees"):
        document = snapshot.get(name)
        if not isinstance(document, dict):
            rows.append((name, "no document"))
            continue
        state = str(document.get("state", "unknown"))
        detail = ""
        for key in ("jobs", "running", "runs", "prs", "items", "worktrees"):
            value = document.get(key)
            if isinstance(value, list):
                detail = "{0} rows".format(len(value))
                break
        errors = document.get("errors") or []
        if errors:
            detail += (" | " if detail else "") + "{0} error(s)".format(len(errors))
        rows.append((name, state + (" | " + detail if detail else "")))
    # Each section a person added runs its own command, so each answers for itself.
    custom = snapshot.get("custom")
    sections = custom.get("sections") if isinstance(custom, dict) else None
    for key, section in (sections or {}).items():
        if not isinstance(section, dict):
            rows.append(("custom:" + str(key), "no document"))
            continue
        line = "{0} | {1} rows".format(section.get("state", "unknown"),
                                       len(section.get("rows") or []))
        errors = section.get("errors") or []
        if errors:
            line += " | {0} error(s)".format(len(errors))
        rows.append(("custom:" + str(key), line))
    return rows


def page(snapshot: dict, pane_text: str, width: int, generated: str,
         vectors: list[dict] | None = None) -> str:
    state_rows = "\n".join(
        '      <tr><td class="k">{0}</td><td>{1}</td></tr>'.format(html.escape(name),
                                                                  html.escape(detail))
        for name, detail in counts(snapshot))
    note = ("<p class=\"note\">Every field a person wrote was masked by the pane's masker "
            "before it was rendered, and this page was written only because none of the "
            "shapes that identify an account or a credential survived it.</p>")
    return """<title>Fleet pane review</title>
<style>
  :root {{
    --bg: #f6f6f4; --plate: #fff; --fg: #16181b; --muted: #5d6167; --rule: #e0e0dc;
    --accent: #1f5673; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    color-scheme: light;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --bg: #101214; --plate: #16191c; --fg: #e7e7e4; --muted: #9aa0a6; --rule: #2a2e33;
      --accent: #74a9c9; color-scheme: dark;
    }}
  }}
  :root[data-theme="dark"] {{
    --bg: #101214; --plate: #16191c; --fg: #e7e7e4; --muted: #9aa0a6; --rule: #2a2e33;
    --accent: #74a9c9; color-scheme: dark;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--fg); padding-inline: 20px;
         padding-block: 32px 64px; line-height: 1.6;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }}
  .wrap {{ max-width: 1020px; margin: 0 auto; display: flex; flex-direction: column; gap: 26px; }}
  h1 {{ font-size: clamp(24px, 4vw, 32px); margin: 4px 0 6px; }}
  h2 {{ font-size: 17px; margin: 0 0 10px; }}
  .eyebrow, .k {{ font-family: var(--mono); font-size: 12px; }}
  .eyebrow {{ letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }}
  .note {{ color: var(--muted); font-size: 14px; }}
  .plate {{ background: var(--plate); border: 1px solid var(--rule); border-radius: 6px;
            overflow: hidden; }}
  .scroll {{ overflow-x: auto; }}
  pre {{ margin: 0; padding: 14px; font-family: var(--mono); font-size: 12.5px;
         line-height: 1.5; white-space: pre; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 14px; }}
  td {{ text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--rule); }}
  td.k {{ color: var(--muted); width: 9rem; }}
  .vectors {{ padding: 14px; display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; }}
  .vectors.light {{ background: #ffffff; color: #16181b; color-scheme: light; }}
  .vectors.dark {{ background: #16191c; color: #e7e7e4; color-scheme: dark; }}
  .vectors .eyebrow {{ width: 100%; }}
  figure {{ margin: 0; display: flex; flex-direction: column; gap: 4px; max-width: 100%; }}
  figure img {{ max-width: 100%; height: auto; }}
  figcaption {{ font-size: 11px; opacity: 0.7; max-width: 22rem; }}
</style>
<div class="wrap">
  <header>
    <div class="eyebrow">llm-fleet-private &middot; pane review</div>
    <h1>Your machine, read by the extracted readers</h1>
    <p class="note">Read at {generated}, width {width}. This is the layout tree rendered as
    text: no terminal or desktop is mounting it yet.</p>
    {note}
  </header>
  <section>
    <h2>What each source answered</h2>
    <table>
{state_rows}
    </table>
  </section>
  <section>
    <h2>The pane</h2>
    <div class="plate"><div class="scroll"><pre>{pane}</pre></div></div>
  </section>
  <section>
    <h2>The desktop's drawings</h2>
    <p class="note">What a surface that draws vectors puts where the text has glyphs: each
    bar, strip and tile, with the alt text a screen reader hears.</p>
    <div class="plate">{vectors}</div>
  </section>
</div>
""".format(generated=html.escape(generated), width=width, note=note, state_rows=state_rows,
           pane=html.escape(pane_text.rstrip("\n")), vectors=vector_plates(vectors or []))


def terminal_width(fallback: int) -> int:
    """The columns of the terminal this is being printed into.

    A pane drawn for a file can be any width; one drawn for a terminal that is
    narrower than the request comes back wrapped and unreadable. When the caller
    names no width, the terminal's own is the honest answer, and a width that is
    not a terminal's is not guessed at.
    """
    try:
        columns = shutil.get_terminal_size(fallback=(fallback, 24)).columns
    except OSError:
        return fallback
    return columns if columns >= MINIMUM_COLUMNS else fallback


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read the machine, render the pane, and write a review page")
    parser.add_argument("--config", default=None)
    parser.add_argument("--out", default=None, help="a file or directory to write to")
    parser.add_argument("--print", dest="to_terminal", action="store_true",
                        help="write the pane to standard output and no file")
    parser.add_argument("--width", type=int, default=100,
                        help="the columns to draw into; the terminal's own width when printing")
    parser.add_argument("--print-width", type=int, default=None, dest="print_width",
                        help=argparse.SUPPRESS)
    parser.add_argument("--now", type=float, default=None)
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    if args.to_terminal and args.print_width is None:
        args.width = terminal_width(args.width)
    snapshot, pane_text = read_machine(args.config, args.now, args.timeout, args.width)
    if not pane_text:
        sys.stderr.write("the read or the render failed; nothing was written\n")
        return 1
    vectors: list[dict] = []
    if not args.to_terminal:
        drawn = draw_vectors(snapshot, args.width, args.timeout)
        if drawn is None:
            sys.stderr.write("the drawings could not be rendered; nothing was written\n")
            return 1
        vectors = drawn
    remaining = leaked(pane_text + "\n" + vector_text(vectors))
    if remaining:
        # Named, never repeated: the value that leaked is the value not to print.
        sys.stderr.write("the pane printed {0} unmasked; nothing was written\n".format(
            ", ".join(remaining)))
        return 1
    if args.to_terminal:
        sys.stdout.write(pane_text.rstrip("\n") + "\n")
        return 0
    destination = Path(args.out).expanduser() if args.out else DEFAULT_OUT
    if destination.suffix in (".html", ".htm"):
        target = destination
    else:
        target = destination / "pane.html"
    target.parent.mkdir(parents=True, exist_ok=True)
    generated = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(snapshot.get("generated_at")
                                                                  or time.time()))
    target.write_text(page(snapshot, pane_text, args.width, generated, vectors),
                      encoding="utf-8")
    (target.parent / "pane.txt").write_text(pane_text + "\n", encoding="utf-8")
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
