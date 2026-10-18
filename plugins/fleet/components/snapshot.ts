/**
 * The snapshot, assembled from what the readers printed.
 *
 * The readers are a separate process, so what arrives here is parsed JSON and not
 * a value this program built. Every field is therefore checked before it is used:
 * a document that is missing, of the wrong shape, or naming a state this layer
 * does not know becomes a source that failed, never a group that quietly reads as
 * empty. That distinction is the whole reason this function exists rather than a
 * cast.
 */

import type {
  AgentFigures, FanEntry, Job, JobReply, Lease, Load, LoadProcess, Progress, PullRequest, PullRequests, ReaderState, Roster, Run, SkillItem, Skills,
  SessionFigures, Snapshot, SourceState, Trial, TrialBucket, TrialHistory, Trials, Worktree,
  Worktrees, Change, Custom, CustomRow, CustomSection, CheckRun, DigestEvent, Events, SpendSeries,
  TimelineSegment } from "./state.ts";

export type ReaderDocuments = {
  roster?: unknown;
  trials?: unknown;
  session?: unknown;
  progress?: unknown;
  prs?: unknown;
  skills?: unknown;
  worktrees?: unknown;
  load?: unknown;
  custom?: unknown;
  events?: unknown;
};

const READER_STATES = new Set<ReaderState>([
  "disabled", "unconfigured", "unavailable", "ready", "empty", "failed", "paused",
]);

const WORKTREE_STATES = new Set<Worktree["state"]>([
  "merged", "held", "active", "unknown", "preserved",
]);

// The states that say whether a branch is merged: active and preserved say it is
// not, merged says it is. Held says only that a process has the folder open.
const MERGE_CLAIMS = new Set<Worktree["state"]>(["merged", "active", "preserved"]);

/**
 * Whether a worktree's state rests on facts the row carries. Held needs a
 * process seen holding it; merged, active and preserved need the merge, the
 * archive and the holders all answered, the last with nothing holding it. A
 * state without its facts is drawn as unknown, never as the claim.
 */
function believed(state: Worktree["state"], merged: boolean | null, archived: boolean | null,
                  held: boolean | null): boolean {
  if (state === "held") {
    return held === true;
  }
  if (MERGE_CLAIMS.has(state)) {
    return merged !== null && archived !== null && held === false;
  }
  return true;
}

// A provider has a configuration state, not a reader state: whether a home was
// read is a property of the roster, not of the home.
const PROVIDER_STATES = new Set<SourceState>([
  "disabled", "unconfigured", "unavailable", "ready",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function maybeText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function maybeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The moment the read finished, as the reading recorded it.
 *
 * The reader stamps the top level of what it prints, and that stamp is the
 * reading's, not the paint's: a reading drawn a second after it was taken and
 * one drawn on the next session's first frame are the same reading, and the age
 * beside the counts has to say which. A reading with no usable clock of its own
 * falls back to the moment the caller read it, which is what a document set
 * that never carried one used to get.
 */
function readingClock(documents: ReaderDocuments, readAt: number): number {
  const claimed = (documents as { generated_at?: unknown }).generated_at;
  // A stamp later than the read that carries it is inconsistent: the reader
  // stamps its own clock before it returns. Drawn as-is it would date the
  // reading to the future and clamp to an age of nothing, so the recorded time
  // wins, being the one that cannot be wrong.
  return typeof claimed === "number" && Number.isFinite(claimed) && claimed <= readAt
    ? claimed
    : readAt;
}

/**
 * The state a document claims.
 *
 * Absent means no read happened, so the source is empty; present but not an
 * object, or naming a state this layer does not know, means the read went wrong
 * and is reported as failed. Reading the second as empty would claim nothing is
 * running when nothing could be read.
 */
function stateOf(document: unknown, fallback: ReaderState): ReaderState {
  if (document === undefined || document === null) {
    return fallback;
  }
  if (!isObject(document)) {
    return "failed";
  }
  const claimed = document.state;
  return typeof claimed === "string" && READER_STATES.has(claimed as ReaderState)
    ? claimed as ReaderState
    : "failed";
}

function errorsOf(document: unknown): { source: string; reason: string }[] {
  if (!isObject(document)) {
    return [];
  }
  return list(document.errors).filter(isObject).map((entry) => ({
    source: text(entry.source, "unknown"),
    reason: text(entry.reason, "no reason was given"),
  }));
}

/** A count the reader published, kept only when it is one: whole and not negative. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A card's figures, kept field by field, and only as the reader published them.
 *
 * Anything that is not the shape it should be is left out rather than repaired:
 * a token total missing one of its four parts is no total, a step count whose
 * done exceeds its total is no step count, and a cost that is not a finite,
 * non-negative number is no cost. Each absence draws as the words for it.
 */
function agentOf(value: unknown): AgentFigures | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const state = stateOf(value, "failed");
  const figures: AgentFigures = { state };
  if (typeof value.reason === "string") {
    figures.reason = value.reason;
  }
  figures.title = maybeText(value.title);
  figures.model = maybeText(value.model);
  figures.effort = maybeText(value.effort);
  const turns = tokenCount(value.turns);
  if (turns !== undefined) {
    figures.turns = turns;
  }
  const context = tokenCount(value.contextTokens);
  if (context !== undefined) {
    figures.contextTokens = context;
  }
  const window = tokenCount(value.contextWindow);
  if (window !== undefined && window > 0) {
    figures.contextWindow = window;
  }
  if (isObject(value.tokens)) {
    const parts = ["input", "cacheWrite", "cacheRead", "output"].map(
      (key) => tokenCount((value.tokens as Record<string, unknown>)[key]));
    if (parts.every((part) => part !== undefined)) {
      const [input, cacheWrite, cacheRead, output] = parts as number[];
      figures.tokens = { input, cacheWrite, cacheRead, output };
    }
  }
  const cost = value.costUsd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      && (value.costSource === "host" || value.costSource === "estimate"
          || value.costSource === "floor")) {
    figures.costUsd = cost;
    figures.costSource = value.costSource;
  }
  figures.lowerBound = value.lowerBound === true;
  figures.firstActivity = maybeCount(value.firstActivity);
  figures.lastActivity = maybeCount(value.lastActivity);
  const steps = value.steps;
  if (isObject(steps)) {
    const done = tokenCount(steps.done);
    const total = tokenCount(steps.total);
    figures.steps = done !== undefined && total !== undefined && total > 0 && done <= total
      ? { done, total, phase: maybeText(steps.phase) } : null;
  } else {
    figures.steps = null;
  }
  figures.timeline = timelineOf(value.timeline);
  return figures;
}

/**
 * An ISO 8601 time that states its zone, as epoch seconds, or null.
 *
 * The readers write UTC with a `Z`. A time with no zone is read by the runtime
 * as this machine's local time, which is a guess at what the writer meant, so it
 * is refused rather than placed.
 */
function isoSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

/**
 * A session's working and idle stretches, or null when there is no timeline to
 * draw: not read, not a list, or holding a stretch that is not two times in
 * order with a state. One bad stretch refuses the whole, because a strip drawn
 * with a hole in it says the session was doing nothing there.
 */
function timelineOf(value: unknown): TimelineSegment[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const segments: TimelineSegment[] = [];
  for (const entry of value) {
    const start = isObject(entry) ? isoSeconds(entry.start) : null;
    const end = isObject(entry) ? isoSeconds(entry.end) : null;
    if (!isObject(entry) || start === null || end === null || end < start
        || typeof entry.state !== "string" || !entry.state) {
      return null;
    }
    segments.push({ start, end, state: entry.state });
  }
  return segments;
}

/**
 * The roster's spend over its window, kept whole or not at all: a bucket that is
 * not a figure, or a figure below nothing, is a series that cannot be drawn, and
 * a line drawn with that bucket as a zero would say the hour cost nothing.
 */
function spendSeriesOf(value: unknown): SpendSeries | null {
  if (!isObject(value) || !Array.isArray(value.buckets)) {
    return null;
  }
  const minutes = value.bucket_minutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) {
    return null;
  }
  const buckets: number[] = [];
  for (const bucket of value.buckets) {
    if (typeof bucket !== "number" || !Number.isFinite(bucket) || bucket < 0) {
      return null;
    }
    buckets.push(bucket);
  }
  const total = value.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return null;
  }
  return { bucket_minutes: minutes, buckets, total, complete: value.complete === true,
           sessions: wholeCount(value.sessions) };
}

/**
 * A pull request's checks by name and state. An entry that is not a check is
 * dropped; one with no name keeps its dot under the empty name, as the reader
 * sends it, so the dots still add up to the checks it listed.
 */
function checkRunsOf(value: unknown[]): CheckRun[] {
  return value.filter((entry): entry is Record<string, unknown> =>
    isObject(entry) && typeof entry.name === "string" && typeof entry.state === "string")
    .map((entry) => ({ name: entry.name as string, state: entry.state as string }));
}

/**
 * The digest's events, newest first as the reader wrote them.
 *
 * An event whose time does not read, or whose words are not text, is dropped:
 * the digest is a list of what happened, and an event placed at a guessed time
 * would land on the wrong side of the last look. A ready document whose events
 * are not a list is not a quiet stretch either, and reads as failed.
 */
function eventsFrom(document: unknown): Events | undefined {
  if (document === undefined || document === null) {
    return undefined;
  }
  let state = stateOf(document, "failed");
  const body = isObject(document) ? document : {};
  if (state === "ready" && !Array.isArray(body.events)) {
    state = "failed";
  }
  const events: DigestEvent[] = [];
  for (const entry of list(body.events)) {
    const at = isObject(entry) ? isoSeconds(entry.at) : null;
    if (!isObject(entry) || at === null || typeof entry.kind !== "string"
        || typeof entry.title !== "string" || typeof entry.ref !== "string") {
      continue;
    }
    events.push({ at, kind: entry.kind, title: entry.title, ref: entry.ref });
  }
  const sources: Record<string, string> = {};
  if (isObject(body.sources)) {
    for (const [name, value] of Object.entries(body.sources)) {
      if (typeof value === "string") {
        sources[name] = value;
      }
    }
  }
  return { state, events, sources, errors: errorsOf(document) };
}

/** A moment the job's state file recorded, kept only when it is a finite number. */
function moment(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The subagent tasks a job's state file lists, each kept only with the two words
 * that name it: an entry without a kind or a label is no task a row can name.
 */
function fanOf(value: unknown): FanEntry[] {
  const entries: FanEntry[] = [];
  for (const entry of list(value)) {
    if (!isObject(entry) || typeof entry.kind !== "string" || typeof entry.label !== "string"
        || !entry.kind || !entry.label) {
      continue;
    }
    const startedAt = moment(entry.startedAt);
    const doneAt = moment(entry.doneAt);
    entries.push({ kind: entry.kind, label: entry.label,
                   ...(startedAt === undefined ? {} : { startedAt }),
                   ...(doneAt === undefined ? {} : { doneAt }) });
  }
  return entries;
}

/** Where a reply stands, kept only in the two states the helper writes and with a time. */
function replyOf(value: unknown): JobReply | null {
  if (isObject(value) && value.state === "unreadable") {
    // A marker that is there but does not read still holds the question.
    const id = typeof value.id === "string" && value.id.length > 0 && value.id.length <= 64 ? value.id : null;
    return { state: "unreadable", at: null, id };
  }
  if (!isObject(value) || (value.state !== "pending" && value.state !== "sent")) {
    return null;
  }
  const at = maybeCount(value.at);
  return at === null ? null : { state: value.state, at };
}

function jobsOf(document: unknown): Job[] {
  if (!isObject(document)) {
    return [];
  }
  return list(document.jobs).filter(isObject).map((entry) => ({
    id: text(entry.id),
    name: text(entry.name, "unnamed"),
    state: text(entry.state, "unknown"),
    cwd: text(entry.cwd),
    started_at: maybeCount(entry.started_at),
    provider: text(entry.provider),
    label: text(entry.label, text(entry.provider)),
    session_id: maybeText(entry.session_id),
    needs: maybeText(entry.needs),
    needs_hash: maybeText(entry.needs_hash),
    reply: replyOf(entry.reply),
    suggested_reply: maybeText(entry.suggested_reply),
    activity: entry.activity === "busy" || entry.activity === "idle" ? entry.activity : null,
    detail: maybeText(entry.detail),
    fan: fanOf(entry.fan),
    since: maybeCount(entry.since),
    attach_command: maybeText(entry.attach_command),
    ...(entry.agent === undefined ? {} : { agent: agentOf(entry.agent) }),
  }));
}

function rosterFrom(document: unknown): Roster {
  const sources = isObject(document) && isObject(document.sources) ? document.sources : {};
  const counts: Record<string, number> = {};
  if (isObject(document) && isObject(document.interactive)) {
    for (const [name, value] of Object.entries(document.interactive)) {
      counts[name] = count(value);
    }
  }
  const providers: Roster["providers"] = {};
  if (isObject(document) && isObject(document.providers)) {
    for (const [name, value] of Object.entries(document.providers)) {
      const entry = isObject(value) ? value : {};
      providers[name] = {
        state: (typeof entry.state === "string" && PROVIDER_STATES.has(entry.state as SourceState)
          ? entry.state as SourceState : "unavailable"),
        reason: maybeText(entry.reason),
      };
    }
  }
  return {
    state: stateOf(document, "empty"),
    jobs: jobsOf(document),
    interactive: counts,
    errors: errorsOf(document),
    providers,
    sources: {
      jobs: stateOf(sources, "empty"),
      interactive: stateOf(sources, "empty"),
    },
    spend_series: isObject(document) ? spendSeriesOf(document.spend_series) : null,
  };
}

function trialsFrom(document: unknown): Trials {
  const running: Lease[] = list(isObject(document) ? document.running : [])
    .filter(isObject)
    .map((entry) => ({
      repo: text(entry.repo),
      branch: text(entry.branch),
      tool: text(entry.tool),
      expires_at: count(entry.expires_at),
      session: text(entry.session),
    }));
  const recent: Trial[] = list(isObject(document) ? document.recent : [])
    .filter(isObject)
    .map((entry) => ({
      key: text(entry.key),
      repo: text(entry.repo),
      branch: text(entry.branch),
      change_state: text(entry.change_state),
      at: count(entry.at),
      is_green: entry.is_green === true,
      passed: count(entry.passed),
      failed: count(entry.failed),
      errors: count(entry.errors),
      skipped: count(entry.skipped),
    }));
  const changes: Change[] = list(isObject(document) ? document.changes : [])
    .filter(isObject)
    .map((entry) => ({
      repo: text(entry.repo),
      branch: text(entry.branch),
      state: text(entry.state),
      stage: maybeCount(entry.stage),
      stages: count(entry.stages),
      moved_at: maybeCount(entry.moved_at),
      held_by: maybeText(entry.held_by),
    }));
  return { state: stateOf(document, "empty"), running, recent, changes,
           history: historyFrom(isObject(document) ? document.history : null),
           switch: switchOf(document),
           errors: errorsOf(document) };
}

/**
 * The trials window, when the reading carries one this pane can draw.
 *
 * Null for anything a strip cannot be drawn from: a missing block, one whose
 * cells are not a list, or a bucket that is not two counts. A bucket read as
 * zero would be an hour reported as quiet, which is the claim a strip makes
 * most loudly, and this is the layer that refuses to make it on a guess.
 */
function historyFrom(value: unknown): TrialHistory | null {
  if (!isObject(value) || !Array.isArray(value.cells)) {
    return null;
  }
  const cells: TrialBucket[] = [];
  for (const cell of value.cells) {
    if (!isObject(cell) || !Number.isFinite(cell.outcomes) || !Number.isFinite(cell.failed)) {
      return null;
    }
    cells.push({ outcomes: count(cell.outcomes), failed: count(cell.failed) });
  }
  return {
    label: text(value.label) || "Recent trials",
    hours: count(value.hours),
    cells,
    outcomes: count(value.outcomes),
    failed: count(value.failed),
  };
}

/** The machine switch a document reports, when it reports one. */
function switchOf(document: unknown): "on" | "off" | null {
  const value = isObject(document) ? document.switch : undefined;
  return value === "on" || value === "off" ? value : null;
}

function progressFrom(document: unknown): Progress {
  const runs: Run[] = list(isObject(document) ? document.runs : [])
    .filter(isObject)
    .map((entry) => ({
      key: text(entry.key),
      repo: text(entry.repo),
      branch: maybeText(entry.branch),
      label: text(entry.label),
      display: text(entry.display, "unnamed run"),
      done: count(entry.done),
      total: count(entry.total),
      failed: count(entry.failed),
      first_failure: text(entry.first_failure),
      elapsed: count(entry.elapsed),
      eta_minutes: maybeCount(entry.eta_minutes),
      phase: text(entry.phase),
      kind: maybeText(entry.kind),
      command_class: text(entry.command_class),
      queue_position: maybeCount(entry.queue_position),
      queue_total: maybeCount(entry.queue_total),
      wait_total: maybeCount(entry.wait_total),
      wait_left: maybeCount(entry.wait_left),
    }));
  return { state: stateOf(document, "empty"), runs, switch: switchOf(document),
           errors: errorsOf(document) };
}

function pullRequestsFrom(document: unknown): PullRequests {
  const prs: PullRequest[] = list(isObject(document) ? document.prs : [])
    .filter(isObject)
    .map((entry) => ({
      repo: text(entry.repo),
      number: maybeCount(entry.number),
      title: text(entry.title),
      branch: text(entry.branch),
      head: text(entry.head),
      is_draft: entry.is_draft === true,
      checks: entry.checks === "pass" || entry.checks === "fail" || entry.checks === "pending"
        ? entry.checks : "none",
      ...(Array.isArray(entry.check_runs) ? { check_runs: checkRunsOf(entry.check_runs) } : {}),
      check_runs_more: wholeCount(entry.check_runs_more) ?? 0,
      opened_at: isoSeconds(entry.opened_at),
      mine: entry.mine === true,
    }));
  return { state: stateOf(document, "empty"), prs, errors: errorsOf(document) };
}

function skillItems(value: unknown): SkillItem[] {
  return list(value).filter(isObject).map((entry) => ({
    name: text(entry.name, "unnamed"),
    target: text(entry.target),
    verdict: text(entry.verdict, "review"),
    score: maybeCount(entry.score),
    hash: text(entry.hash),
    issue: text(entry.issue),
  }));
}

function skillsFrom(document: unknown): Skills {
  const source = isObject(document) ? document : {};
  const running = isObject(source.running)
    ? { done: count(source.running.done), total: count(source.running.total) }
    : null;
  const counts: Record<string, number> = {};
  if (isObject(source.counts)) {
    for (const [name, value] of Object.entries(source.counts)) {
      counts[name] = count(value);
    }
  }
  return {
    state: stateOf(document, "empty"),
    generated_at: maybeCount(source.generated_at),
    counts,
    items: skillItems(source.items),
    new: skillItems(source.new),
    // A running scan without a total has no denominator to report.
    running: running && running.total > 0 ? running : null,
    report_command: maybeText(source.report_command),
    errors: errorsOf(document),
  };
}

/**
 * The figures and the words a session document may carry, by the name the pane
 * draws them under.
 *
 * The two lists are the shape of the reader's document, and they are here rather
 * than beside each field's use so that a field the reader stops sending stops
 * being read: a map written out twice drifts, and the half that drifts draws a
 * figure under a name nothing produces.
 */
const NUMBER_FIELDS: string[] = [
  "costUsd", "providerCostUsd", "durationMs", "apiDurationMs", "linesAdded", "linesRemoved", "inputTokens",
  "outputTokens", "remainingPercent", "windowSize", "cacheReadTokens", "cacheCreationTokens",
  "fiveHourUsedPercent", "fiveHourResetsAt", "sevenDayUsedPercent", "weekResetsAt",
  "spendUsedPercent", "spendWindowUsd", "spendWindowFiles", "spendWindowSkipped",
];
const TEXT_FIELDS: string[] = [
  "sessionId", "sessionName", "cwd", "version", "model", "modelName", "outputStyle",
  "costSource",
];

function worktreesFrom(document: unknown): Worktrees {
  const source = isObject(document) ? document : {};
  const worktrees: Worktree[] = list(source.worktrees).filter(isObject).map((entry) => {
    const named = typeof entry.state === "string" && WORKTREE_STATES.has(entry.state as Worktree["state"])
      ? entry.state as Worktree["state"]
      : "unknown";
    // Anything but a boolean is a fact nobody could tell.
    const merged = typeof entry.merged === "boolean" ? entry.merged : null;
    const archived = typeof entry.archived === "boolean" ? entry.archived : null;
    const held = typeof entry.held === "boolean" ? entry.held : null;
    const claimed = believed(named, merged, archived, held) ? named : "unknown";
    return {
      name: text(entry.name, "unnamed"),
      path: text(entry.path),
      project: maybeText(entry.project) ?? undefined,
      project_root: maybeText(entry.project_root) ?? undefined,
      branch: text(entry.branch),
      state: claimed,
      merged,
      archived,
      held,
      error: maybeText(entry.error) ?? undefined,
      cleanup_command: text(entry.cleanup_command),
      cleanup_note: maybeText(entry.cleanup_note) ?? undefined,
      change_state: maybeText(entry.change_state),
      change_owner: maybeText(entry.change_owner),
      change_updated_at: maybeCount(entry.change_updated_at),
      checked_at: maybeCount(entry.checked_at) ?? undefined,
      recheck_error: maybeText(entry.recheck_error) ?? undefined,
    };
  });
  return {
    state: stateOf(document, "empty"),
    worktrees,
    cleaned: maybeCount(source.cleaned),
    errors: errorsOf(document),
  };
}

/**
 * The processes under load, each kept only with the four figures a row draws.
 *
 * A process missing its pid, its command or one of its measurements is dropped
 * rather than drawn with a nought: a process at 0% CPU is a process this layer
 * measured, and one the listing did not describe is not. A project is kept only
 * as a non-empty name, with its root when the reader carried one.
 */
function loadFrom(document: unknown): Load {
  const source = isObject(document) ? document : {};
  const processes: LoadProcess[] = [];
  for (const entry of list(source.processes)) {
    if (!isObject(entry) || typeof entry.command !== "string" || !entry.command) {
      continue;
    }
    const pid = wholeCount(entry.pid);
    const cpu = maybeCount(entry.cpu_percent);
    const memory = maybeCount(entry.memory_bytes);
    const elapsed = maybeCount(entry.elapsed_seconds);
    if (pid === null || pid <= 0 || cpu === null || cpu < 0 || memory === null
        || memory < 0 || elapsed === null || elapsed < 0) {
      continue;
    }
    const project = maybeText(entry.project);
    const root = maybeText(entry.project_root);
    processes.push({
      pid,
      command: entry.command,
      cpu_percent: cpu,
      memory_bytes: memory,
      elapsed_seconds: elapsed,
      ...(project ? { project } : {}),
      ...(project && root ? { project_root: root } : {}),
    });
  }
  return {
    state: stateOf(document, "empty"),
    sampled_at: maybeCount(source.sampled_at),
    total: wholeCount(source.total) ?? 0,
    processes,
    errors: errorsOf(document),
  };
}

/**
 * This session's figures, read as untrusted input like every other document.
 *
 * A figure the payload did not carry is left out rather than set to zero, and
 * `absent` is what says which: the pane draws "not reported" from the absence
 * and never from a nought, because a session reported as having spent nothing
 * and one nobody measured are different claims.
 */
function sessionFrom(document: unknown): SessionFigures {
  const source = isObject(document) ? document : {};
  const numbers = NUMBER_FIELDS.map((name) => [name, maybeCount(source[name])] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null);
  const words = TEXT_FIELDS.map((name) => [name, maybeText(source[name])] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  const parameters: Record<string, string> = {};
  if (isObject(source.parameters)) {
    for (const [key, value] of Object.entries(source.parameters)) {
      if (typeof value === "string" || typeof value === "number") {
        parameters[key] = String(value);
      }
    }
  }
  return {
    state: stateOf(document, "empty"),
    absent: list(source.absent).filter((name): name is string => typeof name === "string"),
    ...Object.fromEntries(numbers),
    ...Object.fromEntries(words),
    parameters,
    errors: errorsOf(document),
  } as SessionFigures;
}

/**
 * One snapshot from the six documents a read produced.
 *
 * The clock the ages are read against is the reading's own, from its stamp or
 * from the moment the caller read it, rather than the moment of the paint: a
 * pane can open on a reading the last session left.
 */
/** A whole, non-negative figure, or null: a bar is never drawn from anything else. */
function wholeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function customRows(value: unknown): CustomRow[] {
  const rows: CustomRow[] = [];
  for (const entry of list(value)) {
    if (!isObject(entry) || typeof entry.title !== "string" || !entry.title) {
      continue;
    }
    rows.push({
      title: entry.title,
      state: maybeText(entry.state),
      detail: maybeText(entry.detail),
      slot: maybeText(entry.slot),
      done: wholeCount(entry.done),
      total: wholeCount(entry.total),
      failed: wholeCount(entry.failed),
    });
  }
  return rows;
}

/**
 * One declared section. A section that arrives as something other than an
 * object is one whose reading went wrong, so it keeps its place as failed.
 */
function customSection(key: string, value: unknown): CustomSection {
  const body = isObject(value) ? value : {};
  return {
    state: isObject(value) ? stateOf(value, "failed") : "failed",
    title: typeof body.title === "string" && body.title ? body.title : key,
    legend: typeof body.legend === "string" && body.legend ? body.legend : null,
    visible: body.visible !== false,
    collapsed: body.collapsed === true,
    hideWhenEmpty: body.hideWhenEmpty === true,
    ...(typeof body.maxRows === "number" && Number.isInteger(body.maxRows) && body.maxRows >= 1
      ? { maxRows: body.maxRows } : {}),
    summary: maybeText(body.summary),
    rows: customRows(body.rows),
    printed: count(body.printed),
    errors: errorsOf(value),
  };
}

/**
 * The sections a person added. A reading from before they existed carries no
 * document, and that is a switched-off source rather than a failed one.
 */
function customFrom(document: unknown): Custom {
  const sections: Record<string, CustomSection> = {};
  const declared = isObject(document) && isObject(document.sections) ? document.sections : {};
  for (const [key, value] of Object.entries(declared)) {
    sections[key] = customSection(key, value);
  }
  return { state: stateOf(document, "disabled"), sections, errors: errorsOf(document) };
}

export function snapshotFrom(documents: ReaderDocuments, generatedAt: number): Snapshot {
  return {
    generated_at: readingClock(documents, generatedAt),
    roster: rosterFrom(documents.roster),
    trials: trialsFrom(documents.trials),
    session: sessionFrom(documents.session),
    progress: progressFrom(documents.progress),
    prs: pullRequestsFrom(documents.prs),
    skills: skillsFrom(documents.skills),
    worktrees: worktreesFrom(documents.worktrees),
    load: loadFrom(documents.load),
    custom: customFrom(documents.custom),
    ...(documents.events === undefined || documents.events === null ? {}
      : { events: eventsFrom(documents.events) }),
  };
}
