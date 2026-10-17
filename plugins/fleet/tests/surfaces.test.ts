/**
 * The smaller surfaces, through the host's own test kit: the tab color, the
 * key tip after the hint line, `/keys` and `/worktrees`, and a non-interactive
 * session that starts nothing.
 *
 * The unit suite drives each of these with a stub that holds the contract the
 * entry depends on. This runs them through the engine's own calls instead: the
 * environment the tab reads, the process it starts, the hint line's props, the
 * commands' words and the store they keep a preference in. A name or a shape
 * the engine does not have fails here rather than in a session.
 *
 * Run with: claude plugin test plugins/fleet
 */

import { expect, mock, test } from "claude-code/testing";

import { FOLDS_KEY, FRESH_WORKTREES, READING_KEY, TAB_HELPER, TIPS_KEY } from "../hooks/fleet.ts";

const AT = 1790000000;

/** What the read command prints, as the readers print it: one job working, nothing wrong. */
const READING = {
  generated_at: AT,
  roster: {
    state: "ready",
    providers: { one: { state: "ready", jobs: 1 } },
    jobs: [{
      provider: "one", id: "job-1", name: "Review adapter behavior", state: "working",
      label: "Working", started_at: AT - 600, last_seen_at: AT - 5, folder: "/tmp/p",
    }],
    sources: { jobs: "ready", interactive: "empty" },
    interactive: { one: 1 },
  },
  trials: { state: "empty" },
  progress: { state: "empty" },
  prs: { state: "empty" },
  skills: { state: "empty" },
  worktrees: { state: "empty" },
};

/** The same machine with a pull request whose checks fail: the band leads with a failure. */
const FAILING = { ...READING, prs: { state: "ready", prs: [
  { repo: "owner/project", number: 7, title: "Fix it", branch: "fix", head: "abc",
    is_draft: false, checks: "fail" },
] } };

const FIRST_TIP = "Ctrl+U clears the line before the cursor.";

/** The hint line's props as the engine hands them over. */
const HINT = { isDraft: true, isWorking: false, hint: "? for shortcuts" } as const;

/** Every string a drawing or a prop set holds. */
function strings(node: unknown): string[] {
  if (typeof node === "string") {
    return [node];
  }
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Object.values(node as Record<string, unknown>).flatMap(strings);
}

/** The test's `on`, which answers beneath the plugin as the engine does. */
type TestOn = Parameters<Parameters<typeof test>[1] & ((...args: never[]) => unknown)>[1];

/**
 * The engine's own parts a session answers and the kit does not: a command's
 * registration, and the hint line drawn from the props the plugin hands on,
 * its tail after its text, so a case reads what reached the engine.
 */
function engine(on: TestOn): void {
  on("command.register", () => ({ value: undefined }) as never);
  on("ui.render", { component: "PromptHint" }, (_engine, e) => {
    const props = (e as { props: { hint: string; tail?: string } }).props;
    return { type: "Text", props: {}, children: [props.hint + (props.tail ?? "")] } as never;
  });
}

/**
 * The processes the plugin starts, answered beneath it: the read command with a
 * reading a case chooses, the tab helper with success, and anything else with a
 * refusal. What each was asked is kept, in order.
 */
function machine(on: TestOn, reading: () => unknown) {
  const runs: string[][] = [];
  on("process.run", (_engine, e) => {
    const argv = (e as { argv: string[] }).argv;
    runs.push(argv);
    if (argv[1]?.endsWith("snapshot.py")) {
      return { value: { exitCode: 0, stdout: JSON.stringify(reading()), stderr: "" } } as never;
    }
    if (argv[1]?.endsWith(TAB_HELPER)) {
      return { value: { exitCode: 0, stdout: "", stderr: "" } } as never;
    }
    return { value: { exitCode: 1, stdout: "", stderr: "" } } as never;
  });
  return runs;
}

test("a typed draft ends the hint line with a key tip, and no draft leaves the line alone", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  for (const surface of ["terminal", "desktop"] as const) {
    const hint = await $.ui.mount({ plugin: "llm-fleet", surface, component: "PromptHint",
                                    props: HINT as never });
    expect(strings(await hint.drawn()).some((text) => text.includes(FIRST_TIP))).toBe(true);
    const idle = await $.ui.mount({ plugin: "llm-fleet", surface, component: "PromptHint",
                                    props: { ...HINT, isDraft: false } as never });
    expect(strings(await idle.drawn()).some((text) => text.includes(FIRST_TIP))).toBe(false);
  }
});

test("/keys tips off keeps the word in the store and takes the tip off the hint line", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true } as never)
    .catch(() => undefined);
  const off = await $.command.run({ command: "keys", args: "tips off" } as never);
  expect(JSON.stringify(off)).toContain("Key tips off");
  const hint = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "PromptHint",
                                  props: HINT as never });
  expect(strings(await hint.drawn()).some((text) => text.includes(FIRST_TIP))).toBe(false);
  const usage = await $.command.run({ command: "keys", args: "tips sideways" } as never);
  expect(JSON.stringify(usage)).toContain("/keys tips off|on");
  const on2 = await $.command.run({ command: "keys", args: "tips on" } as never);
  expect(JSON.stringify(on2)).toContain("Key tips on");
  expect(TIPS_KEY).toBe("key-tips");
});

test("/worktrees opens the pane, probes the worktrees on the next look, and keeps the folds for the next session", async ($, on) => {
  const clock = mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  const runs = machine(on, () => READING);
  const opened: string[] = [];
  on("ui.panes", () => ({ value: [] }) as never);
  on("ui.open", (_engine, e) => {
    opened.push((e as { id: string }).id);
    return { value: { isPlaced: true } } as never;
  });
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true } as never)
    .catch(() => undefined);
  const ran = await $.command.run({ command: "worktrees", args: "" } as never);
  expect(JSON.stringify(ran)).toContain("Fleet pane opened on Worktrees");
  expect(opened).toEqual(["fleet"]);
  // The command starts no process: the next look, one interval on, probes.
  expect(runs.some((argv) => argv.includes(FRESH_WORKTREES))).toBe(false);
  await clock.advance(3_000);
  expect(runs.some((argv) => argv[1]?.endsWith("snapshot.py") && argv.includes(FRESH_WORKTREES)))
    .toBe(true);
  // The pane drawn after it holds Worktrees open and the sessions folded.
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane",
                                  requestId: "fleet",
                                  props: { title: "Fleet", isFocused: true, bodyColumns: 120,
                                           placement: "dock" } as never });
  const text = strings(await pane.drawn());
  expect(text).toContain("Worktrees");
  expect(text).not.toContain("Review adapter behavior");
  expect(FOLDS_KEY).toBe("folds");
});

test("/keys opens the pane on Keys", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  on("ui.panes", () => ({ value: [] }) as never);
  on("ui.open", () => ({ value: { isPlaced: true } }) as never);
  const ran = await $.command.run({ command: "keys", args: "" } as never);
  expect(JSON.stringify(ran)).toContain("Fleet pane opened on Keys");
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane",
                                  requestId: "fleet",
                                  props: { title: "Fleet", isFocused: true, bodyColumns: 120,
                                           placement: "dock" } as never });
  const text = strings(await pane.drawn());
  expect(text).toContain("close this pane");
  expect(text).not.toContain("Review adapter behavior");
});

test("iTerm's tab is told this session's failure, and the session's end takes it out", async ($, on) => {
  const clock = mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, {});
  mock.env(on, { TERM_PROGRAM: "iTerm.app" });
  // The tab's levels are kept per session, so the session must have an id.
  on("session.id", () => ({ value: "kit-session" }) as never);
  const runs = machine(on, () => FAILING);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true } as never)
    .catch(() => undefined);
  await clock.advance(5_000);
  const tabs = () => runs.filter((argv) => argv[1]?.endsWith(TAB_HELPER)).map((argv) => argv.slice(2));
  const set = ["set", "--tab", "session:kit-session", "--session", "kit-session", "--level", "failed"];
  expect(tabs()).toEqual([set]);
  await $.session.end({ reason: "other", sessionId: "s" } as never).catch(() => undefined);
  expect(tabs()).toEqual([set, ["end", "--tab", "session:kit-session", "--session", "kit-session"]]);
});

test("a terminal that draws no tab color is never written to", async ($, on) => {
  const clock = mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, {});
  mock.env(on, { TERM_PROGRAM: "Apple_Terminal" });
  // With an id, so the only reason nothing is written is the terminal.
  on("session.id", () => ({ value: "kit-session" }) as never);
  const runs = machine(on, () => FAILING);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true } as never)
    .catch(() => undefined);
  await clock.advance(5_000);
  await $.session.end({ reason: "other", sessionId: "s" } as never).catch(() => undefined);
  expect(runs.some((argv) => argv[1]?.endsWith("snapshot.py"))).toBe(true);
  expect(runs.some((argv) => argv[1]?.endsWith(TAB_HELPER))).toBe(false);
});

test("a -p or SDK session reads nothing on its own", async ($, on) => {
  const clock = mock.clock(on, { now: AT * 1000 });
  engine(on);
  mock.store(on, {});
  mock.env(on, { TERM_PROGRAM: "iTerm.app" });
  const runs = machine(on, () => FAILING);
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false } as never)
    .catch(() => undefined);
  await clock.advance(60_000);
  expect(runs).toEqual([]);
});

test("a -p session that submits a prompt runs no helper and writes nothing to the store", async ($, on) => {
  const clock = mock.clock(on, { now: AT * 1000 });
  engine(on);
  // A store that records every key written to it.
  const written: string[] = [];
  on("store.get", () => ({ value: undefined }) as never);
  on("store.keys", () => ({ value: [] }) as never);
  on("store.set", (_engine, e) => {
    written.push((e as { key: string }).key);
    return { value: undefined } as never;
  });
  mock.env(on, { TERM_PROGRAM: "iTerm.app" });
  on("session.id", () => ({ value: "kit-session" }) as never);
  const runs = machine(on, () => FAILING);
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false } as never)
    .catch(() => undefined);
  await $.prompt.submit({ text: "summarize" } as never).catch(() => undefined);
  await clock.advance(60_000);
  expect(runs).toEqual([]);
  expect(written).toEqual([]);
});
