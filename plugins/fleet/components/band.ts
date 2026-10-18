/**
 * The band above the prompt: the switch for the pane, and what needs a person.
 *
 * The pane is opened by a press here rather than by a typed command, and that
 * is the reason the band exists at all: a command typed while a turn runs waits
 * for the turn to end, and a press on a band button runs at once. So the switch
 * is always drawn, whatever the fleet holds.
 *
 * Beside it the band states the fleet in one line: how many sessions work and
 * wait, how many outcomes failed, and the worst thing that needs a person, with
 * the rest counted after it. Errors sort ahead of waits, so the first item is
 * the worst. This session's own job is left out, because a session telling its
 * own person that it is working is noise, and so is anything the person
 * dismissed.
 *
 * Beside the fleet's switch sits the voice's. Speech is one switch for every
 * session on the machine, so the word on it is what the store says, and a press
 * in any session is heard in all of them. Each button carries an icon: a glyph
 * a terminal draws in one cell where the surface is a terminal, and an emoji
 * where the surface draws pictures.
 */

import type { Color, Node } from "./host.ts";
import { chip } from "./cards.ts";
import { box, fit, text } from "./layout.ts";
import { mask } from "./mask.ts";
import { active, failedOutcomes, waiting, working } from "./pane.ts";
import type { Job, Snapshot } from "./state.ts";

/** The address of the band's switch, which is what a press comes back on. */
export const BAND_TOGGLE = "fleet.band.toggle";
/** The address of the button that hides what the band is showing. */
export const BAND_DISMISS = "fleet.band.dismiss";
/** The address of the switch that turns speech on or off in every session. */
export const BAND_SPEAK = "fleet.band.speak";
/** The address of a press on one of the band's figures, before the state it names. */
export const BAND_FOCUS = "fleet.band.focus.";
/** The address of a press on the item the band leads with. */
export const BAND_ITEM = "fleet.band.item.";

/** The cell the rule above the buttons is drawn from, written as a code point. */
const BAND_RULE = "─";

/** The icon each switch carries, as a terminal draws it and as a picture surface does. */
const ICONS = {
  terminal: { fleet: "\u2261", speaking: "\u266A", quiet: "\u266A" },
  pictures: { fleet: "\u{1F4CB}", speaking: "\u{1F50A}", quiet: "\u{1F507}" },
} as const;

function icons(surface: string | undefined) {
  return surface === undefined || surface === "terminal" ? ICONS.terminal : ICONS.pictures;
}

/** The fleet switch's word, which says which way a press goes, after its icon. */
export function fleetLabel(open: boolean, surface?: string): string {
  return icons(surface).fleet + " " + (open ? "Close fleet" : "Open fleet");
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
  /** How long after a job blocked it still leads the band rather than waiting in the pane. */
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

/** The source each kind of band item comes from, by the head of its key. */
const KEY_SOURCES: Record<string, string> = {
  job: "roster", trial: "trials", run: "progress", pr: "prs", skill: "skills",
};

/** The source a band key belongs to, or null for a key no source makes. */
function keySource(key: string): string | null {
  return KEY_SOURCES[key.slice(0, key.indexOf(":"))] ?? null;
}

/**
 * The sources that answered this reading: read ready or empty, with no error.
 *
 * Only such a source can say an item has gone. A roster with one provider
 * failing is ready with an error, and that provider's jobs are absent only
 * because nobody could ask.
 */
export function answeredSources(snapshot: Snapshot): Set<string> {
  const answered = new Set<string>();
  for (const name of Object.values(KEY_SOURCES)) {
    const document = snapshot[name as keyof Snapshot] as { state?: string; errors?: unknown[] };
    if ((document.state === "ready" || document.state === "empty")
        && (document.errors ?? []).length === 0) {
      answered.add(name);
    }
  }
  return answered;
}

/**
 * The dismissed keys to keep once a dismissal is written.
 *
 * A key that names nothing the band could show now is dropped, since it hides
 * nothing, but only when its source answered this reading: an item absent
 * because its source failed is still dismissed when the source recovers. The
 * keys just dismissed go last, each kept once, and only the newest `limit` are
 * kept. Without `answered`, every source is taken to have answered.
 */
export function keptHidden(hidden: readonly string[], current: readonly string[],
                           dismissing: readonly string[], limit: number,
                           answered: ReadonlySet<string> | null = null): string[] {
  const live = new Set(current);
  const fresh = new Set(dismissing);
  const unasked = (key: string): boolean => {
    const source = keySource(key);
    return answered !== null && source !== null && !answered.has(source);
  };
  const kept = hidden.filter((key) => (live.has(key) || unasked(key)) && !fresh.has(key));
  return [...new Set([...kept, ...dismissing])].slice(-limit);
}

/** What a new skill finding says on the band, and whether it is an error or a wait. */
function skillItem(skill: Snapshot["skills"]["new"][number]): BandItem {
  const key = "skill:" + skill.target + ":" + skill.verdict + ":" + skill.hash;
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

/** Change states after which a failed trial no longer needs anybody. */
const SETTLED_CHANGES = new Set(["MERGED", "CLEANED"]);

/**
 * Everything in a reading that needs a person, worst first.
 *
 * A failed trial on a change still open, a run with failures, a pull request
 * whose checks fail and a newly flagged skill are errors; a session waiting on
 * its person, and a new skill finding to read or a scan that could not finish,
 * are waits. The key of each carries what makes it the same item next time, so
 * a dismissed item stays hidden until it changes: a session that waits a second
 * time is a new item.
 *
 * A job that blocked longer ago than `waitingJobSeconds` is parked rather than
 * waiting on its person now, so it stays in the pane and off the band; the age
 * is read against `now`, or against the reading's own clock without one. A job
 * no read has dated is kept, since nothing shows it to be parked.
 */
export function bandItems(snapshot: Snapshot, dismissed: readonly string[],
                          sessionId: string,
                          settings: BandConfig & { now?: number } = BAND_DEFAULTS): BandItem[] {
  const hidden = new Set(dismissed);
  const errors: BandItem[] = [];
  const waits: BandItem[] = [];
  const now = settings.now ?? snapshot.generated_at;
  for (const trial of snapshot.trials.recent) {
    if (!trial.is_green && !SETTLED_CHANGES.has(trial.change_state)) {
      errors.push({ key: "trial:" + trial.key, level: "error",
                    text: "Trial failed on " + said(trial.repo) + " " + said(trial.branch) + ": "
                      + (trial.failed + trial.errors) + " failed" });
    }
  }
  for (const run of snapshot.progress.runs) {
    if (run.failed > 0) {
      errors.push({ key: "run:" + run.key + ":" + run.failed, level: "error",
                    text: said(run.label || run.display) + ": " + run.failed + " failed" });
    }
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
  /** What needs a person, worst first; empty when nothing does. */
  items: BandItem[];
  /** The figures, or null while there is no reading or the roster could not be read. */
  counts: BandCounts | null;
  /** Why there are no figures, when that is the case, such as a read in flight. */
  note?: string;
  /** Whether the pane is open, which is what the switch's word says. */
  open: boolean;
  /** The cells the band is laid out in. */
  width: number;
  /** The surface drawing the band, which picks the icons; a terminal when absent. */
  surface?: string;
  /** Whether speech is on in every session; the speech switch is drawn only with `onSpeak`. */
  speaking?: boolean;
  onToggle: () => unknown;
  onDismiss: () => void;
  onSpeak?: () => unknown;
  /**
   * Open the pane, narrowed to one of the figures, or to the whole fleet.
   *
   * The band is on screen while the pane is shut, which is when a person reads
   * a count and wants the rows behind it; without this the figure is a number
   * they have to go and find.
   */
  onOpen?: (focus?: "working" | "waiting" | "failed") => unknown;
};

/** The cells a button adds around its label: "[ " before it and " ]" after. */
const BUTTON_CHROME = 4;
/** The cells between two parts of the band's line. */
const PART_GAP = 2;

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
 * The figures follow on chips, a figure at zero left out, and then the worst
 * item in its own color with the rest counted after it. Dismiss is offered only
 * when there is something to dismiss. A line too long for the band is cut from
 * the item's end, never from the switch or the figures.
 */
export function bandTree(input: BandInput): Node {
  const toggle = fleetLabel(input.open, input.surface);
  const parts: Node[] = [button(BAND_TOGGLE, toggle, input.onToggle, !input.open)];
  // What the line takes as the terminal draws it: a button is its label in
  // "[ " and " ]", a chip is its word with a cell of fill at each side, and
  // every part after the first sits two cells from the one before.
  let used = toggle.length + BUTTON_CHROME;
  if (input.onSpeak !== undefined) {
    const speaking = input.speaking === true;
    const word = speakLabel(speaking, input.surface);
    parts.push(button(BAND_SPEAK, word, input.onSpeak, speaking));
    used += PART_GAP + word.length + BUTTON_CHROME;
  }
  const figures: [number, string, Color, "working" | "waiting" | "failed"][] =
    input.counts === null ? [] : [
      [input.counts.working, "working", "success", "working"],
      [input.counts.waiting, "waiting", "warning", "waiting"],
      [input.counts.failed, "failed", "error", "failed"],
    ];
  for (const [count, word, color, focus] of figures) {
    if (count > 0) {
      const label = count + " " + word;
      const drawn = chip(label, color);
      // The figure is the way to the rows it counts: a press opens the pane
      // already narrowed to them.
      parts.push(input.onOpen === undefined ? drawn
        : { type: "Button", props: { key: BAND_FOCUS + focus, label,
                                     onPress: () => input.onOpen?.(focus) },
            children: [drawn] });
      used += PART_GAP + label.length + 2;
    }
  }
  if (input.counts !== null && figures.every(([count]) => count === 0)) {
    parts.push(text({ dimColor: true }, "Nothing running"));
    used += PART_GAP + "Nothing running".length;
  }
  if (input.counts === null && input.note) {
    parts.push(text({ dimColor: true }, input.note));
    used += PART_GAP + input.note.length;
  }
  const dismiss = input.items.length > 0;
  // A band too narrow for the whole line says the speech switch's state with
  // its icon alone, before anything the person needs to read is cut.
  const fixed = used + (dismiss ? PART_GAP + "Dismiss".length + BUTTON_CHROME : 0);
  if (input.onSpeak !== undefined && fixed > input.width) {
    const speaking = input.speaking === true;
    const full = speakLabel(speaking, input.surface);
    const short = speakLabel(speaking, input.surface, true);
    parts[1] = button(BAND_SPEAK, short, input.onSpeak, speaking);
    used -= full.length - short.length;
  }
  const room = input.width - used - PART_GAP
    - (dismiss ? PART_GAP + "Dismiss".length + BUTTON_CHROME : 0);
  const [first, ...others] = input.items;
  if (first !== undefined && room > 8) {
    const failing = others.filter((item) => item.level === "error").length;
    const waits = others.length - failing;
    const rest = [failing > 0 ? failing + " more failing" : "",
                  waits > 0 ? waits + " more waiting" : ""].filter(Boolean).join(", ");
    const lead = fit(first.text, Math.max(4, room - (rest ? rest.length + 3 : 0)));
    const words: Node[] = [
      text({ color: first.level, bold: true, wrap: "truncate-end" }, lead),
      ...(rest && lead.length + rest.length + 3 <= room
        ? [text({ dimColor: true }, " · " + rest)] : []),
    ];
    // What the band leads with is the way into it: a press opens the pane,
    // where the row it names is drawn with the rest of what it says.
    parts.push(box({ flexDirection: "row", gap: 0, flexShrink: 1 },
                   input.onOpen === undefined ? words
                     : [{ type: "Button",
                          props: { key: BAND_ITEM + first.key, label: lead,
                                   onPress: () => input.onOpen?.() },
                          children: words }]));
  }
  const left = box({ flexDirection: "row", gap: 2, flexShrink: 1 }, parts);
  const row = dismiss
    ? box({ flexDirection: "row", justifyContent: "space-between", gap: 2 }, [
        left,
        button(BAND_DISMISS, "Dismiss", input.onDismiss),
      ])
    : box({ flexDirection: "row", gap: 0 }, [left]);
  // A rule across the band sets it apart from whatever the session drew above it,
  // so the buttons read as the fleet's own line. It is drawn dim: it separates
  // without competing with the figures and the item beside it.
  return box({ flexDirection: "column", gap: 0, marginBottom: 0 }, [
    text({ dimColor: true }, BAND_RULE.repeat(Math.max(0, input.width))),
    row,
  ]);
}
