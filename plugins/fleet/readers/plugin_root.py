"""Put the plugin root on the import path for a reader started by path.

The plugin starts its readers as `python3 <plugin root>/readers/<name>.py`, so
the reader's own directory is on the import path and the plugin root is not. A
reader started that way imports this module first, as a sibling, and then
imports `config.loader` and `readers.<name>` from the root it put there.

An install copies the plugin folder and nothing beside it, so the root is the
plugin folder itself: one level above this module, never more. This is the one
module the boundary check lets touch the import path or climb more than a
single level, which is why every reader goes through it.
"""

from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
