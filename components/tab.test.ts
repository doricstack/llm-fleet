/**
 * The tab color and the key tip, without the engine.
 *
 * The level a band's items put the tab at, which terminals are told anything,
 * the helper's words, and when this session tells the helper its level: when
 * it moves, every third of the staleness while held, keeping the entry alive
 * without painting once a level was given up on, one run at a time; then the
 * key tip's rotation and `/keys`'s words. The tab's shared record and its
 * colors are the helper's, tested in tests/test_reader_tab.py.
 *
 * Run with: node --test components/tab.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { afterSend, endNeeded, levelWord, nextSend, passesThrough, serially, tabArgs, tabLevel,
         tabSender, tabTerminal, TINT_DEFAULTS, tintFrom } from "../plugins/llm-fleet/components/tab.ts";
import { KEYS_USAGE, keysRequest, tipAt, tipsShown, withTip } from "../plugins/llm-fleet/components/tips.ts";

test("a failure outranks a wait, and a band with nothing in it is the tab's own color", () => {
  assert.equal(tabLevel([]), null);
  assert.equal(tabLevel([{ level: "warning" }]), "waiting");
  assert.equal(tabLevel([{ level: "warning" }, { level: "error" }]), "failure");
  assert.equal(tabLevel([{ level: "error" }]), "failure");
});

test("a tint a reading carries is taken part by part, and a part that is not usable is the default", () => {
  assert.deepEqual(tintFrom(undefined), TINT_DEFAULTS);
  assert.deepEqual(tintFrom([1, 2, 3]), TINT_DEFAULTS);
  assert.deepEqual(tintFrom({ enabled: "yes" }), TINT_DEFAULTS);
  assert.deepEqual(tintFrom({ enabled: false, failureRgb: [0, 0, 255] }),
                   { enabled: false, staleSeconds: 120 });
  assert.equal(tintFrom({ staleSeconds: 30 }).staleSeconds, 30);
  for (const stale of [0, -5, 1.5, 29, "60", null]) {
    assert.equal(tintFrom({ staleSeconds: stale }).staleSeconds, 120, String(stale));
  }
});

test("only iTerm draws a tab color, and inside tmux only where tmux passes it through", () => {
  assert.deepEqual(tabTerminal({ termProgram: "iTerm.app" }, false), { supported: true, tmux: false });
  assert.deepEqual(tabTerminal({ lcTerminal: "iTerm2" }, false), { supported: true, tmux: false });
  assert.deepEqual(tabTerminal({ termProgram: "Apple_Terminal" }, true), { supported: false, tmux: false });
  assert.deepEqual(tabTerminal({}, true), { supported: false, tmux: false });
  const inTmux = { termProgram: "tmux", lcTerminal: "iTerm2", tmux: "/tmp/tmux-1/default,1,0" };
  assert.deepEqual(tabTerminal(inTmux, false), { supported: false, tmux: true });
  assert.deepEqual(tabTerminal(inTmux, true), { supported: true, tmux: true });
  // tmux around another terminal is unsupported whatever tmux passes.
  assert.deepEqual(tabTerminal({ termProgram: "tmux", tmux: "/tmp/t,1,0" }, true),
                   { supported: false, tmux: true });
  assert.deepEqual(tabTerminal({ termProgram: "iTerm.app", tmux: "" }, false),
                   { supported: true, tmux: false });
});

test("tmux passes escapes through when allow-passthrough is on or all", () => {
  assert.equal(passesThrough("on\n"), true);
  assert.equal(passesThrough("all"), true);
  assert.equal(passesThrough("off\n"), false);
  assert.equal(passesThrough(""), false);
});

test("the helper's words say the level or the end, keep the entry only when asked, and say tmux when it wraps", () => {
  const plain = { supported: true, tmux: false };
  const wrapped = { supported: true, tmux: true };
  assert.equal(levelWord("failure"), "failed");
  assert.equal(levelWord("waiting"), "waiting");
  assert.equal(levelWord(null), "none");
  assert.deepEqual(tabArgs("set", "iterm:t", "s1", "failure", plain),
                   ["set", "--tab", "iterm:t", "--session", "s1", "--level", "failed"]);
  assert.deepEqual(tabArgs("set", "iterm:t", "s1", "waiting", wrapped, true),
                   ["set", "--tab", "iterm:t", "--session", "s1", "--level", "waiting",
                    "--record-only", "--tmux"]);
  assert.deepEqual(tabArgs("end", "tmux:/dev/ttys004", "s1", "failure", wrapped),
                   ["end", "--tab", "tmux:/dev/ttys004", "--session", "s1", "--tmux"]);
});

test("a session with tinting on says none as it starts, one with it off says nothing, and a new level is told at once", () => {
  assert.equal(nextSend(tabSender(), null, 1000, 120, true), "paint");
  assert.equal(nextSend(tabSender(), null, 1000, 120, false), null);
  const sender = tabSender();
  assert.equal(nextSend(sender, "waiting", 1000, 120), "paint");
  afterSend(sender, "waiting", 1000, "paint", true);
  assert.equal(nextSend(sender, "waiting", 1001, 120), null);
  assert.equal(nextSend(sender, "failure", 1001, 120), "paint");
  assert.equal(nextSend(sender, null, 1001, 120), "paint");
});

test("a held level is told again once a third of the staleness has passed, and none is a heartbeat only while tinting is on", () => {
  const sender = tabSender();
  afterSend(sender, "failure", 1000, "paint", true);
  assert.equal(nextSend(sender, "failure", 1039, 120), null);
  assert.equal(nextSend(sender, "failure", 1040, 120), "paint");
  assert.equal(nextSend(sender, "failure", 1010, 30), "paint");
  // A session at none says so every third of the staleness, so the helper
  // prunes a failure whose session is gone; with tinting off it says nothing.
  afterSend(sender, null, 1000, "paint", true);
  assert.equal(nextSend(sender, null, 1039, 120, true), null);
  assert.equal(nextSend(sender, null, 1040, 120, true), "paint");
  assert.equal(nextSend(sender, null, 5000, 120, false), null);
});

test("two failed paints of one level give it up: the retelling keeps the entry alive and paints nothing", () => {
  const sender = tabSender();
  afterSend(sender, "failure", 1000, "paint", false);
  assert.equal(sender.failures, 1);
  afterSend(sender, "failure", 1000, "paint", false);
  assert.equal(sender.failures, 2);
  assert.equal(nextSend(sender, "failure", 1020, 120), null);
  assert.equal(nextSend(sender, "failure", 1040, 120), "record");
  // A record-only run that lands paints nothing, so it gives nothing back.
  afterSend(sender, "failure", 1040, "record", true);
  assert.equal(sender.failures, 2);
  assert.equal(sender.at, 1040);
  assert.equal(nextSend(sender, "failure", 1080, 120), "record");
  // A new level starts again, and a paint that lands clears the count.
  assert.equal(nextSend(sender, "waiting", 1041, 120), "paint");
  afterSend(sender, "waiting", 1041, "paint", false);
  assert.equal(sender.failures, 1);
  afterSend(sender, "waiting", 1041, "paint", true);
  assert.equal(sender.failures, 0);
});

test("an end is told for an entry held or a clear that failed, and not for a session that held nothing", () => {
  const sender = tabSender();
  assert.equal(endNeeded(sender), false);
  afterSend(sender, "failure", 1000, "paint", false);
  afterSend(sender, "failure", 1000, "paint", false);
  assert.equal(endNeeded(sender), true);
  afterSend(sender, null, 1001, "paint", true);
  assert.equal(endNeeded(sender), false);
  afterSend(sender, "waiting", 1002, "paint", true);
  afterSend(sender, null, 1003, "paint", false);
  assert.equal(endNeeded(sender), true);
});

test("turns run one at a time, in the order they were asked for, and a turn that throws stops none", async () => {
  const sender = tabSender();
  const order: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = serially(sender, async () => { order.push("first in"); await gate; order.push("first out"); });
  const broken = serially(sender, async () => { order.push("broken"); throw new Error("no helper"); });
  const second = serially(sender, async () => { order.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first in"]);
  release();
  await Promise.all([first, broken, second]);
  assert.deepEqual(order, ["first in", "first out", "broken", "second"]);
});

test("/keys takes nothing, or tips off, or tips on, and nothing else", () => {
  assert.equal(keysRequest(""), "open");
  assert.equal(keysRequest("   "), "open");
  assert.deepEqual(keysRequest("tips off"), { tips: false });
  assert.deepEqual(keysRequest("  tips   on "), { tips: true });
  for (const words of ["tips", "tips maybe", "on", "tips on off", "Tips on"]) {
    assert.equal(keysRequest(words), null, words);
  }
  assert.match(KEYS_USAGE, /\/keys tips off\|on/);
});

test("tips show when the configuration allows them and the person has not turned them off", () => {
  assert.equal(tipsShown(true, undefined), true);
  assert.equal(tipsShown(true, true), true);
  assert.equal(tipsShown(true, "off"), true);
  assert.equal(tipsShown(true, false), false);
  assert.equal(tipsShown(false, true), false);
});

test("the tip rotates through the list and never lands past its end", () => {
  const tips = ["a", "b", "c"];
  assert.equal(tipAt(tips, 0), "a");
  assert.equal(tipAt(tips, 1), "b");
  assert.equal(tipAt(tips, 3), "a");
  assert.equal(tipAt(tips, 7), "b");
  assert.equal(tipAt(tips, -1), "c");
  assert.equal(tipAt([], 4), null);
  assert.equal(withTip(undefined, "a"), "  a");
  assert.equal(withTip("pill", "a"), "pill  a");
});
