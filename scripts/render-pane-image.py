#!/usr/bin/env python3
"""Draw the README's picture of the pane from the picture of the pane.

The README showed a picture of an old release for months, because the image was
an upload to a release and the link named that release: raising the version left
the front page showing a pane from before the change. The image is drawn from
`plugins/llm-fleet/assets/pane-example.svg` and committed beside it now, so what
the README shows is what this tree carries, and nothing has to be uploaded.

`--check` compares the sidecar beside the image against the SVG it was drawn
from, which is what `make quality` runs: it needs no renderer, so a runner
without one still refuses a picture that has fallen behind its source. Drawing
needs `rsvg-convert`; without it the script says so and draws nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "plugins" / "llm-fleet" / "assets"
SOURCE_NAME = "pane-example.svg"
IMAGE_NAME = "pane-example.png"
SIDECAR_NAME = "pane-example.source"
WIDTH = 1000


def digest(assets: Path = ASSETS) -> str:
    """The SVG's hash with line endings normalized.

    A Windows checkout writes CRLF where the image was drawn from LF, so
    hashing the bytes on disk compared two different files. The Windows runner
    called the committed image stale for that reason alone.
    """
    text = (assets / SOURCE_NAME).read_bytes()
    return hashlib.sha256(text.replace(b"\r\n", b"\n")).hexdigest()


def sidecar_text(assets: Path = ASSETS) -> str:
    """What the sidecar holds: the hash of the SVG this image was drawn from."""
    return digest(assets) + "\n"


def where(assets: Path, name: str) -> str:
    return str(Path(name)) if assets == ASSETS else "{0}/{1}".format(assets.name, name)


def problems(assets: Path = ASSETS) -> list[str]:
    """Why the committed image is not the picture of the committed SVG."""
    source = assets / SOURCE_NAME
    image = assets / IMAGE_NAME
    sidecar = assets / SIDECAR_NAME
    if not source.is_file():
        return ["{0} is missing".format(where(assets, SOURCE_NAME))]
    if not image.is_file():
        return ["{0} is missing; run make pane-image".format(where(assets, IMAGE_NAME))]
    if not sidecar.is_file():
        return ["{0} is missing; run make pane-image".format(where(assets, SIDECAR_NAME))]
    if sidecar.read_text(encoding="utf-8").strip() != digest(assets):
        return ["{0} was drawn from another version of the SVG; run make pane-image".format(
            where(assets, IMAGE_NAME))]
    return []


def draw(assets: Path = ASSETS) -> int:
    source = assets / SOURCE_NAME
    image = assets / IMAGE_NAME
    sidecar = assets / SIDECAR_NAME
    tool = shutil.which("rsvg-convert")
    if tool is None:
        sys.stderr.write("Unavailable: rsvg-convert is not on PATH, so the image was not drawn.\n"
                         "The committed image and its sidecar are unchanged.\n")
        return 2
    drawn = subprocess.run([tool, "-w", str(WIDTH), "-o", str(image), str(source)],
                           capture_output=True, text=True)
    if drawn.returncode != 0:
        sys.stderr.write("rsvg-convert refused the SVG:\n{0}\n".format(drawn.stderr[-2000:]))
        return 1
    sidecar.write_text(sidecar_text(assets), encoding="utf-8")
    sys.stdout.write("Drew {0} and recorded its source in {1}\n".format(
        where(assets, IMAGE_NAME), where(assets, SIDECAR_NAME)))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Draw the README's pane image from its SVG")
    parser.add_argument("--check", action="store_true",
                        help="refuse an image that is not the picture of the committed SVG")
    parser.add_argument("--assets", type=Path, default=ASSETS,
                        help="the folder holding the SVG, its image and its sidecar")
    args = parser.parse_args(argv)
    if not args.check:
        return draw(args.assets)
    found = problems(args.assets)
    for line in found:
        sys.stderr.write(line + "\n")
    if not found:
        sys.stdout.write("The pane image is drawn from the committed SVG.\n")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
