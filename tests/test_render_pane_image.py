"""The README's picture is redrawn from the SVG, and the tree refuses a stale one.

The check exists because the front page showed 0.4.22 for months: the image was
an upload on a release, the link named that release, and nothing failed when the
version moved. These cases drive the script that replaced it through real files
in a temporary folder and a stub renderer on the path.
"""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "render-pane-image.py"


def load():
    spec = importlib.util.spec_from_file_location("render_pane_image", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


RENDER = load()
STUB = ("#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  case $1 in -o) shift; out=$1;; esac\n"
        "  shift\ndone\nprintf png > \"$out\"\n")


def assets(base: Path) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    (base / "pane-example.svg").write_bytes(b"<svg>one</svg>\n")
    return base


class Problems(unittest.TestCase):
    """What the check says about a folder whose image and SVG disagree."""

    def test_a_missing_image_is_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            found = RENDER.problems(assets(Path(tmp)))
        self.assertEqual(len(found), 1)
        self.assertIn("run make pane-image", found[0])

    def test_a_missing_sidecar_is_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = assets(Path(tmp))
            (folder / "pane-example.png").write_bytes(b"png")
            found = RENDER.problems(folder)
        self.assertEqual(len(found), 1)
        self.assertIn("pane-example.source", found[0])

    def test_a_sidecar_from_another_version_is_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = assets(Path(tmp))
            (folder / "pane-example.png").write_bytes(b"png")
            (folder / "pane-example.source").write_text("0" * 64 + "\n", encoding="utf-8")
            found = RENDER.problems(folder)
        self.assertIn("another version of the SVG", found[0])

    def test_a_sidecar_that_matches_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = assets(Path(tmp))
            (folder / "pane-example.png").write_bytes(b"png")
            (folder / "pane-example.source").write_text(RENDER.sidecar_text(folder),
                                                        encoding="utf-8")
            self.assertEqual(RENDER.problems(folder), [])
            self.assertEqual(
                RENDER.sidecar_text(folder).strip(),
                RENDER.digest(folder))


class Drawing(unittest.TestCase):
    """What the script does with and without a renderer."""

    def test_no_renderer_leaves_the_tree_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = assets(Path(tmp))
            code = subprocess.run([sys.executable, str(SCRIPT), "--assets", str(folder)],
                                  env={"PATH": tmp, "HOME": tmp},
                                  capture_output=True, text=True).returncode
            self.assertFalse((folder / "pane-example.png").exists())
        self.assertEqual(code, 2)

    @unittest.skipIf(
        os.name == "nt",
        "rsvg-convert is a POSIX tool and the stub is a shell script; Windows has no renderer, "
        "and test_no_renderer_leaves_the_tree_alone covers that path",
    )
    def test_a_renderer_writes_the_image_and_its_source_hash(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tools:
            folder = assets(Path(tmp))
            stub = Path(tools) / "rsvg-convert"
            stub.write_text(STUB, encoding="utf-8")
            stub.chmod(0o755)
            code = subprocess.run([sys.executable, str(SCRIPT), "--assets", str(folder)],
                                  env={"PATH": tools, "HOME": tools},
                                  capture_output=True, text=True).returncode
            self.assertEqual(code, 0)
            self.assertEqual((folder / "pane-example.png").read_bytes(), b"png")
            self.assertEqual(
                (folder / "pane-example.source").read_text(encoding="utf-8").strip(),
                RENDER.digest(folder))


class ExitCode(unittest.TestCase):
    """The check is what the quality gate reads."""

    def test_a_stale_folder_exits_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = assets(Path(tmp))
            (folder / "pane-example.png").write_bytes(b"png")
            (folder / "pane-example.source").write_text("0" * 64 + "\n", encoding="utf-8")
            code = subprocess.run([sys.executable, str(SCRIPT), "--check", "--assets", str(folder)],
                                  capture_output=True, text=True).returncode
        self.assertEqual(code, 1)

    def test_the_committed_tree_passes(self):
        code = subprocess.run([sys.executable, str(SCRIPT), "--check"],
                              capture_output=True, text=True).returncode
        self.assertEqual(code, 0)


class CheckoutLineEndings(unittest.TestCase):
    """A Windows checkout writes CRLF, and the image was drawn from LF.

    Hashing the file as it sits on disk made the check pass on macOS and fail
    on the Windows runner, which reported the committed image as drawn from
    another version of the SVG.
    """

    def test_a_crlf_checkout_hashes_the_same_as_an_lf_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            lf = assets(Path(tmp) / "lf")
            crlf = assets(Path(tmp) / "crlf")
            (crlf / "pane-example.svg").write_bytes(
                (lf / "pane-example.svg").read_bytes().replace(b"\n", b"\r\n"))
            self.assertEqual(RENDER.digest(crlf), RENDER.digest(lf))

    def test_a_sidecar_from_the_lf_source_is_accepted_after_a_crlf_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            lf = assets(Path(tmp) / "lf")
            folder = assets(Path(tmp) / "drawn")
            (folder / "pane-example.svg").write_bytes(
                (lf / "pane-example.svg").read_bytes().replace(b"\n", b"\r\n"))
            (folder / "pane-example.png").write_bytes(b"png")
            (folder / "pane-example.source").write_text(RENDER.sidecar_text(lf))
            self.assertEqual(RENDER.problems(folder), [])


if __name__ == "__main__":
    unittest.main()
