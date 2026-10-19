/**
 * Statusline composition, including every case where a figure is missing.
 *
 * The composer is pure, so these cases read the lines it returns as text. The
 * cases that matter most are the honest ones: a field the host did not send is
 * never drawn as a zero, the token fill is the count that arrived rather than a
 * reconstruction, a negative saving is not drawn as a saving, and a failed read
 * is never rendered as an empty session.
 *
 * Run with: node --test plugins/llm-fleet/components/statusline.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  clockText,
  composeLines,
  contextLine,
  costLine,
  identityLine,
  moneyText,
  renderedLines,
  tokenText,
  type StatuslineInput,
} from "../plugins/llm-fleet/components/statusline.ts";

const NOW = 1790000000;

function input(overrides: Partial<StatuslineInput> = {}): StatuslineInput {
  return {
    host: {
      state: "ready",
      session: { id: "abc", name: "statusline", cwd: "/tmp/project", version: "2.1.105" },
      model: { id: "claude-opus-4-6[1m]", displayName: "Opus 4.6 (1M context)" },
      cost: { totalCostUsd: 12.5, durationMs: 7_200_000, apiDurationMs: 900_000 },
      context: { inputTokens: 902_437, windowSize: 1_000_000 },
      rateLimits: { fiveHour: { usedPercent: 41.5 }, sevenDay: { usedPercent: 12 } },
      promptCache: { warm: true },
      effort: { level: "high" },
    },
    transcript: { state: "ready", records: 40, savedUsd: 7.99, savedTokens: 1_597_000 },
    branch: "task/statusline-core",
    project: "llm-fleet-private",
    width: 120,
    now: NOW,
    ...overrides,
  };
}

function textOf(slots: { text: string }[]): string {
  return slots.map((slot) => slot.text).join(" ");
}

test("the three lines carry what a session is", () => {
  const lines = renderedLines(input());
  assert.equal(lines.length, 3);
  // The clock is the host's local time, so the expectation takes it from the same
  // formatter. Hard coding it here passed on one machine and failed in CI, which
  // runs in UTC.
  assert.equal(lines[0], clockText(NOW) + " statusline Opus 4.6 (1M context) high 2.1.105 "
                        + "llm-fleet-private task/statusline-core");
  assert.equal(lines[1], "CTX: #########- (902K/1M) cache ~$7.99/ses pc: warm");
  assert.equal(lines[2], "COST: ~$12.50 at ~$50.00/h 5h 42% wk 12%");
});

test("the token fill is the count that arrived, not a reconstruction", () => {
  const line = textOf(contextLine(input()));
  assert.equal(line.includes("902K/1M"), true);
  // Deriving the fill from a percentage would print 903K and disagree with the
  // payload, which is the rounding bug the original carried for months.
  assert.equal(line.includes("903K"), false);
  const bar = line.split(" ")[1];
  assert.equal(bar.length, 10);
  assert.equal(bar.startsWith("#"), true);
});

test("a session named after its own project is not shown twice", () => {
  const named = input({ project: "llm-fleet-private" });
  named.host.session = { name: "LLM-Fleet-Private", version: "2.1.105" };
  const line = textOf(identityLine(named));
  assert.equal(line.includes("LLM-Fleet-Private"), false);
  assert.equal(line.includes("llm-fleet-private"), true);

  const other = input();
  other.host.session = { name: "unrelated session", version: "2.1.105" };
  assert.equal(textOf(identityLine(other)).includes("unrelated session"), true);
});

test("a session name carrying an identifier is masked", () => {
  const carried = input();
  carried.host.session = { name: "Secure Transaction Key for the MID behind org_300382" };
  const line = textOf(identityLine(carried));
  assert.equal(line.includes("org_300382"), false);
  assert.equal(line.includes("[masked]"), true);
});

test("an absent model is named rather than left blank", () => {
  const bare = input();
  bare.host.model = {};
  assert.equal(textOf(identityLine(bare)).includes("model unknown"), true);
});

test("a window the host did not send draws no bar and says so", () => {
  const unknown = input();
  unknown.host.context = { inputTokens: 902_437 };
  const line = textOf(contextLine(unknown));
  assert.equal(line.includes("window unknown"), true);
  assert.equal(line.includes("#"), false);
  assert.equal(line.includes("902K"), false);
});

test("a fill the host did not send is named while the window stays", () => {
  const partial = input();
  partial.host.context = { windowSize: 1_000_000 };
  const line = textOf(contextLine(partial));
  assert.equal(line.includes("fill unknown"), true);
  assert.equal(line.includes("1M"), true);
});

test("a saving of nothing is not drawn, and a negative one is not drawn either", () => {
  for (const savedUsd of [0, -1.25]) {
    const cold = input();
    cold.transcript = { state: "ready", records: 4, savedUsd };
    assert.equal(textOf(contextLine(cold)).includes("cache"), false, String(savedUsd));
  }
  const warmed = input();
  warmed.transcript = { state: "ready", records: 4, savedUsd: 0.004 };
  assert.equal(textOf(contextLine(warmed)).includes("~<$0.01/ses"), true);
});

test("an unread transcript leaves the cache segment out and says why", () => {
  const missing = input();
  missing.transcript = { state: "unavailable", reason: "the transcript is not there" };
  const line = textOf(contextLine(missing));
  assert.equal(line.includes("cache"), false);
  assert.equal(textOf(costLine(missing)).includes("economics unavailable"), true);
});

test("a truncated transcript is marked rather than read as a complete session", () => {
  const cut = input();
  cut.transcript = { state: "ready", records: 4, savedUsd: 2.5, truncated: true };
  assert.equal(textOf(contextLine(cut)).includes("cache partial"), true);
});

test("damaged records are reported on the line that carries the session's numbers", () => {
  const damaged = input();
  damaged.transcript = { state: "ready", records: 4, savedUsd: 1, damagedRecords: 2 };
  assert.equal(textOf(costLine(damaged)).includes("2 damaged"), true);
});

test("a cost the host did not send is unknown rather than zero", () => {
  const nothing = input();
  nothing.host.cost = {};
  const line = textOf(costLine(nothing));
  assert.equal(line.includes("unknown"), true);
  assert.equal(line.includes("$0.00"), false);
});

test("the rate is priced against API time, not wall clock", () => {
  const idle = input();
  idle.host.cost = { totalCostUsd: 12.5, durationMs: 7_200_000, apiDurationMs: 900_000 };
  assert.equal(textOf(costLine(idle)).includes("~$50.00/h"), true);
  const same = input();
  same.host.cost = { totalCostUsd: 12.5, durationMs: 900_000, apiDurationMs: 900_000 };
  assert.equal(textOf(costLine(same)).includes("~$50.00/h"), true);
});

test("a rate limit the host did not send draws no percentage", () => {
  const none = input();
  none.host.rateLimits = {};
  const line = textOf(costLine(none));
  assert.equal(line.includes("5h"), false);
  assert.equal(line.includes("wk"), false);
  assert.equal(line.includes("0%"), false);
});

test("a failed host payload is one line naming the failure", () => {
  const failed = input();
  failed.host = { state: "failed", reason: "JSONDecodeError" };
  const lines = renderedLines(failed);
  assert.equal(lines[0].includes("failed to read"), true);
  assert.equal(lines[0].includes("JSONDecodeError"), true);
  // It is never rendered as an empty session, which is the claim to avoid.
  assert.equal(lines[0].includes("no session"), false);
});

test("a host that sent nothing is not a failed read", () => {
  const empty = input();
  empty.host = { state: "empty" };
  const lines = renderedLines(empty);
  assert.equal(lines[0].includes("the host sent no session"), true);
  assert.equal(lines[0].includes("failed"), false);
});

test("a line wider than the host allows is cut and the cut is marked", () => {
  const narrow = input({ width: 40 });
  const lines = renderedLines(narrow);
  for (const line of lines) {
    assert.equal(line.length <= 40, true, line);
  }
  assert.equal(lines[0].endsWith("..."), true);
});

test("a narrow host halves the bar rather than dropping the reading", () => {
  const narrow = input({ width: 60 });
  const line = textOf(contextLine(narrow));
  assert.equal(line.split(" ")[1].length, 5);
  assert.equal(line.includes("902K/1M"), true);
});

test("the narrow host drops the version and the rate, not the figures", () => {
  const narrow = input({ width: 60 });
  const lines = renderedLines(narrow);
  assert.equal(lines[0].includes("2.1.105"), false);
  assert.equal(lines[2].includes("/h"), false);
  assert.equal(lines[1].includes("902K/1M"), true);
});

test("every line is slots, so a host can draw it", () => {
  const lines = composeLines(input());
  assert.equal(lines.length, 3);
  for (const slots of lines) {
    assert.equal(Array.isArray(slots), true);
    assert.equal(slots.length > 0, true);
    for (const slot of slots) {
      assert.equal(typeof slot.text, "string");
      assert.equal(slot.text.length > 0, true);
    }
  }
});

test("the small formatters round once and mark what they round", () => {
  assert.equal(tokenText(902_437), "902K");
  assert.equal(tokenText(1_000_000), "1M");
  assert.equal(tokenText(1_250_000), "1.3M");
  assert.equal(tokenText(999), "999");
  assert.equal(tokenText(-250_000), "-250K");
  assert.equal(moneyText(7.985), "~$7.99");
  assert.equal(moneyText(0.004), "~<$0.01");
  assert.equal(moneyText(-1.25), "~$-1.25");
  assert.equal(clockText(NOW).length, 5);
  assert.equal(clockText(NOW)[2], ":");
  assert.equal(/^\d\d:\d\d$/.test(clockText(NOW)), true);
});

test("the clock is the host's local time and pads both fields", () => {
  // Pinned in a child process, because the zone is a property of the process and
  // not of the formatter. 1790000000 is 14:13 UTC and 10:13 in New York.
  const at = (zone: string): string => {
    // Named by this file's own place, so moving the suite cannot leave it
    // pointing at a path that no longer exists. No TypeScript flag: this mirrors
    // how the suite itself runs a .ts file.
    const module = new URL("../plugins/llm-fleet/components/statusline.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["-e",
      `import(${JSON.stringify(module)}).then((m) => process.stdout.write(m.clockText(1790000000)));`],
      { env: { ...process.env, TZ: zone }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(at("UTC"), "14:13");
  assert.equal(at("America/New_York"), "10:13");
});
