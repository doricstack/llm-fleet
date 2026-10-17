/**
 * What moves on the pane: rows sliding in and out of their sections, a section
 * sliding out as it goes, and warnings blinking when they arrive.
 *
 * Run with: node --test components/motion.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Group, Pane, Row } from "../plugins/fleet/components/layout.ts";
import { renderGroup, renderRow, renderedText } from "../plugins/fleet/components/layout.ts";
import { animate, BLINK_MS, BLINK_PERIOD_MS, motionMemory, SLIDE_CELLS,
         SLIDE_MS } from "../plugins/fleet/components/motion.ts";

const T = 1_000_000;

function row(title: string, extra: Partial<Row> = {}): Row {
  return { title, meta: [], slot: [], ...extra };
}

function group(id: string, rows: Row[], extra: Partial<Group> = {}): Group {
  return { name: id, title: id, summary: [], rows, state: "ready",
           toggle: { key: "fleet.section." + id, label: id, onPress: () => undefined }, ...extra };
}

function pane(groups: Group[]): Pane {
  return { title: "Fleet", counts: [], updated: { text: "" }, groups, width: 120, narrowAt: 60 };
}

function rowsOf(drawn: Pane, id: string): Row[] {
  return drawn.groups.find((entry) => entry.title === id)?.rows ?? [];
}

test("the first paint moves nothing: what was already there did not arrive", () => {
  const memory = motionMemory();
  const first = animate(pane([group("prs", [row("one"), row("two")])]), memory, T);
  assert.equal(first.moving, false);
  assert.equal(rowsOf(first.pane, "prs").some((entry) => entry.motion !== undefined), false);
});

test("a new row slides in from the right and settles", () => {
  const memory = motionMemory();
  animate(pane([group("prs", [row("one")])]), memory, T);
  const start = animate(pane([group("prs", [row("one"), row("two")])]), memory, T + 1);
  assert.equal(start.moving, true);
  const arriving = rowsOf(start.pane, "prs")[1];
  assert.equal(arriving?.motion?.arriving, true);
  assert.equal(arriving?.motion?.offset, SLIDE_CELLS);
  assert.equal(rowsOf(start.pane, "prs")[0]?.motion, undefined);
  const half = animate(pane([group("prs", [row("one"), row("two")])]), memory, T + 1 + SLIDE_MS / 2);
  const offset = rowsOf(half.pane, "prs")[1]?.motion?.offset ?? -1;
  assert.ok(offset > 0 && offset < SLIDE_CELLS, "half way it is part way in: " + offset);
  const done = animate(pane([group("prs", [row("one"), row("two")])]), memory, T + 1 + SLIDE_MS);
  assert.equal(done.moving, false);
  assert.equal(rowsOf(done.pane, "prs")[1]?.motion, undefined);
});

test("a row that went slides out where it was, then is gone", () => {
  const memory = motionMemory();
  animate(pane([group("prs", [row("one"), row("two"), row("three")])]), memory, T);
  const start = animate(pane([group("prs", [row("one"), row("three")])]), memory, T + 1);
  assert.equal(start.moving, true);
  const titles = rowsOf(start.pane, "prs").map((entry) => entry.title);
  assert.deepEqual(titles, ["one", "two", "three"]);
  assert.equal(rowsOf(start.pane, "prs")[1]?.motion?.leaving, true);
  const later = animate(pane([group("prs", [row("one"), row("three")])]), memory, T + 1 + SLIDE_MS);
  assert.deepEqual(rowsOf(later.pane, "prs").map((entry) => entry.title), ["one", "three"]);
  assert.equal(later.moving, false);
});

test("a section that goes slides out whole, then is gone", () => {
  const memory = motionMemory();
  animate(pane([group("warnings", [row("prs failed")]), group("prs", [row("one")])]), memory, T);
  const start = animate(pane([group("prs", [row("one")])]), memory, T + 1);
  assert.deepEqual(start.pane.groups.map((entry) => entry.title), ["warnings", "prs"]);
  assert.equal(rowsOf(start.pane, "warnings")[0]?.motion?.leaving, true);
  const later = animate(pane([group("prs", [row("one")])]), memory, T + 1 + SLIDE_MS);
  assert.deepEqual(later.pane.groups.map((entry) => entry.title), ["prs"]);
});

test("warnings that arrive or change blink for a while, then hold still", () => {
  const memory = motionMemory();
  animate(pane([group("prs", [row("one")])]), memory, T);
  const warn = (rows: Row[]) => pane([group("warnings", rows), group("prs", [row("one")])]);
  const first = animate(warn([row("prs: timed out")]), memory, T + 1);
  const on = first.pane.groups[0]?.blink;
  const off = animate(warn([row("prs: timed out")]), memory, T + 1 + BLINK_PERIOD_MS).pane
    .groups[0]?.blink;
  assert.equal(typeof on, "boolean");
  assert.notEqual(on, off, "the warning alternates between frames a period apart");
  const still = animate(warn([row("prs: timed out")]), memory, T + 1 + BLINK_MS);
  assert.equal(still.pane.groups[0]?.blink, undefined);
  // A new warning starts it again; the same one does not.
  const again = animate(warn([row("prs: timed out"), row("skills: no folder")]), memory,
                        T + 2 + BLINK_MS);
  assert.equal(typeof again.pane.groups[0]?.blink, "boolean");
  assert.equal(again.moving, true);
});

test("a folded section moves nothing, since none of its rows are drawn", () => {
  const memory = motionMemory();
  animate(pane([group("prs", [row("one")], { collapsed: true })]), memory, T);
  const next = animate(pane([group("prs", [row("one"), row("two")], { collapsed: true })]),
                       memory, T + 1);
  assert.equal(next.moving, false);
});

test("an arriving row is drawn in from its side on a tint, and a leaving one dims", () => {
  // The offset moves the item's lines and leaves the section's rail where it is,
  // so a row slides along the rail rather than taking the rail with it.
  const margins = (tree: unknown): number[] => {
    const found: number[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") {
        return;
      }
      const record = node as { props?: { marginLeft?: unknown }; children?: unknown[] };
      if (typeof record.props?.marginLeft === "number" && record.props.marginLeft !== 2) {
        found.push(record.props.marginLeft);
      }
      for (const child of record.children ?? []) {
        walk(child);
      }
    };
    walk(tree);
    return found;
  };
  const arriving = renderRow(row("two", { motion: { offset: 4, arriving: true } }), 100, 60);
  const props = (arriving as { props: Record<string, unknown> }).props;
  assert.equal(margins(arriving).includes(4), true);
  assert.equal(props.backgroundColor, "diffAddedDimmed");
  assert.equal(renderedText(arriving).includes("two"), true);
  const leaving = renderRow(row("gone", { motion: { offset: 3, leaving: true } }), 100, 60);
  assert.equal(margins(leaving).includes(3), true);
  const still = renderRow(row("here"), 100, 60);
  assert.deepEqual(margins(still), []);
});

test("a blinking section swaps its rule between the warning and the error color", () => {
  const failing = [row("prs: timed out", { state: "failed" })];
  const on = renderGroup(group("warnings", failing, { blink: true }), 100, 60);
  const off = renderGroup(group("warnings", failing, { blink: false }), 100, 60);
  // The blink is the heading's fill and the rail's color together.
  const rule = (tree: unknown) => {
    const found = new Set<unknown>();
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") {
        return;
      }
      const record = node as { props?: Record<string, unknown>; children?: unknown[] };
      const [only] = record.children ?? [];
      if (only === "\u2514\u2500" || only === "\u251c\u2500") {
        found.add(record.props?.color);
      }
      if (only === "Warnings" && record.props?.bold === true) {
        found.add(record.props?.backgroundColor);
      }
      for (const child of record.children ?? []) {
        walk(child);
      }
    };
    walk(tree);
    assert.equal(found.size, 1, [...found].join(","));
    return [...found][0];
  };
  assert.notEqual(rule(on), rule(off));
  assert.deepEqual(new Set([rule(on), rule(off)]), new Set(["warning", "error"]));
});
