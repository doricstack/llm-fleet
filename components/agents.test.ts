/**
 * Agent cards: a background session's own figures, from the reader's document
 * to the words the pane draws.
 *
 * Every case starts from the document the roster reader prints, because the
 * mapping between the two is where a field the reader renamed would go missing
 * in silence. The claims under test are the ones a card can overstate: a cost
 * estimated is drawn as an estimate, a total read from a transcript's tail is
 * drawn as a floor, a model nobody priced has no cost, and a bar has a real
 * denominator and says which one.
 *
 * Run with: node --test components/agents.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { snapshotFrom } from "../plugins/llm-fleet/components/snapshot.ts";
import {
  DEFAULT_KEYS, agentStrip, modelName, paneFrom, spentText, tokensOf, type PaneOptions,
} from "../plugins/llm-fleet/components/pane.ts";
import { GEOMETRY } from "../plugins/llm-fleet/components/options.ts";
import { renderedText, renderPane } from "../plugins/llm-fleet/components/layout.ts";
import type { Job } from "../plugins/llm-fleet/components/state.ts";

const NOW = 1_700_000_000;

const OPTIONS: PaneOptions = {
  width: 140,
  narrowAt: 60,
  now: NOW,
  sectionOrder: ["sessions"],
  sections: { sessions: { visible: true, collapsed: false } },
  keys: DEFAULT_KEYS,
  geometry: GEOMETRY,
};

function job(agent: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "0123abcd", name: "job-name", state: "working", cwd: "~", provider: "primary",
           label: "Primary", started_at: NOW - 600, session_id: "0123abcd-0000",
           activity: "busy", since: NOW - 600, agent, ...overrides };
}

function ready(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: "ready", title: "Agent title", model: "claude-opus-5-5", effort: "high",
           turns: 4, contextTokens: 250_000, contextWindow: 1_000_000,
           tokens: { input: 1_000, cacheWrite: 9_000, cacheRead: 1_990_000, output: 0 },
           costUsd: 1.25, costSource: "estimate", lowerBound: false,
           firstActivity: NOW - 3_600, lastActivity: NOW - 10, steps: null, ...overrides };
}

function drawn(jobs: unknown[]): string {
  const snapshot = snapshotFrom({ roster: { state: "ready", jobs, interactive: {}, errors: [],
                                            providers: {}, sources: {} } }, NOW);
  return renderedText(renderPane(paneFrom(snapshot, OPTIONS))).join("\n");
}

function jobsOf(jobs: unknown[]): Job[] {
  return snapshotFrom({ roster: { state: "ready", jobs, interactive: {}, errors: [],
                                  providers: {}, sources: {} } }, NOW).roster.jobs;
}

test("a card draws the title, model, effort, context, tokens, cost and time", () => {
  const text = drawn([job(ready())]);
  for (const figure of ["Agent title", "opus 5.5", "high", "25% of the context window",
                        "2.0M tokens", "~$1.25", "1h 0m"]) {
    assert.equal(text.includes(figure), true, figure + "\n" + text);
  }
});

test("a card reads as the host's Agents panel does: who, then counts and figures, then the bar", () => {
  const [row] = paneFrom(snapshotFrom({ roster: { state: "ready", jobs: [job(ready({
    steps: { done: 2, total: 4, phase: "Banner" } }))], interactive: {}, errors: [],
    providers: {}, sources: {} } }, NOW), OPTIONS).groups[0].rows;
  // Who runs it: the provider, the model and the effort, and nothing measured.
  assert.deepEqual(row.meta.map((slot) => slot.text), ["Primary", " \u00b7 opus 5.5", " \u00b7 high"]);
  // What it measured sits at the right of the bar's line, cost first so a cut
  // line keeps the figure a person looks for.
  assert.deepEqual(row.figures?.map((slot) => slot.text),
                   ["~$1.25", " \u00b7 25% context", " \u00b7 2.0M tokens", " \u00b7 1h 0m"]);
  // How far: the steps and the one in hand at the left, and a bar the width of
  // the card under them.
  assert.equal(row.bar?.label?.text, "2 / 4 steps \u00b7 Banner");
  assert.equal(row.bar?.cells, undefined);
  assert.equal(row.detail, undefined);
});

test("the cost comes before the figures a cut line can spare", () => {
  const text = drawn([job(ready())]);
  // Both searched from the card's title: the heading's strip states the tokens too.
  const card = text.indexOf("Agent title");
  const cost = text.indexOf("~$1.25", card);
  assert.equal(cost > card, true);
  assert.equal(cost < text.indexOf("2.0M tokens", card), true);
});

test("a session days old is dated in days", () => {
  const text = drawn([job(ready({ firstActivity: NOW - (3 * 86_400 + 3_700) }))]);
  assert.equal(text.includes("3d 1h"), true);
});

test("a model identifier is said the way a person says it", () => {
  assert.equal(modelName("claude-opus-5-5"), "opus 5.5");
  assert.equal(modelName("claude-haiku-4"), "haiku 4");
  assert.equal(modelName("deepseek-flash"), "deepseek-flash");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "haiku 4.5");
});

test("a cost is drawn in the words its source allows", () => {
  assert.equal(spentText({ state: "ready", costUsd: 2, costSource: "host" }), "$2.00");
  assert.equal(spentText({ state: "ready", costUsd: 2, costSource: "estimate" }), "~$2.00");
  assert.equal(spentText({ state: "ready", costUsd: 2, costSource: "estimate", lowerBound: true }),
               "at least $2.00");
  // A sub-cent estimate already says it is approximate, once.
  assert.equal(spentText({ state: "ready", costUsd: 0.001, costSource: "estimate" }), "~<$0.01");
  assert.equal(spentText({ state: "ready" }), null);
  assert.equal(spentText({ state: "ready", costUsd: 2, costSource: "floor" }), "at least $2.00");
});

test("a model nobody priced draws no cost, never a nought", () => {
  const text = drawn([job(ready({ costUsd: undefined, costSource: undefined,
                                  model: "deepseek-flash", contextWindow: undefined }))]);
  assert.equal(text.includes("cost not priced"), true);
  assert.equal(text.includes("$0.00"), false);
  assert.equal(text.includes("$"), false);
  // With no window there is no share: the context is drawn in tokens.
  assert.equal(text.includes("250k in context"), true);
  assert.equal(text.includes("% context"), false);
});

test("totals from the end of a long transcript are drawn as floors", () => {
  const text = drawn([job(ready({ lowerBound: true, firstActivity: null }))]);
  assert.equal(text.includes("at least $1.25"), true);
  assert.equal(text.includes("at least 2.0M tokens"), true);
  assert.equal(text.includes("Totals are from the end of a long transcript."), true);
});

test("a floor names the reason the reader gave, not the one for a long transcript", () => {
  // A subagent transcript nobody could read floors the totals for a reason of
  // its own, and the sentence for a tail would name the wrong cause.
  const text = drawn([job(ready({ lowerBound: true,
                                  reason: "2 subagent transcripts could not be read" }))]);
  assert.equal(text.includes("Totals are a floor: 2 subagent transcripts could not be read."),
               true);
  assert.equal(text.includes("Totals are from the end of a long transcript."), false);
});

test("the note follows the floor, not the reason beside it", () => {
  // A reason alone does not make totals inexact, so a card carrying one and no
  // floor keeps a clean line under it.
  const [row] = paneFrom(snapshotFrom({ roster: { state: "ready",
    jobs: [job(ready({ reason: "no transcript for the session" }))], interactive: {},
    errors: [], providers: {}, sources: {} } }, NOW), OPTIONS).groups[0].rows;
  assert.equal(row.note, undefined);
});

test("the bar is the session's own steps when it keeps a list, and says so", () => {
  const text = drawn([job(ready({ steps: { done: 2, total: 5, phase: "Writing the card" } }))]);
  assert.equal(text.includes("2 / 5 steps \u00b7 Writing the card"), true);
  assert.equal(text.includes("Now: Writing the card"), false);
  assert.equal(text.includes("of the context window"), false);
});

test("without a list the bar is the context share, labeled as that", () => {
  const text = drawn([job(ready())]);
  assert.equal(text.includes("25% of the context window"), true);
  assert.equal(text.includes("steps"), false);
  // The share is the bar's own label, so the figures do not state it again.
  assert.equal(text.includes("25% context \u00b7"), false);
  assert.equal(text.includes("\u00b7 25% context"), false);
});

test("without a list or a window there is no bar at all", () => {
  const [row] = paneFrom(snapshotFrom({ roster: { state: "ready",
    jobs: [job(ready({ contextWindow: undefined }))], interactive: {}, errors: [], providers: {},
    sources: {} } }, NOW), OPTIONS).groups[0].rows;
  assert.equal(row.bar, undefined);
});

test("a step count that cannot be true is no step count", () => {
  for (const steps of [{ done: 6, total: 5 }, { done: 1, total: 0 }, { done: -1, total: 3 },
                       { done: 1.5, total: 3 }, "2/5"]) {
    const [card] = jobsOf([job(ready({ steps }))]);
    assert.equal(card.agent?.steps, null, JSON.stringify(steps));
  }
});

test("a figure of the wrong shape is left out, not repaired", () => {
  const [card] = jobsOf([job(ready({
    costUsd: -1, contextTokens: "many", contextWindow: 0,
    tokens: { input: 1, cacheWrite: 1, cacheRead: 1 },
  }))]);
  assert.equal(card.agent?.costUsd, undefined);
  assert.equal(card.agent?.contextTokens, undefined);
  assert.equal(card.agent?.contextWindow, undefined);
  assert.equal(card.agent?.tokens, undefined);
  // A cost with no source it came from is not drawn either.
  const [sourceless] = jobsOf([job(ready({ costSource: "guess" }))]);
  assert.equal(sourceless.agent?.costUsd, undefined);
});

test("a card whose figures could not be read says why and keeps its row", () => {
  const failed = drawn([job({ state: "failed", reason: "PermissionError", steps: null })]);
  assert.equal(failed.includes("Figures unreadable: PermissionError."), true);
  assert.equal(failed.includes("job-name"), true);
  const missing = drawn([job({ state: "unavailable", reason: "no transcript for the session" })]);
  assert.equal(missing.includes("Figures unreadable: no transcript for the session."), true);
  const empty = drawn([job({ state: "empty", steps: null })]);
  assert.equal(empty.includes("No turns recorded yet."), true);
});

test("a row from a roster without the agents source draws as it always did", () => {
  const text = drawn([job(undefined)]);
  assert.equal(text.includes("job-name"), true);
  assert.equal(text.includes("session 0123abcd"), true);
  assert.equal(text.includes("context"), false);
});

test("a session resumed into a new process is dated from its first turn", () => {
  const text = drawn([job(ready({ firstActivity: NOW - 7_200 }), { started_at: NOW - 60 })]);
  assert.equal(text.includes("2h 0m"), true);
});

test("the heading strip sums what the cards show and is as exact as its least exact part", () => {
  const hosts = jobsOf([job(ready({ costUsd: 1, costSource: "host" })),
                        job(ready({ costUsd: 2, costSource: "host" }))]);
  assert.equal(agentStrip(hosts, NOW)[0].text, "$3.00");
  const mixed = jobsOf([job(ready({ costUsd: 1, costSource: "host" })),
                        job(ready({ costUsd: 2, costSource: "estimate" }))]);
  assert.equal(agentStrip(mixed, NOW)[0].text, "~$3.00");
  const unpriced = jobsOf([job(ready({ costUsd: 1, costSource: "host" })),
                           job(ready({ costUsd: undefined, costSource: undefined }))]);
  assert.equal(agentStrip(unpriced, NOW)[0].text, "at least $1.00");
  const floor = jobsOf([job(ready({ costUsd: 1, costSource: "host", lowerBound: true }))]);
  const strip = agentStrip(floor, NOW).map((slot) => slot.text).join("");
  assert.equal(strip.includes("at least $1.00"), true);
  assert.equal(strip.includes("at least 2.0M tokens"), true);
  assert.equal(strip.includes("1h 0m longest"), true);
});

test("a turn larger than the configured window is drawn in tokens, not as a full share", () => {
  const text = drawn([job(ready({ contextTokens: 1_200_000 }))]);
  assert.equal(text.includes("1.2M in context"), true);
  assert.equal(text.includes("100% context"), false);
});

test("a card nobody could read makes the strip a floor", () => {
  const cards = jobsOf([job(ready({ costUsd: 1, costSource: "host" })),
                        job({ state: "failed", reason: "x" })]);
  const strip = agentStrip(cards, NOW).map((slot) => slot.text).join("");
  assert.equal(strip.includes("at least $1.00"), true);
  assert.equal(strip.includes("at least 2.0M tokens"), true);
  // An empty card spent nothing, so it leaves the sum exact.
  const empty = jobsOf([job(ready({ costUsd: 1, costSource: "host" })),
                        job({ state: "empty", steps: null })]);
  assert.equal(agentStrip(empty, NOW)[0].text, "$1.00");
  // A floor from one card's partial host record makes the sum one too.
  const partial = jobsOf([job(ready({ costUsd: 1, costSource: "floor" }))]);
  assert.equal(agentStrip(partial, NOW)[0].text, "at least $1.00");
});

test("the strip counts only cards that were read, and is absent when none was", () => {
  const cards = jobsOf([job({ state: "failed", reason: "x" })]);
  assert.deepEqual(agentStrip(cards, NOW), []);
  assert.equal(tokensOf({ state: "ready" }), null);
});

test("the heading keeps its counts first, so a cut takes the strip, not the counts", () => {
  const text = drawn([job(ready())]);
  // The heading is drawn before the card, so the first figure is the strip's.
  assert.equal(text.indexOf("1 working") < text.indexOf("~$1.25"), true);
  assert.equal(text.indexOf("~$1.25") < text.indexOf("Agent title"), true);
});
