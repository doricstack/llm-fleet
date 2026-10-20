#!/usr/bin/env python3
"""Focus, claims and the voice, against real files and a real synthesizer command.

The synthesizer is a stub script on disk that writes the file it is asked for,
fails, writes nothing, or hangs, and records the environment it was started
with. Every refusal is driven through the same entry the plugin calls.
"""

import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import stat
import sys
import tempfile
import time
import unittest
import unittest.mock
from unittest import mock
import wave

import paths  # puts the plugin root on the path

from config.loader import load_config
from readers import alerts, jobs

NOW = 1_700_000_000.0

STUB = """#!{python}
import json, os, sys, time
args = sys.argv[1:]
out = args[args.index("--out") + 1]
voice = args[args.index("--voice") + 1]
text = args[args.index("--") + 1:]
mode = open({mode!r}).read().strip()
with open({record!r}, "w") as record:
    json.dump({{"voice": voice, "text": text, "env": sorted(os.environ)}}, record)
if mode == "fail":
    sys.exit(3)
if mode == "hang":
    time.sleep(30)
if mode == "empty":
    open(out, "wb").close()
    sys.exit(0)
with open(out, "wb") as wav:
    wav.write(b"RIFF....WAVE")
"""


# How long the stub synthesizer may take. It is a Python script, and under a
# load average of 40 its interpreter took longer than two seconds to start: the
# run was cut off before the stub wrote its record, and a case that read that
# record failed on a missing file rather than on anything the code did.
SYNTHESIS_MS = 30_000
# How long the case that wants a run cut off waits, against a stub that sleeps
# thirty seconds.
HANG_MS = 1_000


def make_link(case, link, target):
    """Make `link` point at `target`, or skip the case where this platform will not."""
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError) as refused:
        case.skipTest("this platform will not create a link here: {0}".format(refused))


class AlertsCase(unittest.TestCase):
    def assert_owner_only(self, path):
        """`path` is closed to group and others, where the platform carries mode bits.

        Windows reports every file as 0o666 or 0o444 and has no group or other
        bits to close, so the check means nothing there and is not made.
        """
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0, path)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-alerts-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.state = self.root / "state"
        self.temp = self.root / "temp"
        self.temp.mkdir()
        self.mode = self.root / "mode"
        self.mode.write_text("ok")
        self.record = self.root / "record.json"
        self.synth = self.root / "synth"
        self.synth.write_text(STUB.format(python=sys.executable, mode=str(self.mode),
                                          record=str(self.record)))
        self.synth.chmod(self.synth.stat().st_mode | stat.S_IXUSR)
        self.environ = {"HOME": str(self.root), "PATH": os.environ.get("PATH", ""),
                        "ANTHROPIC_TEST_TOKEN": "x", "OPENAI_API_KEY": "x", "KEPT": "1"}

    def config(self, synthesis_ms=SYNTHESIS_MS, **speech):
        body = {"stateDir": str(self.state),
                "speech": {"enabled": True, "command": str(self.synth),
                           "tempDirectory": str(self.temp), **speech},
                "timeouts": {"synthesisMs": synthesis_ms}}
        path = self.root / "config.json"
        path.write_text(json.dumps(body))
        return load_config(str(path), environ=self.environ)

    def run_main(self, *argv):
        path = self.root / "config.json"
        if not path.exists():
            self.config()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alerts.main(["--config", str(path), "--now", str(NOW), *argv],
                               environ=self.environ)
        return code, out.getvalue()


class FocusTests(AlertsCase):
    def test_the_session_typed_in_last_is_focused_within_the_window(self):
        self.assertEqual(self.run_main("focus", "session-a")[0], 0)
        self.assertEqual(self.run_main("focused", "session-a")[0], 0)
        self.assertEqual(self.run_main("focused", "session-b")[0], 1)

    def test_focus_lapses_after_the_configured_window(self):
        alerts.set_focus(self.state, "session-a", NOW - 1801)
        self.assertFalse(alerts.is_focused(self.state, "session-a", NOW, 1800))
        self.assertTrue(alerts.is_focused(self.state, "session-a", NOW - 1, 1800))

    def test_an_identifier_that_could_name_a_path_is_refused(self):
        for session in ("../escape", "a/b", "", "x" * 129):
            self.assertFalse(alerts.set_focus(self.state, session, NOW), session)
        self.assertFalse(alerts.focus_path(self.state).exists())

    def test_a_malformed_or_missing_focus_file_is_not_focus(self):
        self.assertFalse(alerts.is_focused(self.state, "session-a", NOW, 1800))
        alerts.focus_path(self.state).parent.mkdir(parents=True)
        for body in ("not json", "[]", '{"session": "session-a", "at": true}',
                     '{"session": "session-a"}'):
            alerts.focus_path(self.state).write_text(body)
            self.assertFalse(alerts.is_focused(self.state, "session-a", NOW, 1800), body)

    def test_a_focus_dated_ahead_of_the_clock_is_not_focus(self):
        alerts.set_focus(self.state, "session-a", NOW + 60)
        self.assertFalse(alerts.is_focused(self.state, "session-a", NOW, 1800))


class ClaimTests(AlertsCase):
    def test_the_first_caller_claims_and_the_second_does_not(self):
        self.assertEqual(self.run_main("claim", "job:a:blocked:1")[0], 0)
        self.assertEqual(self.run_main("claim", "job:a:blocked:1")[0], 1)
        self.assertEqual(self.run_main("claim", "job:a:blocked:2")[0], 0)

    def test_an_expired_claim_is_pruned_and_can_be_claimed_again(self):
        self.assertTrue(alerts.claim(self.state, "k", NOW, 100))
        entry = next(path for path in (self.state / "claims").iterdir() if path.name != ".lock")
        os.utime(entry, (NOW - 101, NOW - 101))
        self.assertTrue(alerts.claim(self.state, "k", NOW, 100))

    def test_an_empty_or_oversized_key_is_refused(self):
        self.assertFalse(alerts.claim(self.state, "", NOW, 100))
        self.assertFalse(alerts.claim(self.state, "k" * 1025, NOW, 100))

    def test_a_lock_that_is_a_link_claims_nothing_and_leaves_its_target_alone(self):
        claims = self.state / "claims"
        claims.mkdir(parents=True)
        target = self.root / "elsewhere"
        target.write_text("kept")
        make_link(self, claims / ".lock", target)
        self.assertFalse(alerts.claim(self.state, "k", NOW, 100))
        self.assertEqual(target.read_text(), "kept")
        self.assertEqual([path.name for path in claims.iterdir()], [".lock"])

    def test_a_lock_directory_that_is_a_link_claims_nothing_and_writes_nothing_through_it(self):
        self.state.mkdir(parents=True)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        try:
            os.symlink(elsewhere, self.state / "claims", target_is_directory=True)
        except (OSError, NotImplementedError) as refused:
            self.skipTest("this platform will not create a link here: {0}".format(refused))
        with self.assertRaises(OSError):
            with alerts.exclusive(self.state / "claims" / ".lock"):
                pass
        self.assertFalse(alerts.claim(self.state, "k", NOW, 100))
        self.assertEqual(list(elsewhere.iterdir()), [])

    @unittest.skipUnless(hasattr(os, "getuid"), "modes are POSIX")
    def test_a_lock_directory_is_made_for_this_user_alone(self):
        with alerts.exclusive(self.state / "fresh" / "x.lock"):
            pass
        self.assertEqual((self.state / "fresh").stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.state / "fresh" / "x.lock").stat().st_mode & 0o777, 0o600)

    def test_a_state_directory_given_as_a_link_claims_and_holds_the_voice(self):
        real = self.root / "real-state"
        real.mkdir()
        linked = self.root / "linked-state"
        make_link(self, linked, real)
        self.assertTrue(alerts.claim(linked, "k", NOW, 100))
        self.assertFalse(alerts.claim(linked, "k", NOW, 100))
        self.assertTrue((real / "claims" / ".lock").is_file())
        moment = [NOW]
        self.assertTrue(alerts.hold_voice(linked, 1.0, lambda: moment[0],
                                          lambda seconds: None, wait_seconds=5))
        self.assertTrue(alerts.voice_path(real).is_file())

    def test_a_claims_link_beneath_a_linked_state_directory_is_still_refused(self):
        real = self.root / "real-state"
        real.mkdir()
        linked = self.root / "linked-state"
        make_link(self, linked, real)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        make_link(self, real / "claims", elsewhere)
        self.assertFalse(alerts.claim(linked, "k", NOW, 100))
        self.assertEqual(list(elsewhere.iterdir()), [])

    @unittest.skipUnless(hasattr(os, "getuid"), "modes are POSIX")
    def test_a_claims_folder_and_lock_left_open_to_others_are_closed_and_used(self):
        claims = self.state / "claims"
        claims.mkdir(parents=True)
        claims.chmod(0o777)
        lock = claims / ".lock"
        lock.write_text("")
        lock.chmod(0o644)
        self.assertTrue(alerts.claim(self.state, "k", NOW, 100))
        self.assertEqual(claims.stat().st_mode & 0o777, 0o700)
        self.assertEqual(lock.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(hasattr(os, "fchmod") and hasattr(os, "O_DIRECTORY"),
                         "a directory handle to change the mode through is POSIX")
    def test_a_folder_swapped_for_a_link_before_its_mode_is_closed_is_refused(self):
        folder = self.state / "claims"
        folder.mkdir(parents=True)
        folder.chmod(0o777)
        target = self.root / "elsewhere"
        target.mkdir()
        target.chmod(0o755)

        def swapping(name, flags, *rest, **at):
            # Between the check and the open, the folder becomes a link.
            os.rmdir(folder)
            make_link(self, folder, target)
            return os.open(name, flags, *rest, **at)

        with self.assertRaises(alerts.UnsafePath):
            alerts.private_directory(folder, opener=swapping)
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)

    @unittest.skipUnless(hasattr(os, "fchmod") and hasattr(os, "O_DIRECTORY"),
                         "a directory handle to change the mode through is POSIX")
    def test_a_folder_handle_that_is_not_a_directory_or_not_this_user_s_is_refused(self):
        folder = self.state / "claims"
        folder.mkdir(parents=True)
        folder.chmod(0o777)
        plain = self.root / "plain"
        plain.write_text("")
        plain.chmod(0o644)

        def to_a_file(path, flags, *rest, **at):
            return os.open(plain, os.O_RDONLY)

        with self.assertRaises(alerts.UnsafePath):
            alerts.private_directory(folder, opener=to_a_file)
        self.assertEqual(plain.stat().st_mode & 0o777, 0o644)
        # Whose the folder is, is judged on the handle opened, not on the name looked at.
        with unittest.mock.patch.object(alerts, "_owned", return_value=False):
            with self.assertRaises(alerts.UnsafePath):
                alerts.private_directory(folder)
        self.assertEqual(folder.stat().st_mode & 0o777, 0o777)

    def test_with_no_directory_handle_a_link_is_still_refused_and_the_mode_left_alone(self):
        opened = []

        def opener(*args):
            opened.append(args)
            return os.open(*args)

        folder = self.state / "claims"
        folder.mkdir(parents=True)
        if hasattr(os, "getuid"):
            folder.chmod(0o777)
        before = folder.stat().st_mode
        with unittest.mock.patch.object(alerts, "_directory_handles", return_value=False):
            alerts.private_directory(folder, opener=opener)
            self.assertEqual(opened, [])
            self.assertEqual(folder.stat().st_mode, before)
            linked = self.state / "locks"
            target = self.root / "elsewhere"
            target.mkdir()
            make_link(self, linked, target)
            with self.assertRaises(alerts.UnsafePath):
                alerts.private_directory(linked, opener=opener)
            # Where the platform has owners, another user's folder is refused by name here.
            with unittest.mock.patch.object(alerts, "_owned", return_value=False):
                with self.assertRaisesRegex(alerts.UnsafePath, "this user owns"):
                    alerts.private_directory(folder, opener=opener)

    def test_the_voice_is_held_in_a_folder_the_plugin_makes_never_in_the_state_directory(self):
        real = Path(os.path.realpath(self.root)) / "state"
        real.mkdir()
        original = alerts.private_directory
        asked = []

        def private_directory(path, *args, **kwargs):
            asked.append(Path(path))
            if Path(path) == real:
                raise alerts.UnsafePath("the case refuses the state directory")
            return original(path, *args, **kwargs)

        moment = [NOW]
        with unittest.mock.patch.object(alerts, "private_directory", private_directory):
            self.assertTrue(alerts.hold_voice(real, 1.0, lambda: moment[0], lambda seconds: None,
                                              wait_seconds=5))
            self.assertTrue(alerts.claim(real, "k", NOW, 100))
        self.assertNotIn(real, asked)
        self.assertIn(real / alerts.LOCKS, asked)
        self.assertTrue((real / alerts.LOCKS / alerts.VOICE_LOCK).is_file())
        self.assertEqual((real / alerts.LOCKS).stat().st_mode & 0o777,
                         0o700 if hasattr(os, "getuid") else (real / alerts.LOCKS).stat().st_mode & 0o777)

    def test_a_lock_that_is_not_a_regular_file_claims_nothing(self):
        (self.state / "claims" / ".lock").mkdir(parents=True)
        self.assertFalse(alerts.claim(self.state, "k", NOW, 100))

    @unittest.skipUnless(hasattr(os, "mkfifo"), "pipes on the filesystem are POSIX")
    def test_a_lock_that_is_a_pipe_claims_nothing(self):
        claims = self.state / "claims"
        claims.mkdir(parents=True)
        os.mkfifo(claims / ".lock")
        self.assertFalse(alerts.claim(self.state, "k", NOW, 100))

    @unittest.skipUnless(hasattr(os, "getuid"), "owners are POSIX")
    def test_a_lock_another_user_owns_claims_nothing(self):
        self.assertTrue(alerts.claim(self.state, "k", NOW, 100))
        with alerts.private_directory(self.state / "claims") as folder:
            with unittest.mock.patch.object(os, "getuid", return_value=os.getuid() + 1):
                self.assertFalse(alerts.claim(self.state, "other", NOW, 100))
                # The lock itself, apart from the directory it sits in.
                with self.assertRaisesRegex(alerts.UnsafePath, "this user owns"):
                    alerts.open_lock(folder, ".lock")

    def test_a_lock_that_opens_as_anything_but_a_regular_file_is_refused(self):
        # Checked on the handle, so whatever the name turned out to be is what is judged.
        ends = []

        def opener(path, flags, mode=0o777, **at):
            read_end, write_end = os.pipe()
            ends.append(read_end)
            return write_end

        with alerts.private_directory(self.root / "locks") as folder:
            with self.assertRaisesRegex(alerts.UnsafePath, "not a regular file"):
                alerts.open_lock(folder, "a.lock", opener)
        for end in ends:
            os.close(end)

    def test_a_lock_is_opened_never_through_a_link(self):
        asked = []

        def opener(path, flags, mode=0o777, **at):
            asked.append(flags)
            raise OSError(13, "refused by the case")

        with alerts.private_directory(self.root / "locks") as folder:
            with self.assertRaises(alerts.UnsafePath):
                alerts.open_lock(folder, "a.lock", opener)
        self.assertTrue(asked[0] & os.O_CREAT)
        if hasattr(os, "O_NOFOLLOW"):
            self.assertTrue(asked[0] & os.O_NOFOLLOW)

    def test_a_lock_made_by_another_session_at_that_instant_is_opened_on_a_retry(self):
        # macOS answers a create through a folder handle with "no such file" when
        # another process makes the same name at that instant; the file is there.
        asked = []

        def opener(path, flags, mode=0o777, **at):
            asked.append(path)
            if len(asked) < 3:
                raise FileNotFoundError(2, "No such file or directory")
            return os.open(path, flags, mode, **at)

        with alerts.private_directory(self.root / "locks") as folder:
            handle = alerts.open_lock(folder, "a.lock", opener)
            os.close(handle)
        self.assertEqual(asked, ["a.lock"] * 3 if alerts._directory_handles() else
                         [self.root / "locks" / "a.lock"] * 3)
        self.assertTrue((self.root / "locks" / "a.lock").is_file())

    def test_a_lock_that_never_opens_is_refused_after_a_bounded_retry(self):
        asked = []

        def opener(path, flags, mode=0o777, **at):
            asked.append(path)
            raise FileNotFoundError(2, "No such file or directory")

        with alerts.private_directory(self.root / "locks") as folder:
            with self.assertRaisesRegex(alerts.UnsafePath, "did not open: No such file"):
                alerts.open_lock(folder, "a.lock", opener)
        self.assertEqual(len(asked), alerts.LOCK_OPEN_TRIES)
        self.assertGreater(alerts.LOCK_OPEN_TRIES, 1)

    def test_a_lock_refused_for_any_other_reason_is_not_retried(self):
        asked = []

        def opener(path, flags, mode=0o777, **at):
            asked.append(path)
            raise PermissionError(13, "Permission denied")

        with alerts.private_directory(self.root / "locks") as folder:
            with self.assertRaisesRegex(alerts.UnsafePath, "did not open: Permission denied"):
                alerts.open_lock(folder, "a.lock", opener)
        self.assertEqual(len(asked), 1)

    def test_a_key_names_a_hashed_file_not_a_path(self):
        self.assertTrue(alerts.claim(self.state, "../../escape", NOW, 100))
        names = [path.name for path in (self.state / "claims").iterdir()]
        self.assertTrue(all(name == ".lock" or len(name) == 32 for name in names), names)
        self.assertFalse((self.root / "escape").exists())


class LockTests(AlertsCase):
    """The lock every shared decision takes: a regular file this user owns, never a link."""

    def posix(self):
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "getuid"):
            self.skipTest("this platform has no link-refusing open or no file owner to check")

    def take(self, path):
        with alerts.exclusive(path):
            return True

    def test_a_lock_folder_is_made_for_this_user_alone(self):
        self.posix()
        lock = self.state / "locks" / ".lock"
        self.assertTrue(self.take(lock))
        self.assertEqual(stat.S_IMODE(lock.parent.stat().st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE(lock.stat().st_mode) & 0o077, 0)

    def test_a_lock_that_is_a_link_is_refused_and_its_target_untouched(self):
        self.posix()
        self.state.mkdir(parents=True)
        victim = self.root / "victim"
        victim.write_text("keep me")
        os.symlink(victim, self.state / ".lock")
        with self.assertRaises(alerts.UnsafePath):
            self.take(self.state / ".lock")
        self.assertEqual(victim.read_text(), "keep me")

    def test_a_lock_folder_that_is_a_link_is_refused(self):
        self.posix()
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.state.mkdir(parents=True)
        os.symlink(elsewhere, self.state / "claims")
        with self.assertRaises(alerts.UnsafePath):
            self.take(self.state / "claims" / ".lock")
        self.assertEqual(list(elsewhere.iterdir()), [])
        # A caller refused its lock claims nothing rather than failing.
        self.assertFalse(alerts.claim(self.state, "k", NOW, 100))

    def test_a_lock_owned_by_another_user_is_refused(self):
        self.posix()
        lock = self.state / ".lock"
        self.assertTrue(self.take(lock))
        with mock.patch.object(alerts, "_this_user", lambda: os.getuid() + 1):
            with self.assertRaises(alerts.UnsafePath):
                self.take(lock)

    def test_an_existing_lock_folder_owned_by_another_user_is_refused(self):
        self.posix()
        folder = self.state / "claims"
        folder.mkdir(parents=True, mode=0o700)
        real = os.getuid()
        # The folder was there before; only the folder's owner is wrong, the lock is new.
        with mock.patch.object(alerts, "_this_user", lambda: real + 1):
            with self.assertRaises(alerts.UnsafePath):
                self.take(folder / ".lock")
        self.assertFalse((folder / ".lock").exists())

    def test_an_existing_lock_folder_open_to_others_is_tightened(self):
        self.posix()
        folder = self.state / "claims"
        folder.mkdir(parents=True)
        folder.chmod(0o755)
        self.assertTrue(self.take(folder / ".lock"))
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)

    def test_a_new_lock_folder_is_never_open_to_others_even_for_a_moment(self):
        self.posix()
        folder = self.state / "claims"
        seen = []

        def look(step):
            if step == "folder" and folder.is_dir():
                seen.append(stat.S_IMODE(folder.stat().st_mode) & 0o077)

        with mock.patch.object(alerts, "_between", look):
            self.assertTrue(self.take(folder / ".lock"))
        self.assertEqual(seen, [0])

    def test_a_lock_folder_swapped_for_a_link_before_it_is_tightened_is_refused(self):
        self.posix()
        folder = self.state / "claims"
        folder.mkdir(parents=True)
        folder.chmod(0o755)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        elsewhere.chmod(0o755)

        def swap(step):
            # Checked by name as a folder, then swapped for a link before it is opened.
            if step == "folder-open":
                folder.rename(self.state / "claims-real")
                os.symlink(elsewhere, folder)

        with mock.patch.object(alerts, "_between", swap):
            with self.assertRaises(alerts.UnsafePath):
                self.take(folder / ".lock")
        self.assertEqual(stat.S_IMODE(elsewhere.stat().st_mode), 0o755)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_a_lock_swapped_for_a_link_after_it_was_checked_is_refused(self):
        self.posix()
        folder = self.state / "claims"
        folder.mkdir(parents=True, mode=0o700)
        victim = self.root / "victim"
        victim.write_text("keep me")
        victim.chmod(0o644)

        def swap(step):
            if step == "lock":
                os.symlink(victim, folder / ".lock")

        with mock.patch.object(alerts, "_between", swap):
            with self.assertRaises(alerts.UnsafePath):
                self.take(folder / ".lock")
        self.assertEqual((victim.read_text(), stat.S_IMODE(victim.stat().st_mode)), ("keep me", 0o644))

    def swapped_at(self, step, folder):
        """A hook that swaps `folder` for a link to an empty folder at `step`, once."""
        elsewhere = self.root / ("elsewhere-" + folder.name)
        elsewhere.mkdir()
        swapped = []

        def swap(name):
            if name == step and not swapped:
                folder.rename(folder.with_name(folder.name + "-real"))
                os.symlink(elsewhere, folder)
                swapped.append(name)

        return swap, swapped, elsewhere

    def test_a_lock_folder_swapped_for_a_link_once_checked_is_never_walked_again(self):
        self.posix()
        folder = self.state / alerts.CLAIMS
        folder.mkdir(parents=True, mode=0o700)
        swap, swapped, elsewhere = self.swapped_at("lock", folder)
        with mock.patch.object(alerts, "_between", swap):
            self.assertTrue(alerts.claim(self.state, "k", NOW, 100))
        self.assertEqual(swapped, ["lock"])
        # The lock, the listing and the claim all land in the folder that was checked.
        self.assertEqual(list(elsewhere.iterdir()), [])
        real = folder.with_name(folder.name + "-real")
        self.assertEqual(sorted(path.name for path in real.iterdir())[0], ".lock")
        self.assertEqual(len(list(real.iterdir())), 2)

    def test_a_kept_file_s_folder_swapped_for_a_link_before_the_write_is_not_followed(self):
        self.posix()
        folder = self.state / alerts.ALERTS_FOLDER
        folder.mkdir(parents=True, mode=0o700)
        swap, swapped, elsewhere = self.swapped_at("write", folder)
        with mock.patch.object(alerts, "_between", swap):
            self.assertTrue(alerts.set_focus(self.state, "session-a", NOW))
        self.assertEqual(swapped, ["write"])
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertTrue((folder.with_name(folder.name + "-real") / alerts.FOCUS_FILE).is_file())

    def test_a_lock_file_owned_by_another_user_in_this_users_folder_is_refused(self):
        self.posix()
        lock = self.state / "claims" / ".lock"
        self.assertTrue(self.take(lock))
        # The folder is this user's; only the lock file reads as another's.
        with mock.patch.object(alerts, "_owned", lambda info: stat.S_ISDIR(info.st_mode)):
            with self.assertRaises(alerts.UnsafePath):
                self.take(lock)

    def test_an_existing_lock_file_open_to_others_is_tightened(self):
        self.posix()
        lock = self.state / "claims" / ".lock"
        lock.parent.mkdir(parents=True, mode=0o700)
        lock.write_text("")
        lock.chmod(0o644)
        self.assertTrue(self.take(lock))
        self.assertEqual(stat.S_IMODE(lock.stat().st_mode), 0o600)

    def test_a_windows_reparse_point_is_taken_as_a_link(self):
        reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        folder = mock.Mock(st_mode=stat.S_IFDIR | 0o700, st_file_attributes=reparse)
        plain = mock.Mock(st_mode=stat.S_IFDIR | 0o700, st_file_attributes=0)
        self.assertTrue(alerts.is_link(folder))
        self.assertFalse(alerts.is_link(plain))
        self.assertTrue(alerts.is_link(mock.Mock(st_mode=stat.S_IFLNK | 0o777,
                                                  st_file_attributes=0)))

    def test_a_lock_that_is_not_a_regular_file_is_refused(self):
        self.posix()
        self.state.mkdir(parents=True)
        (self.state / "folder.lock").mkdir()
        with self.assertRaises(alerts.UnsafePath):
            self.take(self.state / "folder.lock")
        if hasattr(os, "mkfifo"):
            os.mkfifo(self.state / "pipe.lock")
            with self.assertRaises(alerts.UnsafePath):
                self.take(self.state / "pipe.lock")

    def linked_state(self):
        """A configured state directory given as a link to a real one: the owner's own setting."""
        real = self.root / "real-state"
        real.mkdir()
        self.state = self.root / "linked-state"
        os.symlink(real, self.state)
        return real

    def test_a_state_directory_given_as_a_link_claims_speaks_and_answers(self):
        self.posix()
        real = self.linked_state()
        self.assertEqual(self.run_main("claim", "job:a:blocked:1")[0], 0)
        self.assertEqual(self.run_main("claim", "job:a:blocked:1")[0], 1)
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "hello")
        self.assertEqual((code, json.loads(out)["reason"]), (0, None))
        home = self.root / "provider"
        (home / "jobs" / "job-1").mkdir(parents=True)
        (home / "jobs" / "job-1" / "state.json").write_text(
            json.dumps({"needs": "Go?", "sessionId": "s-1"}), encoding="utf-8")
        path = self.root / "config.json"
        document = json.loads(path.read_text())
        document["providers"] = [{"id": "one", "home": str(home)}]
        path.write_text(json.dumps(document))
        code, out = self.run_main("question", "one", "job-1", "--holder", "pane-a")
        self.assertEqual((code, json.loads(out)["held"]), (0, True))
        self.assertEqual(json.loads(self.run_main("question", "one", "job-1", "--holder",
                                                  "pane-b")[1])["state"], "answered")
        self.assertTrue((real / alerts.REPLY_ANSWERS).is_dir())

    def test_a_lock_folder_linked_beneath_a_linked_state_directory_is_refused(self):
        self.posix()
        real = self.linked_state()
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        os.symlink(elsewhere, real / alerts.CLAIMS)
        self.assertEqual(self.run_main("claim", "job:a:blocked:1")[0], 1)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_speech_refused_its_lock_says_why_and_leaves_no_file(self):
        self.posix()
        (self.state / alerts.LOCKS).mkdir(parents=True)
        victim = self.root / "victim"
        victim.write_text("keep me")
        os.symlink(victim, self.state / alerts.LOCKS / "voice.lock")
        spoken = alerts.speak(self.config(), "af_sky", "hello", self.environ, state_dir=self.state)
        self.assertEqual(spoken["file"], None)
        self.assertIn("lock", spoken["reason"])
        self.assertEqual(list(self.temp.iterdir()), [])
        self.assertEqual(victim.read_text(), "keep me")


@unittest.skipIf(not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "getuid"),
                 "this platform has no link-refusing open or no file owner to check")
class OwnerOnlyFileTests(AlertsCase):
    """The files the helper keeps: made for this user alone, and never read or written through a link."""

    def owner_only(self, path):
        self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0, path)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode) & 0o077, 0, path.parent)

    def planted(self, path):
        """A link at `path` to a file of someone else's, which must come out untouched."""
        victim = self.root / ("victim-" + path.name)
        victim.write_text("keep me")
        victim.chmod(0o644)
        path.unlink(missing_ok=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(victim, path)
        return victim

    def untouched(self, victim):
        self.assertEqual((victim.read_text(), stat.S_IMODE(victim.stat().st_mode)), ("keep me", 0o644))

    def linked_folder(self, folder):
        elsewhere = self.root / ("elsewhere-" + folder.name)
        elsewhere.mkdir()
        folder.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(elsewhere, folder)
        return elsewhere

    def test_the_focus_file(self):
        self.assertTrue(alerts.set_focus(self.state, "session-a", NOW))
        self.owner_only(alerts.focus_path(self.state))
        victim = self.planted(alerts.focus_path(self.state))
        # Not read through the link: the planted focus is no focus.
        victim.write_text(json.dumps({"session": "session-b", "at": NOW}))
        victim.chmod(0o644)
        self.assertFalse(alerts.is_focused(self.state, "session-b", NOW, 1800))
        # Written by replacing the link itself, never through it.
        victim.write_text("keep me")
        self.assertTrue(alerts.set_focus(self.state, "session-a", NOW))
        self.untouched(victim)
        self.assertFalse(alerts.focus_path(self.state).is_symlink())
        self.owner_only(alerts.focus_path(self.state))

    def test_the_focus_folder(self):
        elsewhere = self.linked_folder(self.state / alerts.ALERTS_FOLDER)
        self.assertFalse(alerts.set_focus(self.state, "session-a", NOW))
        self.assertEqual(list(elsewhere.iterdir()), [])
        # A focus planted where the link leads is not read through it either.
        (elsewhere / alerts.FOCUS_FILE).write_text(json.dumps({"session": "session-b", "at": NOW}))
        self.assertFalse(alerts.is_focused(self.state, "session-b", NOW, 1800))

    def test_the_voice_files(self):
        clock = lambda: NOW
        self.assertTrue(alerts.hold_voice(self.state, 1.0, clock, lambda seconds: None))
        self.owner_only(alerts.voice_path(self.state))
        self.owner_only(self.state / alerts.LOCKS / "voice.lock")
        victim = self.planted(alerts.voice_path(self.state))
        self.assertTrue(alerts.hold_voice(self.state, 1.0, clock, lambda seconds: None))
        self.untouched(victim)
        self.assertFalse(alerts.voice_path(self.state).is_symlink())

    def test_the_voice_folder(self):
        elsewhere = self.linked_folder(alerts.voice_path(self.state).parent)
        with self.assertRaises(alerts.UnsafePath):
            alerts.hold_voice(self.state, 1.0, lambda: NOW, lambda seconds: None)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_the_claim_files(self):
        self.assertTrue(alerts.claim(self.state, "k", NOW, 100))
        made = [path for path in (self.state / alerts.CLAIMS).iterdir() if path.name != ".lock"]
        self.assertEqual(len(made), 1)
        self.owner_only(made[0])
        # A link at the next claim's name is refused, and claims nothing.
        name = __import__("hashlib").sha256(b"other").hexdigest()[:32]
        victim = self.planted(self.state / alerts.CLAIMS / name)
        self.assertFalse(alerts.claim(self.state, "other", NOW, 100))
        self.untouched(victim)

    def test_the_claim_folder(self):
        elsewhere = self.linked_folder(self.state / alerts.CLAIMS)
        self.assertFalse(alerts.claim(self.state, "k", NOW, 100))
        self.assertEqual(list(elsewhere.iterdir()), [])


class VoicesTests(AlertsCase):
    def test_ready_when_enabled_with_an_executable_command(self):
        code, out = self.run_main("voices")
        document = json.loads(out)
        self.assertEqual((code, document["state"], document["reason"]), (0, "ready", None))
        self.assertIn("af_sky", document["voices"]["female"])

    def test_each_reason_speech_cannot_run_is_named(self):
        cases = [({"enabled": False}, "speech.enabled"),
                 ({"command": None}, "speech.command"),
                 ({"command": str(self.root / "missing")}, "speech.command")]
        for speech, named in cases:
            document = alerts.voices_document(self.config(**speech))
            self.assertEqual(document["state"], "unavailable", speech)
            self.assertIn(named, document["reason"], speech)

    @unittest.skipIf(os.name == "nt", "Windows has no execute bit to withhold")
    def test_a_command_that_is_not_executable_is_unavailable(self):
        self.synth.chmod(0o644)
        document = alerts.voices_document(self.config())
        self.assertEqual(document["state"], "unavailable")


@unittest.skipIf(os.name == "nt", "the stub synthesizer is a script run through its shebang")
class SpeakTests(AlertsCase):
    def test_a_line_is_written_to_a_file_in_the_temporary_directory(self):
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "Hey, build is waiting on you.")
        spoken = json.loads(out)
        self.assertEqual(code, 0)
        path = Path(spoken["file"])
        self.assertEqual(path.parent.resolve(), self.temp.resolve())
        self.assertTrue(alerts.SPOKEN_FILE.fullmatch(path.name))
        record = json.loads(self.record.read_text())
        self.assertEqual(record["voice"], "af_sky")
        self.assertEqual(record["text"], ["Hey, build is waiting on you."])

    def test_a_line_that_starts_with_a_dash_stays_text(self):
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "--help me")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(self.record.read_text())["text"], ["--help me"])

    def test_the_synthesizer_never_inherits_a_provider_credential(self):
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "hello")
        # A run that did not finish says why, rather than as a missing record.
        self.assertEqual(code, 0, out)
        names = json.loads(self.record.read_text())["env"]
        self.assertNotIn("ANTHROPIC_TEST_TOKEN", names)
        self.assertNotIn("OPENAI_API_KEY", names)
        self.assertIn("KEPT", names)

    def test_each_failure_leaves_no_file_and_names_its_reason(self):
        for mode, reason in (("fail", "exited 3"), ("empty", "wrote nothing"),
                             ("hang", "longer than")):
            self.config(synthesis_ms=HANG_MS if mode == "hang" else SYNTHESIS_MS)
            self.mode.write_text(mode)
            code, out = self.run_main("speak", "--voice", "af_sky", "--", "hello")
            spoken = json.loads(out)
            self.assertEqual((code, spoken["file"]), (1, None), mode)
            self.assertIn(reason, spoken["reason"], mode)
            self.assertEqual(list(self.temp.iterdir()), [], mode)

    def test_a_voice_outside_the_configuration_is_refused_before_anything_runs(self):
        for voice in ("--out", "af_unknown", "a b"):
            code, out = self.run_main("speak", "--voice=" + voice, "--", "hello")
            self.assertEqual((code, json.loads(out)["reason"]), (1, "not a configured voice"))
        self.assertFalse(self.record.exists())

    def test_disabled_speech_runs_nothing(self):
        self.config(enabled=False)
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "hello")
        self.assertEqual(code, 1)
        self.assertIn("speech.enabled", json.loads(out)["reason"])
        self.assertFalse(self.record.exists())

    def test_a_voice_lock_that_cannot_be_taken_says_so_and_keeps_no_file(self):
        (self.state / alerts.LOCKS / alerts.VOICE_LOCK).mkdir(parents=True)
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "hello")
        spoken = json.loads(out)
        self.assertEqual((code, spoken["file"]), (1, None))
        self.assertIn("voice lock", spoken["reason"])
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_nothing_to_say_runs_nothing(self):
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "   ")
        self.assertEqual((code, json.loads(out)["reason"]), (1, "nothing to say"))


class VoiceHoldTests(AlertsCase):
    """One voice at a time on the machine: a clip waits for the one playing."""

    def clock(self, start):
        """A clock that moves only when the helper sleeps, so waits are exact."""
        moment = [start]
        slept = []

        def now():
            return moment[0]

        def sleep(seconds):
            slept.append(seconds)
            moment[0] += seconds
        return now, sleep, slept

    def test_a_clip_takes_the_voice_for_its_own_length(self):
        now, sleep, slept = self.clock(NOW)
        self.assertTrue(alerts.hold_voice(self.state, 3.0, now, sleep, wait_seconds=10))
        held = json.loads(alerts.voice_path(self.state).read_text())
        self.assertAlmostEqual(held["until"], NOW + 3.0 + alerts.VOICE_MARGIN_SECONDS)
        self.assertEqual(slept, [])

    def test_a_second_clip_waits_until_the_first_has_finished(self):
        now, sleep, slept = self.clock(NOW)
        self.assertTrue(alerts.hold_voice(self.state, 2.0, now, sleep, wait_seconds=10))
        self.assertTrue(alerts.hold_voice(self.state, 1.0, now, sleep, wait_seconds=10))
        # It started no sooner than the first one's end.
        self.assertGreaterEqual(now(), NOW + 2.0 + alerts.VOICE_MARGIN_SECONDS)
        self.assertTrue(slept)
        held = json.loads(alerts.voice_path(self.state).read_text())
        self.assertGreaterEqual(held["until"], NOW + 3.0 + 2 * alerts.VOICE_MARGIN_SECONDS)

    def test_sessions_speaking_at_once_take_turns_and_never_overlap(self):
        # Each session is its own process, so the turn has to hold across
        # processes with the real clock, not only inside one helper.
        runner = self.root / "voice-runner.py"
        runner.write_text(
            "import json, os, sys, time\n"
            "sys.path.insert(0, {plugin!r})\n"
            "from pathlib import Path\n"
            "from readers import alerts\n"
            "go, state = sys.argv[1], Path(sys.argv[2])\n"
            "read = []\n"
            "def clock():\n"
            "    read.append(time.time())\n"
            "    return read[-1]\n"
            "while not os.path.exists(go):\n"
            "    time.sleep(0.001)\n"
            "held = alerts.hold_voice(state, 0.4, clock=clock, wait_seconds=10)\n"
            # The last reading is the one taken inside the lock as the voice
            # was taken: the clip's start, free of any delay after the return.
            "print(json.dumps({{'held': held, 'start': read[-1]}}))\n".format(
                plugin=str(paths.PLUGIN)))
        clip = 0.4 + alerts.VOICE_MARGIN_SECONDS
        for index in range(3):
            if alerts.voice_path(self.state).exists():
                alerts.voice_path(self.state).unlink()
            go = self.root / ("voice-go-" + str(index))
            racers = [subprocess.Popen([sys.executable, str(runner), str(go), str(self.state)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                      for _ in range(3)]
            time.sleep(0.05)
            go.write_text("go")
            turns = []
            for racer in racers:
                out, err = racer.communicate(timeout=60)
                self.assertEqual(racer.returncode, 0, err)
                turns.append(json.loads(out))
            turns.sort(key=lambda turn: turn["start"])
            self.assertEqual([turn["held"] for turn in turns], [True, True, True])
            # Every clip starts once the one before it has run its length.
            for before, after in zip(turns, turns[1:]):
                # Each start is read where the voice is taken, and a clip is taken
                # only once the one before has passed its end: the gap is a whole
                # clip at least, however late a process ran after its turn.
                self.assertGreaterEqual(after["start"] - before["start"], clip - 0.001, index)

    def test_a_voice_lock_that_is_a_link_is_refused_and_its_target_left_alone(self):
        now, sleep, _ = self.clock(NOW)
        (self.state / alerts.LOCKS).mkdir(parents=True)
        target = self.root / "elsewhere"
        target.write_text("kept")
        make_link(self, self.state / alerts.LOCKS / alerts.VOICE_LOCK, target)
        # Refused by name before any open, as Windows needs, not only by the open.
        with self.assertRaisesRegex(OSError, "is a link"):
            alerts.hold_voice(self.state, 1.0, now, sleep, wait_seconds=5)
        self.assertEqual(target.read_text(), "kept")
        self.assertFalse((self.state / alerts.VOICE_FILE).exists())

    def test_a_clip_that_waits_too_long_gives_up_and_takes_nothing(self):
        now, sleep, _ = self.clock(NOW)
        self.assertTrue(alerts.hold_voice(self.state, 30.0, now, sleep, wait_seconds=10))
        before = alerts.voice_path(self.state).read_text()
        self.assertFalse(alerts.hold_voice(self.state, 1.0, now, sleep, wait_seconds=5))
        self.assertEqual(alerts.voice_path(self.state).read_text(), before)

    def test_a_hold_that_is_unreadable_or_dated_ahead_does_not_stop_the_voice(self):
        now, sleep, _ = self.clock(NOW)
        alerts.voice_path(self.state).parent.mkdir(parents=True, exist_ok=True)
        for broken in ["not json", json.dumps({"until": "soon"}),
                       json.dumps({"until": NOW + 10_000})]:
            alerts.voice_path(self.state).write_text(broken)
            self.assertTrue(alerts.hold_voice(self.state, 1.0, now, sleep, wait_seconds=5),
                            broken)

    def test_a_clip_is_measured_from_its_own_samples(self):
        path = self.temp / "fleet-speak-measured.wav"
        with wave.open(str(path), "wb") as clip:
            clip.setnchannels(1)
            clip.setsampwidth(2)
            clip.setframerate(24000)
            clip.writeframes(b"\x00\x00" * 36000)
        self.assertAlmostEqual(alerts.clip_seconds(path, "anything"), 1.5)
        # A file that is not a readable clip is timed by its words instead.
        bogus = self.temp / "fleet-speak-bogus.wav"
        bogus.write_bytes(b"RIFF....WAVE")
        guessed = alerts.clip_seconds(bogus, "one two three four five six seven eight nine ten")
        self.assertGreaterEqual(guessed, 3.0)

    @unittest.skipIf(os.name == "nt", "the stub synthesizer is a script run through its shebang")
    def test_speak_reports_the_clip_length_and_holds_the_voice_for_it(self):
        code, out = self.run_main("speak", "--voice", "af_sky", "--", "Build waits on you.")
        spoken = json.loads(out)
        self.assertEqual(code, 0)
        self.assertGreater(spoken["seconds"], 0)
        self.assertTrue(alerts.voice_path(self.state).exists())

    @unittest.skipIf(os.name == "nt", "the stub synthesizer is a script run through its shebang")
    def test_speak_while_another_session_holds_the_voice_too_long_leaves_no_file(self):
        alerts.voice_path(self.state).parent.mkdir(parents=True, exist_ok=True)
        alerts.voice_path(self.state).write_text(json.dumps({"until": NOW + 300}))
        spoken = alerts.speak(self.config(), "af_sky", "Build waits on you.", self.environ,
                              state_dir=self.state, clock=lambda: NOW,
                              sleep=lambda seconds: None, wait_seconds=0)
        self.assertIsNone(spoken["file"])
        self.assertEqual(spoken["reason"], "another session is still speaking")
        self.assertEqual(list(self.temp.glob("fleet-speak-*.wav")), [])


class DiscardTests(AlertsCase):
    def test_a_file_speak_wrote_is_removed(self):
        target = self.temp / "fleet-speak-abc123.wav"
        target.write_bytes(b"x")
        self.assertEqual(self.run_main("discard", str(target))[0], 0)
        self.assertFalse(target.exists())

    def test_anything_else_is_refused_and_kept(self):
        outside = self.root / "fleet-speak-abc123.wav"
        wrong_name = self.temp / "notes.wav"
        for path in (outside, wrong_name):
            path.write_bytes(b"x")
            self.assertEqual(self.run_main("discard", str(path))[0], 2, path)
            self.assertTrue(path.exists(), path)

    @unittest.skipIf(os.name == "nt", "creating a symbolic link needs a privilege on Windows")
    def test_a_link_is_refused_and_its_target_kept(self):
        kept = self.root / "kept.txt"
        kept.write_text("kept")
        link = self.temp / "fleet-speak-abc123.wav"
        link.symlink_to(kept)
        self.assertEqual(self.run_main("discard", str(link))[0], 2)
        self.assertTrue(kept.exists())


class QuestionTests(AlertsCase):
    """What a waiting job asks now, read from its own state file before a reply goes."""

    def setUp(self):
        super().setUp()
        self.home = self.root / "provider"
        (self.home / "jobs").mkdir(parents=True)
        path = self.root / "config.json"
        path.write_text(json.dumps({
            "stateDir": str(self.state),
            "providers": [{"id": "one", "home": str(self.home)},
                          {"id": "off", "home": str(self.root / "absent")}],
            "limits": {"questionCharacters": 12}}))

    def job(self, job_id, document):
        folder = self.home / "jobs" / job_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").write_text(json.dumps(document), encoding="utf-8")

    def ask(self, provider, job_id):
        code, out = self.run_main("question", provider, job_id)
        return code, json.loads(out)

    def test_the_question_is_cut_as_the_roster_cut_it(self):
        self.job("job-1", {"needs": "Merge it now?\x07 or wait", "suggestedReply": "wait"})
        code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 0)
        self.assertEqual(asked, {"state": "ready", "needs": "Merge it now",
                                 "needsHash": jobs.question_digest("Merge it now?\x07 or wait"),
                                 "sessionId": None, "held": False, "reason": None})

    def test_the_whole_question_is_hashed_so_a_shared_prefix_is_not_the_same_question(self):
        shared = "w" * 200
        self.job("job-1", {"needs": shared + " the first?"})
        self.job("job-2", {"needs": shared + " the second?"})
        first = self.ask("one", "job-1")[1]
        second = self.ask("one", "job-2")[1]
        self.assertEqual(first["needs"], second["needs"])
        self.assertNotEqual(first["needsHash"], second["needsHash"])
        self.assertEqual(first["needsHash"], jobs.question_digest(shared + " the first?"))

    def test_the_session_is_read_from_the_job_file_itself(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "session-on-disk"})
        self.assertEqual(self.ask("one", "job-1")[1]["sessionId"], "session-on-disk")
        # A session that is not a string names no session to send to.
        self.job("job-2", {"needs": "Go?", "sessionId": 42})
        self.assertEqual(self.ask("one", "job-2")[1]["sessionId"], None)

    def link(self, target, link):
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("this platform does not allow creating a symbolic link here")

    def test_a_job_folder_reached_through_a_link_is_refused(self):
        outside = self.root / "outside" / "jobs" / "job-1"
        outside.mkdir(parents=True)
        (outside / "state.json").write_text(json.dumps({"needs": "Go?", "sessionId": "x"}),
                                            encoding="utf-8")
        # The job's own folder is a link out of the home.
        self.link(outside, self.home / "jobs" / "job-1")
        code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 1)
        self.assertEqual(asked["state"], "unavailable")
        self.assertIn("link", asked["reason"])
        self.assertEqual((asked["needs"], asked["sessionId"]), (None, None))

    def test_an_ancestor_reached_through_a_link_is_refused(self):
        outside = self.root / "outside" / "jobs" / "job-1"
        outside.mkdir(parents=True)
        (outside / "state.json").write_text(json.dumps({"needs": "Go?", "sessionId": "x"}),
                                            encoding="utf-8")
        (self.home / "jobs").rmdir()
        # The jobs folder above the job is the link, so the job folder is not.
        self.link(self.root / "outside" / "jobs", self.home / "jobs")
        code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 1)
        self.assertIn("link", asked["reason"])

    def take(self, holder, *extra, now=NOW):
        code, out = self.run_main_at(now, "question", "one", "job-1", "--holder", holder, *extra)
        return code, json.loads(out)

    def run_main_at(self, now, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alerts.main(["--config", str(self.root / "config.json"), "--now", str(now),
                                *argv], environ=self.environ)
        return code, out.getvalue()

    def release(self, holder, needs="Go?", *extra, now=NOW):
        return self.run_main_at(now, "release", "one", "job-1", "--job-session", "s-1", "--hash",
                                jobs.question_digest(needs), "--holder", holder, *extra)[0]

    def confirm(self, holder, needs="Go?", now=NOW):
        return self.run_main_at(now, "confirm", "one", "job-1", "--job-session", "s-1", "--hash",
                                jobs.question_digest(needs), "--holder", holder)[0]

    def body(self, job_id="job-1", needs="Go?"):
        return json.loads(self.marker(job_id, needs).read_text())

    def marker(self, job_id, needs, session="s-1"):
        return alerts.reply_marker_path(self.state, "one", job_id, session,
                                        jobs.question_digest(needs))

    def markers(self):
        folder = self.state / alerts.REPLY_ANSWERS
        if not folder.exists():
            return []
        return sorted(path.name for path in folder.iterdir() if path.name.endswith(alerts.ANSWERED))

    def test_a_question_is_held_for_one_reply_and_stays_answered_after_it(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        code, first = self.take("pane-a")
        self.assertEqual((code, first["state"], first["held"]), (0, "ready", True))
        self.assertEqual((first["needsHash"], first["sessionId"]),
                         (jobs.question_digest("Go?"), "s-1"))
        # A second pane submitting while the first sends is refused, and so is the
        # first pane asking again: the question has its one reply.
        for holder in ("pane-b", "pane-a"):
            code, again = self.take(holder)
            self.assertEqual((code, again["state"], again["held"]), (1, "answered", False))
            self.assertEqual(again["reason"], "already answered")
            self.assertEqual(again["needsHash"], None)

    def test_no_time_hands_a_question_to_another_pane(self):
        # A sender that is slow, or a pane that died mid-send, keeps the question:
        # nothing resends it on its own.
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        for later in (NOW + 31, NOW + 3600, NOW + 86400 * 30):
            self.assertEqual(self.take("pane-b", now=later)[1]["state"], "answered", later)

    def test_a_pane_a_reading_behind_sends_nothing_after_a_reply_went(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        digest = jobs.question_digest("Go?")
        self.assertEqual(self.take("pane-a", "--hash", digest, "--job-session", "s-1")[1]["held"],
                         True)
        # The send went, so nothing was released; a stale pane typed for the same question.
        code, stale = self.take("pane-b", "--hash", digest, "--job-session", "s-1")
        self.assertEqual((code, stale["state"], stale["held"]), (1, "answered", False))

    def test_a_failed_send_released_by_its_holder_can_be_tried_again(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        # Another pane cannot release it, and a release that is not for a failure is refused.
        self.assertEqual(self.release("pane-b", "Go?", "--failed"), 1)
        self.assertEqual(self.release("pane-a"), 2)
        self.assertEqual(self.take("pane-b")[1]["state"], "answered")
        self.assertEqual(self.release("pane-a", "Go?", "--failed"), 0)
        self.assertEqual(self.markers(), [])
        self.assertEqual(self.take("pane-b")[1]["held"], True)

    def test_the_same_question_asked_again_by_a_restarted_job_is_free(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        # The reply went to the old session; the job now asks the same words anew.
        self.job("job-1", {"needs": "Go?", "sessionId": "s-2"})
        code, asked = self.take("pane-b")
        self.assertEqual((code, asked["held"], asked["sessionId"]), (0, True, "s-2"))
        self.assertEqual(self.take("pane-c")[1]["state"], "answered")

    def test_a_new_question_is_free_after_the_last_one_was_answered(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        self.job("job-1", {"needs": "And now?", "sessionId": "s-1"})
        code, asked = self.take("pane-b")
        self.assertEqual((code, asked["held"], asked["needsHash"]),
                         (0, True, jobs.question_digest("And now?")))

    def test_a_question_asked_without_a_holder_records_nothing(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        code, asked = self.ask("one", "job-1")
        self.assertEqual((code, asked["held"]), (0, False))
        self.assertEqual(self.markers(), [])
        self.assertEqual(self.take("pane-a")[1]["held"], True)

    def test_a_reply_typed_for_another_question_or_session_records_nothing(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        digest = jobs.question_digest("Go?")
        code, moved = self.take("pane-a", "--hash", "another", "--job-session", "s-1")
        self.assertEqual((code, moved["state"], moved["held"]), (1, "question-changed", False))
        code, restarted = self.take("pane-a", "--hash", digest, "--job-session", "s-0")
        self.assertEqual((code, restarted["state"], restarted["held"]), (1, "session-changed", False))
        self.assertEqual(self.markers(), [])
        code, asked = self.take("pane-c", "--hash", digest, "--job-session", "s-1")
        self.assertEqual((code, asked["state"], asked["held"]), (0, "ready", True))

    def test_a_job_that_cannot_be_read_or_asks_nothing_records_nothing(self):
        self.assertEqual(self.take("pane-a")[1]["state"], "unavailable")
        self.job("job-1", {"needs": None, "sessionId": "s-1"})
        code, asked = self.take("pane-a")
        self.assertEqual((code, asked["state"], asked["held"]), (1, "question-changed", False))
        self.assertEqual(self.markers(), [])
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-b")[1]["held"], True)

    def test_a_holder_that_could_name_a_path_is_refused(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        code, asked = self.take("../pane")
        self.assertEqual((code, asked["state"], asked["held"]), (1, "unavailable", False))
        self.assertEqual(self.markers(), [])
        self.assertEqual(self.take("pane-a")[1]["held"], True)

    def test_a_link_planted_where_the_marker_goes_is_refused_and_not_followed(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        victim = self.root / "victim"
        victim.write_text("keep me")
        marker = self.marker("job-1", "Go?")
        marker.parent.mkdir(parents=True)
        self.link(victim, marker)
        code, asked = self.take("pane-a")
        self.assertEqual((code, asked["state"], asked["held"]), (1, "unreadable", False))
        self.assertIn("is a link", asked["reason"])
        self.assertEqual(victim.read_text(), "keep me")
        # Cleared from the row, the link goes and what it points at stays.
        self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 0)
        self.assertFalse(os.path.lexists(marker))
        self.assertEqual(victim.read_text(), "keep me")

    def test_a_marker_folder_that_is_a_link_is_refused(self):
        if not hasattr(os, "O_NOFOLLOW"):
            self.skipTest("this platform has no link-refusing open")
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.state.mkdir(parents=True)
        self.link(elsewhere, self.state / alerts.REPLY_ANSWERS)
        code, asked = self.take("pane-a")
        self.assertEqual((code, asked["state"], asked["held"]), (1, "locked", False))
        self.assertEqual(asked["reason"], "reply-answers is a link; remove the link")
        self.assertEqual(list(elsewhere.iterdir()), [])
        # A marker planted where the link leads is not read through it.
        planted = alerts.reply_marker_path(self.root, "one", "job-1", "s-1", jobs.question_digest("Go?"))
        (elsewhere / planted.name).write_text(json.dumps({"state": "sent", "at": NOW}))
        self.assertIsNone(alerts.reply_marker(self.state, "one", "job-1", "s-1",
                                              jobs.question_digest("Go?")))

    def test_markers_for_jobs_gone_from_the_roster_are_pruned(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.job("job-2", {"needs": "Go?", "sessionId": "s-2"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        code, out = self.run_main_at(NOW, "question", "one", "job-2", "--holder", "pane-a")
        self.assertEqual(json.loads(out)["held"], True)
        kept = self.marker("job-1", "Go?")
        gone = self.marker("job-2", "Go?", "s-2")
        shutil.rmtree(self.home / "jobs" / "job-2")
        self.job("job-1", {"needs": "Next?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        self.assertTrue(kept.exists())
        self.assertFalse(gone.exists())
        self.assertEqual(len(self.markers()), 2)

    def test_live_markers_past_the_cap_refuse_the_reply_and_none_is_pruned(self):
        self.job("job-2", {"needs": "Gone?", "sessionId": "s-2"})
        code, out = self.run_main_at(NOW, "question", "one", "job-2", "--holder", "pane-a")
        self.assertEqual(json.loads(out)["held"], True)
        with mock.patch.object(alerts, "REPLY_MARKER_LIMIT", 3):
            for index in range(2):
                needs = "Q{0}?".format(index)
                self.job("job-1", {"needs": needs, "sessionId": "s-1"})
                self.assertEqual(self.take("pane-a", now=NOW + index)[1]["held"], True)
            # Three live markers: the next reply is refused, and every live one is kept.
            self.job("job-1", {"needs": "Q2?", "sessionId": "s-1"})
            code, full = self.take("pane-a", now=NOW + 5)
            self.assertEqual((code, full["state"], full["held"]), (1, "full", False))
            self.assertEqual(full["reason"], "3 replies are held for jobs still waiting")
            self.assertEqual(len(self.markers()), 3)
            for needs in ("Q0?", "Q1?"):
                self.assertTrue(self.marker("job-1", needs).exists(), needs)
            # A job gone from its home frees its marker, and the reply is then recorded.
            shutil.rmtree(self.home / "jobs" / "job-2")
            self.assertEqual(self.take("pane-a", now=NOW + 6)[1]["held"], True)
        self.assertFalse(self.marker("job-2", "Gone?", "s-2").exists())
        self.assertEqual(len(self.markers()), 3)

    def test_a_new_marker_is_pending_and_its_holder_confirms_it_sent(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        self.assertEqual((self.body()["state"], self.body()["at"]), ("pending", NOW))
        self.assert_owner_only(self.marker("job-1", "Go?"))
        # Only the holder confirms it.
        self.assertEqual(self.confirm("pane-b"), 1)
        self.assertEqual(self.body()["state"], "pending")
        self.assertEqual(self.confirm("pane-a", now=NOW + 2), 0)
        self.assertEqual((self.body()["state"], self.body()["sentAt"]), ("sent", NOW + 2))
        # Recorded once: a second record changes nothing.
        self.assertEqual(self.confirm("pane-a", now=NOW + 3), 1)
        self.assertEqual(self.body()["sentAt"], NOW + 2)
        self.assert_owner_only(self.marker("job-1", "Go?"))
        # A confirmed reply is never given back, as failed or as stale.
        self.assertEqual(self.release("pane-a", "Go?", "--failed"), 1)
        self.assertEqual(self.release("pane-z", "Go?", "--stale", now=NOW + 86400), 1)
        self.assertEqual(self.body()["state"], "sent")
        self.assertEqual(self.take("pane-b", now=NOW + 86400)[1]["state"], "answered")

    def test_a_confirm_with_no_marker_or_through_a_link_records_nothing(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.confirm("pane-a"), 1)
        self.assertEqual(self.markers(), [])
        # A link at the marker's name, aimed at a pending marker someone planted.
        planted = self.root / "planted"
        planted.write_text(json.dumps({"state": "pending", "holder": "pane-a", "at": NOW}))
        self.marker("job-1", "Go?").parent.mkdir(parents=True, exist_ok=True)
        self.link(planted, self.marker("job-1", "Go?"))
        self.assertEqual(self.confirm("pane-a"), 1)
        self.assertEqual(self.release("pane-a", "Go?", "--failed"), 1)
        self.assertEqual(json.loads(planted.read_text())["state"], "pending")
        self.assertTrue(self.marker("job-1", "Go?").is_symlink())

    def test_a_pending_marker_older_than_the_configured_time_can_be_cleared_once(self):
        path = self.root / "config.json"
        document = json.loads(path.read_text())
        document["pane"] = {"replyPendingSeconds": 60}
        path.write_text(json.dumps(document))
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        # Inside its time a pending reply may still be on its way: not cleared.
        self.assertEqual(self.release("pane-z", "Go?", "--stale", now=NOW + 59), 1)
        self.assertEqual(self.body()["state"], "pending")
        self.assertEqual(self.release("pane-z", "Go?", "--stale", now=NOW + 61), 0)
        self.assertEqual(self.markers(), [])
        # Cleared, the question takes one reply again, and only one.
        self.assertEqual(self.take("pane-b", now=NOW + 62)[1]["held"], True)
        self.assertEqual(self.take("pane-c", now=NOW + 63)[1]["state"], "answered")

    def prune_sent(self):
        code, out = self.run_main_at(NOW + 100, "release", "--prune-sent")
        return code, json.loads(out) if out.strip() else None

    def test_clearing_answered_replies_removes_only_sent_ones_that_no_longer_answer(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.job("job-2", {"needs": "Go?", "sessionId": "s-2"})
        self.job("job-3", {"needs": "Go?", "sessionId": "s-3"})
        self.job("job-4", {"needs": "Go?", "sessionId": "s-4"})
        for job_id in ("job-1", "job-2", "job-3", "job-4"):
            code, out = self.run_main_at(NOW, "question", "one", job_id, "--holder", "pane-a")
            self.assertEqual(json.loads(out)["held"], True, job_id)
        state = alerts.state_root(Path(json.loads((self.root / "config.json").read_text())["stateDir"]))
        digest = jobs.question_digest("Go?")
        for job_id, session in (("job-1", "s-1"), ("job-2", "s-2"), ("job-3", "s-3")):
            self.assertTrue(alerts.confirm_reply(state, "one", job_id, session, digest, "pane-a", NOW))
        # job-1 moved on to another question and job-2 left its home: theirs go.
        # job-3 still asks what was answered, and job-4's reply is still pending
        # even though its question moved on: both stay.
        self.job("job-1", {"needs": "Next?", "sessionId": "s-1"})
        shutil.rmtree(self.home / "jobs" / "job-2")
        self.job("job-4", {"needs": "Next?", "sessionId": "s-4"})
        code, removed = self.prune_sent()
        self.assertEqual((code, removed), (0, {"removed": 2}))
        self.assertFalse(self.marker("job-1", "Go?").exists())
        self.assertFalse(self.marker("job-2", "Go?", "s-2").exists())
        self.assertTrue(self.marker("job-3", "Go?", "s-3").exists())
        self.assertEqual(json.loads(self.marker("job-4", "Go?", "s-4").read_text())["state"], "pending")
        # Nothing left to clear says so.
        self.assertEqual(self.prune_sent(), (1, {"removed": 0}))

    def test_clearing_answered_replies_never_removes_a_pending_one(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        self.job("job-1", {"needs": "Next?", "sessionId": "s-1"})
        self.assertEqual(self.prune_sent(), (1, {"removed": 0}))
        self.assertEqual(self.body()["state"], "pending")

    def test_a_release_names_failed_or_stale_and_not_both(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        self.assertEqual(self.release("pane-a"), 2)
        self.assertEqual(self.release("pane-a", "Go?", "--failed", "--stale"), 2)
        self.assertEqual(self.release("pane-a", "Go?", "--failed", "--unreadable"), 2)
        self.assertEqual(self.release("pane-a", "Go?", "--stale", "--unreadable"), 2)
        self.assertEqual(self.body()["state"], "pending")

    def temps(self):
        folder = self.state / alerts.REPLY_ANSWERS
        return sorted(path.name for path in folder.iterdir() if path.name.endswith(".tmp"))

    def killed_at(self, step, holder="pane-a"):
        """Ask for a question in a child process that dies at `step`, cleaning nothing up."""
        if not hasattr(os, "fork"):
            self.skipTest("a helper killed mid-write is staged with fork")
        child = os.fork()
        if child == 0:
            def die(name):
                if name == step:
                    os._exit(9)
            alerts._between = die
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.take(holder)
            finally:
                os._exit(0)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 9, "the helper never reached " + step)

    def test_a_helper_killed_before_its_marker_is_published_leaves_the_question_answerable(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.killed_at("marker")
        # The whole body was written to a file of its own; no marker was published.
        self.assertEqual(self.markers(), [])
        self.assertEqual(len(self.temps()), 1)
        self.assertEqual(json.loads((self.state / alerts.REPLY_ANSWERS / self.temps()[0]).read_text())
                         ["state"], "pending")
        code, asked = self.take("pane-b")
        self.assertEqual((code, asked["held"]), (0, True))

    def test_a_helper_killed_after_publishing_leaves_a_whole_pending_marker(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.killed_at("marker-published")
        self.assertEqual(self.body()["state"], "pending")
        self.assertEqual(alerts.reply_marker(self.state, "one", "job-1", "s-1", jobs.question_digest("Go?")),
                         {"state": "pending", "at": NOW})
        self.assertEqual(self.take("pane-b")[1]["state"], "answered")
        # The file it was published from stays until it is older than a reply may
        # be pending, and then the next question sweeps it.
        stray = self.state / alerts.REPLY_ANSWERS / self.temps()[0]
        os.utime(stray, (NOW - 119, NOW - 119))
        self.job("job-2", {"needs": "Go?", "sessionId": "s-2"})
        self.run_main_at(NOW, "question", "one", "job-2", "--holder", "pane-a")
        self.assertEqual(len(self.temps()), 1)
        os.utime(stray, (NOW - 121, NOW - 121))
        self.run_main_at(NOW, "question", "one", "job-2", "--holder", "pane-a")
        self.assertEqual(self.temps(), [])
        self.assertEqual(self.body()["state"], "pending")

    def test_a_marker_that_appears_while_one_is_written_is_never_overwritten(self):
        # Publishing is a link, which fails on a name already there; a rename would
        # replace it and hand the question a second reply.
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        marker = self.marker("job-1", "Go?")
        planted = json.dumps({"state": "sent", "holder": "pane-z", "at": NOW - 5})

        def plant(step):
            if step == "marker":
                marker.write_text(planted)

        with mock.patch.object(alerts, "_between", plant):
            code, asked = self.take("pane-a")
        self.assertEqual((code, asked["state"], asked["held"]), (1, "answered", False))
        self.assertEqual(marker.read_text(), planted)
        self.assertEqual(self.temps(), [])

    def test_a_truncated_marker_reads_unreadable_and_only_a_clear_of_one_removes_it(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        marker = self.marker("job-1", "Go?")
        marker.parent.mkdir(parents=True)
        for cut in ("", '{"state": "pen', '{"state": "pending"}', "[]"):
            marker.write_text(cut)
            stands = alerts.reply_marker(self.state, "one", "job-1", "s-1", jobs.question_digest("Go?"))
            self.assertEqual((stands["state"], stands["at"]), ("unreadable", None), cut)
            code, asked = self.take("pane-a")
            self.assertEqual((code, asked["state"], asked["held"]), (1, "unreadable", False), cut)
            self.assertIn("could not be read", asked["reason"])
            # Neither a failed send nor a stale reply clears it: only its own press.
            self.assertEqual(self.release("pane-a", "Go?", "--failed"), 1)
            self.assertEqual(self.release("pane-z", "Go?", "--stale", now=NOW + 86400), 1)
            self.assertTrue(marker.exists())
        self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 0)
        self.assertFalse(marker.exists())
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        # A marker that reads is never removed as unreadable, pending or sent.
        self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 1)
        self.assertEqual(self.body()["state"], "pending")
        self.assertEqual(self.confirm("pane-a"), 0)
        self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 1)
        self.assertEqual(self.body()["state"], "sent")
        # Nothing there is nothing to clear.
        self.job("job-1", {"needs": "Other?", "sessionId": "s-1"})
        self.assertEqual(self.release("pane-z", "Other?", "--unreadable"), 1)

    def test_a_marker_whose_time_is_not_finite_reads_unreadable_and_is_cleared_by_its_press(self):
        # JSON has no infinity, but Python reads 1e309 as one and writes it back
        # as Infinity, which the pane's parser refuses, so the row would lose it.
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        marker = self.marker("job-1", "Go?")
        marker.parent.mkdir(parents=True)
        # A 400-digit integer is finite to JSON but past what a float holds.
        for at in ("1e309", "-1e309", "NaN", "Infinity", "1" + "0" * 400):
            marker.write_text('{"state": "pending", "holder": "pane-z", "at": %s}' % at)
            stands = alerts.reply_marker(self.state, "one", "job-1", "s-1", jobs.question_digest("Go?"))
            self.assertEqual(stands["state"], "unreadable", at)
            json.dumps(stands, allow_nan=False)
            self.assertEqual(self.release("pane-z", "Go?", "--stale", now=NOW + 86400), 1, at)
            self.assertTrue(marker.exists(), at)
        self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 0)
        self.assertFalse(marker.exists())

    def test_each_unreadable_marker_is_named_so_a_clear_of_one_does_not_hide_the_next(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        marker = self.marker("job-1", "Go?")
        marker.parent.mkdir(parents=True)
        marker.write_text("")
        digest = jobs.question_digest("Go?")
        first = alerts.reply_marker(self.state, "one", "job-1", "s-1", digest)
        self.assertIsInstance(first["id"], str)
        self.assertEqual(alerts.reply_marker(self.state, "one", "job-1", "s-1", digest), first)
        self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 0)
        # Another pane's record for the same question goes bad afterwards: a new file.
        marker.write_text('{"state": "pen')
        os.utime(marker, ns=(1, 1))
        second = alerts.reply_marker(self.state, "one", "job-1", "s-1", digest)
        self.assertEqual(second["state"], "unreadable")
        self.assertNotEqual(second["id"], first["id"])

    def test_a_temp_file_swapped_for_a_link_before_publishing_is_never_published(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        outside = self.root / "outside.json"
        planted = json.dumps({"state": "sent", "holder": "pane-z", "at": NOW})
        outside.write_text(planted)
        os.chmod(outside, 0o644)
        # What the platform reports for it: Windows keeps no group or other bits.
        mode_before = stat.S_IMODE(outside.stat().st_mode)
        folder = self.state / alerts.REPLY_ANSWERS

        def swap(step):
            if step == "marker":
                temp = folder / self.temps()[0]
                temp.unlink()
                temp.symlink_to(outside)

        with mock.patch.object(alerts, "_between", swap):
            code, asked = self.take("pane-a")
        self.assertNotEqual(code, 0)
        self.assertFalse(asked["held"])
        self.assertIn("was changed after it was written", asked["reason"])
        self.assertEqual(self.markers(), [])
        self.assertEqual(self.temps(), [])
        self.assertEqual(outside.read_text(), planted)
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), mode_before)
        # Nothing was published, so the question is still answerable.
        self.assertEqual(self.take("pane-b")[1]["held"], True)

    def swap_temp_at(self, step, outside):
        """A hook that swaps the reply folder's one temporary file for a link at `step`."""
        folder = self.state / alerts.REPLY_ANSWERS

        def swap(name):
            if name == step:
                temp = folder / self.temps()[0]
                temp.unlink()
                temp.symlink_to(outside)
        return swap

    def test_a_temp_file_swapped_once_checked_is_taken_back_off_the_marker_s_name(self):
        # The swap lands between the check and the link: the link is made to the
        # link itself, and the name is found not to hold the file written.
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        outside = self.root / "outside.json"
        planted = json.dumps({"state": "sent", "holder": "pane-z", "at": NOW})
        outside.write_text(planted)
        with mock.patch.object(alerts, "_between", self.swap_temp_at("publish-checked", outside)):
            code, asked = self.take("pane-a")
        self.assertNotEqual(code, 0)
        self.assertFalse(asked["held"])
        self.assertIn("was changed while it was put in place", asked["reason"])
        self.assertEqual(self.markers(), [])
        self.assertEqual(self.temps(), [])
        self.assertEqual(outside.read_text(), planted)
        self.assertEqual(outside.stat().st_nlink, 1)
        self.assertEqual(self.take("pane-b")[1]["held"], True)

    def test_a_temp_file_swapped_once_checked_for_a_confirm_leaves_the_question_held(self):
        # Put in place over the pending marker, the link is left as it landed: it
        # reads as a record that does not read, which still holds the question.
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        outside = self.root / "outside.json"
        planted = json.dumps({"state": "pending", "holder": "pane-a", "at": NOW})
        outside.write_text(planted)
        with mock.patch.object(alerts, "_between", self.swap_temp_at("replace-checked", outside)):
            self.assertNotEqual(self.confirm("pane-a"), 0)
        self.assertEqual(outside.read_text(), planted)
        stands = alerts.reply_marker(self.state, "one", "job-1", "s-1", jobs.question_digest("Go?"))
        self.assertEqual(stands["state"], "unreadable")
        code, asked = self.take("pane-b")
        self.assertEqual((code, asked["state"], asked["held"]), (1, "unreadable", False))

    def test_a_temp_file_swapped_for_a_link_before_a_confirm_is_never_put_in_place(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        self.assertEqual(self.take("pane-a")[1]["held"], True)
        outside = self.root / "outside.json"
        planted = json.dumps({"state": "sent", "holder": "pane-a", "at": NOW})
        outside.write_text(planted)
        folder = self.state / alerts.REPLY_ANSWERS

        def swap(step):
            if step == "replace":
                temp = folder / self.temps()[0]
                temp.unlink()
                temp.symlink_to(outside)

        with mock.patch.object(alerts, "_between", swap):
            self.assertNotEqual(self.confirm("pane-a"), 0)
        self.assertFalse(self.marker("job-1", "Go?").is_symlink())
        self.assertEqual(self.body()["state"], "pending")
        self.assertEqual(self.temps(), [])
        self.assertEqual(outside.read_text(), planted)

    def test_without_folder_handles_a_reply_is_held_published_confirmed_and_cleared_by_name(self):
        # What Windows does: every file is reached by its path, a link refused first.
        with mock.patch.object(alerts, "_directory_handles", return_value=False):
            self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
            self.assertEqual(self.take("pane-a")[1]["held"], True)
            self.assertEqual(self.take("pane-b")[1]["state"], "answered")
            self.assertEqual(self.temps(), [])
            self.assertEqual(self.confirm("pane-a"), 0)
            self.assertEqual(self.body()["state"], "sent")
            self.marker("job-1", "Go?").write_text("{")
            self.assertEqual(self.take("pane-b")[1]["state"], "unreadable")
            self.assertEqual(self.release("pane-z", "Go?", "--unreadable"), 0)
            self.assertEqual(self.take("pane-b")[1]["held"], True)
            self.job("job-1", {"needs": "Next?", "sessionId": "s-1"})
            self.assertEqual(self.release("pane-b", "Go?", "--failed"), 0)

    def test_a_marker_folder_swapped_for_a_link_while_a_marker_is_written_is_not_followed(self):
        if not alerts._directory_handles():
            self.skipTest("this platform reaches files by name; the swap is named in the docs")
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        folder = self.state / alerts.REPLY_ANSWERS
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        swapped = []

        def swap(step):
            if step == "marker" and not swapped:
                folder.rename(self.state / "answers-real")
                os.symlink(elsewhere, folder)
                swapped.append(step)

        with mock.patch.object(alerts, "_between", swap):
            code, asked = self.take("pane-a")
        self.assertEqual(swapped, ["marker"])
        self.assertEqual((code, asked["held"]), (0, True))
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertTrue((self.state / "answers-real" / self.marker("job-1", "Go?").name).is_file())

    def test_two_processes_racing_for_one_question_never_both_hold_it(self):
        self.job("job-1", {"needs": "Go?", "sessionId": "s-1"})
        runner = self.root / "runner.py"
        runner.write_text(
            "import os, sys, time\n"
            "sys.path.insert(0, {plugin!r})\n"
            "from readers import alerts\n"
            "go, holder, now = sys.argv[1], sys.argv[2], sys.argv[3]\n"
            "while not os.path.exists(go):\n"
            "    time.sleep(0.001)\n"
            "sys.exit(alerts.main(['--config', {config!r}, '--now', now, 'question', 'one',"
            " 'job-1', '--holder', holder]))\n".format(
                plugin=str(paths.PLUGIN),
                config=str(self.root / "config.json")))
        winners = []
        for index in range(8):
            answers = self.state / alerts.REPLY_ANSWERS
            if answers.exists():
                shutil.rmtree(answers)
            go = self.root / ("go-" + str(index))
            racers = [subprocess.Popen([sys.executable, str(runner), str(go), name, str(NOW)],
                                       stdout=subprocess.PIPE, env={**os.environ, **self.environ})
                      for name in ("pane-a", "pane-b")]
            time.sleep(0.05)
            go.write_text("go")
            held = [json.loads(racer.communicate(timeout=60)[0])["held"] for racer in racers]
            winners.append(held.count(True))
        self.assertEqual(winners, [1] * 8)

    def test_without_folder_descriptors_a_linked_part_is_refused_by_name(self):
        outside = self.outside_job("outside")
        self.link(outside, self.home / "jobs" / "job-1")
        with mock.patch.object(jobs, "_WALKS", False):
            code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 1)
        self.assertEqual(asked["reason"], "the job's state is reached through a link")

    def outside_job(self, needs):
        """A job folder outside the home, holding a question a swap would point at."""
        outside = self.root / "outside" / "jobs" / "job-1"
        outside.mkdir(parents=True)
        (outside / "state.json").write_text(json.dumps({"needs": needs, "sessionId": "x"}),
                                            encoding="utf-8")
        return outside

    def walks(self):
        if not getattr(jobs, "_WALKS", True):
            self.skipTest("this platform cannot open a folder relative to another")

    def test_an_ancestor_swapped_for_a_link_after_it_was_opened_is_not_followed(self):
        self.walks()
        self.job("job-1", {"needs": "inside", "sessionId": "s-1"})
        self.outside_job("outside")

        def swap(name):
            # Once the walk is past the jobs folder, the folder is swapped for a
            # link out of the home; what was already opened must be what is read.
            if name == "state.json":
                (self.home / "jobs").rename(self.home / "jobs-real")
                self.link(self.root / "outside" / "jobs", self.home / "jobs")

        with mock.patch.object(jobs, "_between", swap):
            code, asked = self.ask("one", "job-1")
        self.assertNotEqual(asked["needs"], "outside")
        self.assertEqual((code, asked["needs"], asked["sessionId"]), (0, "inside", "s-1"))

    def test_a_job_folder_swapped_for_a_link_mid_walk_is_refused(self):
        self.walks()
        self.job("job-1", {"needs": "inside", "sessionId": "s-1"})
        outside = self.outside_job("outside")

        def swap(name):
            if name == "job-1":
                real = self.home / "jobs" / "job-1"
                (real / "state.json").unlink()
                real.rmdir()
                self.link(outside, real)

        with mock.patch.object(jobs, "_between", swap):
            code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 1)
        self.assertIn("link", asked["reason"])
        self.assertEqual(asked["needs"], None)

    def test_without_folder_descriptors_a_swap_before_the_real_path_check_is_refused(self):
        # Where a folder cannot be opened relative to another (Windows), the path
        # is checked part by part and then by its real path. A swap staged between
        # the two is what the real-path check is there to catch.
        self.job("job-1", {"needs": "inside", "sessionId": "s-1"})
        self.outside_job("outside")

        def swap(name):
            if name == "realpath":
                (self.home / "jobs").rename(self.home / "jobs-real")
                self.link(self.root / "outside" / "jobs", self.home / "jobs")

        with mock.patch.object(jobs, "_WALKS", False), mock.patch.object(jobs, "_between", swap):
            code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 1)
        self.assertEqual(asked["reason"], "the job's state lies outside its home")
        self.assertEqual(asked["needs"], None)

    def test_a_home_that_is_itself_a_link_is_read_where_it_leads(self):
        # The home is the configured root: a link there is the person's own choice,
        # and only what lies below it must stay inside it.
        real = self.root / "real-home"
        (real / "jobs" / "job-1").mkdir(parents=True)
        (real / "jobs" / "job-1" / "state.json").write_text(
            json.dumps({"needs": "Go?", "sessionId": "s-1"}), encoding="utf-8")
        linked = self.root / "linked-home"
        self.link(real, linked)
        path = self.root / "config.json"
        path.write_text(json.dumps({"stateDir": str(self.state),
                                    "providers": [{"id": "one", "home": str(linked)}]}))
        code, asked = self.ask("one", "job-1")
        self.assertEqual(code, 0)
        self.assertEqual(asked["sessionId"], "s-1")

    def test_a_job_that_stopped_asking_answers_no_question(self):
        self.job("job-1", {"needs": None, "detail": "working again"})
        self.assertEqual(self.ask("one", "job-1"), (0, {"state": "ready", "needs": None,
                                                      "needsHash": None, "sessionId": None,
                                                      "held": False, "reason": None}))

    def test_a_job_whose_state_cannot_be_read_is_a_reason_not_a_question(self):
        code, asked = self.ask("one", "missing")
        self.assertEqual(code, 1)
        self.assertEqual(asked["state"], "unavailable")
        self.assertIn("could not be read", asked["reason"])
        # An identifier that could climb out of the home names no state file at all.
        code, asked = self.ask("one", "../escape")
        self.assertEqual(code, 1)
        self.assertEqual(asked["needs"], None)

    def test_a_provider_that_is_not_ready_or_not_configured_is_refused(self):
        for provider in ("off", "nobody"):
            code, asked = self.ask(provider, "job-1")
            self.assertEqual(code, 1, provider)
            self.assertEqual(asked["reason"], "provider {0} is not ready".format(provider))


if __name__ == "__main__":
    unittest.main()
