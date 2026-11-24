/**
 * The band above the prompt: the switch for the pane, and what needs a person.
 *
 * The pane is opened by a press here rather than by a typed command, and that
 * is the reason the band exists at all: a command typed while a turn runs waits
 * for the turn to end, and a press on a band button runs at once. So the switch
 * is always drawn, whatever the fleet holds.
 *
 * Beside it the band states the fleet in one line: how many sessions work and
 * wait, how many outcomes failed, and what this session has spent. Each figure
 * is a press that opens the pane already narrowed to the rows it counts, and
 * the same figure pressed again widens it, so the band is a look rather than a
 * one-way door. This session's own job is left out, because a session telling
 * its own person that it is working is noise.
 *
 * Beside the fleet's switch sits the voice's. Speech is one switch for every
 * session on the machine, so the word on it is what the store says, and a press
 * in any session is heard in all of them. Beside the voice sits pacer's switch
 * when the machine runs pacer: it says whether the machine's run slots are on,
 * and it is not drawn at all for a person who does not run that tooling. Each
 * button carries an icon: a glyph a terminal draws in one cell where the surface
 * is a terminal, and an emoji where the surface draws pictures.
 */

import type { Color, Node } from "./host.ts";
import { chip } from "./cards.ts";
import { box, fit, pressable, text } from "./layout.ts";
import { mask } from "./mask.ts";
import { active, failedOutcomes, waiting, working } from "./pane.ts";
import type { Job, Snapshot } from "./state.ts";

/** The address of the band's switch, which is what a press comes back on. */
export const BAND_TOGGLE = "fleet.band.toggle";
/** The address of the switch that turns speech on or off in every session. */
export const BAND_SPEAK = "fleet.band.speak";
/** The address of pacer's switch, which is the machine's one gear. */
export const BAND_PACER = "fleet.band.pacer";
/** The address of a press on one of the band's figures, before the state it names. */
export const BAND_FOCUS = "fleet.band.focus.";

/** The cell the rule above the buttons is drawn from, written as a code point. */
const BAND_RULE = "─";

/** The icon each switch carries, as a terminal draws it and as a picture surface does. */
const ICONS = {
  terminal: { fleet: "\u2261", speaking: "\u266A", quiet: "\u266A", gear: "\u2699" },
  pictures: { fleet: "\u{1F4CB}", speaking: "\u{1F50A}", quiet: "\u{1F507}",
              gear: "\u2699\ufe0f" },
} as const;

function icons(surface: string | undefined) {
  return surface === undefined || surface === "terminal" ? ICONS.terminal : ICONS.pictures;
}

/**
 * The fleet switch's word, which says which way a press goes, after its icon;
 * `short` keeps the icon and the verb alone, for a band too narrow for the
 * product's name.
 */
export function fleetLabel(open: boolean, surface?: string, short = false): string {
  const word = short ? (open ? "Close" : "Open") : (open ? "Close llm-fleet" : "Open llm-fleet");
  return icons(surface).fleet + " " + word;
}

/**
 * The speech switch's word, which says how speech stands in every session,
 * after its icon; `short` keeps the icon and the state alone, for a narrow band.
 */
export function speakLabel(speaking: boolean, surface?: string, short = false): string {
  const set = icons(surface);
  const word = short ? "" : "Speak: ";
  return speaking ? set.speaking + " " + word + "on" : set.quiet + " " + word + "off";
}

/**
 * Pacer's switch word, after the gear: on, off, or not read when pacer did not
 * say, and "off?" while a first press to switch it off waits for the second.
 */
export function pacerLabel(enabled: boolean | null, surface?: string, short = false,
                           confirming = false): string {
  const word = enabled === true ? (confirming ? "off?" : "on")
    : enabled === false ? "off" : "not read";
  return icons(surface).gear + " " + (short ? "" : "Pacer ") + word;
}

/** One thing the band can lead with, under a key that names it across readings. */
export type BandItem = {
  key: string;
  level: "error" | "warning";
  text: string;
};

/** The figures the band states, or null when there is no reading to state them from. */
export type BandCounts = { working: number; waiting: number; failed: number };

/**
 * Whether a job is this session's own.
 *
 * A job's id is the head of its session's identifier, and a job may carry the
 * whole identifier too; either one matching is the same session.
 */
export function isOwnJob(job: Job, sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  if (job.session_id && job.session_id === sessionId) {
    return true;
  }
  return job.id !== "" && sessionId.startsWith(job.id);
}

/** What a value says once anything secret in it is masked. */
function said(value: string | null | undefined): string {
  return mask(value ?? "").text;
}

/** What the band shows and keeps, as the reading carries it. */
export type BandConfig = {
  /** How many dismissed keys are kept: the newest. */
  hiddenLimit: number;
  /** How long after a job blocked it still counts as waiting: past it the tab holds no level for it. */
  waitingJobSeconds: number;
};

/** The schema's defaults, for a reading that carries no band document or an unusable value. */
export const BAND_DEFAULTS: BandConfig = { hiddenLimit: 200, waitingJobSeconds: 86_400 };

/** The band settings a reading carries, each one the default when it is not a whole number above nought. */
export function bandConfigFrom(documents: unknown): BandConfig {
  const carried = (documents as { band?: Record<string, unknown> } | null)?.band;
  if (typeof carried !== "object" || carried === null) {
    return BAND_DEFAULTS;
  }
  const whole = (key: keyof BandConfig): number => {
    const value = carried[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 1
      ? value : BAND_DEFAULTS[key];
  };
  return { hiddenLimit: whole("hiddenLimit"), waitingJobSeconds: whole("waitingJobSeconds") };
}

/**
 * The dismissal limit a reading carries, or null when it carries none.
 *
 * Unlike `bandConfigFrom`, no default stands in: a reading without a limit says
 * nothing about how many dismissals to keep, so it is no reason to cut them.
 */
export function hiddenLimitFrom(documents: unknown): number | null {
  const carried = (documents as { band?: Record<string, unknown> } | null)?.band;
  const value = typeof carried === "object" && carried !== null ? carried.hiddenLimit : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Whether a finding is in the owner's own skills.
 *
 * A row under a plugin install, a synced copy or a built-in is other people's
 * code: the pane shows it and neither the band nor an alert interrupts for it.
 * A reading written before rows carried a scope is his, because there was
 * nothing else for it to be.
 */
export function hisSkill(scope: string | undefined): boolean {
  return scope === undefined || scope === "own";
}

/** What a new skill finding says on the band, and whether it is an error or a wait. */
function skillItem(skill: Snapshot["skills"]["new"][number]): BandItem {  const key = "skill:" + skill.target + ":" + skill.verdict + ":" + skill.hash;
  if (skill.verdict === "flagged") {
    return { key, level: "error",
             text: "Skill flagged: " + said(skill.name) + ", " + said(skill.issue) };
  }
  if (skill.verdict === "failed") {
    return { key, level: "warning", text: "Skill scan could not finish: " + said(skill.name) };
  }
  return { key, level: "warning",
           text: "Skill to read: " + said(skill.name) + ", " + said(skill.issue) };
}

/**
 * Everything in a reading that needs a person, worst first.
 *
 * A run pacer refused, a pull request whose checks fail and a newly flagged
 * skill are errors; a session waiting on its person, and a new skill finding to
 * read or a scan that could not finish, are waits. The key of each carries what makes it the same item next time, so
 * a dismissed item stays hidden until it changes: a session that waits a second
 * time is a new item.
 *
 * A job that blocked longer ago than `waitingJobSeconds` is parked rather than
 * waiting on its person now, so it is no item at all and the tab holds no level
 * for it; the age is read against `now`, or against the reading's own clock
 * without one. A job no read has dated is kept, since nothing shows it parked.
 */
export function bandItems(snapshot: Snapshot, dismissed: readonly string[],
                          sessionId: string,
                          settings: BandConfig & { now?: number } = BAND_DEFAULTS): BandItem[] {
  const hidden = new Set(dismissed);
  const errors: BandItem[] = [];
  const waits: BandItem[] = [];
  const now = settings.now ?? snapshot.generated_at;
  // A run pacer refused, and that alone. A command that failed inside a run
  // already said so where it ran, and repeating it here is a line a person
  // dismisses every time without learning anything; the run stays in the pane.
  //
  // A refusal is one item per repository and reason, however many times it
  // repeats. Its key carries those two and never the time, so dismissing it
  // once holds: a machine that refuses the same run all afternoon asks its
  // person once, and says how many times it happened.
  const refusals = new Map<string, { repo: string | null; reason: string | null;
                                     count: number; at: number }>();
  for (const run of snapshot.pacer?.recent ?? []) {
    if (run.mode !== "refused") {
      continue;
    }
    const key = "pacer:" + (run.repo ?? "") + ":" + (run.reason ?? "");
    const held = refusals.get(key);
    if (held === undefined) {
      refusals.set(key, { repo: run.repo, reason: run.reason, count: 1, at: run.at });
    } else {
      held.count += 1;
      held.at = Math.max(held.at, run.at);
    }
  }
  const refused = [...refusals].sort((first, second) => second[1].at - first[1].at);
  for (const [key, held] of refused) {
    errors.push({ key, level: "error",
                  text: "Pacer refused " + (held.count === 1 ? "a run" : held.count + " runs")
                    + " in " + said(held.repo ?? "a repository")
                    + (held.reason ? ": " + said(held.reason) : "") });
  }
  for (const pull of snapshot.prs.prs) {
    if (pull.checks === "fail") {
      errors.push({ key: "pr:" + pull.repo + "#" + (pull.number ?? "") + ":" + pull.head,
                    level: "error",
                    text: "PR " + (pull.number === null ? "" : pull.number + " ")
                      + "checks failing: " + said(pull.title) });
    }
  }
  for (const skill of snapshot.skills.new) {
    if (!hisSkill(skill.scope)) {
      continue;
    }
    const item = skillItem(skill);
    (item.level === "error" ? errors : waits).push(item);
  }
  for (const job of snapshot.roster.jobs) {
    const dated = job.since !== null && job.since !== undefined;
    if (dated && now - (job.since as number) > settings.waitingJobSeconds) {
      continue;
    }
    if (waiting(job) && !isOwnJob(job, sessionId)) {
      const since = dated ? ":" + Math.trunc(job.since as number) : "";
      waits.push({ key: "job:" + job.id + ":blocked" + since, level: "warning",
                   text: said(job.name) + " is waiting for you" });
    }
  }
  return [...errors, ...waits].filter((item) => !hidden.has(item.key));
}

/**
 * The figures the band states, counted the way the pane's head counts them,
 * less this session's own job: the band leaves that job out of its items, and a
 * figure that counted it would say "1 waiting" beside nothing that waits.
 */
export function bandCounts(snapshot: Snapshot, sessionId = ""): BandCounts | null {
  if (snapshot.roster.state !== "ready") {
    return null;
  }
  const jobs = snapshot.roster.jobs.filter((job) => !isOwnJob(job, sessionId));
  return {
    working: jobs.filter((job) => working(job) || active(job)).length,
    waiting: jobs.filter(waiting).length,
    failed: failedOutcomes(snapshot),
  };
}

export type BandInput = {
  /** The figures, or null while there is no reading or the roster could not be read. */
  counts: BandCounts | null;
  /**
   * What this session has spent, as its chip says it: the figure with a `~`
   * when it was priced rather than billed. Absent or null when nothing priced
   * it, and the chip is not drawn, since a spend of nothing and no spend read
   * are different claims.
   */
  spend?: string | null;
  /** Why there are no figures, when that is the case, such as a read in flight. */
  note?: string;
  /**
   * How many items need the person, after the person's own dismissals.
   *
   * The band's figures count sessions and failing checks; an item can need a
   * person with every figure at zero, a flagged skill with no job beside it.
   * The line says so rather than calling a machine with something to answer a
   * quiet one. Absent where the caller keeps no items.
   */
  attention?: number;
  /** Whether the pane is open, which is what the switch's word says. */
  open: boolean;
  /** The cells the band is laid out in. */
  width: number;
  /** The surface drawing the band, which picks the icons; a terminal when absent. */
  surface?: string;
  /** Whether speech is on in every session; the speech switch is drawn only with `onSpeak`. */
  speaking?: boolean;
  onToggle: () => unknown;
  onSpeak?: () => unknown;
  /**
   * Pacer's switch, drawn only on a machine that runs pacer.
   */
  pacer?: { enabled: boolean | null; confirming?: boolean } | null;
  onPacer?: () => unknown;
  /**
   * Open the pane, narrowed to one of the figures.
   *
   * The band is on screen while the pane is shut, which is when a person reads
   * a count and wants the rows behind it; without this the figure is a number
   * they have to go and find. The same press widens the pane again, so a figure
   * is a look rather than a state the person has to undo.
   */
  onOpen?: (focus: "working" | "waiting" | "failed") => unknown;
};

/** The cells a button adds around its label: "[ " before it and " ]" after. */
const BUTTON_CHROME = 4;
/** The cells between two parts of the band's line. */
const PART_GAP = 2;

/** How many cells the host draws a button in: its label and the chrome around it. */
function buttonCells(label: string): number {
  return label.length + BUTTON_CHROME;
}

/** How many cells a chip draws: its word with a cell of fill at each side. */
function chipCells(value: string): number {
  return value.length + 2;
}

/** One button, as the host draws a press: the address it comes back on, and its word. */
function button(key: string, label: string, onPress: () => unknown, primary = false): Node {
  return { type: "Button",
           props: { key, label, onPress, ...(primary ? { variant: "primary" as const } : {}) },
           children: [] };
}

/**
 * The band's one line.
 *
 * The switch leads, so it sits in the same place whatever else the line holds.
 * The figures follow on chips, a figure at zero left out, each a press that
 * opens the pane narrowed to what it counted. A line too long for the band is
 * cut from its last part, never from the switch or the figures.
 */
export function bandTree(input: BandInput): Node {
  const toggle = fleetLabel(input.open, input.surface);
  const parts: Node[] = [button(BAND_TOGGLE, toggle, input.onToggle, !input.open)];
  // What the line takes as the terminal draws it: a button is its label in
  // "[ " and " ]", a chip is its word with a cell of fill at each side, and
  // every part after the first sits two cells from the one before.
  let used = buttonCells(toggle);
  let speakAt = -1;
  let speakCells = 0;
  if (input.onSpeak !== undefined) {
    const speaking = input.speaking === true;
    const word = speakLabel(speaking, input.surface);
    speakAt = parts.length;
    parts.push(button(BAND_SPEAK, word, input.onSpeak, speaking));
    speakCells = PART_GAP + buttonCells(word);
    used += speakCells;
  }
  // Pacer's switch sits beside the voice's, and only while the machine runs
  // pacer: a person who does not run that tooling never sees the gear.
  const pacing = input.pacer !== undefined && input.pacer !== null
    && input.onPacer !== undefined;
  const gear: { key: string; press: () => unknown; label: (short: boolean) => string } | null =
    pacing ? { key: BAND_PACER, press: input.onPacer as () => unknown,
               label: (short) => pacerLabel(input.pacer?.enabled ?? null, input.surface, short,
                                            input.pacer?.confirming === true) }
    : null;
  let gearAt = -1;
  let gearCells = 0;
  if (gear !== null) {
    const word = gear.label(false);
    gearAt = parts.length;
    parts.push(button(gear.key, word, gear.press));
    gearCells = PART_GAP + buttonCells(word);
    used += gearCells;
  }
  const figures: [number, string, Color, "working" | "waiting" | "failed"][] =
    input.counts === null ? [] : [
      [input.counts.working, "working", "success", "working"],
      [input.counts.waiting, "waiting", "warning", "waiting"],
      [input.counts.failed, "failed", "error", "failed"],
    ];
  // A figure a press opens the pane from is a button, and the host draws a
  // button wider than the chip inside it: counting it as a chip left the line
  // two cells short of what it draws, for every figure on it.
  const figureStart = parts.length;
  const figureCells: number[] = [];
  for (const [count, word, color, focus] of figures) {
    if (count > 0) {
      const label = count + " " + word;
      const drawn = chip(label, color);
      // The figure is the way to the rows it counts: a press opens the pane
      // already narrowed to them.
      parts.push(input.onOpen === undefined ? drawn
        : { type: "Button", props: { key: BAND_FOCUS + focus, label,
                                     onPress: () => input.onOpen?.(focus) },
            children: pressable([drawn]) });
      const cells = PART_GAP + (input.onOpen === undefined
        ? chipCells(label) : buttonCells(label));
      figureCells.push(cells);
      used += cells;
    }
  }
  // Items that need the person are a fact the line keeps even with no figures:
  // a roster that is unread or disabled leaves `counts` null, and dropping the
  // count there hid the one thing on the machine to answer. Found by review,
  // 2026-11-23.
  const needs = input.attention !== undefined && input.attention > 0
    ? input.attention + (input.attention === 1 ? " needs you" : " need you")
    : null;
  // A nonzero figure says what is running, not that nothing needs the person:
  // a failure beside a working job was dropped for the figure that did draw,
  // and the band's one cue out of the pane went with it. `needs` is drawn at
  // every roster state; "Nothing running" only when the figures agree there is
  // nothing. Found by review, 2026-11-23.
  const idle = input.counts !== null && figures.every(([count]) => count === 0);
  const quiet = needs ?? (idle ? "Nothing running" : null);
  let quietAt = -1;
  if (quiet !== null) {
    // The items themselves are no longer drawn here, so the line says how many
    // there are and leaves the rows to the pane.
    quietAt = parts.length;
    parts.push(text({ dimColor: true }, quiet));
    used += PART_GAP + quiet.length;
  }
  // What this session has spent, beside the figures: it is the one number about
  // this session a person wants without opening the pane, and the pane's own
  // tiles are only read once it is open.
  let spendAt = -1;
  const spend = input.spend ?? null;
  if (spend !== null && spend !== "") {
    spendAt = parts.length;
    parts.push(chip(spend, "subtle"));
    used += PART_GAP + chipCells(spend);
  }
  if (input.counts === null) {
    // With no figures the line still says what needs the person, and the note
    // why the figures are absent takes the room that is left: the note is cut
    // to fit, so a count of items must be drawn before it rather than after.
    if (input.note) {
      // The note is the last part and the least of them, so it is cut to the
      // room that is left rather than drawing the line past its width.
      const note = fit(input.note, Math.max(0, input.width - used - PART_GAP));
      if (note !== "") {
        parts.push(text({ dimColor: true }, note));
        used += PART_GAP + note.length;
      }
    }
  }
  // The spend chip goes first, then the product's name, then the speech
  // switch's state word, then pacer's, then figures from the least urgent end.
  // The chip is a number a person can find on the pane's own tiles; a switch
  // that lost its word would read as a control nobody can name. The fleet's
  // switch is never given up, and the line is one row at every width.
  if (spendAt >= 0 && used > input.width) {
    parts.splice(spendAt, 1);
    used -= PART_GAP + chipCells(spend as string);
  }
  let fixed = used;
  if (fixed > input.width) {
    const short = fleetLabel(input.open, input.surface, true);
    parts[0] = button(BAND_TOGGLE, short, input.onToggle, !input.open);
    used -= toggle.length - short.length;
    fixed = used;
  }
  if (input.onSpeak !== undefined && fixed > input.width) {
    const speaking = input.speaking === true;
    const full = speakLabel(speaking, input.surface);
    const short = speakLabel(speaking, input.surface, true);
    parts[speakAt] = button(BAND_SPEAK, short, input.onSpeak, speaking);
    used -= full.length - short.length;
    speakCells -= full.length - short.length;
  }
  if (gear !== null && gearAt >= 0 && used > input.width) {
    const full = gear.label(false);
    const short = gear.label(true);
    parts[gearAt] = button(gear.key, short, gear.press);
    used -= full.length - short.length;
    gearCells -= full.length - short.length;
  }
  let dropped = 0;
  while (used > input.width && dropped < figureCells.length) {
    used -= figureCells[dropped] as number;
    dropped += 1;
  }
  if (dropped > 0) {
    parts.splice(figureStart, dropped);
    // The count stands after the figures, so every figure given up moves it,
    // and addressing the old place would cut a figure's text or put the count
    // past the end of the line. Found by review, 2026-11-23.
    if (quietAt >= figureStart + dropped) {
      quietAt -= dropped;
    }
  }
  // What needs a person is the line's one cue out of the pane, so it outranks
  // the controls beside it: a control is named again inside the pane, while an
  // item that needs the person is on no other line. The gear goes first, then
  // the voice, and the count is cut only when the switch alone leaves no room.
  // Found by review, 2026-11-23.
  if (quiet !== null && used > input.width && gearCells > 0) {
    parts.splice(gearAt, 1);
    used -= gearCells;
    gearCells = 0;
    // The count is still in the line, and a part removed before it moves its
    // place: addressing the old index would leave a hole where it was.
    if (gearAt < quietAt) {
      quietAt -= 1;
    }
  }
  if (quiet !== null && used > input.width && speakCells > 0) {
    parts.splice(speakAt, 1);
    used -= speakCells;
    speakCells = 0;
    if (speakAt < quietAt) {
      quietAt -= 1;
    }
  }
  if (quiet !== null && used > input.width) {
    const before = used - PART_GAP - quiet.length;
    const cut = fit(quiet, Math.max(0, input.width - before - PART_GAP));
    if (cut === "") {
      parts.splice(quietAt, 1);
      used = before;
    } else if (cut !== quiet) {
      parts[quietAt] = text({ dimColor: true }, cut);
      used = before + PART_GAP + cut.length;
    }
  }
  const row = box({ flexDirection: "row", gap: 0 }, [
    box({ flexDirection: "row", gap: 2, flexShrink: 1 }, parts),
  ]);
  // A rule across the band sets it apart from whatever the session drew above it,
  // so the buttons read as the fleet's own line. It is drawn dim: it separates
  // without competing with the figures beside it.
  return box({ flexDirection: "column", gap: 0, marginBottom: 0 }, [
    text({ dimColor: true }, BAND_RULE.repeat(Math.max(0, input.width))),
    row,
  ]);
}
