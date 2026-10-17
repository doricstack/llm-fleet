/**
 * The statusline: what a session looks like at a glance, in three portable lines.
 *
 * This is the composer, and it is pure. It reads the two documents the readers
 * produce and returns the slots a host draws, so every rule the design cares
 * about is tested without a terminal in the loop.
 *
 * The honesty rules are the pane's, applied to a line:
 *
 * - a figure the host did not send is not drawn as a zero. An absent context
 *   window means no bar, and the line says the window is unknown;
 * - the token fill is the count the payload carried, never reconstructed from a
 *   percentage, because reconstructing it rounds and then disagrees with itself;
 * - a session's cache saving is shown only when it is positive. A cold session
 *   has a negative one, and a negative saving drawn as a saving is a lie;
 * - a truncated transcript is marked, so a smaller session is not read as a
 *   complete one;
 * - a failed read says it failed and names what failed. It is never rendered as
 *   an empty session, which is the one thing a statusline must not do.
 *
 * Which segments are out of the portable core: weather, local IP, disk, the
 * Codex badge, the MCP count, switch advice, governor and task rows. They read
 * state that exists on one machine, and each belongs in a mod with its own
 * config rather than in the line every host draws.
 */

import { MASK, mask } from "./mask.ts";
import { barCells, fit, type Slot } from "./layout.ts";

export type SourceState = "ready" | "empty" | "unavailable" | "failed";

export type LimitReading = {
  usedPercent?: number;
  resetsAt?: number;
};

export type HostReading = {
  state: SourceState;
  reason?: string;
  absent?: string[];
  session?: { id?: string; name?: string; cwd?: string; version?: string };
  model?: { id?: string; displayName?: string };
  cost?: { totalCostUsd?: number; apiDurationMs?: number; durationMs?: number };
  context?: {
    inputTokens?: number;
    windowSize?: number;
    remainingPercent?: number;
    currentUsage?: { cacheReadTokens?: number; cacheCreationTokens?: number };
  };
  rateLimits?: { fiveHour?: LimitReading; sevenDay?: LimitReading; spendLimit?: LimitReading };
  promptCache?: { warm?: boolean; hitRatio?: number };
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  pr?: { number?: number; state?: string };
  worktree?: { branch?: string };
};

export type TranscriptReading = {
  state: SourceState;
  reason?: string;
  records?: number;
  damagedRecords?: number;
  truncated?: boolean;
  inputTokens?: number;
  rawTokens?: number;
  savedTokens?: number;
  savedUsd?: number;
  pricePerMTok?: number;
  priceFamily?: string;
};

export type StatuslineInput = {
  host: HostReading;
  transcript: TranscriptReading;
  /** The branch this session is on, when it could be read. */
  branch?: string | null;
  /** The project directory's name, when it could be read. */
  project?: string | null;
  /** The columns the host will draw into. */
  width: number;
  /** The local clock, as seconds since the epoch. */
  now?: number;
};

/** Below this many columns the line drops what can be spared, never what it says. */
const NARROW = 80;
const WIDE = 110;
const CONTEXT_CELLS = 10;
const NARROW_CELLS = 5;

function hidden(value: string | null | undefined): Slot {
  const result = mask(value ?? "");
  return { text: result.text, dim: result.rules.length > 0 };
}

/** A token count a person reads at a glance, rounded once and marked as rounded. */
export function tokenText(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  const sign = value < 0 ? "-" : "";
  const size = Math.abs(value);
  if (size >= 1_000_000) {
    return sign + (size / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (size >= 1_000) {
    return sign + Math.round(size / 1_000) + "K";
  }
  return sign + String(size);
}

/** Dollars, with a saving too small to print said so rather than shown as $0.00. */
export function moneyText(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Math.abs(value) < 0.01) {
    return "~<$0.01";
  }
  return "~$" + value.toFixed(2);
}

export function clockText(now: number): string {
  const date = new Date(now * 1000);
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

function percentOfLimit(limit: LimitReading | undefined): Slot[] {
  if (!limit || !Number.isFinite(limit.usedPercent)) {
    return [];
  }
  const used = Math.max(0, Math.min(100, limit.usedPercent as number));
  return [{ text: Math.round(used) + "%", dim: used < 50 }];
}

/** The identity line: when, what, which model, how much room, what is cached. */
export function identityLine(input: StatuslineInput): Slot[] {
  const { host } = input;
  if (host.state === "failed") {
    return [{ text: "session", bold: true },
            { text: "| the host payload failed to read: " + (host.reason ?? "no reason given") }];
  }
  if (host.state === "empty") {
    return [{ text: "session", bold: true },
            { text: "| the host sent no session" }];
  }
  const slots: Slot[] = [];
  slots.push({ text: clockText(input.now ?? Date.now() / 1000), dim: true });

  const name = host.session?.name;
  const project = input.project ?? null;
  if (name) {
    // A session named after its own project repeats the project, so one of them
    // is dropped. Either direction counts: sessions are named both ways.
    const lower = name.toLowerCase();
    const projectLower = (project ?? "").toLowerCase();
    const repeats = projectLower.length > 0
      && (projectLower.includes(lower) || lower.includes(projectLower));
    if (!repeats) {
      slots.push(hidden(name));
    }
  }

  const model = host.model?.displayName ?? host.model?.id;
  const badge: Slot[] = [{ text: model ? model : "model unknown", bold: true }];
  const effort = host.effort?.level;
  if (effort) {
    badge.push({ text: effort, dim: effort !== "high" && effort !== "max" && effort !== "xhigh" });
  }
  if (host.thinking?.enabled === true) {
    badge.push({ text: "thinking", dim: true });
  }
  slots.push(...badge);

  const version = host.session?.version;
  if (version && input.width >= NARROW) {
    slots.push({ text: version, dim: true });
  }
  if (project) {
    const where: Slot[] = [{ text: project }];
    if (input.branch) {
      where.push(hidden(input.branch));
    }
    if (host.pr?.number !== undefined) {
      where.push({ text: "#" + host.pr.number });
    }
    if (host.worktree?.branch) {
      where.push({ text: "worktree", dim: true });
    }
    slots.push(...where);
  }
  return slots;
}

/** The context line: how full the window is, and what the cache saved. */
export function contextLine(input: StatuslineInput): Slot[] {
  const context = input.host.context ?? {};
  const tokens = context.inputTokens;
  const window = context.windowSize;
  const slots: Slot[] = [{ text: "CTX:", dim: true }];

  if (!Number.isFinite(window) || (window as number) <= 0) {
    // No denominator is not an empty window, and a bar against an invented one
    // would be the exact claim this layer refuses to make.
    slots.push({ text: "window unknown", dim: true });
  } else {
    const size = window as number;
    if (Number.isFinite(tokens)) {
      const used = Math.max(0, Math.min(size, tokens as number));
      const cells = input.width < NARROW ? NARROW_CELLS : CONTEXT_CELLS;
      slots.push({ text: barCells(cells, used, size) });
      slots.push({ text: "(" + tokenText(used) + "/" + tokenText(size) + ")", dim: true });
    } else {
      // The window is known even though the fill is not, so the size stays on
      // the line beside the missing figure rather than being thrown away with it.
      slots.push({ text: "fill unknown", dim: true },
                 { text: "of " + tokenText(size), dim: true });
    }
  }

  const saved = input.transcript.state === "ready" ? input.transcript.savedUsd : undefined;
  if (saved !== undefined && saved > 0) {
    slots.push({ text: "cache", dim: true }, { text: moneyText(saved) + "/ses" });
  }
  if (input.transcript.truncated) {
    slots.push({ text: "cache partial", dim: true });
  }
  const cache = input.host.promptCache;
  if (cache && cache.warm !== undefined) {
    slots.push({ text: "pc:", dim: true },
               { text: cache.warm ? "warm" : "COLD", dim: cache.warm });
  }
  return slots;
}

/** The cost line: what this session has spent, and how much of each window is gone. */
export function costLine(input: StatuslineInput): Slot[] {
  const slots: Slot[] = [];
  const cost = input.host.cost?.totalCostUsd;
  if (Number.isFinite(cost)) {
    slots.push({ text: "COST:", dim: true }, { text: moneyText(cost as number) });
  } else {
    slots.push({ text: "COST:", dim: true }, { text: "unknown", dim: true });
  }
  // The rate is priced against the time the API was actually working, not wall
  // clock: a session that sat idle for an hour did not spend an hour of tokens.
  const api = input.host.cost?.apiDurationMs;
  if (input.width >= WIDE && Number.isFinite(cost) && Number.isFinite(api)
      && (api as number) > 0) {
    const perHour = (cost as number) / ((api as number) / 3_600_000);
    slots.push({ text: "at " + moneyText(perHour) + "/h", dim: true });
  }
  const limits = input.host.rateLimits ?? {};
  const five = percentOfLimit(limits.fiveHour);
  if (five.length) {
    slots.push({ text: "5h", dim: true }, ...five);
  }
  const week = percentOfLimit(limits.sevenDay);
  if (week.length) {
    slots.push({ text: "wk", dim: true }, ...week);
  }
  if (input.transcript.state === "ready" && input.transcript.damagedRecords) {
    slots.push({ text: input.transcript.damagedRecords + " damaged", dim: true });
  }
  if (input.transcript.state === "failed" || input.transcript.state === "unavailable") {
    slots.push({ text: "economics " + input.transcript.state, dim: true });
  }
  return slots;
}

/** Every line, ready to draw. */
export function composeLines(input: StatuslineInput): Slot[][] {
  return [identityLine(input), contextLine(input), costLine(input)];
}

/** The lines as plain text, which is what a test and a preview read. */
export function renderedLines(input: StatuslineInput): string[] {
  return composeLines(input).map((slots) => fit(slots.map((slot) => slot.text)
                                                   .join(" ")
                                                   .replace(/\s+/g, " ")
                                                   .trim(), input.width));
}

export { MASK };
