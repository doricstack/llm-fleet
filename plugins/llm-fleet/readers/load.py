#!/usr/bin/env python3
"""The load reader: which processes are using this machine, and where they run.

One sample of the process table, taken once per read. The rows drawn are the
ones at the top of the CPU list and the ones at the top of the memory list: a
process heavy in either is what a person is looking for, and a single order
would hide the other kind. A process in both lists is drawn once.

Every figure is a measurement this read took: a percentage as the platform
reported it, resident bytes as the platform reported them, and elapsed time
from the process's own start. The project a process works in is asked of the
system in a second pass, one call over every pid; a process whose working
directory nobody could read carries no project rather than a guessed one.

A platform whose process table this reader cannot read says so, and reads as
unavailable rather than as a machine under no load.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Mapping

from readers.runtime import (ReaderFailure, child_environment, printable, read_bounded_text,
                             resolve_command)

# The POSIX listing: pid, CPU percent, resident kilobytes, elapsed, command.
POSIX_ARGV = ["ps", "-Ao", "pid=,pcpu=,rss=,etime=,comm="]
# The POSIX call that names the working directory of each pid it is given.
CWD_ARGV = "lsof"
# How far above a working directory the search for its repository may climb.
PROJECT_DEPTH = 12
# The longest command a row names, as the reader publishes it.
COMMAND_CHARACTERS = 200
# A `.git` file is a line, not a document.
GITFILE_BYTES = 4096
# The most process rows one reading keeps, so a busy machine cannot grow a
# snapshot without bound.
MAX_ROWS = 4096


class MissingCommand(ReaderFailure):
    """The process list cannot be taken here, which is unavailable rather than a failed read."""


def elapsed_seconds(value: str) -> float | None:
    """A process age from `[[dd-]hh:]mm:ss`, in seconds, or None when it does not read."""
    days = 0
    text = value.strip()
    if "-" in text:
        day_text, _, text = text.partition("-")
        if not day_text.isdigit():
            return None
        days = int(day_text)
    parts = text.split(":")
    if not 1 <= len(parts) <= 3 or not all(part.isdigit() for part in parts):
        return None
    numbers = [int(part) for part in parts]
    # ps drops the leading units it does not need: one part is seconds, two are
    # minutes and seconds, three are hours, minutes and seconds.
    if len(numbers) == 1:
        hours, minutes, seconds = 0, 0, numbers[0]
    elif len(numbers) == 2:
        hours, minutes, seconds = 0, numbers[0], numbers[1]
    else:
        hours, minutes, seconds = numbers
    return float(days * 86400 + hours * 3600 + minutes * 60 + seconds)


def process_line(line: str) -> dict[str, Any] | None:
    """One process from one listing line, or None when the line does not read.

    The command is the remainder of the line, because a program's path may hold
    spaces. Everything before it is four fields, and each is checked rather than
    trusted: a percentage that is not a number is not a process at zero.
    """
    fields = line.split(None, 4)
    if len(fields) != 5 or not all(fields[:4]):
        return None
    pid_text, cpu_text, rss_text, age_text, command = fields
    if not pid_text.isdigit():
        return None
    try:
        cpu = float(cpu_text)
        resident = int(rss_text)
    except ValueError:
        return None
    if not math.isfinite(cpu) or cpu < 0 or resident < 0:
        return None
    age = elapsed_seconds(age_text)
    if age is None or not command.strip():
        return None
    return {
        "pid": int(pid_text),
        "command": printable(command.strip())[:COMMAND_CHARACTERS],
        "cpu_percent": round(cpu, 1),
        "memory_bytes": resident * 1024,
        "elapsed_seconds": age,
    }


def _git_root(candidate: Path) -> Path | None:
    """The repository a folder is in, following a worktree's `.git` file.

    A folder in a linked worktree holds a `.git` file naming the worktree's
    directory under the repository's `.git`, and the project is the repository
    that owns it, not the worktree folder the process happens to run in.
    """
    marker = candidate / ".git"
    if marker.is_dir():
        return candidate
    if not marker.is_file():
        return None
    document = read_bounded_text(marker, GITFILE_BYTES)
    if not document:
        return None
    first = document.strip().splitlines()[0] if document.strip() else ""
    prefix = "gitdir:"
    if not first.startswith(prefix):
        return None
    target = Path(first[len(prefix):].strip())
    if not target.is_absolute():
        target = candidate / target
    try:
        target = target.resolve()
    except OSError:
        return None
    parents = target.parents
    if len(parents) >= 3 and parents[1].name == ".git":
        return parents[2]
    return None


def project_of(directory: Path) -> tuple[str, str] | None:
    """The nearest repository above a working directory, as (project, root).

    The climb is bounded, and stops at the filesystem root: a process running in
    a folder outside any repository has no project, and is not given the name
    of whichever folder it happens to sit in.
    """
    candidate = directory
    for _ in range(PROJECT_DEPTH + 1):
        root = _git_root(candidate)
        if root is not None and root.name:
            return root.name, str(root)
        parent = candidate.parent
        if parent == candidate:
            return None
        candidate = parent
    return None


def working_directories(pids: list[int], environment: Mapping[str, str],
                        seconds: float) -> dict[int, Path]:
    """The working directory of each pid, from one bounded lsof call.

    An empty map is this machine declining to answer: no lsof, a refusal of the
    pids it may not inspect, or a timeout. It is not evidence that no process
    has a working directory, so callers draw no project rather than one that
    guesses.
    """
    if not pids:
        return {}
    argv = [CWD_ARGV, "-a", "-d", "cwd", "-Fpn", "-p", ",".join(str(pid) for pid in pids)]
    resolved = resolve_command(argv, environment)
    if resolved is None:
        return {}
    try:
        # The same environment the listing gets: a child that never sees a
        # provider credential cannot leak one.
        completed = subprocess.run(resolved, capture_output=True, text=True,
                                   env=dict(environment), timeout=seconds,
                                   errors="replace")
    except subprocess.TimeoutExpired:
        return {}
    except OSError:
        return {}
    found: dict[int, Path] = {}
    pid: int | None = None
    for line in completed.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None and line[1:]:
            found[pid] = Path(line[1:])
    return found


def _sample(config: Mapping[str, Any], environment: Mapping[str, str]
            ) -> tuple[list[dict[str, Any]], int]:
    """One read of the process table: the rows, and how many lines did not read."""
    source = config["sources"]["load"]
    command = source.get("command")
    if command is None:
        if os.name == "nt":
            raise MissingCommand("the process load is not read on this platform")
        command = POSIX_ARGV
    resolved = resolve_command(list(command), environment)
    if resolved is None:
        raise MissingCommand(command[0] + " was not found")
    seconds = float(config["timeouts"]["commandSeconds"])
    try:
        completed = subprocess.run(resolved, capture_output=True, text=True,
                                   env=dict(environment), timeout=seconds,
                                   errors="replace")
    except subprocess.TimeoutExpired:
        raise ReaderFailure("timed out after {0:g}s".format(seconds)) from None
    except OSError as caught:
        raise ReaderFailure(caught.strerror or type(caught).__name__) from None
    if completed.returncode != 0:
        raise ReaderFailure("exit {0}".format(completed.returncode))
    rows: list[dict[str, Any]] = []
    unreadable = 0
    for line in completed.stdout.splitlines()[:MAX_ROWS]:
        if not line.strip():
            continue
        row = process_line(line)
        if row is None:
            unreadable += 1
            continue
        rows.append(row)
    return rows, unreadable


def _ranked(rows: list[dict[str, Any]], top: int) -> list[dict[str, Any]]:
    """The top rows by CPU and by memory, once each, by CPU first."""
    by_cpu = sorted(rows, key=lambda row: (-row["cpu_percent"], -row["memory_bytes"],
                                           row["pid"]))
    by_memory = sorted(rows, key=lambda row: (-row["memory_bytes"], -row["cpu_percent"],
                                              row["pid"]))
    chosen: dict[int, dict[str, Any]] = {}
    for row in [*by_cpu[:top], *by_memory[:top]]:
        chosen.setdefault(row["pid"], row)
    return sorted(chosen.values(), key=lambda row: (-row["cpu_percent"], -row["memory_bytes"],
                                                    row["pid"]))


# The machine's own figures, as the platform states them.
#
# The process table says what each program costs; only the platform can say how
# much of the machine is left, and every platform says it in its own words. The
# parsers are kept apart from the calls so each is proved against text a real
# command printed, and a platform that states nothing answers None rather than a
# nought: an unknown load and an idle machine are different answers.

_SIZE = re.compile(r"^(?P<number>\d+(?:\.\d+)?)\s*(?P<unit>[KMGTP])?B?$", re.IGNORECASE)
_SIZE_STEPS = {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4,
               "P": 1024 ** 5}
# How long the two Linux samples are held apart: one read of /proc/stat counts
# the ticks since boot, so two reads a moment apart are what make a rate.
PROC_SAMPLE_SECONDS = 0.1
# The platform whose reader runs, read at import so a test can stand in for
# another one: the Windows branch is otherwise only exercised on Windows.
PLATFORM = os.name

# What a Windows machine is asked when `wmic` is not there to answer.
_POWERSHELL_SYSTEM = (
    "$os = Get-CimInstance Win32_OperatingSystem; "
    "$c = (Get-CimInstance Win32_Processor | "
    "Measure-Object -Property LoadPercentage -Average).Average; "
    "\"TotalVisibleMemorySize=$($os.TotalVisibleMemorySize)\"; "
    "\"FreePhysicalMemory=$($os.FreePhysicalMemory)\"; "
    # A machine whose processor query answers nothing is drawn with no CPU
    # meter at all: casting the empty answer to a number would publish a
    # measured zero for a figure nobody read.
    "if ($null -ne $c) { \"LoadPercentage=$([int]$c)\" }"
)


def _size_of(text: str) -> int | None:
    """Bytes from a size a platform printed, such as `126G`, `9887M` or `1634MB`."""
    match = _SIZE.match(text.strip())
    if match is None:
        return None
    return int(float(match.group("number")) * _SIZE_STEPS[match.group("unit").upper()
                                                         if match.group("unit") else ""])


def parse_top_system(output: str) -> dict[str, Any] | None:
    """macOS `top -l 1 -n 0`: the load averages, the CPU split and the memory summary."""
    averages: list[float] | None = None
    cpu: float | None = None
    used: int | None = None
    total: int | None = None
    for line in output.splitlines():
        text = line.strip()
        if text.startswith("Load Avg:"):
            numbers = [float(part) for part in
                       re.findall(r"\d+(?:\.\d+)?", text.partition(":")[2])]
            if len(numbers) >= 3:
                averages = numbers[:3]
        elif text.startswith("CPU usage:"):
            # Busy is everything that is not idle, which is one number to trust
            # rather than a sum of the words a platform happened to print.
            for amount, word in re.findall(r"(\d+(?:\.\d+)?)%\s*(\w+)", text):
                if word == "idle":
                    cpu = max(0.0, min(100.0, 100.0 - float(amount)))
        elif text.startswith("PhysMem:"):
            body = text.partition(":")[2]
            used_text = re.search(r"([\d.]+[KMGTP]?)\s+used", body, re.IGNORECASE)
            unused_text = re.search(r"([\d.]+[KMGTP]?)\s+unused", body, re.IGNORECASE)
            if used_text is not None:
                used = _size_of(used_text.group(1))
            if used is not None and unused_text is not None:
                spare = _size_of(unused_text.group(1))
                total = used + spare if spare is not None else None
    if cpu is None and averages is None and used is None:
        return None
    return {"cpuPercent": cpu, "loadAverage": averages,
            "memoryUsedBytes": used, "memoryTotalBytes": total}


def parse_proc_stat(text: str) -> tuple[int, int] | None:
    """The whole machine's ticks since boot, as (total, idle), from /proc/stat."""
    for line in text.splitlines():
        if not line.startswith("cpu "):
            continue
        fields = [int(part) for part in line.split()[1:] if part.isdigit()]
        if len(fields) < 4:
            return None
        # Idle and waiting on input/output are both time the machine spent with
        # nothing to run, which is what a busy figure leaves out.
        #
        # Only the first eight fields count. Guest time is already inside user
        # and nice, so a machine running virtual machines would otherwise have
        # those ticks charged twice and read as twice as busy as it is.
        counted = fields[:8]
        idle = counted[3] + (counted[4] if len(counted) > 4 else 0)
        return sum(counted), idle
    return None


def parse_proc_system(first: str, second: str, loadavg: str, meminfo: str
                      ) -> dict[str, Any] | None:
    """Linux: the busy share between two samples, the load averages and the memory."""
    cpu: float | None = None
    before = parse_proc_stat(first)
    after = parse_proc_stat(second)
    if before is not None and after is not None:
        total = after[0] - before[0]
        idle = after[1] - before[1]
        if total > 0:
            cpu = max(0.0, min(100.0, 100.0 * (total - idle) / total))
    averages: list[float] | None = None
    numbers = [float(part) for part in loadavg.split()[:3] if part.replace(".", "", 1).isdigit()]
    if len(numbers) == 3:
        averages = numbers
    values = {}
    for line in meminfo.splitlines():
        key, _, rest = line.partition(":")
        amount = rest.strip().split(" ")[0]
        if amount.isdigit():
            # Every figure in /proc/meminfo is in kilobytes.
            values[key] = int(amount) * 1024
    used = None
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if total is not None and available is not None:
        used = max(0, total - available)
    if cpu is None and averages is None and used is None:
        return None
    return {"cpuPercent": cpu, "loadAverage": averages,
            "memoryUsedBytes": used, "memoryTotalBytes": total}


def parse_wmic_system(os_text: str, cpu_text: str) -> dict[str, Any] | None:
    """Windows: `wmic` prints one `key=value` pair per line, in kilobytes."""
    values = {}
    # wmic prints one block per processor package, so the processor's share is
    # every figure it printed: keeping the last one drew one package's load as
    # the machine's, which on a two-socket box is a reading of the wrong thing.
    processor: list[int] = []
    for line in (os_text + "\n" + cpu_text).splitlines():
        key, separator, rest = line.strip().partition("=")
        if not (separator and rest.strip().isdigit()):
            continue
        if key.strip() == "LoadPercentage":
            processor.append(int(rest.strip()))
        else:
            values[key.strip()] = int(rest.strip())
    total_kb = values.get("TotalVisibleMemorySize")
    free_kb = values.get("FreePhysicalMemory")
    load = sum(processor) / len(processor) if processor else None
    cpu = float(min(100, max(0, load))) if load is not None else None
    total = total_kb * 1024 if total_kb is not None else None
    used = max(0, total - free_kb * 1024) if total is not None and free_kb is not None else None
    if cpu is None and used is None:
        return None
    return {"cpuPercent": cpu, "loadAverage": None,
            "memoryUsedBytes": used, "memoryTotalBytes": total}


def _print(environment: Mapping[str, str], command: list[str], seconds: float) -> str | None:
    """One bounded call whose text answers, or None when it cannot be made."""
    resolved = resolve_command(command, environment)
    if resolved is None:
        return None
    try:
        completed = subprocess.run(resolved, capture_output=True, text=True,
                                   env=dict(environment), timeout=seconds,
                                   errors="replace")
    except (subprocess.TimeoutExpired, OSError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


def _file_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def windows_cpu_percent(first: tuple[int, int, int],
                        second: tuple[int, int, int]) -> float | None:
    """The busy share between two GetSystemTimes samples, or None without ticks.

    Each sample is (idle, kernel, user), and the kernel total already holds the
    idle ticks, so the machine's whole time between the samples is kernel plus
    user and what it was busy with is that less the idle.
    """
    idle = second[0] - first[0]
    total = (second[1] - first[1]) + (second[2] - first[2])
    if total <= 0:
        return None
    return 100.0 * max(0, total - idle) / total


def windows_system() -> dict[str, Any] | None:
    """Windows' own figures through kernel32, with no command to start.

    `wmic` is gone from Windows 11 24H2, and PowerShell takes tens of seconds to
    start on a cold machine, which is longer than a read may wait: kernel32 is
    already loaded and answers at once.
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return None

    class FileTime(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD),
                    ("totalPhysical", ctypes.c_ulonglong),
                    ("availablePhysical", ctypes.c_ulonglong),
                    ("totalPageFile", ctypes.c_ulonglong),
                    ("availablePageFile", ctypes.c_ulonglong),
                    ("totalVirtual", ctypes.c_ulonglong),
                    ("availableVirtual", ctypes.c_ulonglong),
                    ("availableExtendedVirtual", ctypes.c_ulonglong)]

    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]

        def ticks() -> tuple[int, int, int]:
            samples = (FileTime(), FileTime(), FileTime())
            if not kernel.GetSystemTimes(*(ctypes.byref(sample) for sample in samples)):
                raise OSError(ctypes.get_last_error())
            return tuple((sample.high << 32) | sample.low for sample in samples)  # type: ignore[return-value]

        first = ticks()
        time.sleep(PROC_SAMPLE_SECONDS)
        second = ticks()
        memory = MemoryStatus()
        memory.length = ctypes.sizeof(MemoryStatus)
        if not kernel.GlobalMemoryStatusEx(ctypes.byref(memory)):
            raise OSError(ctypes.get_last_error())
    except (OSError, AttributeError):
        return None
    total = int(memory.totalPhysical)
    available = int(memory.availablePhysical)
    return {"cpuPercent": windows_cpu_percent(first, second), "loadAverage": None,
            "memoryUsedBytes": max(0, total - available), "memoryTotalBytes": total}


def system_load(environment: Mapping[str, str], seconds: float) -> dict[str, Any] | None:
    """What the whole machine is doing, or None where the platform does not say."""
    try:
        if PLATFORM == "nt":
            # The platform's own interface first: on Windows 11 24H2 there is no
            # `wmic` to call, and PowerShell takes longer to start than a read
            # may wait, so a machine that answers kernel32 draws its meters at
            # once and the commands behind it are kept for the machine where
            # that call is refused.
            direct = windows_system()
            if direct is not None and (direct["cpuPercent"] is not None
                                       or direct["memoryUsedBytes"] is not None):
                return direct
            wmic = parse_wmic_system(
                _print(environment, ["wmic", "OS", "get",
                                     "FreePhysicalMemory,TotalVisibleMemorySize", "/value"],
                       seconds) or "",
                _print(environment, ["wmic", "cpu", "get", "LoadPercentage", "/value"],
                       seconds) or "")
            if wmic is not None:
                return wmic
            # Windows 11 24H2 turns `wmic` off by default, so the same three
            # figures come from the interface it points people at, printed in
            # the shape the wmic parser already reads.
            return parse_wmic_system(
                _print(environment, ["powershell", "-NoProfile", "-NonInteractive",
                                     "-Command", _POWERSHELL_SYSTEM], seconds + 4.0) or "",
                "")
        if sys.platform == "darwin":
            # `top` computes its first sample since boot and every later one
            # since the sample before it, so two samples a second apart are what
            # make the number say what the machine is doing now rather than how
            # it has averaged over its uptime. The parser keeps the last block.
            printed = _print(environment, ["top", "-l", "2", "-n", "0", "-s", "1"],
                             seconds + 1.0)
            return parse_top_system(printed) if printed is not None else None
        first = _file_text("/proc/stat")
        if not first:
            return None
        time.sleep(PROC_SAMPLE_SECONDS)
        return parse_proc_system(first, _file_text("/proc/stat"), _file_text("/proc/loadavg"),
                                 _file_text("/proc/meminfo"))
    except OSError:
        return None


def read_load(config: Mapping[str, Any], *, now: float | None = None,
              environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The processes under the most load, each with the project it works in."""
    source = config["sources"]["load"]
    clock = float(now) if now is not None else time.time()
    errors: list[dict[str, str]] = []
    result: dict[str, Any] = {"state": "disabled", "sampled_at": clock, "total": 0,
                              "system": None, "processes": [], "errors": errors}
    if not source["enabled"]:
        return result
    inherited = dict(os.environ if environ is None else environ)
    # Both calls are handed the same stripped environment, and every command is
    # resolved on the PATH the child actually receives.
    environment = child_environment(config["runtime"]["childEnvironment"], inherited)
    # The machine's own figures are read before the process list, so a platform
    # that states no process table still draws its meters: Windows has no
    # process command unless one is configured, and the meters do not depend on
    # that list at all.
    result["system"] = system_load(environment, float(config["timeouts"]["commandSeconds"]))
    try:
        rows, unreadable = _sample(config, environment)
    except MissingCommand as missing:
        result["state"] = "unavailable"
        errors.append({"source": "load", "reason": str(missing)})
        return result
    except ReaderFailure as failure:
        result["state"] = "failed"
        errors.append({"source": "load", "reason": str(failure)})
        return result
    if not rows:
        result["state"] = "failed" if unreadable else "empty"
        if unreadable:
            errors.append({"source": "load", "reason": "the process list did not read"})
        return result
    top = int(source["top"])
    chosen = _ranked(rows, top)
    directories = working_directories([row["pid"] for row in chosen], environment,
                                      float(config["timeouts"]["commandSeconds"]))
    for row in chosen:
        directory = directories.get(row["pid"])
        found = project_of(directory) if directory is not None else None
        if found is not None:
            row["project"], row["project_root"] = found
    result.update(state="ready", total=len(rows), processes=chosen)
    return result


