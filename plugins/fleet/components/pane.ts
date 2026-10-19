/**
 * The pane's view model: reader rows in, layout descriptions out.
 *
 * This is where the honesty rules of the design live, and it is a pure function
 * so each of them can be tested without a terminal: a group that was never read
 * is not an empty group, a stale row says how old it is, a count is never
 * invented, and the same entity is never counted twice under two headings.
 */

import type { Control, Digest, Group, Pane, PickerItem, Row, RowLine, GroupState, Slot,
              Spark } from "./layout.ts";
import { ageText, countLabel, durationText, fit } from "./layout.ts";
import { mask, MASK } from "./mask.ts";
import { THEME, worktreeToken, type Theme } from "./palette.ts";
import { money, spendWindowTile } from "./session.ts";
import { FOOTER_TEXT } from "./version.ts";

// The money rule lives with the session figures it prices; this module drew it
// before the machine-wide spend tile needed the same rule in that module.
export { money };
import type {
  AgentFigures, Job, Load, LoadProcess, Progress, PullRequest, PullRequests, Roster, Run,
  SessionFigures, SkillItem, Skills, Snapshot, SpendSeries, Trial, Trials, Worktree, Worktrees,
  Change, CustomRow, CustomSection } from "./state.ts";

/** The prefix a section a person added is named by in the order. */
export const CUSTOM_PREFIX = "custom:";

/**
 * The keys the pane draws with, and the tips it shows beside them.
 *
 * Every binding here is one the pane's own controls carry, which is what makes
 * the keys section a description of this pane rather than a list of shortcuts a
 * person has to hope apply here.
 */
export type PaneKeys = {
  tipsEnabled: boolean;
  tips: string[];
  close: string;
  collapse: string;
  expand: string;
};

/**
 * The packaged default, which is the schema's own, for a reading carrying none.
 *
 * It lives here rather than beside the schema defaults because the pane is what
 * has to draw something when a reading arrives without keys, and a pane that
 * throws on the one reading it cannot refuse would leave a blank panel.
 */
export const DEFAULT_KEYS: PaneKeys = {
  tipsEnabled: true,
  tips: [
    "Ctrl+U clears the line before the cursor.",
    "Ctrl+K clears the text after the cursor.",
    "Option+Delete, or Ctrl+W, deletes the previous word.",
    "Escape twice clears the draft; Ctrl+_ and Ctrl+Y undo and redo.",
    "/diff reviews the changes in this session.",
  ],
  close: "x",
  collapse: "c",
  expand: "e",
};

/**
 * The measurements the configuration declares, which decide what fits where.
 *
 * They are configuration rather than constants because each one is a choice a
 * person made about their own terminal: how narrow the pane may get, how much of
 * the width the surface keeps for itself, how long a bar is, and how many rows a
 * scan may take. A pane that drew at its own numbers would be one whose declared
 * settings are read, validated, and honoured by nobody.
 */
export type PaneGeometry = {
  minimumColumns: number;
  horizontalReserve: number;
  progressCells: number;
  skillRows: number;
  /** How many of a working job's unfinished subagent tasks are listed before the rest are counted. */
  fanLines: number;
};

/** The order the sections appear in, and what the person chose for each. */
export type SectionChoice = {
  /** What the section is called, when the configuration renamed it. */
  title?: string | null;
  visible: boolean;
  collapsed: boolean;
  legend?: string | null;
  /** Leave the section out while it has nothing to show and nothing is wrong with it. */
  hideWhenEmpty?: boolean;
  /** The most rows the section draws; the rest are counted beside its heading. */
  maxRows?: number;
};

/**
 * Whether a section has nothing to show: no rows, and a state that says so
 * rather than one that says something went wrong. A section whose source failed,
 * is unavailable or has gone stale is never empty in this sense, because the
 * failure is the thing to show.
 */
export function emptyGroup(group: Group): boolean {
  return group.rows.length === 0 && !(group.notes?.length) && group.state !== "failed"
    && group.state !== "unavailable" && group.state !== "stale";
}

/**
 * What a press on a row asks of the entry, which is the one that holds the
 * engine: put a line on the clipboard, say why a row has nothing to copy, or
 * send a waiting job its reply. The view model only names the text and the job.
 */
export type PaneActions = {
  /** Copy `text`; `what` names it in the toast that says so. */
  copy: (text: string, what: string) => void;
  /** Say why a press has nothing to act on. */
  refuse: (why: string) => void;
  /** Send a waiting job what was typed, or its suggestion when nothing was. */
  reply: (job: Job, typed: string) => void;
  /** Clear a reply that may not have been sent, so the question can take one again. */
  resend?: (job: Job) => void;
  /** Forget the sent replies that answer nothing any more, so replies are open again. */
  clearAnswered?: () => void;
  /** Clear a reply's record that does not read, so the question can take a reply. */
  clearUnreadable?: (job: Job) => void;
};

/**
 * Why replies are paused on this machine, as the helper last refused one: too
 * many held markers (`full`), cleared by a press, or a lock it will not use
 * (`lock`), which names the lock and its fix and ends when a retry succeeds.
 */
export type RepliesPaused = { kind: "full" | "lock"; reason: string };

export type PaneOptions = {
  width: number;
  narrowAt: number;
  now: number;
  /**
   * When the governor's counts were read, on the same clock as `now`. A run's
   * times are aged from it at each paint, so they count on between reads
   * instead of freezing and then jumping. Absent, the reading's own figures
   * stand.
   */
  countsAt?: number;
  /** Section order and per-section choices, as configuration resolved them. */
  sectionOrder: string[];
  sections: Record<string, SectionChoice>;
  /**
   * The pane's own keys and the tips it shows, as configuration resolved them.
   *
   * Every binding here is one the pane's own controls carry, which is what makes
   * the keys section a description of this pane rather than a list of shortcuts
   * a person has to guess apply.
   */
  keys: PaneKeys;
  /** The measurements the configuration declares, which decide what fits where. */
  geometry: PaneGeometry;
  /** The tones the configuration draws states in; the packaged theme when absent. */
  theme?: Theme;
  /**
   * The fold a person pressed, by section, which outranks the configured one.
   *
   * A section's configured fold is where it starts, not where it stays: this is
   * what a press changes, and it lives for the session rather than on disk.
   */
  folded?: Record<string, boolean>;
  /**
   * The sections a person pressed to draw in full, by section.
   *
   * A section's configured `maxRows` is where it starts, not where it stays: a
   * press on its control raises the ceiling for this session, the same way a
   * fold press outranks the configured fold.
   */
  shownAll?: Record<string, boolean>;
  /**
   * The sections a person put away, by section name.
   *
   * A section put away is not drawn among the cards, but it keeps its name in
   * the picker, so the press that put it away brings it back. It lives beside
   * the folds because it is a preference about the pane, not a filter on the
   * rows a person is reading now.
   */
  putAway?: Record<string, boolean>;
  /**
   * What a press on one of the pane's controls does.
   *
   * The layout is pure and cannot press anything itself, so the pane hands each
   * control the action it carries, and the entry is the one that knows what to
   * do with it.
   */
  onPress?: (element: string) => void;
  /** Session counts are read from the same roster; they are not a second source. */
  titles?: Record<string, string>;
  /** What a press on a row does, when the caller answers; a pane without it draws inert rows. */
  actions?: PaneActions;
  /** The reply keys already sent from a pane, newest last, so a replied job is not asked again. */
  replied?: string[];
  /**
   * How long a reply recorded as on its way, and never recorded as sent, waits
   * before its row says it may not have been sent (`pane.replyPendingSeconds`).
   */
  replyPendingSeconds?: number;
  /**
   * The pending replies this pane cleared, each as its reply key and the time it
   * was recorded, so the row offers the field again before the next reading.
   */
  cleared?: string[];
  /** Why replies are paused, when the helper last refused one for the whole machine. */
  paused?: RepliesPaused | null;
  /** How many items still on the band a person dismissed from it. */
  hidden?: number;
  /** Whether the surface draws a text field, so a reply is typed rather than copied. */
  fields?: boolean;
  /**
   * When the person last looked, for the "since you left" digest: the newest
   * event the digest drew when the pane last closed, in epoch seconds. Null is
   * never, and the digest shows the newest events as a first look. Absent is a
   * caller that has not found out yet, and no digest is drawn: drawing every
   * event until the store answered would flash a first look at someone who has
   * looked before.
   */
  lastSeen?: number | null;
  /**
   * The state a press on one of the headline figures narrowed the pane to.
   *
   * Absent or null is the whole fleet. A narrowed pane draws the same figures
   * and the same headings, so the numbers still count everything; only the rows
   * under them are the ones in that state, and a line says so.
   */
  focus?: Focus | null;
  /** The rows a person pressed open, by the key the row carries. */
  details?: Record<string, true>;
};

/** The three states a headline figure narrows the pane to. */
export type Focus = "working" | "waiting" | "failed";

/** The address of a press on one of the headline figures. */
export const FOCUS_PREFIX = "fleet.focus.";
/** The address of the press that widens a narrowed pane again. */
export const FOCUS_CLEAR = "fleet.focus.clear";
/** The address of a press that opens the rest of a row. */
export const DETAILS_PREFIX = "fleet.details.";

/**
 * Whether a row is one the focused figure counted.
 *
 * The words are the states the rows carry: a job works or waits, a pull request
 * and a trial pass or fail, and a run is running. A figure for working counts
 * every live state, because a lapse of one word is not a different outcome.
 */
export function focusMatches(state: string | undefined, focus: Focus): boolean {
  if (focus === "failed") {
    return state === "failed";
  }
  if (focus === "waiting") {
    // A job that waits on a person carries the word its provider uses for it.
    return state === "waiting" || state === "blocked";
  }
  return state === "working" || state === "running" || state === "active";
}

/** The address a press carries back for a job's attach command. */
export const JOB_PREFIX = "fleet.job.";
/** The address of a waiting job's reply field. */
export const REPLY_PREFIX = "fleet.reply.";
/** The address of a waiting job's suggestion, pressed to copy it where no field is drawn. */
export const SUGGEST_PREFIX = "fleet.suggest.";
/** The address of a reply that may not have been sent, pressed to clear it and send again. */
export const RESEND_PREFIX = "fleet.resend.";
/** The address of the press that clears answered replies when replies are paused. */
export const PRUNE_PREFIX = "fleet.prune.";
/** The address of a reply whose record does not read, pressed to clear that record. */
export const UNREADABLE_PREFIX = "fleet.unreadable.";
/** How long a pending reply waits before it reads as maybe not sent, until a reading says. */
export const REPLY_PENDING_SECONDS = 120;
/** The address of a worktree's cleanup press. */
export const WORKTREE_PREFIX = "fleet.worktree.";
/** The address of the skills section's status line, pressed to copy the report command. */
export const SKILL_REPORT = "fleet.skills.report";

/**
 * The key a reply is remembered by: this job, the session it runs in, and the
 * hash of the whole question it was sent for. The time a job began waiting is
 * not the question: a job answered and asking again between two readings never
 * seemed to stop waiting, and its new question would read as answered. The
 * session is: a job restarted into another session asking the same words is
 * asking again, and the reply sent to the old session never reached it.
 */
export function replyKey(job: Job): string {
  return job.provider + ":" + job.id + ":" + (job.session_id ?? "") + ":" + (job.needs_hash ?? "");
}

/** The pending reply a row draws, unless this pane already cleared that very one. */
function pendingReply(job: Job, options: PaneOptions): { at: number } | null {
  const reply = job.reply;
  if (!reply || reply.state !== "pending") {
    return null;
  }
  return options.cleared?.includes(replyKey(job) + "@" + reply.at) ? null : reply;
}

/** The key a pane keeps for an unreadable record it cleared: the question's and the file's. */
export function unreadableKey(job: Job, id: string): string {
  return replyKey(job) + "@unreadable:" + id;
}

/**
 * Whether this pane cleared that very unreadable record. Another record for the
 * same question that goes bad later is another file with another id, so it is
 * drawn; a reading that names no file hides nothing on a clearing's word.
 */
function clearedUnreadable(id: string | null, job: Job, options: PaneOptions): boolean {
  return id !== null && (options.cleared?.includes(unreadableKey(job, id)) ?? false);
}

/**
 * What a reply sends: what was typed, exactly as typed, or the suggestion for a
 * field left blank; null for neither. Spacing and line breaks are the person's
 * words, so nothing is trimmed from a reply that has any.
 */
export function replyText(typed: string, suggested: string | null | undefined): string | null {
  if (typed.trim() !== "") {
    return typed;
  }
  const offered = suggested ?? "";
  return offered.trim() === "" ? null : offered;
}

/** A pull request's page, or null for a repository that is not `owner/name` or a missing number. */
export function prUrl(pull: { repo: string; number: number | null }): string | null {
  return pull.number !== null && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pull.repo)
    ? "https://github.com/" + pull.repo + "/pull/" + pull.number : null;
}

/** The address a press carries back for a section's own fold control. */
export const TOGGLE_PREFIX = "fleet.section.";
/**
 * The address a press carries back for a section's "show all rows" control.
 *
 * A section past its ceiling holds rows back, and hover is the only way to see
 * them: a pointer is not on every surface, so the section that withholds rows
 * carries a control, and pressing it raises that ceiling for the session.
 */
export const SHOW_ALL_PREFIX = "fleet.showall.";
/** The address a press carries back for the picker's control over one section. */
export const HIDE_PREFIX = "fleet.hide.";
/** The address a press carries back for the control that folds every section. */
export const TOGGLE_ALL = "fleet.all";
/** The address a press carries back for the control that closes the pane. */
export const CLOSE = "fleet.close";
/** The two folds that act on every section at once. */
export const ALL_CONTROLS = [
  { key: TOGGLE_ALL + ".collapse", label: "Collapse all" },
  { key: TOGGLE_ALL + ".expand", label: "Expand all" },
];

/**
 * What each section is called when the configuration does not say.
 *
 * A fallback rather than the answer: the schema declares a title per section and
 * the reading carries them, so this is what a reading written before they
 * travelled draws instead of a section with no heading at all.
 */
const DEFAULT_TITLES: Record<string, string> = {
  running: "Running",
  sessions: "Background sessions",
  session: "This session",
  trials: "Trials",
  prs: "Pull requests",
  worktrees: "Worktrees",
  skills: "Skills",
  load: "Load",
  warnings: "Warnings",
  keys: "Keys",
};

const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "error", "stopped"]);

export function titleOf(name: string, options: PaneOptions): string {
  return options.titles?.[name] ?? options.sections[name]?.title
    ?? DEFAULT_TITLES[name] ?? name;
}

/** A reader's state, as a group state. */
function groupState(state: string): GroupState {
  switch (state) {
    case "paused":
    case "disabled":
    case "empty":
    case "failed":
    case "unavailable":
      return state;
    case "unconfigured":
      return "unavailable";
    default:
      return "ready";
  }
}

/** The reading of a group that failed but still holds rows from an earlier read. */
function partial(rows: Row[], state: string): GroupState {
  if (state === "failed" && rows.length > 0) {
    return "stale";
  }
  return groupState(state);
}

/**
 * Every string that came from a session, masked before it is placed on a row.
 *
 * A session writes its own name, its own question and its own detail, and any of
 * them can carry an account identifier or a sign-in. The pane is a display
 * surface: it masks on the way in, so a row cannot show what it was never meant
 * to show, and it says on the row that something was hidden rather than hiding it
 * silently.
 */
function shown(value: string | null | undefined): { text: string; masked: boolean } {
  const result = mask(value ?? "");
  return { text: result.text, masked: result.rules.length > 0 };
}

export function waiting(job: Job): boolean {
  return job.state === "blocked";
}

export function working(job: Job): boolean {
  return job.state === "working";
}

export function active(job: Job): boolean {
  return !waiting(job) && !working(job) && !TERMINAL_STATES.has(job.state);
}

/**
 * What a press on a live job's title does: copy the line that opens it, or say
 * why there is none. A reading from before the line travelled carries none, and
 * the press says so rather than copying a guess at the provider's home.
 */
function attachPress(job: Job, title: string, options: PaneOptions): Control {
  const key = JOB_PREFIX + job.provider + "." + job.id;
  const command = job.attach_command;
  return {
    key,
    label: title,
    onPress: () => command
      ? options.actions?.copy(command, "the command that opens " + title)
      : options.actions?.refuse("no attach command for " + title
                                + ": this reading carries none; the next one will"),
  };
}

/**
 * The lines a waiting job draws under its question: the reply it suggests and
 * a field to send one, or the word that it was answered from here.
 *
 * The field needs a surface that draws one and a session to send to. Without
 * either, the suggestion is the control, and a press copies it for the person to
 * paste where the job is open.
 */
function replyLines(job: Job, options: PaneOptions): { lines: RowLine[]; field?: Row["field"] } {
  if (job.reply?.state === "unreadable" && !clearedUnreadable(job.reply.id, job, options)) {
    // The record is there but does not read: it holds the question for every
    // pane, this one too, so nothing is typed, and the press clears only it.
    return { lines: [{
      slots: [{ text: "this reply's record could not be read", color: "warning" }],
      press: { key: UNREADABLE_PREFIX + job.provider + "." + job.id,
               label: "Clear the record so a reply can be sent",
               onPress: () => options.actions?.clearUnreadable?.(job) },
    }] };
  }
  if (options.replied?.includes(replyKey(job)) || job.reply?.state === "sent") {
    return { lines: [{ slots: [{ text: "replied; if it stays waiting, press the job to open it",
                                 dim: true }] }] };
  }
  const pending = pendingReply(job, options);
  if (pending !== null) {
    // A reply recorded as on its way holds the question: no second one is typed.
    // Past its time it may never have gone, and the person is told and offered
    // to send again, which clears it first.
    const waited = options.replyPendingSeconds ?? REPLY_PENDING_SECONDS;
    // One dated ahead of now would never come of age by waiting; it is offered
    // the press at once, as the helper's own stale release takes it.
    const age = options.now - pending.at;
    if (age >= 0 && age < waited) {
      return { lines: [{ slots: [{ text: "a reply is on its way", dim: true }] }] };
    }
    return { lines: [{
      slots: [{ text: "your reply may not have been sent", color: "warning" }],
      press: { key: RESEND_PREFIX + job.provider + "." + job.id, label: "Send again",
               onPress: () => options.actions?.resend?.(job) },
    }] };
  }
  const lines: RowLine[] = [];
  const paused = options.paused ?? null;
  if (paused !== null) {
    // The helper refused a reply for the whole machine: the row says why, masked.
    // Too many held markers is cleared by a press and draws no field until then;
    // an unsafe lock names its fix and keeps the field, since a retry once it is
    // fixed is what ends the pause.
    const why: RowLine = { slots: [{ text: "replies are paused: " + shown(paused.reason).text,
                                     color: "warning" }] };
    if (paused.kind === "full") {
      return { lines: [{ ...why, press: { key: PRUNE_PREFIX + job.provider + "." + job.id,
                                          label: "Clear answered replies",
                                          onPress: () => options.actions?.clearAnswered?.() } }] };
    }
    lines.push(why);
  }
  const suggested = (job.suggested_reply ?? "").trim();
  const canSend = options.fields === true && Boolean(job.session_id) && options.actions !== undefined;
  if (suggested) {
    const words: Slot[] = [{ text: "suggests:", dim: true }, { text: shown(suggested).text }];
    lines.push(canSend ? { slots: words, italic: true } : {
      slots: [...words, { text: " \u00b7 press to copy", dim: true }],
      italic: true,
      press: { key: SUGGEST_PREFIX + job.provider + "." + job.id,
               label: "Copy the suggested reply",
               onPress: () => options.actions?.copy(suggested, "the reply " + job.name + " suggests") },
    });
  }
  if (!canSend) {
    return { lines };
  }
  return {
    lines,
    field: {
      key: REPLY_PREFIX + job.provider + "." + job.id,
      label: "reply",
      placeholder: suggested ? "Enter alone sends the suggested reply" : "type a reply",
      submitLabel: "send",
      onSubmit: (value: string) => options.actions?.reply(job, value),
    },
  };
}

/**
 * The subagent tasks a working job has started and not finished, one line each,
 * the rest counted. A job between turns lists none: what it started is not
 * running while it waits for its next turn.
 */
function fanLines(job: Job, options: PaneOptions): RowLine[] {
  if (job.activity === "idle") {
    return [];
  }
  const open = (job.fan ?? []).filter((entry) => entry.startedAt !== undefined
                                                && entry.doneAt === undefined);
  const listed = Math.max(0, options.geometry.fanLines);
  const lines: RowLine[] = open.slice(0, listed).map((entry) => {
    // The state file dates a task in milliseconds, and marks one it started
    // without a time with 0: that one is running, and its age is unknown.
    const started = entry.startedAt as number;
    const age = started > 0 ? [{ text: " \u00b7 " + durationText(Math.max(0, options.now - started / 1000)),
                                 dim: true }] : [];
    return { slots: [{ text: shown(entry.kind).text, color: "suggestion" },
                     { text: shown(entry.label).text }, ...age] };
  });
  if (open.length > listed) {
    lines.push({ slots: [{ text: (open.length - listed) + " more running", dim: true }] });
  }
  return lines;
}

/** A live job's press, reply lines and subagent tasks, added to the row it draws as. */
function withJobActions(row: Row, job: Job, options: PaneOptions): Row {
  const lines: RowLine[] = [];
  let field: Row["field"];
  if (waiting(job)) {
    const reply = replyLines(job, options);
    lines.push(...reply.lines);
    field = reply.field;
  } else {
    lines.push(...fanLines(job, options));
  }
  return { ...row, press: attachPress(job, row.title, options),
           ...(lines.length ? { lines } : {}), ...(field ? { field } : {}) };
}

/**
 * A finished job, drawn quiet under the live ones: what it was, who ran it,
 * when it finished and what it left as its last word. It has no bar, since a
 * finished job's context share says nothing about anything still to do.
 */
function finishedRow(job: Job, options: PaneOptions): Row {
  const row = job.agent ? agentRow(job, job.agent, options) : jobRow(job, options);
  const meta = row.meta.filter((slot) => !/^ \u00b7 (\d|waiting|mid-turn|between)/.test(slot.text));
  const ended = job.since === null || job.since === undefined ? null : options.now - job.since;
  if (ended !== null) {
    meta.push({ text: " \u00b7 finished " + ageText(Math.max(0, ended)) });
  }
  return {
    ...row,
    key: "done:" + job.provider + ":" + job.id,
    dim: true,
    meta,
    slot: [{ text: job.state, dim: true }],
    figures: row.figures?.map((slot) => ({ ...slot, dim: true })),
    bar: undefined,
  };
}

function jobRow(job: Job, options: PaneOptions): Row {
  const name = shown(job.name);
  const question = shown(job.needs);
  const detail = shown(job.detail);
  const meta: Slot[] = [{ text: shown(job.label).text }];
  if (job.session_id) {
    meta.push({ text: " \u00b7 session " + job.session_id.slice(0, 8) });
  }
  const age = job.since === null || job.since === undefined
    ? null
    : options.now - job.since;
  if (age !== null && age >= 60) {
    // A job waiting for an answer has been waiting that long; anything else in a
    // live state entered it that long ago.
    meta.push({ text: " \u00b7 " + (waiting(job) ? "waiting " + durationText(age)
                                            : ageText(age)) });
  }
  if (job.activity === "busy") {
    meta.push({ text: " \u00b7 mid-turn" });
  } else if (job.activity === "idle") {
    meta.push({ text: " \u00b7 between turns" });
  }
  const slot: Slot[] = waiting(job)
    ? [{ text: "Waiting for you", color: "warning" }]
    : working(job)
      ? [{ text: "Working", color: "success" }]
      : active(job)
        ? [{ text: job.state, color: "success" }]
        : [{ text: job.state, dim: true }];
  // What a person opens the row for: where it runs, under which provider, for
  // how long, and the line that puts them in front of it. All of it was read
  // already; none of it earns a line on a row at rest.
  const opened: Slot[] = [];
  if (job.cwd) {
    opened.push({ text: "folder " + shown(job.cwd).text });
  }
  opened.push({ text: "provider " + shown(job.provider).text
                      + (job.session_id ? " \u00b7 session " + job.session_id : "") });
  if (job.since !== null && job.since !== undefined) {
    opened.push({ text: "in this state for " + durationText(options.now - job.since) });
  }
  if (job.attach_command) {
    opened.push({ text: job.attach_command });
  }
  return {
    // The row is named across readings, so a press that opens it survives a
    // filter or a fresh reading rather than landing on another row's place.
    key: "job:" + job.id,
    title: name.text,
    // The job's own state word, which is what the dot beside the name is for:
    // the slot at the right says the same thing in words for a reader who
    // wants them, and neither is a guess.
    state: job.state,
    meta,
    slot: name.masked || question.masked
      ? [...slot, { text: " \u00b7 " + MASK, dim: true }]
      : slot,
    detail: question.text || detail.text || undefined,
    ...(opened.length ? { details: opened } : {}),
  };
}

/** A model identifier the way a person says it: `claude-opus-5-5` as `opus 5.5`. */
export function modelName(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1");
}

/** Each effort word in a color of its own, always beside the word it repeats. */
const EFFORT_COLORS: Record<string, Slot["color"]> = {
  low: "subtle", medium: "text", high: "suggestion", xhigh: "planMode", max: "claude",
};

/**
 * What an agent spent, in the words its source allows.
 *
 * The host's own figure is drawn as it is. An estimate at configured rates is
 * drawn as one, and a total read from the end of a long transcript is drawn as
 * the floor it is: the session spent at least that, and a bare figure would say
 * it spent exactly that.
 */
export function spentText(agent: AgentFigures): string | null {
  if (agent.costUsd === undefined) {
    return null;
  }
  const figure = money(agent.costUsd);
  if (agent.lowerBound || agent.costSource === "floor") {
    return "at least " + figure.replace(/^~/, "");
  }
  return agent.costSource === "estimate" && !figure.startsWith("~") ? "~" + figure : figure;
}

/** Every token a session's turns moved: what it sent, wrote and read from the cache, and wrote back. */
export function tokensOf(agent: AgentFigures): number | null {
  const counts = agent.tokens;
  if (!counts) {
    return null;
  }
  return counts.input + counts.cacheWrite + counts.cacheRead + counts.output;
}

/**
 * The share of its context window a session's last turn filled, when the
 * window is known and the turn fits it.
 *
 * A turn larger than the configured window says the window is wrong for this
 * session, not that it is full: drawn as a share it would read "100%" for a
 * session with room to spare, so it is drawn in tokens instead.
 */
function contextShare(agent: AgentFigures): number | null {
  if (agent.contextTokens === undefined || !agent.contextWindow
      || agent.contextTokens > agent.contextWindow) {
    return null;
  }
  return Math.max(0, (agent.contextTokens / agent.contextWindow) * 100);
}

/**
 * How long a session has run: to now while it lives, to its last turn once it
 * has ended.
 *
 * It starts at the earlier of the roster's start and the transcript's first
 * turn. The roster dates the process, and a session resumed into a new process
 * keeps its transcript: dated by the process alone, a session that has spent
 * for hours reads as minutes old.
 */
function elapsedOf(job: Job, agent: AgentFigures | undefined, now: number): number | null {
  const starts = [job.started_at, agent?.firstActivity].filter(
    (value): value is number => typeof value === "number");
  if (!starts.length) {
    return null;
  }
  const end = TERMINAL_STATES.has(job.state) && agent?.lastActivity ? agent.lastActivity : now;
  return Math.max(0, end - Math.min(...starts));
}

/**
 * A background session as a card: what it is, what it runs on, what it has
 * spent, and how far through its own plan it is.
 *
 * The step bar is drawn from the session's task list and from nothing else. A
 * session that keeps no list has no denominator, so its bar is the share of the
 * context window its last turn filled, labeled as that, because the two are
 * different measurements and a bar must say which one it is.
 */
function agentRow(job: Job, agent: AgentFigures, options: PaneOptions): Row {
  const base = jobRow(job, options);
  if (agent.state !== "ready") {
    const reason = agent.state === "empty" ? "No turns recorded yet."
      : "Figures unreadable: " + (agent.reason ?? agent.state) + ".";
    return { ...base, note: { text: reason, color: agent.state === "failed" ? "warning" : undefined,
                              dim: agent.state !== "failed" || undefined } };
  }
  const title = agent.title ? shown(agent.title) : null;
  // Who runs it, under the title: the provider, the model and the effort.
  const meta: Slot[] = [{ text: shown(job.label).text }];
  if (agent.model) {
    meta.push({ text: " \u00b7 " + modelName(agent.model) });
  }
  if (agent.effort) {
    meta.push({ text: " \u00b7 " + agent.effort, color: EFFORT_COLORS[agent.effort] ?? "text" });
  }
  const steps = agent.steps;
  const listed = steps !== null && steps !== undefined && steps.total > 0;
  const share = contextShare(agent);
  // What it measured, at the right of the bar's line. A line too long for its
  // card is cut from the end, so the figures run from the one a person looks for
  // first to the one the strip repeats. The context share is stated here only
  // when the bar is the session's steps: otherwise the bar is the share and its
  // label already says it.
  const figures: Slot[] = [];
  const add = (slot: Slot) => figures.push(
    figures.length ? { ...slot, text: " \u00b7 " + slot.text } : slot);
  const spent = spentText(agent);
  add(spent === null ? { text: "cost not priced", dim: true } : { text: spent });
  if (share !== null && listed) {
    add({ text: share.toFixed(0) + "% context" });
  } else if (share === null && agent.contextTokens !== undefined) {
    add({ text: tokens(agent.contextTokens) + " in context" });
  }
  const moved = tokensOf(agent);
  if (moved !== null) {
    add({ text: (agent.lowerBound ? "at least " : "") + tokens(moved) + " tokens" });
  }
  const elapsed = elapsedOf(job, agent, options.now);
  if (elapsed !== null) {
    add({ text: durationOf(elapsed * 1000) });
  }
  const question = shown(job.needs);
  const phase = steps?.phase ? shown(steps.phase).text : "";
  // The step in hand is the bar's own label when there is a list to count it in;
  // a phase with no list behind it is said on a line of its own.
  const detail = question.text || (!listed && phase ? "Now: " + phase : "") || base.detail;
  const bar: Row["bar"] = listed && steps
    ? { done: steps.done, total: steps.total,
        label: { text: `${steps.done} / ${steps.total} steps` + (phase ? " \u00b7 " + phase : "") } }
    : share !== null
      ? { done: share, total: 100,
          label: { text: share.toFixed(0) + "% of the context window", dim: true } }
      : undefined;
  return {
    ...base,
    title: title ? title.text : base.title,
    meta,
    figures,
    slot: title?.masked && !base.slot.some((slot) => slot.text.includes(MASK))
      ? [...base.slot, { text: " \u00b7 " + MASK, dim: true }] : base.slot,
    detail: detail || undefined,
    bar,
    // Why the totals are a floor, in the reader's own words where it gave them:
    // a transcript longer than the bound and a subagent transcript nobody could
    // read are different reasons, and the sentence for one would name the wrong
    // cause for the other.
    note: agent.lowerBound
      ? { text: agent.reason
          ? "Totals are a floor: " + agent.reason + "."
          : "Totals are from the end of a long transcript.", dim: true } : undefined,
    ...timelineOf(job, agent, options),
  };
}

/**
 * The card's timeline: its stretches from the first to now while it lives, and
 * from the first to the last once it has ended.
 *
 * The stretch after the last record is the row's own state where the row knows
 * it: waiting on the person, mid-turn, or between turns. A job that says none of
 * those leaves it unknown rather than idle, since the transcript writes nothing
 * while a long tool call runs.
 */
function timelineOf(job: Job, agent: AgentFigures, options: PaneOptions): Pick<Row, "timeline"> {
  const segments = agent.timeline;
  if (!segments || !segments.length) {
    return {};
  }
  const from = Math.min(...segments.map((segment) => segment.start));
  const last = Math.max(...segments.map((segment) => segment.end));
  if (TERMINAL_STATES.has(job.state)) {
    return { timeline: { from, to: last, segments } };
  }
  const tail = waiting(job) ? "waiting" : job.activity === "busy" ? "working"
    : job.activity === "idle" ? "idle" : undefined;
  return { timeline: { from, to: Math.max(last, options.now), segments,
                       ...(tail ? { tail } : {}) } };
}

/**
 * The strip a sessions heading carries: what the shown sessions spent, the
 * tokens they moved, and the longest any of them has run.
 *
 * A sum is only as exact as its least exact part: one estimate makes the total
 * an estimate, and one floor, or one session nobody could price, makes it a
 * floor. Drawn as anything more certain, the strip would claim what no card does.
 */
export function agentStrip(jobs: Job[], now: number): Slot[] {
  const agents = jobs.map((job) => job.agent).filter(
    (agent): agent is AgentFigures => agent !== undefined && agent.state === "ready");
  if (!agents.length) {
    return [];
  }
  // A card that could not be read spent something nobody counted, so a sum
  // without it is a floor. An empty one has no turns and spent nothing.
  const unread = jobs.some((job) => job.agent !== undefined
    && job.agent.state !== "ready" && job.agent.state !== "empty");
  let cost = 0;
  let priced = 0;
  let floor = unread;
  let estimated = false;
  let moved = 0;
  for (const agent of agents) {
    if (agent.costUsd === undefined) {
      floor = true;
    } else {
      cost += agent.costUsd;
      priced += 1;
      estimated = estimated || agent.costSource === "estimate";
    }
    floor = floor || agent.lowerBound === true || agent.costSource === "floor";
    moved += tokensOf(agent) ?? 0;
  }
  const strip: Slot[] = [];
  // With nothing priced there is no sum to state: "at least $0.00" is true and
  // says nothing a reader can use.
  if (priced) {
    const figure = money(cost);
    strip.push({ text: floor ? "at least " + figure.replace(/^~/, "")
                   : estimated && !figure.startsWith("~") ? "~" + figure : figure,
                 color: "text", bold: true });
  }
  const anyFloor = unread || agents.some((agent) => agent.lowerBound);
  strip.push({ text: (strip.length ? "  " : "") + (anyFloor ? "at least " : "")
                 + tokens(moved) + " tokens", dim: true });
  let longest = 0;
  for (const job of jobs) {
    longest = Math.max(longest, elapsedOf(job, job.agent, now) ?? 0);
  }
  if (longest > 0) {
    strip.push({ text: "  " + durationOf(longest * 1000) + " longest", dim: true });
  }
  return strip;
}

/**
 * A command the governor is holding: its place in the queue and how much of the
 * wait it set has gone, drawn as a bar of that wait. Every figure is the
 * governor's own; a wait it did not state draws no bar rather than a guess.
 */
function heldRow(run: Run, options: PaneOptions): Row {
  const what = run.command_class ? run.command_class + " in " + run.repo : run.repo;
  const meta: Slot[] = [{ text: "waiting" }];
  if (run.queue_position !== null && run.queue_position !== undefined) {
    meta.push({ text: " \u00b7 " + ordinal(run.queue_position)
                  + (run.queue_total ? " of " + run.queue_total : "") + " in line" });
  }
  if (run.phase) {
    meta.push({ text: " \u00b7 " + run.phase + " gate", dim: true });
  }
  const total = run.wait_total ?? 0;
  const read = run.wait_left;
  const left = read === null || read === undefined ? read
    : Math.max(0, read - aged(options));
  const waited = left !== null && left !== undefined && total > 0
    ? Math.max(0, Math.min(total, total - left)) : null;
  return {
    title: shown(run.branch ? run.branch + " \u00b7 " + what : what).text,
    state: "waiting",
    meta,
    slot: [],
    bar: waited !== null
      ? { done: waited, total, cells: options.geometry.progressCells,
          label: { text: durationText(left as number) + " left", dim: true } }
      : undefined,
  };
}

/**
 * How long ago the governor's counts were read, by this paint's clock: never
 * less than nothing, since counts dated ahead of the clock are the store being
 * quick, not time running backwards.
 */
function aged(options: PaneOptions): number {
  return options.countsAt === undefined ? 0 : Math.max(0, options.now - options.countsAt);
}

/** 1st, 2nd, 3rd, 4th: a place in a queue as a person says it. */
function ordinal(place: number): string {
  const tens = place % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th"
    : ["th", "st", "nd", "rd"][place % 10] ?? "th";
  return place + suffix;
}

function runRow(run: Run, options: PaneOptions): Row {
  if (run.kind === "wait") {
    return heldRow(run, options);
  }
  const meta: Slot[] = [];
  if (run.branch) {
    meta.push({ text: run.branch });
  }
  meta.push({ text: (meta.length ? " \u00b7 " : "") + durationText(run.elapsed + aged(options))
                    + " elapsed" });
  if (run.eta_minutes !== null) {
    meta.push({ text: " \u00b7 about " + run.eta_minutes + "m left", dim: true });
  }
  return {
    title: shown(run.label || run.display).text,
    meta,
    // The count label and the failure count are the layout's to write, so the
    // slot stays empty here and the bar carries the measurement.
    slot: [],
    bar: { done: run.done, total: run.total, failed: run.failed,
           cells: options.geometry.progressCells },
    note: run.first_failure ? { text: run.first_failure, color: "error" } : undefined,
  };
}

function leaseRow(lease: { repo: string; branch: string; tool: string; expires_at: number },
                  options: PaneOptions, retrying = false): Row {
  const left = lease.expires_at - options.now;
  return {
    title: shown(lease.branch).text,
    meta: [{ text: lease.repo }, { text: " \u00b7 " + lease.tool },
           { text: " \u00b7 lease " + (left > 0 ? "ends in " + durationText(left)
                                           : "expired " + ageText(-left)) }],
    state: left > 0 ? "running" : "expired",
    // The slot repeats what the dot says, so the two cannot disagree: a dot
    // that warned of an expired lease beside the word "running" would be the
    // row contradicting itself.
    // A branch tried again after a failure says so on the one row it keeps:
    // the failed trial is not drawn a second time beside the try that follows it.
    slot: [{ text: (left > 0 ? "running" : "expired") + (retrying ? ", last try failed" : ""),
             color: retrying ? "error" : left > 0 ? "text" : "warning" }],
  };
}

/**
 * A change on its way through the controller: where it stands on the stage
 * path, drawn as a bar of the path, who holds it, and when it last moved. The
 * path is the configuration's, so the bar's whole is a declared length rather
 * than a guess at how much work is left.
 */
function changeRow(change: Change, options: PaneOptions, trial?: Trial): Row {
  const meta: Slot[] = [{ text: change.repo }];
  meta.push({ text: " \u00b7 " + change.state.toLowerCase().replace(/_/g, " ") });
  if (change.held_by) {
    meta.push({ text: " \u00b7 held by " + change.held_by });
  }
  if (change.moved_at !== null) {
    meta.push({ text: " \u00b7 moved " + ageText(Math.max(0, options.now - change.moved_at)),
                dim: true });
  }
  // The change's latest trial is its own verdict, so it sits on the change's
  // row rather than as a second row for the same branch further down. A trial
  // that reported no outcome has no verdict to state: it says so rather than
  // drawing a nought, which is the rule the bar beside it already follows.
  const bad = trial ? trial.failed + trial.errors : 0;
  const outcomes = trial ? trial.passed + bad : 0;
  return {
    title: shown(change.branch).text,
    state: change.held_by ? "running" : undefined,
    meta,
    slot: trial
      ? outcomes > 0
        ? [{ text: trial.passed + " passed", color: trial.is_green ? "success" : "error" },
           ...(bad ? [{ text: " \u00b7 " + bad + " failed", color: "error" as const }] : [])]
        : [countLabel(undefined)]
      : [],
    bar: change.stage !== null && change.stages > 0
      ? { done: change.stage, total: change.stages, cells: options.geometry.progressCells,
          label: { text: "stage " + change.stage + " of " + change.stages, dim: true } }
      : undefined,
  };
}

function trialRow(trial: Trial, options: PaneOptions): Row {
  const counts = trial.passed + " passed";
  const bad = trial.failed + trial.errors;
  const outcomes = trial.passed + bad;
  return {
    key: "trial:" + trial.key,
    title: shown(trial.branch).text,
    state: trial.is_green ? "passed" : "failed",
    // The repository is the root above these rows; the row says what changed
    // since it mattered.
    meta: [{ text: ageText(options.now - trial.at) }],
    slot: outcomes > 0
      ? [{ text: counts, color: trial.is_green ? "success" : "error" },
         ...(trial.failed ? [{ text: " \u00b7 " + trial.failed + " failed", color: "error" as const }]
                          : []),
         ...(trial.errors ? [{ text: " \u00b7 " + trial.errors + " errors", color: "error" as const }]
                          : [])]
      : [countLabel(undefined)],
    // The share of the run that did not pass, drawn rather than written: the
    // figure a person reads at a glance is the one with the bar under it, and a
    // trial reporting eleven hundred passes and ten failures reads as a clean
    // run until the ten are a cell of a bar. The denominator is what the run
    // reported outcomes for, which is not what it selected: a trial that ran
    // nothing reports no bar rather than a full one.
    //
    // The counts are already in the slot beside the title, so the bar carries no
    // label of its own. Written twice they would be one row making two claims
    // that a reader has to check against each other.
    bar: outcomes > 0
      ? { done: trial.passed, total: outcomes, failed: bad, label: null,
          cells: options.geometry.progressCells }
      : undefined,
    // The counts in full, the repository the branch belongs to, and when the
    // trial ran: what a person checking a red row wants before opening the log.
    details: [
      { text: outcomes + " outcomes: " + trial.passed + " passed, " + trial.failed
              + " failed, " + trial.errors + " errors" },
      { text: "repository " + trial.repo + " · ran " + ageText(options.now - trial.at) + " ago" },
    ],
  };
}

/** The longest check name a row states, so a long one leaves room for the dots. */
const CHECK_NAME_CELLS = 32;

function pullRequestRow(pull: PullRequest): Row {
  const label = pull.checks === "pass" ? "checks passed"
    : pull.checks === "fail" ? "checks failed"
      : pull.checks === "pending" ? "checks pending"
        : "no checks";
  const color = pull.checks === "fail" ? "error"
    : pull.checks === "pass" ? "success"
      : pull.checks === "pending" ? "warning" : "subtle";
  // A failing check is named where the verdict would be, so what broke is read
  // without opening the page; a check the reader could not name is not guessed.
  const runs = pull.check_runs;
  const failing = (runs ?? []).filter((run) => run.state === "fail" && run.name);
  const named = failing.length
    ? fit(shown(failing[0]?.name).text, CHECK_NAME_CELLS)
      + (failing.length > 1 ? " and " + (failing.length - 1) + " more" : "") + " failed"
    : null;
  const slots: Slot[] = [named === null ? { text: label, color } : { text: named, color: "error" }];
  if (pull.is_draft) {
    slots.unshift({ text: "draft", dim: true });
  }
  const page = prUrl(pull);
  return {
    key: "pr:" + pull.repo + "#" + String(pull.number),
    title: (pull.number === null ? "" : "#" + pull.number + " ") + shown(pull.title).text,
    ...(page ? { link: page } : {}),
    state: pull.checks === "pass" ? "passed"
      : pull.checks === "fail" ? "failed"
        : pull.checks === "pending" ? "pending" : "unknown",
    // The project the pull request belongs to is the root above it, drawn
    // once for its rows rather than repeated on every one.
    meta: [...(pull.branch ? [{ text: pull.branch }] : [])],
    // The owner the row could not spend its width on is one hover away, so
    // nothing the repository states is lost.
    ...(pull.repo.includes("/") ? { note: { text: pull.repo, dim: true } } : {}),
    slot: slots,
    // A reading from before checks were listed one by one has no dots to draw.
    ...(runs === undefined ? {}
      : { checks: { states: runs.map((run) => run.state), more: pull.check_runs_more ?? 0 } }),
    details: [
      ...(pull.repo ? [{ text: "repository " + pull.repo }] : []),
      ...(pull.branch ? [{ text: "branch " + pull.branch }] : []),
      ...(page ? [{ text: page }] : []),
      ...(runs === undefined ? []
        : [{ text: runs.length + " check" + (runs.length === 1 ? "" : "s") + " read"
                  + (failing.length ? ", " + failing.length + " failing" : "")
                  + (pull.check_runs_more ? ", " + pull.check_runs_more + " not listed" : "") }]),
    ],
  };
}

/**
 * What names the repository on a pull request's row.
 *
 * Every repository the person's own search finds is under the same owner, so
 * drawing "owner/project" spends the row's width on the one part that never
 * varies and leaves the project name to be cut. A repository the configuration
 * named is left whole: there the owner is what tells two of the same name apart.
 */
function repoLabel(pull: PullRequest): string {
  // The row is a line of project names: an owner drawn on every one of them is
  // the part that never tells two rows apart, and cut to eight cells it told
  // nothing at all. The whole repository is kept on the row's hover card.
  const slash = pull.repo.lastIndexOf("/");
  return slash > 0 ? pull.repo.slice(slash + 1) : pull.repo;
}

function skillRow(item: SkillItem, isNew: boolean): Row {  const meta: Slot[] = [{ text: item.target }];
  if (item.score !== null) {
    meta.push({ text: " \u00b7 score " + item.score });
  }
  return {
    title: (isNew ? "* " : "") + shown(item.name).text,
    meta,
    slot: [{ text: item.verdict, color: item.verdict === "flagged" ? "error" : "warning" }],
    note: item.issue ? { text: shown(item.issue).text, color: "warning" } : undefined,
  };
}

/** What happens to a worktree next, by its state, in the words the last pane used. */
export function worktreeNextStep(tree: Worktree): string {
  switch (tree.state) {
    case "active":
      return "in use";
    case "held":
      return "a running process has it open; cleaned after it exits";
    case "merged":
      return tree.change_state === "MERGED"
        ? "cleaned automatically at the next daily prune"
        : "no changes yet; press to copy cleanup if unused";
    case "preserved":
      return "not merged; archived copy kept; press to copy cleanup if abandoned";
    case "unknown":
      return "could not check: " + (tree.error ? shown(tree.error).text : "probe unavailable");
  }
}

/** "4m", "2h", "3d": a short age, rounded down, as the owner note says it. */
function shortAge(seconds: number): string {
  if (seconds < 3600) {
    return Math.max(0, Math.floor(seconds / 60)) + "m";
  }
  if (seconds < 86_400) {
    return Math.floor(seconds / 3600) + "h";
  }
  return Math.floor(seconds / 86_400) + "d";
}

/**
 * Who last moved a worktree's change and how long ago, worded by what the tree
 * is doing: a live lane was last moved, a merged or preserved one is parked. A
 * change the controller recorded merged names no owner, since nobody holds it.
 */
export function worktreeOwnerNote(tree: Worktree, now: number): string {
  if (!tree.change_owner || tree.change_state === "MERGED") {
    return "";
  }
  // The controller records whoever moved the change, in their own words.
  const owner = shown(tree.change_owner).text;
  const at = tree.change_updated_at;
  if (at === undefined || at === null) {
    return " by " + owner;
  }
  if (tree.state !== "merged" && tree.state !== "preserved") {
    return " last moved " + shortAge(Math.max(0, now - at)) + " ago by " + owner;
  }
  return " parked " + shortAge(Math.max(0, now - at)) + " by " + owner;
}

/**
 * Why a worktree is offered no cleanup whatever line its document carried, or
 * null when nothing withholds one. A merge, an archive or a set of live holders
 * nobody could tell leaves nothing saying the work is safe to remove.
 */
function cleanupWithheld(tree: Worktree): string | null {
  if (tree.merged === null) {
    return "could not tell whether it is merged";
  }
  if (tree.archived === null) {
    return "could not tell whether a copy of it is archived";
  }
  if (tree.held === null) {
    return "could not check whether a process has it open";
  }
  return null;
}

/** Whether a press on this worktree would copy a cleanup line. */
function cleanupCopyable(tree: Worktree): boolean {
  return cleanupWithheld(tree) === null && !tree.cleanup_note && tree.cleanup_command !== "";
}

/** What a press on a worktree does: copy its cleanup line, or say why it has none. */
function cleanupPress(tree: Worktree, title: string, options: PaneOptions): Control {
  const withheld = cleanupWithheld(tree);
  const command = withheld === null ? tree.cleanup_command : "";
  const why = tree.error ? shown(tree.error).text
    : withheld !== null ? withheld
      : tree.branch ? "no cleanup command is configured (commands.cleanup)"
        : "its branch is unknown";
  return {
    key: WORKTREE_PREFIX + tree.path,
    label: title,
    onPress: () => command
      ? options.actions?.copy(command, "cleanup for " + title)
      : options.actions?.refuse("no cleanup for " + title + ": " + why),
  };
}

function worktreeRow(tree: Worktree, options: PaneOptions): Row {
  // Which project's checkout this is comes first: a machine with three projects
  // on it draws the same branch name under each, and the row that does not say
  // where it belongs is one a person has to open to find out.
  const meta: Slot[] = [];
  if (tree.project) {
    meta.push({ text: shown(tree.project).text });
  }
  if (tree.branch) {
    meta.push({ text: (meta.length ? " · " : "") + shown(tree.branch).text });
  }
  const failure = tree.recheck_error ?? tree.error;
  const trouble = failure ? shown(failure).text : failure;
  const quiet = tree.state === "merged" || tree.state === "preserved";
  const title = shown(tree.name).text;
  // A tree the reader could offer no safe line for, as on Windows for a name cmd
  // would read, says so where the press would be offered, and offers no press:
  // a press there could only copy nothing or a line that runs part of the name.
  const byHand = tree.cleanup_note ? shown(tree.cleanup_note).text : null;
  const step = byHand === null ? worktreeNextStep(tree)
    : worktreeNextStep(tree).replace(/; press to copy cleanup.*$/, "");
  // The tone the configuration picks for the state; the theme's own token for
  // that tone is laid over the finished tree.
  const tone = worktreeToken(options.theme ?? THEME, tree.state);
  return {
    key: "worktree:" + tree.path,
    title,
    state: tree.state,
    meta,
    ...(byHand === null ? { press: cleanupPress(tree, title, options) } : {}),
    // What happens to it next, and who moved it last, at rest under the title.
    lines: [{ slots: [{ text: step + worktreeOwnerNote(tree, options.now)
                                + (byHand === null ? "" : "; " + byHand),
                        color: tone, ...(quiet ? { dim: true } : {}) }] }],
    slot: [{ text: tree.state, color: tone }],
    // What a person who is about to clean it needs: where it is, which checkout
    // it belongs to, and the line that removes it. A row the reader could offer
    // no safe line for stays a row with nothing to press, which is the whole of
    // what it says.
    ...(byHand === null ? {
      details: [
        { text: "path " + tree.path },
        ...(tree.project_root ? [{ text: "project root " + tree.project_root }] : []),
        ...(tree.cleanup_command ? [{ text: tree.cleanup_command }] : []),
      ],
    } : {}),
    // A stale row says so, with the age of the read it is carrying. Nothing
    // wrong with it, the hover card carries the project's own root, which is
    // more of a path than a row at rest should spend.
    note: trouble
      ? { text: trouble + (tree.checked_at === undefined
        ? "" : " \u00b7 not rechecked since " + ageText(options.now - tree.checked_at)),
          color: "warning" }
      // The project root is the heading this row hangs under, drawn once above
      // it, so the row does not spend its hover on saying it again.
      : undefined,
  };
}

function errorRow(error: { source: string; reason: string }): Row {
  // A reason can quote what it could not read, so it is masked like anything else.
  return { title: shown(error.source).text, state: "failed", meta: [],
           slot: [{ text: shown(error.reason).text, color: "error" }] };
}

/**
 * A group's summary: what it holds, counted once and named by what was observed.
 *
 * A group that failed does not report a count at all: the header says the count
 * is unknown, because a zero there would read as nothing running.
 */
function summary(slots: Slot[], group: GroupState): Slot[] {
  if (group === "paused") {
    return [];
  }
  return group === "failed" ? [{ text: "unknown", color: "error" }] : slots;
}

function countSlot(count: number, label: string,
                   color?: Slot["color"]): Slot[] {
  return count > 0 ? [{ text: count + " " + label, ...(color ? { color } : {}) }] : [];
}

/**
 * A count that comes and goes, drawn as a quiet zero when there is none.
 *
 * Dropped at zero, every figure after it moved along the line each time it
 * came back, which on a pane that redraws every second reads as a jump.
 */
function steadyCount(count: number, label: string, color?: Slot["color"]): Slot[] {
  return count > 0 ? [{ text: count + " " + label, ...(color ? { color } : {}) }]
    : [{ text: "0 " + label, dim: true }];
}

/** The count a group always states, even at zero: an empty reading is a reading. */
function primaryCount(count: number, label: string, color?: Slot["color"]): Slot[] {
  return [{ text: count + " " + label, ...(color ? { color } : {}) }];
}

function combine(parts: Slot[][]): Slot[] {
  const flat = parts.flat();
  return flat.map((slot, index) => index === 0 ? slot : { ...slot, text: "  " + slot.text });
}

/**
 * What each section says when it is switched off or has nothing to show.
 *
 * The layout knows how a failed source reads; only this layer knows that one
 * section holds running work and another holds open pull requests, so the wording
 * that names them belongs here.
 */
const SECTION_TEXT: Record<string, { disabled: string; empty: string }> = {
  sessions: { disabled: "Background jobs are disabled in configuration.",
              empty: "No background jobs in the configured sources." },
  // The engine reports this session's figures, so a document that says the old
  // payload source is off means only that the engine has not answered yet.
  session: { disabled: "Waiting for the engine to report this session's figures.",
             empty: "Waiting for the engine to report this session's figures." },
  trials: { disabled: "Trials are disabled in configuration.",
            empty: "No trials in the configured sources." },
  running: { disabled: "Running work is disabled in configuration.",
             empty: "No measured runs in the configured sources." },
  prs: { disabled: "Pull requests are disabled in configuration.",
         empty: "No open pull requests in the configured repositories." },
  worktrees: { disabled: "Worktrees are disabled in configuration.",
               empty: "No worktrees under the configured roots." },
  skills: { disabled: "Skills are disabled in configuration.",
            empty: "No findings in the configured scan folder." },
  load: { disabled: "The machine's load is switched off in configuration.",
          empty: "The process table held nothing to read." },
};

/**
 * The one digit that folds a section, by the place it holds in the order.
 *
 * Unique and stable within a pane, so a person learns it: the first section is
 * 1. Past the ninth there is no digit left, and a section without one is folded
 * by pressing its heading instead.
 */
function sectionHotkey(index: number): string | undefined {
  return index >= 0 && index < 9 ? String(index + 1) : undefined;
}

/**
 * What a control does when it is pressed: hand its address back to the caller.
 *
 * A pane built without a handler still draws its controls, and a press on one
 * then does nothing rather than throwing: the pane is a description, and what a
 * press means belongs to whoever drew it.
 */
function pressTo(options: PaneOptions, key: string): () => void {
  return () => options.onPress?.(key);
}

/** What a section a person added says when its command printed nothing. */
const CUSTOM_TEXT = { disabled: "This section is switched off in configuration.",
                      empty: "The command printed no rows." };

function sectionGroup(name: string, rows: Row[], state: GroupState, summarySlots: Slot[],
                      options: PaneOptions, extra: Partial<Group> = {}): Group {
  const choice = options.sections[name];
  const wording = SECTION_TEXT[name] ?? (name.startsWith(CUSTOM_PREFIX) ? CUSTOM_TEXT : undefined);
  const title = titleOf(name, options);
  // What a person pressed outranks what the configuration chose: the configured
  // fold is where a section starts, and a press is where it stays for this session.
  const collapsed = options.folded?.[name] ?? choice?.collapsed ?? false;
  // A section past its ceiling draws the first rows and says how many it held
  // back: one long section must not push every section after it off the pane.
  // A ceiling holds the rest of a long section back so one section cannot push
  // every section after it off the pane. A press on the section's control puts
  // that ceiling out of the way for the rest of the session.
  const ceiling = options.shownAll?.[name] === true ? undefined : choice?.maxRows;
  const held = ceiling !== undefined && rows.length > ceiling ? rows.length - ceiling : 0;
  let withheld: Row[] = [];
  if (held > 0) {
    withheld = rows.slice(ceiling);
    rows = rows.slice(0, ceiling);
    summarySlots = [...summarySlots, { text: (summarySlots.length ? "  " : "") + held + " more",
                                       dim: true }];
    // The heading says how many are held back and the control is what opens
    // them: hover does it too, where there is a pointer and a surface that
    // draws one, and a row a person cannot open on their own surface is one
    // they have to take on trust.
    const key = SHOW_ALL_PREFIX + name;
    rows = [...rows, { key: "show-all", title: "show all rows", dim: true, meta: [], slot: [],
                       press: { key, label: "show all rows", onPress: pressTo(options, key) } }];
  }
  const stated = summary(summarySlots, state);
  return {
    name: title,
    title,
    summary: stated,
    rows: state === "ready" || state === "stale" ? rows : [],
    ...(withheld.length ? { held: withheld } : {}),
    state,
    collapsed,
    // The mark is the state, spelled out, so what is drawn is what is folded
    // rather than a word that has to be read against a legend.
    toggle: {
      key: TOGGLE_PREFIX + name,
      label: title,
      onPress: pressTo(options, TOGGLE_PREFIX + name),
      hotkey: sectionHotkey(options.sectionOrder.indexOf(name)),
    },
    disabledText: wording?.disabled,
    emptyText: wording?.empty,
    // Every section draws its own legend, in the one place that knows which
    // section it is: a legend configured and drawn by one section only is a
    // legend seven sections were promised and never got.
    legend: choice?.legend ?? null,
    // Every section whose rows end in a figure names that figure once, above
    // them: a word like "passed" or "merged" says what it is, and a bare
    // percentage or a check's verdict does not. The line is drawn at the rows'
    // own right edge, so the names sit over the figures they name.
    columns: COLUMN_NAMES[name] ?? (name.startsWith(CUSTOM_PREFIX) ? [{ text: "STATE" }] : undefined),
    ...extra,
  };
}

/** What a section's right-hand figures are, where the words beside them do not say. */
const COLUMN_NAMES: Record<string, Slot[]> = {
  sessions: [{ text: "STATE" }],
  trials: [{ text: "RESULT" }],
  prs: [{ text: "CHECKS" }],
  worktrees: [{ text: "STATE" }],
  skills: [{ text: "VERDICT" }],
  warnings: [{ text: "REASON" }],
};

/** A token count in the unit a person reads it in, and never a rounded zero. */
export function tokens(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return (value / 1_000_000).toFixed(1) + "M";
  }
  if (Math.abs(value) >= 1_000) {
    return Math.round(value / 1_000) + "k";
  }
  return String(Math.round(value));
}

/** A duration in milliseconds as the two units that say it best. */
export function durationOf(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return seconds + "s";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes + "m " + (seconds % 60) + "s";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours + "h " + (minutes % 60) + "m";
  }
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}

/** A percentage at one precision, so two places cannot state it two ways. */
function percentOf(value: number): string {
  return value.toFixed(1);
}

/** The word a figure the payload did not carry is drawn with. */
const NOT_REPORTED: Slot = { text: "not reported", dim: true };

/**
 * The money this session has spent: the reader's own price where it priced one.
 *
 * A routed session is priced from its own transcript, and the host's cost is an
 * Anthropic-table figure that is not that provider's money. Both can reach this
 * layer in one document, so the drawn figure is the reader's whenever it
 * reported a usable one rather than whichever field the host happened to fill.
 */
function sessionSpend(session: SessionFigures): number | undefined {
  const priced = session.providerCostUsd;
  if (typeof priced === "number" && Number.isFinite(priced) && priced >= 0) {
    return priced;
  }
  return session.costUsd;
}

/**
 * This session's own figures: what it has spent, and the windows it runs in.
 *
 * The rows are the four things a person looks at their own session for, and each
 * one is built from a pair the payload actually carries rather than from a total
 * this layer worked out. A figure the payload did not carry is drawn as the
 * words for that, never as a zero: a session reported as having spent nothing
 * and one nobody measured are different claims, and only one of them is true.
 */
function sessionGroup(session: SessionFigures, options: PaneOptions): Group {
  const rows: Row[] = [];
  const model = session.modelName ?? (session.model ? modelName(session.model) : undefined);
  if (model) {
    const meta: Slot[] = [];
    // The identifier is stated under a name the engine gave; a title made from
    // the identifier itself already says it.
    if (session.model && session.modelName) {
      meta.push({ text: session.model });
    }
    if (session.parameters.effort) {
      meta.push({ text: (meta.length ? " \u00b7 " : "") + "effort " + session.parameters.effort });
    }
    if (session.parameters.thinking) {
      meta.push({ text: (meta.length ? " \u00b7 " : "") + "thinking " + session.parameters.thinking });
    }
    if (session.outputStyle) {
      meta.push({ text: (meta.length ? " \u00b7 " : "") + "style " + session.outputStyle });
    }
    rows.push({ title: model, meta, slot: session.version
      ? [{ text: "v" + session.version, dim: true }] : [] });
  }
  // The cost and the wall time are the section's tiles, so this row carries
  // only what the tiles do not: time in calls and lines changed, when reported.
  const spentMeta: Slot[] = [];
  if (session.apiDurationMs !== undefined) {
    spentMeta.push({ text: (spentMeta.length ? " \u00b7 " : "")
                      + durationOf(session.apiDurationMs) + " in calls" });
  }
  // Each half of the line count is drawn only when the payload carried it. A
  // missing count is not a count of nought: "40 lines added, removed not
  // reported" and "40 added, 0 removed" are different afternoons.
  const lines: string[] = [];
  if (session.linesAdded !== undefined) {
    lines.push("+" + session.linesAdded);
  }
  if (session.linesRemoved !== undefined) {
    lines.push("-" + session.linesRemoved);
  }
  if (lines.length) {
    spentMeta.push({ text: (spentMeta.length ? " \u00b7 " : "") + lines.join(" ")
                      + " lines" });
  }
  // A routed session's money is priced from its transcript rather than read off
  // a bill, so the row says which figure the person is looking at.
  if (session.costSource === "provider") {
    spentMeta.push({ text: (spentMeta.length ? " \u00b7 " : "") + "priced from the transcript" });
  }
  if (spentMeta.length) {
    rows.push({ title: "Spent on this session", meta: spentMeta, slot: [] });
  }
  const cache = (session.cacheReadTokens ?? 0) + (session.cacheCreationTokens ?? 0);
  if (cache > 0) {
    rows.push({
      title: "Through the cache",
      meta: [{ text: tokens(cache) + " tokens, read and written" }],
      slot: [],
    });
  }
  // The context window is drawn from the two numbers the host reports together:
  // what is left of the window and how big it is. A bar of input tokens against
  // the window would be a different measurement wearing this one's name.
  // The row is drawn from whichever of the window's figures the payload
  // carried. The bar needs the percentage and nothing else: what is left of a
  // window is a share of a whole by definition. The size and the token totals
  // are separate facts, and a payload carrying them without the percentage is
  // drawn as them, with the share named missing, rather than as nothing at all.
  const context: Slot[] = [];
  if (session.windowSize !== undefined) {
    context.push({ text: tokens(session.windowSize) + " tokens" });
  }
  const flows: string[] = [];
  if (session.inputTokens !== undefined) {
    flows.push(tokens(session.inputTokens) + " in");
  }
  if (session.outputTokens !== undefined) {
    flows.push(tokens(session.outputTokens) + " out");
  }
  if (flows.length) {
    context.push({ text: (context.length ? " \u00b7 " : "") + flows.join(", ") });
  }
  if (session.remainingPercent !== undefined) {
    rows.push({
      title: "Context window",
      meta: context,
      slot: [{ text: percentOf(session.remainingPercent) + "% left",
               color: session.remainingPercent <= 10 ? "warning" : "text" }],
      bar: { done: Math.max(0, Math.min(100, 100 - session.remainingPercent)), total: 100,
             label: null },
    });
  } else {
    rows.push({ title: "Context window", meta: context,
                slot: context.length ? [{ text: "share not reported", dim: true }]
                                     : [NOT_REPORTED] });
  }
  // The rate windows are spent-of-allowed, which is the one pair here whose
  // denominator is a hundred by definition rather than by report.
  const windows: [string, number | undefined, number | undefined][] = [
    ["Five-hour window", session.fiveHourUsedPercent, session.fiveHourResetsAt],
    ["Weekly window", session.sevenDayUsedPercent, session.weekResetsAt],
    ["Spend limit", session.spendUsedPercent, undefined],
  ];
  for (const [title, usedPercent, resetsAt] of windows) {
    if (usedPercent === undefined) {
      continue;
    }
    const meta: Slot[] = [];
    if (resetsAt !== undefined) {
      const left = resetsAt - options.now;
      meta.push({ text: left > 0 ? "resets in " + durationText(left)
                                 : "reset " + ageText(-left) });
    }
    rows.push({
      title,
      meta,
      slot: [{ text: usedPercent.toFixed(0) + "% used",
               color: usedPercent >= 90 ? "error"
                 : usedPercent >= 75 ? "warning" : "text" }],
      bar: { done: Math.max(0, Math.min(100, usedPercent)), total: 100, label: null },
    });
  }
  const summary: Slot[] = [];
  // A subscription session reports a cost of nought because the host bills the
  // person a flat fee, not because the session spent nothing. Drawing "$0.00"
  // there says a figure it does not have; the rate windows are what that person
  // watches instead, so they are what the heading states.
  const subscription = session.costUsd === 0
    && (session.fiveHourUsedPercent !== undefined || session.sevenDayUsedPercent !== undefined);
  const spend = sessionSpend(session);
  if (spend !== undefined && !subscription) {
    summary.push({ text: money(spend), color: "text" });
  }
  if (subscription) {
    if (session.fiveHourUsedPercent !== undefined) {
      summary.push({ text: Math.round(session.fiveHourUsedPercent) + "% 5h",
                     color: session.fiveHourUsedPercent >= 90 ? "error"
                       : session.fiveHourUsedPercent >= 75 ? "warning" : "text" });
    }
    if (session.sevenDayUsedPercent !== undefined) {
      summary.push({ text: (summary.length ? "  " : "")
                        + Math.round(session.sevenDayUsedPercent) + "% wk",
                     color: session.sevenDayUsedPercent >= 90 ? "error"
                       : session.sevenDayUsedPercent >= 75 ? "warning" : "text" });
    }
  }
  if (session.remainingPercent !== undefined) {
    // The heading states the same figure as the row, at the same precision: one
    // reading rounded and the other not looks like two figures that disagree.
    summary.push({ text: (summary.length ? "  " : "")
                      + percentOf(session.remainingPercent) + "% context left",
                   color: session.remainingPercent <= 10 ? "warning" : undefined });
  }
  // A session nobody could read has no rows, whatever this function built on
  // the way: every other section takes its rows from the document's own arrays,
  // so a failed one is empty. Rows kept here would make `partial` call a failed
  // read a stale one, drawn with an age and a claim that two things were
  // observed, and the reason it failed would never reach the pane. What is built
  // above is what a ready payload draws, and nothing else.
  const readable = session.state === "ready" ? rows : [];
  const group = sectionGroup("session", readable, partial(readable, session.state),
                             summary.length ? summary : [{ text: "none", dim: true }],
                             options);
  group.observed = readable.length;
  // The three figures a person looks at their own session for, as tiles. One
  // nobody reported says so in the quiet color rather than drawing a nought.
  const unreported = { value: "not reported", color: "subtle" as const };
  if (session.state === "ready") {
    // A subscription session's tiles are its rate windows, which are what the
    // person is metered by, in place of a cost the host reports as nought.
    group.tiles = subscription
      ? [
        session.fiveHourUsedPercent !== undefined
          ? { label: "5-hour", value: Math.round(session.fiveHourUsedPercent) + "% used",
              ...(session.fiveHourUsedPercent >= 75 ? { color: "warning" as const } : {}) }
          : { label: "5-hour", ...unreported },
        session.sevenDayUsedPercent !== undefined
          ? { label: "Weekly", value: Math.round(session.sevenDayUsedPercent) + "% used",
              ...(session.sevenDayUsedPercent >= 75 ? { color: "warning" as const } : {}) }
          : { label: "Weekly", ...unreported },
        session.remainingPercent !== undefined
          ? { label: "Context", value: percentOf(session.remainingPercent) + "% left",
              ...(session.remainingPercent <= 10 ? { color: "warning" as const } : {}) }
          : { label: "Context", ...unreported },
      ]
      : [
        spend !== undefined
          ? { label: "Cost", value: money(spend) } : { label: "Cost", ...unreported },
        // The machine's own day sits beside this session's spend, because the
        // question a person asks of the card is what everything is costing.
        spendWindowTile(session),
        session.remainingPercent !== undefined
          ? { label: "Context", value: percentOf(session.remainingPercent) + "% left",
              ...(session.remainingPercent <= 10 ? { color: "warning" as const } : {}) }
          : { label: "Context", ...unreported },
        session.durationMs !== undefined
          ? { label: "Time", value: durationOf(session.durationMs) } : { label: "Time", ...unreported },
      ];
  }
  return group;
}

function rosterGroups(roster: Roster, options: PaneOptions): Group[] {
  const jobs = roster.jobs;
  const blocked = jobs.filter(waiting);
  const busy = jobs.filter(working);
  const others = jobs.filter(active);
  const ordered = [...blocked, ...busy, ...others];
  // What finished in the window the reader keeps, newest first, under the live
  // ones: the reader already holds them to that window and that many.
  const finished = jobs.filter((job) => TERMINAL_STATES.has(job.state))
    .sort((left, right) => (right.since ?? 0) - (left.since ?? 0));
  const rows = [
    ...ordered.map((job) => withJobActions(
      job.agent ? agentRow(job, job.agent, options) : jobRow(job, options), job, options)),
    ...finished.map((job) => finishedRow(job, options)),
  ];
  const counts = combine([
    countSlot(blocked.length, "waiting", "warning"),
    countSlot(busy.length, "working", "success"),
    countSlot(others.length, "running"),
    countSlot(finished.length, "done"),
  ]).map((slot) => slot.text.endsWith(" done") ? { ...slot, dim: true } : slot);
  // The counts lead because a heading is cut from its least important end.
  const strip = agentStrip(ordered, options.now);
  const summarySlots = counts.length && strip.length
    ? [...counts, { text: "   " }, ...strip] : [...counts, ...strip];
  const group = sectionGroup("sessions", rows, partial(rows, roster.state),
                             summarySlots.length ? summarySlots : [{ text: "none", dim: true }],
                             options);
  group.observed = rows.length;
  if (ordered.length && options.actions) {
    group.notes = [[{ text: "Press a session to copy the command that opens it.", dim: true }]];
  }
  // Only a roster that was read has a spend to draw: a failed one keeps its
  // failure, and a series from it would be a day of spend nobody measured.
  if (roster.state === "ready" || roster.state === "empty") {
    group.spark = sparkFrom(roster.spend_series ?? null);
  }
  group.attention = blocked.length > 0;
  return [group];
}

/** A window of minutes as a person says it: whole hours in hours, the rest in minutes. */
function windowText(minutes: number): string {
  return minutes % 60 === 0 ? minutes / 60 + "h" : minutes + "m";
}

/**
 * The roster's spend over its window, with the words for what it adds up to.
 *
 * A series that is not complete is a floor: a bucket it could not fill is a
 * bucket that may have held spend, so its total is "at least" and it is marked
 * incomplete, the mark kept right after the figure so a narrow card cuts the
 * window and the session count first. The glyphs are scaled to the busiest bucket and to nothing
 * else: no budget is drawn against.
 */
function sparkFrom(series: SpendSeries | null): Spark | null {
  if (series === null || !series.buckets.length) {
    return null;
  }
  const figure = money(series.total);
  const label: Slot[] = [{ text: series.complete ? figure : "at least " + figure.replace(/^~/, ""),
                           color: "text", bold: true }];
  // The mark sits next to the figure it qualifies: a narrow card cuts from the
  // end, and a floor read without its mark reads as the whole spend.
  if (!series.complete) {
    label.push({ text: " · incomplete", color: "warning" });
  }
  label.push({ text: " over " + windowText(series.bucket_minutes * series.buckets.length), dim: true });
  if (series.sessions !== null) {
    label.push({ text: " · " + series.sessions + (series.sessions === 1 ? " session" : " sessions"),
                 dim: true });
  }
  // A floor keeps its mark beside it at any width; a complete figure keeps itself.
  return { values: series.buckets, label, keep: series.complete ? 1 : 2 };
}

/** The lines one governor run takes: its row and its bar or its words. */
const RUN_LINES = 2;

/**
 * The machine switch a section's heading states.
 *
 * It is a file the person touches for the whole machine, so every session draws
 * the same answer. Switched off is drawn as a warning, because it is the state
 * that stops work from running; on is drawn dim, because a switch nobody
 * touched is not news. A reading that reported no switch draws nothing rather
 * than claiming one is on.
 */
function switchSlot(state: "on" | "off" | null | undefined): Slot[] {
  if (state === "off") {
    return [{ text: "switched off", color: "warning" }];
  }
  if (state === "on") {
    return [{ text: "switch on", dim: true }];
  }
  return [];
}

function trialGroups(trials: Trials, progress: Progress, options: PaneOptions): Group[] {
  // Commands the governor runs come first, then the ones it holds in line.
  const ordered = [...progress.runs.filter((run) => run.kind !== "wait"),
                   ...progress.runs.filter((run) => run.kind === "wait")];
  const runRows = byProject(ordered.map((run) => ({ project: run.repo, row: runRow(run, options) })));
  const held = progress.runs.filter((run) => run.kind === "wait").length;
  const runningCounts = combine([primaryCount(ordered.length - held, "running", "text"),
                                 steadyCount(held, "waiting", "warning")]);
  const runningSwitch = switchSlot(progress.switch);
  const running = sectionGroup(
    "running", runRows, partial(runRows, progress.state),
    // The switch leads when it is off: it is the reason the counts are nought,
    // and a heading that says "0 running" without it reads as an idle machine.
    progress.switch === "off" ? [...runningSwitch, ...runningCounts]
      : [...runningCounts, ...runningSwitch],
    options);
  running.observed = runRows.length;
  // A run that failed is the person's to read; one the governor holds in line is not.
  running.attention = progress.runs.some((run) => run.failed > 0);
  // The room one run takes, its line and its bar, is kept when there is none:
  // a run that comes and goes in seconds otherwise moved every section below.
  running.reserve = RUN_LINES;
  // A change in flight carries its own lease as "held by", so a lease is drawn on
  // its own only when no change in flight names its branch.
  // A snapshot built before changes were read carries none.
  const changes = trials.changes ?? [];
  const moving = new Set(changes.map((change) => change.repo + "|" + change.branch));
  const latest = new Map(trials.recent.map((trial) => [trial.repo + "|" + trial.branch, trial]));
  // A branch whose latest trial failed and that holds a lease again is being
  // tried again: it is drawn once, as the try in progress, marked as following a
  // failure.
  const leased = trials.running.filter((lease) => !moving.has(lease.repo + "|" + lease.branch));
  const retrying = new Set(leased.map((lease) => lease.repo + "|" + lease.branch)
    .filter((key) => latest.get(key)?.is_green === false));
  const trialEntries = [
    ...changes.map((change) => ({ project: change.repo,
                                  row: changeRow(change, options,
                                                 latest.get(change.repo + "|" + change.branch)) })),
    ...leased.map((lease) => ({ project: lease.repo,
                                row: leaseRow(lease, options,
                                              retrying.has(lease.repo + "|" + lease.branch)) })),
    ...trials.recent.filter((trial) => !moving.has(trial.repo + "|" + trial.branch)
                                       && !retrying.has(trial.repo + "|" + trial.branch))
      .map((trial) => ({ project: trial.repo, row: trialRow(trial, options) })),
  ];
  const trialRows = byProject(trialEntries);
  // The window's failures are the strip's caption and nowhere else. Stated on
  // the heading as well they were one section making the same claim twice, and
  // the two numbers sat next to "8 recent", which counts branches in a
  // twelve-hour window rather than trials in it.
  const trialCounts = combine([primaryCount(changes.length, "in flight", "text"),
                               steadyCount(trials.running.length, "running"),
                               countSlot(trials.recent.length, "recent")]);
  const trialSwitch = switchSlot(trials.switch);
  const groups = sectionGroup(
    "trials", trialRows, partial(trialRows, trials.state),
    // The switch leads when it is off: a controller nobody is running is not the
    // same controller as one with no work, and the heading is where a person
    // looks to tell the two apart.
    trials.switch === "off" ? [...trialSwitch, ...trialCounts]
      : [...trialCounts, ...trialSwitch],
    options);
  groups.observed = trialEntries.length;
  groups.history = trials.history;
  // The latest trial of a branch is its verdict, so one that failed needs reading.
  groups.attention = trials.recent.some((trial) => !trial.is_green);
  return [running, groups];
}

/**
 * A section's items under the project each belongs to.
 *
 * The project root is a heading and its items hang under it one rail deeper,
 * so a pane holding four worktrees of one repository and one of another reads
 * as two groups rather than five rows nobody can attribute. An item whose
 * project nobody could read sits under its own heading rather than being
 * attached to another project or dropped. Projects are ordered by name and
 * items keep the order the reader gave, so a section does not reshuffle when an
 * item arrives.
 */
function byProject(entries: { project: string | null | undefined; row: Row }[]): Row[] {
  const groups = new Map<string, Row[]>();
  for (const entry of entries) {
    const name = (entry.project ?? "").trim() || "no project";
    const bucket = groups.get(name);
    if (bucket) {
      bucket.push(entry.row);
    } else {
      groups.set(name, [entry.row]);
    }
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const rows: Row[] = [];
  names.forEach((name, index) => {
    const children = groups.get(name) ?? [];
    for (const child of children) {
      rows.push({ ...child,
                  project: { root: name, count: children.length,
                             last: index === names.length - 1 } });
    }
  });
  return rows;
}

function pullRequestGroup(prs: PullRequests, options: PaneOptions): Group {
  const rows = byProject(prs.prs.map((pull) => ({ project: pull.repo, row: pullRequestRow(pull) })));
  const failing = prs.prs.filter((pull) => pull.checks === "fail").length;
  const group = sectionGroup(
    "prs", rows, partial(rows, prs.state),
    combine([primaryCount(prs.prs.length, "open"),
             countSlot(failing, "failing", "error")]),
    options);
  group.observed = prs.prs.length;
  group.attention = failing > 0;
  return group;
}

/**
 * The scan's own line: how long ago it ran and what it found, every count it
 * keeps, and a press that copies the command that prints every finding.
 *
 * Null before any scan has run: a line of noughts would say a scan found
 * nothing. A configuration with no report command draws the line without the
 * press and says so, rather than offering a copy of nothing.
 */
function skillStatusRow(skills: Skills, options: PaneOptions): Row | null {
  if (skills.generated_at === null && skills.running === null) {
    return null;
  }
  const counts = skills.counts;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const found: Slot[] = [{ text: total + " checked" },
                         { text: " \u00b7 " + (counts.clean ?? 0) + " clean", color: "success" }];
  const tally = (count: number | undefined, words: string, color: Slot["color"], dim = false) => {
    if (count) {
      found.push({ text: " \u00b7 " + count + " " + words, color, ...(dim ? { dim: true } : {}) });
    }
  };
  tally(counts.flagged, "flagged", "error");
  tally(counts.review, "to read", "warning");
  tally(counts.failed, "could not finish", "warning");
  tally(counts.reviewed, "reviewed", undefined, true);
  const report = skills.report_command;
  return {
    key: "scan",
    title: skills.generated_at === null ? "No finished scan yet"
      : "Last scan " + ageText(Math.max(0, options.now - skills.generated_at)),
    meta: skills.running
      ? [{ text: "scanning " + skills.running.done + " of " + skills.running.total
                 + " changed folders" }] : [],
    slot: [{ text: report ? "press to copy the report command" : "report command not configured",
             dim: true }],
    lines: skills.generated_at === null ? [] : [{ slots: found }],
    ...(report ? { press: { key: SKILL_REPORT, label: "Copy the skill report command",
                            onPress: () => options.actions?.copy(report, "the skill report command") } }
      : {}),
  };
}

function skillGroup(skills: Skills, options: PaneOptions): Group {
  const fresh = new Set(skills.new.map((item) => item.hash + "|" + item.target));
  // The same press that raises a section's ceiling raises this one, which is a
  // measurement rather than a configured row count.
  const ceiling = options.shownAll?.skills === true ? skills.items.length
    : Math.max(0, options.geometry.skillRows);
  const shown = skills.items.slice(0, ceiling);
  const status = skillStatusRow(skills, options);
  const rows = [...(status ? [status] : []), ...shown.map((item) =>
    skillRow(item, fresh.has(item.hash + "|" + item.target)))];
  // A scan with more findings than the pane will draw says how many it left out.
  // Cutting them silently draws a section that looks like the whole scan, and a
  // count beside a heading that no longer matches the rows under it is worse
  // than the extra line.
  const withheld = skills.items.length - shown.length;
  // A running scan says how far it is on its status row, which every running
  // scan has, so the heading does not say it a second time.
  // A scan that ran and left nothing to read is a reading, and its line says so.
  const state = status !== null && skills.state === "empty" ? "ready" : partial(rows, skills.state);
  const group = sectionGroup(
    "skills", rows, state,
    combine([primaryCount(skills.items.length, "need attention", "warning"),
             countSlot(withheld, "not shown", "warning")]),
    options);
  group.observed = rows.length;
  // The findings the scan row ceiling held back are drawn under the section
  // while the pointer is on it, so "5 not shown" is a count a person can open,
  // and the control beside it opens them where no pointer is.
  if (withheld > 0) {
    group.held = skills.items.slice(ceiling).map((item) =>
      skillRow(item, fresh.has(item.hash + "|" + item.target)));
    const key = SHOW_ALL_PREFIX + "skills";
    group.rows = [...group.rows, { key: "show-all", title: "show all rows", dim: true, meta: [],
                                   slot: [], press: { key, label: "show all rows",
                                                      onPress: pressTo(options, key) } }];
  }
  return group;
}

/**
 * The line under the worktrees: an invitation to press when a press copies a
 * cleanup line, and otherwise why none does. A machine that cannot check live
 * holders, as a Windows one without lsof, has every row in that state, and is
 * told so once rather than left with a section that refuses every press.
 */
function worktreePressNote(trees: Worktree[]): string {
  if (trees.some(cleanupCopyable)) {
    return "Press a worktree to copy its cleanup command.";
  }
  if (trees.every((tree) => tree.held === null)) {
    return "No cleanup is offered: this machine could not check which processes have a worktree open.";
  }
  return "No worktree here offers a cleanup command; press one to see why.";
}

function worktreeGroup(worktrees: Worktrees, options: PaneOptions): Group {
  const rows = byProject(
    worktrees.worktrees.map((tree) => ({ project: tree.project_root, row: worktreeRow(tree, options) })));
  const legend = (["active", "held", "merged", "preserved", "unknown"] as const)
    .map((state) => ({
      count: worktrees.worktrees.filter((tree) => tree.state === state).length,
      state,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => ({ text: entry.count + " " + entry.state, dim: true }));
  const cleaned = worktrees.cleaned === null || worktrees.cleaned === 0
    ? []
    : [{ text: worktrees.cleaned + " cleaned this week", dim: true }];
  const stale = worktrees.worktrees.some((tree) => tree.recheck_error !== undefined);
  const age = rows.length
    ? Math.max(...worktrees.worktrees.map((tree) =>
      options.now - (tree.checked_at ?? options.now)))
    : 0;
  const state: GroupState = partial(rows, worktrees.state);
  const group = sectionGroup(
    "worktrees", rows, state,
    combine([primaryCount(worktrees.worktrees.length, "checked out"), legend, cleaned]),
    options);
  group.observed = worktrees.worktrees.length;
  group.staleSeconds = stale && state === "stale" ? age : undefined;
  if (worktrees.worktrees.length && options.actions) {
    group.notes = [[{ text: worktreePressNote(worktrees.worktrees), dim: true }]];
  }
  return group;
}

/** A memory figure in the unit a person reads it in, and never a rounded zero. */
export function bytes(value: number): string {
  if (value >= 1024 ** 3) {
    return (value / 1024 ** 3).toFixed(1) + " GB";
  }
  if (value >= 1024 ** 2) {
    return Math.round(value / 1024 ** 2) + " MB";
  }
  if (value >= 1024) {
    return Math.round(value / 1024) + " KB";
  }
  return Math.round(value) + " B";
}

/** The name a process is read by: its command without the path that places it. */
function commandName(command: string): string {
  const trimmed = command.trim();
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.replace(/^\((.*)\)$/, "$1") || trimmed;
}

/** The tone a CPU figure is drawn in: only a figure that presses the machine is colored. */
function cpuTone(cpu: number): Slot["color"] {
  if (cpu >= 80) {
    return "error";
  }
  return cpu >= 40 ? "warning" : "text";
}

/**
 * How wide each of a load row's two figures is drawn.
 *
 * A percentage is drawn up to five cells ("100.0%", and above one core it goes
 * higher) and a figure of memory up to seven ("999.9 GB"): each column is that
 * wide on every row, so the column beside it starts in the same place.
 */
const CPU_COLUMN = 6;
const MEMORY_COLUMN = 8;

/**
 * One process under load: what it is, where it works, and what it costs the
 * machine now.
 *
 * The figures are the measurement, not a rank: a process drawn because it leads
 * the memory list says so with its own bytes, and one drawn because it leads
 * the CPU list says so with its own percentage. A process whose project nobody
 * could read draws no project rather than a folder guessed from its name.
 */
function loadRow(entry: LoadProcess): Row {
  const project: Slot[] = entry.project
    ? [{ text: entry.project }]
    : [{ text: "no project", dim: true }];
  return {
    key: "load:" + entry.pid,
    title: commandName(entry.command),
    meta: [...project,
           { text: " \u00b7 pid " + entry.pid, dim: true },
           { text: " \u00b7 " + durationOf(entry.elapsed_seconds * 1000), dim: true }],
    // Two columns, each its own width: a percentage of four characters and one
    // of five put the memory figure one cell apart, so the columns walked.
    slot: [
      { text: entry.cpu_percent.toFixed(1) + "%", color: cpuTone(entry.cpu_percent),
        width: CPU_COLUMN, align: "right" },
      { text: " " + bytes(entry.memory_bytes), width: MEMORY_COLUMN, align: "left" },
    ],
    ...(entry.project_root ? { note: { text: entry.project_root, dim: true } } : {}),
    // The row is read by a name; the command it was started from is what a
    // person acts on, and the pid is what a kill or a signal takes.
    details: [
      { text: "command " + entry.command },
      { text: "pid " + entry.pid + " · running " + durationOf(entry.elapsed_seconds * 1000)
              + " · " + bytes(entry.memory_bytes) },
      ...(entry.project_root ? [{ text: "project root " + entry.project_root }] : []),
    ],
  };
}

/**
 * The machine's load: the processes at the top of the CPU list and the top of
 * the memory list, each drawn once.
 *
 * The heading says how many processes the drawn ones were chosen from, because
 * "6 rows" on a machine running four hundred reads as a quiet machine.
 */
function loadGroup(load: Load, options: PaneOptions): Group {
  const rows = load.processes.map(loadRow);
  const summary = combine([primaryCount(load.total, "processes"),
                           countSlot(rows.length, "shown", "subtle")]);
  const group = sectionGroup("load", rows, partial(rows, load.state), summary, options);
  // The two figures are the section's only meaning that a shape does not tell
  // on its own: a percentage and a byte count, in columns wide enough to hold
  // them. Naming them once costs one line and stops a reader guessing which is
  // which. The widths are the row's own, so the names sit over their columns.
  group.columns = [
    { text: "CPU", width: CPU_COLUMN, align: "right" },
    { text: " · MEM", width: MEMORY_COLUMN, align: "left" },
  ];
  group.observed = rows.length;
  return group;
}

/**
 * The interactive sessions each provider runs, by the name the provider is
 * shown under, or null when the roster counted none: a provider the roster
 * could not read has no count, and is named in the warnings instead.
 */
function interactiveLine(roster: Roster): Slot[] | null {
  const labels = new Map(roster.jobs.map((job) => [job.provider, job.label || job.provider]));
  const counted = Object.entries(roster.interactive).filter(([, count]) => count > 0);
  if (!counted.length) {
    return null;
  }
  return [{ text: "Interactive sessions:", dim: true },
          ...counted.map(([provider, count], index): Slot => ({
            text: (index ? " \u00b7 " : "") + shown(labels.get(provider) ?? provider).text + " " + count,
          }))];
}

function warningGroup(errors: { source: string; reason: string }[], roster: Roster,
                      options: PaneOptions): Group {
  const rows = errors.map(errorRow);
  const interactive = interactiveLine(roster);
  const sessions = Object.values(roster.interactive).reduce((sum, count) => sum + count, 0);
  const hidden = options.hidden ?? 0;
  // The warning list is the collected reader errors, not a source: an empty one
  // states a count and claims nothing about what was read.
  const summary: Slot[] = rows.length
    ? [{ text: rows.length + " source" + (rows.length === 1 ? "" : "s"), color: "error" }]
    : [{ text: "none", dim: true }];
  if (sessions > 0) {
    summary.push({ text: "  " + sessions + " interactive", dim: true });
  }
  const group = sectionGroup("warnings", rows, "ready", summary, options);
  const notes: Slot[][] = [];
  if (interactive) {
    notes.push(interactive);
  }
  if (hidden > 0) {
    notes.push([{ text: hidden + " hidden from the band; /fleet unhide shows them again.",
                  dim: true }]);
  }
  if (notes.length) {
    group.notes = notes;
  }
  return group;
}

/**
 * One binding: the key, and what pressing it does.
 *
 * The key is the title and the action is the quiet line under it, which is the
 * same shape every other row on the pane uses, so a shortcut reads as a thing
 * with a name rather than as a sentence a person has to parse.
 */
/**
 * One row a person's command printed. Every string came from someone else's
 * program, so it is masked on the way in like a session's own text, and a bar is
 * drawn only from the two figures the command gave.
 */
function customRow(row: CustomRow, options: PaneOptions): Row {
  const bar = row.done !== null && row.total !== null && row.total > 0 && row.done <= row.total
    ? { done: row.done, total: row.total, failed: row.failed ?? undefined,
        cells: options.geometry.progressCells }
    : undefined;
  return {
    title: shown(row.title).text,
    state: row.state ?? undefined,
    meta: row.detail ? [{ text: shown(row.detail).text }] : [],
    slot: row.slot ? [{ text: shown(row.slot).text, dim: true }] : [],
    bar,
  };
}

/** A section a person added, drawn from the rows its command printed. */
function customGroup(name: string, section: CustomSection | undefined,
                     options: PaneOptions): Group {
  if (section === undefined) {
    // The order names it and the reading carries nothing for it: the custom
    // reader itself went wrong, which the warnings name.
    return sectionGroup(name, [], "failed", [], options);
  }
  const rows = section.rows.map((row) => customRow(row, options));
  const counted: Slot[] = section.summary
    ? [{ text: shown(section.summary).text }]
    : primaryCount(section.printed, "row" + (section.printed === 1 ? "" : "s"));
  const held: Slot[] = section.printed > rows.length
    ? [{ text: rows.length + " shown", dim: true }]
    : [];
  const group = sectionGroup(name, rows, partial(rows, section.state),
                             combine([counted, held]), options);
  group.observed = rows.length;
  // A person's own command decides its rows' states, so a row it calls failed
  // or waiting is read as the pane reads its own.
  group.attention = section.rows.some((row) => ["failed", "error", "blocked", "waiting"]
    .includes(row.state ?? ""));
  return group;
}

function keyRow(key: string, does: string): Row {
  return { title: key, meta: [{ text: does }], slot: [] };
}

/**
 * What this pane's keys do, and the tips the configuration carries with them.
 *
 * The bindings come first, because they are this pane's own: every one is
 * carried by a control the pane actually draws, so the list describes the pane
 * a person is looking at rather than a set of shortcuts they have to hope
 * apply here. The tips follow, and they are advice about the prompt rather than
 * about this pane, which is why turning them off leaves the keys standing.
 */
function keyGroup(options: PaneOptions): Group {
  const keys = options.keys;
  const bindings: Row[] = [
    keyRow(keys.close, "close this pane"),
    keyRow(keys.collapse, "fold every section"),
    keyRow(keys.expand, "open every section"),
    keyRow("1-9", "fold one section, by its place in the pane"),
  ];
  const tips = keys.tipsEnabled
    ? keys.tips.map((tip) => ({ title: tip, meta: [], slot: [] }))
    : [];
  const rows = [...bindings, ...tips];
  const summary: Slot[] = [{ text: bindings.length + " keys" }];
  if (!keys.tipsEnabled) {
    summary.push({ text: "  tips off", dim: true });
  } else if (tips.length) {
    summary.push({ text: "  " + tips.length + " tips", dim: true });
  }
  // A section with no rows at all is not a reading: the pane's own keys are
  // always there to be listed, so an empty list would mean this build draws no
  // controls, which it does.
  return sectionGroup("keys", rows, "ready", summary, options);
}

/**
 * The whole pane: the groups the configuration asks for, in the order it asks for
 * them, and a header that says what was observed and what could not be read.
 */
export function paneFrom(snapshot: Snapshot, options: PaneOptions): Pane {
  const [runningGroup, trialsGroup] = trialGroups(snapshot.trials, snapshot.progress, options);
  const built: Record<string, Group[]> = {
    sessions: rosterGroups(snapshot.roster, options),
    session: [sessionGroup(snapshot.session, options)],
    running: [runningGroup],
    trials: [trialsGroup],
    prs: [pullRequestGroup(snapshot.prs, options)],
    skills: [skillGroup(snapshot.skills, options)],
    worktrees: [worktreeGroup(snapshot.worktrees, options)],
    load: [loadGroup(snapshot.load, options)],
    warnings: [warningGroup(allErrors(snapshot), snapshot.roster, options)],
    keys: [keyGroup(options)],
  };
  for (const name of options.sectionOrder) {
    if (name.startsWith(CUSTOM_PREFIX)) {
      built[name] = [customGroup(name, snapshot.custom.sections[name.slice(CUSTOM_PREFIX.length)],
                                 options)];
    }
  }
  // The picker lists every section the configuration made visible, in the order
  // it asked for, whether or not a person has put it away: a section missing
  // from the picker is one that was hidden with no press left to bring it back.
  // A section the configuration itself hid is not listed, because no press made
  // it go and no press should pretend to return it.
  const hidden = options.putAway ?? {};
  const picker: PickerItem[] = options.sectionOrder
    .filter((name) => built[name] !== undefined && options.sections[name]?.visible !== false)
    .map((name): PickerItem => {
      const title = titleOf(name, options);
      return { name, title, hidden: hidden[name] === true,
               press: { key: HIDE_PREFIX + name, label: title,
                        onPress: pressTo(options, HIDE_PREFIX + name) } };
    });
  const groups: Group[] = [];
  for (const name of options.sectionOrder) {
    const choice = options.sections[name];
    if (choice && choice.visible === false) {
      continue;
    }
    // A section a person put away draws no card while it is away; its name in
    // the picker is what the press acts on until it comes back.
    if (hidden[name] === true) {
      continue;
    }
    const found = built[name];
    if (found) {
      groups.push(...found.filter((group) => group !== undefined
        && !(choice?.hideWhenEmpty === true && emptyGroup(group))));
    }
  }
  // The order is the one the configuration asks for, and nothing moves out of
  // it. A section used to jump above the calm ones while it held something that
  // needs the person, which also moved every digit below it: the hotkey a person
  // learned for a section became another section's on a reading they did not
  // ask for. What needs the person is said where it is instead, by the heading's
  // tone and count and by the band above the prompt, and the order is set once
  // in configuration.
  // A failing source is the most urgent thing on the pane, so its warnings lead
  // while they hold anything, wherever the order placed them; a person who hid
  // the section was never given it to move.
  const warned = groups.findIndex((group) => group.toggle?.key === TOGGLE_PREFIX + "warnings"
                                            && group.rows.length > 0);
  if (warned > 0) {
    groups.unshift(...groups.splice(warned, 1));
  }
  // A press on a figure narrows the pane to the rows that figure counted. A
  // section left with nothing to say leaves the pane rather than drawing an
  // empty card: the filter is a deliberate mode, and a heading over no rows is
  // a place a person presses and finds nothing.
  const focus = options.focus ?? null;
  if (focus !== null) {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const kept = groups[index]?.rows.filter((row) => focusMatches(row.state, focus)) ?? [];
      if (groups[index] && kept.length === 0) {
        groups.splice(index, 1);
      } else if (groups[index]) {
        groups[index].rows = kept;
      }
    }
  }
  // A row that holds more than its two lines gets the press that opens them,
  // keyed by what names the row across readings, and is drawn open when the
  // person left it open.
  const details = options.details ?? {};
  for (const group of groups) {
    group.rows = group.rows.map((row, index) => {
      if (!row.details?.length) {
        return row;
      }
      const id = row.key ?? (group.toggle?.key ?? group.title) + ":" + index;
      return {
        ...row,
        key: row.key ?? id,
        detailsPress: { key: DETAILS_PREFIX + id, label: "details",
                        onPress: pressTo(options, DETAILS_PREFIX + id) },
        expanded: details[id] === true,
      };
    });
  }
  const jobs = snapshot.roster.jobs;
  const workingNow = jobs.filter((job) => working(job) || active(job)).length;
  const waitingNow = jobs.filter(waiting).length;
  const failedNow = failedOutcomes(snapshot);
  const counts = combine([
    primaryCount(workingNow, "working", "text"),
    countSlot(waitingNow, "waiting", "warning"),
    countSlot(failedNow, "failed", "error"),
  ]);
  // Each label names what its figure counts, because the three do not count the
  // same thing. Two of them are background sessions and the third is every
  // failed outcome, trials and runs alike, and a row of bare "Working / Waiting
  // / Failed" reads as three states of one subject, which is a claim none of
  // them makes. "Outcomes" is the word that holds both, and it is short enough
  // to be drawn whole at the width the three figures share.
  //
  // A reading that failed draws no cards at all: the pane does not have those
  // counts, and a card is the loudest place to be wrong.
  const readable = snapshot.roster.state === "ready";
  // Each figure is also the way in to what it counted: pressing it narrows the
  // pane to those rows, and the line under the controls says so and offers the
  // press that widens it again.
  const card = (label: string, value: number, tone: "success" | "warning" | "error",
                which: Focus): { label: string; value: string; color: "success" | "warning"
                                 | "error" | "subtle"; press: Control } => ({
    label,
    value: String(value),
    color: value > 0 ? tone : "subtle",
    press: { key: FOCUS_PREFIX + which, label: label,
             onPress: pressTo(options, FOCUS_PREFIX + which) },
  });
  const cards = readable
    ? [card("Working sessions", workingNow, "success", "working"),
       card("Waiting on you", waitingNow, "warning", "waiting"),
       card("Failed outcomes", failedNow, "error", "failed")]
    : [];
  const unreadable = unreadableSources(snapshot);
  return {
    title: "Fleet",
    cards,
    counts,
    updated: { text: "Updated " + ageText(Math.max(0, options.now - snapshot.generated_at)),
               dim: true },
    warning: unreadable.length
      ? { text: unreadable.length + " source" + (unreadable.length === 1 ? "" : "s")
          + " unavailable", color: "warning" }
      : undefined,
    // Every control here carries the key the configuration bound to it, which is
    // what the keys section promises: a binding listed there and not on the
    // control is a shortcut the pane advertises and does not honour. Close is
    // always offered, because it is the one action that does not need a section
    // to act on; the two folds are offered only when there is something to fold.
    controls: [
      { key: CLOSE, label: "Close", hotkey: options.keys.close,
        onPress: pressTo(options, CLOSE), dim: true },
      ...(groups.length
        ? [{ ...ALL_CONTROLS[0], hotkey: options.keys.collapse,
             onPress: pressTo(options, ALL_CONTROLS[0].key) },
           { ...ALL_CONTROLS[1], hotkey: options.keys.expand,
             onPress: pressTo(options, ALL_CONTROLS[1].key) }]
        : []),
    ],
    // Escape closes the pane as well as its key: the engine opens it with
    // `closeOnEscape`, and a key nobody is told about is a key nobody presses.
    hint: "Esc or " + options.keys.close + " closes this pane",
    ...(focus === null ? {} : {
      focus: {
        text: "Showing " + focus + " only.",
        clear: { key: FOCUS_CLEAR, label: "Show all",
                 onPress: pressTo(options, FOCUS_CLEAR) },
      },
    }),
    footer: { text: FOOTER_TEXT, dim: true },
    digest: digestFrom(snapshot, options),
    ...(picker.length ? { picker } : {}),
    groups,
    width: options.width,
    narrowAt: options.narrowAt,
  };
}

/** The most events the digest lists; the rest are counted. */
export const DIGEST_LINES = 5;

/** What each kind of event is called on the digest, in the tone it is drawn in. */
const EVENT_WORDS: Record<string, { word: string; color: Slot["color"] }> = {
  "trial-failed": { word: "Trial failed", color: "error" },
  "trial-passed": { word: "Trial passed", color: "success" },
  "pr-opened": { word: "PR opened", color: "suggestion" },
  "job-waiting": { word: "Waiting on you", color: "warning" },
  "job-finished": { word: "Finished", color: "subtle" },
};

/**
 * What happened since the person last looked, from the reading's events.
 *
 * The events newer than the last look, newest first, at most five lines and the
 * rest counted. Nothing new from sources that were all read draws nothing at
 * all. A document that could not be
 * read says so in the error color and never reads as a quiet stretch, and a
 * source the events could not see is named under what they did see, so a digest
 * of two pull requests is not taken for everything that happened.
 *
 * When every event the reading holds is newer than the last look, the reader's
 * own limit may have left older ones out, so the count says "or more".
 */
export function digestFrom(snapshot: Snapshot, options: PaneOptions): Digest | null {
  const document = snapshot.events;
  if (options.lastSeen === undefined || document === undefined) {
    return null;
  }
  const lastSeen = options.lastSeen;
  const title = "Since you left";
  if (document.state === "failed" || document.state === "unavailable"
      || document.state === "unconfigured") {
    const reason = document.errors[0]?.reason;
    return { title, tone: "error", heading: [], through: null,
             lines: [[{ text: "Could not read what happened while you were away"
                              + (reason ? ": " + shown(reason).text : "") + ".",
                        color: document.state === "failed" ? "error" : "warning" }]] };
  }
  const fresh = document.events.filter((entry) => lastSeen === null || entry.at > lastSeen)
    .sort((left, right) => right.at - left.at);
  const unseen = Object.entries(document.sources)
    .filter(([, state]) => state === "failed" || state === "unavailable")
    .map(([name]) => name);
  const blind: Slot[][] = unseen.length
    ? [[{ text: unseen.join(", ") + " could not be read, so what they hold is not here",
          color: "warning" }]]
    : [];
  if (!fresh.length) {
    // Nothing new from what was seen is not nothing new: a source the events
    // could not see keeps its line, and nothing drawn as new moves the look.
    return blind.length
      ? { title, tone: "claude", heading: [{ text: "Nothing new from what could be read",
                                            color: "text" }],
          lines: blind, through: null }
      : null;
  }
  const lines: Slot[][] = fresh.slice(0, DIGEST_LINES).map((entry) => {
    const named = EVENT_WORDS[entry.kind] ?? { word: entry.kind, color: "subtle" as const };
    const parts: Slot[] = [{ text: named.word, color: named.color },
                           { text: shown(entry.title).text || "untitled" }];
    // A pull request's reference is the one a person reads, `owner/name#7`; a
    // trial's receipt key and a job's identifier are addresses, not words.
    if (entry.ref && entry.kind === "pr-opened") {
      parts.push({ text: " · " + shown(entry.ref).text, dim: true });
    }
    parts.push({ text: " · " + ageText(Math.max(0, options.now - entry.at)), dim: true });
    return parts;
  });
  const left = fresh.length - DIGEST_LINES;
  if (left > 0) {
    const capped = lastSeen !== null && fresh.length === document.events.length;
    lines.push([{ text: "+" + left + (capped ? " or more" : " more"), dim: true }]);
  }
  lines.push(...blind);
  const heading: Slot[] = [
    { text: fresh.length + " new", color: "text" },
    { text: lastSeen === null ? " · first look, newest first"
        : " · since your last look " + ageText(Math.max(0, options.now - lastSeen)), dim: true },
  ];
  return { title, tone: "claude", heading, lines,
           through: Math.max(...fresh.map((entry) => entry.at)) };
}

/** Every error any reader reported, in one list, for the warnings group. */
export function allErrors(snapshot: Snapshot): { source: string; reason: string }[] {
  const errors = [
    ...snapshot.roster.errors,
    ...snapshot.trials.errors,
    ...snapshot.session.errors,
    ...snapshot.progress.errors,
    ...snapshot.prs.errors,
    ...snapshot.skills.errors,
    ...snapshot.worktrees.errors,
    ...snapshot.load.errors,
    ...snapshot.custom.errors,
  ];
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = error.source + "|" + error.reason;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The sources a read could not reach, by their own names. */
export function unreadableSources(snapshot: Snapshot): string[] {
  const named: [string, string][] = [
    // The roster answers for both job rows and session counts: one read, one
    // source, so a failure there is one unreadable source and not two.
    ["roster", snapshot.roster.state],
    ["trials", snapshot.trials.state],
    ["session", snapshot.session.state],
    ["progress", snapshot.progress.state],
    ["prs", snapshot.prs.state],
    ["skills", snapshot.skills.state],
    ["worktrees", snapshot.worktrees.state],
    ["load", snapshot.load.state],
    ["custom", snapshot.custom.state],
    ...Object.entries(snapshot.custom.sections).map(
      ([key, section]): [string, string] => [CUSTOM_PREFIX + key, section.state]),
  ];
  return named.filter(([, state]) => state === "failed" || state === "unavailable")
    .map(([name]) => name);
}

/**
 * Failed test outcomes, counted once.
 *
 * A trial verdict and a run with failures are the same class of thing, so they
 * share one number. A pull-request check failure is a different denominator and
 * stays in its own group rather than being added to this one.
 */
export function failedOutcomes(snapshot: Snapshot): number {
  const trials = snapshot.trials.recent.filter((trial) => !trial.is_green).length;
  const runs = snapshot.progress.runs.filter((run) => run.failed > 0).length;
  return trials + runs;
}
