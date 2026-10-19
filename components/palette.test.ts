/**
 * File: components/palette.test.ts
 * Purpose: The theme a reading carries, and the one substitution that draws the
 *          finished tree in it: every tone, nested hover props, and the colors a
 *          desktop drawing carries in its own markup.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Node } from "../plugins/llm-fleet/components/host.ts";
import { recordingPrimitives } from "../plugins/llm-fleet/components/mount.ts";
import { paneConfigFrom, paneOptions } from "../plugins/llm-fleet/components/options.ts";
import { recolor, THEME, themeFrom, worktreeToken } from "../plugins/llm-fleet/components/palette.ts";
import { surfaceTree } from "../plugins/llm-fleet/components/surface.ts";
import { barVector, restyle, tileVector } from "../plugins/llm-fleet/components/vector.ts";
import { renderVectors } from "./review.ts";

const NOW = 1790000000;

/** Every color a tree holds, in props, hover props and children alike. */
function colors(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => colors(item, found));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if ((key === "color" || key.endsWith("Color")) && typeof inner === "string") {
        found.push(inner);
      } else if (typeof inner === "object") {
        colors(inner, found);
      }
    }
  }
  return found;
}

function text(props: Record<string, unknown>, value: string): Node {
  return { type: "Text", props, children: [value] };
}

test("a theme is read entry by entry, and anything this build cannot draw keeps the packaged choice", () => {
  assert.deepEqual(themeFrom(undefined), THEME);
  assert.deepEqual(themeFrom(["error"]), THEME);
  const read = themeFrom({ failure: "claude", waiting: "accent", working: 7, idle: "inactive",
                           worktrees: { held: "failure", merged: "purple", active: "success" } });
  assert.deepEqual(read.tones, { failure: "claude", waiting: "warning", working: "success", idle: "inactive" });
  assert.deepEqual(read.worktrees, { active: "working", held: "failure", unknown: "waiting",
                                     merged: "idle", preserved: "idle" });
  assert.equal(worktreeToken(read, "held"), "error");
});

test("the packaged theme hands the same tree back without copying it", () => {
  const tree: Node = { type: "Box", props: {}, children: [text({ color: "error" }, "x")] };
  assert.equal(recolor(tree, THEME), tree);
});

test("every tone is drawn as its theme's token, nested and hovered, and nothing else moves", () => {
  const press = () => undefined;
  const tree: Node = {
    type: "Box", props: { borderColor: "warning", hover: { borderColor: "error", display: "flex" } },
    children: [
      text({ color: "error", backgroundColor: "success", bold: true }, "failed"),
      text({ color: "subtle", hover: { color: "claude" } }, "quiet"),
      { type: "Button", props: { key: "go", label: "go", onPress: press,
                                 children: [text({ color: "success" }, "go")] },
        children: [text({ color: "text" }, "go")] },
      "plain words",
    ],
  };
  // A swap both ways is made once per color, not chained.
  const theme = themeFrom({ failure: "success", working: "error", waiting: "claude", idle: "inactive" });
  const drawn = recolor(tree, theme);
  assert.deepEqual(drawn.props, { borderColor: "claude", hover: { borderColor: "success", display: "flex" } });
  const [failed, quiet, button, words] = drawn.children as [Node, Node, Node, string];
  assert.deepEqual(failed.props, { color: "success", backgroundColor: "error", bold: true });
  assert.deepEqual(quiet.props, { color: "inactive", hover: { color: "claude" } });
  assert.equal((button.props as { onPress: unknown }).onPress, press);
  assert.deepEqual(colors((button.props as { children: unknown }).children), ["error"]);
  assert.deepEqual(colors(button.children), ["text"]);
  assert.equal(words, "plain words");
  // The tree that was handed in is not changed underneath its caller.
  assert.deepEqual((tree.children[0] as Node).props, { color: "error", backgroundColor: "success", bold: true });
});

test("a desktop drawing's own fills follow the theme, light and dark, and its shapes keep their classes", () => {
  const vector = barVector(3, 4, "success", 16);
  if (vector === null) {
    throw new Error("a bar of 3 of 4 is drawn");
  }
  const node: Node = { type: "Text", props: { color: "success" }, children: ["3 of 4"], vector };
  const drawn = recolor(node, themeFrom({ working: "suggestion" }));
  const source = drawn.vector?.source ?? "";
  assert.match(source, /class="f-success"/);
  assert.match(source, /\.f-success\{fill:#5769f7\}.*@media \(prefers-color-scheme: dark\)\{.*\.f-success\{fill:#b1b9f9\}/s);
  assert.doesNotMatch(source, /#2c7a39|#4eba65/);
  assert.equal(drawn.vector?.alt, vector.alt);
  assert.equal(drawn.vector?.cells, vector.cells);
});

test("a desktop tile's outline follows the quiet tone, as the terminal's border does", () => {
  const vector = tileVector("Running", "3", "success", 12);
  const node: Node = { type: "Box", props: { borderColor: "subtle" }, children: [], vector };
  // The packaged quiet tone leaves the neutral outline as it was drawn.
  assert.match(restyle(vector.source, (token) => token), /\.rule\{[^}]*stroke:#000000;stroke-opacity:\.18\}/);
  const drawn = recolor(node, themeFrom({ idle: "planMode" }));
  assert.equal((drawn.props as { borderColor: string }).borderColor, "planMode");
  const source = drawn.vector?.source ?? "";
  assert.match(source, /\.rule\{fill:#000000;fill-opacity:\.03;stroke:#006666;stroke-opacity:1\}/);
  assert.match(source, /@media \(prefers-color-scheme: dark\)\{.*\.rule\{fill:#ffffff;fill-opacity:\.04;stroke:#48968c;stroke-opacity:1\}/s);
  // A theme that leaves the quiet tone alone leaves the outline alone.
  const working = recolor(node, themeFrom({ working: "claude" })).vector?.source ?? "";
  assert.match(working, /\.rule\{[^}]*stroke:#000000;stroke-opacity:\.18\}/);
});

test("the review page draws the reading's theme, as the live pane does", () => {
  const documents = (theme: Record<string, string>) => ({
    pane: { state: "ready", order: ["running"],
            sections: { running: { title: "Running", visible: true, collapsed: false, legend: null,
                                   hideWhenEmpty: false, maxRows: null } },
            theme },
    roster: { state: "ready", jobs: [], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
    progress: { state: "ready", errors: [], runs: [
      { key: "k", repo: "project", branch: "feature-a", label: "Test export boundaries",
        display: "Test export boundaries", done: 42, total: 80, failed: 0,
        first_failure: "", elapsed: 120, eta_minutes: null, phase: "running" }] },
  });
  const drawn = (theme: Record<string, string>): string =>
    renderVectors(documents(theme) as never, 100, NOW, NOW - 4).map((vector) => vector.source).join("");
  const packaged = drawn({});
  assert.match(packaged, /\.f-success\{fill:#2c7a39\}/);
  const themed = drawn({ working: "claude" });
  assert.doesNotMatch(themed, /\.f-success\{fill:#2c7a39\}/);
  assert.match(themed, /\.f-success\{fill:#c2643f\}/);
});

test("a reading's theme reaches the drawn pane: a working job is drawn in the token it names", () => {
  const documents = {
    generated_at: NOW,
    pane: { state: "ready", order: ["sessions"],
            sections: { sessions: { title: "Sessions", visible: true, collapsed: false, legend: null,
                                    hideWhenEmpty: false, maxRows: null } },
            theme: { failure: "error", waiting: "warning", working: "claude", idle: "subtle",
                     worktrees: {} } },
    roster: {
      state: "ready",
      providers: { one: { state: "ready", jobs: 1 } },
      jobs: [{ provider: "one", id: "job-1", name: "Review adapter behavior", state: "working",
               label: "Working", started_at: NOW - 600, last_seen_at: NOW - 5, folder: "/tmp/project" }],
      sources: { jobs: "ready", interactive: "empty" },
      interactive: { one: 2 },
    },
    trials: { state: "empty" }, progress: { state: "empty" }, prs: { state: "empty" },
    skills: { state: "empty" }, worktrees: { state: "empty" },
  };
  const options = paneOptions(100, NOW, paneConfigFrom(documents));
  assert.equal(options.theme?.tones.working, "claude");
  const themed = colors(surfaceTree({ documents: documents as never, width: 100, now: NOW, options },
                                    recordingPrimitives()));
  const packaged = colors(surfaceTree({ documents: documents as never, width: 100, now: NOW,
                                        options: { ...options, theme: THEME } }, recordingPrimitives()));
  assert.ok(packaged.includes("success"));
  assert.ok(!themed.includes("success"));
  assert.ok(themed.includes("claude"));
});
