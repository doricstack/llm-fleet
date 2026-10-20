#!/usr/bin/env bash
# File: .cits/test-impact.sh
# Description: Run the tests a change affects, in this repository, with nothing
#              installed beyond git, make, Python and Node. Nothing here reads a
#              path from the machine it runs on: a fresh clone runs the same
#              selection as the checkout it was written in.
#
#              Every TypeScript suite in this repository runs through
#              scripts/typescript-suite.py, which exists because Node 22.6 runs
#              TypeScript directly and no build step or dependency install is
#              wanted. A selector that reaches for a framework adapter cannot
#              see them, and the failure that produced this file was exactly
#              that: eight suites named and four run, with a success reported
#              over a change nothing had exercised.
#
#              The selection is by file. scripts/test-select.py reads the
#              repository's own sources and names the test files and suites
#              each changed file reaches, through imports, through paths a test
#              writes out, and through folders a test walks. A whole layer runs
#              only when the selector says which file forced it: the test
#              harness, or a file no test reaches. This replaced a selection by
#              language lane, under which one changed test file and a README ran
#              the whole Python suite, more than a thousand tests.
#
#              The commit and push tiers run that selection; the ci tier runs
#              everything. CI runs the push tier on a pull request and the ci
#              tier on main and on a release tag, so the whole suite still runs
#              on every change that lands.
#
# Usage: .cits/test-impact.sh --tier commit|push|ci [--base REF] [--repo PATH] [--require-change] [--dry-run]
#        --dry-run prints the commands without running them.
#        --require-change refuses a change set that comes out empty, for a
#        caller, such as a pull request check, that always has something to test.
# Exit:  0 = the selected suites passed or nothing was affected; non-zero = a
#        selected suite failed, or the selection could not be made.

set -euo pipefail

tier=""
base=""
repo="$PWD"
dry_run=0
require_change=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tier) tier="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --require-change) require_change=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help)
      sed -n 's/^# Usage:/Usage:/p' "$0"
      exit 0 ;;
    *) echo "test-impact: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$tier" in
  commit|push|ci) ;;
  *) echo "test-impact: --tier must be commit|push|ci (got '${tier:-}')" >&2; exit 2 ;;
esac

cd "$repo" || { echo "test-impact: cannot enter $repo" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "test-impact: git is not installed" >&2; exit 2; }

# The interpreter is resolved the way the make targets resolve theirs, so a host
# where only `python` answers runs the same suite instead of failing to start
# it. A name found on the path is not a path from this machine, which is what
# the selection is not allowed to carry, and a name is not an interpreter
# either: Windows keeps a `python3` stub that answers every call with a message
# about the Microsoft Store and exits 49, so each candidate is asked to answer
# something before it is believed. The answer is compared, not the exit status:
# the same stub has been seen to report zero while it printed that message and
# started nothing, and a probe that read only the status took it.
python=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 \
     && [ "$("$candidate" -c 'import sys; print(sys.version_info[0])' 2>/dev/null)" = "3" ]; then
    python="$candidate"
    break
  fi
done
if [ -z "$python" ]; then
  echo "test-impact: no Python interpreter answers on this machine" >&2
  exit 2
fi

plan_header() { echo "--- plan ---"; }
no_tests() { echo "  - nothing affected -> no tests to run"; }

# --- where reports go ---------------------------------------------------------
# A gate that reads reports names a folder. Every TypeScript suite is told it
# through the environment rather than an argument, because a TypeScript suite is
# started from many places (this plan, and every make target the whole run
# reaches), and a folder passed in the environment is never spliced into the
# text this script evaluates: a folder holding a space or a semicolon stays one
# folder. The runner names each report from its suite, so none share a file.
# The Python suite's report goes the same way, for the same reason: a path in
# the environment is never expanded by the shell that evaluates a command or by
# make, so a folder holding a quote, a dollar or a semicolon is still one folder.
if [ -n "${CITS_JUNIT_DIR:-}" ]; then
  export FLEET_TS_JUNIT_DIR="$CITS_JUNIT_DIR"
  export FLEET_JUNIT_XML="$CITS_JUNIT_DIR/fleet-python.xml"
fi
reports_note() {
  [ -n "${CITS_JUNIT_DIR:-}" ] && echo "  - reports go to the folder the gate named"
  return 0
}

# --- what the run is ----------------------------------------------------------
# The blanket tier is the one tier that may run everything: it is what CI runs
# on main and on a release tag, and an affected-only selection there would leave
# the rest of the repository unverified on the only run that is allowed to check
# all of it.
if [ "$tier" = "ci" ]; then
  echo "=== test-impact (tier=ci) ==="
  echo "  - the whole suite, including the isolated export round trip"
  # A gate that reads reports named a folder above; every suite the whole run
  # starts writes into it, so a full run is one a receipt can count.
  reports_note
  plan_header
  echo "  \$ make test-ci"
  [ "$dry_run" -eq 1 ] && exit 0
  exec make test-ci
fi

# --- what changed -------------------------------------------------------------
# The staged set for a commit, everything since the merge base for a push. The
# merge base is what makes a push measure its own work rather than everything
# main has gained since the branch started. A deletion counts, and a rename is
# read as its two paths: a test that still names the old path is the test the
# change breaks.
diff_names() { git diff --name-only --relative --no-renames --diff-filter=ACDMR "$@" 2>/dev/null || true; }
if [ "$tier" = "commit" ]; then
  [ -n "$base" ] || base="HEAD"
else
  [ -n "$base" ] || base="origin/main"
fi
# A base that names no commit would make every diff below come out empty and
# read as "nothing affected": a renamed branch or a failed fetch would pass a
# check that ran nothing.
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "test-impact: the base $base names no commit here; fetch it or name another" >&2
  exit 2
fi
if [ "$tier" = "commit" ]; then
  changed="$(diff_names --cached "$base")"
else
  merge_base="$(git merge-base HEAD "$base" 2>/dev/null)" || {
    echo "test-impact: HEAD and $base share no history to measure from" >&2
    exit 2
  }
  changed="$(diff_names "$merge_base")"
fi
# Uncommitted work counts as changed at both tiers. The commit tier is what
# `make test-impacted` runs and a person's edits are usually unstaged when they
# run it; the push tier measures a branch but the working tree is still what is
# about to be pushed. A selection that read only the index or only the commits
# would answer "nothing affected" over an edit sitting right there.
changed="${changed}
$(diff_names HEAD)"
# A file written but not added yet is invisible to every diff above, and the
# first thing a person runs the selection against is often the test they just
# wrote. Untracked files are read with the ignored ones left out, so a build
# directory cannot drag the whole suite in.
changed="${changed}
$(git ls-files --others --exclude-standard 2>/dev/null || true)"
changed="$(printf '%s\n' "$changed" | sed '/^$/d' | sort -u)"
if [ "$require_change" -eq 1 ] && [ -z "$changed" ]; then
  echo "test-impact: no change against $base, and this caller requires one" >&2
  exit 2
fi

echo "=== test-impact (tier=$tier, base=$base) ==="

# An empty change set needs no branch of its own: it yields no command, and the
# one place that decides what an empty selection looks like is the one that
# draws the plan.
has() { printf '%s\n' "$changed" | grep -qE "$1"; }

# --- the selection ------------------------------------------------------------
# The selector reads the files of the repository being measured, so a clone
# selects with its own copy; it is started with the interpreter resolved above.
selection=""
if [ -n "$changed" ]; then
  if [ ! -f scripts/test-select.py ]; then
    echo "test-impact: scripts/test-select.py is not in $repo" >&2
    exit 2
  fi
  select_rc=0
  # A carriage return is dropped on the way in: on Windows a line can carry
  # one, and a name that keeps it is a file that reads as absent.
  selection="$(printf '%s\n' "$changed" | "$python" scripts/test-select.py --root . \
               | tr -d '\r')" || select_rc=$?
  if [ "$select_rc" -ne 0 ]; then
    echo "test-impact: the selection failed (exit $select_rc)" >&2
    exit 2
  fi
fi
picked() { printf '%s\n' "$selection" | sed -n "s/^$1 //p"; }

# --- the commands -------------------------------------------------------------
commands=""
add() { commands="${commands}$1
"; }

# The Python side. A file that changes how every test runs, or that no test
# reaches, runs the suite whole through `make test-report`, the suite this
# repository publishes; otherwise the selected files run as one report through
# the same script, so a gate reading CITS_JUNIT_DIR counts exactly what ran.
# Each name is checked against the shape of a test file before it is placed in
# a command, because the plan is evaluated by a shell.
python_all="$(picked python-all)"
python_files="$(picked python-test)"
if [ -n "$python_all" ]; then
  while IFS= read -r forced; do
    [ -n "$forced" ] && echo "  - the whole Python suite: $forced changes how every test runs or reaches no test"
  done <<EOF
$python_all
EOF
  add "make test-report"
elif [ -n "$python_files" ]; then
  file_args=""
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    printf '%s\n' "$file" | grep -qE '^tests/test_[A-Za-z0-9_]+\.py$' \
      || { echo "test-impact: refusing the test name $file" >&2; exit 2; }
    [ -f "$file" ] || continue
    file_args="$file_args --file $file"
  done <<EOF
$python_files
EOF
  # The environment the make targets give the suite, so no run leaves caches.
  [ -n "$file_args" ] && add "PYTHONDONTWRITEBYTECODE=1 $python scripts/test-report.py --directory tests$file_args"
fi

# The TypeScript layer, suite by suite through the repository's own runner. A
# changed module no suite imports runs the layer whole, because a suite that
# reaches it by a road the selector cannot read is the failure this file exists
# to fix.
typescript_all="$(picked ts-all)"
if [ -n "$typescript_all" ]; then
  while IFS= read -r forced; do
    [ -n "$forced" ] && echo "  - every TypeScript suite: $forced is imported by no suite"
  done <<EOF
$typescript_all
EOF
  # Tracked and not-yet-added alike: a suite written for this change is often
  # not staged yet, and a suite nobody lists is a suite nobody runs.
  suites="$({ git ls-files -- 'components/*.test.ts' 'config/*.test.ts'
              git ls-files --others --exclude-standard -- 'components/*.test.ts' \
                                                            'config/*.test.ts'
            } | sort -u)"
else
  suites="$(picked ts-suite)"
fi
while IFS= read -r suite; do
  [ -n "$suite" ] || continue
  printf '%s\n' "$suite" | grep -qE '^(components|config)/[A-Za-z0-9_.-]+\.test\.ts$' \
    || { echo "test-impact: refusing the suite name $suite" >&2; exit 2; }
  # `git ls-files` reads the index, and a file removed with `rm` is still
  # listed there. Naming it would hand the runner a path that is not present.
  [ -f "$suite" ] || continue
  add "$python scripts/typescript-suite.py --suite $suite"
done <<EOF
$suites
EOF

# The isolated export round trip: export the tree, then run the exported copy's
# own checks in it. It runs whole, so it is planned only for a change to what
# decides the export: the policy files, the exporter, its make fragment and its
# suite. A new file the allowlist misses is caught by the full run on main.
if has '^public-export/|^scripts/public-export\.py$|^make/export\.mk$|^tests/test_public_export\.py$'; then
  echo "  - the export round trip: the change touches what decides the export"
  add "make test-export-roundtrip"
fi

# The format check reads every source file and instruction table, takes under a
# second, and is the one check a documentation change can fail, so any change
# plans it.
if [ -n "$changed" ]; then
  add "make doc-format"
fi

# Named rather than left out: these suites run under the host's own test kit,
# which plain node cannot load, and a selection that drops what it cannot run
# without saying so is the failure this file exists to fix.
if has '^plugins/llm-fleet/'; then
  echo "  - plugins/llm-fleet runs through the host's test kit; CI covers it (make test-pane)"
fi
while IFS= read -r note; do
  [ -n "$note" ] && echo "  - documentation no test reads: $note"
done <<EOF
$(picked docs)
EOF

# The header is printed only over a plan. An empty selection is stated as one,
# and a header standing over no commands reads as a plan that came out empty,
# which is a different claim from a selection that found nothing to run.
if [ -z "$commands" ]; then
  no_tests
  exit 0
fi
reports_note
plan_header
printf '%s' "$commands" | sed '/^$/d' | sed 's/^/  $ /'

if [ "$dry_run" -eq 1 ]; then
  exit 0
fi

echo "--- run ---"
rc=0
while IFS= read -r command; do
  [ -n "$command" ] || continue
  echo "  \$ $command"
  command_rc=0
  eval "$command" || command_rc=$?
  [ "$command_rc" -eq 0 ] || rc="$command_rc"
done <<EOF
$commands
EOF

if [ "$rc" -eq 0 ]; then
  echo "test-impact: the selected suites passed."
else
  echo "test-impact: a selected suite failed (exit $rc)." >&2
fi
exit "$rc"
