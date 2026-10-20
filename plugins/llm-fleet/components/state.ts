/**
 * What the readers produce, as the pane reads it.
 *
 * These types describe the JSON the readers emit. They are declared here rather
 * than generated from the Python side so the view layer has one readable
 * contract, and a field name that drifts shows up as a type error in this
 * repository instead of as a blank row on screen.
 */

export type SourceState = "disabled" | "unconfigured" | "unavailable" | "ready" | "paused";
export type ReaderState = SourceState | "empty" | "failed";

export type ReaderError = {
  source: string;
  reason: string;
};

export type FanEntry = {
  kind: string;
  label: string;
  startedAt?: number;
  doneAt?: number;
};

/**
 * What one session's own records say it has spent, and where it stands.
 *
 * Read from the session's own transcript, the subagent transcripts beside it and
 * the session's task list. A figure the records did not carry is absent rather
 * than nought, and `lowerBound` says the totals come from a transcript too long
 * to read whole, or from a subagent transcript nobody could read, so they are
 * less than the session spent, never more. `reason` names which.
 */
/** What a model was priced from, and when its card was read, in epoch seconds. */
export type RateAccount = {
  state: "live" | "cached" | "table";
  checkedAt: number | null;
  reason?: string;
};

/**
 * One model a session ran: its turns, and their cost at that model's own rate,
 * or null when no rate prices it. `model` is null for turns no record named.
 */
export type ModelSpend = {
  model: string | null;
  turns: number;
  costUsd: number | null;
  rates?: RateAccount;
};

export type AgentFigures = {
  state: ReaderState | "unavailable";
  reason?: string;
  title?: string | null;
  model?: string | null;
  effort?: string | null;
  turns?: number;
  contextTokens?: number;
  contextWindow?: number;
  tokens?: { input: number; cacheWrite: number; cacheRead: number; output: number };
  costUsd?: number;
  /**
   * "host" is the cost the host recorded and that covers the whole session;
   * "estimate" is usage at configured rates; "floor" is the larger of a host
   * record that covers part of the session and the estimate.
   */
  costSource?: "host" | "estimate" | "floor";
  /**
   * Where the model's rates came from: its provider's card read within the
   * allowed age, a card kept from an earlier read whose page failed since, or
   * the shipped table. Absent when the read carried no account.
   */
  rates?: RateAccount;
  /** Each model the session and its subagents ran, dearest first. */
  models?: ModelSpend[];
  lowerBound?: boolean;
  /** The session's first turn, when the transcript was read from its start. */
  firstActivity?: number | null;
  lastActivity?: number | null;
  /** The session's own task list: the only plan a step count may be drawn from. */
  steps?: { done: number; total: number; phase: string | null } | null;
  /** Its working and idle stretches over the window, oldest first; null when not read. */
  timeline?: TimelineSegment[] | null;
};

export type Job = {
  id: string;
  name: string;
  state: string;
  cwd: string;
  started_at: number | null;
  provider: string;
  label: string;
  /** The full session identifier a reply goes to, when the registry gave one. */
  session_id?: string | null;
  /** What a waiting job asks, and the reply it suggests, already printable. */
  needs?: string | null;
  suggested_reply?: string | null;
  /**
   * The SHA-256 of the whole question, as the reader read it: `needs` is cut to
   * fit a row, and a reply is remembered by, and sent only to, this question.
   */
  needs_hash?: string | null;
  /**
   * Where a reply to this question stands on this machine, as the helper's marker
   * records it: on its way since `at`, or sent. None when no pane has sent one.
   */
  reply?: JobReply | null;
  /** A working job mid-turn or between turns, when the registry says. */
  activity?: "busy" | "idle" | null;
  detail?: string | null;
  fan?: FanEntry[];
  /** When the job entered its state, as far as any read has seen. */
  since?: number | null;
  /**
   * The line that opens the job in a terminal, quoted for a POSIX shell, as the
   * reader built it from the provider's home; absent from older readings.
   */
  attach_command?: string | null;
  /** The card's figures, when the agents source is on. */
  agent?: AgentFigures;
};

export type JobReply = { state: "pending" | "sent"; at: number }
  /** A record there that does not read; `id` names that very file when the reading says. */
  | { state: "unreadable"; at: null; id: string | null };

export type Roster = {
  state: ReaderState;
  jobs: Job[];
  interactive: Record<string, number>;
  errors: ReaderError[];
  providers: Record<string, { state: SourceState; reason: string | null }>;
  sources: { jobs: ReaderState; interactive: ReaderState };
  /**
   * What the roster's sessions spent per bucket of the window, oldest first.
   * Null where no provider answered with the agent source on: a row of zeros
   * from a roster nobody read would be a claim. Absent from older readings.
   */
  spend_series?: SpendSeries | null;
};

/**
 * Spend over a window, one figure per bucket, as the reader summed it.
 *
 * `complete` is false when a figure the series should hold could be missing, so
 * its total is a floor; `sessions` is how many cards it sums.
 */
export type SpendSeries = {
  bucket_minutes: number;
  buckets: number[];
  total: number;
  complete: boolean;
  sessions: number | null;
};

/** One stretch of a session's recent work, in epoch seconds: working or idle. */
export type TimelineSegment = { start: number; end: number; state: string };

/** One check run on a pull request, as the reader states it: pass, fail or pending. */
export type CheckRun = { name: string; state: string };

/** Something that happened, for the "since you left" digest, in epoch seconds. */
export type DigestEvent = { at: number; kind: string; title: string; ref: string };

/**
 * The events a whole reading holds, newest first, and the state each document
 * they came from was read in, so a digest can say what it could not see.
 */
export type Events = {
  state: ReaderState;
  events: DigestEvent[];
  sources: Record<string, string>;
  errors: ReaderError[];
};

export type Lease = {
  repo: string;
  branch: string;
  tool: string;
  expires_at: number;
  session: string;
};

export type Trial = {
  key: string;
  repo: string;
  branch: string;
  change_state: string;
  at: number;
  is_green: boolean;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
};

/** One hour of the trials window: how many landed in it and how many failed. */
export type TrialBucket = {
  outcomes: number;
  failed: number;
};

/**
 * The trials window as buckets, which is what the pane's strip is drawn from.
 *
 * It is null, rather than a run of empty buckets, whenever the store behind it
 * was not read: a strip of track is a claim about twelve hours, and a source
 * that was switched off has not measured any.
 */
export type TrialHistory = {
  label: string;
  hours: number;
  cells: TrialBucket[];
  outcomes: number;
  failed: number;
};

/**
 * This session's own figures, as the renderer last recorded them.
 *
 * Every field is optional but `absent` names each one the payload did not carry:
 * a session whose context window nobody reported is not a session at 0% of one,
 * and the only way the pane can tell those apart is if this layer keeps them
 * apart rather than filling them in.
 */
export type SessionFigures = {
  state: ReaderState;
  absent: string[];
  costUsd?: number;
  /** A routed session's spend, priced by the status line from its transcript. */
  providerCostUsd?: number;
  /** Where the cost came from: the provider's own pricing, or the host's table. */
  costSource?: "provider" | "host" | "estimate";
  /** What every routed session spent inside the configured window, priced from the status line's files. */
  spendWindowUsd?: number;
  /** How many files contributed to the window spend. */
  spendWindowFiles?: number;
  /** How many files inside the window could not be read or priced. */
  spendWindowSkipped?: number;
  durationMs?: number;
  apiDurationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  inputTokens?: number;
  outputTokens?: number;
  remainingPercent?: number;
  windowSize?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  fiveHourUsedPercent?: number;
  fiveHourResetsAt?: number;
  sevenDayUsedPercent?: number;
  weekResetsAt?: number;
  spendUsedPercent?: number;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  version?: string;
  model?: string;
  modelName?: string;
  outputStyle?: string;
  parameters: Record<string, string>;
  errors: ReaderError[];
};

/** One change still moving through the controller, and its place on the stage path. */
export type Change = {
  repo: string;
  branch: string;
  state: string;
  /** Its place on the configured path, first stage 1; null for a state the path does not name. */
  stage: number | null;
  stages: number;
  moved_at: number | null;
  /** The tool holding a live lease on it, when one does. */
  held_by: string | null;
};

export type Trials = {
  state: ReaderState;
  running: Lease[];
  recent: Trial[];
  history: TrialHistory | null;
  /** Changes in flight; absent from a snapshot assembled before they were read. */
  changes?: Change[];
  /**
   * The machine-wide on/off switch the reader found, or null when no switch file
   * is configured or it could not be looked at.
   */
  switch?: "on" | "off" | null;
  errors: ReaderError[];
};

export type Run = {
  key: string;
  repo: string;
  branch: string | null;
  label: string;
  display: string;
  done: number;
  total: number;
  failed: number;
  first_failure: string;
  elapsed: number;
  eta_minutes: number | null;
  phase: string;
  /** "wait" while the governor holds the command, "run" once it runs; absent from older readings. */
  kind?: string | null;
  command_class?: string;
  /** The command's place in the governor's queue, and the queue's length, when it said. */
  queue_position?: number | null;
  queue_total?: number | null;
  /** The wait the governor set, and what is left of it, in seconds, while it holds the command. */
  wait_total?: number | null;
  wait_left?: number | null;
};

export type Progress = {
  state: ReaderState;
  runs: Run[];
  /**
   * The machine-wide on/off switch the reader found, or null when no switch file
   * is configured or it could not be looked at.
   */
  switch?: "on" | "off" | null;
  errors: ReaderError[];
};

export type PullRequest = {
  repo: string;
  /** Absent when the command did not report one: a row shows no number rather than a zero. */
  number: number | null;
  title: string;
  branch: string;
  head: string;
  is_draft: boolean;
  checks: "pass" | "fail" | "pending" | "none";
  /** Each check by name, capped by the reader, failing ones kept first; absent from older readings. */
  check_runs?: CheckRun[];
  /** How many checks the cap left out of `check_runs`. */
  check_runs_more?: number;
  /** When the pull request was opened, in epoch seconds; null when not stated. */
  opened_at?: number | null;
  /**
   * True when the person's own search found this repository rather than the
   * configuration naming it. The owner is then the same on every such row, so
   * the pane draws the project alone and keeps the width for the name that
   * varies. Absent from a reading made before this was carried.
   */
  mine?: boolean;
};

export type PullRequests = {
  state: ReaderState;
  prs: PullRequest[];
  errors: ReaderError[];
};

export type SkillItem = {
  name: string;
  /** The folder, home-relative. */
  target: string;
  verdict: string;
  score: number | null;
  hash: string;
  /** The worst finding as one line, empty when there is none. */
  issue: string;
};

export type Skills = {
  state: ReaderState;
  generated_at: number | null;
  counts: Record<string, number>;
  items: SkillItem[];
  new: SkillItem[];
  running: { done: number; total: number } | null;
  /** The line that prints every finding, as configured; null when none is. */
  report_command?: string | null;
  errors: ReaderError[];
};

export type Worktree = {
  name: string;
  path: string;
  /** The project this worktree belongs to, as git names it; absent when git could not say. */
  project?: string;
  /** That project's root, carried to the hover card; absent with `project`. */
  project_root?: string;
  branch: string;
  state: "merged" | "held" | "active" | "unknown" | "preserved";
  /**
   * Whether the branch is in the base ref; null when that could not be told, as
   * for a cut-off probe or a comparison git failed. An unknown is never drawn as
   * merged or as not merged, and never offered for cleanup.
   */
  merged: boolean | null;
  /** Whether an archive ref keeps the branch; null when the lookup failed. */
  archived: boolean | null;
  /** Whether a live process has the folder open; null when that could not be checked. */
  held: boolean | null;
  error?: string;
  cleanup_command: string;
  /** Why no cleanup command is offered, when the reader refused to build one. */
  cleanup_note?: string;
  change_state?: string | null;
  change_owner?: string | null;
  change_updated_at?: number | null;
  /** When this row was last read successfully, kept across a failed recheck. */
  checked_at?: number;
  recheck_error?: string;
};

export type Worktrees = {
  state: ReaderState;
  worktrees: Worktree[];
  /** Worktrees cleaned inside the retention window, absent when nothing could say. */
  cleaned: number | null;
  errors: ReaderError[];
};

/**
 * One process under load, as the platform's process table reported it.
 *
 * `cpu_percent` is the platform's own reading for the moment it was sampled,
 * never an average this layer computed. `project` is absent when nobody could
 * read the process's working directory, which is a fact about the read rather
 * than a process that belongs to no project.
 */
export type LoadProcess = {
  pid: number;
  command: string;
  cpu_percent: number;
  memory_bytes: number;
  elapsed_seconds: number;
  project?: string;
  project_root?: string;
};

export type Load = {
  state: ReaderState;
  /** When the process table was sampled, in epoch seconds. */
  sampled_at: number | null;
  /** How many processes the machine reported, which is what the drawn ones were chosen from. */
  total: number;
  processes: LoadProcess[];
  errors: ReaderError[];
};

/**
 * The machine's governor and controller switch.
 *
 * The tool that owns the switch writes one small document, so a state this
 * layer draws is one the reader read: a file that could not be read is failed
 * and carries no scope at all, rather than the tool's own "both on" default.
 */
/** One of pacer's machine-wide run slots. */
export type PacerSlot = {
  slot: number;
  /** The lock decides this, so a busy slot may name nobody. */
  busy: boolean;
  pid: number | null;
  repo: string | null;
  /** Epoch seconds the holder took the slot, when it said. */
  startedAt: number | null;
};

/** A caller blocked on a slot. */
export type PacerWaiter = { pid: number | null; repo: string | null; since: number };

/** A run pacer recorded when it ended. */
export type PacerRun = {
  at: number;
  repo: string | null;
  waitSeconds: number | null;
  runSeconds: number | null;
  exit: number;
  slot: number | null;
  /** on, off, nested, refused, failopen or interrupted, as pacer wrote it. */
  mode: string | null;
  reason: string | null;
};

/** The machine's run slots, as pacer's own status reports them. */
export type Pacer = {
  state: ReaderState;
  /** Whether pacer is on; absent when nothing was read. */
  enabled: boolean | null;
  /** Where the switch's answer came from: missing, file, corrupt or env. */
  switchSource: string | null;
  reason: string | null;
  version: number | null;
  slotCount: number | null;
  workersPerRun: number | null;
  slots: PacerSlot[];
  /** Null when pacer did not report its waiters, which is not nobody waiting. */
  waiting: PacerWaiter[] | null;
  /** Null when pacer did not report its runs. */
  recent: PacerRun[] | null;
  errors: ReaderError[];
};

export type Governance = {
  state: ReaderState;
  /** Whether each scope is on, absent when the document was not a reading. */
  governor: boolean | null;
  controller: boolean | null;
  /** Where the answer came from: the file, a legacy marker, or a missing file's default. */
  source: string | null;
  /** The switch file the configuration named. */
  path: string | null;
  /** When the switch last moved, as the writer stamped it. */
  updated_at: string | null;
  /** Who moved it, as the writer recorded. */
  by: string | null;
  errors: ReaderError[];
};

/** One row a custom section's command printed, checked by the reader. */
export type CustomRow = {
  title: string;
  state: string | null;
  detail: string | null;
  slot: string | null;
  /** A bar's parts, both present or both null: the reader never fills one in. */
  done: number | null;
  total: number | null;
  failed: number | null;
};

/** A section a person added, with the settings it was declared with. */
export type CustomSection = {
  state: ReaderState;
  title: string;
  legend: string | null;
  visible: boolean;
  collapsed: boolean;
  hideWhenEmpty: boolean;
  /** The most rows drawn, as the section was declared with; absent from older readings. */
  maxRows?: number;
  summary: string | null;
  rows: CustomRow[];
  /** How many rows the command printed, which can be more than the rows carried. */
  printed: number;
  errors: ReaderError[];
};

export type Custom = {
  state: ReaderState;
  /** By the key the section was declared under, in the order it was declared. */
  sections: Record<string, CustomSection>;
  errors: ReaderError[];
};

/** Everything the pane reads, as one snapshot. */
export type Snapshot = {
  generated_at: number;
  roster: Roster;
  trials: Trials;
  session: SessionFigures;
  progress: Progress;
  prs: PullRequests;
  skills: Skills;
  worktrees: Worktrees;
  load: Load;
  custom: Custom;
  /** The machine's governor and controller switch; absent from a reading taken before it was read. */
  governance?: Governance;
  /** Pacer's run slots; absent from a reading taken before they were read. */
  pacer?: Pacer;
  /** The digest's events; absent from a reading taken before they were read, or a part of one. */
  events?: Events;
};
