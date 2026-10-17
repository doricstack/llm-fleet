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
#              The selection is by the repository's own test lanes rather than
#              by a framework's import graph. A change to the Python side runs
#              the Python suite; a change to the TypeScript side runs the
#              TypeScript layer. The layers are small enough that running one
#              whole is cheaper than being wrong about which part of it a change
#              reaches, and being wrong is what this file is for.
#
# Usage: .cits/test-impact.sh --tier commit|push|ci [--base REF] [--repo PATH] [--dry-run]
#        --dry-run prints the commands without running them.
# Exit:  0 = the selected suites passed or nothing was affected; non-zero = a
#        selected suite failed.

set -euo pipefail

tier=""
base=""
repo="$PWD"
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tier) tier="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
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
# the selection is not allowed to carry.
if command -v python3 >/dev/null 2>&1; then
  python="python3"
else
  python="python"
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
# The blanket tier is the one tier that may run everything: it is what CI runs,
# and an affected-only selection there would leave the rest of the repository
# unverified on the only run that is allowed to check all of it.
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
# main has gained since the branch started.
if [ "$tier" = "commit" ]; then
  [ -n "$base" ] || base="HEAD"
  changed="$(git diff --cached --name-only --relative --diff-filter=ACMR "$base" 2>/dev/null || true)"
else
  [ -n "$base" ] || base="origin/main"
  merge_base="$(git merge-base HEAD "$base" 2>/dev/null || echo "$base")"
  changed="$(git diff --name-only --relative --diff-filter=ACMR "$merge_base" 2>/dev/null || true)"
fi
# Uncommitted work counts as changed at both tiers. The commit tier is what
# `make test-impacted` runs and a person's edits are usually unstaged when they
# run it; the push tier measures a branch but the working tree is still what is
# about to be pushed. A selection that read only the index or only the commits
# would answer "nothing affected" over an edit sitting right there.
changed="${changed}
$(git diff --name-only --relative --diff-filter=ACMR HEAD 2>/dev/null || true)"
# A file written but not added yet is invisible to every diff above, and the
# first thing a person runs the selection against is often the test they just
# wrote. Untracked files are read with the ignored ones left out, so a build
# directory cannot drag the whole suite in.
changed="${changed}
$(git ls-files --others --exclude-standard 2>/dev/null || true)"
changed="$(printf '%s\n' "$changed" | sed '/^$/d' | sort -u)"

echo "=== test-impact (tier=$tier, base=$base) ==="

# An empty change set needs no branch of its own: it matches no rule below, so
# it yields no command, and the one place that decides what an empty selection
# looks like is the one that draws the plan.
has() { printf '%s\n' "$changed" | grep -qE "$1"; }

# --- the commands -------------------------------------------------------------
commands=""
add() { commands="${commands}$1
"; }

# The Python side, as one command: `make test-report` is the suite this
# repository already publishes for it, and running it whole keeps one definition
# of what the Python tests are. A caller that wants a report names where, and
# the gate that reads one passes its destination in CITS_JUNIT_DIR. unittest
# writes no report of its own, which is why the repository carries one. The
# schema both loaders read lives in the plugin folder, under plugins/fleet/config,
# so a change there plans this side and the TypeScript side alike.
if has '\.py$|^tests/|^config/|^plugins/fleet/config/|^public-export/|^Makefile$|^make/|^\.cits/'; then
  add "make test-report"
fi

# The TypeScript layer, suite by suite through the repository's own runner. A
# changed .ts runs the layer whole, because a suite that names the changed
# module and is not selected is the failure this file exists to fix.
if has '\.tsx?$|^components/|^config/|^plugins/fleet/config/'; then
  # Tracked and not-yet-added alike: a suite written for this change is often
  # not staged yet, and a suite nobody lists is a suite nobody runs.
  suites="$({ git ls-files -- 'components/*.test.ts' 'config/*.test.ts'
              git ls-files --others --exclude-standard -- 'components/*.test.ts' \
                                                            'config/*.test.ts'
            } | sort -u)"
  while IFS= read -r suite; do
    [ -n "$suite" ] || continue
    # `git ls-files` reads the index, and a file removed with `rm` is still
    # listed there. Naming it would hand the runner a path that is not present.
    [ -f "$suite" ] || continue
    add "$python scripts/typescript-suite.py --suite $suite"
  done <<EOF
$suites
EOF
fi

# Named rather than left out: this suite runs under the host's own test kit,
# which plain node cannot load, and a selection that drops what it cannot run
# without saying so is the failure this file exists to fix.
if has '^plugins/fleet/'; then
  echo "  - plugins/fleet runs through the host's test kit; CI covers it (make test-pane)"
fi

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
