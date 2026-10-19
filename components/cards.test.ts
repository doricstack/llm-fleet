/**
 * The pieces a tile is built from: a dot, a stat card, a rate bar.
 *
 * These are drawn with the surface's own elements, so the cases are about what
 * each piece says and what it refuses to say. The refusals carry the weight: a
 * bar with no denominator, a state nobody recognizes, a figure the machine never
 * gave. Each of those draws nothing or draws quiet, because the loudest places
 * on a pane are the ones where being wrong costs the most.
 *
 * Run with: node --test components/cards.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BAR_FILLED, BAR_TRACK, DOT_FILLED, historyStrip, rateBar, statStrip,
         stateColor, statusDot } from "../plugins/llm-fleet/components/cards.ts";
import { renderedText } from "../plugins/llm-fleet/components/layout.ts";

type Drawn = { props?: Record<string, unknown>; children?: unknown };

/** Every color the drawing paints with, wherever it appears. */
function colorsIn(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const record = node as Drawn;
  const color = record.props?.color;
  if (typeof color === "string") {
    found.push(color);
  }
  const children = Array.isArray(record.children) ? record.children : [record.children];
  for (const child of children) {
    colorsIn(child, found);
  }
  return found;
}

test("a state is drawn in the color that means it, and an unknown state quietly", () => {
  assert.equal(stateColor("working"), "success");
  assert.equal(stateColor("running"), "success");
  assert.equal(stateColor("blocked"), "warning");
  assert.equal(stateColor("failed"), "error");
  assert.equal(stateColor("merged"), "merged");
  // A word the pane does not know is not good news. A dot that went green for it
  // would be this pane passing a verdict it has no basis for.
  for (const state of ["", "finished", "WORKING", "ok"]) {
    assert.equal(stateColor(state), "subtle", state);
  }
});

test("a status dot is the state's own color and nothing else", () => {
  const working = statusDot("working");
  assert.deepEqual(colorsIn(working), ["success"]);
  assert.equal(renderedText(working as never).join(""), DOT_FILLED);
  assert.deepEqual(colorsIn(statusDot("wat")), ["subtle"]);
});

test("the figures sit on one line, each value on a chip of its color over a quiet label", () => {
  const strip = statStrip([{ label: "Working sessions", value: "5", color: "success" },
                           { label: "Waiting on you", value: "2" },
                           { label: "Failed outcomes", value: "0", color: "error" }], 100);
  const props = (strip as { props?: Record<string, unknown> }).props ?? {};
  // No rule at all: a rule round one line spends two rows the cards below need,
  // and three boxes of a single digit is what this replaced before that.
  assert.equal(props.borderStyle, undefined);
  assert.equal(props.flexDirection, "row");
  const cells = ((strip as { children?: unknown[] }).children ?? []);
  assert.equal(cells.length, 3);
  // A label gets the width to be written, rather than cut to fit a column that
  // was divided evenly whether or not anything needed the room.
  assert.equal(renderedText(strip as never).includes("Failed outcomes"), true);
  type Shape = { props?: Record<string, unknown>; children?: Shape[] };
  const first = cells[0] as Shape;
  const value = first.children?.[0]?.children?.[1];
  assert.equal(value?.props?.bold, true);
  assert.equal(value?.props?.backgroundColor, "success");
  assert.equal(value?.props?.color, "inverseText");
  assert.equal(first.children?.[1]?.props?.dimColor, true);
  // A figure given no color of its own sits on the quiet fill, not on a verdict.
  const second = cells[1] as Shape;
  assert.equal(second.children?.[0]?.children?.[1]?.props?.backgroundColor, "subtle");
});

test("a strip too narrow for columns stacks its figures instead of shrinking them", () => {
  const cards = [{ label: "Working sessions", value: "5" },
                 { label: "Waiting on you", value: "2" },
                 { label: "Failed outcomes", value: "0" }];
  const narrow = statStrip(cards, 40);
  assert.equal((narrow as { props?: { flexDirection?: string } }).props?.flexDirection,
               "column");
  // Every label still arrives whole: a figure whose word was cut to two letters
  // is a figure nobody can read.
  const text = renderedText(narrow as never);
  for (const card of cards) {
    assert.equal(text.includes(card.label), true, card.label);
  }
  const wide = statStrip(cards, 100);
  assert.equal((wide as { props?: { flexDirection?: string } }).props?.flexDirection, "row");
});

test("a strip holds nothing but what it was given", () => {
  // A figure the machine did not give is not a card. The pane refuses to invent
  // one, and this is the piece it refuses with: an empty strip is not drawn.
  const strip = statStrip([], 80);
  assert.deepEqual(renderedText(strip as never), []);
});

test("a strip of history draws one cell per bucket, oldest first", () => {
  const strip = historyStrip({ label: "Last 12 hours",
                               cells: [{ outcomes: 2, failed: 0 }, { outcomes: 0, failed: 0 },
                                       { outcomes: 1, failed: 1 }, { outcomes: 3, failed: 0 }],
                               outcomes: 6, failed: 1 }, 80);
  assert.notEqual(strip, null);
  const cells = ((strip as { children?: unknown[] }).children ?? [])[0] as
    { children?: { props?: { color?: string; dimColor?: boolean } }[] };
  const drawn = cells.children ?? [];
  // Filled, track, filled, filled: a bucket nobody tried anything in is track
  // rather than a pass, which is the one thing a bar cannot say.
  assert.deepEqual(renderedText(cells as never),
                   [BAR_FILLED, BAR_TRACK, BAR_FILLED, BAR_FILLED]);
  assert.deepEqual(drawn.map((cell) => cell.props?.color ?? "none"),
                   ["success", "none", "error", "success"]);
  assert.equal(drawn[1]?.props?.dimColor, true);
  const text = renderedText(strip as never);
  // The caption states what the cells add up to: twelve cells cannot say how
  // many outcomes they are.
  assert.equal(text.includes("Last 12 hours"), true);
  assert.equal(text.includes(" 6 outcomes"), true);
  assert.equal(text.includes("  1 failed"), true);
});

test("a strip too narrow for its hours says which hours it is showing", () => {
  const history = { label: "Last 12 hours",
                    cells: Array.from({ length: 12 }, () => ({ outcomes: 1, failed: 0 })),
                    outcomes: 12, failed: 0 };
  const narrow = historyStrip(history, 8);
  const text = renderedText(narrow as never);
  // Eight cells under the words "Last 12 hours" is a label claiming hours the
  // strip is not showing, and the cells a reader counts would not be the ones
  // they think. The caption names the stretch that is drawn.
  assert.equal(text.filter((value) => value === BAR_FILLED).length, 8);
  assert.equal(text.includes("Last 8 hours"), true);
  assert.equal(text.includes("Last 12 hours"), false);
  // Room for all of them, the caption is the configured label unchanged.
  assert.equal(renderedText(historyStrip(history, 40) as never).includes("Last 12 hours"), true);
});

test("a bar is as long as the length it was given, however short", () => {
  // The cell count is configuration. A minimum of four inside the bar drew a
  // four-cell bar for a setting that asked for two, which is a declared value
  // the pane overruled.
  for (const cells of [1, 2, 3, 4, 16]) {
    const bar = rateBar(1, 2, "success", cells);
    const drawn = renderedText(bar as never).join("");
    assert.equal(drawn.length, cells, String(cells));
  }
  // A bar of no cells is still not a bar.
  assert.equal(rateBar(1, 2, "success", 0), null);
});

test("a period that holds nothing draws no strip at all", () => {
  for (const history of [{ label: "Last 12 hours", cells: [], outcomes: 0, failed: 0 },
                         { label: "Last 12 hours",
                           cells: [{ outcomes: 0, failed: 0 }, { outcomes: 0, failed: 0 }],
                           outcomes: 0, failed: 0 }]) {
    // An all-track strip is a claim about a period nobody measured.
    assert.equal(historyStrip(history, 80), null);
  }
});

test("a rate bar is the done part drawn in color and the rest drawn quiet", () => {
  // One thin mark on the middle of the cell for both parts, so a bar never
  // touches the line under it: color and dimness tell the parts apart.
  assert.equal(BAR_FILLED, "\u2501");
  assert.equal(BAR_TRACK, "\u2501");
  const bar = rateBar(42, 80, "success", 60);
  const parts = ((bar as { children?: { props?: { dimColor?: boolean; color?: string } }[] })
    .children ?? []);
  assert.deepEqual(parts.map((part) => part.props?.dimColor === true), [false, true]);
  assert.equal(parts[0]?.props?.color, "success");
  const lines = renderedText(bar as never);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], BAR_FILLED.repeat(32));
  assert.equal(lines[1], BAR_TRACK.repeat(28));
  assert.equal(`${lines[0]}${lines[1]}`.length, 60);
  assert.deepEqual(colorsIn(bar), ["success"]);
});

test("a bar with no denominator draws nothing at all", () => {
  // An empty track under a run whose total is unknown reads as nought done
  // rather than as nothing known, which is the opposite of what it is.
  for (const [done, total] of [[0, 0], [5, 0], [5, -1], [5, Number.NaN], [Number.NaN, 80]]) {
    assert.equal(rateBar(done as number, total as number, "success", 60), null,
                 `${done}/${total}`);
  }
});

test("a bar draws the whole track and no more of it than there is", () => {
  const full = rateBar(100, 100, "success", 20);
  assert.equal(renderedText(full as never).join(""), BAR_FILLED.repeat(20));
  const none = rateBar(0, 100, "success", 20);
  assert.equal(renderedText(none as never).join(""), BAR_TRACK.repeat(20));
});

test("counts that cannot both be true draw no bar", () => {
  // A bar is the one thing on the pane that shows progress as a proportion, and
  // a proportion of an impossible pair means nothing. The row states both
  // numbers instead and lets them be read.
  for (const [done, total] of [[200, 100], [90, 80], [-1, 80]]) {
    assert.equal(rateBar(done as number, total as number, "success", 20), null,
                 `${done}/${total}`);
  }
});

test("a bar rounds to the nearest cell rather than up", () => {
  // A third of ten cells is 3.33: the nearest is three. Rounding up would make
  // every run read a little further along than it is, which is the one direction
  // a progress bar must never lean.
  const bar = rateBar(1, 3, "success", 10);
  assert.equal((renderedText(bar as never)[0] ?? "").length, 3);
  // And the boundary the other way: two thirds is 6.67, which is seven.
  const more = rateBar(2, 3, "success", 10);
  assert.equal((renderedText(more as never)[0] ?? "").length, 7);
});

test("the three headline figures keep their labels whole at the width the pane gives them", () => {
  // The old strip gave every figure the same share, sized for the widest label:
  // the longest was cut ("Failed trials...") while the short ones left cells
  // unread. Each card is sized to its own label now, so all three fit from the
  // width their whole labels need.
  const cards = [{ label: "Working sessions", value: "2", color: "success" as const },
                 { label: "Waiting on you", value: "1", color: "warning" as const },
                 { label: "Failed outcomes", value: "0", color: "error" as const }];
  for (const width of [64, 66, 80]) {
    const drawn = renderedText(statStrip(cards, width) as never).join(" ");
    for (const card of cards) {
      assert.equal(drawn.includes(card.label), true, width + ": " + drawn);
    }
  }
});

test("too narrow for the whole labels, the figures stack rather than becoming initials", () => {
  const cards = [{ label: "Working sessions", value: "2" },
                 { label: "Waiting on you", value: "1" },
                 { label: "Failed outcomes", value: "0" }];
  const strip = statStrip(cards, 40) as unknown as { children: unknown[] };
  // One line per figure, each with its label whole.
  for (const child of strip.children) {
    const drawn = renderedText(child as never).join(" ");
    assert.equal(cards.some((card) => drawn.includes(card.label)), true, drawn);
  }
});



