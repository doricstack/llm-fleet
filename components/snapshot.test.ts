/**
 * Snapshot assembly behavior.
 *
 * What arrives from the readers is parsed JSON from another process, so the cases
 * here are about untrusted shapes: a document that is absent, of the wrong type,
 * or naming a state this layer does not know must become a source that failed.
 * A silently empty group would read as nothing running.
 *
 * Run with: node --test plugins/llm-fleet/components/snapshot.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { snapshotFrom } from "../plugins/llm-fleet/components/snapshot.ts";
import { DEFAULT_KEYS, paneFrom, type PaneOptions } from "../plugins/llm-fleet/components/pane.ts";
import { GEOMETRY } from "../plugins/llm-fleet/components/options.ts";
import { renderedText, renderPane } from "../plugins/llm-fleet/components/layout.ts";

const NOW = 1_700_000_000;

const SECTIONS = ["sessions", "session", "trials", "prs", "warnings", "worktrees", "skills",
                  "running", "keys"];

const OPTIONS: PaneOptions = {
  width: 120,
  narrowAt: 60,
  now: NOW,
  sectionOrder: SECTIONS,
  sections: Object.fromEntries(SECTIONS.map((name) =>
    [name, { visible: true, collapsed: false }])),
  keys: DEFAULT_KEYS,
  geometry: GEOMETRY,
};

function rendered(documents: Parameters<typeof snapshotFrom>[0]): string[] {
  return renderedText(renderPane(paneFrom(snapshotFrom(documents, NOW - 4), OPTIONS)));
}

test("this session's figures reach the pane from the document that carried them", () => {
  // Read off the reader's own document as it prints it, rather than off a
  // snapshot a test built: the mapping between the two is where a field the
  // reader renamed would go missing in silence.
  const values = rendered({
    session: { state: "ready", absent: ["spendUsedPercent"],
               parameters: { effort: "high" },
               costUsd: 12.5, durationMs: 900_000, modelName: "Opus 5.5",
               remainingPercent: 42.5, windowSize: 200_000 },
  });
  for (const figure of ["$12.50", "42.5% left", "effort high"]) {
    assert.equal(values.includes(figure), true, figure);
  }
  // A figure the payload did not carry is named rather than drawn as a nought.
  const bare = rendered({ session: { state: "ready", absent: ["costUsd"], parameters: {},
                                     modelName: "Opus 5.5", remainingPercent: 42.5,
                                     windowSize: 200_000 } });
  assert.equal(bare.includes("not reported"), true);
  assert.equal(bare.some((value) => value.includes("$")), false);
});

test("an absent document reads as an empty source, not as a failure", () => {
  const snapshot = snapshotFrom({}, NOW);
  assert.equal(snapshot.roster.state, "empty");
  assert.equal(snapshot.trials.state, "empty");
  assert.equal(snapshot.progress.state, "empty");
  assert.equal(snapshot.prs.state, "empty");
  assert.equal(snapshot.skills.state, "empty");
  assert.equal(snapshot.worktrees.state, "empty");
  assert.deepEqual(snapshot.roster.jobs, []);
});

test("a document that is not an object reads as failed", () => {
  const snapshot = snapshotFrom({ roster: "not a document", prs: [1, 2, 3] }, NOW);
  assert.equal(snapshot.roster.state, "failed");
  assert.equal(snapshot.prs.state, "failed");
});

test("a document naming a state this layer does not know reads as failed", () => {
  const snapshot = snapshotFrom({ roster: { state: "flourishing" } }, NOW);
  assert.equal(snapshot.roster.state, "failed");
});

test("a failed document renders as a failed group, not an empty one", () => {
  const values = rendered({ roster: { state: "failed", errors: [{ source: "jobs:x", reason: "exit 3" }] } });
  assert.equal(values.includes("unknown"), true);
  assert.equal(values.some((value) => value.includes("Could not read Background sessions")), true);
  assert.equal(values.some((value) => value.includes("No background jobs")), false);
});

test("a roster row is read with its identifiers and nothing invented", () => {
  const snapshot = snapshotFrom({ roster: { state: "ready", jobs: [
    { id: "a", name: "Review", state: "blocked", label: "Provider A", since: NOW - 120,
      needs: "Which source?", session_id: "1234abcd-ffff", started_at: NOW - 600 },
    { id: "b" },
  ], interactive: { primary: 2 }, sources: { jobs: "ready", interactive: "ready" } } }, NOW);
  assert.equal(snapshot.roster.jobs.length, 2);
  assert.equal(snapshot.roster.jobs[0]?.label, "Provider A");
  assert.equal(snapshot.roster.jobs[0]?.needs, "Which source?");
  assert.equal(snapshot.roster.jobs[1]?.name, "unnamed");
  assert.equal(snapshot.roster.jobs[1]?.state, "unknown");
  assert.equal(snapshot.roster.jobs[1]?.since, null);
  assert.deepEqual(snapshot.roster.interactive, { primary: 2 });
});

test("a job with no count is not given one", () => {
  const snapshot = snapshotFrom({ roster: { state: "ready", jobs: [
    { id: "a", name: "x", state: "working", started_at: "soon" },
  ] } }, NOW);
  assert.equal(snapshot.roster.jobs[0]?.started_at, null);
});

test("a provider map keeps the states it was given and refuses the rest", () => {
  const snapshot = snapshotFrom({ roster: { state: "ready", providers: {
    primary: { state: "ready", reason: null },
    off: { state: "disabled" },
    odd: { state: "sleepy" },
    shapeless: 7,
  } } }, NOW);
  assert.equal(snapshot.roster.providers.primary?.state, "ready");
  assert.equal(snapshot.roster.providers.off?.state, "disabled");
  assert.equal(snapshot.roster.providers.odd?.state, "unavailable");
  assert.equal(snapshot.roster.providers.shapeless?.state, "unavailable");
});

test("a run keeps its measured counts and drops a total it cannot trust", () => {
  const snapshot = snapshotFrom({ progress: { state: "ready", runs: [
    { key: "a", label: "Suite", done: 42, total: 80, failed: 1, elapsed: 120, eta_minutes: 3 },
    { key: "b", label: "Other", done: 1, total: "many" },
  ] } }, NOW);
  assert.equal(snapshot.progress.runs[0]?.total, 80);
  assert.equal(snapshot.progress.runs[1]?.total, 0);
  assert.equal(snapshot.progress.runs[1]?.eta_minutes, null);
  assert.equal(snapshot.progress.runs[1]?.display, "unnamed run");
});

test("a pull request without a number keeps it absent and its checks unknown", () => {
  const snapshot = snapshotFrom({ prs: { state: "ready", prs: [
    { repo: "owner/one", title: "t", checks: "weird" },
  ] } }, NOW);
  assert.equal(snapshot.prs.prs[0]?.number, null);
  assert.equal(snapshot.prs.prs[0]?.checks, "none");
  assert.equal(snapshot.prs.prs[0]?.is_draft, false);
});

test("a running scan without a denominator is not published as one", () => {
  const snapshot = snapshotFrom({ skills: { state: "ready", running: { done: 5 } } }, NOW);
  assert.equal(snapshot.skills.running, null);
  const counted = snapshotFrom({ skills: { state: "ready", running: { done: 5, total: 20 } } }, NOW);
  assert.deepEqual(counted.skills.running, { done: 5, total: 20 });
});

test("a worktree state outside the known set reads as unknown", () => {
  const snapshot = snapshotFrom({ worktrees: { state: "ready", worktrees: [
    { name: "lane", state: "haunted", cleanup_command: "" },
  ] } }, NOW);
  assert.equal(snapshot.worktrees.worktrees[0]?.state, "unknown");
  assert.equal(snapshot.worktrees.worktrees[0]?.held, null);
});

test("a worktree whose merge is unknown is carried as unknown and drawn as neither", () => {
  const snapshot = snapshotFrom({ worktrees: { state: "ready", worktrees: [
    { name: "open", branch: "a", state: "active", merged: false, archived: false, held: false,
      cleanup_command: "clean a" },
    { name: "done", branch: "b", state: "merged", merged: true, archived: false, held: false,
      cleanup_command: "clean b" },
    { name: "cut", branch: "c", state: "unknown", merged: null, cleanup_command: "",
      error: "probe budget of 1s was spent" },
    // A row claiming a state its merge fact cannot back is not believed.
    // Each carries every other fact, so the merge alone is what is missing.
    { name: "claims-merged", branch: "d", state: "merged", merged: null, archived: false,
      held: false, cleanup_command: "clean d" },
    { name: "claims-active", branch: "e", state: "active", archived: false, held: false,
      cleanup_command: "clean e" },
    { name: "claims-preserved", branch: "f", state: "preserved", merged: "yes", archived: true,
      held: false, cleanup_command: "clean f" },
    // Held is a fact about a process, not about the merge, so it stands.
    { name: "held", branch: "g", state: "held", merged: null, held: true,
      cleanup_command: "clean g" },
  ] } }, NOW);
  const trees = snapshot.worktrees.worktrees;
  assert.deepEqual(trees.map((tree) => tree.merged), [false, true, null, null, null, null, null]);
  assert.deepEqual(trees.map((tree) => tree.state),
                   ["active", "merged", "unknown", "unknown", "unknown", "unknown", "held"]);
  const values = rendered({ worktrees: { state: "ready", cleaned: null, worktrees: [
    { name: "cut", branch: "c", state: "merged", merged: null, cleanup_command: "clean c",
      error: "git merge-base exited 128" },
  ] } });
  const words = values.join("\n");
  assert.equal(words.includes("could not check: git merge-base exited 128"), true, words);
  for (const claim of ["in use", "not merged", "no changes yet", "cleaned automatically",
                       "press to copy cleanup"]) {
    assert.equal(words.includes(claim), false, claim);
  }
});

test("a worktree whose archive or live holders are unknown is carried and drawn as unknown", () => {
  const snapshot = snapshotFrom({ worktrees: { state: "ready", worktrees: [
    { name: "kept", branch: "a", state: "preserved", merged: false, archived: true, held: false,
      cleanup_command: "clean a" },
    { name: "no-archive", branch: "b", state: "active", merged: false, archived: null, held: false,
      cleanup_command: "clean b" },
    { name: "merged-no-archive", branch: "c", state: "merged", merged: true, archived: "maybe",
      held: false, cleanup_command: "clean c" },
    { name: "no-lsof", branch: "d", state: "active", merged: false, archived: false, held: null,
      cleanup_command: "clean d" },
    // A row that says a process holds it, with nothing behind the claim.
    { name: "claims-held", branch: "e", state: "held", merged: false, archived: false,
      cleanup_command: "clean e" },
  ] } }, NOW);
  const trees = snapshot.worktrees.worktrees;
  assert.deepEqual(trees.map((tree) => tree.archived), [true, null, null, false, false]);
  assert.deepEqual(trees.map((tree) => tree.held), [false, false, false, null, null]);
  assert.deepEqual(trees.map((tree) => tree.state),
                   ["preserved", "unknown", "unknown", "unknown", "unknown"]);
  const values = rendered({ worktrees: { state: "ready", cleaned: null, worktrees: [
    { name: "no-lsof", branch: "d", state: "active", merged: false, archived: false, held: null,
      cleanup_command: "clean d",
      error: "live process inspection unavailable: lsof is not on the PATH" },
  ] } });
  const words = values.join("\n");
  assert.equal(words.includes("could not check: live process inspection unavailable"), true, words);
  for (const claim of ["in use", "press to copy cleanup"]) {
    assert.equal(words.includes(claim), false, claim);
  }
});

test("a worktree that was not rechecked keeps that note and its age", () => {
  const snapshot = snapshotFrom({ worktrees: { state: "ready", cleaned: 3, worktrees: [
    { name: "lane", branch: "x", state: "active", merged: false, checked_at: NOW - 600,
      recheck_error: "timed out after 2s" },
  ] } }, NOW);
  const tree = snapshot.worktrees.worktrees[0];
  assert.equal(tree?.recheck_error, "timed out after 2s");
  assert.equal(tree?.checked_at, NOW - 600);
  assert.equal(snapshot.worktrees.cleaned, 3);
  const values = rendered({ worktrees: { state: "ready", cleaned: null, worktrees: [
    { name: "lane", branch: "x", state: "active", merged: false, archived: false, held: false,
      cleanup_command: "clean" },
  ] } });
  // What happens to it next is said under it, in the words the last pane used.
  assert.equal(values.includes("in use"), true);
});

test("a worktree offered no cleanup command keeps the note saying why", () => {
  const snapshot = snapshotFrom({ worktrees: { state: "ready", worktrees: [
    { name: "odd", branch: "x", state: "merged", merged: true, cleanup_command: "",
      cleanup_note: "clean this worktree up by hand" },
    { name: "plain", branch: "y", state: "merged", merged: true, cleanup_command: "clean" },
  ] } }, NOW);
  assert.equal(snapshot.worktrees.worktrees[0]?.cleanup_note, "clean this worktree up by hand");
  assert.equal(snapshot.worktrees.worktrees[1]?.cleanup_note, undefined);
});

test("an error list survives assembly and reaches the warnings group", () => {
  const values = rendered({
    roster: { state: "failed", errors: [{ source: "jobs:primary", reason: "exit 3" }] },
    prs: { state: "failed", errors: [{}, { reason: "no source" }] },
  });
  assert.equal(values.includes("jobs:primary"), true);
  assert.equal(values.includes("unknown"), true);
  assert.equal(values.includes("no reason was given"), true);
});

test("a snapshot carries the moment the read finished", () => {
  assert.equal(snapshotFrom({}, NOW)?.generated_at, NOW);
  const values = renderedText(renderPane(paneFrom(snapshotFrom({}, NOW - 60), OPTIONS)));
  assert.equal(values.includes("Updated 1m ago"), true);
});

test("a reading keeps its own clock rather than the moment it was painted", () => {
  // The pane can open on a reading from the last session. Its age is then the
  // reading's, not this paint's: a pane that stamped every reading with the
  // moment it drew it would label an hour-old fleet as current.
  const documents = { generated_at: NOW - 3600, roster: { state: "empty" } };
  assert.equal(snapshotFrom(documents as never, NOW)?.generated_at, NOW - 3600);
  const values = renderedText(renderPane(paneFrom(snapshotFrom(documents as never, NOW), OPTIONS)));
  assert.equal(values.includes("Updated 1h ago"), true);
});

test("a reading with no clock of its own falls back to when it was read", () => {
  assert.equal(snapshotFrom({ roster: { state: "empty" } } as never, NOW)?.generated_at, NOW);
  assert.equal(snapshotFrom({ generated_at: "yesterday" } as never, NOW)?.generated_at, NOW);
});

test("a stamp later than the read that carries it is not trusted", () => {
  // The reader stamps before it returns, so a stamp from after the read is
  // inconsistent, and drawn as-is it would date a reading to the future and
  // clamp to an age of nothing. The time the reading was taken cannot be wrong.
  const ahead = { generated_at: NOW + 3600, roster: { state: "empty" } };
  assert.equal(snapshotFrom(ahead as never, NOW)?.generated_at, NOW);
  const values = renderedText(renderPane(paneFrom(snapshotFrom(ahead as never, NOW), OPTIONS)));
  assert.equal(values.includes("Updated 0s ago"), true);
});

test("a job's subagent tasks are kept as the state file listed them, and broken ones dropped", () => {
  const built = snapshotFrom({ roster: { state: "ready", jobs: [{
    id: "a", name: "job", state: "working", provider: "one",
    attach_command: "CLAUDE_CONFIG_DIR=/h claude attach a",
    fan: [{ kind: "agent", label: "Read", startedAt: 5, doneAt: 9 },
          { kind: "agent", label: "Open", startedAt: 7 },
          { kind: "todo", label: "Later" },
          { kind: "agent", label: "Bad time", startedAt: "soon", doneAt: Number.NaN },
          { kind: "", label: "No kind" }, { kind: "agent" }, "not an entry", null],
  }] } }, NOW);
  const job = built.roster.jobs[0];
  assert.deepEqual(job?.fan, [{ kind: "agent", label: "Read", startedAt: 5, doneAt: 9 },
                              { kind: "agent", label: "Open", startedAt: 7 },
                              { kind: "todo", label: "Later" },
                              { kind: "agent", label: "Bad time" }]);
  assert.equal(job?.attach_command, "CLAUDE_CONFIG_DIR=/h claude attach a");
  const bare = snapshotFrom({ roster: { state: "ready", jobs: [{ id: "b", fan: "nope" }] } }, NOW);
  assert.deepEqual(bare.roster.jobs[0]?.fan, []);
  assert.equal(bare.roster.jobs[0]?.attach_command, null);
});

test("a waiting job's question hash travels, and one that is not text is none", () => {
  const built = snapshotFrom({ roster: { state: "ready", jobs: [
    { id: "a", state: "blocked", provider: "one", needs: "Go?", needs_hash: "abc123" },
    { id: "b", state: "blocked", provider: "one", needs: "Go?", needs_hash: 7 },
    { id: "c", state: "blocked", provider: "one", needs: "Go?" },
  ] } }, NOW);
  assert.deepEqual(built.roster.jobs.map((job) => job.needs_hash), ["abc123", null, null]);
});

test("where a waiting job's reply stands travels, and anything else is no reply", () => {
  const built = snapshotFrom({ roster: { state: "ready", jobs: [
    { id: "a", state: "blocked", provider: "one", reply: { state: "pending", at: NOW - 5 } },
    { id: "b", state: "blocked", provider: "one", reply: { state: "sent", at: NOW - 9 } },
    { id: "c", state: "blocked", provider: "one", reply: { state: "lost", at: NOW } },
    { id: "d", state: "blocked", provider: "one", reply: { state: "pending", at: "soon" } },
    { id: "e", state: "blocked", provider: "one" },
    { id: "f", state: "blocked", provider: "one", reply: { state: "unreadable", at: null, id: "7-1" } },
    { id: "g", state: "blocked", provider: "one", reply: { state: "unreadable" } },
    { id: "h", state: "blocked", provider: "one", reply: { state: "unreadable", at: null, id: 7 } },
  ] } }, NOW);
  // A marker that is there but does not read holds the question: it travels as
  // a state of its own, with no time, and never as no reply. Its id names that
  // very file, and one that is not text is dropped rather than guessed.
  assert.deepEqual(built.roster.jobs.map((job) => job.reply),
                   [{ state: "pending", at: NOW - 5 }, { state: "sent", at: NOW - 9 }, null, null, null,
                    { state: "unreadable", at: null, id: "7-1" }, { state: "unreadable", at: null, id: null },
                    { state: "unreadable", at: null, id: null }]);
});

test("the skill report command travels with the scan, and a reading without one has none", () => {
  const carried = snapshotFrom({ skills: { state: "ready", report_command: "scan report" } }, NOW);
  assert.equal(carried.skills.report_command, "scan report");
  const without = snapshotFrom({ skills: { state: "ready", report_command: 7 } }, NOW);
  assert.equal(without.skills.report_command, null);
});

/** An ISO time `ago` seconds before NOW, to the second, as the readers write one. */
function iso(ago: number): string {
  return new Date((NOW - ago) * 1000).toISOString().replace(".000Z", "Z");
}

test("a pull request's checks travel by name and state, and what is not a check is dropped", () => {
  const built = snapshotFrom({ prs: { state: "ready", prs: [{
    repo: "o/p", number: 1, title: "t", checks: "fail", opened_at: iso(600),
    check_runs: [{ name: "lint", state: "fail" }, { name: "", state: "pass" }, { state: "pass" },
                 "build", { name: "docs", state: 3 }],
    check_runs_more: 4,
  }, { repo: "o/p", number: 2, title: "u", checks: "none", check_runs: "lots", check_runs_more: -1,
       opened_at: "yesterday" }] } }, NOW);
  const [first, second] = built.prs.prs;
  // A check with no name keeps its dot under the empty name, as the reader sends it.
  assert.deepEqual(first?.check_runs, [{ name: "lint", state: "fail" }, { name: "", state: "pass" }]);
  assert.equal(first?.check_runs_more, 4);
  assert.equal(first?.opened_at, NOW - 600);
  // Not a list is no checks listed, and a count that is not one is none.
  assert.equal(second?.check_runs, undefined);
  assert.equal(second?.check_runs_more, 0);
  assert.equal(second?.opened_at, null);
});

test("the roster's spend series is kept whole or not at all", () => {
  const series = { bucket_minutes: 60, buckets: [0, 1.5], total: 1.5, complete: true, sessions: 2 };
  assert.deepEqual(snapshotFrom({ roster: { state: "ready", jobs: [], spend_series: series } }, NOW)
    .roster.spend_series, series);
  // A bucket that is not a figure, or a figure below nothing, is a series that cannot be drawn.
  for (const buckets of [[0, "1"], [0, -1], [0, Number.NaN], "0,1"]) {
    const built = snapshotFrom({ roster: { state: "ready", jobs: [],
                                           spend_series: { ...series, buckets } } }, NOW);
    assert.equal(built.roster.spend_series, null, JSON.stringify(buckets));
  }
  // Complete is only ever what the reader said it was.
  const unsure = snapshotFrom({ roster: { state: "ready", jobs: [],
                                          spend_series: { ...series, complete: "yes" } } }, NOW);
  assert.equal(unsure.roster.spend_series?.complete, false);
  assert.equal(snapshotFrom({ roster: { state: "ready", jobs: [] } }, NOW).roster.spend_series, null);
});

test("an agent's timeline is read as times, and a segment that is not one refuses the whole", () => {
  const timeline = [{ start: iso(600), end: iso(300), state: "working" },
                    { start: iso(300), end: iso(100), state: "idle" }];
  const job = (line: unknown) => ({ roster: { state: "ready", jobs: [{ id: "a", state: "working",
                                                                       agent: { state: "ready", timeline: line } }] } });
  const built = snapshotFrom(job(timeline), NOW);
  assert.deepEqual(built.roster.jobs[0]?.agent?.timeline,
                   [{ start: NOW - 600, end: NOW - 300, state: "working" },
                    { start: NOW - 300, end: NOW - 100, state: "idle" }]);
  for (const broken of [[{ start: "then", end: iso(1), state: "working" }],
                        [{ start: iso(9), end: iso(1) }], "working",
                        [{ start: iso(1), end: iso(9), state: "working" }]]) {
    assert.equal(snapshotFrom(job(broken), NOW).roster.jobs[0]?.agent?.timeline, null,
                 JSON.stringify(broken));
  }
});

test("the digest's events are read with their times, and a document that is not one has failed", () => {
  const ready = snapshotFrom({ events: { state: "ready", sources: { prs: "ready", trials: "failed" },
    events: [{ at: iso(60), kind: "pr-opened", title: "Add", ref: "o/p#1" },
             { at: "soon", kind: "pr-opened", title: "Bad", ref: "o/p#2" },
             { at: iso(90), kind: 4, title: "Bad", ref: "o/p#3" }] } }, NOW);
  assert.deepEqual(ready.events?.events, [{ at: NOW - 60, kind: "pr-opened", title: "Add", ref: "o/p#1" }]);
  assert.deepEqual(ready.events?.sources, { prs: "ready", trials: "failed" });
  assert.equal(ready.events?.state, "ready");
  const failed = snapshotFrom({ events: { state: "failed", events: [],
                                          errors: [{ source: "events", reason: "boom" }] } }, NOW);
  assert.equal(failed.events?.state, "failed");
  assert.deepEqual(failed.events?.errors, [{ source: "events", reason: "boom" }]);
  // A ready document whose events are not a list is not a quiet stretch.
  assert.equal(snapshotFrom({ events: { state: "ready", events: "none" } }, NOW).events?.state, "failed");
  // A reading from before events were read carries none.
  assert.equal(snapshotFrom({ roster: { state: "empty" } }, NOW).events, undefined);
});

test("a process under load reaches the pane only with the figures that read", () => {
  const snapshot = snapshotFrom({ load: { state: "ready", sampled_at: NOW, total: 3, processes: [
    { pid: 101, command: "python3 worker.py", cpu_percent: 12.5, memory_bytes: 2048 * 1024,
      elapsed_seconds: 60, project: "repo", project_root: "/p/repo" },
    // A pid of zero places no process, so the row is dropped rather than drawn
    // against a process this layer did not read.
    { pid: 0, command: "bad", cpu_percent: 5, memory_bytes: 1, elapsed_seconds: 1 },
    { pid: 202, command: "hog", cpu_percent: 90, memory_bytes: 1024, elapsed_seconds: 2,
      project: "repo" },
    { pid: 303, command: "", cpu_percent: 1, memory_bytes: 1, elapsed_seconds: 1 },
  ] } }, NOW);
  assert.equal(snapshot.load.total, 3);
  assert.deepEqual(snapshot.load.processes.map((entry) => entry.pid), [101, 202]);
  assert.equal(snapshot.load.processes[0]?.project_root, "/p/repo");
  // A project without a root keeps the name and invents no path.
  assert.equal(snapshot.load.processes[1]?.project_root, undefined);
  // A reading from before the load was read carries an empty document rather
  // than a failed one: nobody asked this machine about its load.
  assert.equal(snapshotFrom({}, NOW).load.state, "empty");
});

test("a governance document is kept as read, and a failed one carries no scope", () => {
  const read = snapshotFrom({ governance: { state: "ready", governor: false, controller: true,
                                            source: "config", path: "/switch.json",
                                            updated_at: "2026-10-19T10:00:00Z",
                                            by: "someone", errors: [] } }, NOW);
  assert.deepEqual(read.governance, { state: "ready", governor: false, controller: true,
                                      source: "config", path: "/switch.json",
                                      updated_at: "2026-10-19T10:00:00Z", by: "someone",
                                      errors: [] });
  // A document that failed is drawn as a failure, not as the tool's own "both
  // on" default: the pane would be reporting a state it never read.
  const failed = snapshotFrom({ governance: { state: "failed", errors: [
    { source: "governance", reason: "switch file is not JSON" }] } }, NOW);
  assert.equal(failed.governance?.state, "failed");
  assert.equal(failed.governance?.governor, null);
  assert.equal(failed.governance?.controller, null);
  // A reading from before the switch was read is disabled, never ready.
  assert.equal(snapshotFrom({}, NOW).governance?.state, "disabled");
});
