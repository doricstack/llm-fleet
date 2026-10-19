/**
 * Review-renderer behavior.
 *
 * The renderer exists so a pane can be read before anything mounts it, which
 * means a fault here misleads whoever is reviewing: a row's segments must land on
 * one line, a widening line must be indented, and a clause that refused the
 * configuration must come back as that refusal rather than as a drawer of empty
 * sections.
 *
 * Run with: node --test plugins/llm-fleet/components/review.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { documentsOf, nodeLines, renderText, renderVectors, vectorsOf } from "./review.ts";
import type { ReaderDocuments } from "../plugins/llm-fleet/components/snapshot.ts";

const NOW = 1_700_000_000;

const DOCUMENTS: ReaderDocuments = {
  roster: { state: "ready", jobs: [
    { id: "a", name: "Review adapter behavior", state: "blocked", label: "Provider A",
      session_id: "1234abcd-9999", since: NOW - 120, needs: "Which source?" }],
    interactive: { primary: 2 }, errors: [], providers: {},
    sources: { jobs: "ready", interactive: "ready" } },
  worktrees: { state: "ready", cleaned: 3, errors: [], worktrees: [
    { name: "lane", path: "/tmp/lane", branch: "task/lane", state: "active", merged: false,
      archived: false, held: false, cleanup_command: "clean", checked_at: NOW }] },
};

test("a rendered pane carries the rows, the counts and the warning", () => {
  const text = renderText(DOCUMENTS, 100, NOW, NOW - 4);
  // A figure is a press, and the page shows the number it counts: a label that
  // named only the words printed every figure as a bare label.
  assert.equal(text.includes("1 Waiting on you"), true);
  assert.equal(text.includes("Review adapter behavior"), true);
  assert.equal(text.includes("Waiting for you"), true);
  assert.equal(text.includes("Which source?"), true);
  assert.equal(text.includes("1 checked out"), true);
  assert.equal(text.includes("3 cleaned this week"), true);
  // Worktrees is one of the sections the contract starts folded, so its row is
  // not drawn and its heading says so. The review page shows what the pane
  // shows; a page that unfolded it would be showing a pane nobody has.
  assert.equal(text.includes("\u25b8 Worktrees"), true);
  assert.equal(text.includes("lane"), false, text);
});

test("a folded section still names what it holds, and opens when it is told to", () => {
  const folded = renderText(DOCUMENTS, 100, NOW, NOW - 4);
  assert.equal(folded.includes("1 checked out"), true);
  const open = renderText(DOCUMENTS, 100, NOW, NOW - 4,
                          { worktrees: { visible: true, collapsed: false } });
  assert.equal(open.includes("\u25be Worktrees"), true);
  assert.equal(open.includes("lane"), true);
});

test("the page carries every heading and both controls, which are drawn as buttons", () => {
  const text = renderText(DOCUMENTS, 100, NOW, NOW - 4);
  // The warnings are left out while nothing is wrong, which is this reading.
  for (const heading of ["Background sessions", "Trials", "Pull requests",
                         "Worktrees", "Skills", "Running", "Keys"]) {
    assert.equal(text.includes(heading), true, heading);
  }
  // A heading is a control now, and a control's text is its label: a renderer
  // that read only children would print this page with every heading missing.
  assert.equal(text.includes("Collapse all"), true);
  assert.equal(text.includes("Expand all"), true);
});

test("the page draws the configuration the reading carried, not this build's default", () => {
  // A reading that says sessions starts folded and the order is warnings first.
  // A page rendering the packaged default would show the session row and put
  // sessions before warnings, which is a pane nobody has. The job is working
  // rather than waiting: one waiting on the person moves its section above the
  // calm ones whatever the order says, which is not what this case is about.
  const roster = DOCUMENTS.roster as { jobs: Record<string, unknown>[] };
  const configured = {
    ...DOCUMENTS,
    roster: { ...roster, jobs: roster.jobs.map((job) => ({ ...job, state: "working", needs: null })) },
    pane: { state: "ready",
            order: ["warnings", "sessions"],
            sections: { warnings: { visible: true, collapsed: false },
                        sessions: { visible: true, collapsed: true } } },
  } as ReaderDocuments;
  const text = renderText(configured, 100, NOW, NOW - 4);
  assert.equal(text.includes("\u25b8 Background sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), false);
  assert.equal(text.indexOf("Warnings") < text.indexOf("Background sessions"), true);
  // A section the configuration's order does not name is not on the page, the
  // same way it is not on the pane.
  assert.equal(text.includes("Worktrees"), false);
});

test("a reading that places no sections prints a page with none", () => {
  // An empty order resolves from the schema, and the pane draws no sections for
  // it. A page that drew all eight would be showing a pane nobody has.
  const empty = { ...DOCUMENTS, pane: { state: "ready", order: [], sections: {} } } as ReaderDocuments;
  const text = renderText(empty, 100, NOW, NOW - 4);
  assert.equal(text.includes("Background sessions"), false);
  assert.equal(text.includes("Worktrees"), false);
  assert.equal(text.includes("Collapse all"), false);
});

test("a page still renders for a reading that carries no configuration", () => {
  // Every reading written before the pane configuration travelled with one, and
  // a page that threw on those would be a page nobody could read.
  const text = renderText(DOCUMENTS, 100, NOW, NOW - 4);
  assert.equal(text.includes("Review adapter behavior"), true);
  assert.equal(text.includes("\u25b8 Worktrees"), true);
});

test("a row's segments land on one line, not one per line", () => {
  const lines = nodeLines({ type: "Box", props: { flexDirection: "row" }, children: [
    { type: "Text", props: {}, children: ["left"] },
    { type: "Text", props: { color: "error" }, children: ["right"] }] }, 40);
  assert.deepEqual(lines, ["leftright"]);
});

test("a row with a right slot is padded to the width it was given", () => {
  const lines = nodeLines({ type: "Box",
                            props: { flexDirection: "row", justifyContent: "space-between" },
                            children: [{ type: "Text", props: {}, children: ["a"] },
                                       { type: "Text", props: {}, children: ["b"] }] }, 10);
  // The gap is what is left after both readings, so the line is exactly the
  // width it was given.
  assert.equal(lines[0], "a" + " ".repeat(8) + "b");
  assert.equal(lines[0]?.length, 10);
});

test("a stacked line is indented under the one above it", () => {
  const lines = nodeLines({ type: "Box", props: { flexDirection: "column" }, children: [
    { type: "Text", props: {}, children: ["outer"] },
    { type: "Box", props: { flexDirection: "column" }, children: [
      { type: "Text", props: {}, children: ["inner"] }] }] }, 40);
  // Each level of nesting indents its children, the outermost one included, so a
  // line two levels down sits four columns in.
  assert.deepEqual(lines, ["  outer", "    inner"]);
});

test("a narrow width is honoured rather than widened", () => {
  const lines = nodeLines({ type: "Box",
                            props: { flexDirection: "row", justifyContent: "space-between" },
                            children: [{ type: "Text", props: {}, children: ["title"] },
                                       { type: "Text", props: {}, children: ["42 / 80"] }] }, 20);
  assert.equal(lines[0]?.length, 20);
});

test("a snapshot is read with the moment the read finished", () => {
  const { documents, generatedAt } = documentsOf({ generated_at: NOW, roster: { state: "empty" } });
  assert.equal(generatedAt, NOW);
  assert.equal((documents.roster as { state: string }).state, "empty");
});

test("input that is not an object is refused rather than guessed at", () => {
  for (const value of [null, 7, "a string", [1, 2]]) {
    assert.throws(() => documentsOf(value), /not an object/);
  }
});

test("a read that names no moment still renders", () => {
  const { generatedAt } = documentsOf({ roster: { state: "empty" } });
  assert.equal(typeof generatedAt, "number");
  assert.equal(generatedAt > 0, true);
});

test("a drawn pane fits the width it was given", () => {
  // Measured, not asserted structurally. The card carries the width while its
  // contents are budgeted for a wider interior, so every line of every group
  // ran off the edge and a case that read only the card's own props stayed
  // green. A bar is what makes the overflow visible, because it is drawn to
  // fill the room it was told it had.
  const documents: ReaderDocuments = {
    roster: { state: "ready", jobs: [], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
    progress: { state: "ready", errors: [], runs: [
      { key: "k", repo: "project", branch: "feature-a", label: "Test export boundaries",
        display: "Test export boundaries", done: 42, total: 80, failed: 1,
        first_failure: "", elapsed: 120, eta_minutes: null, phase: "running" }] },
  };
  for (const width of [60, 80, 100]) {
    const text = renderText(documents, width, NOW, NOW - 4);
    assert.ok(text.includes("\u2501"), "no bar was drawn at " + width);
    for (const line of text.split("\n")) {
      assert.ok(line.length <= width, width + ": " + JSON.stringify(line));
    }
  }
});

test("a card is printed with its rule, and two cards sit beside each other", () => {
  const card = { type: "Box" as const, props: { borderStyle: "round" as const, width: 12 },
                 children: [{ type: "Text" as const, props: {}, children: ["Working"] },
                            { type: "Text" as const, props: {}, children: ["5"] }] };
  const lines = nodeLines(card as never, 40);
  // A card printed without its rule would be a review of something nobody sees:
  // the rules and the rows are most of what makes a section read as a section.
  assert.equal(lines.length, 4);
  assert.equal(lines[0]?.startsWith("╭"), true);
  assert.equal(lines[0]?.endsWith("╮"), true);
  assert.equal(lines[3]?.startsWith("╰"), true);
  assert.equal(lines[1]?.includes("Working"), true);

  const pair = nodeLines({ type: "Box", props: { flexDirection: "row" },
                           children: [card, card] } as never, 40);
  // Side by side, line by line, rather than run together: three rows of two
  // cards is three rows, not one row of six.
  assert.equal(pair.length, lines.length);
  assert.equal(pair[0]?.includes("╮") && pair[0]?.includes("╭"), true);
});

test("the drawings are the open pane's bars, each with what it shows in its alt", () => {
  const documents: ReaderDocuments = {
    roster: { state: "ready", jobs: [], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
    progress: { state: "ready", errors: [], runs: [
      { key: "k", repo: "project", branch: "feature-a", label: "Test export boundaries",
        display: "Test export boundaries", done: 42, total: 80, failed: 1,
        first_failure: "", elapsed: 120, eta_minutes: null, phase: "running" }] },
  };
  const drawn = renderVectors(documents, 100, NOW, NOW - 4);
  assert.ok(drawn.length >= 1, "no drawing for a run with counts");
  for (const vector of drawn) {
    assert.ok(vector.source.startsWith("<svg"), vector.source.slice(0, 40));
    assert.ok(vector.alt.trim().length > 0);
    assert.ok(vector.cells > 0 && vector.cells <= 100, String(vector.cells));
  }
  assert.ok(drawn.some((vector) => vector.alt.includes("42")), JSON.stringify(drawn.map((v) => v.alt)));
});

test("a section folded shut draws nothing where it would have drawn a bar", () => {
  const documents: ReaderDocuments = {
    roster: { state: "ready", jobs: [], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
    progress: { state: "ready", errors: [], runs: [
      { key: "k", repo: "project", branch: "feature-a", label: "Test export boundaries",
        display: "Test export boundaries", done: 42, total: 80, failed: 1,
        first_failure: "", elapsed: 120, eta_minutes: null, phase: "running" }] },
  };
  const open = renderVectors(documents, 100, NOW, NOW - 4);
  const shut = renderVectors(documents, 100, NOW, NOW - 4,
                             { running: { visible: true, collapsed: true } });
  assert.ok(shut.length < open.length, open.length + " open, " + shut.length + " shut");
});

test("the drawings come out in the order the tree holds them, a drawn node's children unread", () => {
  const vector = (alt: string) => ({ source: "<svg/>", alt, cells: 4 });
  const tree = { type: "Box", props: {}, children: [
    { type: "Box", props: {}, vector: vector("first"),
      children: [{ type: "Box", props: {}, vector: vector("inside"), children: [] }] },
    "text",
    { type: "Box", props: {}, children: [
      { type: "Text", props: {}, vector: vector("second"), children: ["x"] }] },
  ] };
  assert.deepEqual(vectorsOf(tree as never).map((v) => v.alt), ["first", "second"]);
  assert.deepEqual(vectorsOf("text"), []);
});

test("a press prints its label and not its children, so a row is never printed twice", () => {
  // The figures are presses: a card is a Button over a chip and a word. Its
  // label carries the number, and reading the children as well printed the row
  // twice on the review page.
  const figure = { type: "Button",
                   props: { key: "fleet.focus.working", label: "4 Working sessions" },
                   children: [{ type: "Box", props: { flexDirection: "row", gap: 1 }, children: [
                     { type: "Text", props: {}, children: ["4"] },
                     { type: "Text", props: {}, children: ["Working sessions"] }] }] };
  assert.deepEqual(nodeLines(figure as never, 80), ["4 Working sessions"]);
  const heading = { type: "Button", props: { key: "h", label: "Warnings" }, children: [] };
  assert.deepEqual(nodeLines(heading as never, 80), ["Warnings"]);
});
