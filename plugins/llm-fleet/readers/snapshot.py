#!/usr/bin/env python3
"""The read: run every reader once and print what the machine answered.

This is the command a view layer calls. It resolves the configuration, asks each
reader for its document, and prints one JSON object. Two rules hold it together:

- a reader that raises does not remove its document. The slot is filled with a
  failed source that names the reason, because a missing key reads downstream as
  a source nobody asked about, and a source that failed is not the same thing;
- the documents keep the reader's own shape, unrepaired. Nothing here renames a
  field or fills a value the reader chose not to publish, so what a view model
  sees is exactly what was read.

Read-only by design: every reader opens files, runs a bounded command, or queries
a store it does not write.
"""

from __future__ import annotations

import argparse
import inspect
import json
from pathlib import Path
import sys
import time
from typing import Any, Callable, Mapping

if __package__ in (None, ""):
    import plugin_root  # noqa: F401  (puts the plugin root on the import path)

from config.loader import ConfigError, load_config
from readers.custom import read_custom
from readers.events import read_events
from readers.load import read_load
from readers.prs import read_prs
from readers.progress import read_progress
from readers.roster import keep_job_states, load_job_states, read_providers
from readers.session import read_session
from readers.skills import read_skills
from readers.governance import read_governance
from readers.trials import read_trials
from readers.worktrees import read_worktrees

READERS: dict[str, Callable[..., dict[str, Any]]] = {
    "roster": read_providers,
    "trials": read_trials,
    "progress": read_progress,
    "prs": read_prs,
    "skills": read_skills,
    "worktrees": read_worktrees,
    "load": read_load,
    "session": read_session,
    "custom": read_custom,
    "governance": read_governance,
}


def failed(document: str, reason: str) -> dict[str, Any]:
    """The document a reader would have produced had it been able to report this."""
    state_keys = {"roster": "jobs", "trials": "running", "progress": "runs", "prs": "prs",
                  "skills": "items", "worktrees": "worktrees", "load": "processes",
                  "session": "parameters", "custom": "sections", "events": "events",
                  "governance": "scopes"}
    body: dict[str, Any] = {"state": "failed", state_keys[document]: [],
                            "errors": [{"source": document, "reason": reason}]}
    if document == "roster":
        body.update({"interactive": {}, "providers": {}, "spend_series": None,
                     "sources": {"jobs": "failed", "interactive": "failed"}})
    elif document == "trials":
        body["history"] = None
    elif document == "skills":
        body.update({"generated_at": None, "counts": {}, "new": [], "running": None})
    elif document == "worktrees":
        body["cleaned"] = None
    elif document == "custom":
        body["sections"] = {}
    return body


def _accepted(reader: Callable[..., dict[str, Any]]) -> frozenset[str]:
    """The keyword arguments a reader declares, read off its own signature."""
    return frozenset(inspect.signature(reader).parameters)


def pane_document(config: Mapping[str, Any]) -> dict[str, Any]:
    """The pane's own configuration, resolved, for the view layer that draws it.

    The pane draws inside a plugin with no configuration file of its own to read,
    so the choices that decide what it shows travel with the reading: which
    sections there are, in what order, and how each one starts. This is the only
    path by which a person's edited `pane.sections` reaches the pane, so a
    setting omitted here is a setting the pane cannot honour.

    Only what the pane acts on travels. The width itself stays in the
    configuration document, because the pane is given the one the surface
    reports; the reserve and the floor travel with it, because they are how the
    surface arrives at that width and a pane that ignored them would draw at a
    width the configuration did not ask for. A section's title and legend, the
    keys the pane honours, and the ceiling on the rows a section may take are
    carried for the same reason: they were left behind once and arrived at a
    section that had nothing to draw, or at one that drew past its own limit.
    """
    pane = config.get("pane") or {}
    order = pane.get("sectionOrder") or []
    sections = pane.get("sections") or {}
    keys = config.get("keys") or {}
    theme = config.get("theme") or {}
    return {
        "state": "ready",
        "order": [name for name in order],
        "sections": {
            name: {"title": body.get("title"),
                   "visible": bool(body.get("visible", True)),
                   "collapsed": bool(body.get("collapsed", False)),
                   "legend": body.get("legend"),
                   "hideWhenEmpty": bool(body.get("hideWhenEmpty", False)),
                   "maxRows": body.get("maxRows")}
            for name, body in sections.items()
        },
        "geometry": {
            "minimumColumns": pane.get("minimumColumns"),
            "horizontalReserve": pane.get("horizontalReserve"),
            "progressCells": pane.get("progressCells"),
            "skillRows": pane.get("skillRows"),
            "fanLines": pane.get("fanLines"),
        },
        # How many replies the pane remembers, so a job answered from it is not
        # offered the field again while it still reads as waiting.
        "repliedLimit": pane.get("repliedLimit"),
        # The longest reply sent.
        "replyMaxChars": pane.get("replyMaxChars"),
        # How long a reply recorded as on its way waits before its row says it
        # may not have been sent and offers to send again.
        "replyPendingSeconds": pane.get("replyPendingSeconds"),
        # The tones states are drawn in, and the tone each worktree state takes;
        # the band draws in them too.
        "theme": {
            "failure": theme.get("failure"),
            "waiting": theme.get("waiting"),
            "working": theme.get("working"),
            "idle": theme.get("idle"),
            "worktrees": dict(theme.get("worktrees") or {}),
        },
        "keys": {
            "tipsEnabled": bool(keys.get("tipsEnabled", True)),
            "tips": [str(tip) for tip in (keys.get("tips") or [])],
            "close": keys.get("close"),
            "collapse": keys.get("collapse"),
            "expand": keys.get("expand"),
        },
    }


def alerts_document(config: Mapping[str, Any]) -> dict[str, Any]:
    """How the plugin raises what is new, resolved, for the hooks that raise it.

    Like the pane's own document, this travels with the reading because the
    plugin has no configuration file of its own to read: whether a focused
    session shows a toast and for how long, whether one session per machine
    raises a native notification, how often the machine is read for news, and
    how long a line may take to synthesize before the voice gives up on it.
    """
    alerts = config.get("alerts") or {}
    refresh = config.get("refresh") or {}
    timeouts = config.get("timeouts") or {}
    tint = alerts.get("tabTint") or {}
    return {
        "state": "ready",
        "toast": bool(alerts.get("toast", True)),
        "notify": bool(alerts.get("notify", True)),
        "toastMs": alerts.get("toastMs"),
        # How long the toast that says a press copied something stays up.
        "copyToastMs": alerts.get("copyToastMs"),
        "snapshotMs": refresh.get("snapshotMs"),
        # How old the reading every session shares may get before one session
        # reads the machine again, and how old a live run's counts may get
        # while a pane shows them.
        "snapshotSeconds": (config.get("cache") or {}).get("snapshotSeconds"),
        "progressMs": refresh.get("progressMs"),
        # How often an open pane is drawn so its ages count, and how far apart
        # the sections a new reading changed land on it.
        "clockMs": refresh.get("clockMs"),
        "streamStepMs": refresh.get("streamStepMs"),
        "synthesisMs": timeouts.get("synthesisMs"),
        # Whether the plugin tells the tab helper its level, how often it says
        # it again, and how long the helper may take. The colors are the
        # helper's, which reads the configuration itself.
        "tabTint": {
            "enabled": bool(tint.get("enabled", True)),
            "staleSeconds": tint.get("staleSeconds"),
        },
        "tabCommandMs": timeouts.get("tabCommandMs"),
        # How often the key tip after the prompt hint moves on while a draft is typed.
        "keyTipMs": refresh.get("keyTipMs"),
        # How long the plugin lets a read of the whole machine run, and the
        # slower one that probes every worktree now.
        "helperMs": timeouts.get("helperMs"),
        "worktreeHelperMs": timeouts.get("worktreeHelperMs"),
    }


def band_document(config: Mapping[str, Any]) -> dict[str, Any]:
    """What the band above the prompt shows and keeps, resolved, for the band.

    The band draws inside the plugin as the pane does, with no configuration
    file of its own, so these reach it only with the reading: how long after a
    job blocked it still leads the band rather than waiting in the pane, and how
    many dismissed items are kept.
    """
    band = config.get("band") or {}
    return {
        "state": "ready",
        "hiddenLimit": band.get("hiddenLimit"),
        "waitingJobSeconds": band.get("waitingJobSeconds"),
    }


def read_snapshot(config: Mapping[str, Any], *, now: float | None = None,
                  home: Path | None = None, only: list[str] | None = None,
                  refresh_worktrees: bool = False, settings: bool = False,
                  session_id: str = "", model: str = "") -> dict[str, Any]:
    """Every reader's document, keyed by its source, with a failure kept in place.

    `only` names the sources to read, and no other reader runs: the pane asks
    for the governor's counts every few seconds while a run is live, and a read
    of everything that often would ask the pull request host and every worktree
    each time. Such a read carries no pane or alert configuration either; it is
    a part of a reading, merged into the whole one the caller holds.

    `refresh_worktrees` has the worktree reader probe every worktree now rather
    than answer from its cache: `/worktrees` asks for it, because a person who
    asks for the worktrees is asking how they stand now.

    `settings` prints the configuration's parts alone, with no reader run. A
    session that has never held a reading does not know how long its own read
    may take, since that time travels in the reading; this answer is quick, so it
    learns the time before a slow source can make the first read run past it.
    """
    clock = float(now) if now is not None else time.time()
    snapshot: dict[str, Any] = {"generated_at": clock}
    if only is None:
        snapshot["pane"] = pane_document(config)
        snapshot["alerts"] = alerts_document(config)
        snapshot["band"] = band_document(config)
    if settings:
        return snapshot
    for name, reader in READERS.items():
        if only is not None and name not in only:
            continue
        try:
            # Each reader is handed what it takes rather than what this command
            # assumes every reader takes. A reader with no clock in its work, or
            # none of it reading the filesystem a home shortens, was being handed
            # both and failing on the argument it never wanted, which leaves its
            # slot reading as a source that broke rather than one nobody asked.
            accepted = _accepted(reader)
            extra: dict[str, Any] = {}
            if "now" in accepted:
                extra["now"] = clock
            if "home" in accepted:
                # The skill reader is the one that shortens a displayed path
                # against a home; the rest read the environment they were
                # started with.
                extra["home"] = home
            if refresh_worktrees and name == "worktrees" and "refresh" in accepted:
                extra["refresh"] = True
            if "session_id" in accepted:
                # The session reader prices a routed session from the file the
                # status line keeps for that session, so it needs to know which
                # session it is being drawn for.
                extra["session_id"] = session_id
            if "model" in accepted:
                extra["model"] = model
            kept: dict[str, Any] | None = None
            if "previous" in accepted:
                # The roster dates each job from when it entered its state, and
                # only an earlier read knows that. This command is a new process
                # every time, so what that read saw is kept in the state
                # directory; without it every job would date from this read.
                kept = load_job_states(config, clock)
                extra["previous"] = kept
            snapshot[name] = reader(config, **extra)
            if kept is not None and not keep_job_states(config, snapshot[name], kept, clock):
                snapshot[name].setdefault("errors", []).append(
                    {"source": "jobs", "reason": "job states were not kept"})
        except Exception as caught:  # a reader may never take a source off the pane
            snapshot[name] = failed(name, "{0}: {1}".format(type(caught).__name__, caught))
    if only is None:
        # The digest's events are drawn from the documents just read, so only a
        # whole reading carries them: a part merged into a held reading would
        # hand the digest one source's events as if they were every source's.
        try:
            snapshot["events"] = read_events(snapshot, config)
        except Exception as caught:  # the digest may never take the reading down
            snapshot["events"] = failed("events",
                                        "{0}: {1}".format(type(caught).__name__, caught))
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run every reader once and print the snapshot")
    parser.add_argument("--config", default=None,
                        help="the configuration document; the declared default is used without it")
    parser.add_argument("--home", default=None,
                        help="the directory a displayed path is shortened against")
    parser.add_argument("--now", type=float, default=None,
                        help="the clock to read against, for a reproducible run")
    parser.add_argument("--pretty", action="store_true", help="indent the output")
    parser.add_argument("--only", action="append", choices=sorted(READERS), default=None,
                        help="read this source alone; repeat for more")
    parser.add_argument("--refresh-worktrees", action="store_true",
                        help="probe every worktree now rather than answer from the cache")
    parser.add_argument("--settings", action="store_true",
                        help="print the configuration's parts alone and run no reader")
    parser.add_argument("--session", default="", help="this session's identifier")
    parser.add_argument("--model", default="", help="the model this session runs")
    args = parser.parse_args(argv)
    if args.settings and (args.only is not None or args.refresh_worktrees):
        parser.error("--settings runs no reader, so it takes neither --only nor --refresh-worktrees")
    try:
        config = load_config(args.config)
    except ConfigError as refusal:
        # A refused configuration is a result, not a crash: the caller can show
        # every error it holds.
        json.dump({"configErrors": refusal.errors}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2
    except Exception as caught:
        json.dump({"configErrors": [{"code": "E_CONFIG_LOAD",
                                     "path": "",
                                     "detail": "{0}: {1}".format(type(caught).__name__, caught)}]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2
    home = Path(args.home).expanduser() if args.home else Path.home()
    snapshot = read_snapshot(config, now=args.now, home=home, only=args.only,
                             refresh_worktrees=args.refresh_worktrees, settings=args.settings,
                             session_id=args.session, model=args.model)
    json.dump(snapshot, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
