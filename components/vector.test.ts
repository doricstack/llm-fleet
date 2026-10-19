/**
 * The pane's shapes as vectors, and the mount that picks them by surface.
 *
 * The cases hold the two drawings to one view model: a bar's vector is the same
 * share as its cells, a strip's blocks are the same alphabet, a tile says the
 * same words, and each refuses what its cell drawing refuses. The mount cases
 * prove the terminal is handed no Svg and the desktop is handed no glyph bar.
 *
 * They read the markup, not a painted drawing. What a desktop paints is the
 * host kit's case in plugins/llm-fleet/tests/pane.test.ts and a live look.
 *
 * Run with: node --test components/vector.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Node } from "../plugins/llm-fleet/components/host.ts";
import { BAR_FILLED, historyStrip, rateBar } from "../plugins/llm-fleet/components/cards.ts";
import type { Group, Pane, Row } from "../plugins/llm-fleet/components/layout.ts";
import { elementTypes, renderPane, renderedText } from "../plugins/llm-fleet/components/layout.ts";
import { bindPrimitives, mount, recordingPrimitives } from "../plugins/llm-fleet/components/mount.ts";
import { CELL_PIXELS, barVector, cutTo, escapeXml, stripVector,
         tileVector } from "../plugins/llm-fleet/components/vector.ts";
import { renderGroup, renderRow } from "../plugins/llm-fleet/components/layout.ts";

/** The engine's bound on an Svg's source. */
const SOURCE_LIMIT = 131072;

/** The width of every rect drawn with a class, in the order written. */
function rects(source: string): { cls: string; width: number }[] {
  return [...source.matchAll(/<rect class="([^"]+)"[^>]* width="([0-9.]+)"/g)]
    .map((match) => ({ cls: match[1], width: Number(match[2]) }));
}

test("a bar's vector fills the exact share of its slot, over a track across all of it", () => {
  const drawn = barVector(1, 3, "success", 20);
  assert.ok(drawn);
  assert.equal(drawn.cells, 20);
  assert.equal(drawn.alt, "1 of 3");
  const [track, fill] = rects(drawn.source);
  assert.deepEqual(track, { cls: "track", width: 20 * CELL_PIXELS });
  // A third of 200, not the 7 cells of 20 the terminal rounds it to.
  assert.equal(fill.cls, "f-success");
  assert.equal(fill.width, 66.67);
  assert.ok(drawn.source.startsWith("<svg "));
  assert.ok(drawn.source.endsWith("</svg>"));
});

test("a bar with nothing done draws its track and no fill", () => {
  const drawn = barVector(0, 5, "success", 10);
  assert.ok(drawn);
  assert.deepEqual(rects(drawn.source).map((rect) => rect.cls), ["track"]);
});

test("a full bar fills the whole track in the color it was given", () => {
  const drawn = barVector(4, 4, "error", 10);
  assert.ok(drawn);
  assert.deepEqual(rects(drawn.source)[1], { cls: "f-error", width: 10 * CELL_PIXELS });
});

test("a bar's vector refuses what its cells refuse", () => {
  // No denominator, counts that cannot both be true, values that are not
  // numbers, and a slot of no cells: each is a drawing of a share nobody measured.
  assert.equal(barVector(1, 0, "success", 10), null);
  assert.equal(barVector(5, 4, "success", 10), null);
  assert.equal(barVector(-1, 4, "success", 10), null);
  assert.equal(barVector(Number.NaN, 4, "success", 10), null);
  assert.equal(barVector(1, Number.POSITIVE_INFINITY, "success", 10), null);
  assert.equal(barVector(1, 4, "success", 0), null);
});

test("a strip's vector draws one block per bucket in the strip's alphabet", () => {
  const drawn = stripVector([{ outcomes: 0, failed: 0 }, { outcomes: 3, failed: 0 },
                             { outcomes: 2, failed: 1 }], "Last 12 hours, 5 outcomes");
  assert.ok(drawn);
  assert.equal(drawn.cells, 3);
  assert.equal(drawn.alt, "Last 12 hours, 5 outcomes");
  // An hour nobody tried anything in is track, never a pass.
  assert.deepEqual(rects(drawn.source).map((rect) => rect.cls), ["track", "f-success", "f-error"]);
});

test("a strip with no buckets is no drawing", () => {
  assert.equal(stripVector([], "Last 12 hours"), null);
});

test("a tile's vector says the tile's words, escaped, and both in its alt", () => {
  const drawn = tileVector("Cost <today>", "$3 & up", "warning", 18);
  assert.equal(drawn.cells, 18);
  assert.equal(drawn.alt, "Cost <today>: $3 & up");
  assert.ok(drawn.source.includes(">Cost &lt;today&gt;</text>"));
  assert.ok(drawn.source.includes(">$3 &amp; up</text>"));
  assert.ok(drawn.source.includes("class=\"f-warning\""));
  assert.ok(!drawn.source.includes("<today>"));
});

test("markup escapes every character that would end an attribute or open a tag", () => {
  assert.equal(escapeXml("<a href=\"x\">'&'</a>"),
               "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
});

test("a drawing carries a light and a dark color for each token it uses, and no other", () => {
  const drawn = barVector(1, 2, "merged", 10);
  assert.ok(drawn);
  const [light, dark] = drawn.source.split("@media (prefers-color-scheme: dark)");
  assert.ok(light.includes(".f-merged{fill:#"));
  assert.ok(dark.includes(".f-merged{fill:#"));
  assert.notEqual(light.match(/\.f-merged\{fill:(#[0-9a-f]+)\}/)?.[1],
                  dark.match(/\.f-merged\{fill:(#[0-9a-f]+)\}/)?.[1]);
  assert.ok(!drawn.source.includes("f-success"));
});

test("every drawing stays inside the engine's bound on an Svg's source", () => {
  const wide = barVector(1, 2, "success", 2000);
  const strip = stripVector(Array.from({ length: 500 }, () => ({ outcomes: 1, failed: 0 })), "x");
  const tile = tileVector("L".repeat(500), "V".repeat(500), "text", 500);
  for (const drawn of [wide, strip, tile]) {
    assert.ok(drawn);
    assert.ok(drawn.source.length < SOURCE_LIMIT, String(drawn.source.length));
  }
});

test("a rate bar and a strip carry the vector of the counts their cells were drawn from", () => {
  const bar = rateBar(2, 8, "warning", 16) as Node;
  assert.equal(bar.vector?.alt, "2 of 8");
  assert.equal(bar.vector?.cells, 16);
  assert.ok(bar.vector?.source.includes("f-warning"));
  // A bar that is not drawn carries nothing to draw instead.
  assert.equal(rateBar(9, 8, "warning", 16), null);
  const strip = historyStrip({ label: "Last 12 hours", outcomes: 4, failed: 1,
                               cells: [{ outcomes: 3, failed: 0 }, { outcomes: 1, failed: 1 }] }, 40);
  assert.ok(strip);
  const cells = strip.children[0] as Node;
  assert.equal(cells.vector?.cells, 2);
  assert.equal(cells.vector?.alt, "Last 12 hours, 4 outcomes, 1 failed");
});

const AT = 1790000000;

function measured(): Pane {
  const row: Row = { title: "Test suite", meta: [], slot: [{ text: "Working" }], state: "working",
                     bar: { done: 3, total: 10 } };
  const group: Group = {
    name: "Background jobs", title: "Background sessions", summary: [], rows: [row],
    state: "ready", tiles: [{ label: "Cost", value: "$3.75" }, { label: "Context", value: "40%" }],
    history: { label: "Last 12 hours", outcomes: 2, failed: 0,
               cells: [{ outcomes: 0, failed: 0 }, { outcomes: 2, failed: 0 }] },
  };
  return { title: "Fleet", counts: [], updated: { text: `Updated at ${AT}` }, groups: [group],
           width: 100, narrowAt: 60 };
}

/** Every node of a mounted recording, depth first. */
function nodes(tree: Node): Node[] {
  return [tree, ...tree.children.flatMap((child) => typeof child === "string" ? [] : nodes(child))];
}

test("the terminal is handed the cells and never an Svg", () => {
  const mounted = mount(renderPane(measured()), recordingPrimitives()) as Node;
  assert.deepEqual(elementTypes(mounted), ["Box", "Text"]);
  assert.ok(renderedText(mounted).some((value) => value.includes(BAR_FILLED)));
  assert.ok(renderedText(mounted).includes("$3.75"));
});

test("the desktop is handed a vector for every bar, strip and tile, in the slot its cells take", () => {
  const tree = renderPane(measured());
  const mounted = mount(tree, recordingPrimitives({ vectors: true })) as Node;
  const svgs = nodes(mounted).filter((node) => node.type === "Svg");
  const alts = svgs.map((node) => (node.props as { alt: string }).alt);
  // A bar's alt says what its label says beside it.
  assert.deepEqual(alts.sort(), ["3 / 10", "Context: 40%", "Cost: $3.75",
                                 "Last 12 hours, 2 outcomes"].sort());
  // No glyph bar is left beside a drawing of itself.
  assert.ok(!renderedText(mounted).some((value) => value.includes(BAR_FILLED)));
  // Each drawing sits in a box as wide as the cells it replaced, so the rest of
  // the row lays out as it does in a terminal.
  const slots = nodes(mounted).filter((node) =>
    node.type === "Box" && node.children.some((child) => typeof child !== "string" && child.type === "Svg"));
  const expected = nodes(tree).filter((node) => node.vector).map((node) => node.vector?.cells);
  assert.deepEqual(slots.map((node) => (node.props as { width?: number }).width).sort(),
                   expected.sort());
  // The words around the drawings are still text: the row's title and state.
  assert.ok(renderedText(mounted).includes("Test suite"));
  assert.ok(renderedText(mounted).includes("Working"));
});

test("a drawing keeps the key and the place of the node it replaces, and never shrinks", () => {
  const bar = rateBar(1, 4, "success", 12) as Node;
  const keyed: Node = { ...bar, props: { ...bar.props, key: "row:x", marginLeft: 2,
                                         display: "none", hover: { display: "flex" } } };
  const mounted = mount(keyed, recordingPrimitives({ vectors: true })) as Node;
  assert.deepEqual(mounted.props, { key: "row:x", marginLeft: 2, display: "none",
                                    hover: { display: "flex" }, width: 12, flexShrink: 0 });
  assert.equal((mounted.children[0] as Node).type, "Svg");
});

test("a narrow strip's drawing holds only the hours its caption names", () => {
  const cells = Array.from({ length: 12 }, (_, index) => ({ outcomes: index % 2, failed: 0 }));
  const strip = historyStrip({ label: "Last 12 hours", outcomes: 6, failed: 0, cells }, 8);
  assert.ok(strip);
  const drawn = strip.children[0] as Node;
  assert.equal(drawn.vector?.cells, 8);
  assert.equal(drawn.vector?.alt.startsWith("Last 8 hours"), true);
  assert.equal(rects(drawn.vector?.source ?? "").length, 8);
});

test("a tile's drawing cuts its words by the room they take, marks the cut, and says them whole", () => {
  const value = "$1234567890.12 across every model";
  const drawn = tileVector("Cost", value, "warning", 14);
  const shown = drawn.source.match(/font-weight="600"[^>]*>([^<]*)</)?.[1] ?? "";
  // 140 pixels less the insets, at 12 a character: nine of them, the cut marked.
  assert.equal(shown, cutTo(value, 9));
  assert.equal(shown.endsWith("..."), true);
  assert.equal(drawn.alt, "Cost: " + value);
  assert.equal(cutTo("short", 9), "short");
  assert.equal(cutTo("abcdef", 2), "ab");
});

test("a section's tiles carry their own color and their whole words to the drawing", () => {
  const group: Group = {
    name: "This session", title: "This session", summary: [], rows: [], state: "ready",
    tiles: [{ label: "Context", value: "8% left", color: "warning" },
            { label: "A label far longer than any tile could hold", value: "1" }],
  };
  const tree = renderGroup(group, 60, 40);
  const vectors = nodes(tree).flatMap((node) => node.vector ? [node.vector] : []);
  assert.equal(vectors[0].source.includes("class=\"f-warning\""), true);
  assert.equal(vectors[1].alt, "A label far longer than any tile could hold: 1");
});

test("a bar's drawing says what the label beside it says", () => {
  const row: Row = { title: "Waiting job", meta: [], slot: [], state: "waiting",
                     bar: { done: 125, total: 600, label: { text: "4m left" } } };
  const drawn = nodes(renderRow(row, 80, 40)).find((node) => node.vector);
  assert.equal(drawn?.vector?.alt, "4m left");
});

test("the Svg is bound by the surface's name, never by the table holding one", () => {
  // The engine completes every table with every element name, the terminal's
  // included, and a name the terminal does not draw is an empty fragment there.
  const table = { ...recordingPrimitives({ vectors: true }) };
  assert.equal(bindPrimitives(table, "terminal").Svg, undefined);
  for (const surface of ["desktop", "vscode", "mobile"]) {
    assert.equal(typeof bindPrimitives(table, surface).Svg, "function", surface);
  }
  // A surface whose table has none draws the cells, whatever its name.
  const bare = { ...recordingPrimitives() };
  assert.equal(bindPrimitives(bare, "desktop").Svg, undefined);
  const mounted = mount(renderPane(measured()), bindPrimitives(table, "terminal")) as Node;
  assert.deepEqual(elementTypes(mounted), ["Box", "Text"]);
  assert.ok(renderedText(mounted).includes("Cost"));
});
