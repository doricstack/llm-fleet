#!/usr/bin/env python3
"""An example custom section: how full each disk the session writes to is.

Name it under `pane.custom` and the pane draws one row per disk, with a bar of
the space used against the disk's size. It prints the shape every custom
section prints: a summary and a list of rows, each with a title and, where it
has them, a detail, a slot, and the two figures a bar is drawn from.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile

GIB = 1024 ** 3
# A disk this full is drawn as needing a look.
WARN_AT = 0.9


def places() -> dict[str, str]:
    """The folders worth watching, by the name a row is drawn with."""
    return {"home": os.path.expanduser("~"), "temp": tempfile.gettempdir()}


def main() -> int:
    rows = []
    seen: set[int] = set()
    for name, path in places().items():
        try:
            device = os.stat(path).st_dev
            usage = shutil.disk_usage(path)
        except OSError:
            continue
        # Two folders on one disk are one disk: draw it once.
        if device in seen or usage.total <= 0:
            continue
        seen.add(device)
        used = usage.total - usage.free
        rows.append({
            "title": name,
            "state": "waiting" if used / usage.total >= WARN_AT else None,
            "detail": path,
            "slot": "{0} GiB free".format(usage.free // GIB),
            "done": used // GIB,
            "total": usage.total // GIB,
        })
    print(json.dumps({"summary": "{0} disk{1}".format(len(rows), "" if len(rows) == 1 else "s"),
                      "rows": rows}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
