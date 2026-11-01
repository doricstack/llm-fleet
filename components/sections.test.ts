/**
 * Which sections the pane draws, in what order, and when a section keeps out of
 * sight.
 *
 * Run with: node --test components/sections.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyGroup, paneFrom } from "../plugins/llm-fleet/components/pane.ts";
import { paneOptions } from "../plugins/llm-fleet/components/options.ts";
import { renderedText, renderPane } from "../plugins/llm-fleet/components/layout.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/llm-fleet/components/snapshot.ts";

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

