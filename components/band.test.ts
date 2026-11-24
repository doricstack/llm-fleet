/**
 * The band above the prompt: the switch it always draws, and the figures it
 * makes a way into the pane.
 *
 * The cases read a snapshot assembled the way the plugin assembles one, from
 * documents shaped as the readers print them, so a figure is proved against
 * the same fields the pane reads. The item list is still built for the tab's
 * color, which is why bandItems has cases here without the band drawing one.
 *
 * Run with: node --test components/band.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BAND_DEFAULTS, BAND_FOCUS, BAND_PACER, BAND_SPEAK, BAND_TOGGLE,
         bandConfigFrom, bandCounts, bandItems, bandTree, fleetLabel,
         isOwnJob, speakLabel } from "../plugins/llm-fleet/components/band.ts";
import { renderedText } from "../plugins/llm-fleet/components/layout.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/llm-fleet/components/snapshot.ts";
import type { Node } from "../plugins/llm-fleet/components/host.ts";
import { nodeLines } from "./review.ts";

const AT = 1_790_000_000;

function job(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { provider: "one", id, name: "Job " + id, state, label: state, started_at: AT - 600,
           last_seen_at: AT - 5, folder: "/tmp/p", ...extra };
}

function reading(overrides: Record<string, unknown> = {}): ReaderDocuments {
  return {
    roster: { state: "ready", providers: { one: { state: "ready", jobs: 3 } },
              jobs: [job("aaaa1111", "working"), job("bbbb2222", "blocked", { since: AT - 120 }),
                     job("cccc3333", "blocked", { since: AT - 60 })],
              sources: { jobs: "ready", interactive: "empty" }, interactive: {} },
    pacer: { state: "ready", slots: [], waiting: [], outside: [], outsideCount: 0, recent: [
      { at: AT - 30, repo: "example-repo", waitSeconds: 0, runSeconds: 4, exit: 1, slot: 0,
        mode: "on", reason: null },
      { at: AT - 20, repo: "example-repo", waitSeconds: 0, runSeconds: 2, exit: 0, slot: 1,
        mode: "on", reason: null },
    ] },
    prs: { state: "ready", prs: [
      { repo: "owner/project", number: 7, title: "Fix it", branch: "fix", head: "abc",
        is_draft: false, checks: "fail" },
      { repo: "owner/project", number: 8, title: "Fine", branch: "fine", head: "def",
        is_draft: false, checks: "pass" },
    ] },
    skills: { state: "empty" },
    worktrees: { state: "empty" },
    ...overrides,
  } as unknown as ReaderDocuments;
}

function nodesIn(tree: Node): Node[] {
  const found: Node[] = [tree];
  for (const child of tree.children) {
    if (typeof child !== "string") {
      found.push(...nodesIn(child));
    }
  }
  return found;
}

const noop = () => undefined;

test("errors lead the band, then the sessions waiting on a person", () => {
  const items = bandItems(snapshotFrom(reading(), AT), [], "");
  assert.deepEqual(items.map((item) => item.level), ["error", "warning", "warning"]);
  assert.equal(items[0]?.text, "PR 7 checks failing: Fix it");
  assert.equal(items[1]?.text, "Job bbbb2222 is waiting for you");
  // A run that failed inside a slot said so where it ran. The band does not
  // repeat it: it was a line nobody acted on and everybody dismissed.
  assert.equal(items.some((item) => item.text.startsWith("Run failed")), false);
  // A passing run, a passing PR and a working session need nobody.
  assert.equal(items.some((item) => item.text.includes("slot 1")), false);
  assert.equal(items.some((item) => item.text.includes("Fine")), false);
  assert.equal(items.some((item) => item.text.includes("aaaa1111")), false);
});

test("this session's own job and what was dismissed are left out", () => {
  const snapshot = snapshotFrom(reading(), AT);
  const own = bandItems(snapshot, [], "bbbb2222-rest-of-the-session-id");
  assert.equal(own.some((item) => item.text.includes("bbbb2222")), false);
  assert.equal(own.some((item) => item.text.includes("cccc3333")), true);
  const keys = bandItems(snapshot, [], "").map((item) => item.key);
  const left = bandItems(snapshot, keys.slice(0, 2), "");
  assert.deepEqual(left.map((item) => item.key), keys.slice(2));
});

test("a session that waits a second time is a new item, not a dismissed one", () => {
  const first = bandItems(snapshotFrom(reading(), AT), [], "");
  const dismissed = first.map((item) => item.key);
  const again = reading({
    roster: { state: "ready", providers: {}, interactive: {},
              sources: { jobs: "ready", interactive: "empty" },
              jobs: [job("bbbb2222", "blocked", { since: AT + 300 })] },
  });
  const items = bandItems(snapshotFrom(again, AT + 400), dismissed, "");
  assert.deepEqual(items.map((item) => item.text), ["Job bbbb2222 is waiting for you"]);
});

function skill(name: string, verdict: string, extra: Record<string, unknown> = {}) {
  return { name, target: "~/skills/" + name, verdict, score: null, hash: "h-" + name,
           issue: "reads " + name + " secrets", ...extra };
}

test("a newly flagged skill is an error on the band, and one to read or a failed scan a wait", () => {
  const items = bandItems(snapshotFrom(reading({
    skills: { state: "ready", counts: {},
              new: [skill("alpha", "flagged"), skill("beta", "review"), skill("gamma", "failed")] },
  }), AT), [], "");
  const skills = items.filter((item) => item.key.startsWith("skill:"));
  assert.deepEqual(skills, [
    { key: "skill:~/skills/alpha:flagged:h-alpha", level: "error",
      text: "Skill flagged: alpha, reads alpha secrets" },
    { key: "skill:~/skills/beta:review:h-beta", level: "warning",
      text: "Skill to read: beta, reads beta secrets" },
    { key: "skill:~/skills/gamma:failed:h-gamma", level: "warning",
      text: "Skill scan could not finish: gamma" },
  ]);
  // Errors still lead, waits follow: the flagged skill sits among the errors.
  const levels = items.map((item) => item.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)));
  // A finding already in the list but not new is the pane's, not the band's.
  const old = bandItems(snapshotFrom(reading({
    skills: { state: "ready", counts: {}, new: [], items: [skill("delta", "flagged")] },
  }), AT), [], "");
  assert.equal(old.some((item) => item.key.startsWith("skill:")), false);
});

/** A key of the shape the masking refuses, built in parts so no file holds one whole. */
const SKILL_KEY = ["sk-", "ant-", "api03-", "B".repeat(24)].join("");

test("the band raises only a finding in his own skills", () => {
  // A plugin tree is other people's code: a row there is the pane's to show and
  // not the band's to interrupt for. A reading written before rows carried a
  // scope is his, because there was nothing else for it to be.
  const items = bandItems(snapshotFrom(reading({
    skills: { state: "ready", counts: {}, new: [
      skill("mine", "flagged"),
      skill("theirs", "flagged", { scope: "installed" }),
      skill("theirs-too", "review", { scope: "other" }),
      skill("older", "flagged"),
    ] },
  }), AT), [], "");
  assert.deepEqual(items.filter((item) => item.key.startsWith("skill:"))
                     .map((item) => item.text),
                   ["Skill flagged: mine, reads mine secrets",
                    "Skill flagged: older, reads older secrets"]);
});

test("a skill's finding is masked on the band as it is on the pane", () => {
  const items = bandItems(snapshotFrom(reading({
    skills: { state: "ready", counts: {},
              new: [skill("alpha", "flagged", { issue: "posts " + SKILL_KEY })] },
  }), AT), [], "");
  const flagged = items.find((item) => item.key.startsWith("skill:"))?.text ?? "";
  assert.equal(flagged.includes("posts"), true, flagged);
  assert.equal(flagged.includes(SKILL_KEY), false, flagged);
});

test("a pacer run it refused is an error on the band; one that failed on its own is not", () => {
  const run = (repo: string | null, exit: number, mode: string, at: number,
               reason: string | null = null) =>
    ({ at, repo, waitSeconds: 0, runSeconds: 1, exit, slot: 0, mode, reason });
  const items = bandItems(snapshotFrom(reading({
    pacer: { state: "ready", enabled: true, slotCount: 4, slots: [], errors: [], recent: [
      run("web-app", 75, "refused", AT - 60, "memory pressure"),
      // A command that failed inside a slot is the pane's row, not a line the
      // band raises: dismissing it changed nothing, so nothing is raised.
      run("fleet", 2, "on", AT - 120),
      run("fine", 0, "on", AT - 30),
      run("unpaced", 1, "off", AT - 10),
      run("stopped", 130, "interrupted", AT - 5),
      run(null, 3, "on", AT - 1)] },
  }), AT), [], "");
  const pacer = items.filter((item) => item.key.startsWith("pacer:"));
  assert.deepEqual(pacer.map((item) => item.text),
                   ["Pacer refused a run in web-app: memory pressure"]);
  assert.deepEqual(pacer.map((item) => item.level), ["error"]);
  assert.deepEqual(pacer.map((item) => item.key), ["pacer:web-app:memory pressure"]);
  // A refusal pacer could not tie to a repository still says where it happened.
  const unnamed = bandItems(snapshotFrom(reading({
    pacer: { state: "ready", enabled: true, slotCount: 4, slots: [], errors: [],
             recent: [run(null, 75, "refused", AT - 1)] } }), AT), [], "");
  assert.deepEqual(unnamed.filter((item) => item.key.startsWith("pacer:")).map((item) => item.text),
                   ["Pacer refused a run in a repository"]);
  // A reading from before pacer was read has not heard from it, and raises
  // nothing for it.
  const older = snapshotFrom(reading(), AT);
  delete (older as { pacer?: unknown }).pacer;
  // A pacer that has not reported its runs raises nothing.
  const quiet = bandItems(snapshotFrom(reading({
    pacer: { state: "ready", enabled: true, slotCount: 4, slots: [], errors: [] } }), AT), [], "");
  assert.equal(quiet.some((item) => item.key.startsWith("pacer:")), false);
});

test("a refusal that repeats is one item, and one dismissal holds for all of it", () => {
  const run = (repo: string | null, at: number, reason: string | null) =>
    ({ at, repo, waitSeconds: 0, runSeconds: 1, exit: 75, slot: null, mode: "refused",
       reason });
  const repeated = snapshotFrom(reading({
    pacer: { state: "ready", enabled: true, slotCount: 4, slots: [], errors: [], recent: [
      run("web-app", AT - 30, "memory pressure"),
      run("web-app", AT - 60, "memory pressure"),
      run("web-app", AT - 90, "no slot free"),
      run("fleet", AT - 120, "memory pressure")] },
  }), AT);
  const items = bandItems(repeated, [], "").filter((item) => item.key.startsWith("pacer:"));
  // Two refusals of the same repository and reason are one line, and it says
  // how often: a person reads it once rather than twice.
  assert.deepEqual(items.map((item) => item.text), [
    "Pacer refused 2 runs in web-app: memory pressure",
    "Pacer refused a run in web-app: no slot free",
    "Pacer refused a run in fleet: memory pressure",
  ]);
  // Newest first, so the line that just happened is the one on top.
  assert.deepEqual(items.map((item) => item.key), [
    "pacer:web-app:memory pressure", "pacer:web-app:no slot free", "pacer:fleet:memory pressure",
  ]);
  // Dismissing the repeat takes the whole repeat with it, including a refusal
  // that lands after the dismissal: the key is the condition, not the run.
  const dismissed = bandItems(repeated, ["pacer:web-app:memory pressure"], "")
    .filter((item) => item.key.startsWith("pacer:"));
  assert.deepEqual(dismissed.map((item) => item.key),
                   ["pacer:web-app:no slot free", "pacer:fleet:memory pressure"]);
  // A different reason is a different item, and is not dismissed with it.
  const changed = snapshotFrom(reading({
    pacer: { state: "ready", enabled: true, slotCount: 4, slots: [], errors: [],
             recent: [run("web-app", AT - 10, "no slot free")] } }), AT);
  assert.deepEqual(bandItems(changed, ["pacer:web-app:memory pressure"], "")
    .filter((item) => item.key.startsWith("pacer:")).map((item) => item.text),
                   ["Pacer refused a run in web-app: no slot free"]);
});

test("a job that has waited past the configured span is left to the pane", () => {
  const snapshot = snapshotFrom(reading({
    roster: { state: "ready", providers: {}, interactive: {},
              sources: { jobs: "ready", interactive: "empty" },
              jobs: [job("recent", "blocked", { since: AT - 100 }),
                     job("edge", "blocked", { since: AT - 600 }),
                     job("parked", "blocked", { since: AT - 601 }),
                     job("undated", "blocked", { since: null })] },
  }), AT);
  const shown = (settings?: Parameters<typeof bandItems>[3]) =>
    bandItems(snapshot, [], "", settings).filter((item) => item.key.startsWith("job:"))
      .map((item) => item.text);
  // A job with no date cannot be shown to be parked, so it stays: a person
  // not told that a job waits is the worse fault.
  assert.deepEqual(shown({ waitingJobSeconds: 600, hiddenLimit: 200 }),
                   ["Job recent is waiting for you", "Job edge is waiting for you",
                    "Job undated is waiting for you"]);
  // The default is a day, as the schema declares it.
  assert.deepEqual(shown(), ["Job recent is waiting for you", "Job edge is waiting for you",
                             "Job parked is waiting for you", "Job undated is waiting for you"]);
  // Measured against the clock the band is drawn at when one is given.
  assert.deepEqual(shown({ waitingJobSeconds: 600, hiddenLimit: 200, now: AT + 450 }),
                   ["Job recent is waiting for you", "Job undated is waiting for you"]);
});

test("the band's settings come from the reading, each one the default when it is unusable", () => {
  assert.deepEqual(bandConfigFrom({ band: { state: "ready", hiddenLimit: 7,
                                            waitingJobSeconds: 600 } }),
                   { hiddenLimit: 7, waitingJobSeconds: 600 });
  assert.deepEqual(bandConfigFrom(null), BAND_DEFAULTS);
  assert.deepEqual(bandConfigFrom({}), BAND_DEFAULTS);
  assert.deepEqual(bandConfigFrom({ band: { hiddenLimit: 0, waitingJobSeconds: "x" } }),
                   BAND_DEFAULTS);
  assert.deepEqual(bandConfigFrom({ band: { hiddenLimit: 2.5, waitingJobSeconds: Infinity } }),
                   BAND_DEFAULTS);
  assert.deepEqual(BAND_DEFAULTS, { hiddenLimit: 200, waitingJobSeconds: 86400 });
});

test("a job is this session's own by its full identifier or by its head", () => {
  const snapshot = snapshotFrom(reading(), AT);
  const waiting = snapshot.roster.jobs[1];
  assert.ok(waiting);
  assert.equal(isOwnJob(waiting, "bbbb2222-0000"), true);
  assert.equal(isOwnJob({ ...waiting, session_id: "full-id" }, "full-id"), true);
  assert.equal(isOwnJob(waiting, "other"), false);
  // No identifier known is no session's own, rather than everyone's.
  assert.equal(isOwnJob(waiting, ""), false);
  assert.equal(isOwnJob({ ...waiting, id: "" }, "anything"), false);
});

test("the figures are the pane's, and there are none for a roster nobody read", () => {
  assert.deepEqual(bandCounts(snapshotFrom(reading(), AT)),
                   { working: 1, waiting: 2, failed: 1 });
  const unread = reading({ roster: { state: "failed", errors: [{ source: "jobs:x", reason: "exit 3" }] } });
  assert.equal(bandCounts(snapshotFrom(unread, AT)), null);
});

test("the switch is always drawn, and its word says which way a press goes", () => {
  for (const open of [false, true]) {
    const tree = bandTree({ counts: null, open, width: 120,
                            onToggle: noop });
    const toggle = nodesIn(tree).find((node) => node.props && "key" in node.props
      && (node.props as { key?: string }).key === BAND_TOGGLE);
    assert.equal((toggle?.props as { label?: string }).label,
                 open ? "\u2261 Close llm-fleet" : "\u2261 Open llm-fleet");
  }
});

test("pacer takes the gear, and its word says whether pacer is on", () => {
  let pressed = 0;
  const keyed = (tree: Node, key: string) => nodesIn(tree).find((node) =>
    (node.props as { key?: string } | undefined)?.key === key);
  const on = bandTree({ counts: null, open: false, width: 120,
                        pacer: { enabled: true }, onPacer: () => { pressed += 1; },
                        onToggle: noop });
  const button = keyed(on, BAND_PACER);
  assert.equal((button?.props as { label?: string }).label, "⚙ Pacer on");
  (button?.props as { onPress: () => void }).onPress();
  assert.equal(pressed, 1);
  const off = bandTree({ counts: null, open: false, width: 120,
                         pacer: { enabled: false }, onPacer: noop,
                         onToggle: noop });
  assert.equal((keyed(off, BAND_PACER)?.props as { label?: string }).label, "⚙ Pacer off");
  // A pacer whose switch was not read says so rather than picking a side.
  const unread = bandTree({ counts: null, open: false, width: 120,
                            pacer: { enabled: null }, onPacer: noop,
                            onToggle: noop });
  assert.equal((keyed(unread, BAND_PACER)?.props as { label?: string }).label,
               "⚙ Pacer not read");
  // No pacer: the band carries no gear at all.
  const without = bandTree({ counts: null, open: false, width: 120, pacer: null,
                             onPacer: noop, onToggle: noop });
  assert.equal(keyed(without, BAND_PACER), undefined);
  // Narrow, the word drops its name and keeps the icon and the answer.
  const narrow = bandTree({ counts: null, open: false, width: 30,
                            pacer: { enabled: true }, onPacer: noop,
                            onSpeak: noop, speaking: false,
                            onToggle: noop });
  assert.equal((keyed(narrow, BAND_PACER)?.props as { label?: string }).label, "⚙ on");
});

test("a figure is the press that opens the pane narrowed to what it counted", () => {
  const opened: (string | undefined)[] = [];
  const counts = { working: 2, waiting: 1, failed: 1 };
  const tree = bandTree({ counts, open: false, width: 120,
                          onToggle: () => undefined,
                          onOpen: (focus) => { opened.push(focus); } });
  const keys = nodesIn(tree).filter((node) => node.type === "Button")
    .map((node) => (node.props as { key?: string }).key);
  assert.deepEqual(keys, [BAND_TOGGLE, BAND_FOCUS + "working", BAND_FOCUS + "waiting",
                          BAND_FOCUS + "failed"]);
  const failed = nodesIn(tree).find((node) =>
    (node.props as { key?: string }).key === BAND_FOCUS + "failed");
  (failed?.props as { onPress?: () => unknown }).onPress?.();
  assert.deepEqual(opened, ["failed"]);
  // A figure at zero draws nothing, so there is no press to a state nobody is in.
  const quiet = bandTree({ counts: { working: 2, waiting: 0, failed: 0 }, open: false,
                           width: 120, onToggle: () => undefined,
                           onOpen: (focus) => { opened.push(focus); } });
  const quietKeys = nodesIn(quiet).filter((node) => node.type === "Button")
    .map((node) => (node.props as { key?: string }).key);
  assert.deepEqual(quietKeys, [BAND_TOGGLE, BAND_FOCUS + "working"]);
});

test("the band states what this session spent, and gives the chip up before a figure", () => {
  const priced = renderedText(bandTree({
    counts: { working: 1, waiting: 0, failed: 0 }, spend: "~$1.24", open: false,
    width: 120, onToggle: noop })).join("");
  assert.equal(priced.includes("~$1.24"), true);
  // Nothing priced it: no chip, since a spend of nothing is a different claim.
  const unpriced = renderedText(bandTree({
    counts: { working: 1, waiting: 0, failed: 0 }, spend: null, open: false,
    width: 120, onToggle: noop })).join("");
  assert.equal(unpriced.includes("$"), false);
  // A line too narrow for both gives the chip up: a figure is still on the
  // pane's own tiles, and the switch above them is not.
  const tight = (width: number, spend: string | null) => renderedText(bandTree({
    counts: { working: 1, waiting: 0, failed: 0 }, spend, open: false,
    width, onToggle: noop })).join("");
  assert.equal(tight(40, "$1.24").includes("$1.24"), false);
  assert.equal(tight(40, "$1.24").includes("1 working"), true);
  // And a line with no room for either draws no chip.
  assert.equal(tight(30, "$1.24").includes("$1.24"), false);
});

test("the band states figures above zero, says when nothing runs, and names a read in flight", () => {
  const busy = renderedText(bandTree({ counts: { working: 2, waiting: 0, failed: 1 },
                                       open: false, width: 120, onToggle: noop }));
  assert.equal(busy.includes("2 working"), true);
  assert.equal(busy.includes("1 failed"), true);
  assert.equal(busy.some((value) => value.includes("waiting")), false);
  const quiet = renderedText(bandTree({ counts: { working: 0, waiting: 0, failed: 0 },
                                        open: false, width: 120, onToggle: noop }));
  assert.equal(quiet.includes("Nothing running"), true);
  // An item can need a person with every figure at zero, a flagged skill with
  // no job beside it: the line says how many rather than calling the machine
  // quiet. Found by review, 2026-11-23.
  const attention = renderedText(bandTree({ counts: { working: 0, waiting: 0, failed: 0 },
                                            attention: 1, open: false, width: 120,
                                            onToggle: noop }));
  assert.equal(attention.includes("1 needs you"), true);
  assert.equal(attention.includes("Nothing running"), false);
  const several = renderedText(bandTree({ counts: { working: 0, waiting: 0, failed: 0 },
                                          attention: 3, open: false, width: 120,
                                          onToggle: noop }));
  assert.equal(several.includes("3 need you"), true);
  // A job figure does not answer an item that needs the person: one job
  // working and one flagged item both show, because the figure counts jobs
  // and the item count is a different fact. Found by review, 2026-11-23.
  const busyWithAttention = renderedText(bandTree({ counts: { working: 1, waiting: 0, failed: 0 },
                                                    attention: 1, open: false, width: 120,
                                                    onToggle: noop }));
  assert.equal(busyWithAttention.includes("1 working"), true);
  assert.equal(busyWithAttention.includes("1 needs you"), true);
  const none = renderedText(bandTree({ counts: { working: 0, waiting: 0, failed: 0 },
                                       attention: 0, open: false, width: 120,
                                       onToggle: noop }));
  assert.equal(none.includes("Nothing running"), true);
  // No reading yet is not a quiet fleet: the band says it is still reading.
  const reading = renderedText(bandTree({ counts: null, note: "Reading the machine...",
                                          open: false, width: 120, onToggle: noop }));
  assert.equal(reading.includes("Reading the machine..."), true);
  assert.equal(reading.includes("Nothing running"), false);
  // The roster can be unread or disabled, which leaves no figures, and an item
  // can still need the person: the note says why the figures are absent, and
  // the count is drawn before it rather than dropped. Found by review, 2026-11-23.
  const unread = renderedText(bandTree({ counts: null, note: "Roster unread", attention: 2,
                                         open: false, width: 120, onToggle: noop }));
  assert.equal(unread.includes("2 need you"), true);
  assert.equal(unread.some((value) => value.includes("Roster unread")), true);
  assert.equal(unread.indexOf("2 need you") < unread.findIndex(
    (value) => value.includes("Roster unread")), true);
});

test("the band draws no item of its own, whatever needs a person", () => {
  // The figures say what needs a person and a press on one opens the rows. A
  // sentence naming the worst item made the line long and, at a narrow width,
  // cost the switch its room, so the band does not draw one at all.
  const items = bandItems(snapshotFrom(reading(), AT), [], "");
  const tree = bandTree({ counts: { working: 1, waiting: 2, failed: 1 }, open: false,
                          width: 160, onToggle: noop, onOpen: noop });
  const values = renderedText(tree);
  assert.equal(values.includes("PR 7 checks failing: Fix it"), false);
  assert.equal(values.some((value) => value.includes("more waiting")), false);
  assert.equal(nodesIn(tree).some((node) =>
    (node.props as { key?: string }).key === "fleet.band.dismiss"), false);
  assert.equal(items.length > 0, true);
  // A narrow band keeps the switch and the figures, and the line stays one row.
  const narrow = renderedText(bandTree({ counts: { working: 1, waiting: 2, failed: 1 },
                                         open: false, width: 50, onToggle: noop }));
  assert.equal(narrow.includes("1 working"), true);
  assert.equal(new Set(narrow).size > 0, true);
});

/** A key of the shape the masking refuses, built in parts so no file holds one whole. */
const KEY = ["sk-", "ant-", "api03-", "A".repeat(24)].join("");

test("a secret in an item's words is masked on the band as it is on the pane", () => {
  const secret = reading({
    roster: { state: "ready", providers: {}, interactive: {},
              sources: { jobs: "ready", interactive: "empty" },
              jobs: [job("dddd4444", "blocked", { name: "deploy with " + KEY })] },
  });
  const items = bandItems(snapshotFrom(secret, AT), [], "")
    .filter((item) => item.level === "warning");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text.includes("deploy with"), true);
  assert.equal(items[0]?.text.includes(KEY), false);
});


/** The cells a band tree takes as the terminal draws it, laid out in a row. */
function drawnWidth(node: Node | string): number {
  if (typeof node === "string") {
    return node.length;
  }
  if (node.type === "Button") {
    return String((node.props as { label?: unknown }).label ?? "").length + 4;
  }
  const parts = node.children.map(drawnWidth);
  const gap = Number((node.props as { gap?: unknown }).gap ?? 0);
  const row = (node.props as { flexDirection?: unknown }).flexDirection === "row";
  if (node.type === "Box" && !row) {
    return Math.max(0, ...parts);
  }
  return parts.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, parts.length - 1);
}

test("the band's line fits the width it is given, gaps and button chrome counted", () => {
  const counts = { working: 12, waiting: 3, failed: 2 };
  for (let width = 40; width <= 160; width += 1) {
    for (const open of [false, true]) {
      const tree = bandTree({ counts, open, width, onToggle: noop, onOpen: noop });
      assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
      const lines = nodeLines(tree, width, false);
      assert.equal(lines.length, 2, `width ${width}: drew ${lines.length} lines`);
      for (const line of lines) {
        assert.ok(line.length <= width, `width ${width}: a line drew ${line.length} cells`);
      }
    }
  }
});

test("the band draws a rule across its width above the buttons, and keeps the line under it", () => {
  const width = 80;
  const tree = bandTree({ counts: null, open: true, width,
                          onToggle: noop });
  assert.equal(tree.type, "Box");
  assert.equal((tree.props as { flexDirection?: unknown }).flexDirection, "column");
  const [first, second] = tree.children;
  assert.equal(typeof first === "string", false, "the rule is the band's first line");
  const rule = first as Node;
  assert.equal(rule.type, "Text");
  assert.deepEqual(renderedText(rule), ["─".repeat(width)]);
  assert.equal((rule.props as { dimColor?: unknown }).dimColor, true);
  // The buttons are drawn on the line below the rule, not replaced by it.
  assert.equal(typeof second === "string", false);
  const row = second as Node;
  assert.equal((row.props as { flexDirection?: unknown }).flexDirection, "row");
  assert.ok(nodesIn(row).some((node) => node.type === "Button"));
});

test("the band's figures leave out this session's own job, as its items do", () => {  const snapshot = snapshotFrom(reading(), AT);
  assert.deepEqual(bandCounts(snapshot), { working: 1, waiting: 2, failed: 1 });
  const own = bandCounts(snapshot, "bbbb2222-rest-of-the-session-id");
  assert.equal(own?.waiting, 1);
  assert.equal(bandItems(snapshot, [], "bbbb2222-rest-of-the-session-id")
    .filter((item) => item.level === "warning").length, own?.waiting);
});

function pressable(tree: Node, key: string): { label?: string; variant?: string; onPress?: () => unknown } | undefined {
  return nodesIn(tree).find((node) => (node.props as { key?: string }).key === key)?.props as never;
}

test("the speech switch sits beside the fleet's and says how speech stands everywhere", () => {
  const pressed: string[] = [];
  for (const speaking of [false, true]) {
    const tree = bandTree({ counts: null, open: false, width: 120, speaking,
                            onToggle: noop,
                            onSpeak: () => { pressed.push("speak"); } });
    const speak = pressable(tree, BAND_SPEAK);
    assert.equal(speak?.label, speaking ? "\u266A Speak: on" : "\u266A Speak: off");
    // Lit while the machine speaks, so a voice that is on is the one that stands out.
    assert.equal(speak?.variant, speaking ? "primary" : undefined);
    speak?.onPress?.();
    // Drawn after the fleet's switch, in the same row.
    const keys = nodesIn(tree).map((node) => (node.props as { key?: string }).key).filter(Boolean);
    assert.deepEqual(keys, [BAND_TOGGLE, BAND_SPEAK]);
  }
  assert.deepEqual(pressed, ["speak", "speak"]);
  // A band built without the press draws no switch that would do nothing.
  const bare = bandTree({ counts: null, open: false, width: 120,
                          onToggle: noop });
  assert.equal(pressable(bare, BAND_SPEAK), undefined);
});

test("a terminal draws one-cell glyphs on the switches and a picture surface draws emoji", () => {
  assert.equal(fleetLabel(false), "\u2261 Open llm-fleet");
  assert.equal(fleetLabel(true, "terminal"), "\u2261 Close llm-fleet");
  assert.equal(speakLabel(true, "terminal"), "\u266A Speak: on");
  for (const surface of ["desktop", "vscode", "mobile"]) {
    assert.equal(fleetLabel(false, surface), "\u{1F4CB} Open llm-fleet");
    assert.equal(speakLabel(true, surface), "\u{1F50A} Speak: on");
    assert.equal(speakLabel(false, surface), "\u{1F507} Speak: off");
  }
  const tree = bandTree({ counts: null, open: true, width: 120, surface: "desktop",
                          speaking: false, onToggle: noop, onSpeak: noop });
  assert.equal(pressable(tree, BAND_TOGGLE)?.label, "\u{1F4CB} Close llm-fleet");
  assert.equal(pressable(tree, BAND_SPEAK)?.label, "\u{1F507} Speak: off");
});

test("the band's line fits its width with the speech switch drawn too", () => {
  const counts = { working: 12, waiting: 3, failed: 2 };
  // Down to the narrowest width the band is drawn at, where the speech switch
  // gives up its word to keep the line inside the terminal.
  for (let width = 40; width <= 160; width += 1) {
    for (const speaking of [false, true]) {
      const tree = bandTree({ counts, open: false, width, speaking,
                              onToggle: noop, onSpeak: noop });
      assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
      // The switch keeps its icon and its state however narrow the band is.
      const label = String(pressable(tree, BAND_SPEAK)?.label);
      assert.equal(label.startsWith("♪ ") && label.endsWith(speaking ? "on" : "off"), true, label);
    }
  }
  // The product's name and the speech switch's word are given up before a
  // figure is: the counts are what the line is read for, and the verb alone
  // still says which way a press goes.
  const narrow = bandTree({ counts, open: false, width: 30, speaking: true,
                            onToggle: noop, onSpeak: noop });
  assert.equal(pressable(narrow, BAND_TOGGLE)?.label, "≡ Open");
  assert.equal(pressable(narrow, BAND_SPEAK)?.label, "♪ on");
  const wide = bandTree({ counts, open: false, width: 160, speaking: true,
                          onToggle: noop, onSpeak: noop });
  assert.equal(pressable(wide, BAND_TOGGLE)?.label, "≡ Open llm-fleet");
  assert.equal(pressable(wide, BAND_SPEAK)?.label, "♪ Speak: on");
  // A band too narrow for the word drops it rather than running off the edge:
  // the icon and the state are what a person presses for.
  let shortened = 0;
  for (let width = 30; width <= 45; width += 1) {
    const tree = bandTree({ counts, open: false, width, speaking: true,
                            onToggle: noop, onSpeak: noop });
    if (pressable(tree, BAND_SPEAK)?.label === "♪ on") {
      shortened += 1;
    }
    assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
  }
  assert.ok(shortened > 0, "no width between 30 and 45 drew the short speech switch");
});

test("the count stays where it is when a figure is given up", () => {
  // The count stands after the figures, so every figure dropped from the middle
  // moved it, and the cut was then written one place along the line: the count
  // was drawn twice or the line ran past its width. Found by review,
  // 2026-11-23.
  for (let width = 20; width <= 70; width += 1) {
    const tree = bandTree({ counts: { working: 5, waiting: 3, failed: 0 },
                            attention: 2, open: false, width, onToggle: noop });
    const line = renderedText(tree).join("");
    const counted = line.match(/needs? you/g)?.length ?? 0;
    assert.ok(counted <= 1, `width ${width}: the count was drawn ${counted} times`);
    assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
  }
});

test("what needs a person outranks the controls beside it on a narrow line", () => {
  // The item count is the line's one cue out of the pane, and no other line
  // carries it: a control gives up its place first, and the count itself is
  // cut only when the switch alone leaves no room. Found by review, 2026-11-23.
  const build = (width: number) => bandTree({
    counts: { working: 0, waiting: 0, failed: 0 }, attention: 1, open: false,
    width, speaking: false, pacer: { enabled: true }, onPacer: noop,
    onToggle: noop, onSpeak: noop,
  });
  for (let width = 30; width <= 80; width += 1) {
    const tree = build(width);
    assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
    // The whole count survives wherever the switch and the count alone fit.
    assert.equal(renderedText(tree).join("").includes("1 needs you"), true,
                 `width ${width}: the count was not drawn in full`);
  }
  // At 40 the gear has already gone, and the line is still inside its width.
  assert.equal(pressable(build(40), BAND_PACER), undefined);
  assert.equal(pressable(build(40), BAND_SPEAK)?.label, "♪ off");
  // Narrower than the switch and the count, the count is cut and marked rather
  // than dropped: a line that says less is still a line that says something.
  const cut = renderedText(build(20)).join("");
  assert.equal(cut.includes("1 ne"), true);
  assert.equal(cut.includes("..."), true);
  assert.ok(drawnWidth(build(20)) <= 20, `width 20: drew ${drawnWidth(build(20))}`);
});
