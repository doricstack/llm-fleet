/**
 * The band above the prompt: what it leads with, and the switch it always draws.
 *
 * The cases read a snapshot assembled the way the plugin assembles one, from
 * documents shaped as the readers print them, so a band item is proved against
 * the same fields the pane reads.
 *
 * Run with: node --test components/band.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BAND_DEFAULTS, BAND_DISMISS, BAND_FOCUS, BAND_ITEM, BAND_SPEAK, BAND_TOGGLE,
         bandConfigFrom, bandCounts, bandItems,
         answeredSources, bandTree, fleetLabel, keptHidden,
         isOwnJob, speakLabel } from "../plugins/fleet/components/band.ts";
import { renderedText } from "../plugins/fleet/components/layout.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/fleet/components/snapshot.ts";
import type { Node } from "../plugins/fleet/components/host.ts";

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
    trials: { state: "ready", running: [], history: null, recent: [
      { key: "t1", repo: "repo", branch: "feat/a", change_state: "TRYING", at: AT - 30,
        is_green: false, passed: 4, failed: 2, errors: 1, skipped: 0 },
      { key: "t2", repo: "repo", branch: "feat/b", change_state: "TRYING", at: AT - 30,
        is_green: true, passed: 9, failed: 0, errors: 0, skipped: 0 },
    ] },
    progress: { state: "empty" },
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
  assert.deepEqual(items.map((item) => item.level),
                   ["error", "error", "warning", "warning"]);
  assert.equal(items[0]?.text, "Trial failed on repo feat/a: 3 failed");
  assert.equal(items[1]?.text, "PR 7 checks failing: Fix it");
  assert.equal(items[2]?.text, "Job bbbb2222 is waiting for you");
  // A passing trial, a passing PR and a working session need nobody.
  assert.equal(items.some((item) => item.text.includes("feat/b")), false);
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
    skills: { state: "ready", items: [], counts: {},
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

test("a skill's finding is masked on the band as it is on the pane", () => {
  const items = bandItems(snapshotFrom(reading({
    skills: { state: "ready", items: [], counts: {},
              new: [skill("alpha", "flagged", { issue: "posts " + SKILL_KEY })] },
  }), AT), [], "");
  const flagged = items.find((item) => item.key.startsWith("skill:"))?.text ?? "";
  assert.equal(flagged.includes("posts"), true, flagged);
  assert.equal(flagged.includes(SKILL_KEY), false, flagged);
});

test("a failed trial leaves the band once its change has merged or been cleaned", () => {
  const trial = (key: string, change_state: string) => ({
    key, repo: "repo", branch: "feat/" + key, change_state, at: AT - 30, is_green: false,
    passed: 1, failed: 1, errors: 0, skipped: 0 });
  const items = bandItems(snapshotFrom(reading({
    trials: { state: "ready", running: [], history: null,
              recent: [trial("open", "TRYING"), trial("merged", "MERGED"),
                       trial("cleaned", "CLEANED")] },
  }), AT), [], "");
  assert.deepEqual(items.filter((item) => item.key.startsWith("trial:")).map((item) => item.key),
                   ["trial:open"]);
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

test("a dismissal keeps only keys that name something current, the newest within the limit", () => {
  const current = ["trial:t1", "pr:a", "job:x:blocked:1", "job:y:blocked:2"];
  // Keys for things that have gone are dropped when a dismissal is written.
  assert.deepEqual(keptHidden(["gone:1", "trial:t1", "gone:2"], current, ["pr:a"], 200),
                   ["trial:t1", "pr:a"]);
  // A key dismissed twice is kept once, at its newest place.
  assert.deepEqual(keptHidden(["pr:a", "trial:t1"], current, ["pr:a"], 200),
                   ["trial:t1", "pr:a"]);
  // The limit keeps the newest.
  assert.deepEqual(keptHidden(["trial:t1", "pr:a"], current,
                              ["job:x:blocked:1", "job:y:blocked:2"], 3),
                   ["pr:a", "job:x:blocked:1", "job:y:blocked:2"]);
});

test("a dismissed key from a source that did not answer is kept, though nothing shows it now", () => {
  // The roster failed this read, so job a is absent only because nobody could
  // ask; its dismissal must outlive the read. A trial key is pruned, since the
  // trials source answered and the trial is gone.
  const answered = new Set(["trials", "prs", "skills", "progress"]);
  assert.deepEqual(keptHidden(["job:a:blocked:1", "trial:gone"], ["pr:a"], ["pr:a"], 200,
                              answered),
                   ["job:a:blocked:1", "pr:a"]);
  // A key no source claims names nothing the band could show, and goes.
  assert.deepEqual(keptHidden(["odd:1"], [], ["pr:a"], 200, new Set()), ["pr:a"]);
});

test("a source has answered when it read ready or empty with no error", () => {
  const sources = (overrides: Record<string, unknown>) =>
    [...answeredSources(snapshotFrom(reading(overrides), AT))].sort();
  assert.deepEqual(sources({ progress: { state: "empty" }, skills: { state: "ready", new: [] },
                             worktrees: { state: "empty" } }),
                   ["progress", "prs", "roster", "skills", "trials"]);
  // A roster with one provider failing has not answered for that provider's jobs.
  assert.deepEqual(sources({ roster: { state: "ready", providers: {}, interactive: {},
                                       sources: { jobs: "ready", interactive: "empty" },
                                       jobs: [], errors: [{ source: "jobs:two",
                                                            reason: "exit 3" }] } }),
                   ["progress", "prs", "skills", "trials"]);
  assert.deepEqual(sources({ roster: { state: "failed", errors: [] },
                             prs: { state: "disabled" }, trials: { state: "unavailable" } }),
                   ["progress", "skills"]);
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
    const tree = bandTree({ items: [], counts: null, open, width: 120,
                            onToggle: noop, onDismiss: noop });
    const toggle = nodesIn(tree).find((node) => node.props && "key" in node.props
      && (node.props as { key?: string }).key === BAND_TOGGLE);
    assert.equal((toggle?.props as { label?: string }).label,
                 open ? "\u2261 Close fleet" : "\u2261 Open fleet");
    // Nothing to dismiss draws no Dismiss.
    assert.equal(nodesIn(tree).some((node) =>
      (node.props as { key?: string }).key === BAND_DISMISS), false);
  }
});

test("a figure is the press that opens the pane narrowed to what it counted", () => {
  const opened: (string | undefined)[] = [];
  const counts = { working: 2, waiting: 1, failed: 1 };
  const tree = bandTree({ items: [], counts, open: false, width: 120,
                          onToggle: () => undefined, onDismiss: () => undefined,
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
  const quiet = bandTree({ items: [], counts: { working: 2, waiting: 0, failed: 0 }, open: false,
                           width: 120, onToggle: () => undefined, onDismiss: () => undefined,
                           onOpen: (focus) => { opened.push(focus); } });
  const quietKeys = nodesIn(quiet).filter((node) => node.type === "Button")
    .map((node) => (node.props as { key?: string }).key);
  assert.deepEqual(quietKeys, [BAND_TOGGLE, BAND_FOCUS + "working"]);
});

test("what the band leads with opens the pane", () => {
  const items = [{ key: "trial:r:feat/a:TRYING", level: "error" as const,
                   text: "Trial failed on repo feat/a: 2 failed" }];
  const opened: (string | undefined)[] = [];
  const tree = bandTree({ items, counts: { working: 0, waiting: 0, failed: 1 }, open: false,
                          width: 140, onToggle: () => undefined, onDismiss: () => undefined,
                          onOpen: (focus) => { opened.push(focus); } });
  const lead = nodesIn(tree).find((node) =>
    (node.props as { key?: string }).key === BAND_ITEM + items[0].key);
  assert.notEqual(lead, undefined);
  (lead?.props as { onPress?: () => unknown }).onPress?.();
  // No state was named: the press opens the whole fleet, where the item lives.
  assert.deepEqual(opened, [undefined]);
});

test("the band states figures above zero, says when nothing runs, and names a read in flight", () => {
  const busy = renderedText(bandTree({ items: [], counts: { working: 2, waiting: 0, failed: 1 },
                                       open: false, width: 120, onToggle: noop,
                                       onDismiss: noop }));
  assert.equal(busy.includes("2 working"), true);
  assert.equal(busy.includes("1 failed"), true);
  assert.equal(busy.some((value) => value.includes("waiting")), false);
  const quiet = renderedText(bandTree({ items: [], counts: { working: 0, waiting: 0, failed: 0 },
                                        open: false, width: 120, onToggle: noop,
                                        onDismiss: noop }));
  assert.equal(quiet.includes("Nothing running"), true);
  // No reading yet is not a quiet fleet: the band says it is still reading.
  const reading = renderedText(bandTree({ items: [], counts: null, note: "Reading the machine...",
                                          open: false, width: 120, onToggle: noop,
                                          onDismiss: noop }));
  assert.equal(reading.includes("Reading the machine..."), true);
  assert.equal(reading.includes("Nothing running"), false);
});

test("the band leads with the worst item and counts the rest after it", () => {
  const items = bandItems(snapshotFrom(reading(), AT), [], "");
  const tree = bandTree({ items, counts: { working: 1, waiting: 2, failed: 1 }, open: false,
                          width: 160, onToggle: noop, onDismiss: noop });
  const values = renderedText(tree);
  assert.equal(values.includes("Trial failed on repo feat/a: 3 failed"), true);
  assert.equal(values.includes(" · 1 more failing, 2 more waiting"), true);
  const lead = nodesIn(tree).find((node) => node.children[0] === "Trial failed on repo feat/a: 3 failed");
  assert.equal((lead?.props as { color?: string }).color, "error");
  assert.equal(nodesIn(tree).some((node) =>
    (node.props as { key?: string }).key === BAND_DISMISS), true);
  // Too narrow for the item, the switch and the figures stay and the item goes.
  const narrow = renderedText(bandTree({ items, counts: { working: 1, waiting: 2, failed: 1 },
                                         open: false, width: 50, onToggle: noop,
                                         onDismiss: noop }));
  assert.equal(narrow.includes("Trial failed on repo feat/a: 3 failed"), false);
  assert.equal(narrow.includes("1 working"), true);
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
  const snapshot = snapshotFrom(reading(), AT);
  const items = bandItems(snapshot, [], "");
  const counts = { working: 12, waiting: 3, failed: 2 };
  for (let width = 70; width <= 160; width += 1) {
    for (const open of [false, true]) {
      const tree = bandTree({ items, counts, open, width, onToggle: noop, onDismiss: noop });
      assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
    }
  }
});

test("the band draws a rule across its width above the buttons, and keeps the line under it", () => {
  const width = 80;
  const tree = bandTree({ items: [], counts: null, open: true, width,
                          onToggle: noop, onDismiss: noop });
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
    const tree = bandTree({ items: [], counts: null, open: false, width: 120, speaking,
                            onToggle: noop, onDismiss: noop,
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
  const bare = bandTree({ items: [], counts: null, open: false, width: 120,
                          onToggle: noop, onDismiss: noop });
  assert.equal(pressable(bare, BAND_SPEAK), undefined);
});

test("a terminal draws one-cell glyphs on the switches and a picture surface draws emoji", () => {
  assert.equal(fleetLabel(false), "\u2261 Open fleet");
  assert.equal(fleetLabel(true, "terminal"), "\u2261 Close fleet");
  assert.equal(speakLabel(true, "terminal"), "\u266A Speak: on");
  for (const surface of ["desktop", "vscode", "mobile"]) {
    assert.equal(fleetLabel(false, surface), "\u{1F4CB} Open fleet");
    assert.equal(speakLabel(true, surface), "\u{1F50A} Speak: on");
    assert.equal(speakLabel(false, surface), "\u{1F507} Speak: off");
  }
  const tree = bandTree({ items: [], counts: null, open: true, width: 120, surface: "desktop",
                          speaking: false, onToggle: noop, onDismiss: noop, onSpeak: noop });
  assert.equal(pressable(tree, BAND_TOGGLE)?.label, "\u{1F4CB} Close fleet");
  assert.equal(pressable(tree, BAND_SPEAK)?.label, "\u{1F507} Speak: off");
});

test("the band's line fits its width with the speech switch drawn too", () => {
  const snapshot = snapshotFrom(reading(), AT);
  const items = bandItems(snapshot, [], "");
  const counts = { working: 12, waiting: 3, failed: 2 };
  for (let width = 80; width <= 160; width += 1) {
    for (const speaking of [false, true]) {
      const tree = bandTree({ items, counts, open: false, width, speaking,
                              onToggle: noop, onDismiss: noop, onSpeak: noop });
      assert.ok(drawnWidth(tree) <= width, `width ${width}: drew ${drawnWidth(tree)}`);
      // The switch keeps its icon and its state however narrow the band is.
      const label = String(pressable(tree, BAND_SPEAK)?.label);
      assert.equal(label.startsWith("♪ ") && label.endsWith(speaking ? "on" : "off"), true, label);
    }
  }
  const narrow = bandTree({ items, counts, open: false, width: 80, speaking: true,
                            onToggle: noop, onDismiss: noop, onSpeak: noop });
  assert.equal(pressable(narrow, BAND_SPEAK)?.label, "♪ on");
  const wide = bandTree({ items, counts, open: false, width: 160, speaking: true,
                          onToggle: noop, onDismiss: noop, onSpeak: noop });
  assert.equal(pressable(wide, BAND_SPEAK)?.label, "♪ Speak: on");
});
