"""The environment a case hands the loader, with every root inside its own tree.

A case that set only `HOME` left the reader tests reading and writing the
machine's real state folder on a Windows runner. The contract resolves the
state folder from the first variable that names a place, and Windows sets no
`HOME` for the loader to find: the real `LOCALAPPDATA` answered instead, so
`roster.json` landed in the runner user's own profile and two roster cases drew
whatever an earlier case had left there. They passed or failed by the order
they ran in, and passed here because a Mac sets no `LOCALAPPDATA` at all.

The names come from the contract rather than from a list kept here, so a
variable the loader learns to read is one this helper is told about. One it has
no place for is refused rather than left pointing at the machine.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import paths  # noqa: F401  (puts the plugin root on the path)


SCHEMA = paths.PLUGIN / "config" / "schema.json"

# Where each variable points under a case's own root. The shape is the platform
# the variable belongs to, not the one the case runs on: a Windows runner reads
# LOCALAPPDATA whatever the suite was written on.
PLACES = {
    "HOME": (),
    "XDG_CONFIG_HOME": (".config",),
    "XDG_STATE_HOME": (".local", "state"),
    "XDG_CACHE_HOME": (".cache",),
    "XDG_DATA_HOME": (".local", "share"),
    "LOCALAPPDATA": ("AppData", "Local"),
    "APPDATA": ("AppData", "Roaming"),
}

# The configuration file is named directly by the selector and by the legacy
# override, so a developer who has set either one would have every case read
# their own machine. Both are removed rather than pointed anywhere.
SELECTOR_VARIABLES = ("FLEET_CONFIG", "FLEET_STATE_DIR")


def contract_variables() -> list[str]:
    """Every environment variable the configuration contract reads."""
    document = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return list(document["environment"]["variables"])


def home_environment(root: Path, **extra: str) -> dict[str, str]:
    """This machine's environment with every home and state root under `root`.

    `extra` is applied last, so a case may name a variable of its own without
    losing the sandbox. A variable the contract reads and this module cannot
    place raises rather than passing through, because passing it through is the
    leak this exists to close.
    """
    unknown = sorted(name for name in contract_variables() if name not in PLACES)
    if unknown:
        raise AssertionError(
            "the configuration contract reads {0}; give each a place under the case's own root in "
            "tests/sandbox.py".format(", ".join(unknown)))
    home = root / "user"
    environment = dict(os.environ)
    for name, parts in PLACES.items():
        environment[name] = str(home.joinpath(*parts)) if parts else str(home)
    for name in SELECTOR_VARIABLES:
        environment.pop(name, None)
    environment.update(extra)
    return environment
