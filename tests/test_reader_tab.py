#!/usr/bin/env python3
"""The tab color helper: the record sessions share, the escape, and where it goes.

Sessions in one tab each say their level to the helper, and the helper keeps
one record per tab, read, merged, painted and written under one lock. The cases
are the helper's own contract: the iTerm escape for a color and for the tab's
own, wrapped for tmux with every escape doubled; the highest live level painted
and only when the tab is not painted it already; a record it cannot read
leaving everything as it was; two processes racing on one tab with real files
and a real lock; a real write to a real terminal device, including from a
helper started in a session of its own; nothing written where the path is not
that terminal; and words it does not take answered with exit 2.
"""

import contextlib
import io
import json
import os
import random
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import paths

PLUGIN = paths.PLUGIN

from readers import alerts as alerts_module
from readers import tab

HELPER = Path(tab.__file__)
NOW = 1_790_000_000.0
RED = (220, 50, 47)
AMBER = (255, 176, 0)
TINT = {"enabled": True, "failureRgb": list(RED), "waitingRgb": list(AMBER), "staleSeconds": 120}
POSIX_TERMINALS = hasattr(os, "openpty") and sys.platform != "win32"


def make_link(case, link, target, directory=False):
    """Make `link` point at `target`, or skip the case where this platform will not."""
    try:
        os.symlink(target, link, target_is_directory=directory)
    except (OSError, NotImplementedError) as refused:
        case.skipTest("this platform will not create a link here: {0}".format(refused))
NO_PTY = "pseudo-terminals are POSIX; the tab color is iTerm's, which is macOS"
UID = os.getuid() if hasattr(os, "getuid") else 0


class SequenceTests(unittest.TestCase):
    def test_a_color_is_one_escape_per_channel(self):
        self.assertEqual(tab.sequence((220, 50, 47), False),
                         b"\x1b]6;1;bg;red;brightness;220\x07"
                         b"\x1b]6;1;bg;green;brightness;50\x07"
                         b"\x1b]6;1;bg;blue;brightness;47\x07")

    def test_the_tab_s_own_color_is_the_default_escape(self):
        self.assertEqual(tab.sequence(None, False), b"\x1b]6;1;bg;*;default\x07")

    def test_tmux_gets_its_own_wrapper_with_every_escape_doubled(self):
        # tmux hands a sequence to the terminal around it only inside its own
        # device control string; an escape left single inside would end it.
        self.assertEqual(tab.sequence(None, True),
                         b"\x1bPtmux;\x1b\x1b]6;1;bg;*;default\x07\x1b\\")
        wrapped = tab.sequence((1, 2, 3), True)
        self.assertTrue(wrapped.startswith(b"\x1bPtmux;"))
        self.assertTrue(wrapped.endswith(b"\x1b\\"))
        inner = wrapped[len(b"\x1bPtmux;"):-len(b"\x1b\\")]
        self.assertEqual(inner.replace(b"\x1b\x1b", b"\x1b"), tab.sequence((1, 2, 3), False))
        self.assertNotIn(b"\x1b]", inner.replace(b"\x1b\x1b", b""))


@unittest.skipIf(sys.platform == "win32", "Windows has no terminal devices or user ids to walk")
class ParentDeviceTests(unittest.TestCase):
    """The walk up the parents, each answer as ps gives it: parent, real user, terminal, device number."""

    def test_the_nearest_parent_with_a_terminal_names_it_and_its_device_number(self):
        chain = {300: (200, UID, "??", None), 200: (100, UID, "?", None),
                 100: (1, UID, "ttys004", 4242)}
        self.assertEqual(tab.parent_device(300, chain.get), (("/dev/ttys004", 4242), ""))

    def test_a_linux_pseudo_terminal_is_a_device_under_pts(self):
        found, _ = tab.parent_device(5, {5: (1, UID, "pts/3", 34819)}.get)
        self.assertEqual(found, ("/dev/pts/3", 34819))

    def test_no_terminal_up_to_the_first_process_is_none(self):
        chain = {300: (200, UID, "??", None), 200: (1, UID, "??", None)}
        found, reason = tab.parent_device(300, chain.get)
        self.assertIsNone(found)
        self.assertIn("no process", reason)

    def test_a_name_that_is_not_a_device_is_refused(self):
        for name in ("../etc/passwd", "ttys004/../../x", "/dev/ttys004", "a b"):
            found, reason = tab.parent_device(9, {9: (1, UID, name, 1)}.get)
            self.assertIsNone(found, name)
            self.assertIn("not a device name", reason)

    def test_a_ps_that_cannot_answer_is_none(self):
        found, reason = tab.parent_device(9, lambda pid: None)
        self.assertIsNone(found)
        self.assertIn("ps", reason)

    def test_a_parent_another_user_runs_stops_the_walk(self):
        # A process another user runs is no part of this person's session, and
        # nothing it started or has open is this helper's to write to.
        chain = {300: (200, UID, "??", None), 200: (1, UID + 1, "ttys004", 4242)}
        found, reason = tab.parent_device(300, chain.get)
        self.assertIsNone(found)
        self.assertIn("another user", reason)

    def test_a_terminal_whose_device_number_is_unknown_is_refused(self):
        found, reason = tab.parent_device(9, {9: (1, UID, "ttys004", None)}.get)
        self.assertIsNone(found)
        self.assertIn("device number", reason)

    def test_a_platform_with_no_user_ids_walks_nowhere(self):
        with mock.patch.object(tab, "_user", return_value=None):
            found, reason = tab.parent_device(9, {9: (1, UID, "ttys004", 4242)}.get)
        self.assertIsNone(found)
        self.assertIn("no terminal devices", reason)

    def test_a_chain_that_loops_stops(self):
        calls = []

        def looping(pid):
            calls.append(pid)
            return (pid + 1, UID, "??", None)

        self.assertIsNone(tab.parent_device(10, looping)[0])
        self.assertEqual(len(calls), tab.PARENT_HOPS)
        self.assertIsNone(tab.parent_device(10, lambda pid: (pid, UID, "??", None))[0])

    def test_the_walk_starts_at_the_parent_after_the_controlling_terminal(self):
        asked = []

        def ps(pid):
            asked.append(pid)
            return (1, UID, "ttys004", 4242)

        found, reason = tab.terminals(ps, lambda: 4321)
        self.assertEqual(asked, [4321])
        self.assertEqual(found, [("/dev/tty", None), ("/dev/ttys004", 4242)])
        self.assertEqual(reason, "")
        found, reason = tab.terminals(lambda pid: None, lambda: 4321)
        self.assertEqual(found, [("/dev/tty", None)])
        self.assertIn("ps", reason)


class ProcessParseTests(unittest.TestCase):
    """What ps and /proc print, read without raising whatever they print."""

    STAT = "4242 (tmux: client (a b)) c) S 1 4242 4242 34819 4242 4194560 0 0"

    def test_a_proc_stat_line_with_a_command_holding_spaces_and_parentheses_is_read(self):
        self.assertEqual(tab.parse_proc_stat(self.STAT), 34819)

    def test_a_proc_stat_line_that_is_not_one_refuses_cleanly(self):
        for text in ("", "4242 tmux S 1 2 3 34819", "4242 (x) S 1 2 3", "4242 (x) S 1 2 3 -1 5",
                     "4242 (x) S 1 2 3 abc 5", "4242 (x) S 1 2 3 0 5", "4242 (x) S 1 2 3 ² 5",
                     "4242 (x)", ")" * 40, "4242 (x) S 1 2 3 99999999999999999999999 5"):
            with self.subTest(text=text):
                self.assertIsNone(tab.parse_proc_stat(text))

    def test_a_bsd_device_number_is_major_slash_minor_and_anything_else_is_none(self):
        self.assertEqual(tab.parse_ps_device("16/5"), os.makedev(16, 5) if hasattr(os, "makedev")
                         else None)
        for text in ("", "??", "16/5/7", "/5", "16/", "x/y", "²/1",
                     "99999999999999999999/1", "9999999999999999999/1", "-1/5"):
            with self.subTest(text=text):
                self.assertIsNone(tab.parse_ps_device(text))

    def test_linux_ps_and_proc_together_name_the_parent_user_terminal_and_device(self):
        answer = tab._ps(4242, run=lambda pid, fields: ["1", "501", "pts/3"],
                         read_stat=lambda pid: self.STAT, linux=True)
        self.assertEqual(answer, (1, 501, "pts/3", 34819))

    def test_bsd_ps_names_the_device_in_its_own_column(self):
        answer = tab._ps(5, run=lambda pid, fields: ["1", "501", "16/5", "ttys005"],
                         read_stat=lambda pid: None, linux=False)
        self.assertEqual(answer[:3], (1, 501, "ttys005"))
        self.assertEqual(answer[3], tab.parse_ps_device("16/5"))
        self.assertEqual(tab._ps(5, run=lambda pid, fields: ["1", "501", "??", "??"],
                                 read_stat=lambda pid: None, linux=False), (1, 501, "??", None))

    def test_ps_output_that_is_not_a_process_refuses_cleanly(self):
        for parts in (None, [], ["1"], ["x", "501", "pts/3"], ["1", "²", "pts/3"],
                      ["-1", "501", "pts/3"]):
            for linux in (True, False):
                with self.subTest(parts=parts, linux=linux):
                    self.assertIsNone(tab._ps(9, run=lambda pid, fields: parts,
                                              read_stat=lambda pid: self.STAT, linux=linux))

    def test_a_process_gone_between_ps_and_proc_has_no_device_number(self):
        answer = tab._ps(9, run=lambda pid, fields: ["1", "501", "pts/3"],
                         read_stat=lambda pid: None, linux=True)
        self.assertEqual(answer, (1, 501, "pts/3", None))

    @unittest.skipIf(sys.platform == "win32", "Windows has no terminal devices or user ids to walk")
    def test_a_process_gone_mid_walk_ends_the_walk_with_a_reason(self):
        chain = {300: (200, UID, "??", None)}
        found, reason = tab.parent_device(300, chain.get)
        self.assertIsNone(found)
        self.assertIn("process 200", reason)


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-tab-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def pty_pair(self):
        """A real pseudo-terminal owned by this user: its other end, its path, its device number."""
        master, slave = os.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        return master, os.ttyname(slave), os.fstat(slave).st_rdev

    def test_a_path_that_is_not_a_character_device_is_not_written(self):
        plain = self.root / "not-a-terminal"
        plain.write_bytes(b"")
        for device in (None, 7):
            written, reason = tab.write(b"\x1b]6;1;bg;*;default\x07", [(str(plain), device)])
            self.assertFalse(written)
            self.assertIn("not a character device", reason)
        self.assertEqual(plain.read_bytes(), b"")

    def test_a_path_that_does_not_open_is_passed_over_and_named(self):
        written, reason = tab.write(b"x", [(str(self.root / "missing"), 7)])
        self.assertFalse(written)
        self.assertIn("did not open", reason)

    @unittest.skipUnless(POSIX_TERMINALS and os.path.exists("/dev/null"), NO_PTY)
    def test_a_character_device_that_is_not_a_terminal_is_not_written(self):
        written, reason = tab.write(b"x", [("/dev/null", None)])
        self.assertFalse(written)
        self.assertIn("not a terminal", reason)

    @unittest.skipUnless(POSIX_TERMINALS and os.path.exists("/dev/null") and UID != 0,
                         "needs a device another user owns; root owns them all")
    def test_a_found_device_another_user_owns_is_not_written(self):
        device = os.stat("/dev/null").st_rdev
        written, reason = tab.write(b"x", [("/dev/null", device)])
        self.assertFalse(written)
        self.assertIn("owned by another user", reason)

    @unittest.skipUnless(POSIX_TERMINALS, NO_PTY)
    def test_a_found_terminal_this_user_owns_is_written(self):
        master, path, device = self.pty_pair()
        written, reason = tab.write(tab.sequence(None, False), [(path, device)])
        self.assertEqual((written, reason), (True, ""))
        self.assertEqual(os.read(master, 1024), tab.sequence(None, False))

    @unittest.skipUnless(POSIX_TERMINALS, NO_PTY)
    def test_a_terminal_that_is_not_the_parent_s_is_not_written(self):
        # The name ps printed opened a terminal this user owns, but not the one
        # the parent runs on: a name is not proof, the device number is.
        master, path, device = self.pty_pair()
        written, reason = tab.write(b"x", [(path, device + 1)])
        self.assertFalse(written)
        self.assertIn("not the terminal", reason)
        ready, _, _ = select.select([master], [], [], 0.2)
        self.assertEqual(ready, [])

    @unittest.skipUnless(POSIX_TERMINALS, NO_PTY)
    def test_a_link_to_a_terminal_is_not_followed(self):
        master, path, device = self.pty_pair()
        link = self.root / "terminal-link"
        link.symlink_to(path)
        written, reason = tab.write(b"x", [(str(link), device)])
        self.assertFalse(written)
        self.assertIn("did not open", reason)
        ready, _, _ = select.select([master], [], [], 0.2)
        self.assertEqual(ready, [])

    @unittest.skipUnless(POSIX_TERMINALS and hasattr(os, "mkfifo"), NO_PTY)
    def test_a_path_nobody_reads_is_refused_rather_than_waited_on(self):
        # A pipe with no reader holds an open for writing until one comes; the
        # helper must answer at once rather than hang the plugin's process run.
        pipe = self.root / "pipe"
        os.mkfifo(pipe)
        answer = []
        worker = threading.Thread(target=lambda: answer.append(tab.write(b"x", [(str(pipe), 7)])),
                                  daemon=True)
        worker.start()
        worker.join(5)
        self.assertEqual(len(answer), 1, "the open waited on a pipe nobody reads")
        written, reason = answer[0]
        self.assertFalse(written)
        self.assertIn("did not open", reason)

    def test_every_terminal_is_opened_to_write_only_never_as_this_process_s_own(self):
        # The flags themselves, on every platform: a terminal opened without
        # O_NOCTTY can become the controlling terminal of a helper that has
        # none, and the behavior that shows it is Linux's alone.
        asked = []

        def opener(path, flags):
            asked.append((path, flags))
            raise OSError(13, "refused by the case")

        written, reason = tab.write(b"x", [("/dev/tty", None), ("/dev/ttys004", 4242)], opener)
        self.assertFalse(written)
        self.assertEqual([path for path, _ in asked], ["/dev/tty", "/dev/ttys004"])
        for _, flags in asked:
            self.assertEqual(flags & (os.O_WRONLY | os.O_RDWR), os.O_WRONLY)
            for name in ("O_NOCTTY", "O_NONBLOCK", "O_NOFOLLOW"):
                if hasattr(os, name):
                    self.assertTrue(flags & getattr(os, name), name)

    @unittest.skipUnless(POSIX_TERMINALS, NO_PTY)
    def test_a_terminal_written_is_never_taken_as_the_writer_s_own(self):
        # A session leader with no terminal, as the helper is when the host runs
        # it in a session of its own, takes the first terminal it opens as its
        # controlling one unless the open says not to (Linux does; macOS never
        # does). Whether the open made it so is read back from /dev/tty.
        script = (
            "import os, sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "from readers import tab\n"
            "master, slave = os.openpty()\n"
            "path = os.ttyname(slave)\n"
            "device = os.fstat(slave).st_rdev\n"
            "os.close(slave)\n"
            "print(tab.write(b'x', [(path, device)])[0])\n"
            "try:\n"
            "    os.close(os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY))\n"
            "    print('controlling')\n"
            "except OSError:\n"
            "    print('none')\n"
        )
        ran = subprocess.run([sys.executable, "-c", script, str(PLUGIN)],
                             capture_output=True, text=True, check=False, start_new_session=True,
                             stdin=subprocess.DEVNULL, timeout=30)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(ran.stdout.split(), ["True", "none"])


class Painter:
    """A terminal that keeps what it was asked to paint, and fails while told to."""

    def __init__(self):
        self.painted = []
        self.fails = False

    def __call__(self, color):
        self.painted.append(None if color is None else tuple(color))
        return (False, "the case refused the write") if self.fails else (True, "")


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-tab-record-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.state = self.root / "state"
        self.paint = Painter()

    def update(self, session, level, now=NOW, tint=None, record_only=False, tab_id="tab-1"):
        return tab.update(self.state, tab_id, session, level, now, tint or TINT, self.paint,
                          record_only)

    def record(self, tab_id="tab-1"):
        return json.loads(tab.record_path(self.state, tab_id).read_text())

    def test_two_sessions_in_one_tab_keep_each_other_s_level_and_clear_only_when_both_have(self):
        self.assertEqual(self.update("a", "failed"), (0, ""))
        self.assertEqual(self.paint.painted, [RED])
        # A wait is lower than the failure the tab shows: nothing is repainted.
        self.assertEqual(self.update("b", "waiting", NOW + 1), (0, ""))
        self.assertEqual(self.paint.painted, [RED])
        self.assertEqual(sorted(self.record()["entries"]), ["a", "b"])
        # The failure clears: the tab shows the wait the other session holds.
        self.assertEqual(self.update("a", "none", NOW + 2), (0, ""))
        self.assertEqual(self.paint.painted, [RED, AMBER])
        # The last one ends: nobody holds a level, the tab gets its own color.
        self.assertEqual(tab.end(self.state, "tab-1", "b", NOW + 3, TINT, self.paint), (0, ""))
        self.assertEqual(self.paint.painted, [RED, AMBER, None])
        self.assertFalse(tab.record_path(self.state, "tab-1").exists())

    def test_a_session_ending_leaves_the_level_another_still_holds(self):
        self.update("a", "failed")
        self.update("b", "failed", NOW + 1)
        tab.end(self.state, "tab-1", "a", NOW + 2, TINT, self.paint)
        self.assertEqual(self.paint.painted, [RED])
        self.assertEqual(list(self.record()["entries"]), ["b"])

    def test_an_entry_past_the_staleness_holds_nothing_and_is_dropped(self):
        self.update("ghost", "failed")
        # Said again by the other session past the ghost's staleness: the
        # ghost's failure no longer holds the tab, and its entry goes.
        self.update("b", "waiting", NOW + 120)
        self.assertEqual(self.paint.painted, [RED, AMBER])
        self.assertEqual(list(self.record()["entries"]), ["b"])
        # One dated far ahead of this clock counts for nothing either.
        self.update("ahead", "failed", NOW + 1000)
        self.update("b", "waiting", NOW + 121)
        self.assertEqual(list(self.record()["entries"]), ["b"])

    def test_the_staleness_and_the_colors_are_the_configuration_s(self):
        tint = {**TINT, "staleSeconds": 30, "failureRgb": [1, 2, 3]}
        self.update("ghost", "failed", tint=tint)
        self.update("b", "none", NOW + 29, tint=tint)
        self.assertEqual(self.paint.painted, [(1, 2, 3)])
        self.update("b", "none", NOW + 30, tint=tint)
        self.assertEqual(self.paint.painted, [(1, 2, 3), None])

    def test_a_tint_switched_off_gives_the_tab_its_own_color(self):
        self.update("a", "failed")
        self.update("a", "failed", NOW + 1, tint={**TINT, "enabled": False})
        self.assertEqual(self.paint.painted, [RED, None])

    def test_a_failed_paint_leaves_the_tab_unknown_so_the_next_call_paints_again(self):
        self.paint.fails = True
        code, reason = self.update("a", "failed")
        self.assertEqual(code, 1)
        self.assertIn("refused", reason)
        self.assertEqual(self.record()["painted"], "unknown")
        # The entry stands though the paint failed: the level was said.
        self.assertEqual(list(self.record()["entries"]), ["a"])
        self.paint.fails = False
        self.assertEqual(self.update("a", "failed", NOW + 1), (0, ""))
        self.assertEqual(self.paint.painted, [RED, RED])
        # A tab whose color is unknown is restored on clear, never assumed own.
        self.paint.fails = True
        self.update("a", "none", NOW + 2)
        self.paint.fails = False
        tab.end(self.state, "tab-1", "a", NOW + 3, TINT, self.paint)
        self.assertEqual(self.paint.painted, [RED, RED, None, None])
        # Restored with nobody left: the record goes.
        self.assertFalse(tab.record_path(self.state, "tab-1").exists())

    def test_the_record_says_unknown_while_the_paint_is_out(self):
        seen = []

        def paint(color):
            seen.append(self.record())
            return True, ""

        self.assertEqual(tab.update(self.state, "tab-1", "a", "failed", NOW, TINT, paint), (0, ""))
        self.assertEqual(seen[0]["painted"], "unknown")
        self.assertEqual(list(seen[0]["entries"]), ["a"])
        self.assertEqual(self.record()["painted"], "220,50,47")

    def test_a_paint_that_lands_but_is_not_recorded_leaves_the_record_unknown(self):
        writes = []

        def flaky(tabs, name, record):
            writes.append(record["painted"])
            if len(writes) == 2:
                raise OSError(28, "No space left on device")
            tab.persist(tabs, name, record)

        code, reason = tab.update(self.state, "tab-1", "a", "failed", NOW, TINT, self.paint,
                                  persist=flaky)
        self.assertEqual(code, 1)
        self.assertIn("could not be written", reason)
        self.assertEqual(writes, ["unknown", "220,50,47"])
        self.assertEqual(self.record()["painted"], "unknown")
        # The next word on the tab sees it unknown and paints it again.
        self.assertEqual(self.update("a", "failed", NOW + 1), (0, ""))
        self.assertEqual(self.paint.painted, [RED, RED])
        self.assertEqual(self.record()["painted"], "220,50,47")

    def test_a_first_write_that_fails_paints_nothing(self):
        def refusing(tabs, name, record):
            raise OSError(13, "Permission denied")

        code, reason = tab.update(self.state, "tab-1", "a", "failed", NOW, TINT, self.paint,
                                  persist=refusing)
        self.assertEqual(code, 1)
        self.assertIn("could not be written", reason)
        self.assertEqual(self.paint.painted, [])

    def test_a_helper_killed_between_paint_and_record_leaves_the_tab_to_be_painted_again(self):
        killer = (
            "import os, sys\n"
            "from pathlib import Path\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "from readers import tab\n"
            "def paint(color):\n"
            "    os._exit(9)\n"
            "tint = {'enabled': True, 'failureRgb': [220, 50, 47], 'waitingRgb': [255, 176, 0],"
            " 'staleSeconds': 120}\n"
            "tab.update(Path(sys.argv[2]), 'tab-1', 'a', 'failed', 1790000000.0, tint, paint)\n"
        )
        ran = subprocess.run([sys.executable, "-c", killer, str(PLUGIN), str(self.state)],
                             capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(ran.returncode, 9, ran.stderr)
        self.assertEqual(self.record()["painted"], "unknown")
        self.assertEqual(list(self.record()["entries"]), ["a"])
        self.assertEqual(self.update("a", "failed", NOW + 1), (0, ""))
        self.assertEqual(self.paint.painted, [RED])

    def test_a_record_left_with_nobody_and_the_tab_s_own_color_is_removed(self):
        path = tab.record_path(self.state, "tab-1")
        self.update("a", "failed")
        self.assertTrue(path.exists())
        tab.end(self.state, "tab-1", "a", NOW + 1, TINT, self.paint)
        self.assertFalse(path.exists())
        # Nothing to say about a tab nobody holds writes no file at all.
        self.update("b", "none", NOW + 2)
        self.assertFalse(path.exists())

    def test_a_failure_whose_session_vanished_is_cleared_by_a_survivor_s_heartbeat(self):
        path = tab.record_path(self.state, "tab-1")
        self.update("gone", "failed")
        self.update("survivor", "none", NOW + 60)
        self.assertEqual(self.paint.painted, [RED])
        # Past the staleness the survivor's word at none prunes the failure,
        # restores the tab, and leaves nothing to keep.
        self.update("survivor", "none", NOW + 120)
        self.assertEqual(self.paint.painted, [RED, None])
        self.assertFalse(path.exists())

    def test_a_record_kept_for_a_level_is_not_removed(self):
        self.update("a", "waiting")
        self.update("b", "none", NOW + 1)
        self.assertEqual(list(self.record()["entries"]), ["a"])

    def test_record_only_keeps_the_entry_alive_and_paints_nothing(self):
        self.paint.fails = True
        self.update("a", "failed")
        self.paint.fails = False
        self.assertEqual(self.update("a", "failed", NOW + 50, record_only=True), (0, ""))
        self.assertEqual(self.paint.painted, [RED])
        self.assertEqual(self.record()["entries"]["a"]["at"], NOW + 50)
        self.assertEqual(self.record()["painted"], "unknown")

    def test_the_same_level_again_paints_nothing(self):
        self.update("a", "failed")
        self.update("a", "failed", NOW + 1)
        self.assertEqual(self.paint.painted, [RED])

    def test_a_record_that_does_not_parse_leaves_the_tab_and_the_file_alone(self):
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        for broken in (b"{not json", b"[]", b'{"entries": [], "painted": "own"}',
                       b'{"entries": {"a": {"level": "loud", "at": 1}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": [], "at": 1}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": {}, "at": 1}}, "painted": "own"}',
                       b'{"entries": {"a": "failed"}, "painted": "own"}',
                       b'{"entries": {"a": ["failed", 1]}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": "1"}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": true}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": NaN}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": Infinity}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed"}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": 1' + b'0' * 400 + b'}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": -1}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": 9007199254740993}}, "painted": "own"}',
                       b'{"entries": {"a": {"level": "failed", "at": 1e300}}, "painted": "own"}',
                       # Nested past the parser's depth, and small enough to be read.
                       b'[' * 5000 + b']' * 5000,
                       b'{"entries": {}, "painted": 7}'):
            with self.subTest(broken=broken):
                path.write_bytes(broken)
                code, reason = self.update("a", "failed")
                self.assertEqual(code, 3)
                self.assertIn("could not be read", reason)
                self.assertEqual(self.paint.painted, [])
                self.assertEqual(path.read_bytes(), broken)

    def test_a_record_the_parser_cannot_descend_leaves_the_tab_and_the_file_alone(self):
        # Whether a given nesting depth recurses differs between Python
        # versions, so the parser is made to give up the way a deep one does.
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        body = b'{"entries": {}, "painted": "own"}'
        path.write_bytes(body)
        with mock.patch.object(tab.json, "loads", side_effect=RecursionError("too deep")):
            code, reason = self.update("a", "failed")
        self.assertEqual(code, 3)
        self.assertIn("could not be read", reason)
        self.assertEqual(self.paint.painted, [])
        self.assertEqual(path.read_bytes(), body)

    def test_a_record_too_large_to_be_one_is_not_read(self):
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        body = json.dumps({"entries": {}, "painted": "own", "pad": "x" * tab.RECORD_BYTES})
        path.write_text(body)
        self.assertEqual(self.update("a", "failed")[0], 3)
        self.assertEqual(path.read_text(), body)
        self.assertEqual(self.paint.painted, [])

    @unittest.skipUnless(hasattr(os, "getuid") and UID != 0, "root reads every file")
    def test_a_record_that_cannot_be_read_leaves_the_tab_and_the_file_alone(self):
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        body = json.dumps({"entries": {}, "painted": "220,50,47"})
        path.write_text(body)
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        code, reason = self.update("a", "none")
        self.assertEqual(code, 3)
        self.assertIn("could not be read", reason)
        self.assertEqual(self.paint.painted, [])
        path.chmod(0o600)
        self.assertEqual(path.read_text(), body)

    def test_a_record_that_is_a_link_is_neither_read_nor_replaced(self):
        target = self.root / "elsewhere.json"
        body = json.dumps({"entries": {"x": {"level": "waiting", "at": NOW}}, "painted": "own"})
        target.write_text(body)
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        make_link(self, path, target)
        code, reason = self.update("a", "failed")
        self.assertEqual(code, 3)
        # Refused by name before any open, as Windows needs, not only by the open.
        self.assertIn("is a link", reason)
        self.assertEqual(self.paint.painted, [])
        self.assertEqual(target.read_text(), body)
        # Nor replaced, should one appear between the read and the write.
        with self.assertRaises(OSError):
            with alerts_module.private_directory(path.parent) as tabs:
                tab.persist(tabs, path.name, {"entries": {"a": {"level": "failed", "at": NOW}},
                                              "painted": "own"})
        self.assertTrue(os.path.islink(path))
        self.assertEqual(target.read_text(), body)

    def test_a_record_is_opened_to_read_only_never_through_a_link_and_never_waiting(self):
        asked = []

        def opener(path, flags, *rest, **at):
            asked.append(flags)
            raise FileNotFoundError(2, "No such file or directory")

        with alerts_module.private_directory(self.root / "tabs") as tabs:
            record, _ = tab.read_record(tabs, "missing.json", opener)
        self.assertEqual(record, {"entries": {}, "painted": "own"})
        self.assertEqual(asked[0] & (os.O_WRONLY | os.O_RDWR), 0)
        for name in ("O_NOFOLLOW", "O_NONBLOCK"):
            if hasattr(os, name):
                self.assertTrue(asked[0] & getattr(os, name), name)

    @unittest.skipUnless(hasattr(os, "getuid"), "owners are POSIX")
    def test_a_tabs_directory_another_user_owns_is_refused(self):
        self.update("a", "failed")
        with mock.patch.object(os, "getuid", return_value=UID + 1):
            code, reason = self.update("a", "waiting", NOW + 1)
        self.assertEqual(code, 3)
        self.assertIn("directory", reason)
        self.assertEqual(self.paint.painted, [RED])

    def test_a_state_directory_given_as_a_link_is_the_owner_s_own_and_tints(self):
        real = self.root / "real-state"
        real.mkdir()
        make_link(self, self.state, real, directory=True)
        self.assertEqual(self.update("a", "failed"), (0, ""))
        self.assertEqual(self.paint.painted, [RED])
        self.assertTrue(tab.record_path(real, "tab-1").is_file())
        self.assertTrue((real / tab.TABS / tab.TABS_LOCK).is_file())

    def test_a_tabs_link_beneath_a_linked_state_directory_is_still_refused(self):
        real = self.root / "real-state"
        real.mkdir()
        make_link(self, self.state, real, directory=True)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        make_link(self, real / tab.TABS, elsewhere, directory=True)
        code, reason = self.update("a", "failed")
        self.assertEqual(code, 3)
        self.assertIn("tabs is a link; remove the link", reason)
        self.assertEqual(self.paint.painted, [])
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_a_lock_that_is_a_link_is_refused_and_its_target_left_alone(self):
        (self.state / tab.TABS).mkdir(parents=True)
        target = self.root / "elsewhere.lock"
        target.write_text("kept")
        make_link(self, self.state / tab.TABS / tab.TABS_LOCK, target)
        code, reason = self.update("a", "failed")
        self.assertEqual(code, 3)
        self.assertIn("lock", reason)
        self.assertEqual(self.paint.painted, [])
        self.assertEqual(target.read_text(), "kept")

    def test_a_lock_that_is_not_a_regular_file_is_refused(self):
        (self.state / tab.TABS / tab.TABS_LOCK).mkdir(parents=True)
        self.assertEqual(self.update("a", "failed")[0], 3)
        self.assertEqual(self.paint.painted, [])

    def test_a_tabs_directory_that_is_a_link_is_refused_and_nothing_written_through_it(self):
        self.state.mkdir(parents=True)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        make_link(self, self.state / tab.TABS, elsewhere, directory=True)
        code, reason = self.update("a", "failed")
        self.assertEqual(code, 3)
        self.assertIn("tabs is a link; remove the link", reason)
        self.assertEqual(self.paint.painted, [])
        self.assertEqual(list(elsewhere.iterdir()), [])

    @unittest.skipUnless(alerts_module._directory_handles(), "files are reached by name on Windows")
    def test_a_tabs_folder_swapped_for_a_link_once_checked_is_never_walked_again(self):
        tabs = self.state / tab.TABS
        tabs.mkdir(parents=True, mode=0o700)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        swapped = []

        def swap(step):
            if step == "lock" and not swapped:
                tabs.rename(self.state / "tabs-real")
                os.symlink(elsewhere, tabs)
                swapped.append(step)

        with mock.patch.object(alerts_module, "_between", swap):
            self.assertEqual(self.update("a", "failed"), (0, ""))
        self.assertEqual(swapped, ["lock"])
        # The lock and the record land in the folder that was checked, never where the link leads.
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual(sorted(path.name for path in (self.state / "tabs-real").iterdir()),
                         sorted([tab.TABS_LOCK, tab.record_path(self.state, "tab-1").name]))

    @unittest.skipUnless(hasattr(os, "getuid"), "modes and owners are POSIX")
    def test_the_tabs_directory_is_made_private_and_holds_the_one_lock(self):
        self.update("a", "failed")
        self.assertEqual((self.state / tab.TABS).stat().st_mode & 0o777, 0o700)
        lock = self.state / tab.TABS / tab.TABS_LOCK
        self.assertTrue(lock.is_file())
        self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
        self.update("a", "failed", tab_id="tab-2")
        self.assertEqual(sorted(path.name for path in (self.state / tab.TABS).iterdir()),
                         sorted([tab.TABS_LOCK, tab.record_path(self.state, "tab-1").name,
                                 tab.record_path(self.state, "tab-2").name]))
        # Nothing of the plugin's sits in the state directory itself.
        self.assertEqual(sorted(path.name for path in self.state.iterdir()), [tab.TABS])

    @unittest.skipUnless(hasattr(os, "getuid"), "modes are POSIX")
    def test_a_tabs_directory_and_lock_left_open_to_others_are_closed_and_used(self):
        tabs = self.state / tab.TABS
        tabs.mkdir(parents=True)
        tabs.chmod(0o777)
        lock = tabs / tab.TABS_LOCK
        lock.write_text("")
        lock.chmod(0o666)
        self.assertEqual(self.update("a", "failed"), (0, ""))
        self.assertEqual(self.paint.painted, [RED])
        self.assertEqual(tabs.stat().st_mode & 0o777, 0o700)
        self.assertEqual(lock.stat().st_mode & 0o777, 0o600)

    def test_a_state_directory_the_owner_check_would_refuse_is_never_checked(self):
        # The state directory is the owner's own setting: what is checked is what
        # the plugin makes beneath it. A check that would refuse the state
        # directory itself is never asked about it.
        real = Path(os.path.realpath(self.root)) / "state"
        real.mkdir()
        original = alerts_module.private_directory
        asked = []

        def private_directory(path, *args, **kwargs):
            asked.append(Path(path))
            if Path(path) == real:
                raise alerts_module.UnsafePath("the case refuses the state directory")
            return original(path, *args, **kwargs)

        with mock.patch.object(alerts_module, "private_directory", private_directory):
            self.assertEqual(tab.update(real, "tab-1", "a", "failed", NOW, TINT, self.paint),
                             (0, ""))
        self.assertEqual(self.paint.painted, [RED])
        self.assertNotIn(real, asked)
        self.assertIn(real / tab.TABS, asked)

    def test_old_records_nobody_holds_are_swept_and_one_still_painted_is_kept(self):
        def plant(name, record):
            path = tab.record_path(self.state, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record))
            return path

        old = {"a": {"level": "failed", "at": NOW - 500}}
        gone_own = plant("gone-own", {"entries": old, "painted": "own"})
        gone_unknown = plant("gone-unknown", {"entries": old, "painted": "unknown"})
        empty_unknown = plant("empty-unknown", {"entries": {}, "painted": "unknown"})
        still_red = plant("still-red", {"entries": old, "painted": "220,50,47"})
        live = plant("live", {"entries": {"a": {"level": "waiting", "at": NOW - 10}},
                              "painted": "own"})
        broken = self.state / tab.TABS / ("0" * 32 + ".json")
        broken.write_text("{broken")
        self.update("me", "waiting")
        self.assertFalse(gone_own.exists())
        # A color that may still be on screen is kept until its own tab speaks:
        # one painted, and one whose paint nobody saw finish.
        for path in (gone_unknown, empty_unknown, still_red, live, broken):
            self.assertTrue(path.exists(), path.name)
        self.assertTrue(tab.record_path(self.state, "tab-1").exists())

    def test_a_tab_painted_red_whose_helper_died_is_still_restored_after_another_tab_sweeps(self):
        # The helper wrote unknown, painted red and died before writing the color.
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"entries": {"a": {"level": "failed", "at": NOW}},
                                    "painted": "unknown"}))
        later = NOW + 500
        self.update("b", "waiting", later, tab_id="tab-2")
        self.assertTrue(path.exists())
        self.update("a", "none", later + 1)
        self.assertEqual(self.paint.painted, [AMBER, None])
        self.assertFalse(path.exists())

    def test_a_sweep_reaches_a_record_past_any_fixed_run_of_ones_it_must_keep(self):
        stale = {"a": {"level": "failed", "at": NOW - 500}}
        tabs = self.state / tab.TABS
        tabs.mkdir(parents=True)
        own = tab.record_path(self.state, "tab-1")
        others = sorted(path for path in (tab.record_path(self.state, "other-{0}".format(index))
                                          for index in range(21)) if path != own)
        # Twenty records that must stay sort ahead of the one that may go.
        for path in others[:20]:
            path.write_text(json.dumps({"entries": stale, "painted": "220,50,47"}))
        eligible = others[20]
        eligible.write_text(json.dumps({"entries": stale, "painted": "own"}))
        with mock.patch.object(tab, "random", random.Random(7)):
            for turn in range(8):
                self.update("me", "waiting", NOW + turn)
                if not eligible.exists():
                    break
        self.assertFalse(eligible.exists())
        for path in others[:20]:
            self.assertTrue(path.exists(), path.name)

    def test_this_tab_s_own_record_left_unknown_survives_the_sweep_it_runs(self):
        # This tab's own record, every entry gone stale and its color unknown:
        # swept, it would read as a tab at its own color and the restore it
        # needs would never be written.
        path = tab.record_path(self.state, "tab-1")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"entries": {"x": {"level": "failed", "at": NOW - 500}},
                                    "painted": "unknown"}))
        self.update("me", "none")
        self.assertEqual(self.paint.painted, [None])

    def test_a_sweep_looks_at_no_more_than_its_bound_of_records(self):
        old = {"entries": {"a": {"level": "failed", "at": NOW - 500}}, "painted": "own"}
        tabs = self.state / tab.TABS
        tabs.mkdir(parents=True)
        for index in range(tab.SWEEP_LIMIT + 4):
            tab.record_path(self.state, "gone-{0}".format(index)).write_text(json.dumps(old))
        self.update("me", "waiting")
        left = [path for path in tabs.iterdir() if path.name.endswith(".json")]
        # Four old records stay for a later sweep, beside this tab's own.
        self.assertEqual(len(left), 4 + 1)

    def test_the_record_keeps_at_most_its_bound_of_entries_the_newest_first(self):
        for index in range(tab.MAX_ENTRIES + 5):
            self.update("s{0}".format(index), "waiting", NOW + index * 0.01)
        entries = self.record()["entries"]
        self.assertEqual(len(entries), tab.MAX_ENTRIES)
        self.assertIn("s{0}".format(tab.MAX_ENTRIES + 4), entries)
        self.assertNotIn("s0", entries)

    def test_each_tab_has_its_own_record_named_by_a_hash_under_the_state_directory(self):
        self.update("a", "failed", tab_id="tmux:/dev/ttys004")
        self.update("a", "waiting", tab_id="../../escape")
        first = tab.record_path(self.state, "tmux:/dev/ttys004")
        second = tab.record_path(self.state, "../../escape")
        self.assertNotEqual(first, second)
        for path in (first, second):
            self.assertEqual(path.parent, self.state / tab.TABS)
            self.assertRegex(path.name, r"^[0-9a-f]{32}\.json$")
        self.assertEqual(self.paint.painted, [RED, AMBER])


RACER = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from readers import tab
state, log, marker, who, level = sys.argv[2:7]
if who == "b":
    # The second waits until the first is painting, so the race is certain.
    for _ in range(1000):
        if Path(marker).exists():
            break
        time.sleep(0.01)
def paint(color):
    if who == "a":
        Path(marker).write_text("painting")
        time.sleep(1.0)
    with open(log, "a") as out:
        out.write(("own" if color is None else ",".join(map(str, color))) + "\\n")
    return True, ""
tint = {"enabled": True, "failureRgb": [220, 50, 47], "waitingRgb": [255, 176, 0],
        "staleSeconds": 120}
print(tab.update(Path(state), "tab-1", who, level, 1790000001.0, tint, paint)[0])
"""


class RaceTests(unittest.TestCase):
    def test_a_delayed_restore_never_lands_over_another_session_s_red(self):
        # Two processes, one record, a real lock. The first clears while the tab
        # is red and its restore is slow; the second fails while that restore is
        # being written. Each reads, merges, paints and writes the record whole,
        # one after the other, so the restore lands first and the red after it,
        # and the record keeps the second's failure.
        root = Path(tempfile.mkdtemp(prefix="fleet-tab-race-"))
        self.addCleanup(shutil.rmtree, root, True)
        state, log, marker = root / "state", root / "log", root / "marker"
        tab.update(state, "tab-1", "a", "failed", NOW, TINT, lambda color: (True, ""))

        def racer(who, level):
            return subprocess.Popen([sys.executable, "-c", RACER, str(PLUGIN), str(state), str(log),
                                     str(marker), who, level],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        first = racer("a", "none")
        second = racer("b", "failed")
        outputs = [process.communicate(timeout=30) for process in (first, second)]
        for process, (out, err) in zip((first, second), outputs):
            self.assertEqual((process.returncode, out.strip()), (0, "0"), err)
        self.assertEqual(log.read_text().split(), ["own", "220,50,47"])
        record = json.loads(tab.record_path(state, "tab-1").read_text())
        self.assertEqual(list(record["entries"]), ["b"])
        self.assertEqual(record["painted"], "220,50,47")


def read_all(master, seconds=10):
    """Everything a pseudo-terminal's other end is handed until it closes or goes quiet."""
    received = b""
    while True:
        ready, _, _ = select.select([master], [], [], seconds)
        if not ready:
            break
        try:
            chunk = os.read(master, 1024)
        except OSError:
            break
        if not chunk:
            break
        received += chunk
    return received


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-tab-terminal-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"stateDir": str(self.root / "state")}))

    def words(self, *rest):
        return [sys.executable, str(HELPER), "--config", str(self.config), "--now", str(NOW),
                *rest]

    @unittest.skipUnless(hasattr(os, "fork") and POSIX_TERMINALS, NO_PTY)
    def test_the_escape_reaches_the_session_s_terminal(self):
        # A real pseudo-terminal, made the helper's controlling terminal, read
        # back from its other end: what a session's terminal would be handed.
        import pty

        pid, master = pty.fork()
        if pid == 0:
            words = self.words("set", "--tab", "t", "--session", "s", "--level", "failed", "--tmux")
            os.execv(sys.executable, words)
        received = read_all(master)
        _, status = os.waitpid(pid, 0)
        os.close(master)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(received, tab.sequence(RED, True))

    @unittest.skipUnless(hasattr(os, "fork") and POSIX_TERMINALS, NO_PTY)
    def test_a_helper_the_host_starts_in_a_session_of_its_own_still_tints(self):
        # The host may run the helper detached: a new session, no controlling
        # terminal. Its parent runs on the pty, so the walk finds the parent's
        # terminal, checks it is the same device, and writes there.
        import pty

        pid, master = pty.fork()
        if pid == 0:
            ran = subprocess.run(self.words("set", "--tab", "t", "--session", "s", "--level",
                                            "waiting"),
                                 start_new_session=True, stdin=subprocess.DEVNULL,
                                 capture_output=True, check=False)
            os._exit(ran.returncode)
        received = read_all(master)
        _, status = os.waitpid(pid, 0)
        os.close(master)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(received, tab.sequence(AMBER, False))


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-tab-command-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"stateDir": str(self.root / "state")}))

    def main(self, *words):
        said = io.StringIO()
        with contextlib.redirect_stderr(said):
            code = tab.main(["--config", str(self.config), "--now", str(NOW), *words])
        return code, said.getvalue()

    def test_words_it_does_not_take_exit_two(self):
        for words in (["set", "--tab", "t", "--session", "s", "--level", "loud"],
                      ["set", "--tab", "t", "--level", "failed"],
                      ["set", "--session", "s", "--level", "failed"],
                      ["set", "--tab", "t", "--session", "a/b", "--level", "failed"],
                      ["set", "--tab", "", "--session", "s", "--level", "failed"],
                      ["set", "--tab", "t" * 300, "--session", "s", "--level", "failed"],
                      ["end", "--tab", "t"], ["paint", "1", "2", "3"], ["wiggle"], []):
            with self.subTest(words=words):
                self.assertEqual(self.main(*words)[0], 2)

    def test_a_configuration_it_refuses_exits_two_and_says_why(self):
        self.config.write_text(json.dumps({"alerts": {"tabTint": {"staleSeconds": 0}}}))
        code, said = self.main("set", "--tab", "t", "--session", "s", "--level", "failed")
        self.assertEqual(code, 2)
        self.assertIn("staleSeconds", said)

    def test_no_terminal_anywhere_writes_nothing_says_why_and_records_the_tab_unknown(self):
        nowhere = ([(str(self.root / "missing"), None)], "no process up the chain has a terminal")
        with mock.patch.object(tab, "terminals", return_value=nowhere):
            code, said = self.main("set", "--tab", "t", "--session", "s", "--level", "failed")
        self.assertEqual(code, 1)
        self.assertIn("wrote nothing", said)
        self.assertIn("no process up the chain", said)
        record = json.loads(tab.record_path(self.root / "state", "t").read_text())
        self.assertEqual(record["painted"], "unknown")

    def test_a_record_that_does_not_parse_exits_three_and_replaces_nothing(self):
        path = tab.record_path(self.root / "state", "t")
        path.parent.mkdir(parents=True)
        path.write_text("{broken")
        with mock.patch.object(tab, "terminals") as terminals:
            code, said = self.main("end", "--tab", "t", "--session", "s")
        self.assertEqual(code, 3)
        self.assertIn("could not be read", said)
        terminals.assert_not_called()
        self.assertEqual(path.read_text(), "{broken")

    def test_nothing_to_paint_looks_for_no_terminal(self):
        with mock.patch.object(tab, "terminals") as terminals:
            code, _ = self.main("set", "--tab", "t", "--session", "s", "--level", "none")
        self.assertEqual(code, 0)
        terminals.assert_not_called()


if __name__ == "__main__":
    unittest.main()
