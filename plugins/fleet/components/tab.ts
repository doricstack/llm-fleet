/**
 * The terminal tab's color, by the band's level.
 *
 * A session whose band leads with a failure tints its terminal tab red, one
 * whose band leads with a wait tints it amber, and a band that clears gives the
 * tab its own color back, as the session ending does. The person sees which
 * tab needs them without looking at any of them.
 *
 * Only iTerm draws a tab color from an escape, and inside tmux only when tmux
 * passes escapes through to the terminal around it. Anywhere else nothing is
 * written at all: an escape another terminal does not know is drawn as noise
 * in the transcript, or swallowed, and neither is a tint.
 *
 * Several sessions can share one tab: tmux panes in one iTerm tab. The tab's
 * state is the helper's (`readers/tab.py`): it keeps one record per tab under
 * a lock, paints the highest level any live session holds, and writes the
 * escape to the session's terminal, since a plugin's own output is not the
 * terminal. What is here is this session's side, testable without a terminal:
 * the level from the band's items, the helper's words, and when to tell the
 * helper, which is when the level moves, once more after a paint that failed,
 * and every third of the staleness while a level is held.
 */

/** What the tab says: a failure, a wait, or nothing, which is the tab's own color. */
export type TabLevel = "failure" | "waiting" | null;

/** How the tab is tinted, as the configuration resolves it; the colors are the helper's to read. */
export type TabTint = { enabled: boolean; staleSeconds: number };

/** The schema's own defaults, for a reading that carries no tint of its own. */
export const TINT_DEFAULTS: TabTint = { enabled: true, staleSeconds: 120 };

/** The schema's floor for the staleness: the heartbeat at a third of it runs at most every ten seconds. */
export const STALE_FLOOR = 30;

/** The tint a reading carries, each part the default when it is not usable. */
export function tintFrom(value: unknown): TabTint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return TINT_DEFAULTS;
  }
  const body = value as Record<string, unknown>;
  return {
    enabled: typeof body.enabled === "boolean" ? body.enabled : TINT_DEFAULTS.enabled,
    staleSeconds: typeof body.staleSeconds === "number" && Number.isInteger(body.staleSeconds)
      && body.staleSeconds >= STALE_FLOOR ? body.staleSeconds : TINT_DEFAULTS.staleSeconds,
  };
}

/**
 * The level the band's items put the tab at: a failure outranks a wait, and a
 * band with nothing in it is the tab's own color.
 */
export function tabLevel(items: readonly { level: "error" | "warning" }[]): TabLevel {
  if (items.some((item) => item.level === "error")) {
    return "failure";
  }
  return items.some((item) => item.level === "warning") ? "waiting" : null;
}

/** Where the session runs, as far as a tab color is concerned. */
export type TabTerminal = { supported: boolean; tmux: boolean };

/** What the environment says about the terminal, as the engine reads it. */
export type TabEnvironment = {
  termProgram?: string;
  lcTerminal?: string;
  tmux?: string;
};

/**
 * Whether this terminal draws a tab color, and whether the escape goes through tmux.
 *
 * iTerm names itself in `TERM_PROGRAM`; inside tmux that variable names tmux,
 * and `LC_TERMINAL`, which iTerm sets and tmux carries in, is what still says
 * iTerm. Inside tmux the escape reaches iTerm only when tmux passes it through
 * (`allow-passthrough`), so a tmux that does not is as unsupported as another
 * terminal.
 */
export function tabTerminal(env: TabEnvironment, passesThrough: boolean): TabTerminal {
  const iTerm = env.termProgram === "iTerm.app" || env.lcTerminal === "iTerm2";
  const tmux = typeof env.tmux === "string" && env.tmux !== "";
  return { supported: iTerm && (!tmux || passesThrough), tmux };
}

/** Whether tmux's answer to `show-options -gqv allow-passthrough` is a yes. */
export function passesThrough(answer: string): boolean {
  return ["on", "all"].includes(answer.trim());
}

/** The helper's word for a level. */
export function levelWord(level: TabLevel): "none" | "waiting" | "failed" {
  if (level === null) {
    return "none";
  }
  return level === "failure" ? "failed" : "waiting";
}

/**
 * The helper's words, what follows its path: this session's level for the tab,
 * or its end, with `--tmux` when the escape goes through tmux.
 */
export function tabArgs(form: "set" | "end", tab: string, session: string, level: TabLevel,
                        terminal: TabTerminal, recordOnly = false): string[] {
  const words = form === "end" ? ["end", "--tab", tab, "--session", session]
    : ["set", "--tab", tab, "--session", session, "--level", levelWord(level),
       ...(recordOnly ? ["--record-only"] : [])];
  return terminal.tmux ? [...words, "--tmux"] : words;
}

/**
 * What this session last told the helper: the level, when, how many times in a
 * row the helper said it could not paint it, and the run in flight, so one is
 * told at a time. The tab's own state is the helper's record, not this.
 */
export type TabSender = { sent: TabLevel | undefined; at: number; failures: number;
                          queue: Promise<void> };

/** A sender that has told the helper nothing. */
export function tabSender(): TabSender {
  return { sent: undefined, at: 0, failures: 0, queue: Promise.resolve() };
}

/**
 * Whether to tell the helper this level now: to paint, to keep the entry alive
 * without painting, or not at all.
 *
 * A new level is told at once. A held level is told again every third of the
 * staleness, so the entry never goes stale while the session holds it. With
 * `heartbeat`, which is tinting switched on, a session holding no level says
 * none as it starts and on the same beat: the helper prunes entries only when
 * some session speaks, so without it a failure whose session died would tint
 * the tab for good while the sessions left hold nothing. Once the helper could
 * not paint a level twice in a row the session gives up painting it until the
 * level moves, and the retelling then keeps the entry alive and paints nothing.
 */
export function nextSend(sender: TabSender, level: TabLevel, now: number,
                         staleSeconds: number, heartbeat = false): "paint" | "record" | null {
  if (sender.sent === undefined && level === null && !heartbeat) {
    return null;
  }
  if (level !== sender.sent) {
    return "paint";
  }
  if ((level !== null || heartbeat) && now - sender.at >= staleSeconds / 3) {
    return sender.failures >= 2 ? "record" : "paint";
  }
  return null;
}

/** Take in what telling the helper came to. A record-only run paints nothing, so it counts no failure. */
export function afterSend(sender: TabSender, level: TabLevel, now: number,
                          mode: "paint" | "record", landed: boolean): void {
  if (level !== sender.sent) {
    sender.failures = 0;
  }
  sender.sent = level;
  sender.at = now;
  if (mode === "paint") {
    sender.failures = landed ? 0 : sender.failures + 1;
  }
}

/**
 * Whether the session's end has anything to take back: an entry it holds, or a
 * clear the helper could not paint. A session that never held a level ends
 * without a word to the helper.
 */
export function endNeeded(sender: TabSender): boolean {
  return sender.sent !== undefined && (sender.sent !== null || sender.failures > 0);
}

/** Run one turn after whatever the sender is doing now, never two at once. */
export function serially(sender: TabSender, turn: () => Promise<void>): Promise<void> {
  const next = sender.queue.then(turn);
  sender.queue = next.catch(() => undefined);
  return sender.queue;
}
