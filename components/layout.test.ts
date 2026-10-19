/**
 * Shared layout behavior.
 *
 * These cases assert the structure the layout produces, which is what a test can
 * honestly prove without a host: only Box and Text appear, a bar needs a real
 * denominator, a contradiction is reported rather than drawn, a failure survives
 * a collapsed group, and a long title does not push the state off the row.
 *
 * They do not prove how a surface paints. That belongs to an engine-mounted run,
 * which needs the engine and reports itself unavailable without it.
 *
 * Run with: node --test plugins/llm-fleet/components/layout.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Group, Pane, Row } from "../plugins/llm-fleet/components/layout.ts";
import type { Tree } from "../plugins/llm-fleet/components/host.ts";
import {
  ageText, barCells, countLabel, elementTypes, fit, fitSlots, groupMessage, groupTone,
  renderGroup, renderPane, renderRow, renderedText,
} from "../plugins/llm-fleet/components/layout.ts";
import { ACCENT } from "../plugins/llm-fleet/components/cards.ts";
import { mount, recordingPrimitives } from "../plugins/llm-fleet/components/mount.ts";

const WIDE = 120;
const NARROW_AT = 60;

function row(overrides: Partial<Row> = {}): Row {
  return { title: "Test suite", meta: [{ text: "2m elapsed" }], slot: [{ text: "42 / 80" }],
           ...overrides };
}

function group(overrides: Partial<Group> = {}): Group {
  return { name: "Background jobs", title: "Background sessions", summary: [{ text: "1 waiting" }],
           rows: [row()], state: "ready", ...overrides };
}

function pane(overrides: Partial<Pane> = {}): Pane {
  return { title: "Fleet", counts: [{ text: "3 working" }], updated: { text: "Updated 4s ago" },
           groups: [group()], width: WIDE, narrowAt: NARROW_AT, ...overrides };
}

test("a pane uses only Box and Text", () => {
  const tree = renderPane(pane({ groups: [group({ rows: [] }), group({ state: "failed" })] }));
  assert.deepEqual(elementTypes(tree), ["Box", "Text"]);
});

test("a headline figure is the control that opens what it counts", () => {
  const pressed: string[] = [];
  const tree = renderPane(pane({ cards: [
    { label: "Failed outcomes", value: "2", color: "error",
      press: { key: "fleet.focus.failed", label: "Failed outcomes",
               onPress: () => pressed.push("failed") } },
  ] }));
  const found: string[] = [];
  const walk = (node: Tree | string): void => {
    if (typeof node === "string") {
      return;
    }
    const props = node.props as { key?: string; onPress?: () => void };
    if (node.type === "Button" && typeof props.onPress === "function") {
      found.push(props.key ?? "unnamed");
      props.onPress();
    }
    node.children.forEach(walk);
  };
  walk(tree);
  assert.deepEqual(found, ["fleet.focus.failed"]);
  assert.deepEqual(pressed, ["failed"]);
});

test("a narrowed pane says so, and offers the press that widens it", () => {
  const words: string[] = [];
  const tree = renderPane(pane({
    focus: { text: "Showing failed only.",
             clear: { key: "fleet.focus.clear", label: "Show all",
                      onPress: () => words.push("clear") } },
  }));
  const drawn = renderedText(tree);
  assert.equal(drawn.includes("Showing failed only."), true);
  assert.equal(drawn.includes("Show all"), true);
  const walk = (node: Tree | string): void => {
    if (typeof node === "string") {
      return;
    }
    const props = node.props as { key?: string; onPress?: () => void };
    if (node.type === "Button" && props.key === "fleet.focus.clear") {
      props.onPress?.();
    }
    node.children.forEach(walk);
  };
  walk(tree);
  assert.deepEqual(words, ["clear"]);
});

test("a row pressed open draws what it holds in full, and a row left shut does not", () => {
  const details = [{ text: "folder /tmp/project" }, { text: "provider one" }];
  const open = renderedText(renderPane(pane({ groups: [group({
    rows: [row({ details, detailsPress: { key: "fleet.details.1", label: "details",
                                          onPress: () => undefined }, expanded: true })] })] })));
  assert.equal(open.includes("folder /tmp/project"), true);
  assert.equal(open.includes("provider one"), true);
  const shut = renderedText(renderPane(pane({ groups: [group({
    rows: [row({ details, detailsPress: { key: "fleet.details.1", label: "details",
                                          onPress: () => undefined } })] })] })));
  assert.equal(shut.includes("folder /tmp/project"), false);
});

test("a section names the figures in its columns, once, above its rows", () => {
  const columns = [{ text: "CPU", width: 6, align: "right" as const },
                   { text: " MEM", width: 8, align: "left" as const }];
  const open = renderedText(renderPane(pane({ groups: [group({ columns })] })));
  const names = open.indexOf("CPU");
  assert.equal(names > 0, true);
  assert.equal(names < open.indexOf("Test suite"), true, "the names head the rows");
  // Folded, the section draws no rows, so it names no columns above them.
  const folded = renderedText(renderPane(pane({ groups: [group({ columns, collapsed: true })] })));
  assert.equal(folded.includes("CPU"), false);
});

test("the footer is the pane's last line, drawn dim and cut rather than wrapped", () => {
  const footer = { text: "llm-fleet 0.3.15 · Doric Stack LLC · MIT", dim: true };
  const tree = renderPane(pane({ footer }));
  assert.equal(renderedText(tree).at(-1), footer.text);
  // Dim on the node itself: a footer drawn in the body color competes with what
  // the pane reports, which is the one thing it must not do.
  const drawn: { text: string; dim: boolean }[] = [];
  const walk = (node: Tree | string): void => {
    if (typeof node === "string") {
      return;
    }
    const props = node.props as { dimColor?: boolean };
    if (node.type === "Text" && node.children[0] === footer.text) {
      drawn.push({ text: footer.text, dim: props.dimColor === true });
    }
    node.children.forEach(walk);
  };
  walk(tree);
  assert.deepEqual(drawn, [{ text: footer.text, dim: true }]);
  const narrow = renderedText(renderPane(pane({ footer, width: 24 }))).at(-1) ?? "";
  assert.equal(narrow.length, 24);
  assert.equal(narrow.endsWith("..."), true);
});

test("the same tree renders through a host binding without changing its structure", () => {
  // Both surfaces declare Box and Text with the same props, so one binding
  // serves them; a mounted tree is compared with the tree it was built from.
  const tree = renderPane(pane());
  const mounted = mount(tree, recordingPrimitives());
  assert.deepEqual(mounted, tree);
});

test("a measured row draws a bar across the width it was given", () => {
  const tree = renderRow(row({ bar: { done: 42, total: 80 } }), WIDE, NARROW_AT);
  const runs = barRuns(tree);
  // Two runs: the part that is done, in color, and the part that is not, dim.
  // Together they take the row's line less the two-cell indent under the dot
  // and the counts beside them, so items with the same counts are read against
  // the same length rather than against whichever title sits above them.
  assert.equal(runs.length, 2);
  assert.equal(runs.map((run) => run.text).join("").length, WIDE - 2 - ("42 / 80".length + 2));
  assert.equal(runs[0]?.dim, false);
  assert.equal(runs[0]?.color, "success");
  assert.equal(runs[1]?.dim, true);
});

test("a row with no denominator draws no bar and says so", () => {
  const silent = renderRow(row({ bar: undefined }), WIDE, NARROW_AT);
  assert.equal(renderedText(silent).some((value) => value.startsWith("#")), false);
  assert.equal(renderedText(silent).includes("No counts yet"), false);
  for (const bar of [{ done: 0, total: 0 }, { done: 5, total: -1 }]) {
    const tree = renderRow(row({ bar }), WIDE, NARROW_AT);
    assert.equal(renderedText(tree).some((value) => value.startsWith("#")), false);
    assert.equal(renderedText(tree).includes("No counts yet"), true);
  }
});

test("counts that contradict themselves are reported, never drawn as success", () => {
  const tree = renderRow(row({ bar: { done: 42, total: 80 } }), WIDE, NARROW_AT);
  const drawn = (values: string[]): string[] =>
    values.filter((value) => /^\u2501+$/.test(value));
  assert.equal(drawn(renderedText(tree)).length, 2);
  const impossible = renderRow(row({ bar: { done: 90, total: 80 } }), WIDE, NARROW_AT);
  // Counts that cannot both be true are reported, never drawn as progress: a bar
  // here would be the pane showing 113% of a run as though that meant something.
  assert.equal(drawn(renderedText(impossible)).length, 0);
  assert.equal(renderedText(impossible).includes("90 of 80"), true);
  assert.equal(barCells(20, 90, 80), "");
});

test("a failed outcome is colored and labeled, and a full bar can still be failed", () => {
  const tree = renderRow(row({ bar: { done: 80, total: 80, failed: 3 } }), WIDE, NARROW_AT);
  const values = renderedText(tree);
  assert.equal(values.includes("80 / 80"), true);
  assert.equal(values.includes(" \u00b7 3 failed"), true);
  const colors = JSON.stringify(tree);
  assert.equal(colors.includes("\"error\""), true);
});

test("a stopped run keeps its original denominator and says it stopped", () => {
  const tree = renderRow(row({ bar: { done: 42, total: 80, stopped: true } }), WIDE, NARROW_AT);
  const values = renderedText(tree);
  assert.equal(values.includes("42 / 80"), true);
  assert.equal(values.includes(" \u00b7 Stopped early"), true);
});

test("a long title is cut and the state and denominator are not", () => {
  const long = "x".repeat(400);
  const tree = renderRow(row({ title: long, slot: [{ text: "42 / 80" }] }), 40, NARROW_AT);
  const values = renderedText(tree);
  assert.equal(values.includes("42 / 80"), true);
  assert.equal(values.some((value) => value === long), false);
  assert.equal(values.some((value) => value.endsWith("...")), true);
});

test("a narrow row keeps its title and its right slot, and drops who runs it", () => {
  const tree = renderRow(row(), 30, NARROW_AT);
  const values = renderedText(tree);
  assert.equal(values.includes("42 / 80"), true);
  assert.equal(values.includes("Test suite"), true);
  // Too narrow for the meta beside the title, it moves to the hover lines
  // rather than squeezing the title and the slot off the line.
  const hidden = nodesIn(tree).find((node) => node.props.display === "none");
  assert.equal(renderedText(hidden as never).join("").includes("2m elapsed"), true);
});

test("a pressable pane draws only Box, Text and Button", () => {
  const tree = renderPane(pane({
    controls: [{ key: "fleet.all.collapse", label: "Collapse all", hotkey: "c", onPress: () => undefined }],
    groups: [
      group({ toggle: { key: "fleet.section.jobs", label: "- Background jobs", hotkey: "1", onPress: () => undefined } }),
      group({ collapsed: true, toggle: { key: "fleet.section.trials", label: "+ Trials", hotkey: "2", onPress: () => undefined } }),
    ],
  }));
  assert.deepEqual(elementTypes(tree), ["Box", "Button", "Text"]);
});

/** Every Button in a tree, in drawing order. */
/** Every color the drawn tree paints with, wherever it appears. */
function colorsIn(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const record = node as { props?: { color?: unknown }; children?: unknown };
  if (typeof record.props?.color === "string") {
    found.push(record.props.color);
  }
  const children = Array.isArray(record.children) ? record.children : [record.children];
  for (const child of children) {
    colorsIn(child, found);
  }
  return found;
}

function buttons(tree: Tree): { key: string; label: string; hotkey?: string }[] {
  const found: { key: string; label: string; hotkey?: string }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    const record = node as { type?: string; props?: Record<string, unknown>;
                             children?: readonly unknown[] };
    if (record.type === "Button") {
      found.push(record.props as { key: string; label: string; hotkey?: string });
    }
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(tree);
  return found;
}

test("a section heading is pressable and its label says which way it is folded", () => {
  const open = renderPane(pane({ groups: [group({ toggle: { key: "k", label: "- Jobs", onPress: () => undefined } })] }));
  const shut = renderPane(pane({ groups: [group({ collapsed: true, toggle: { key: "k", label: "+ Jobs", onPress: () => undefined } })] }));
  // What a person reads is the fold, not a word they have to hold a legend for.
  assert.equal(renderedText(open).includes("- Jobs"), true);
  assert.equal(renderedText(shut).includes("+ Jobs"), true);
  // The heading is the button itself, addressed by the key a press carries back.
  assert.deepEqual(buttons(open).map((item) => [item.key, item.label]), [["k", "- Jobs"]]);
  assert.deepEqual(buttons(shut).map((item) => [item.key, item.label]), [["k", "+ Jobs"]]);
});

test("every control carries a distinct hotkey, since two would clash", () => {
  const tree = renderPane(pane({
    controls: [
      { key: "fleet.all.collapse", label: "Collapse all", hotkey: "c", onPress: () => undefined },
      { key: "fleet.all.expand", label: "Expand all", hotkey: "e", onPress: () => undefined },
    ],
    groups: [group({ toggle: { key: "a", label: "- A", hotkey: "1", onPress: () => undefined } }),
             group({ toggle: { key: "b", label: "- B", hotkey: "2", onPress: () => undefined } })],
  }));
  const hotkeys = buttons(tree).map((item) => item.hotkey ?? "");
  assert.deepEqual([...hotkeys].sort(), ["1", "2", "c", "e"]);
  assert.equal(new Set(hotkeys).size, hotkeys.length);
});

test("a row the width has room for keeps the right slot on the same line", () => {
  const tree = renderRow(row(), WIDE, NARROW_AT);
  const head = tree.children[0];
  const props = typeof head === "string" ? "" : JSON.stringify(head?.props);
  // The mirror of the narrow case, and the half that was missing: a row that
  // stacked at every width passes the narrow case and draws every row of a wide
  // pane over two lines, which is what the width is measured for.
  assert.equal(props.includes("column"), false);
  assert.equal(props.includes("row"), true);
});

test("a row carries what could not be read about it", () => {
  const tree = renderRow(row({ note: { text: "held by 2 processes", color: "warning" } }),
                         WIDE, NARROW_AT);
  assert.equal(renderedText(tree).includes("held by 2 processes"), true);
});

test("a row carries a line of its own, such as what is being asked", () => {
  const tree = renderRow(row({ detail: "Which source should this adapter read?" }), WIDE,
                         NARROW_AT);
  assert.equal(renderedText(tree).includes("Which source should this adapter read?"), true);
});

test("each group state says something a reader can act on", () => {
  assert.deepEqual(
    groupMessage(group({ state: "empty", emptyText: "No background jobs in the configured sources." })),
    [{ text: "No background jobs in the configured sources.", dim: true }]);
  assert.deepEqual(
    groupMessage(group({ state: "disabled", disabledText: "Background jobs are disabled in configuration." })),
    [{ text: "Background jobs are disabled in configuration.", dim: true }]);
  // Without a section's own wording, the generic sentence still reads.
  assert.deepEqual(groupMessage(group({ state: "disabled", name: "Worktrees" })),
                   [{ text: "Worktrees is disabled in configuration.", dim: true }]);
  assert.equal(groupMessage(group({ state: "failed", failure: "Provider A" }))[0]?.text,
               "Could not read Provider A. Count unknown.");
  assert.equal(groupMessage(group({ state: "failed", failure: "Provider A" }))[0]?.color, "error");
  assert.equal(groupMessage(group({ state: "unavailable", failure: "the API" }))[0]?.color,
               "warning");
  assert.deepEqual(groupMessage(group({ state: "empty" })).length, 1);
});

test("a stale group keeps its observed count and the age of the last good read", () => {
  const message = groupMessage(group({ state: "stale", observed: 2, staleSeconds: 180 }));
  assert.deepEqual(message, [{ text: "2 observed, as of 3m ago. Refresh failed.",
                              color: "warning" }]);
});

test("a failed group says so even when it is collapsed", () => {
  const collapsed = renderGroupText(group({ state: "failed", failure: "Provider A",
                                           collapsed: true }));
  assert.equal(collapsed.includes("Could not read Provider A. Count unknown."), true);
  const ready = renderGroupText(group({ collapsed: true }));
  assert.equal(ready.includes("2m elapsed"), false);
  assert.equal(ready.includes("Test suite"), false);
});

test("a healthy empty group is not a failure and a failure is not empty", () => {
  const healthy = renderGroupText(group({ state: "empty", rows: [] }));
  const failed = renderGroupText(group({ state: "failed", rows: [], failure: "Provider A" }));
  assert.equal(healthy.some((value) => value.includes("No background jobs")), true);
  assert.equal(healthy.some((value) => value.toLowerCase().includes("could not read")), false);
  assert.equal(failed.some((value) => value.includes("Could not read Provider A")), true);
  assert.equal(failed.some((value) => value.includes("No background jobs")), false);
});

test("the header names the counts and the warning beside them", () => {
  const tree = renderPane(pane({ warning: { text: "1 source unavailable", color: "warning" } }));
  const values = renderedText(tree);
  assert.equal(values.includes("3 working"), true);
  // One space, so the two readings do not run together.
  assert.equal(values.includes(" 1 source unavailable"), true);
  assert.equal(values.includes("Updated 4s ago"), true);
  const updated = values.find((value) => value === "Updated 4s ago");
  assert.equal(updated, "Updated 4s ago");
});

test("the figures are stated once, as cards or as a line, never both", () => {
  // The pane drew the same three numbers twice: as a line beside the title and
  // as a row of cards under it. One statement is the point of the rule, and the
  // line is what survives when a card cannot be drawn.
  const both: Partial<Pane> = {
    cards: [{ label: "Working sessions", value: "2" }],
    counts: [{ text: "2 working" }],
  };
  const drawn = renderedText(renderPane(pane(both)));
  assert.equal(drawn.includes("Working sessions"), true);
  assert.equal(drawn.includes("2 working"), false);

  const noCards = renderedText(renderPane(pane({ cards: [], counts: [{ text: "2 working" }] })));
  assert.equal(noCards.includes("2 working"), true);
  assert.equal(noCards.includes("Working sessions"), false);
});

test("groups render in the order the pane gives them", () => {
  const tree = renderPane(pane({ groups: [group({ title: "Trials" }),
                                          group({ title: "Pull requests" })] }));
  const titles = renderedText(tree);
  assert.equal(titles.indexOf("Trials") < titles.indexOf("Pull requests"), true);
});

test("a width the layout cannot use produces no bar rather than a broken one", () => {
  assert.equal(barCells(0, 1, 2), "");
  assert.equal(barCells(-5, 1, 2), "");
  assert.equal(fit("value", 0), "");
  assert.equal(barCells(10, 0, 10), "----------");
  assert.equal(barCells(10, 10, 10), "##########");
  assert.equal(barCells(3, 1, 3), "#--");
});

test("a denominator is never invented for a run that has none", () => {
  assert.deepEqual(countLabel(undefined), { text: "No counts yet", color: "warning" });
  assert.deepEqual(countLabel({ done: 0, total: 0 }), { text: "No counts yet",
                                                        color: "warning" });
  assert.deepEqual(countLabel({ done: Number.NaN, total: 80 }), { text: "No counts yet",
                                                                  color: "warning" });
  assert.deepEqual(countLabel({ done: 1, total: Number.POSITIVE_INFINITY }),
                   { text: "No counts yet", color: "warning" });
});

test("an age is one unit and never a negative", () => {
  assert.equal(ageText(-5), "0s ago");
  assert.equal(ageText(30), "30s ago");
  assert.equal(ageText(180), "3m ago");
  assert.equal(ageText(7200), "2h ago");
  assert.equal(ageText(172800), "2d ago");
});

test("the dot is the row's state, and a row with no state draws the quiet one", () => {
  // Read from a row that carries nothing else: a case that reads a populated
  // row's colors cannot tell the dot's from the ones its own slots paint, and
  // a dot forced to the quiet default passes it. That is the defect this case
  // exists to be able to fail on.
  //
  // A state that needs a person or failed also marks the title in the same
  // color, behind its accent and on no fill; a working one does not.
  const failed = renderRow({ title: "x", state: "failed", meta: [], slot: [] },
                           WIDE, NARROW_AT);
  assert.deepEqual([...new Set(colorsIn(failed))].sort(), ["error"]);
  const working = renderRow({ title: "x", state: "working", meta: [], slot: [] },
                            WIDE, NARROW_AT);
  assert.deepEqual([...new Set(colorsIn(working))].sort(), ["success"]);
  const plain = renderRow({ title: "x", meta: [], slot: [] }, WIDE, NARROW_AT);
  assert.deepEqual([...new Set(colorsIn(plain))].sort(), ["subtle"]);
});

test("a section is given the pane's width rather than sized to its contents", () => {
  // The rows inside were laid out for the pane's width less the section's
  // padding. A section left to size itself adds the padding on top of that
  // width, so the last columns fall off the right edge of a terminal that is
  // exactly the width the pane was given.
  for (const width of [40, 80, WIDE]) {
    const drawn = renderGroup(group(), width, NARROW_AT);
    const props = (drawn as { props?: { width?: unknown; borderStyle?: unknown } }).props ?? {};
    assert.equal(props.borderStyle, undefined, String(width));
    assert.equal(props.width, width, String(width));
  }
});

function renderGroupText(value: Group): string[] {
  const tree = renderPane(pane({ groups: [value] }));
  return renderedText(tree);
}

test("a section is drawn as its mark, its name and its count, with no card round it", () => {
  const tree = renderGroup(group(), WIDE, NARROW_AT);
  const props = (tree as { props?: Record<string, unknown> }).props ?? {};
  assert.equal(props.borderStyle, undefined);
  // The accent before the name is its own text, not part of the name.
  const lines = renderedText(tree).filter((value) => value.trim());
  // The mark says which way the section is folded, the name says which section
  // it is, and the count says what it holds.
  assert.deepEqual(lines.slice(0, 4), ["\u25be", ACCENT, "Background sessions", "1 waiting"]);
});

test("a section with nothing in it is a line, and a failed one still says so", () => {
  // No section is a card now: a section with rows is its heading and the rail
  // its rows hang off, and one with nothing in it is its heading and the words
  // for why. A failure keeps its message however empty it is: an error drawn as
  // a section name alone is an error nobody notices.
  for (const state of ["failed", "unavailable", "stale"] as const) {
    const drawn = renderedText(renderGroup(group({ rows: [], state }), WIDE, NARROW_AT));
    assert.equal(drawn.some((value) => value.includes("Could not read")
      || value.includes("Refresh failed")), true, state);
  }
  // And the line still carries the mark, the name and the count, which is what
  // a reader needs and no more. The legend goes with the rows: a section drawn
  // as a line has nothing under it to explain.
  const stated = renderedText(renderGroup(
    group({ rows: [], state: "empty", legend: "Background sessions by state." }),
    WIDE, NARROW_AT)).filter((value) => value.trim());
  assert.deepEqual(stated, ["\u25be", ACCENT, "Background sessions", "1 waiting",
                            "No background jobs here."]);
  assert.equal(renderedText(renderGroup(
    group({ legend: "Background sessions by state." }), WIDE, NARROW_AT))
    .includes("Background sessions by state."), true);
});

test("a heading's counts are cut to the room the heading leaves them", () => {
  const many: Group = group({
    title: "Worktrees",
    summary: [{ text: "30 checked out" }, { text: "  23 active" }, { text: "  3 held" },
              { text: "  3 merged" }, { text: "  1 unknown" }],
  });
  // The figures are one text node each, so a heading with room to spare draws
  // every one of them as it was written.
  const roomy = renderedText(renderGroup(many, WIDE, NARROW_AT));
  for (const figure of ["30 checked out", "  23 active", "  3 held", "  3 merged",
                        "  1 unknown"]) {
    assert.equal(roomy.includes(figure), true, figure);
  }
  // A heading's figures are the tail of a line that already holds the section's
  // name, so a section with five of them runs past the edge and what a reader
  // loses is the last figure and the rule around it. The cut is marked where it
  // happened rather than left to the surface.
  // The room is what the section leaves after its padding, the name, and the
  // seven cells the fold mark, a hotkey and the gaps between them take.
  const tight = renderedText(renderGroup(many, 28, NARROW_AT));
  // The cut backs up to the last word boundary, so the first figure is drawn as
  // its count and the mark rather than as half of the word after it.
  const counts = tight.filter((value) => value.startsWith("30"));
  assert.equal(counts.length, 1);
  assert.equal((counts[0] ?? "").length <= 28 - 2 - "Worktrees".length - 7, true);
  assert.equal((counts[0] ?? "").endsWith("..."), true);
  // A heading with room to spare is not cut, and neither is one with no counts.
  assert.equal(renderedText(renderGroup(group({ summary: [] }), WIDE, NARROW_AT))
                 .includes("Worktrees"), false);
  // A name already longer than the card leaves its figures no room at all, and
  // that is the case this exists for: the figures go rather than being drawn
  // whole across a card they do not fit in.
  const long = renderGroup(group({ title: "A very long configured section name",
                                   summary: [{ text: "30 checked out" }] }), 40, NARROW_AT);
  const drawn = renderedText(long);
  assert.equal(drawn.some((value) => value.includes("30 checked out")), false);
  assert.equal(drawn.some((value) => value.startsWith("A very long")), true);
});

test("a section's strip is drawn above its rows, and not while folded", () => {
  const history = { label: "Last 12 hours",
                    cells: [{ outcomes: 1, failed: 0 }, { outcomes: 2, failed: 1 }],
                    outcomes: 3, failed: 1 };
  const lines = renderedText(renderGroup(group({ history }), WIDE, NARROW_AT));
  // The cells are one text node each, so what the drawing holds is the caption
  // and the count of them, not a run of characters.
  const cells = lines.filter((value) => value === "\u2501").length;
  const caption = lines.indexOf("Last 12 hours");
  assert.equal(cells, 2);
  // Above the first row and below the count: what the recent past did is what a
  // reader looks for before reading any single row of it.
  assert.equal(caption > lines.indexOf("1 waiting"), true);
  assert.equal(caption < lines.indexOf("Test suite"), true);
  assert.equal(lines.includes(" 3 outcomes"), true);
  // A folded section gave that room back, so the strip goes with the rows.
  const folded = renderedText(renderGroup(group({ history, collapsed: true }), WIDE, NARROW_AT));
  assert.equal(folded.includes("Last 12 hours"), false);
  // A section with no strip draws none, rather than the cells of some other one.
  assert.equal(renderedText(renderGroup(group(), WIDE, NARROW_AT)).includes("Last 12 hours"),
               false);
});

test("a folded section is marked as folded and draws no rows", () => {
  const lines = renderedText(renderGroup(group({ collapsed: true }), WIDE, NARROW_AT));
  assert.equal(lines[0], "\u25b8");
  // The count stays: a folded section still says what it holds, which is what
  // makes folding safe to do.
  assert.equal(lines.includes("1 waiting"), true);
  assert.equal(lines.includes("Test suite"), false);
});

test("a section's legend is drawn with its rows, and a folded section states no legend", () => {
  // The legend is what the section's counts mean, so it belongs with them: a
  // row of figures at the right of a heading cannot say what they count.
  const open = renderedText(renderGroup(group({ legend: "Background sessions by state." }),
                                        WIDE, NARROW_AT));
  assert.equal(open.includes("Background sessions by state."), true);
  assert.equal(open.indexOf("Background sessions by state."), open.indexOf("1 waiting") + 1);
  // Folded, the section states its figures and does not explain them, which is
  // what folding it asked for. A section that explained them anyway would take
  // the room folding it gave back.
  const folded = renderedText(renderGroup(
    group({ collapsed: true, legend: "Background sessions by state." }), WIDE, NARROW_AT));
  assert.equal(folded.includes("Background sessions by state."), false);
  // A section with no legend draws nothing in its place: an absent legend is not
  // an empty line under every heading.
  const bare = renderedText(renderGroup(group({ legend: null }), WIDE, NARROW_AT));
  assert.deepEqual(bare, renderedText(renderGroup(group(), WIDE, NARROW_AT)));
});

test("a section whose source failed is headed in the error color and keeps its warning", () => {
  const tree = renderGroup(group({ state: "failed", rows: [] }), WIDE, NARROW_AT);
  const name = nodesIn(tree).find((node) => node.type === "Text" && node.props.bold === true
    && node.children[0] === "Background sessions")?.props;
  assert.equal(name?.color, "error");
  assert.equal(name?.backgroundColor, undefined);
  // An error hidden behind a quiet heading is a claim that nothing is wrong.
  assert.equal(renderedText(tree).includes("1 waiting"), true);
});

/** Every node in a tree, outermost first, for reading the props the layout wrote. */
/** Each run of bar cells a tree draws, with its color and whether it is dim. */
function barRuns(tree: unknown): { text: string; color?: string; dim: boolean }[] {
  return nodesIn(tree)
    .filter((node) => node.type === "Text" && node.children.length === 1
      && typeof node.children[0] === "string" && /^\u2501+$/.test(node.children[0]))
    .map((node) => ({ text: node.children[0] as string,
                      color: node.props.color as string | undefined,
                      dim: node.props.dimColor === true }));
}

/** A row's own lines, without the card its hover draws: the card takes no room. */
function drawnChildren(tree: unknown): unknown[] {
  const children = (tree as { children?: unknown[] }).children ?? [];
  return children.filter((child) => {
    if (child === null || typeof child !== "object") {
      return true;
    }
    const props = (child as { props?: Record<string, unknown> }).props ?? {};
    return !(props.display === "none" && props.position === "absolute");
  });
}

function nodesIn(tree: unknown): { type: string; props: Record<string, unknown>; children: unknown[] }[] {  const found: { type: string; props: Record<string, unknown>; children: unknown[] }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    const record = node as { type: string; props: Record<string, unknown>; children: unknown[] };
    // A row's hover card is out of the flow and hidden at rest, so it draws no
    // cells: what a row takes is measured without it.
    if (record.props.display === "none" && record.props.position === "absolute") {
      return;
    }
    found.push(record);
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(tree);
  return found;
}

test("a line too long for its card is cut from its end, each segment keeping its style", () => {
  const slots = [{ text: "Claude" }, { text: " \u00b7 opus 5.5" },
                 { text: " \u00b7 high", color: "suggestion" as const },
                 { text: " \u00b7 ~$4.10" }, { text: " \u00b7 12.4M tokens" }];
  // Room for every segment draws every segment, untouched.
  assert.deepEqual(fitSlots(slots, 200), slots);
  // The cut lands in the segment that crosses the edge, which keeps its own
  // color and ends with the mark; nothing after it is drawn. Drawn uncut, a row
  // of texts too wide for its line is squeezed segment by segment by the
  // surface, and each segment wraps into a column of its own.
  const cut = fitSlots(slots, 26);
  assert.equal(cut.map((slot) => slot.text).join("").length <= 26, true);
  assert.equal(cut.length, 3);
  assert.equal(cut[2]?.color, "suggestion");
  assert.equal(cut[2]?.text.endsWith("..."), true);
  // A segment with no room at all is left out, and a dim mark of its own says
  // the line went on: the segment before it stays whole and keeps its color.
  const marked = fitSlots(slots, 28);
  assert.deepEqual(marked.map((slot) => slot.text), ["Claude", " \u00b7 opus 5.5", " \u00b7 high", " ..."]);
  assert.equal(marked[3]?.dim, true);
  // No room for any of the next segment puts the mark on the one before it, so
  // a reader still sees that the line goes on.
  const tight = fitSlots([{ text: "abcdefghij" }, { text: " klmnop" }], 12);
  assert.deepEqual(tight.map((slot) => slot.text), ["abcdefg..."]);
  assert.deepEqual(fitSlots(slots, 0), []);
});

test("a slot drawn in a column of its own width keeps the next column in place", () => {
  // A figure is padded inside its own column rather than being drawn at the
  // width it happens to need: a percentage of four characters and one of five
  // otherwise put the figure after them one cell apart, row to row.
  const short = fitSlots([{ text: "8.6%", width: 6, align: "right" }, { text: "430 MB" }], 40);
  const long = fitSlots([{ text: "98.8%", width: 6, align: "right" }, { text: "430 MB" }], 40);
  assert.equal(short[0]?.text, "  8.6%");
  assert.equal(long[0]?.text, " 98.8%");
  // The column after it starts at the same cell in both rows.
  assert.equal(short[1]?.text.startsWith(" "), long[1]?.text.startsWith(" "));
  assert.equal((short[0]?.text ?? "").length + (short[1]?.text ?? "").length,
               (long[0]?.text ?? "").length + (long[1]?.text ?? "").length);
  // A left-aligned column pads after its text.
  const left = fitSlots([{ text: "3 MB", width: 8, align: "left" }, { text: "x" }], 40);
  assert.equal(left[0]?.text, "3 MB    ");
});

test("a segment cut for room ends on a whole word rather than half of one", () => {
  // A segment can hold more than one fact, and the strip's last one holds a
  // duration and the word after it. Cutting on the character sliced that word
  // and drew "10h 29m lon...", which reads as a figure rather than as a cut.
  const slots = [{ text: "3 working" }, { text: "  10 done" },
                 { text: "  at least 178.5M tokens" }, { text: "  10h 29m longest", dim: true }];
  const cut = fitSlots(slots, 58);
  assert.equal(cut[cut.length - 1]?.text, "  10h 29m...");
  // A single word with no room to keep it is still cut and marked: there is no
  // boundary to back up to, and a line that dropped it would say less.
  assert.deepEqual(fitSlots([{ text: "aaaaaaaaaaaaaaaaaaaa" }], 8).map((slot) => slot.text),
                   ["aaaaa..."]);
  // A cut landing on a boundary keeps the word whole, mark and all.
  assert.deepEqual(fitSlots([{ text: "alpha beta gamma" }], 13).map((slot) => slot.text),
                   ["alpha beta..."]);
});

test("a count on a chip is dropped whole rather than cut", () => {
  // Half a count on a fill reads as a different count, so a chip that does not
  // fit is not drawn at all; the plain figure before it keeps its place.
  const slots = [{ text: "2 waiting", color: "warning" as const },
                 { text: "  12 working", color: "success" as const }];
  // A chip is drawn two cells wider than its word, and the cut counts them.
  assert.deepEqual(fitSlots(slots, 11, true).map((slot) => slot.text), ["2 waiting"]);
  // With room for the mark it follows the chip as its own segment, never on
  // the chip's fill, where it would read as part of the count.
  assert.deepEqual(fitSlots(slots, 15, true).map((slot) => slot.text), ["2 waiting", " ..."]);
  const summary = fitSlots([{ text: "2 waiting", color: "warning" as const }, { text: "   " },
                            { text: "12 working" }], 13, true);
  assert.equal(summary[0]?.text, "2 waiting");
  assert.equal(summary.some((slot) => slot.text.includes("wai...")), false);
  assert.deepEqual(fitSlots(slots, 10, true), []);
  assert.equal(fitSlots(slots, 25, true).length, 2);
});

test("a row carries its whole line in a card its own hover draws", () => {
  const titled = "A title long enough that the row has to cut it somewhere";
  const tree = renderRow(row({ title: titled, meta: [{ text: "owner/example-repository" }],
                               slot: [{ text: "12 passed" }] }), 40, 20);
  // The host draws no tooltip, so the whole line is a box in the tree: out of
  // the flow, hidden, and revealed by the row's own hover scope.
  const card = (tree as { children: Node[] }).children.find((child) => {
    const props = child.props as { display?: unknown; position?: unknown };
    return props.display === "none" && props.position === "absolute";
  });
  assert.ok(card !== undefined, "the row draws no hover card");
  const props = card.props as { hover?: { display?: unknown }; width?: unknown };
  assert.equal(props.hover?.display, "flex");
  // It holds the words the row cut, and it fits inside the row it belongs to.
  assert.deepEqual((card.children[0] as { children: unknown[] }).children,
                   [titled + "owner/example-repository  12 passed"]);
  assert.equal(typeof props.width === "number" && props.width <= 40, true);
  // What the pane draws at rest is still the cut line: the card is not a second
  // copy of the row on screen.
  assert.equal(renderedText(tree).join(" ").includes(titled), false);
  // A row with nothing to say draws no card rather than an empty one.
  const bare = renderRow({ title: "", meta: [], slot: [] }, 40, 20);
  assert.equal(nodesIn(bare).some((node) => node.props.position === "absolute"), false);
});

test("a colored segment on a line that draws no chips is cut like text, never dropped whole", () => {
  // Only a summary draws its counts as chips; elsewhere a warning is colored
  // text, and measured as a chip it was dropped for want of a cell.
  const slots = [{ text: "Nothing new" }, { text: " trials could not be read", color: "warning" as const }];
  const cut = fitSlots(slots, 26).map((slot) => slot.text);
  assert.equal(cut.length, 2);
  // Colored rather than chipped, so it is cut and kept; the cut backs up to the
  // word boundary, which drops the half word the mark would otherwise sit on.
  assert.equal(cut[1], " trials...");
  assert.match(cut[1] ?? "", /\.\.\.$/);
  // Whole when it fits, to the cell: a chip would have needed two more.
  assert.deepEqual(fitSlots(slots, 36).map((slot) => slot.text), ["Nothing new", " trials could not be read"]);
});

test("a card's rule is drawn in the loudest state it holds", () => {
  const live = (state: string) => row({ state });
  assert.equal(groupTone(group({ state: "failed" })), "error");
  assert.equal(groupTone(group({ state: "unavailable" })), "warning");
  assert.equal(groupTone(group({ state: "stale" })), "warning");
  assert.equal(groupTone(group({ rows: [live("working"), live("failed")] })), "error");
  assert.equal(groupTone(group({ rows: [live("working"), live("waiting")] })), "warning");
  assert.equal(groupTone(group({ rows: [live("passed"), live("working")] })), "success");
  // A state the pane does not know is the quiet rule, never a verdict.
  assert.equal(groupTone(group({ rows: [live("wat")] })), "subtle");
  assert.equal(groupTone(group({ rows: [row()] })), "subtle");
});

test("a calm rail rests dim; a rail that warns is drawn at full strength", () => {
  const railOf = (tree: unknown) => nodesIn(tree).find((node) => node.type === "Text"
    && (node.children[0] === "\u2514\u2500" || node.children[0] === "\u251c\u2500"));
  const calm = railOf(renderGroup(group({ rows: [row({ state: "working" })] }), WIDE, NARROW_AT));
  assert.equal(calm?.props.color, "success");
  assert.equal(calm?.props.dimColor, true);
  const loud = railOf(renderGroup(group({ rows: [row({ state: "waiting" })] }), WIDE, NARROW_AT));
  assert.equal(loud?.props.color, "warning");
  assert.equal(loud?.props.dimColor, undefined);
  // The section is still a hover scope, addressed by what it is.
  const section = renderGroup(group({ rows: [row()] }), WIDE, NARROW_AT) as
    { props: { key?: unknown } };
  assert.equal(typeof section.props.key, "string");
});

test("a section's legend is the card's hint, shown under the pointer and hidden at rest", () => {
  const tree = renderGroup(group({ legend: "Sessions by state." }), WIDE, NARROW_AT);
  // Still in the tree, so a reader of what the pane says finds it; drawn only
  // while the pointer is on the card.
  assert.equal(renderedText(tree).includes("Sessions by state."), true);
  const holder = nodesIn(tree).find((node) => node.props.display === "none");
  assert.deepEqual(holder?.props.hover, { display: "flex" });
  assert.equal(renderedText(holder as never).includes("Sessions by state."), true);
});

test("each row is a hover scope of its own, addressed by what it is", () => {
  const tree = renderGroup(group({ rows: [row({ key: "one:job-1" }), row({ title: "Other" })] }),
                           WIDE, NARROW_AT);
  const keys = nodesIn(tree).map((node) => node.props.key).filter(
    (key): key is string => typeof key === "string" && key.startsWith("row:"));
  // A row with a key of its own keeps it across readings; one without is
  // addressed by its place. No two siblings share one, or neither would scope.
  assert.deepEqual(keys, ["row:Background sessions:one:job-1", "row:Background sessions:1"]);
});

test("a title that needs a person or failed is marked in its color, and every other one is bold", () => {
  const drawn = (state: string) => nodesIn(renderRow(row({ state }), WIDE, NARROW_AT));
  const chipOf = (state: string) => drawn(state)
    .find((node) => node.type === "Text" && node.children[0] === "Test suite");
  const accentOf = (state: string) => drawn(state)
    .find((node) => node.type === "Text" && node.children[0] === ACCENT);
  assert.equal(chipOf("waiting")?.props.color, "warning");
  assert.equal(accentOf("waiting")?.props.color, "warning");
  assert.equal(chipOf("working")?.props.color, undefined);
  assert.equal(accentOf("working"), undefined);
  assert.equal(chipOf("working")?.props.bold, true);
  assert.equal(chipOf("failed")?.props.color, "error");
  assert.equal(accentOf("passed"), undefined);
  // No title is drawn on a fill: a block of color the width of a name is
  // louder than the one word it marks.
  for (const state of ["waiting", "failed", "working", "passed"]) {
    assert.equal(chipOf(state)?.props.backgroundColor, undefined, state);
  }
  assert.equal(chipOf("passed")?.props.bold, true);
});

test("what a row says in its own words is set in italic", () => {
  const tree = renderRow(row({ detail: "Which source?", note: { text: "Totals are a floor." } }),
                         WIDE, NARROW_AT);
  for (const words of ["Which source?", "Totals are a floor."]) {
    const node = nodesIn(tree).find((item) => item.type === "Text" && item.children[0] === words);
    assert.equal(node?.props.italic, true, words);
  }
});

test("a bar carries its counts beside it on the item's second line", () => {
  const short = renderRow(row({ bar: { done: 2, total: 5, cells: 16,
                                       label: { text: "2 / 5 steps" } } }), WIDE, NARROW_AT);
  const besideCounts = nodesIn(short).find((node) => node.props.flexDirection === "row"
    && renderedText(node as never).includes("2 / 5 steps")
    && renderedText(node as never).some((value) => /^\u2501+$/.test(value)));
  assert.notEqual(besideCounts, undefined);
  // A configured length is the bar's length when the line has room for it.
  assert.equal(barRuns(short).map((run) => run.text).join("").length, 16);
  // A bar with no label takes the whole line.
  const bare = renderRow(row({ bar: { done: 5, total: 5, label: null } }), WIDE, NARROW_AT);
  assert.equal(barRuns(bare).map((run) => run.text).join("").length, WIDE - 2);
});

test("the head puts the figures beside the title when they fit, and on their own line when not", () => {
  const cards = [{ label: "Working sessions", value: "2", color: "success" as const },
                 { label: "Waiting on you", value: "1", color: "warning" as const }];
  const wide = renderPane(pane({ cards }));
  const head = (wide as { children: unknown[] }).children[0];
  assert.equal(renderedText(head as never).includes("Working sessions"), true);
  assert.equal(renderedText(head as never).includes("Updated 4s ago"), true);
  const narrow = renderPane(pane({ cards, width: 50 }));
  const narrowHead = (narrow as { children: unknown[] }).children[0];
  assert.equal(renderedText(narrowHead as never).includes("Working sessions"), false);
  assert.equal(renderedText(narrow).includes("Working sessions"), true);
});

test("a control with a hotkey is drawn plain, the way the host draws its shortcuts", () => {
  const tree = renderPane(pane({ controls: [
    { key: "close", label: "Close", hotkey: "x", onPress: () => undefined },
    { key: "other", label: "Other", onPress: () => undefined },
  ] }));
  const buttons = nodesIn(tree).filter((node) => node.type === "Button");
  assert.equal(buttons.find((node) => node.props.key === "close")?.props.plain, true);
  // A control with no hotkey keeps its chrome: drawn plain it would be a bare
  // word with nothing to say it can be pressed.
  assert.equal(buttons.find((node) => node.props.key === "other")?.props.plain, undefined);
});

test("a count of a state is marked in its color on no fill, and a measurement is plain", () => {
  const tree = renderGroup(group({ summary: [{ text: "1 waiting", color: "warning" },
                                             { text: "  $4.20", dim: true }] }),
                           WIDE, NARROW_AT);
  const texts = nodesIn(tree).filter((node) => node.type === "Text");
  const count = texts.find((node) => node.children[0] === "1 waiting");
  assert.equal(count?.props.color, "warning");
  assert.equal(count?.props.bold, true);
  assert.equal(count?.props.backgroundColor, undefined);
  // The count's accent stands just before it, in the same color.
  const at = texts.indexOf(count as never);
  assert.equal(texts[at - 2]?.children[0], ACCENT);
  assert.equal(texts[at - 2]?.props.color, "warning");
  // A cost is a measurement: no accent, no color of a state.
  const cost = texts.find((node) => String(node.children[0]).includes("$4.20"));
  assert.equal(cost?.props.color, undefined);
  assert.equal(texts.filter((node) => node.children[0] === ACCENT).length, 2);
});

test("a section's name is marked in the color its card is drawn in, on no fill", () => {
  const calm = renderGroup(group({ rows: [row()] }), WIDE, NARROW_AT);
  const live = renderGroup(group({ rows: [row({ state: "running" })] }), WIDE, NARROW_AT);
  const broken = renderGroup(group({ rows: [row({ state: "failed" })] }), WIDE, NARROW_AT);
  const fillOf = (tree: unknown) => nodesIn(tree).find((node) => node.type === "Text"
    && node.props.bold === true && renderedText(node as never).join("") === "Background sessions")
    ?.props;
  assert.equal(fillOf(calm)?.color, "subtle");
  assert.equal(fillOf(live)?.color, "success");
  assert.equal(fillOf(broken)?.color, "error");
  // The heading is on no fill. A failed row under it keeps its own soft shade,
  // which is the row's, not the heading's.
  for (const tree of [calm, live, broken]) {
    const heading = nodesIn(tree).filter((node) => node.type === "Text"
      && (node.children[0] === ACCENT || node.children[0] === "Background sessions"));
    assert.ok(heading.length >= 2);
    assert.equal(heading.some((node) => node.props.backgroundColor !== undefined), false);
  }
});

test("a bar is drawn half a line high, in color over a dim track of the same mark", () => {
  // Half a cell high, as the host's own Agents panel draws its bars: a full block
  // read as a slab beside the text, and a line as a rule nobody reads as progress.
  const tree = renderRow(row({ bar: { done: 1, total: 4, cells: 8 } }), WIDE, NARROW_AT);
  const runs = barRuns(tree);
  assert.deepEqual(runs.map((run) => run.text), ["\u2501\u2501", "\u2501".repeat(6)]);
  assert.deepEqual(runs.map((run) => run.dim), [false, true]);
  assert.equal(renderedText(tree).some((value) => /[\u2588\u2591]/.test(value)), false);
});

test("a row with figures states them at the right of its first line, and its bar under", () => {
  const tree = renderRow(row({
    meta: [{ text: "Primary" }, { text: " \u00b7 opus 5.5" }],
    figures: [{ text: "~$0.11" }, { text: " \u00b7 44k tokens" }, { text: " \u00b7 0:53" }],
    bar: { done: 2, total: 4, label: { text: "2 / 4 steps \u00b7 Banner" } },
  }), WIDE, NARROW_AT);
  const lines = restingLines(tree);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.includes("Primary \u00b7 opus 5.5"), true);
  assert.equal(lines[0]?.includes("~$0.11 \u00b7 44k tokens \u00b7 0:53"), true);
  // The figures stand in for the slot: a row states one or the other at its right.
  assert.equal(lines[0]?.includes("42 / 80"), false);
  assert.equal(lines[1]?.includes("2 / 4 steps \u00b7 Banner"), true);
  assert.equal(/\u2501+/.test(lines[1] ?? ""), true);
});

test("a row whose bar has no denominator still states its figures", () => {
  const tree = renderRow(row({ figures: [{ text: "~$0.11" }], bar: { done: 0, total: 0 } }),
                         WIDE, NARROW_AT);
  assert.equal(renderedText(tree).includes("~$0.11"), true);
  assert.equal(barRuns(tree).length, 0);
});

test("a group's tiles are drawn as small cards above its rows, and not while folded", () => {
  const tiles = [{ label: "Cost", value: "$0.24" }, { label: "Context", value: "42% left" },
                 { label: "Time", value: "0:53" }];
  const open = renderGroup(group({ tiles }), WIDE, NARROW_AT);
  const cards = nodesIn(open).filter((node) => node.props.borderStyle === "round"
    && node.props.flexDirection === "column" && renderedText(node as never).length === 2);
  assert.deepEqual(cards.map((node) => renderedText(node as never)),
                   [["Cost", "$0.24"], ["Context", "42% left"], ["Time", "0:53"]]);
  const values = renderedText(open);
  assert.equal(values.indexOf("$0.24") < values.indexOf("Test suite"), true);
  // Side by side, each no wider than its share of the card.
  const widths = cards.map((node) => node.props.width as number);
  assert.equal(widths.reduce((sum, value) => sum + value, 0) <= WIDE - 4, true);
  const folded = renderGroup(group({ tiles, collapsed: true }), WIDE, NARROW_AT);
  assert.equal(renderedText(folded).includes("$0.24"), false);
  // Too narrow for three across, they stack rather than cutting each figure.
  const narrow = renderGroup(group({ tiles }), 30, NARROW_AT);
  assert.equal(renderedText(narrow).includes("42% left"), true);
});

test("a failing row is shaded so it stands out of its card, and a healthy one is not", () => {
  const failing = renderRow(row({ state: "failed", key: "a" }), WIDE, NARROW_AT);
  const healthy = renderRow(row({ state: "running", key: "b" }), WIDE, NARROW_AT);
  assert.equal((failing as { props: Record<string, unknown> }).props.backgroundColor,
               "diffRemovedDimmed");
  assert.equal((healthy as { props: Record<string, unknown> }).props.backgroundColor, undefined);
});

// The tree: a section is the parent and its items hang off one rail.

/** The lines a row draws at rest, each as its joined text. */
function restingLines(tree: unknown): string[] {
  const column = tree as { children: unknown[] };
  return column.children
    .filter((child) => (child as { props?: { display?: string } }).props?.display !== "none")
    .map((child) => renderedText(child as never).join(""));
}

test("a section's items hang off its rail: a branch for each, the last one closing it", () => {
  const bar = { done: 1, total: 2 };
  const rows = [row({ key: "a", title: "First", bar }), row({ key: "b", title: "Second", bar }),
                row({ key: "c", title: "Third", bar })];
  const drawn = renderGroup(group({ rows }), WIDE, NARROW_AT);
  const values = renderedText(drawn);
  assert.equal(values.filter((value) => value === "\u251c\u2500").length, 2);
  assert.equal(values.filter((value) => value === "\u2514\u2500").length, 1);
  // The rail runs down beside every line of an item but the last item's.
  assert.equal(values.includes("\u2502 "), true);
  // Drawn in the section's own tone, so the heading's color runs down it.
  const rails = nodesIn(drawn).filter((node) => node.type === "Text"
    && ["\u251c\u2500", "\u2514\u2500", "\u2502 ", "  "].includes(node.children[0] as string)
    && node.props.color !== undefined);
  assert.equal(rails.every((node) => node.props.color === groupTone(group({ rows }))), true);
  // No card border round the section: the rail is what groups it.
  assert.equal(nodesIn(drawn).some((node) => node.props.borderStyle === "round"), false);
});

test("an item is two lines at rest: what and its figures, then its bar", () => {
  const drawn = renderRow(row({
    title: "Kera", state: "working",
    meta: [{ text: "opus 5.5" }, { text: " \u00b7 high" }],
    figures: [{ text: "~$7.11" }, { text: " \u00b7 13m 39s" }],
    bar: { done: 27, total: 100, label: { text: "27% context" } },
    note: { text: "Totals are from the end of a long transcript.", dim: true },
  }), WIDE, NARROW_AT);
  const lines = restingLines(drawn);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.equal(lines[0]?.includes("Kera"), true);
  assert.equal(lines[0]?.includes("opus 5.5 \u00b7 high"), true);
  assert.equal(lines[0]?.includes("~$7.11 \u00b7 13m 39s"), true);
  assert.equal(/\u2501+/.test(lines[1] ?? ""), true);
  assert.equal(lines[1]?.includes("27% context"), true);
  // What the row has to say for itself waits for the pointer.
  const hidden = nodesIn(drawn).find((node) => node.props.display === "none");
  assert.notEqual(hidden, undefined);
  assert.equal(renderedText(hidden as never).join("").includes("long transcript"), true);
  assert.deepEqual((hidden as { hover?: unknown }).hover ?? hidden?.props.hover, { display: "flex" });
});

test("an item that waits on a person says what it asks on its second line", () => {
  const drawn = renderRow(row({ title: "SE-DSK", state: "waiting", meta: [{ text: "deepseek" }],
                                slot: [{ text: "Waiting for you" }],
                                detail: "your call: branch the flake separately" }),
                          WIDE, NARROW_AT);
  const lines = restingLines(drawn);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.includes("your call: branch the flake separately"), true);
});

test("an item with nothing more to say is one line", () => {
  const drawn = renderRow(row({ meta: [{ text: "owner/project" }], slot: [{ text: "open" }] }),
                          WIDE, NARROW_AT);
  assert.equal(restingLines(drawn).length, 1);
});

test("only an item that needs a person or failed draws its title in its color", () => {
  const fill = (state: string): unknown => nodesIn(renderRow(row({ state, title: "Item" }),
                                                             WIDE, NARROW_AT))
    .find((node) => node.type === "Text" && node.children[0] === "Item")?.props.color;
  assert.equal(fill("working"), undefined);
  assert.equal(fill("running"), undefined);
  assert.equal(fill("waiting"), "warning");
  assert.equal(fill("failed"), "error");
});

test("an item's lines never run past the width it was given", () => {
  for (const width of [40, 80, WIDE]) {
    const drawn = renderRow(row({
      title: "a-very-long-branch-name-that-goes-on-and-on", state: "working",
      meta: [{ text: "example-repo" }, { text: " \u00b7 trialed \u00b7 held by claude \u00b7 moved 2m ago" }],
      figures: [{ text: "at least $28.50" }, { text: " \u00b7 17% context" }, { text: " \u00b7 3h 22m" }],
      bar: { done: 2, total: 3, label: { text: "2 / 3 steps \u00b7 Redesigning the access roster" } },
    }), width, NARROW_AT, undefined, { first: "\u251c\u2500", rest: "\u2502 ", color: "success" });
    for (const drawnLine of restingLines(drawn)) {
      assert.equal(drawnLine.length <= width, true, width + ": " + drawnLine);
    }
  }
});

test("a row whose title copies something draws the title as one control", () => {
  let pressed = 0;
  const control = { key: "fleet.job.one.a", label: "Test suite", onPress: () => { pressed += 1; } };
  const drawn = renderRow(row({ press: control }), WIDE, NARROW_AT, "row:x");
  const buttons = nodesIn(drawn).filter((node) => node.type === "Button");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]?.props.key, "fleet.job.one.a");
  assert.equal(buttons[0]?.props.plain, true);
  // A button holds texts and nothing else, or the engine refuses the pane.
  assert.deepEqual(buttons[0]?.children.map((child) => (child as { type: string }).type), ["Text"]);
  assert.deepEqual(renderedText(buttons[0] as never).slice(1), ["Test suite"]);
  (buttons[0]?.props.onPress as () => void)();
  assert.equal(pressed, 1);
  // A title on a chip keeps the chip, as its three texts rather than the box.
  const chipped = renderRow(row({ state: "blocked", press: control }), WIDE, NARROW_AT, "row:x");
  const held = nodesIn(chipped).find((node) => node.type === "Button");
  assert.deepEqual(held?.children.map((child) => (child as { type: string }).type),
                   ["Text", "Text", "Text"]);
});

test("a row that is a page draws its title as a link", () => {
  const drawn = renderRow(row({ link: "https://example.invalid/pull/1" }), WIDE, NARROW_AT);
  const links = nodesIn(drawn).filter((node) => node.type === "Link");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.props.href, "https://example.invalid/pull/1");
  assert.deepEqual(renderedText(links[0] as never), ["Test suite"]);
});

test("a failing pull request keeps its title a link, drawn behind its accent", () => {
  // A failing row's title is marked in red; the page is still its page.
  const drawn = renderRow(row({ state: "failed", link: "https://example.invalid/pull/2" }),
                          WIDE, NARROW_AT);
  const links = nodesIn(drawn).filter((node) => node.type === "Link");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.props.href, "https://example.invalid/pull/2");
  assert.deepEqual(renderedText(links[0] as never).join("").trim(), ACCENT + " Test suite");
  // A link is inline: it holds the mark's texts, never a box.
  assert.deepEqual(links[0]?.children.map((child) => (child as { type: string }).type),
                   ["Text", "Text", "Text"]);
  assert.equal((links[0]?.children[2] as { props: { color?: string } }).props.color, "error");
  assert.equal((links[0]?.children[0] as { children: string[] }).children[0], ACCENT);
});

test("a row's own lines are drawn at rest, a pressable one as one control", () => {
  let copied = 0;
  const drawn = renderRow(row({ lines: [
    { slots: [{ text: "agent" }, { text: "Read the tests" }] },
    { slots: [{ text: "suggests:" }, { text: "yes" }], italic: true,
      press: { key: "fleet.suggest.a", label: "Copy", onPress: () => { copied += 1; } } },
  ] }), WIDE, NARROW_AT, "row:x");
  const words = renderedText(drawn);
  assert.equal(words.includes("agent"), true);
  assert.equal(words.includes(" Read the tests"), true);
  const control = nodesIn(drawn).find((node) => node.type === "Button");
  assert.equal(control?.props.key, "fleet.suggest.a");
  assert.equal(control?.children.every((child) => (child as { type: string }).type === "Text"), true);
  assert.equal((control?.children[0] as { props: { italic?: boolean } }).props.italic, true);
  (control?.props.onPress as () => void)();
  assert.equal(copied, 1);
  // Neither line waits for the pointer: no box around them is hidden at rest.
  const hidden = nodesIn(drawn).filter((node) => node.props.display === "none");
  assert.equal(hidden.some((node) => renderedText(node as never).includes("agent")), false);
});

test("a row's field is drawn under it, last, with the handler it was given", () => {
  const sent: string[] = [];
  const drawn = renderRow(row({ detail: "Which one?", state: "blocked",
                                field: { key: "fleet.reply.a", label: "reply", submitLabel: "send",
                                         placeholder: "type a reply",
                                         onSubmit: (value) => { sent.push(value); } } }),
                          WIDE, NARROW_AT, "row:x");
  const fields = nodesIn(drawn).filter((node) => node.type === "Input");
  assert.equal(fields.length, 1);
  assert.equal(fields[0]?.props.key, "fleet.reply.a");
  assert.equal(fields[0]?.props.placeholder, "type a reply");
  (fields[0]?.props.onSubmit as (value: string) => void)("yes");
  assert.deepEqual(sent, ["yes"]);
});

test("a row of the past is drawn quiet, its own words included", () => {
  const drawn = renderRow(row({ dim: true, detail: "left word", state: "done" }), WIDE, NARROW_AT);
  const title = nodesIn(drawn).find((node) => node.type === "Text"
    && node.children[0] === "Test suite");
  assert.equal(title?.props.dimColor, true);
  assert.equal(title?.props.bold, undefined);
  const said = nodesIn(drawn).find((node) => node.type === "Text" && node.children[0] === "left word");
  assert.equal(said?.props.dimColor, true);
});

test("a section's notes are drawn under its rows while it is open, and not while folded", () => {
  const notes = [[{ text: "Press a session to copy the command that opens it.", dim: true }]];
  const open = renderedText(renderGroup(group({ notes }), WIDE, NARROW_AT));
  assert.equal(open.at(-1), "Press a session to copy the command that opens it.");
  const folded = renderedText(renderGroup(group({ notes, collapsed: true }), WIDE, NARROW_AT));
  assert.equal(folded.includes("Press a session to copy the command that opens it."), false);
  // A section with notes and no rows is a card, so its legend is drawn.
  const noted = renderGroup(group({ rows: [], notes, legend: "What it means." }), WIDE, NARROW_AT);
  assert.equal(renderedText(noted).includes("What it means."), true);
});

test("the pane's hint is drawn beside its controls", () => {
  const tree = renderPane(pane({ controls: [{ key: "fleet.close", label: "Close", hotkey: "x",
                                              onPress: () => undefined }],
                                 hint: "Esc or x closes this pane" }));
  const words = renderedText(tree);
  assert.equal(words.indexOf("Esc or x closes this pane"), words.indexOf("Close") + 1);
});

test("the pane's hint is left out where the controls' line cannot hold it", () => {
  const close = [{ key: "fleet.close", label: "Close", hotkey: "x", onPress: () => undefined }];
  const hint = "Esc or x closes this pane";
  // "x: Close" takes 8 cells and the gap 3, so the 25-cell hint needs 36.
  const narrow = renderedText(renderPane(pane({ controls: close, hint, width: 35 })));
  assert.equal(narrow.includes("Close"), true);
  assert.equal(narrow.includes(hint), false);
  const exact = renderedText(renderPane(pane({ controls: close, hint, width: 36 })));
  assert.equal(exact.includes(hint), true);
});

test("a link and a field are bound where the surface draws them, and stood in for where not", () => {
  const link = { type: "Link" as const, props: { href: "https://example.invalid" }, children: ["page"] };
  const field = { type: "Input" as const, props: { key: "f", onSubmit: () => undefined }, children: [] };
  const tree = { type: "Box" as const, props: {}, children: [link, field] };
  const full = mount(tree, recordingPrimitives({ fields: true })) as Tree;
  assert.deepEqual(full.children.map((child) => (child as Tree).type), ["Link", "Input"]);
  // A table with neither keeps the words and drops the field.
  const bare = mount(tree, recordingPrimitives({ links: false })) as Tree;
  assert.deepEqual(bare.children.map((child) => (child as Tree).type), ["Text", "Box"]);
  assert.deepEqual(renderedText(bare), ["page"]);
});

test("a section whose last row is leaving does not say it is empty until the row is gone", () => {
  // The leaving row is still on the pane, sliding out; the line saying there
  // is nothing here appeared under it and then jumped up a line when it went.
  const message = emptyMessageOf(group({ state: "empty", rows: [] }));
  const leaving = renderGroup(group({ state: "empty",
                                      rows: [row({ motion: { offset: 3, leaving: true } })] }),
                              WIDE, NARROW_AT);
  assert.equal(renderedText(leaving).some((value) => value.includes("Test suite")), true);
  assert.equal(renderedText(leaving).some((value) => value.includes(message)), false);
  // Once it is gone, the section says so.
  const gone = renderGroup(group({ state: "empty", rows: [] }), WIDE, NARROW_AT);
  assert.equal(renderedText(gone).some((value) => value.includes(message)), true);
  // A failed source still says so while a row leaves: an error is never held back.
  const failed = renderGroup(group({ state: "failed",
                                     rows: [row({ motion: { offset: 3, leaving: true } })] }),
                             WIDE, NARROW_AT);
  assert.equal(renderedText(failed).some((value) => value.includes("Could not read")
    || value.includes("Refresh failed")), true);
});

test("a row arriving as another leaves takes its place, so the section changes height once", () => {
  // A waiting run that starts leaves the waiting rows as a running row arrives.
  // Drawn together for the length of the slide, the section grew by the
  // leaving row and shrank back, and every section below it went down and up.
  const going = row({ key: "held", title: "Waiting run", motion: { offset: 3, leaving: true } });
  const coming = row({ key: "run", title: "Running run", motion: { offset: 3, arriving: true } });
  const staying = row({ key: "other", title: "Other run" });
  const swapping = renderGroup(group({ rows: [going, staying, coming] }), WIDE, NARROW_AT);
  const settled = renderGroup(group({ rows: [staying, row({ key: "run", title: "Running run" })] }),
                              WIDE, NARROW_AT);
  assert.equal(renderedText(swapping).some((value) => value.includes("Waiting run")), false);
  assert.equal(renderedText(swapping).some((value) => value.includes("Running run")), true);
  assert.equal(renderedText(swapping).some((value) => value.includes("Other run")), true);
  const rowsIn = (tree: unknown) => (JSON.stringify(tree).match(/"row:[^"]*"/g) ?? []).length;
  assert.equal(rowsIn(swapping), 2);
  assert.equal(rowsIn(swapping), rowsIn(settled));
  // With nothing arriving, a leaving row still slides out where it stood.
  const leavingOnly = renderGroup(group({ rows: [going, staying] }), WIDE, NARROW_AT);
  assert.equal(renderedText(leavingOnly).some((value) => value.includes("Waiting run")), true);
});

/** What an empty section says, read from the layout rather than spelled again here. */
function emptyMessageOf(empty: Group): string {
  const text = groupMessage(empty).map((slot) => slot.text).join("").trim();
  assert.ok(text.length > 0, "an empty section drew no message");
  return text;
}

test("a row sliding in keeps the title, figures and layout it has at rest", () => {
  // Cut to the room left after the slide, the title's ellipsis moved a cell on
  // every frame ("test..." then "te..." then "tes..."), which reads as flicker.
  const long = "A long title that has to be cut somewhere on a pane this wide";
  const titleOf = (tree: unknown) => nodesIn(tree).find((node) => node.type === "Text"
    && typeof node.children[0] === "string" && (node.children[0] as string).startsWith("A long"))
    ?.children[0];
  // A pane a few cells wider than the width rows stack at is where a slide's
  // offset would cross it: the row restacked on its way in and back at rest.
  // A pane wide enough now keeps the whole title: the row spends its width on
  // the name before the dim context beside it. The slide is proved where the
  // title genuinely has to be cut.
  assert.equal(titleOf(renderRow(
    row({ title: long, figures: [{ text: "42 / 80" }] }), 80, NARROW_AT)), long);
  for (const width of [NARROW_AT + 3, 50]) {
    const at = (offset: number) => renderRow(
      row({ title: long, figures: [{ text: "42 / 80" }],
            ...(offset ? { motion: { offset, arriving: true } } : {}) }),
      width, NARROW_AT);
    const rest = titleOf(at(0));
    assert.ok(typeof rest === "string" && rest.length < long.length, String(rest));
    for (const offset of [1, 2, 3, 4, 5, 6]) {
      const where = "width " + width + " offset " + offset;
      assert.equal(titleOf(at(offset)), rest, where);
      assert.equal(renderedText(at(offset)).includes("42 / 80"), true, where);
      assert.equal(restingLines(at(offset)).length, restingLines(at(0)).length, where);
    }
  }
});

test("a section keeps the room it reserves when it holds less, and adds none when it holds more", () => {
  const visible = (tree: unknown) => (tree as { children: unknown[] }).children
    .filter((child) => (child as { props?: { display?: string } }).props?.display !== "none");
  // Empty: the heading, the line saying so, and one blank line to make up two.
  const empty = renderGroup(group({ state: "empty", rows: [], reserve: 2 }), WIDE, NARROW_AT);
  const emptyLines = visible(empty);
  assert.equal(emptyLines.length, 3);
  assert.equal(renderedText(emptyLines[2] as never).join("").trim(), "");
  // A legend shows only under the pointer, so it holds none of the room: a
  // failed section with one still makes up two lines, and its height does not
  // change when its source fails.
  const failed = renderGroup(group({ state: "failed", rows: [], reserve: 2, legend: "what it means" }),
                             WIDE, NARROW_AT);
  const bare = renderGroup(group({ state: "failed", rows: [], reserve: 2 }), WIDE, NARROW_AT);
  assert.equal(visible(failed).length, 3);
  assert.equal(visible(failed).length, visible(bare).length);
  // One item with a bar is two lines already: nothing is added.
  const one = renderGroup(group({ rows: [row({ bar: { done: 1, total: 2 } })], reserve: 2 }),
                          WIDE, NARROW_AT);
  assert.equal(visible(one).length, 2);
  // An item of one line is made up to two.
  const short = renderGroup(group({ rows: [row()], reserve: 2 }), WIDE, NARROW_AT);
  assert.equal(visible(short).length, 3);
  // A folded section gave its room back, reserve and all.
  const folded = renderGroup(group({ state: "empty", rows: [], reserve: 2, collapsed: true }),
                             WIDE, NARROW_AT);
  assert.equal(visible(folded).some((child) => renderedText(child as never).join("").trim() === ""
    && child !== visible(folded)[0]), false);
});

/** Every text a tree draws, with the color and dimness it is drawn in, in order. */
function painted(tree: unknown): { text: string; color?: string; dim: boolean }[] {
  return nodesIn(tree)
    .filter((node) => node.type === "Text" && node.children.length === 1
      && typeof node.children[0] === "string")
    .map((node) => ({ text: node.children[0] as string,
                      color: node.props.color as string | undefined,
                      dim: node.props.dimColor === true }));
}

const CHECK_DOT = "•";

test("a pull request row draws one dot per check in its state's color, and counts the rest", () => {
  const tree = renderRow(row({ checks: { states: ["pass", "fail", "pending", "neutral"], more: 2 } }),
                         WIDE, NARROW_AT);
  const dots = painted(tree).filter((part) => part.text === CHECK_DOT);
  assert.deepEqual(dots.map((dot) => dot.color), ["success", "error", "warning", "subtle"]);
  assert.equal(renderedText(tree).some((value) => value.trim() === "+2"), true);
  // The dots sit at the right with the row's own words, which keep their place.
  assert.equal(renderedText(tree).includes("42 / 80"), true);
});

test("dots too many for the row are capped, the failing ones kept, and the rest counted", () => {
  const states = [...Array.from({ length: 40 }, () => "pass"), "fail"];
  const tree = renderRow(row({ title: "A pull request", meta: [], checks: { states, more: 3 } }),
                         40, 20);
  const dots = painted(tree).filter((part) => part.text === CHECK_DOT);
  assert.ok(dots.length > 0 && dots.length < states.length, "the dots were not capped: " + dots.length);
  assert.equal(dots.some((dot) => dot.color === "error"), true, "the failing check was dropped");
  // What was left out is counted with what the reader already left out.
  const counted = renderedText(tree).map((value) => value.trim()).find((value) => /^\+\d+$/.test(value));
  assert.equal(counted, "+" + (states.length - dots.length + 3));
  // Nothing past the row's width: the dot, its space, and the line beside it.
  const drawn = painted(tree).reduce((sum, part) => sum + part.text.length, 0);
  assert.ok(drawn <= 40, "the row drew " + drawn + " cells in 40");
});

test("a row with no checks draws no dots, and a row with only uncounted ones draws the count", () => {
  assert.equal(painted(renderRow(row(), WIDE, NARROW_AT)).some((part) => part.text === CHECK_DOT), false);
  const counted = renderRow(row({ checks: { states: [], more: 4 } }), WIDE, NARROW_AT);
  assert.equal(painted(counted).some((part) => part.text === CHECK_DOT), false);
  assert.equal(renderedText(counted).some((value) => value.trim() === "+4"), true);
});

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

test("a section's spend is a line of block glyphs scaled to its busiest bucket, with its label", () => {
  const tree = renderGroup(group({ spark: { values: [0, 1, 4, 8], label: [{ text: "$13.00" }] } }),
                           WIDE, NARROW_AT);
  const glyphs = painted(tree).filter((part) => SPARK.includes(part.text));
  assert.deepEqual(glyphs.map((part) => part.text), [SPARK[0], SPARK[0], SPARK[3], SPARK[7]]);
  // A bucket that held nothing is drawn quiet, so it is not read as the least spend.
  assert.equal(glyphs[0]?.dim, true);
  assert.equal(glyphs.slice(1).every((part) => !part.dim), true);
  assert.equal(renderedText(tree).includes("$13.00"), true);
});

test("a spend line wider than its card sums neighboring buckets, the newest at the right", () => {
  // Twenty columns hold eighteen inside the card; the label and its gap take four.
  const values = [...Array.from({ length: 26 }, () => 1), 4, 4];
  const tree = renderGroup(group({ spark: { values, label: [{ text: "$1" }] } }), 20, 10);
  const glyphs = painted(tree).filter((part) => SPARK.includes(part.text));
  assert.equal(glyphs.length, 14);
  // Two buckets a cell: the last cell holds the two busiest, the others two of one each.
  assert.equal(glyphs.at(-1)?.text, SPARK[7]);
  assert.equal(glyphs.slice(0, -1).every((part) => part.text === SPARK[1]), true);
});

test("a spend line of nothing but empty buckets draws them quiet, and a folded section draws none", () => {
  const quiet = renderGroup(group({ spark: { values: [0, 0, 0], label: [{ text: "$0.00" }] } }),
                            WIDE, NARROW_AT);
  const glyphs = painted(quiet).filter((part) => SPARK.includes(part.text));
  assert.equal(glyphs.length, 3);
  assert.equal(glyphs.every((part) => part.dim), true);
  const folded = renderGroup(group({ collapsed: true,
                                     spark: { values: [1, 2], label: [{ text: "$3.00" }] } }),
                             WIDE, NARROW_AT);
  assert.equal(painted(folded).some((part) => SPARK.includes(part.text)), false);
});

test("an agent card draws its timeline across the card, each stretch in its state's color", () => {
  const width = 42;
  const tree = renderRow(row({ timeline: { from: 0, to: 100, segments: [
    { start: 0, end: 50, state: "working" }, { start: 50, end: 75, state: "idle" },
  ], tail: "waiting" } }), width, 20);
  const strip = painted(tree).filter((part) => /^[─━┄]$/.test(part.text));
  // The card's width less the indent under the dot.
  assert.equal(strip.length, width - 2);
  const half = Math.round((width - 2) / 2);
  const quarter = Math.round((width - 2) * 3 / 4);
  assert.equal(strip.slice(0, half).every((cell) => cell.color === "success"), true);
  assert.equal(strip.slice(half, quarter).every((cell) => cell.color === "subtle"), true);
  assert.equal(strip.slice(quarter).every((cell) => cell.color === "warning"), true);
  // The strip is a line of its own under the title, kept at rest.
  const lines = drawnChildren(tree);
  assert.equal(lines.length, 2);
});

test("a stretch the timeline does not cover is drawn as unknown, and an empty timeline draws nothing", () => {
  const tree = renderRow(row({ timeline: { from: 0, to: 100, segments: [
    { start: 0, end: 50, state: "working" }] } }), 42, 20);
  const strip = painted(tree).filter((part) => /^[─━┄]$/.test(part.text));
  assert.equal(strip.at(-1)?.text, "┄");
  assert.equal(strip.at(-1)?.dim, true);
  const none = renderRow(row({ timeline: { from: 0, to: 0, segments: [] } }), 42, 20);
  assert.equal(drawnChildren(none).length, 1);
});

test("a timeline line is counted in the room a section reserves", () => {
  const visible = (tree: unknown) => (tree as { children: unknown[] }).children
    .filter((child) => (child as { props?: { display?: string } }).props?.display !== "none");
  // The heading, then one row of two lines: nothing is added to make up two.
  const tree = renderGroup(group({ reserve: 2, rows: [row({ timeline: { from: 0, to: 10,
    segments: [{ start: 0, end: 10, state: "working" }] } })] }), WIDE, NARROW_AT);
  assert.equal(visible(tree).length, 2);
});

test("the digest heads the pane under its controls, every line cut to the width", () => {
  const long = "x".repeat(200);
  const tree = renderPane(pane({ width: 60, digest: {
    title: "Since you left", tone: "claude", heading: [{ text: "2 new", dim: true }],
    lines: [[{ text: "Trial failed", color: "error" }, { text: long }], [{ text: "+3 more", dim: true }]],
    through: 10 } }));
  const values = renderedText(tree);
  assert.equal(values.includes("Since you left"), true);
  assert.equal(values.includes("+3 more"), true);
  assert.equal(values.some((value) => value.includes(long)), false);
  // It comes before the first section.
  assert.ok(values.indexOf("Since you left") < values.indexOf("Background sessions"));
  assert.equal(renderedText(renderPane(pane())).includes("Since you left"), false);
});

test("a heading's figures are cut to its line, never wrapped under it", () => {
  // The room was budgeted from the title's unshown length and missed the cell
  // between the two halves of the line, so a summary was a cell too wide and the
  // surface wrapped its last count onto a line of its own: "59 checked out 44
  // active 9" then "merged" under the 9.
  const drawn = renderGroup(group({
    title: "Worktrees",
    rows: [row()],
    summary: [{ text: "59 checked out" }, { text: "  44 active" }, { text: "  9 merged" }],
  }), 40, NARROW_AT);
  const heading = (drawn as { children: unknown[] }).children[0];
  const cells = renderedText(heading as never).join("").length;
  assert.ok(cells <= 38, "the heading drew " + cells + " cells in 40");
});

test("the rows a ceiling held back are drawn under the section, hidden until pointed at", () => {
  const drawn = renderGroup(group({ rows: [row({ title: "First" })],
                                    held: [row({ title: "Held item" })] }), WIDE, NARROW_AT);
  // The row is read, masked and given its rail like the drawn ones.
  assert.equal(renderedText(drawn).some((value) => value.includes("Held item")), true);
  // It takes no room at rest: the box that holds it is hidden until hover.
  const holder = nodesIn(drawn).find((node) => node.props.display === "none"
    && node.props.hover !== undefined);
  assert.ok(holder !== undefined, "the held rows are not drawn in a hover-only box");
  assert.equal(renderedText(holder as never).some((value) => value.includes("Held item")), true);
});
