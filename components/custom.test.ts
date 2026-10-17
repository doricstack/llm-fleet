/**
 * Sections a person adds by naming a command: what the pane reads from the
 * custom document, where it places each section, and how a row is drawn.
 *
 * Run with: node --test components/custom.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { allErrors, paneFrom, TOGGLE_PREFIX, unreadableSources } from "../plugins/fleet/components/pane.ts";
import { paneConfigFrom, paneOptions, SECTIONS } from "../plugins/fleet/components/options.ts";
import { renderedText, renderPane } from "../plugins/fleet/components/layout.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/fleet/components/snapshot.ts";

const AT = 1_790_000_000;

function section(extra: Record<string, unknown> = {}) {
  return { state: "ready", title: "Deploys", legend: "What is deploying.", visible: true,
           collapsed: false, hideWhenEmpty: false, summary: null, rows: [], printed: 0,
           errors: [], ...extra };
}

function documents(order: string[], custom: unknown): ReaderDocuments {
  const sections = Object.fromEntries(SECTIONS.map((name) => [
    name, { title: null, visible: true, collapsed: false, legend: null, hideWhenEmpty: false }]));
  return {
    pane: { state: "ready", order, sections, keys: {}, geometry: {} },
    roster: { state: "ready", providers: {}, jobs: [],
              sources: { jobs: "ready", interactive: "empty" }, interactive: {} },
    trials: { state: "empty" }, progress: { state: "empty" },
    prs: { state: "empty", prs: [], errors: [] },
    skills: { state: "empty" }, worktrees: { state: "empty" },
    custom,
  } as unknown as ReaderDocuments;
}

function drawn(order: string[], custom: unknown, folded: Record<string, boolean> = {}) {
  const read = documents(order, custom);
  const resolved = paneConfigFrom(read);
  assert.ok(resolved, "the pane document was refused");
  const options = { ...paneOptions(120, AT, resolved), folded };
  const pane = paneFrom(snapshotFrom(read, AT), options);
  return { resolved, options, pane, text: renderedText(renderPane(pane)).join("\n") };
}

test("a custom section is placed where the order names it and drawn with its own rows", () => {
  const { pane, text, resolved } = drawn(["prs", "custom:deploys", "keys"], {
    state: "ready", errors: [],
    sections: { deploys: section({ summary: "1 running", printed: 2, rows: [
      { title: "web to staging", state: "running", detail: "migrating", slot: "4m",
        done: 3, total: 5, failed: null },
      { title: "api", state: null, detail: null, slot: null, done: null, total: null, failed: null },
    ] }) },
  });
  assert.deepEqual(resolved.order, ["prs", "custom:deploys", "keys"]);
  assert.deepEqual(pane.groups.map((group) => group.title), ["Pull requests", "Deploys", "Keys"]);
  const group = pane.groups[1];
  assert.ok(group);
  assert.equal(group.state, "ready");
  assert.equal(group.legend, "What is deploying.");
  assert.equal(group.toggle?.key, TOGGLE_PREFIX + "custom:deploys");
  assert.equal(group.toggle?.hotkey, "2");
  assert.deepEqual(group.summary.map((slot) => slot.text), ["1 running"]);
  const [first, second] = group.rows;
  assert.equal(first?.title, "web to staging");
  assert.equal(first?.state, "running");
  assert.deepEqual(first?.meta.map((slot) => slot.text), ["migrating"]);
  assert.deepEqual(first?.slot.map((slot) => slot.text), ["4m"]);
  assert.deepEqual([first?.bar?.done, first?.bar?.total], [3, 5]);
  // A row the command gave no figures for draws no bar rather than an empty one.
  assert.equal(second?.bar, undefined);
  assert.match(text, /web to staging/);
  assert.match(text, /Deploys/);
});

test("a declared section the order leaves out is drawn after the ones it names, unless hidden", () => {
  const { resolved, pane } = drawn(["prs", "keys"], {
    state: "ready", errors: [],
    sections: {
      later: section({ title: "Later" }),
      hidden: section({ title: "Hidden", visible: false }),
    },
  });
  assert.deepEqual(resolved.order, ["prs", "keys", "custom:later", "custom:hidden"]);
  assert.deepEqual(pane.groups.map((group) => group.title), ["Pull requests", "Keys", "Later"]);
});

test("a section's own settings start it folded and hide it while it is empty", () => {
  const { pane } = drawn(["custom:folded", "custom:quiet", "custom:broken"], {
    state: "ready",
    errors: [{ source: "custom:broken", reason: "exit 3" }],
    sections: {
      folded: section({ title: "Folded", collapsed: true,
                        rows: [{ title: "a", state: null, detail: null, slot: null,
                                 done: null, total: null, failed: null }], printed: 1 }),
      quiet: section({ title: "Quiet", state: "empty", hideWhenEmpty: true }),
      broken: section({ title: "Broken", state: "failed", hideWhenEmpty: true,
                        errors: [{ source: "custom:broken", reason: "exit 3" }] }),
    },
  });
  assert.deepEqual(pane.groups.map((group) => group.title), ["Folded", "Broken"]);
  assert.equal(pane.groups[0]?.collapsed, true);
  // A command that failed is never hidden as empty: the failure is the thing to show.
  assert.equal(pane.groups[1]?.state, "failed");
});

test("a press folds a custom section like any other", () => {
  const { pane } = drawn(["custom:deploys"], {
    state: "ready", errors: [], sections: { deploys: section() },
  }, { "custom:deploys": true });
  assert.equal(pane.groups[0]?.collapsed, true);
});

test("a custom section's failures reach the warnings and the unreadable count", () => {
  const read = documents(["custom:gone", "custom:broken", "warnings"], {
    state: "ready",
    errors: [{ source: "custom:gone", reason: "deploy-status is not on PATH" },
             { source: "custom:broken", reason: "exit 3" }],
    sections: {
      gone: section({ title: "Gone", state: "unavailable" }),
      broken: section({ title: "Broken", state: "failed" }),
    },
  });
  const snapshot = snapshotFrom(read, AT);
  assert.deepEqual(unreadableSources(snapshot), ["custom:gone", "custom:broken"]);
  assert.deepEqual(allErrors(snapshot).map((error) => error.source),
                   ["custom:gone", "custom:broken"]);
});

test("an order naming a section the reading lacks draws it as not read, not as empty", () => {
  // The custom reader itself failed, so the section the order names has no document.
  const { pane } = drawn(["custom:deploys"], { state: "failed", sections: {},
    errors: [{ source: "custom", reason: "RuntimeError: boom" }] });
  assert.equal(pane.groups[0]?.title, "deploys");
  assert.equal(pane.groups[0]?.state, "failed");
});

test("a reading from before custom sections existed draws none and refuses nothing", () => {
  const read = documents(["prs"], undefined);
  const resolved = paneConfigFrom(read);
  assert.deepEqual(resolved?.order, ["prs"]);
  const snapshot = snapshotFrom(read, AT);
  assert.equal(snapshot.custom.state, "disabled");
  assert.deepEqual(snapshot.custom.sections, {});
});

test("a malformed custom document is a failed source, and malformed rows are dropped", () => {
  assert.equal(snapshotFrom(documents([], "nonsense"), AT).custom.state, "failed");
  const snapshot = snapshotFrom(documents([], {
    state: "ready", errors: [],
    sections: {
      deploys: section({ rows: [{ title: "kept", done: "3", total: 5 }, { detail: "no title" },
                                "not a row", { title: "" }] }),
      broken: "not a section",
    },
  }), AT);
  assert.deepEqual(Object.keys(snapshot.custom.sections), ["deploys", "broken"]);
  const rows = snapshot.custom.sections.deploys?.rows ?? [];
  assert.deepEqual(rows.map((row) => row.title), ["kept"]);
  // A figure that is not a whole number is not a figure, so the row draws no bar.
  assert.deepEqual([rows[0]?.done, rows[0]?.total], [null, 5]);
  assert.equal(snapshot.custom.sections.broken?.state, "failed");
});

test("a section that printed more rows than it carries says how many it holds back", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    title: "row " + index, state: null, detail: null, slot: null, done: null, total: null,
    failed: null }));
  const { pane } = drawn(["custom:many"], {
    state: "ready", errors: [], sections: { many: section({ rows, printed: 57 }) },
  });
  assert.deepEqual(pane.groups[0]?.summary.map((slot) => slot.text.trim()),
                   ["57 rows", "50 shown"]);
});
