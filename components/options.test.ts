/**
 * The pane's own configuration, as the reading carries it.
 *
 * The plugin has no configuration file to read, so this document is the only
 * way a person's choices reach the pane. It crosses a process boundary, so it is
 * read as untrusted input: a pane that half-read a document it did not
 * understand would fold sections on the strength of a guess, which is exactly
 * what these cases refuse.
 *
 * Run with: node --test components/options.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GEOMETRY, NARROW_AT, SECTIONS, paneConfigFrom, paneOptions }
  from "../plugins/llm-fleet/components/options.ts";
import { DEFAULT_KEYS } from "../plugins/llm-fleet/components/pane.ts";

const NOW = 1_700_000_000;

/** A configuration document as the read command prints it. */
function reading(pane: unknown): unknown {
  return { generated_at: NOW, pane };
}

const ALL = Object.fromEntries(
  SECTIONS.map((name) => [name, { visible: true, collapsed: false }]));

test("a configuration the reading carried decides the order and every start", () => {
  const config = paneConfigFrom(reading({
    state: "ready",
    order: ["warnings", "sessions"],
    sections: { warnings: { visible: true, collapsed: true },
                sessions: { visible: false, collapsed: false } },
  }));
  assert.notEqual(config, null);
  const options = paneOptions(80, NOW, config);
  assert.deepEqual(options.sectionOrder, ["warnings", "sessions"]);
  const starts: [string, boolean, boolean][] =
    [["warnings", true, true], ["sessions", false, false]];
  for (const [name, shown, folded] of starts) {
    // A section the document did not rename or explain draws neither, rather
    // than the packaged title or legend of whichever section the schema names
    // first: absent and empty are the same answer here, and both are honest.
    assert.deepEqual(options.sections[name],
                     { title: null, visible: shown, collapsed: folded, legend: null,
                       hideWhenEmpty: false }, name);
  }
  // A section the order does not name is not drawn. The order is the whole of
  // what was configured, not a starting point to add the rest back to.
  assert.equal("keys" in options.sections, false);
});

test("a reading carrying no configuration draws the packaged default", () => {
  for (const value of [undefined, null, 7, "a string", [], {}, { order: [] }]) {
    assert.equal(paneConfigFrom(reading(value)), null, JSON.stringify(value));
  }
  const options = paneOptions(80, NOW, null);
  assert.deepEqual(options.sectionOrder, SECTIONS);
  for (const name of SECTIONS) {
    assert.equal(options.sections[name]?.visible, true, name);
  }
  // The three the schema declares folded still start folded with nothing else
  // to go on, so a machine with no configuration file is not a pane that lost
  // its defaults.
  for (const name of ["worktrees", "skills", "keys"]) {
    assert.equal(options.sections[name]?.collapsed, true, name);
  }
  for (const name of ["sessions", "trials", "prs", "warnings", "running"]) {
    assert.equal(options.sections[name]?.collapsed, false, name);
  }
});

test("a section whose choice is not two booleans refuses the whole document", () => {
  // Half a document is not a document. `"collapsed": "yes"` read as truthy would
  // fold a section on the strength of a string, and a missing `visible` read as
  // false would hide one nobody hid. Worse than either: dropping just the
  // section it could not read would take a section off the pane, and one
  // dropped for being unreadable looks exactly like one somebody chose to hide.
  for (const choice of [{ visible: true }, { collapsed: true },
                        { visible: true, collapsed: "yes" },
                        { visible: 1, collapsed: 0 },
                        { visible: null, collapsed: null },
                        "yes", 7, null, []]) {
    assert.equal(paneConfigFrom(reading({
      state: "ready",
      order: ["sessions", "warnings"],
      sections: { sessions: { visible: true, collapsed: false }, warnings: choice },
    })), null, JSON.stringify(choice));
  }
});

test("a document that did not resolve a configuration decides nothing", () => {
  // The state is what says the document is a resolution at all. A failed or
  // half-built one carrying section choices would otherwise decide the layout.
  for (const state of [undefined, null, "failed", "unavailable", "ready ", 7, true]) {
    assert.equal(paneConfigFrom(reading({
      state, order: ["sessions"], sections: { sessions: { visible: true, collapsed: true } },
    })), null, JSON.stringify(state));
  }
});

test("an order that is empty on purpose draws no sections", () => {
  // Distinct from an absent document: an empty order is somebody asking for a
  // pane with no sections in it, and a pane that answered with all eight would
  // be drawing a layout that was not asked for. The schema resolves an empty
  // subset, so this is reachable from a configuration file.
  const config = paneConfigFrom(reading({ state: "ready", order: [], sections: {} }));
  assert.notEqual(config, null);
  assert.deepEqual(config?.order, []);
  const options = paneOptions(80, NOW, config);
  assert.deepEqual(options.sectionOrder, []);
  assert.deepEqual(options.sections, {});
  // Absent is the other thing, and it still means all eight.
  assert.deepEqual(paneOptions(80, NOW, null).sectionOrder, SECTIONS);
});

test("an order naming a section this build does not draw drops it", () => {
  const config = paneConfigFrom(reading({
    state: "ready",
    order: ["sessions", "secrets", "sessions", 7, null, "warnings"],
    sections: { ...ALL, secrets: { visible: true, collapsed: false } },
  }));
  // Unknown, repeated and non-string entries are dropped rather than drawn: a
  // pane cannot build a section it does not have, and a repeat would draw one
  // twice with two headings that address the same fold.
  assert.deepEqual(config?.order, ["sessions", "warnings"]);
  assert.deepEqual(Object.keys(config?.sections ?? {}), ["sessions", "warnings"]);
});

test("an order naming nothing this build draws is no configuration at all", () => {
  const config = paneConfigFrom(reading({
    state: "ready", order: ["secrets"], sections: { secrets: { visible: true, collapsed: false } } }));
  // Nothing usable in it, so it is refused whole and the packaged default
  // stands, rather than an empty pane that draws no sections at all.
  assert.equal(config, null);
});

test("what is not an object is refused rather than guessed at", () => {
  for (const value of [null, 7, "a string", [1, 2]]) {
    assert.equal(paneConfigFrom(value), null, JSON.stringify(value));
  }
});

test("the width below which a row stacks is the pane's own, not the configuration's", () => {
  const config = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } } }));
  assert.equal(paneOptions(80, NOW, config).narrowAt, NARROW_AT);
  assert.equal(paneOptions(80, NOW, null).narrowAt, NARROW_AT);
});

test("a section's legend reaches the pane, and one that is not prose does not", () => {
  const stated = paneConfigFrom(reading({
    state: "ready", order: ["sessions", "prs"],
    sections: { sessions: { visible: true, collapsed: false, legend: "Sessions by state." },
                prs: { visible: true, collapsed: false } },
  }));
  assert.equal(stated?.sections["sessions"]?.legend, "Sessions by state.");
  // Absent and not-a-string are the same answer: no legend. The alternative
  // draws whatever the document held under a heading, and an object there is
  // the string "[object Object]" printed over a section's counts.
  for (const legend of [undefined, null, 7, {}, ["one"], ""]) {
    const config = paneConfigFrom(reading({
      state: "ready", order: ["sessions"],
      sections: { sessions: { visible: true, collapsed: false, legend } },
    }));
    assert.equal(config?.sections["sessions"]?.legend, null, JSON.stringify(legend));
  }
});

test("the measurements a reading carries decide what fits where", () => {
  const stated = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } },
    geometry: { minimumColumns: 30, horizontalReserve: 4, progressCells: 24, skillRows: 2,
                fanLines: 0 },
  }));
  // No task lines is a choice the schema allows: every task is then counted.
  assert.deepEqual(stated?.geometry,
                   { minimumColumns: 30, horizontalReserve: 4, progressCells: 24, skillRows: 2,
                     fanLines: 0 });
  assert.deepEqual(paneOptions(80, NOW, stated).geometry, stated?.geometry);
  // A reading carrying none, and one carrying values that are not measurements,
  // both draw the packaged numbers: a width of zero columns is not a width the
  // surface can be told to use, and honouring it would draw a pane nobody can
  // read rather than the one the schema ships.
  for (const geometry of [undefined, null, 7, "twenty", [],
                          { minimumColumns: 0, horizontalReserve: -1, progressCells: 0,
                            skillRows: 0, fanLines: -1 },
                          { minimumColumns: 1.5, horizontalReserve: "eight",
                            progressCells: true, skillRows: null, fanLines: 2.5 }]) {
    const config = paneConfigFrom(reading({
      state: "ready", order: ["sessions"],
      sections: { sessions: { visible: true, collapsed: false } }, geometry,
    }));
    assert.deepEqual(config?.geometry, GEOMETRY, JSON.stringify(geometry));
  }
  assert.deepEqual(paneOptions(80, NOW, null).geometry, GEOMETRY);
});

test("a section's configured title is the word on its heading", () => {
  const config = paneConfigFrom(reading({
    state: "ready", order: ["sessions", "prs"],
    sections: { sessions: { title: "Live sessions", visible: true, collapsed: false },
                prs: { title: 7, visible: true, collapsed: false } },
  }));
  assert.equal(config?.sections["sessions"]?.title, "Live sessions");
  // Not a word, so the heading is whatever this build calls the section rather
  // than the string the document held.
  assert.equal(config?.sections["prs"]?.title, null);
});

test("the keys a reading carries are the pane's, and an unnamed key falls back", () => {
  const stated = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } },
    keys: { tipsEnabled: false, tips: [], close: "q", collapse: "z", expand: "a" },
  }));
  assert.deepEqual(stated?.keys, { tipsEnabled: false, tips: [], close: "q", collapse: "z",
                                   expand: "a" });
  // A document naming no keys is a document whose keys the pane already knows:
  // the packaged default. Empty tips are the different case and are honoured,
  // because that is a person who turned them off rather than one who said
  // nothing.
  const bare = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } },
    keys: { tips: [], close: 7, collapse: "", expand: null },
  }));
  assert.equal(bare?.keys.close, DEFAULT_KEYS.close);
  assert.equal(bare?.keys.collapse, DEFAULT_KEYS.collapse);
  assert.equal(bare?.keys.expand, DEFAULT_KEYS.expand);
  assert.deepEqual(bare?.keys.tips, []);
  // And a reading carrying no keys block at all draws the packaged five tips.
  const none = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } } }));
  assert.deepEqual(none?.keys, DEFAULT_KEYS);
  // A keys block naming no tips is a reading from before the tips travelled,
  // not a person who turned them off. Only the second is written as a list.
  const unspecified = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } },
    keys: { close: "q" } }));
  assert.deepEqual(unspecified?.keys.tips, DEFAULT_KEYS.tips);
});

test("a key the host cannot fire is refused rather than listed", () => {
  // The pane draws a hotkey on a control and lists every binding in the keys
  // section. A binding of two characters is a shortcut nothing will ever match,
  // and listing it is worse than listing nothing. A digit is refused too: the
  // digits are the pane's own and fold one section each, so a configured digit
  // is two controls on one key, of which one silently stops working.
  const config = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } },
    keys: { close: "zz", collapse: "1", expand: "9" } }));
  assert.equal(config?.keys.close, DEFAULT_KEYS.close);
  assert.equal(config?.keys.collapse, DEFAULT_KEYS.collapse);
  assert.equal(config?.keys.expand, DEFAULT_KEYS.expand);
  // One character that is not a digit is honoured.
  const good = paneConfigFrom(reading({
    state: "ready", order: ["sessions"], sections: { sessions: { visible: true, collapsed: false } },
    keys: { close: "q", collapse: "z", expand: "a" } }));
  assert.deepEqual([good?.keys.close, good?.keys.collapse, good?.keys.expand], ["q", "z", "a"]);
});
