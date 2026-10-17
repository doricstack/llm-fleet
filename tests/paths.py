"""Where the suites find this repository and the plugin they test.

The plugin folder is what an install copies, so its modules import one another
as `config.loader` and `readers.<name>` from the plugin root, never through the
repository. A suite puts that root on the import path once, here, rather than
each computing its own, so a move of the plugin is one edit and not twenty.
"""

from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "fleet"

if str(PLUGIN) not in sys.path:
    sys.path.insert(0, str(PLUGIN))
