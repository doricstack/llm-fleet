/**
 * The pane surface, which is what the engine entry hands the host.
 *
 * These cases are the ones the engine cannot be asked about without loading a
 * plugin into a live session: which tree a set of documents becomes, what the
 * surface says while the read is still running, and what it says when the read
 * failed or the configuration was refused. A pane that drew an empty fleet in any
 * of those cases would report a quiet machine and hide a broken reader.
 *
 * Run with: node --test plugins/llm-fleet/components/surface.test.ts
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { elementTypes, renderedText } from "../plugins/llm-fleet/components/layout.ts";
import { DEFAULT_KEYS } from "../plugins/llm-fleet/components/pane.ts";
import { GEOMETRY } from "../plugins/llm-fleet/components/options.ts";
import { recordingPrimitives } from "../plugins/llm-fleet/components/mount.ts";
import { isReading, isRefusal, surfaceTree,
         type SurfaceInput } from "../plugins/llm-fleet/components/surface.ts";
import { FOOTER_TEXT } from "../plugins/llm-fleet/components/version.ts";

const WIDTH = 100;
const NOW = 1790000000;

function reading(): Record<string, unknown> {
  return {
    generated_at: NOW,
    roster: {
      state: "ready",
      providers: { "one": { state: "ready", jobs: 1 } },
      jobs: [{
        provider: "one", id: "job-1", name: "Review adapter behavior", state: "working",
        label: "Working", started_at: NOW - 600, last_seen_at: NOW - 5, folder: "/tmp/project",
      }],
      sources: { jobs: "ready", interactive: "empty" },
      interactive: { one: 2 },
    },
    trials: { state: "empty" },
    progress: { state: "empty" },
    prs: { state: "empty" },
    skills: { state: "empty" },
    worktrees: { state: "empty" },
  };
}

function input(overrides: Partial<SurfaceInput> = {}): SurfaceInput {
  return { documents: reading() as never, width: WIDTH, now: NOW, ...overrides };
}

function draw(request: SurfaceInput): { types: string[]; text: string } {
  const primitives = recordingPrimitives();
  const tree = surfaceTree(request, primitives);
  return { types: elementTypes(tree), text: renderedText(tree).join("\n") };
}

/** Every row the tree draws, as the cells on it: what a line is made of. */
function rowsOf(node: unknown): string[][] {
  const rows: string[][] = [];
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as { props?: { flexDirection?: string }; children?: unknown };
    const children = Array.isArray(record.children) ? record.children : [];
    if (record.props?.flexDirection === "row" && children.length) {
      rows.push(renderedText(value as never));
    }
    for (const child of children) {
      walk(child);
    }
  };
  walk(node);
  return rows;
}

test("a reading becomes the pane, drawn with the host's own elements", () => {
  const drawn = draw(input());
  // Box for the shape, Text for what is written, Button for what a person can
  // press: the three the declared subset carries, and nothing else.
  assert.deepEqual(drawn.types, ["Box", "Button", "Text"]);
  assert.equal(drawn.text.includes("Review adapter behavior"), true);
  assert.equal(drawn.text.includes("llm-fleet"), true);
});

test("a pane drawn before a reading still names the plugin and its version", () => {
  // The footer is not a claim about the machine, so it is drawn whatever the
  // read is doing: a person quoting a version takes it from the pane they see.
  const drawn = draw(input({ documents: null }));
  assert.equal(drawn.text.split("\n").at(-1), FOOTER_TEXT);
});

test("a read that has not answered says it is reading, not that nothing is running", () => {
  const drawn = draw(input({ documents: null }));
  assert.equal(drawn.text.includes("Reading the machine"), true);
  // The one sentence it must not print while a read is in flight.
  assert.equal(drawn.text.includes("No background"), false);
  assert.equal(drawn.text.includes("nothing"), false);
});

test("a read that failed names the failure and is not an empty fleet", () => {
  const drawn = draw(input({ documents: null, reason: "the read command exited 1" }));
  assert.equal(drawn.text.includes("the read did not answer"), true);
  assert.equal(drawn.text.includes("the read command exited 1"), true);
  assert.equal(drawn.text.includes("Reading the machine"), false);
  assert.equal(drawn.text.includes("No "), false);
});

test("a refused configuration names every error rather than the first", () => {
  const drawn = draw(input({
    documents: { configErrors: [{ code: "E_CONFIG_TYPE", path: "pane.width" },
                               { code: "E_CONFIG_RULE", path: "keys.open" }] } as never,
  }));
  assert.equal(drawn.text.includes("E_CONFIG_TYPE pane.width"), true);
  assert.equal(drawn.text.includes("E_CONFIG_RULE keys.open"), true);
});

test("each refusal is drawn on its own line, so none is cut by the one before it", () => {
  // Joined into one sentence, the pane's width cut the line after the first
  // error, and the second error's meaning is the part a person needs. Slots
  // side by side in one row are cut from that row's end, so each refusal is a
  // row of its own. Found by review, 2026-11-23.
  const primitives = recordingPrimitives();
  const tree = surfaceTree(input({
    documents: { configErrors: [{ code: "E_CONFIG_TYPE", path: "pane.width" },
                                { code: "E_CONFIG_RULE", path: "keys.open" }] } as never,
  }), primitives);
  const rows = rowsOf(tree).filter((row) => row.some((cell) => cell.includes("E_CONFIG_")));
  assert.equal(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.filter((cell) => cell.trim() !== "").length, 1, JSON.stringify(row));
  }
  assert.equal(rows[1]?.join("").includes("two fields contradict each other"), true);
  const lines = renderedText(tree);
  assert.equal(lines.includes("the configuration was refused:"), true);
});

test("a refused configuration says what each code means, not just which rule broke", () => {
  // A code alone says nothing a person can act on, and the malformed one stands
  // for two causes the pane could not tell apart. Found by review, 2026-11-23.
  const drawn = draw(input({
    documents: { configErrors: [{ code: "E_CONFIG_MALFORMED", path: "config.json" }] } as never,
  }));
  assert.equal(drawn.text.includes("E_CONFIG_MALFORMED config.json: the file is not valid JSON"),
               true);
  assert.equal(drawn.text.includes("or its bytes are not UTF-8"), true);
});

test("a malformed refusal names the cause the loader found", () => {
  // The loader can tell bytes that are not UTF-8 from text that is not JSON,
  // and the repair differs: saving in UTF-8 is not the same fix as repairing
  // the document. Found by review, 2026-11-23.
  const bytes = draw(input({ documents: { configErrors: [
    { code: "E_CONFIG_MALFORMED", path: "config.json", detail: "bytes" }] } as never }));
  assert.equal(bytes.text.includes("the file's bytes are not UTF-8"), true);
  assert.equal(bytes.text.includes("not valid JSON"), false);
  const json = draw(input({ documents: { configErrors: [
    { code: "E_CONFIG_MALFORMED", path: "config.json", detail: "json" }] } as never }));
  assert.equal(json.text.includes("the file is not valid JSON"), true);
  assert.equal(json.text.includes("bytes are not UTF-8"), false);
});

test("every refusal the schema names has a sentence, and no other code is invented", async () => {
  // The sentences are the schema's own errorCodes table, kept in step here so a
  // new code cannot reach the pane as a bare name. Found by review, 2026-11-23.
  const schema = JSON.parse(
    await readFile(new URL("../plugins/llm-fleet/config/schema.json", import.meta.url), "utf-8"));
  const declared = new Map((schema.errorCodes as { code: string; meaning: string }[])
    .map((entry) => [entry.code, entry.meaning]));
  for (const [code, meaning] of declared) {
    const drawn = draw(input({ documents: { configErrors: [{ code, path: "x" }] } as never }));
    assert.equal(drawn.text.includes(code + " x: " + meaning), true,
                 "the pane draws what " + code + " means");
  }
});

test("a refusal and a reading are told apart before anything is drawn", () => {
  assert.equal(isReading(reading() as never), true);
  assert.equal(isReading({ configErrors: [] } as never), false);
  assert.equal(isReading(null), false);
  assert.equal(isReading([1, 2] as never), false);
  assert.equal(isRefusal({ configErrors: [] } as never), true);
  assert.equal(isRefusal(reading() as never), false);
  assert.equal(isRefusal([1, 2] as never), false);
  assert.equal(isRefusal(null), false);
});

test("documents that are neither a reading nor a refusal are named, not drawn as an empty fleet", () => {
  // A reader that printed a list, or anything else that is not one of the two
  // shapes this layer knows. It is a broken read, not a refusal and not a quiet
  // machine, and reading past it threw inside the paint.
  const drawn = draw(input({ documents: [1, 2] as never }));
  assert.equal(drawn.text.includes("did not print a reading"), true);
  assert.equal(drawn.text.includes("configuration"), false);
  assert.equal(drawn.text.includes("No "), false);
});

test("documents carrying none of the fleet's sources are not a reading", () => {
  // An empty object names no source at all, so drawing it reports zero of
  // everything the machine never said: a quiet fleet with no evidence behind it.
  assert.equal(isReading({} as never), false);
  assert.equal(isReading({ anything: 1 } as never), false);
  assert.equal(isReading({ roster: { state: "empty" } } as never), true);
  const drawn = draw(input({ documents: {} as never }));
  assert.equal(drawn.text.includes("did not print a reading"), true);
  assert.equal(drawn.text.includes("0 working"), false);
  assert.equal(drawn.text.includes("No "), false);
});

test("a reading with no clock of its own is aged from when it was taken", () => {
  // The entry knows when the reading it holds was taken, and a reading that
  // carries no usable timestamp of its own is still that old. Falling back to
  // the moment of the paint labels a fleet from the last session as current.
  const documents = { roster: { state: "ready" } };
  const drawn = draw({ documents: documents as never, width: WIDTH, now: NOW,
                       takenAt: NOW - 3600 });
  assert.equal(drawn.text.includes("Updated 1h ago"), true);
});

test("a source named with nothing under it is not a source", () => {
  assert.equal(isReading({ roster: null } as never), false);
  assert.equal(isReading({ roster: null, pacer: null } as never), false);
  // A source that is the wrong shape is named, and the assembly fails it rather
  // than reading it as empty, so it still counts as naming one.
  assert.equal(isReading({ roster: [1, 2] } as never), true);
  const drawn = draw(input({ documents: { roster: null } as never }));
  assert.equal(drawn.text.includes("did not print a reading"), true);
  assert.equal(drawn.text.includes("0 working"), false);
});

test("a refusal whose errors are not a list of errors is still drawn as a refusal", () => {
  for (const errors of ["nope", [7], null, []] as unknown[]) {
    const drawn = draw(input({ documents: { configErrors: errors } as never }));
    assert.equal(drawn.text.includes("the configuration was refused"), true);
    assert.equal(drawn.text.includes("undefined"), false);
  }
});

test("every surface is host elements a host can draw", () => {
  const surfaces = [
    input(),
    input({ documents: null }),
    input({ documents: null, reason: "no JSON" }),
    input({ documents: { configErrors: [{ code: "E", path: "p" }] } as never }),
  ];
  for (const request of surfaces) {
    const drawn = draw(request);
    assert.equal(drawn.types.length > 0, true);
    for (const type of drawn.types) {
      assert.equal(type === "Box" || type === "Text" || type === "Button", true, type);
    }
    assert.equal(drawn.text.trim().length > 0, true);
  }
});

test("the surface takes the options it is given rather than inventing them", () => {
  const drawn = draw(input({
    options: {
      width: 60, narrowAt: 40, now: NOW, sectionOrder: ["sessions"],
      sections: { sessions: { visible: true, collapsed: false } },
      keys: DEFAULT_KEYS,
      geometry: GEOMETRY,
    },
  }));
  assert.equal(drawn.text.includes("Review adapter behavior"), true);
  assert.equal(drawn.text.includes("Worktrees"), false);
});

test("a document naming a state this layer does not know is failed, not empty", () => {
  const documents = reading();
  documents.pacer = { state: "something-new" };
  const drawn = draw(input({ documents: documents as never }));
  assert.equal(drawn.text.includes("Could not read"), true);
});

test("the pane drawn before any reading carries the close control and says Escape closes it", () => {
  const pressed: string[] = [];
  for (const reason of [undefined, "the read command exited 3"]) {
    const tree = surfaceTree({ documents: null, width: WIDTH, now: NOW, reason,
                               onPress: (element) => { pressed.push(element); } },
                             recordingPrimitives()) as never;
    const words = renderedText(tree);
    assert.equal(words.includes("Close"), true);
    assert.equal(words.includes("Esc or x closes this pane"), true);
    const close = findButton(tree, "fleet.close");
    assert.equal(close?.props.hotkey, "x");
    close?.props.onPress();
  }
  assert.deepEqual(pressed, ["fleet.close", "fleet.close"]);
  // The configured key is the one drawn and named.
  const keyed = surfaceTree({ documents: null, width: WIDTH, now: NOW,
                              options: { width: WIDTH, narrowAt: 60, now: NOW, sectionOrder: [],
                                         sections: {}, keys: { ...DEFAULT_KEYS, close: "q" },
                                         geometry: GEOMETRY } },
                            recordingPrimitives()) as never;
  assert.equal(renderedText(keyed).includes("Esc or q closes this pane"), true);
  assert.equal(findButton(keyed, "fleet.close")?.props.hotkey, "q");
});

/** The button a tree draws under one address. */
function findButton(node: unknown,
                    key: string): { props: { hotkey?: string; onPress: () => void } } | undefined {
  if (node === null || typeof node !== "object") {
    return undefined;
  }
  const record = node as { type?: string; props?: { key?: string }; children?: unknown[] };
  if (record.type === "Button" && record.props?.key === key) {
    return record as never;
  }
  for (const child of record.children ?? []) {
    const found = findButton(child, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}
