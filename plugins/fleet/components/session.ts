/**
 * This session's figures, from the engine rather than from a file.
 *
 * The session section once read a payload the status line was to write, and on
 * a machine whose status line writes none it was always empty. The engine hands
 * a plugin the same figures directly: what the session has cost, when it began,
 * its context window, its rate-limit windows, and its model. This turns them
 * into the document the section already draws, with every field the engine does
 * not report named as absent rather than drawn as nought.
 */

/** What the engine's usage call answers, as far as this module reads it. */
export type EngineUsage = {
  startedAt?: unknown;
  context?: { tokens?: unknown; window?: unknown; percent?: unknown } | null;
  rateLimits?: unknown;
  cost?: { usd?: unknown } | null;
};

/** The fields the section draws that the engine never reports. */
const NOT_FROM_ENGINE = ["apiDurationMs", "linesAdded", "linesRemoved", "inputTokens",
                         "outputTokens", "cacheReadTokens", "cacheCreationTokens",
                         "outputStyle", "modelName"];

/** Each rate-limit window the engine names, and the fields it fills. */
const WINDOWS: Record<string, { used: string; resets?: string }> = {
  five_hour: { used: "fiveHourUsedPercent", resets: "fiveHourResetsAt" },
  seven_day: { used: "sevenDayUsedPercent", resets: "weekResetsAt" },
  spend_limit: { used: "spendUsedPercent" },
};

/**
 * A money figure, to the cent, and never rounded to a nought.
 *
 * A cost below half a cent is not nothing, and `toFixed(2)` draws it as
 * "$0.00": a session that has spent something, drawn as one that has spent
 * none. Below a cent the figure is stated in the words that carry its size, as
 * the statusline already does for the same case.
 */
export function money(usd: number): string {
  if (usd !== 0 && Math.abs(usd) < 0.01) {
    return "~<$0.01";
  }
  return "$" + usd.toFixed(2);
}

/** One headline figure of the session section. */
export type SpendTile = { label: string; value: string; color?: "subtle" };

/**
 * The machine-wide spend tile, drawn beside this session's own cost.
 *
 * The figure is what every routed session wrote inside the configured window.
 * A reader that could not price it leaves it out, and the tile says so in the
 * quiet color: a machine nobody could measure is not a machine that spent
 * nothing, and "$0.00" would state the second claim from the first one's data.
 */
export function spendWindowTile(figures: { spendWindowUsd?: unknown }): SpendTile {
  const usd = figures.spendWindowUsd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    return { label: "24h", value: "not reported", color: "subtle" };
  }
  return { label: "24h", value: money(usd) };
}

/** The figures the reader priced across the machine, kept over the engine's document. */
const SPEND_FIELDS = ["spendWindowUsd", "spendWindowFiles", "spendWindowSkipped"] as const;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A time the engine wrote as text, in seconds since the epoch, or null. */
function seconds(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at / 1000 : null;
}

/**
 * The windows the reader reports for this session's own provider, filling the
 * rows a subscription session's five-hour and weekly windows fill.
 *
 * The reader is the only layer that can read a rollout or the status line's
 * own file, and it names each window by the length of time it spans: five
 * hours and a week are the two a person watches, and they are drawn under
 * those names. A window of another length is left out rather than drawn under
 * a name it does not have, and a limit that is not a ready reading of a
 * provider that reports windows contributes nothing.
 */
const WINDOW_PROVIDERS = new Set(["codex", "claude"]);

function providerWindows(limits: unknown): Record<string, number> {
  if (typeof limits !== "object" || limits === null) {
    return {};
  }
  const read = limits as { state?: unknown; provider?: unknown; windows?: unknown };
  if (read.state !== "ready" || typeof read.provider !== "string"
      || !WINDOW_PROVIDERS.has(read.provider) || !Array.isArray(read.windows)) {
    return {};
  }
  const rows: Record<string, number> = {};
  for (const entry of read.windows) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const window = entry as { windowMinutes?: unknown; usedPercent?: unknown;
                              resetsAt?: unknown };
    const used = finite(window.usedPercent);
    const resets = finite(window.resetsAt);
    if (window.windowMinutes === 300) {
      if (used !== null && used <= 100) {
        rows.fiveHourUsedPercent = used;
      }
      if (resets !== null) {
        rows.fiveHourResetsAt = resets;
      }
    } else if (window.windowMinutes === 10080) {
      if (used !== null && used <= 100) {
        rows.sevenDayUsedPercent = used;
      }
      if (resets !== null) {
        rows.weekResetsAt = resets;
      }
    }
  }
  return rows;
}

/**
 * The session section's document from what the engine reported.
 *
 * `now` is in milliseconds, the engine clock's own unit, and so is the usage's
 * `startedAt`. Null when the usage is not a usage at all, so a caller keeps
 * whatever document it had rather than drawing an empty session.
 */
export function sessionDocument(usage: unknown, model: unknown, version: unknown,
                                sessionId: string, now: number): Record<string, unknown> | null {
  if (typeof usage !== "object" || usage === null) {
    return null;
  }
  const read = usage as EngineUsage;
  const document: Record<string, unknown> = { state: "ready", errors: [], parameters: {} };
  const absent: string[] = [...NOT_FROM_ENGINE];
  const put = (name: string, value: number | string | null) => {
    if (value === null) {
      absent.push(name);
    } else {
      document[name] = value;
    }
  };
  put("costUsd", finite(read.cost?.usd));
  const started = finite(read.startedAt);
  put("durationMs", started !== null && now >= started ? now - started : null);
  put("windowSize", finite(read.context?.window));
  const percent = finite(read.context?.percent);
  put("remainingPercent", percent !== null && percent <= 100 ? 100 - percent : null);
  const limits = Array.isArray(read.rateLimits) ? read.rateLimits : [];
  for (const [kind, fields] of Object.entries(WINDOWS)) {
    const found = limits.find((limit) => typeof limit === "object" && limit !== null
      && (limit as { kind?: unknown }).kind === kind) as
      { percentUsed?: unknown; resetsAt?: unknown } | undefined;
    put(fields.used, finite(found?.percentUsed));
    if (fields.resets) {
      put(fields.resets, seconds(found?.resetsAt));
    }
  }
  put("model", typeof model === "string" && model ? model : null);
  const named = typeof version === "object" && version !== null
    ? (version as { version?: unknown }).version : null;
  put("version", typeof named === "string" && named ? named : null);
  put("sessionId", sessionId || null);
  document.absent = absent;
  return document;
}

/**
 * The documents a paint draws from: the reading's, with this session's figures
 * taken from the engine when the engine has answered.
 *
 * The engine's figures are this session's own and current, so they stand over
 * a payload file, which may be another session's and is as old as its last
 * write. A reading that is not an object is handed back untouched.
 */
export function withSession(documents: unknown, engine: Record<string, unknown> | null): unknown {
  if (typeof documents !== "object" || documents === null) {
    return documents;
  }
  const reading = documents as Record<string, unknown>;
  const fromReader = typeof reading.session === "object" && reading.session !== null
    ? reading.session as Record<string, unknown> : {};
  // A Codex session's windows are read from its rollout, and a Claude
  // session's from the file the status line writes, not from the engine, which
  // reports no rate limits on either. They fill the rows the subscription
  // session already draws, and stand over a reading's own fields because they
  // are this session's current figures.
  const windows = providerWindows(fromReader.limits);
  const provider = typeof fromReader.providerCostUsd === "number"
    && Number.isFinite(fromReader.providerCostUsd) ? fromReader.providerCostUsd : null;
  // The window spend is the machine's, read from files the engine never sees,
  // so it is carried over the engine's document rather than dropped with the
  // payload figures it replaces.
  const spend: Record<string, unknown> = {};
  for (const name of SPEND_FIELDS) {
    const value = fromReader[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      spend[name] = value;
    }
  }
  const merged = { ...engine, ...spend };
  if (engine === null) {
    if (Object.keys(windows).length === 0) {
      return documents;
    }
    return { ...reading, session: { ...fromReader, ...windows } };
  }
  // A routed session's money is the figure the status line priced from that
  // session's own transcript. The engine's cost is an Anthropic-table number,
  // and on a session routed to another provider it is not that provider's
  // spend; every other engine field still stands over the reading.
  const priced = provider === null ? merged
    : { ...merged, costUsd: provider, providerCostUsd: provider, costSource: "provider" };
  return { ...reading, session: { ...priced, ...windows } };
}
