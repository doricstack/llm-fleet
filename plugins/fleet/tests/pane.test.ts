/**
 * The pane, mounted through the host's own test kit.
 *
 * The unit suite drives the entry with a stub, which proves the contract the
 * entry holds but says nothing about whether the surface draws what it returns.
 * This mounts the pane the way the host mounts it and reads the drawing back, so
 * a tree the surface will not draw fails here rather than in a session where the
 * only sign is an empty frame.
 *
 * The engine the test runs under answers only the nouns a test mocks, so the
 * clock is mocked here: without it the render hook is skipped, which is how the
 * kit reports a noun a plugin reached for and the test never provided. The read
 * command is not mocked, so what this can assert is the state the pane draws
 * when the machine did not answer. That is the point: the assertion names the
 * sentence the pane draws, so a pane that drew a title over nothing, or claimed
 * to be reading forever, would fail here.
 *
 * A populated drawing is proved through the store instead, which the kit does
 * answer. The pane opens on the reading the last session left, so seeding that
 * value is what puts rows, counts and their theme keys in front of the surface's
 * own table: a pane whose rows the terminal will not draw fails here.
 *
 * Run with: claude plugin test plugins/fleet
 */

import { expect, mock, test } from "claude-code/testing";

import { HIDDEN_KEY, READING_KEY, REPLIED_KEY } from "../hooks/fleet.ts";

const PANE_PROPS = {
  title: "Fleet",
  isFocused: true,
  bodyColumns: 120,
  placement: "dock",
} as const;

const AT = 1790000000;

/** What the read command prints, as the readers print it. */
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

test("the pane draws what it could not read rather than an empty fleet", async ($, on) => {
  mock.clock(on);
  const pane = await $.ui.mount({
    plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet",
    props: PANE_PROPS as never,
  });
  const drawn = await pane.drawn();
  expect(drawn).toBeDefined();
  const text = JSON.stringify(drawn);
  expect(text).toContain("Fleet");
  // The read has no implementation under the kit, so the pane must say the
  // machine did not answer. A drawing that only carried the title would pass a
  // check for the title alone.
  expect(text).toContain("the read did not answer");
  expect(text).not.toContain("Reading the machine");
});

/**
 * The surfaces this pane is mounted on.
 *
 * The layout draws one view model for each, and a surface the pane cannot be
 * mounted on is one thing; a surface it is mounted on and quietly draws wrong is
 * another. Every case that presses or reads a row runs on each, so a fault
 * one surface alone has is a failure here rather than a report from whoever
 * opened it there.
 */
const SURFACES = ["terminal", "desktop", "vscode", "mobile"] as const;

test("the pane draws a reading, not just a sentence, through the surface's own table", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({
      plugin: "llm-fleet", surface, component: "Pane", requestId: "fleet",
      props: PANE_PROPS as never,
    });
    const drawn = await pane.drawn();
    const text = JSON.stringify(drawn);
    // The parts a failed read never reaches, and the ones a host refuses when a
    // color or a prop is not in its table. Each is read off the node that should
    // carry it rather than off the whole drawing: searching everything would pass
    // on a count from a group summary and a color from an unrelated row.
    expect(text).not.toContain("Reading the machine");
    expect(texts(drawn).some((value) => value.startsWith("Updated"))).toBe(true);
    // The head carries the figures on the title's line when they fit: the count
    // on its chip, and the words for what it counts beside it.
    expect(headerTexts(drawn)).toContain("Working sessions");
    expect(headerTexts(drawn)).toContain("1");
    const row = rowHolding(drawn, "Review adapter behavior", "Working");
    expect(row).not.toBeNull();
    expect(texts(row)).toContain("Working");
    expect(colorsIn(row).length).toBeGreaterThan(0);
  }
});

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown };

/** Every string the drawing holds, in the order the surface would draw them. */
function texts(node: unknown): string[] {
  if (typeof node === "string") {
    return [node];
  }
  if (node === null || typeof node !== "object") {
    return [];
  }
  const children = (node as Drawn).children;
  return (Array.isArray(children) ? children : [children]).flatMap(texts);
}

/** The pane's header line: the title, and the counts drawn beside it. */
function headerTexts(drawn: Drawn): string[] {
  const children = Array.isArray(drawn.children) ? drawn.children : [];
  return children.length === 0 ? [] : texts(children[0]);
}

/** Every color the drawing paints with, under `node`. */
function colorsIn(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const record = node as Drawn;
  const color = record.props?.color;
  if (typeof color === "string") {
    found.push(color);
  }
  const children = Array.isArray(record.children) ? record.children : [record.children];
  for (const child of children) {
    colorsIn(child, found);
  }
  return found;
}

/**
 * The innermost box holding both a row's title and its right slot.
 *
 * Innermost is the point: every box above the row holds the same two strings,
 * and the row is the one whose own direction decides whether they share a line.
 */
function rowHolding(node: unknown, title: string, slot: string): Drawn | null {
  if (node === null || typeof node !== "object") {
    return null;
  }
  const record = node as Drawn;
  const children = Array.isArray(record.children) ? record.children : [record.children];
  for (const child of children) {
    const inner = rowHolding(child, title, slot);
    if (inner !== null) {
      return inner;
    }
  }
  const inside = texts(record);
  return inside.includes(title) && inside.includes(slot) ? record : null;
}

test("pressing a section heading folds that section, through the host", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({
      plugin: "llm-fleet", surface, component: "Pane", requestId: "fleet",
      props: PANE_PROPS as never,
    });
    expect(JSON.stringify(await pane.drawn())).toContain("Review adapter behavior");
    // A real press on the heading the pane drew, run by the host the way a
    // person's press is: the row goes, and the heading says which way it folded.
    await pane.press({ key: "fleet.section.sessions" });
    const folded = JSON.stringify(await pane.drawn());
    expect(folded).not.toContain("Review adapter behavior");
    expect(folded).toContain("\u25b8");
    expect(folded).toContain("Background sessions");
    await pane.press({ key: "fleet.section.sessions" });
    const open = JSON.stringify(await pane.drawn());
    expect(open).toContain("Review adapter behavior");
    expect(open).toContain("\u25be");
    expect(open).toContain("Background sessions");
  }
});

test("pressing Collapse all folds every section, through the host", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({
      plugin: "llm-fleet", surface, component: "Pane", requestId: "fleet",
      props: PANE_PROPS as never,
    });
    await pane.press({ key: "fleet.all.collapse" });
    const folded = JSON.stringify(await pane.drawn());
    expect(folded).not.toContain("Review adapter behavior");
    expect(folded).toContain("\u25b8");
    expect(folded).toContain("Background sessions");
    await pane.press({ key: "fleet.all.expand" });
    const open = JSON.stringify(await pane.drawn());
    expect(open).toContain("Review adapter behavior");
    expect(open).toContain("\u25be");
    expect(open).toContain("Background sessions");
  }
});

test("a row the surface has room for keeps its title and its right slot on one line", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  const pane = await $.ui.mount({
    plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet",
    props: { ...PANE_PROPS, bodyColumns: 120 } as never,
  });
  const row = rowHolding(await pane.drawn(), "Review adapter behavior", "Working");
  expect(row).not.toBeNull();
  // The direction is asserted, not merely the absence of the other one: a row
  // that named no direction at all would pass a check for "not column", and a
  // row the pane went narrow over would stack here. A row that lost its right
  // slot would not be found at all.
  expect(row?.props?.flexDirection).toBe("row");
});

test("a row wider than the surface has room for stacks rather than dropping its right slot", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  const pane = await $.ui.mount({
    plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet",
    props: { ...PANE_PROPS, bodyColumns: 40 } as never,
  });
  const row = rowHolding(await pane.drawn(), "Review adapter behavior", "Working");
  // Both halves are still there, one above the other. A narrow row that dropped
  // the state, or one whose title was cut to fit, fails here.
  expect(row).not.toBeNull();
  expect(row?.props?.flexDirection).toBe("column");
});

/** What the band is handed: room for one line, no survey, a turn running. */
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 140,
} as const;

/**
 * The band's switch, pressed through the host.
 *
 * The switch exists because a typed command waits behind a running turn and a
 * press does not, so the case runs with a turn running and proves the press
 * alone opens the pane, then closes it, and that the band says which way it
 * went each time. The engine's pane calls are answered here, beneath the
 * plugin, which is where a session answers them.
 */
test("the band's switch opens and closes the pane with a press, mid-turn", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  const open: string[] = [];
  on("session.id", () => ({ value: "another-session" }) as never);
  on("ui.panes", () => ({ value: open.map((id) => ({ id })) }) as never);
  on("ui.open", (_engine, e) => {
    open.push((e as { id: string }).id);
    return { value: { isPlaced: true } } as never;
  });
  on("ui.close", (_engine, e) => {
    const at = open.indexOf((e as { id: string }).id);
    if (at >= 0) {
      open.splice(at, 1);
    }
    return { value: undefined } as never;
  });
  for (const surface of SURFACES) {
    open.length = 0;
    const band = await $.ui.mount({ plugin: "llm-fleet", surface, component: "AbovePrompt",
                                    props: BAND_PROPS as never });
    expect(JSON.stringify(await band.drawn())).toContain("Open fleet");
    // The figures beside the switch are the reading's, on the band as on the pane.
    expect(texts(await band.drawn())).toContain("1 working");
    await band.press({ key: "fleet.band.toggle" });
    expect(open).toEqual(["fleet"]);
    expect(JSON.stringify(await band.drawn())).toContain("Close fleet");
    await band.press({ key: "fleet.band.toggle" });
    expect(open).toEqual([]);
    expect(JSON.stringify(await band.drawn())).toContain("Open fleet");
  }
});

test("the band yields to a survey", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  // The engine's own band, beneath the plugin: what a session draws when the
  // fleet hands the band on.
  on("ui.render", { component: "AbovePrompt" }, () => ({
    type: "Text", props: {}, children: ["the engine's own band"],
  }) as never);
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: "llm-fleet", surface, component: "AbovePrompt",
                                    props: { ...BAND_PROPS, hasSurvey: true } as never });
    const drawn = JSON.stringify(await band.drawn());
    expect(drawn).toContain("the engine's own band");
    expect(drawn).not.toContain("fleet.band.toggle");
  }
});

/**
 * A command's words, as the engine hands them over.
 *
 * The engine names what followed the command `args`. A plugin that read it
 * under any other name hears every `/fleet unhide` as a bare `/fleet`, and a
 * stub written from the same wrong name agrees with it, so this runs the
 * command through the engine's own call.
 */
test("/fleet unhide brings back what was dismissed, through the engine's command", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING }, [HIDDEN_KEY]: ["job:x:blocked"] });
  on("session.id", () => ({ value: "another-session" }) as never);
  const opened: string[] = [];
  on("ui.panes", () => ({ value: [] }) as never);
  on("ui.open", (_engine, e) => {
    opened.push((e as { id: string }).id);
    return { value: { isPlaced: true } } as never;
  });
  // The dismissal is read at startup, which is where a session reads it.
  await $.session.start({ surface: "terminal" } as never).catch(() => undefined);
  const ran = await $.command.run({ command: "fleet", args: "unhide" } as never);
  expect(JSON.stringify(ran)).toContain("shown again");
  expect(opened).toEqual([]);
});

/** What the alerts helper says about speech on a machine that has it. */
const VOICES = {
  state: "ready", reason: null, group: "female", voice: null,
  voices: { female: ["af_sky", "af_kore"], male: ["am_michael"] },
};

/**
 * `/speak` through the engine: the helper is asked for the voices, a line is
 * synthesized to a file, the engine reads its bytes and plays them, and the
 * file is discarded. Each of those is the engine's own call, answered beneath
 * the plugin, so a name or a shape the engine does not have fails here.
 */
test("/speak picks a voice, says hello in it, and keeps the pick", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  on("session.id", () => ({ value: "another-session" }) as never);
  const runs: string[][] = [];
  on("process.run", (_engine, e) => {
    const argv = (e as { argv: string[] }).argv;
    runs.push(argv);
    const verb = argv[2];
    const stdout = verb === "voices" ? JSON.stringify(VOICES)
      : verb === "speak" ? JSON.stringify({ file: "/tmp/fleet-speak-abc.wav", reason: null })
      : JSON.stringify(READING);
    return { value: { exitCode: 0, stdout, stderr: "" } } as never;
  });
  const read: string[] = [];
  on("fs.read", (_engine, e) => {
    read.push((e as { path: string }).path);
    return { value: { base64: "UklGRg==" } } as never;
  });
  const played: unknown[] = [];
  on("audio.play", (_engine, e) => {
    played.push(e);
    return { value: undefined } as never;
  });
  await $.session.start({ surface: "terminal" } as never).catch(() => undefined);
  const ran = await $.command.run({ command: "speak", args: "male" } as never);
  expect(JSON.stringify(ran)).toContain("Fleet speaks as am_michael now.");
  const speakRun = runs.find((argv) => argv[2] === "speak");
  expect(speakRun?.includes("--voice=am_michael")).toBe(true);
  expect(read).toEqual(["/tmp/fleet-speak-abc.wav"]);
  expect(played.length).toBe(1);
  expect(runs.some((argv) => argv[2] === "discard" && argv[3] === "/tmp/fleet-speak-abc.wav"))
    .toBe(true);
  const status = await $.command.run({ command: "speak", args: "" } as never);
  expect(JSON.stringify(status)).toContain("Fleet speaks as am_michael.");
});

/**
 * This session's figures come from the engine's own session calls, answered
 * beneath the plugin, so a call the engine does not have fails here rather than
 * leaving the section empty in a session.
 */
test("this session's section draws the engine's cost and model", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  on("session.id", () => ({ value: "another-session" }) as never);
  on("session.usage", () => ({ value: { startedAt: AT * 1000 - 600000, cost: { usd: 3.75 },
    context: { window: 200000, percent: 40 }, rateLimits: [] } }) as never);
  on("session.model", () => ({ value: "claude-opus-5-5" }) as never);
  on("session.version", () => ({ value: { version: "2.1.296" } }) as never);
  on("process.run", () => ({ value: { exitCode: 0, stdout: JSON.stringify(READING), stderr: "" } }) as never);
  await $.session.start({ surface: "terminal" } as never).catch(() => undefined);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane",
                                  requestId: "fleet", props: { ...PANE_PROPS, bodyColumns: 140 } as never });
  let drawn = "";
  for (let attempt = 0; attempt < 20 && !drawn.includes("$3.75"); attempt += 1) {
    drawn = JSON.stringify(await pane.drawn());
  }
  expect(drawn).toContain("$3.75");
  // The model is said the way a person says it, and the section opens with tiles.
  expect(drawn).toContain("\"opus 5.5\"");
  expect(drawn).not.toContain("claude-opus-5-5");
  expect(drawn).toContain("\"Cost\"");
});

/** Every node of a drawing of one element type, depth first. */
function ofType(node: unknown, type: string, found: Drawn[] = []): Drawn[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const record = node as Drawn;
  if (record.type === type) {
    found.push(record);
  }
  const children = Array.isArray(record.children) ? record.children : [record.children];
  for (const child of children) {
    ofType(child, type, found);
  }
  return found;
}

/**
 * The desktop draws a tile as a vector and the terminal as a bordered box, from
 * the same reading. The drawing is mounted through the host on each surface, so
 * an Svg the desktop's table refuses, or one handed to the terminal, which has
 * no Svg at all, fails here rather than as a blank pane.
 */
test("the desktop draws this session's tiles as vectors, and the terminal as text", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: READING } });
  on("session.id", () => ({ value: "another-session" }) as never);
  on("session.usage", () => ({ value: { startedAt: AT * 1000 - 600000, cost: { usd: 3.75 },
    context: { window: 200000, percent: 40 }, rateLimits: [] } }) as never);
  on("session.model", () => ({ value: "claude-opus-5-5" }) as never);
  on("session.version", () => ({ value: { version: "2.1.296" } }) as never);
  on("process.run", () => ({ value: { exitCode: 0, stdout: JSON.stringify(READING), stderr: "" } }) as never);
  await $.session.start({ surface: "terminal" } as never).catch(() => undefined);
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface, component: "Pane", requestId: "fleet",
                                    props: { ...PANE_PROPS, bodyColumns: 140 } as never });
    let drawn: unknown = null;
    for (let attempt = 0; attempt < 20 && !JSON.stringify(drawn).includes("$3.75"); attempt += 1) {
      drawn = await pane.drawn();
    }
    const vectors = ofType(drawn, "Svg");
    if (surface !== "terminal") {
      const cost = vectors.find((node) => node.props?.alt === "Cost: $3.75");
      expect(cost).toBeDefined();
      expect(String(cost?.props?.source)).toContain("$3.75");
      expect(String(cost?.props?.source).startsWith("<svg ")).toBe(true);
    } else {
      // The tile's own words, which a terminal Svg would have drawn as nothing:
      // the engine completes the terminal's table with an Svg that is a fragment.
      expect(vectors.length).toBe(0);
      expect(texts(drawn)).toContain("Cost");
      expect(texts(drawn)).toContain("$3.75");
    }
  }
});


/**
 * A reading with something to press on every kind of row: a waiting job with a
 * question and a suggested reply, a working job running subagent tasks, a job
 * that finished, a worktree with a cleanup line and one without, a pull request
 * with a page, a skill scan with its report command, and a branch tried again
 * after a failure.
 */
const ATTACH = "CLAUDE_CONFIG_DIR=/srv/provider-one claude attach job-2";
const WAITING = {
  provider: "one", id: "job-2", name: "Draft the migration", state: "blocked",
  label: "One", started_at: AT - 900, since: AT - 300, session_id: "job-2-session",
  needs: "Merge now or wait for review?", needs_hash: "hash-merge-or-wait",
  suggested_reply: "wait for review", attach_command: ATTACH,
};
/** What the helper says the waiting job asks now: the same question, in the same session. */
const STILL_ASKING = { state: "ready", needs: WAITING.needs, needsHash: WAITING.needs_hash,
                       sessionId: WAITING.session_id, held: true, reason: null };
const RICH = {
  ...READING,
  roster: {
    ...READING.roster,
    jobs: [
      WAITING,
      { provider: "one", id: "job-1", name: "Review adapter behavior", state: "working",
        label: "One", started_at: AT - 600, activity: "busy",
        attach_command: "CLAUDE_CONFIG_DIR=/srv/provider-one claude attach job-1",
        fan: [{ kind: "agent", label: "Read the adapter tests", startedAt: (AT - 120) * 1000 },
              { kind: "shell", label: "finished already", startedAt: (AT - 300) * 1000,
                doneAt: (AT - 200) * 1000 }] },
      { provider: "one", id: "job-3", name: "Tidy the changelog", state: "done", label: "One",
        started_at: AT - 7200, since: AT - 3600, detail: "Changelog trimmed to the release." },
    ],
    interactive: { one: 2 },
  },
  trials: {
    state: "ready", history: null, changes: [],
    running: [{ repo: "acme/app", branch: "fix/flaky", tool: "claude", expires_at: AT + 600,
                session: "s" }],
    recent: [{ key: "t1", repo: "acme/app", branch: "fix/flaky", change_state: "", at: AT - 900,
               is_green: false, passed: 40, failed: 2, errors: 0, skipped: 0 }],
  },
  prs: { state: "ready", prs: [{ repo: "acme/app", number: 42, title: "Speed up the reader",
                                 branch: "speed", head: "abc", is_draft: false, checks: "pass" }] },
  skills: { state: "ready", generated_at: AT - 600, running: null, new: [], items: [],
            counts: { clean: 10, flagged: 2, review: 3, failed: 1, reviewed: 4 },
            report_command: "python3 \"$HOME\"/scan.py report" },
  worktrees: { state: "ready", cleaned: null, worktrees: [
    { name: "lane-a", path: "/w/lane-a", branch: "feat/a", state: "merged", merged: true,
      archived: false, held: false, change_state: "PUSHED", change_owner: "codex",
      change_updated_at: AT - 7200, cleanup_command: "tool cleanup --worktree /w/lane-a" },
    { name: "lane-b", path: "/w/lane-b", branch: "", state: "unknown", merged: false,
      archived: false, held: null, error: "git timed out", cleanup_command: "" },
  ] },
  pane: {
    state: "ready",
    order: ["sessions", "trials", "prs", "skills", "worktrees", "warnings"],
    sections: Object.fromEntries(["sessions", "trials", "prs", "skills", "worktrees", "warnings"]
      .map((name) => [name, { visible: true, collapsed: false, maxRows: 8 }])),
    repliedLimit: 5,
  },
  alerts: { state: "ready", toast: true, notify: false, toastMs: 8000, copyToastMs: 4321,
            snapshotMs: 3000, snapshotSeconds: 20, progressMs: 1000, synthesisMs: 30000 },
};

/** The hooks a case registers beneath the plugin, as loosely as the kit takes them. */
type Beneath = (event: string, hook: (engine: unknown, e: unknown) => unknown) => void;

/** The props a pane is mounted with when it has room for every row of the rich reading. */
const WIDE = { ...PANE_PROPS, bodyColumns: 140 } as const;

/** The engine calls a press makes, answered beneath the plugin and recorded. */
function answerPresses(hooks: unknown,
                       options: { copies?: boolean; question?: unknown; delivered?: boolean;
                                  questionExit?: number } = {}) {
  const on = hooks as Beneath;
  const copied: { text: string; surface?: string }[] = [];
  const toasts: { text: string; timeoutMs?: number }[] = [];
  const sent: { to: unknown; text: string }[] = [];
  const asked: string[][] = [];
  const released: string[][] = [];
  const confirmed: string[][] = [];
  on("session.id", () => ({ value: "another-session" }) as never);
  // What a session's startup needs beneath the plugin, so the hook that reads
  // what was dismissed and replied runs rather than being skipped.
  on("command.register", () => ({ value: undefined }) as never);
  on("ui.copy", (_engine, e) => {
    copied.push(e as never);
    return { value: options.copies === false ? { isCopied: false, reason: "no-clipboard" }
      : { isCopied: true } } as never;
  });
  on("ui.toast", (_engine, e) => {
    toasts.push(e as never);
    return { value: undefined } as never;
  });
  on("session.send", (_engine, e) => {
    sent.push(e as never);
    // A send's hook answers with the result itself, as `next` resolves it.
    return (options.delivered === false ? { isDelivered: false, reason: "the session is gone" }
      : { isDelivered: true }) as never;
  });
  on("process.run", (_engine, e) => {
    const argv = (e as { argv: string[] }).argv;
    if (argv[2] === "release") {
      released.push(argv);
      return { value: { exitCode: 0, stdout: argv.includes("--prune-sent")
        ? JSON.stringify({ removed: 1 }) : "", stderr: "" } } as never;
    }
    if (argv[2] === "confirm") {
      confirmed.push(argv);
      return { value: { exitCode: 0, stdout: "", stderr: "" } } as never;
    }
    if (argv[2] === "question") {
      asked.push(argv);
      return { value: { exitCode: options.questionExit ?? 0, stderr: "",
                        stdout: JSON.stringify(options.question
                          ?? STILL_ASKING) } } as never;
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(RICH), stderr: "" } } as never;
  });
  return { copied, toasts, sent, asked, released, confirmed };
}


test("pressing a background job copies the line that opens it, and says so", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on);
  for (const surface of ["terminal", "desktop"] as const) {
    calls.copied.length = 0;
    calls.toasts.length = 0;
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface: surface, component: "Pane", requestId: "fleet", props: WIDE as never });
    await pane.drawn();
    await pane.press({ key: "fleet.job.one.job-2" });
    expect(calls.copied).toEqual([{ text: ATTACH, surface }]);
    expect(calls.toasts.length).toBe(1);
    expect(calls.toasts[0]?.text).toContain("copied");
    expect(calls.toasts[0]?.text).toContain(ATTACH);
    // The copy's own toast time, carried by the reading, not the alerts' one.
    expect(calls.toasts[0]?.timeoutMs).toBe(4321);
  }
});

test("a copy the surface refused says why and still shows the line", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on, { copies: false });
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.press({ key: "fleet.job.one.job-2" });
  expect(calls.toasts[0]?.text).toContain("could not copy");
  expect(calls.toasts[0]?.text).toContain("no-clipboard");
  expect(calls.toasts[0]?.text).toContain(ATTACH);
});

for (const surface of ["terminal", "desktop", "vscode"] as const) {
  test("a waiting job takes a reply in its field on the " + surface
       + ", sent to its session once its question still stands", async ($, on) => {
    mock.clock(on, { now: AT * 1000 });
    mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
    const calls = answerPresses(on);
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface, component: "Pane", requestId: "fleet", props: WIDE as never });
    const before = await pane.drawn();
    expect(texts(before)).toContain("suggests:");
    expect(texts(before)).toContain(" wait for review");
    expect(ofType(before, "Input").length).toBe(1);
    await pane.input({ key: "fleet.reply.one.job-2", text: "merge it" });
    // Asked first, then sent, to the job's own session.
    expect(calls.asked.length).toBe(1);
    expect(calls.asked[0]?.slice(3, 5)).toEqual(["one", "job-2"]);
    expect(calls.sent.length).toBe(1);
    expect(calls.sent[0]?.text).toBe("merge it");
    expect(JSON.stringify(calls.sent[0]?.to)).toContain("job-2-session");
    // Marked answered by this pane, recorded as sent once it went, and never released.
    expect(calls.asked[0]).toContain("--holder");
    expect(calls.confirmed.length).toBe(1);
    expect(calls.released.length).toBe(0);
    expect(calls.toasts.some((toast) => toast.text.includes("sent to Draft the migration")))
      .toBe(true);
    // Answered here, the job is not offered the field again for that question.
    const after = await pane.drawn();
    expect(ofType(after, "Input").length).toBe(0);
    expect(texts(after).some((value) => value.startsWith("replied;"))).toBe(true);
  });
}

test("an empty reply sends the job's own suggestion", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.input({ key: "fleet.reply.one.job-2", text: "   " });
  expect(calls.sent.map((message) => message.text)).toEqual(["wait for review"]);
});

test("a reply to a question the job has moved past is not sent", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on, { question: { ...STILL_ASKING, needs: "Which branch?",
                                                needsHash: "hash-which-branch" } });
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.input({ key: "fleet.reply.one.job-2", text: "merge it" });
  expect(calls.sent.length).toBe(0);
  expect(calls.toasts.some((toast) => toast.text.includes("no longer asking that"))).toBe(true);
  // Nothing went, so the field stays.
  expect(ofType(await pane.drawn(), "Input").length).toBe(1);
});

test("a reply is not sent when the job's own file names another session", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on, { question: { ...STILL_ASKING, sessionId: "job-2-restarted" } });
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.input({ key: "fleet.reply.one.job-2", text: "merge it" });
  expect(calls.sent.length).toBe(0);
  expect(calls.toasts.map((toast) => toast.text))
    .toContain("fleet: Draft the migration: this job's session changed; nothing sent");
  expect(ofType(await pane.drawn(), "Input").length).toBe(1);
});

test("a reply over the configured length is refused with the limit named, and nothing is asked", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: { ...RICH, pane: { ...RICH.pane, replyMaxChars: 5 } } } });
  const calls = answerPresses(on);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.input({ key: "fleet.reply.one.job-2", text: "merge it" });
  expect(calls.asked.length).toBe(0);
  expect(calls.sent.length).toBe(0);
  expect(calls.toasts.map((toast) => toast.text).join("\n")).toContain("over the limit of 5 (pane.replyMaxChars)");
});

test("a reply that could not reach the job says so and keeps the field", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on, { delivered: false });
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.input({ key: "fleet.reply.one.job-2", text: "merge it" });
  const said = calls.toasts.map((toast) => toast.text).join("\n");
  expect(said).toContain("could not reach Draft the migration (the session is gone)");
  expect(said).toContain(ATTACH);
  expect(ofType(await pane.drawn(), "Input").length).toBe(1);
});

test("a reply that may not have been sent says so, and its press clears it and offers the field", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  const pending = { ...RICH, roster: { ...RICH.roster, jobs: RICH.roster.jobs.map((job) =>
    job.id === "job-2" ? { ...job, reply: { state: "pending", at: AT - 600 } } : job) } };
  mock.store(on, { [READING_KEY]: { at: AT, documents: pending } });
  const calls = answerPresses(on);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  const before = await pane.drawn();
  expect(texts(before)).toContain("your reply may not have been sent");
  expect(ofType(before, "Input").length).toBe(0);
  await pane.press({ key: "fleet.resend.one.job-2" });
  expect(calls.released.length).toBe(1);
  expect(calls.released[0]).toContain("--stale");
  expect(calls.toasts.some((toast) => toast.text.includes("cleared the reply to Draft the migration")))
    .toBe(true);
  let after: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    after = await pane.drawn();
    if (ofType(after, "Input").length === 1) {
      break;
    }
  }
  expect(ofType(after, "Input").length).toBe(1);
});

test("a reply whose record does not read says so, and its press clears it and offers the field", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  const unreadable = { ...RICH, roster: { ...RICH.roster, jobs: RICH.roster.jobs.map((job) =>
    job.id === "job-2" ? { ...job, reply: { state: "unreadable", at: null, id: "7-1" } } : job) } };
  mock.store(on, { [READING_KEY]: { at: AT, documents: unreadable } });
  const calls = answerPresses(on);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  const before = await pane.drawn();
  expect(texts(before)).toContain("this reply's record could not be read");
  expect(ofType(before, "Input").length).toBe(0);
  await pane.press({ key: "fleet.unreadable.one.job-2" });
  expect(calls.released.length).toBe(1);
  expect(calls.released[0]).toContain("--unreadable");
  expect(calls.toasts.some((toast) => toast.text.includes("cleared the reply record for Draft the migration")))
    .toBe(true);
  let after: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    after = await pane.drawn();
    if (ofType(after, "Input").length === 1) {
      break;
    }
  }
  expect(ofType(after, "Input").length).toBe(1);
});

test("replies paused for too many held markers show on the row, and the press opens them again", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on, { questionExit: 1, question: {
    state: "full", needs: null, needsHash: null, sessionId: null, held: false,
    reason: "3 replies are held for jobs still waiting" } });
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  await pane.drawn();
  await pane.input({ key: "fleet.reply.one.job-2", text: "merge it" });
  expect(calls.sent.length).toBe(0);
  let paused: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    paused = await pane.drawn();
    if (texts(paused).includes("replies are paused: 3 replies are held for jobs still waiting")) {
      break;
    }
  }
  expect(texts(paused)).toContain("replies are paused: 3 replies are held for jobs still waiting");
  expect(ofType(paused, "Input").length).toBe(0);
  await pane.press({ key: "fleet.prune.one.job-2" });
  expect(calls.released.some((argv) => argv.includes("--prune-sent"))).toBe(true);
  let open: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    open = await pane.drawn();
    if (ofType(open, "Input").length === 1) {
      break;
    }
  }
  expect(ofType(open, "Input").length).toBe(1);
});

test("a job replied to in another session is not offered the field", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH },
                   [REPLIED_KEY]: ["one:job-2:job-2-session:hash-merge-or-wait"] });
  answerPresses(on);
  await $.session.start({ surface: "terminal", cwd: "/tmp" } as never).catch(() => undefined);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "terminal", component: "Pane", requestId: "fleet", props: WIDE as never });
  let drawn: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    drawn = await pane.drawn();
    if (ofType(drawn, "Input").length === 0) {
      break;
    }
  }
  expect(ofType(drawn, "Input").length).toBe(0);
  expect(texts(drawn).some((value) => value.startsWith("replied;"))).toBe(true);
});

test("the phone draws no field, so a press on the suggestion copies it", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on);
  const pane = await $.ui.mount({ plugin: "llm-fleet", surface: "mobile", component: "Pane", requestId: "fleet", props: WIDE as never });
  const drawn = await pane.drawn();
  expect(ofType(drawn, "Input").length).toBe(0);
  await pane.press({ key: "fleet.suggest.one.job-2" });
  expect(calls.copied.map((copy) => copy.text)).toEqual(["wait for review"]);
});

test("a worktree copies its cleanup line, or says why it has none", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on);
  for (const surface of SURFACES) {
    calls.copied.length = 0;
    calls.toasts.length = 0;
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface: surface, component: "Pane", requestId: "fleet", props: WIDE as never });
    const drawn = await pane.drawn();
    // The next step and who parked it, in the words the last pane used.
    expect(texts(drawn)).toContain("no changes yet; press to copy cleanup if unused parked 2h by codex");
    expect(texts(drawn)).toContain("could not check: git timed out");
    await pane.press({ key: "fleet.worktree./w/lane-a" });
    expect(calls.copied.map((copy) => copy.text)).toEqual(["tool cleanup --worktree /w/lane-a"]);
    await pane.press({ key: "fleet.worktree./w/lane-b" });
    expect(calls.copied.length).toBe(1);
    expect(calls.toasts.at(-1)?.text).toBe("fleet: no cleanup for lane-b: git timed out");
  }
});

test("the skills status line counts the scan and copies the report command", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  const calls = answerPresses(on);
  for (const surface of SURFACES) {
    calls.copied.length = 0;
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface: surface, component: "Pane", requestId: "fleet", props: WIDE as never });
    const words = texts(await pane.drawn()).join("");
    expect(words).toContain("Last scan 10m ago");
    expect(words).toContain("20 checked · 10 clean · 2 flagged · 3 to read"
                            + " · 1 could not finish · 4 reviewed");
    await pane.press({ key: "fleet.skills.report" });
    expect(calls.copied.map((copy) => copy.text)).toEqual(["python3 \"$HOME\"/scan.py report"]);
  }
});

test("a pull request's title is a link to its page on every surface", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH } });
  answerPresses(on);
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface: surface, component: "Pane", requestId: "fleet", props: WIDE as never });
    const links = ofType(await pane.drawn(), "Link");
    const link = links.find((node) => node.props?.href === "https://github.com/acme/app/pull/42");
    expect(link).toBeDefined();
    expect(texts(link)).toContain("#42 Speed up the reader");
  }
});

test("finished jobs, subagent tasks, interactive counts and a retried branch are drawn", async ($, on) => {
  mock.clock(on, { now: AT * 1000 });
  mock.store(on, { [READING_KEY]: { at: AT, documents: RICH }, [HIDDEN_KEY]: ["job:job-2:blocked:" + (AT - 300)] });
  answerPresses(on);
  await $.session.start({ surface: "terminal", cwd: "/tmp" } as never).catch(() => undefined);
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface: surface, component: "Pane", requestId: "fleet", props: WIDE as never });
    let words = "";
    for (let attempt = 0; attempt < 20 && !words.includes("hidden from the band"); attempt += 1) {
      words = texts(await pane.drawn()).join("\n");
    }
    // A job that finished is drawn quiet under the live ones, with its last word.
    expect(words).toContain("Tidy the changelog");
    expect(words).toContain(" · finished 1h ago");
    expect(words).toContain("Changelog trimmed to the release.");
    // A working job lists the subagent task it has open, and not the one it finished.
    expect(words).toContain("Read the adapter tests");
    expect(words).not.toContain("finished already");
    // The roster's interactive count, by the name the provider is shown under.
    expect(words).toContain("Interactive sessions:");
    expect(words).toContain("One 2");
    expect(words).toContain("1 hidden from the band; /fleet unhide shows them again.");
    // The branch tried again after a failure is one row, marked.
    expect(words).toContain("running, last try failed");
    expect(words).toContain("Esc or x closes this pane");
  }
});

test("the pane drawn before any reading still has its close control", async ($, on) => {
  mock.clock(on);
  const closed: string[] = [];
  on("ui.close", (_engine, e) => {
    closed.push((e as { id: string }).id);
    return { value: undefined } as never;
  });
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: "llm-fleet", surface, component: "Pane",
                                    requestId: "fleet", props: PANE_PROPS as never });
    const drawn = await pane.drawn();
    expect(texts(drawn)).toContain("Esc or x closes this pane");
    await pane.press({ key: "fleet.close" });
  }
  expect(closed).toEqual(SURFACES.map(() => "fleet"));
});
