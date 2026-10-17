/**
 * Which sections the pane draws, in what order, and when a section keeps out of
 * sight.
 *
 * Run with: node --test components/sections.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyGroup, paneFrom } from "../plugins/fleet/components/pane.ts";
import { paneOptions } from "../plugins/fleet/components/options.ts";
import { renderedText, renderPane } from "../plugins/fleet/components/layout.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/fleet/components/snapshot.ts";

const AT = 1_790_000_000;

function reading(overrides: Record<string, unknown> = {}): ReaderDocuments {
  return {
    roster: { state: "ready", providers: { one: { state: "ready", jobs: 0 } }, jobs: [],
              sources: { jobs: "ready", interactive: "empty" }, interactive: {} },
    trials: { state: "empty" }, progress: { state: "empty" },
    prs: { state: "empty", prs: [], errors: [] },
    skills: { state: "empty" }, worktrees: { state: "empty" },
    ...overrides,
  } as unknown as ReaderDocuments;
}


test("a section that hides while empty is left out until it has something, or something is wrong", () => {
  const options = paneOptions(120, AT, null);
  const quiet = paneFrom(snapshotFrom(reading(), AT), options);
  assert.equal(quiet.groups.some((group) => group.title === "Warnings"), false);
  // A source that failed is something to show, so the section comes back.
  const failed = paneFrom(snapshotFrom(reading({ prs: { state: "failed", prs: [],
    errors: [{ source: "prs:owner/project", reason: "timed out" }] } }), AT), options);
  assert.equal(failed.groups.some((group) => group.title === "Warnings"), true);
  // A section that does not hide stays drawn while empty.
  assert.equal(quiet.groups.some((group) => group.title === "Pull requests"), true);
});

test("pull requests lead the pane when nothing reorders it", () => {
  const pane = paneFrom(snapshotFrom(reading(), AT), paneOptions(120, AT, null));
  assert.equal(pane.groups[0]?.title, "Pull requests");
});

test("an empty group is one with no rows and nothing wrong", () => {
  const base = { name: "x", title: "X", summary: [], rows: [] };
  assert.equal(emptyGroup({ ...base, state: "ready" }), true);
  assert.equal(emptyGroup({ ...base, state: "empty" }), true);
  for (const state of ["failed", "unavailable", "stale"] as const) {
    assert.equal(emptyGroup({ ...base, state }), false, state);
  }
  assert.equal(emptyGroup({ ...base, state: "ready",
                            rows: [{ title: "a", meta: [], slot: [] }] }), false);
});

function run(extra: Record<string, unknown>) {
  return { key: "k", repo: "example-repo", branch: null, label: "", display: "run in example-repo",
           done: 0, total: 0, failed: 0, first_failure: "", elapsed: 30, eta_minutes: null,
           phase: "run", kind: "run", command_class: "full", ...extra };
}

function running(runs: unknown[]) {
  const pane = paneFrom(snapshotFrom(reading({ progress: { state: "ready", runs, errors: [] } }), AT),
                        paneOptions(120, AT, null));
  const group = pane.groups.find((entry) => entry.title === "Running");
  assert.ok(group);
  return { group, text: renderedText(renderPane(pane)).join("\n") };
}

test("a command the governor holds shows its place in line and a bar of its wait", () => {
  const { group, text } = running([
    run({ key: "a", kind: "run", label: "tests", done: 1, total: 5 }),
    run({ key: "b", kind: "wait", phase: "global", command_class: "mutation", repo: "other-repo",
          queue_position: 4, queue_total: 6, wait_total: 300, wait_left: 258 }),
  ]);
  const held = group.rows[1];
  assert.ok(held);
  assert.equal(held.title, "mutation in other-repo");
  assert.equal(held.state, "waiting");
  assert.deepEqual(held.bar && [held.bar.done, held.bar.total], [42, 300]);
  assert.equal(text.includes("4th of 6 in line"), true, text);
  assert.equal(text.includes("4m 18s left") || text.includes("4m left"), true, text);
  // The heading counts what runs and what waits apart.
  assert.equal(group.summary.map((slot) => slot.text).join(""), "1 running  1 waiting");
  // What runs comes before what waits.
  assert.equal(group.rows[0]?.title, "tests");
});

test("a held command whose wait the governor did not state draws no bar", () => {
  const { group } = running([run({ kind: "wait", queue_position: 2 })]);
  assert.equal(group.rows[0]?.bar, undefined);
});

function trials(extra: Record<string, unknown>) {
  const pane = paneFrom(snapshotFrom(reading({ trials: { state: "ready", running: [], recent: [],
    history: null, errors: [], ...extra } }), AT), paneOptions(120, AT, null));
  const group = pane.groups.find((entry) => entry.title === "Trials");
  assert.ok(group);
  return { group, text: renderedText(renderPane(pane)).join("\n") };
}

test("a change in flight shows its stage as a bar of the path, and who holds it", () => {
  const { group, text } = trials({
    changes: [
      { repo: "example-repo", branch: "feat/one", state: "TRIALED", stage: 3, stages: 9,
        moved_at: AT - 120, held_by: "claude" },
      { repo: "example-repo", branch: "feat/two", state: "ODD", stage: null, stages: 9,
        moved_at: null, held_by: null },
    ],
    running: [{ repo: "example-repo", branch: "feat/one", tool: "claude", expires_at: AT + 60,
                session: "s" },
              { repo: "example-repo", branch: "feat/three", tool: "codex", expires_at: AT + 60,
                session: "t" }],
  });
  const [held, odd, lease] = group.rows;
  assert.equal(held?.title, "feat/one");
  assert.equal(held?.state, "running");
  assert.deepEqual(held?.bar && [held.bar.done, held.bar.total], [3, 9]);
  assert.equal(text.includes("stage 3 of 9"), true, text);
  assert.equal(text.includes("held by claude"), true);
  // A state off the path keeps its row and draws no bar.
  assert.equal(odd?.bar, undefined);
  // A lease on a change in flight is that change's row; another lease is its own.
  assert.equal(lease?.title, "feat/three");
  assert.equal(group.rows.length, 3);
  assert.equal(group.summary.map((slot) => slot.text).join("").startsWith("2 in flight"), true);
});

test("a change's latest trial sits on its own row, not as a second row for the branch", () => {
  const { group } = trials({
    changes: [{ repo: "example-repo", branch: "feat/one", state: "TRIALED", stage: 3, stages: 9,
                moved_at: AT - 60, held_by: null }],
    recent: [
      { key: "t1", repo: "example-repo", branch: "feat/one", change_state: "TRIALED", at: AT - 30,
        is_green: false, passed: 9, failed: 2, errors: 1, skipped: 0 },
      { key: "t2", repo: "example-repo", branch: "feat/done", change_state: "MERGED", at: AT - 30,
        is_green: true, passed: 4, failed: 0, errors: 0, skipped: 0 },
    ],
  });
  assert.deepEqual(group.rows.map((row) => row.title), ["feat/one", "feat/done"]);
  assert.equal(group.rows[0]?.slot.map((slot) => slot.text).join(""), "9 passed \u00b7 3 failed");
  assert.equal(group.rows[0]?.slot[0]?.color, "error");
});

test("warnings lead the pane while a source is failing, wherever the order put them", () => {
  const options = paneOptions(120, AT, null);
  const failing = paneFrom(snapshotFrom(reading({ prs: { state: "failed", prs: [],
    errors: [{ source: "prs:owner/project", reason: "timed out" }] } }), AT), options);
  assert.equal(failing.groups[0]?.title, "Warnings");
  assert.equal(failing.groups[0]?.rows.length, 1);
  // The rest keep the order they were given, behind it.
  assert.equal(failing.groups[1]?.title, "Pull requests");
  // A person who hid warnings is not overruled.
  const hidden = { ...options, sections: { ...options.sections,
    warnings: { ...options.sections.warnings, visible: false } } };
  const quiet = paneFrom(snapshotFrom(reading({ prs: { state: "failed", prs: [],
    errors: [{ source: "prs:owner/project", reason: "timed out" }] } }), AT), hidden);
  assert.equal(quiet.groups.some((group) => group.title === "Warnings"), false);
});

test("this session waits for the engine rather than claiming it is switched off", () => {
  const pane = paneFrom(snapshotFrom(reading({ session: { state: "disabled" } }), AT),
                        paneOptions(120, AT, null));
  const text = renderedText(renderPane(pane)).join("\n");
  assert.equal(text.includes("switched off"), false, text);
  assert.match(text, /Waiting for the engine/);
});

test("a section past its row limit draws the first rows and counts the rest beside its heading", () => {
  const base = paneOptions(120, AT, null);
  const options = { ...base, sections: { ...base.sections,
    prs: { ...base.sections.prs, maxRows: 2 } } };
  const pulls = [1, 2, 3, 4, 5].map((number) => ({ repo: "owner/project", number,
    title: "Change " + number, branch: "b" + number, head: "", is_draft: false, checks: "pass" }));
  const pane = paneFrom(snapshotFrom(reading({ prs: { state: "ready", prs: pulls, errors: [] } }),
                                     AT), options);
  const group = pane.groups.find((entry) => entry.title === "Pull requests");
  assert.ok(group);
  // The two drawn rows, then the control that opens the rest: the count beside
  // the heading says how many there are, and the press is what draws them where
  // no pointer does.
  assert.deepEqual(group.rows.map((row) => row.title.replace(/^#\d+ /, "")),
                   ["Change 1", "Change 2", "show all rows"]);
  const heading = group.summary.map((slot) => slot.text.trim());
  assert.equal(heading.includes("3 more"), true, heading.join("|"));
  // The count of what is open still counts all five.
  assert.equal(heading.some((text) => text.startsWith("5")), true, heading.join("|"));
  // No limit, no cut.
  const whole = paneFrom(snapshotFrom(reading({ prs: { state: "ready", prs: pulls, errors: [] } }),
                                      AT), base);
  assert.equal(whole.groups.find((entry) => entry.title === "Pull requests")?.rows.length, 5);
});

