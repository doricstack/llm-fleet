/**
 * This session's figures from the engine, as the section's document.
 *
 * Run with: node --test components/session.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionDocument, withSession } from "../plugins/llm-fleet/components/session.ts";
import { paneFrom } from "../plugins/llm-fleet/components/pane.ts";
import { paneOptions } from "../plugins/llm-fleet/components/options.ts";
import { renderedText, renderPane } from "../plugins/llm-fleet/components/layout.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/llm-fleet/components/snapshot.ts";

const NOW_MS = 1_790_000_000_000;

const USAGE = {
  startedAt: NOW_MS - 3_600_000,
  context: { tokens: 50_000, window: 200_000, percent: 25 },
  rateLimits: [
    { kind: "five_hour", percentUsed: 42, resetsAt: "2026-10-12T16:00:00Z" },
    { kind: "seven_day", percentUsed: 7 },
  ],
  cost: { usd: 1.23 },
};

test("the engine's figures fill the fields the section draws", () => {
  const document = sessionDocument(USAGE, "claude-opus-5-5", { version: "2.1.296" }, "abc", NOW_MS);
  assert.ok(document);
  assert.equal(document.state, "ready");
  assert.equal(document.costUsd, 1.23);
  assert.equal(document.durationMs, 3_600_000);
  assert.equal(document.windowSize, 200_000);
  assert.equal(document.remainingPercent, 75);
  assert.equal(document.fiveHourUsedPercent, 42);
  assert.equal(document.fiveHourResetsAt, Date.parse("2026-10-12T16:00:00Z") / 1000);
  assert.equal(document.sevenDayUsedPercent, 7);
  assert.equal(document.model, "claude-opus-5-5");
  assert.equal(document.version, "2.1.296");
  assert.equal(document.sessionId, "abc");
});

test("what the engine did not report is named absent, never drawn as nought", () => {
  const document = sessionDocument({ context: { window: 200_000 }, rateLimits: [] }, null, null, "",
                                   NOW_MS);
  assert.ok(document);
  const absent = document.absent as string[];
  for (const name of ["costUsd", "durationMs", "remainingPercent", "fiveHourUsedPercent",
                      "weekResetsAt", "spendUsedPercent", "model", "version", "sessionId",
                      "linesAdded", "inputTokens"]) {
    assert.equal(absent.includes(name), true, name);
    assert.equal(name in document, false, name);
  }
  // A value of the wrong kind is absent too, not coerced.
  const odd = sessionDocument({ cost: { usd: "1" }, startedAt: NOW_MS + 5,
                                context: { percent: 140 } }, 3, "v", "", NOW_MS);
  assert.ok(odd);
  for (const name of ["costUsd", "durationMs", "remainingPercent", "model", "version"]) {
    assert.equal(name in odd, false, name);
  }
});

test("a usage that is not one leaves the reading's own document standing", () => {
  assert.equal(sessionDocument(null, "m", null, "", NOW_MS), null);
  assert.equal(sessionDocument("usage", "m", null, "", NOW_MS), null);
  const documents = { session: { state: "disabled" } };
  assert.equal(withSession(documents, null), documents);
  assert.equal(withSession(null, { state: "ready" }), null);
});

test("a routed session's priced spend stands over the host's table", () => {
  // The engine's cost is an Anthropic-table figure. On a session routed to
  // another provider it is not that provider's money, so the figure the status
  // line priced from the transcript is the one drawn.
  const reading = { session: { state: "ready", providerCostUsd: 0.0647,
                               costSource: "provider", errors: [] } };
  const engine = sessionDocument(USAGE, "deepseek-flash[1m]", null, "abc", NOW_MS);
  assert.ok(engine);
  const merged = withSession(reading, engine) as { session: Record<string, unknown> };
  assert.equal(merged.session.costUsd, 0.0647);
  assert.equal(merged.session.providerCostUsd, 0.0647);
  assert.equal(merged.session.costSource, "provider");
  // Every other engine figure still stands over the reading.
  assert.equal(merged.session.remainingPercent, engine.remainingPercent);
  // A reading carrying no priced figure leaves the engine's own cost alone.
  const plain = withSession({ session: { state: "ready", errors: [] } }, engine) as
    { session: Record<string, unknown> };
  assert.equal(plain.session.costUsd, 1.23);
});

test("a routed session's Cost card draws the reader's figure over the host's table", () => {
  // The document the pane draws can carry both figures: the host's, priced from
  // the Anthropic table, and the reader's, priced from the session's own
  // transcript. The provider's is the money this session spends, so it is the
  // one the Cost card and the section's heading state.
  const documents = readingWith({ costUsd: 149.52, providerCostUsd: 0.9659,
                                  costSource: "provider" });
  const lines = linesOf(documents);
  assert.equal(lines.includes("$149.52"), false, lines.join("\n"));
  const at = lines.indexOf("Cost (API)");
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], "$0.97");
  // The heading states the same figure, and the row says which pricing it is.
  assert.equal(lines.filter((line) => line === "$0.97").length >= 2, true, lines.join("\n"));
  assert.equal(lines.some((line) => line.includes("priced from the transcript")), true,
               lines.join("\n"));
});

test("a routed session priced before the engine answers draws what the reader priced", () => {
  // The reader can price a session before the engine has reported anything.
  // The Cost card then has no engine figure to fall back on and must not draw
  // the price it does hold as missing.
  const documents = withSession(readingWith({ providerCostUsd: 0.9659,
                                              costSource: "provider" }), null) as ReaderDocuments;
  const lines = linesOf(documents);
  const at = lines.indexOf("Cost (API)");
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], "$0.97");
});

test("the engine's table stands where the reader priced nothing", () => {
  // A hosted session is priced by the engine's table and the reader carries no
  // figure of its own, so the engine's is the one drawn.
  const documents = readingWith({ costUsd: 149.52, costSource: "host" });
  const lines = linesOf(documents);
  const at = lines.indexOf("Cost (API)");
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], "$149.52");
});

/** The reading the pane needs beside the engine's document, with this session's own spent. */
function readingWith(session: Record<string, unknown>): ReaderDocuments {
  return {
    roster: { state: "ready", providers: {}, jobs: [], sources: { jobs: "ready", interactive: "empty" },
              interactive: {} },
    trials: { state: "empty" }, progress: { state: "empty" }, prs: { state: "empty", prs: [], errors: [] },
    skills: { state: "empty" }, worktrees: { state: "empty" },
    session: { state: "ready", errors: [], ...session },
  } as ReaderDocuments;
}

function linesOf(documents: ReaderDocuments): string[] {
  const now = NOW_MS / 1000;
  const pane = paneFrom(snapshotFrom(documents, now), paneOptions(120, now, null));
  return renderedText(renderPane(pane, 120));
}

test("the machine's 24-hour spend is a card beside this session's cost", () => {
  const engine = sessionDocument(USAGE, "deepseek-flash[1m]", null, "abc", NOW_MS);
  assert.ok(engine);
  const merged = withSession(readingWith({ spendWindowUsd: 3.04, spendWindowFiles: 4,
                                           spendWindowSkipped: 1 }), engine) as ReaderDocuments;
  // The reader's window figure survives the engine's document replacing the payload's.
  assert.equal((merged.session as Record<string, unknown>).spendWindowUsd, 3.04);
  const lines = linesOf(merged);
  const at = lines.indexOf("24h routed");
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], "$3.04");
  assert.equal(lines.includes("$0.00"), false);
});

test("a machine spend nobody could price says so, never $0.00", () => {
  const engine = sessionDocument(USAGE, "deepseek-flash[1m]", null, "abc", NOW_MS);
  assert.ok(engine);
  const lines = linesOf(withSession(readingWith({}), engine) as ReaderDocuments);
  const at = lines.indexOf("24h routed");
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], "not reported");
  assert.equal(lines.includes("$0.00"), false);
});

test("the section draws the engine's figures where it drew nothing before", () => {
  const reading = {
    roster: { state: "ready", providers: {}, jobs: [], sources: { jobs: "ready", interactive: "empty" },
              interactive: {} },
    trials: { state: "empty" }, progress: { state: "empty" }, prs: { state: "empty", prs: [], errors: [] },
    skills: { state: "empty" }, worktrees: { state: "empty" },
    session: { state: "disabled", errors: [] },
  };
  const engine = sessionDocument(USAGE, "claude-opus-5-5", { version: "2.1.296" }, "abc", NOW_MS);
  const merged = withSession(reading, engine) as ReaderDocuments;
  const now = NOW_MS / 1000;
  const pane = paneFrom(snapshotFrom(merged, now), paneOptions(120, now, null));
  const text = renderedText(renderPane(pane, 120)).join("\n");
  assert.equal(text.includes("$1.23"), true);
  // The model is said the way a person says it, once.
  assert.equal(text.includes("opus 5.5"), true);
  assert.equal(text.includes("claude-opus-5-5"), false);
});

const CODEX_LIMITS = {
  state: "ready",
  provider: "codex",
  windows: [
    { name: "primary", usedPercent: 100, windowMinutes: 300, resetsAt: 1_792_270_988 },
    { name: "secondary", usedPercent: 47, windowMinutes: 10080, resetsAt: 1_792_821_767 },
  ],
  credits: 60_924.34,
};

function codexReading(limits: unknown): ReaderDocuments {
  return {
    roster: { state: "ready", providers: {}, jobs: [],
              sources: { jobs: "ready", interactive: "empty" }, interactive: {} },
    trials: { state: "empty" }, progress: { state: "empty" },
    prs: { state: "empty", prs: [], errors: [] },
    skills: { state: "empty" }, worktrees: { state: "empty" },
    session: { state: "ready", errors: [], limits },
  } as ReaderDocuments;
}

test("a codex session's own windows fill the subscription rows the pane draws", () => {
  // The engine reports no rate limits on a Codex session. The reader's rollout
  // windows are what a person is metered by, so they fill the same rows and
  // tiles the Claude subscription session uses.
  const engine = sessionDocument({ cost: { usd: 0 } }, "gpt-5-codex", null, "abc", NOW_MS);
  const merged = withSession(codexReading(CODEX_LIMITS), engine) as
    { session: Record<string, unknown> };
  assert.equal(merged.session.fiveHourUsedPercent, 100);
  assert.equal(merged.session.fiveHourResetsAt, 1_792_270_988);
  assert.equal(merged.session.sevenDayUsedPercent, 47);
  assert.equal(merged.session.weekResetsAt, 1_792_821_767);
  const now = NOW_MS / 1000;
  const text = renderedText(renderPane(
    paneFrom(snapshotFrom(merged as ReaderDocuments, now), paneOptions(120, now, null)), 120))
    .join("\n");
  assert.equal(text.includes("Five-hour window"), true);
  assert.equal(text.includes("100% used"), true);
  assert.equal(text.includes("Weekly window"), true);
  assert.equal(text.includes("47% used"), true);
  // The reset travels with each window.
  assert.equal(text.includes("resets in"), true);
});

const CLAUDE_LIMITS = {
  state: "ready",
  provider: "claude",
  windows: [
    { name: "five_hour", usedPercent: 20, windowMinutes: 300, resetsAt: 1_792_281_600 },
    { name: "weekly", usedPercent: 95, windowMinutes: 10080, resetsAt: 1_792_393_200 },
  ],
};

test("a claude session with no windows in its payload takes the account's own", () => {
  // The engine reports no rate limits on a routed Claude session, and the
  // reader fills them from the file the status line writes for the account.
  const engine = sessionDocument({ cost: { usd: 0 } }, "claude-opus-5-5", null, "abc", NOW_MS);
  const merged = withSession(codexReading(CLAUDE_LIMITS), engine) as
    { session: Record<string, unknown> };
  assert.equal(merged.session.fiveHourUsedPercent, 20);
  assert.equal(merged.session.fiveHourResetsAt, 1_792_281_600);
  assert.equal(merged.session.sevenDayUsedPercent, 95);
  assert.equal(merged.session.weekResetsAt, 1_792_393_200);
});

test("a session without codex limits draws no window rows", () => {
  // A DeepSeek or Claude session never shows Codex's windows, and an
  // unavailable rollout reading is not a set of noughts to draw.
  for (const limits of [null, { state: "unavailable", errors: [] },
                        { state: "ready", provider: "deepseek",
                          windows: [{ usedPercent: 47, windowMinutes: 10080 }] }]) {
    const engine = sessionDocument({ cost: { usd: 1.23 } }, "deepseek-flash[1m]", null, "", NOW_MS);
    const merged = withSession(codexReading(limits), engine) as
      { session: Record<string, unknown> };
    for (const name of ["fiveHourUsedPercent", "fiveHourResetsAt", "sevenDayUsedPercent",
                        "weekResetsAt"]) {
      assert.equal(name in merged.session, false, name);
    }
    const now = NOW_MS / 1000;
    const text = renderedText(renderPane(
      paneFrom(snapshotFrom(merged as ReaderDocuments, now), paneOptions(120, now, null)), 120))
      .join("\n");
    assert.equal(text.includes("Five-hour window"), false);
    assert.equal(text.includes("Weekly window"), false);
  }
});

test("a window of another length is left out rather than mislabeled", () => {
  const engine = sessionDocument({ cost: { usd: 0 } }, "gpt-5-codex", null, "", NOW_MS);
  const merged = withSession(codexReading({
    state: "ready", provider: "codex",
    windows: [{ name: "primary", usedPercent: 42, windowMinutes: 1440, resetsAt: 5 }],
  }), engine) as { session: Record<string, unknown> };
  assert.equal("fiveHourUsedPercent" in merged.session, false);
  assert.equal("sevenDayUsedPercent" in merged.session, false);
});
