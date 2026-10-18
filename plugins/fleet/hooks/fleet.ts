/**
 * Fleet: the pane, drawn by the engine.
 *
 * This is the entry the engine loads. It is deliberately thin: it registers one
 * command, opens one pane, and hands the reading it already has to
 * `plugins/fleet/components/surface.ts`, which decides the tree. Everything the
 * pane shows is therefore testable without the engine, and this file holds only
 * what needs it: the plugin's own root, the resolved element table, the process
 * runner, and the clock.
 *
 * A render hook paints: it is asked for a tree while the surface is drawing, so
 * it must answer from what it already holds. The reading therefore happens off
 * the paint, in a refresh this module owns, and the pane is asked to draw again
 * once it lands. A hook that awaited the read command instead would be waiting
 * inside a paint, and the surface would draw the pane empty while it waited.
 *
 * The engine gives a render hook its element constructors through `$.ui.resolve`,
 * which is exactly the subset this repository declares in `plugins/fleet/components/host.ts`.
 * Nothing here writes JSX: the layout builds the tree as data, so the same code
 * that a terminal draws is the code the review renderer measures.
 *
 * The band above the prompt is drawn here too: it holds the switch that opens
 * and closes the pane, because a typed command waits behind a running turn and a
 * press does not, and beside it the fleet's figures and what needs a person.
 *
 * Alerts are raised here too, from each fresh reading: a toast in the session
 * the person typed in last, one native notification per machine, and the voice
 * saying a waiting job aloud once per machine. Which session is focused and
 * which one takes an event are decided by a helper over files every session
 * shares, because each session runs its own copy of this plugin.
 *
 * Speech is one switch for the whole machine, kept in the store every session
 * reads: the band's Speak button or `/speak on|off` in any session turns it on
 * or off in all the sessions running, and every session starts with it off.
 * Off is a hard stop: a session that hears it stops the clip it is playing and
 * drops every line it was going to say. The voice is each session's own: `/speak male` here leaves the
 * session beside it speaking as it did. A session says one clip at a time, and
 * the helper holds the machine's voice for each clip, so two sessions never
 * speak over each other.
 *
 * A press on a row copies what that row offers: a background job the line that
 * opens it, a worktree its cleanup line, the skills status the report command.
 * A waiting job takes a reply in a field under its question, sent to its own
 * session once the job is asked again what it asks now, so a reply typed for an
 * old question never lands on a new one.
 *
 * The terminal tab is tinted by the band's level where the terminal draws a
 * tab color, and given its own color back when the band clears or the session
 * ends. While a draft is typed the hint line under the prompt ends with a key
 * tip. `/worktrees` and `/keys` open the pane on one section, and the folds a
 * person leaves are kept for the next session.
 *
 * A `-p` run or an SDK host has nobody to show any of this to, so it starts no
 * timer and reads nothing on its own.
 *
 * Not built here, and named so nothing pretends to have it: the switch advice,
 * which was a separate plugin.
 */

import type { ReaderDocuments } from "../components/snapshot.ts";
import type { Engine, Register } from "./engine.ts";
import type { Job } from "../components/state.ts";
import type { PaneConfig } from "../components/options.ts";
import type { FleetDigestSeen, FleetFold } from "../types/index.d.ts";
import { GEOMETRY, paneConfigFrom, paneOptions, SECTIONS } from "../components/options.ts";
import { recolor, THEME } from "../components/palette.ts";
import { CLOSE, DETAILS_PREFIX, FOCUS_CLEAR, FOCUS_PREFIX,
         REPLY_PENDING_SECONDS, replyKey, replyText, SHOW_ALL_PREFIX, TOGGLE_ALL,
         TOGGLE_PREFIX, unreadableKey,
         type Focus, type PaneActions, type PaneOptions, type RepliesPaused }
  from "../components/pane.ts";
import { mask } from "../components/mask.ts";
import { pendingSources, stepStream } from "../components/stream.ts";
import { isReading, isRefusal, surfaceTree } from "../components/surface.ts";
import { answeredSources, bandConfigFrom, bandCounts, bandItems, bandTree, hiddenLimitFrom,
         keptHidden } from "../components/band.ts";
import { bindPrimitives, drawsFields, mount, type HostElements } from "../components/mount.ts";
import { snapshotFrom } from "../components/snapshot.ts";
import { newEvents, type FleetEvent } from "../components/alerts.ts";
import { sessionDocument, withSession } from "../components/session.ts";
import { animate, BLINK_MS, motionMemory, SLIDE_MS, type Motion } from "../components/motion.ts";
import type { Pane } from "../components/layout.ts";
import { firstName, speakRequest, speakStatus, speechInfo, SPEAK_USAGE, voiceList, voiceOrder,
         voiceReply, voiceSetting, type SpeechInfo, type VoiceSetting }
  from "../components/speech.ts";
import { afterSend, endNeeded, nextSend, passesThrough, serially, tabArgs, tabLevel, tabSender,
         tabTerminal, TINT_DEFAULTS, tintFrom, type TabLevel, type TabSender, type TabTerminal,
         type TabTint } from "../components/tab.ts";
import { KEYS_USAGE, keysRequest, tipAt, tipsShown, withTip } from "../components/tips.ts";
import { ENTRIES, entryArgv, entryEnv, LAUNCH, launchFrom, type Entry, type Launch }
  from "../components/entries.ts";

/** The pane's id, which is also the requestId its render hook is keyed by. */
export const PANE = "fleet";
/** Carried in the pane's title and its messages, so which plugin is loaded is visible. */
export const MARK = "llm-fleet";
/** Where the read command lives inside the plugin. */
export const READER = ENTRIES.snapshot;
/** How long a reading is drawn before another is asked for. */
export const STALE_SECONDS = 20;
/**
 * How far ahead of this clock a reading or a claim may be dated and still count
 * as current. Another session writes them between this session's clock read and
 * its store read, so a few milliseconds ahead is the store being quick, not a
 * clock that is wrong; an hour ahead is a clock that is wrong.
 */
export const AHEAD_SECONDS = 2;
/**
 * How often a session looks at the reading every session shares, until a
 * reading says otherwise (`refresh.snapshotMs`). A look is one store read; the
 * machine is read only by the one session that finds the shared reading old and
 * claims the read.
 */
export const LOOK_MS = 3_000;
/**
 * How old a live governor run's counts may get while a pane shows them, until a
 * reading says otherwise (`refresh.progressMs`).
 */
export const LIVE_MS = 1_000;
/**
 * How often an open pane is drawn with nothing new held, until a reading says
 * otherwise (`refresh.clockMs`): ages and run times are counted from the paint's
 * clock, and a pane drawn only when a reading landed showed them still and then
 * leaping.
 */
export const CLOCK_MS = 1_000;
/**
 * How far apart the sections a new reading changed land on the pane, until a
 * reading says otherwise (`refresh.streamStepMs`): the first lands at once and
 * the rest follow it down the pane, rather than every one changing in one frame.
 */
export const STREAM_MS = 150;
/**
 * How long a claim to read for every session stands before another session may
 * take it over: longer than a read may run, so only a claim whose session died
 * mid-read is taken over.
 */
export const CLAIM_SECONDS = 35;
/** Where the session reading the whole machine for every session says so. */
export const CLAIM_KEY = "reading.claim";
/** Where the session reading a live governor run's counts for every session says so. */
export const PROGRESS_CLAIM_KEY = "progress.claim";
/**
 * The interval the pane is drawn at while something on it moves, and only then:
 * about twelve frames a second, enough for a row to read as sliding.
 */
export const FRAME_MS = 80;
/**
 * How long after a paint a write it asked for is made: at the next tick, which
 * the host runs as an event of its own rather than as part of the paint.
 */
export const AFTER_PAINT_MS = 1;
/** The longest a session's end waits for the folds and the last look it is still writing. */
export const END_WRITES_MS = 2_000;
/** The most frames one movement may ask for, so frames stop even if no paint comes. */
const FRAME_LIMIT = Math.ceil((BLINK_MS + SLIDE_MS) / FRAME_MS) + 2;
/**
 * Where the last reading is kept, in the plugin's own store.
 *
 * The store is the one place a plugin keeps a value between sessions, so this
 * is what lets the pane open on the fleet as it last stood instead of on a
 * sentence while the read command runs.
 */
export const READING_KEY = "last-reading";
/**
 * Where a live governor run's counts are kept, apart from the whole reading.
 *
 * A count read never writes the whole reading back. The store has no
 * compare-and-set, so a count read that rewrote the whole reading could put an
 * older fleet over a newer one another session had just written; kept apart,
 * each key is written by one kind of read only, and the two are put together
 * where they are drawn.
 */
export const COUNTS_KEY = "live-counts";
/**
 * Where the items a person dismissed from the band are kept, in the plugin's
 * own store, so a dismissal holds in the next session as well.
 */
export const HIDDEN_KEY = "band-hidden";
/**
 * The session state holding which sections a person folded. The host keeps
 * state under the plugin's own name and reads this reference from the source,
 * so the name is spelled here once, as the literal the manifest carries.
 */
const FOLDED = { plugin: "llm-fleet", key: "folded" } as const;
/**
 * The session state holding which sections a person pressed to draw in full.
 *
 * A section past its ceiling holds rows back, and the press is what opens them
 * for the rest of the session. Kept beside the fold for the same reason: a hot
 * reload of the plugin is not a reason to draw the section short again.
 */
const SHOWN_ALL = { plugin: "llm-fleet", key: "shownAll" } as const;
/**
 * Where the replies sent from a pane are kept, by job and the hash of the
 * question answered, in the store every session reads: a job answered from one
 * pane is not offered the field again in the pane beside it.
 */
export const REPLIED_KEY = "replied";
/** How many replies are remembered, until a reading says otherwise (`pane.repliedLimit`). */
export const REPLIED_LIMIT = 50;
/** The longest reply sent, until a reading says otherwise (`pane.replyMaxChars`). */
export const REPLY_MAX_CHARS = 4000;
/** Where focus, claims and the voice are decided, inside the plugin. */
export const ALERTS = ENTRIES.alerts;
/**
 * Where a voice picked before voices were each session's own was kept. A
 * session with no voice of its own starts from it, and nothing writes it now.
 */
export const VOICE_KEY = "voice";
/** Where a session keeps the voice it picked, under its own identifier. */
/**
 * Whether a reading already in hand was taken without this session's identifier.
 *
 * The reader prices a routed session from the status line's own file for the
 * session it is told about, and prices the transcript when it is told none. The
 * identifier arrives on a promise of its own, so a read can finish first and
 * carry a figure that is not this session's money: that reading is read again
 * once the identifier is here.
 */
export function needsSessionRead(hasReading: boolean, sessionId: string,
                                 readWith: string): boolean {
  return hasReading && sessionId !== "" && sessionId !== readWith;
}

export function sessionVoiceKey(sessionId: string): string {
  return VOICE_KEY + ":" + sessionId;
}
/**
 * When speech was switched on, in epoch milliseconds, for every session running
 * then; `false`, absent, or anything else is off.
 */
export const SPEECH_ON_KEY = "speech.on";

/**
 * Whether the stored switch speaks in a session that started at `startedAt`.
 *
 * Only a press made since the session started counts: every session starts
 * silent, and a switch an earlier session left on never reaches a new one. A
 * value from before the press was stamped, plain `true`, is off.
 */
export function speechIsOn(value: unknown, startedAt: number | null): boolean {
  return typeof value === "number" && startedAt !== null && value >= startedAt;
}
/** How often a session looks for the switch another session pressed. */
export const SPEECH_POLL_MS = 1_500;
/**
 * Where the folds a person left are kept, in the plugin's own store, so the
 * next session opens with them. The host's `fleet.folded` holds them for this
 * session across a reload; this holds them across sessions.
 */
export const FOLDS_KEY = "folds";
/** Where the person's own word on the key tips is kept: false is off, anything else is no word. */
export const TIPS_KEY = "key-tips";
/**
 * The last look for the "since you left" digest: `{ at }`, the newest event a
 * digest drew when its pane closed. It is kept twice.
 *
 * The first is the session's own, held by the host in its state: it outlives a hot reload,
 * every load of the session shares it, and a write is made only at the version
 * it read, so two loads closing at once never move it back. It is exact.
 *
 * The second, `SEEN_KEY`, is the look every session shares, in the store, so a new session
 * does not show what was seen in another. The store has no compare-and-set, so
 * two sessions closing in the same moment can leave the earlier of their looks
 * there; then another session's next digest shows a few events again. A session
 * always starts from the later of the two, so its own look is never moved back.
 */
export const SEEN_KEY = "digest-seen";
const SEEN_HELD = { plugin: "llm-fleet", key: "digestSeen" } as const;
/** Where the tab color is written, inside the plugin. */
export const TAB_HELPER = ENTRIES.tab;
/** What the read command takes to probe every worktree now rather than answer from its cache. */
export const FRESH_WORKTREES = "--refresh-worktrees";
/** What asks the read command for the configuration's parts alone, with no reader run. */
export const SETTINGS_ONLY = "--settings";
/** How long the settings may take: a load of the configuration, with no source read. */
export const SETTINGS_MS = 10_000;

/**
 * How alerts are raised and how often the machine is looked at, as the reading
 * carries it, and what stands in before one lands.
 */
type AlertConfig = { toast: boolean; notify: boolean; toastMs: number; snapshotMs: number;
                     synthesisMs: number; snapshotSeconds: number; progressMs: number;
                     copyToastMs: number; tabCommandMs: number; keyTipMs: number; tint: TabTint;
                     helperMs: number; worktreeHelperMs: number; clockMs: number;
                     streamStepMs: number };
const ALERT_DEFAULTS: AlertConfig = { toast: true, notify: true, toastMs: 8000,
                                      snapshotMs: LOOK_MS, synthesisMs: 30_000,
                                      snapshotSeconds: STALE_SECONDS, progressMs: LIVE_MS,
                                      copyToastMs: 6000, tabCommandMs: 5_000, keyTipMs: 30_000,
                                      tint: TINT_DEFAULTS, helperMs: 25_000, worktreeHelperMs: 60_000,
                                      clockMs: CLOCK_MS, streamStepMs: STREAM_MS };

/** The alert settings a reading carries, each one the default when it is not a usable value. */
export function alertConfigFrom(documents: unknown): AlertConfig {
  const carried = (documents as { alerts?: Record<string, unknown> } | null)?.alerts;
  if (typeof carried !== "object" || carried === null) {
    return ALERT_DEFAULTS;
  }
  const flag = (key: "toast" | "notify") =>
    typeof carried[key] === "boolean" ? carried[key] as boolean : ALERT_DEFAULTS[key];
  const span = (key: "toastMs" | "snapshotMs" | "synthesisMs" | "snapshotSeconds"
                      | "progressMs" | "copyToastMs" | "tabCommandMs" | "keyTipMs"
                      | "helperMs" | "worktreeHelperMs" | "clockMs" | "streamStepMs") => {
    const value = carried[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 1
      ? value : ALERT_DEFAULTS[key];
  };
  // A reading written by a build from before the shared reading carries the
  // interval that build read on, thirty seconds, and none of the intervals the
  // shared reading is aged by: taken here, it would slow every session drawing
  // it, and the panes would drift apart again.
  const shared = typeof carried.progressMs === "number";
  return { toast: flag("toast"), notify: flag("notify"), toastMs: span("toastMs"),
           snapshotMs: shared ? span("snapshotMs") : ALERT_DEFAULTS.snapshotMs, synthesisMs: span("synthesisMs"),
           snapshotSeconds: span("snapshotSeconds"), progressMs: span("progressMs"),
           copyToastMs: span("copyToastMs"), tabCommandMs: span("tabCommandMs"),
           keyTipMs: span("keyTipMs"), tint: tintFrom(carried.tabTint),
           helperMs: span("helperMs"), worktreeHelperMs: span("worktreeHelperMs"),
           clockMs: span("clockMs"), streamStepMs: span("streamStepMs") };
}

/**
 * How many replies the pane remembers, as the reading carries it: a whole
 * number of at least one, or the packaged default for anything else.
 */
export function repliedLimitFrom(documents: unknown): number {
  return paneNumberFrom(documents, "repliedLimit", REPLIED_LIMIT);
}

/**
 * One of the pane's whole-number settings as the reading carries it, or the
 * packaged default for a reading without it or a value that is not one.
 */
export function paneNumberFrom(documents: unknown,
                               key: "repliedLimit" | "replyMaxChars" | "replyPendingSeconds",
                               fallback: number): number {
  const carried = (documents as { pane?: Record<string, unknown> } | null)?.pane?.[key];
  return typeof carried === "number" && Number.isInteger(carried) && carried >= 1
    ? carried : fallback;
}

/**
 * Which sections are folded, by name: the value held under `fleet.folded`, so
 * its type is the one the contract declares to the engine.
 */
type Fold = FleetFold;

/**
 * What the pane draws from: the last reading, or the reason there is none.
 *
 * One of these per registration rather than one for the module: the engine
 * loads a plugin once, so a registration is a session's view of the machine,
 * and a reading is not state that outlives it.
 */
type Held = { documents: unknown; at: number; progressAt?: number } | { reason: string; at: number };
type State = {
  held: Held | null;
  /** Whether a look at the store is out. */
  looking: boolean;
  /** Whether this session is reading the whole machine for every session. */
  readingWhole: boolean;
  /** Whether this session is reading a live run's counts for every session. */
  counting: boolean;
  hydrated: boolean;
  /**
   * Which sections are folded, by name, once anything has been pressed.
   *
   * Only what a person pressed, not what the pane draws: the configuration
   * decides every section nobody touched, and a reading that lands while the
   * pane is open brings its own configuration with it. Keeping the two apart is
   * what lets a fresh reading's configuration take effect for the sections
   * nobody has an opinion about, while the presses stand.
   *
   * It lives for this session and nowhere else, and the host holds it: a press
   * folds a section for now, and a hot reload of the plugin keeps it.
   */
  pressed: Fold;
  /** Whether the fold this session was left in has been asked for. */
  restored: boolean;
  /** Which sections a person pressed to draw in full, by name. */
  shownAll: Fold;
  /**
   * The state a press on a headline figure narrowed the pane to.
   *
   * It lives for this session and only while it is pressed: the figures at the
   * top keep counting the whole machine, and the clear control beside them
   * widens the pane again.
   */
  focus: Focus | null;
  /** The rows a person pressed open, by the key the row carries. */
  details: Record<string, true>;
  /** Whether the sections this session was left in full have been asked for. */
  shownAllRestored: boolean;
  /** The band items a person dismissed, by key. */
  hidden: string[];
  /** The replies sent from a pane on this machine, by `replyKey`, newest last. */
  replied: string[];
  /** The jobs this session is sending a reply to now, by their claim key. */
  replying: Set<string>;
  /** The pending replies cleared from this pane, by `replyKey` and the time each was recorded. */
  cleared: string[];
  /** Why the helper last refused a reply for the whole machine, until one goes or a press clears it. */
  paused: RepliesPaused | null;
  /** Whether the pane was open at the last answer or press, for when the engine gives none. */
  open: boolean;
  /** This session's identifier, so the band leaves out its own job; empty until known. */
  sessionId: string;
  /** The identifier the reading in hand was taken with, so a later one can tell it priced this session. */
  sessionIdRead: string;
  /** The model this session runs, for pricing a routed session; empty until the engine says. */
  modelId?: string;
  /** The event keys already raised, or null before the first fresh reading. */
  seen: string[] | null;
  /** How alerts are raised, from the last reading. */
  alerts: AlertConfig;
  /** Whether `alerts` came from the configuration rather than the packaged defaults. */
  timesKnown: boolean;
  /** Whether this registration may raise native notifications at all. */
  notify: boolean;
  /** What the helper says about speech here, once asked. */
  speech: SpeechInfo | null;
  /** The voice a person picked, once read from the store. */
  voice: VoiceSetting | null;
  /** The voice that spoke last, tried first next time. */
  voiceName: string | null;
  /**
   * How many times a voice has been picked here, so a line that started before
   * a pick and finished after it does not put its own voice over the pick.
   */
  voiceSelection: number;
  /** The session the voice was read for, so one read before the identifier landed is read again. */
  voiceFor: string;
  /** Whether speech is on in every session, as the store last said; null before it has. */
  speechOn: boolean | null;
  /** The clip playing now, so speech switched off stops it mid-word. */
  playing: AbortController | null;
  /** The clips this session says, each one after the one before. */
  voiceQueue: Promise<unknown>;
  /** When this session started, in epoch milliseconds; a switch pressed before it is off here. */
  startedAt: number | null;
  /** Moved on each time speech is heard off, so every line asked for before it is dropped. */
  speechEpoch: number;
  /** The voice picks, run one after another so two never interleave. */
  voicePicks: Promise<unknown>;
  /** The timer that follows the switch other sessions press. */
  speechTimer: { cancel(): void } | null;
  /** The timer that looks at the shared reading, drawn or not, so alerts are not late. */
  timer: { cancel(): void } | null;
  /** The interval that timer runs at, so a look that needs another one re-arms it. */
  timerMs: number;
  /** Whether the session has ended, so a look still out does not start the timer again. */
  ended: boolean;
  /** What this registration writes in a claim, so it knows its own claim from another's. */
  token: string;
  /** This session's figures as the engine last reported them, once it has. */
  engineSession: Record<string, unknown> | null;
  /** Whether the engine is being asked for them now. */
  measuring: boolean;
  /** Whether it has been asked at all, so a paint asks at most once on its own. */
  measured: boolean;
  /** What the last paint drew and what is moving since, kept across paints. */
  motion: Motion;
  /** The frames running while something moves, and how many each has asked for. */
  frames: { cancel(): void } | null;
  framed: number;
  /**
   * What the pane draws: the held reading's sections as far as they have
   * landed, so a reading that changed several lands them one after another.
   */
  shown: Record<string, unknown> | null;
  /** The held reading `shown` has fully landed, so a paint of it steps nothing. */
  shownFrom: unknown;
  /** When the counts the pane draws were read, so run times age from then. */
  shownCountsAt: number | undefined;
  /** The timer landing the sections still to land, and those sections in line. */
  streamTimer: { cancel(): void } | null;
  streamQueue: string[];
  /** The timer drawing an open pane so its ages count, and the interval it runs at. */
  clock: { cancel(): void } | null;
  clockMs: number;
  /**
   * Whether a person is at the prompt. A `-p` run or an SDK host is not
   * interactive, and starts no timer of its own.
   */
  interactive: boolean;
  /** Whether `/worktrees` asked for every worktree probed now, on the next look. */
  freshAsked: boolean;
  /** The terminal the session runs in, once asked; null before, and where it could not be. */
  terminal: TabTerminal | null;
  /** The color this session gave up on, and the write in flight. */
  tab: TabSender;
  /** What names the tab this session draws in, once asked; null for a tab nothing names. */
  tabId: string | null;
  /** The person's own word on the key tips, from the store; undefined until read. */
  tipsWord: unknown;
  /** Whether `/keys tips` set the word in this session, which the startup read then leaves alone. */
  tipsSet: boolean;
  /** The turn the key tip is at, and the timer that moves it on while a draft is typed. */
  tipTurn: number;
  tipTimer: { cancel(): void } | null;
  /** The interval that timer runs at, so a reading that changes it re-arms it. */
  tipMs: number;
  /** The tab's heartbeat, at a third of the staleness, and the interval it runs at. */
  tabBeat: { cancel(): void } | null;
  tabBeatMs: number;
  /** The fold saves to the store, one after another, so the last press is the one kept. */
  foldSaves: Promise<unknown>;
  /** Whether the person has been told the folds could not be saved, so it is said once. */
  foldToast: boolean;
  /** Whether the folds the last session left have been read, or found absent. */
  foldsLoaded: boolean;
  /** Whether a press landed before they were, so the merge is saved once they are. */
  foldsDirty: boolean;
  /** The sections pressed before they were, saved over what the store holds once they are. */
  foldsPending: Fold;
  /** This load's last write of the held fold, so its writes land in the order made. */
  foldWrites: Promise<unknown>;
  /** The read of the folds a session opens with, which adds writes of its own when it lands. */
  foldRestore: Promise<unknown>;
  /**
   * The person's last look, for the digest: undefined until the store answers,
   * null when it holds none, and the newest event a closed pane's digest drew.
   */
  lastSeen: number | null | undefined;
  /** Whether the last look has been asked of the store since the pane last closed. */
  seenAsked: boolean;
  /** The newest event the digest has drawn since the pane opened; null while it drew none. */
  digestThrough: number | null;
  /** This session's last write of its own look, so its writes land in the order made. */
  seenWrite: Promise<unknown>;
  /** The writes a paint asked for, made at the next tick rather than inside it. */
  afterPaint: (() => void)[];
  /** The tick those writes wait on; null while none waits. */
  afterPaintTick: { cancel(): void } | null;
};

/**
 * What the store holds under `READING_KEY`: the last reading, when it was taken,
 * and when its governor counts were last read on their own, when they were.
 */
type Carried = { documents: unknown; at: number; progressAt?: number };

/**
 * Whether a value the store handed back is a reading.
 *
 * Anything can be under that key: a value from an older version of this plugin,
 * one written while the process died, or something else entirely. A value that
 * is not a reading is not drawn as one, and the test for that is the surface's
 * own, so a stored value can never be a shape the pane would refuse to draw.
 */
function isCarried(value: unknown): value is Carried {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { documents?: unknown; at?: unknown };
  return typeof candidate.at === "number" && Number.isFinite(candidate.at)
    && isReading(candidate.documents as ReaderDocuments | null);
}

/** What the store holds under `COUNTS_KEY`: a live run's counts and when they were read. */
type Counts = { at: number; progress: Record<string, unknown> };

/** Whether a value the store handed back is a count read that worked. */
function isCounts(value: unknown): value is Counts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { at?: unknown; progress?: unknown };
  return typeof candidate.at === "number" && Number.isFinite(candidate.at)
    && typeof candidate.progress === "object" && candidate.progress !== null
    && READ_STATES.has((candidate.progress as { state?: unknown }).state);
}

/** What a failed run printed, when what it printed is a refusal document. */
function refusalFrom(stdout: string): ReaderDocuments | null {
  try {
    const printed: unknown = JSON.parse(stdout);
    return isRefusal(printed as ReaderDocuments | null) ? printed as ReaderDocuments : null;
  } catch {
    return null;
  }
}

/**
 * Whether the host killed the run rather than the run failing.
 *
 * A run belongs to the work that started it, and the host is documented to kill
 * a child when the signal it ran under aborts. Scrolling the pane is enough to
 * supersede the request a read was started from, and what comes back is the
 * host saying it stopped the command, not a command that answered. Read as a
 * failure it draws "could not read the fleet" over a machine that was never
 * asked, which is the pane inventing a fault.
 */
function cancelled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ((error as { name?: unknown }).name === "AbortError") {
    return true;
  }
  return /\babort/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * How this load starts the plugin's scripts, from the options the host handed
 * `register`. The options are fixed for a load, and a change to one reloads the
 * module, which sets this again; so it is set once per load and read by every
 * start, rather than threaded through each caller.
 */
let launch: Launch = LAUNCH;

/** Start one of the plugin's scripts under the person's interpreter and configuration. */
function runEntry($: Engine, entry: Entry, args: readonly string[], timeoutMs: number) {
  const env = entryEnv(launch);
  return $.process.run(entryArgv($.plugin.root, entry, args, launch),
                       env === undefined ? { timeoutMs } : { timeoutMs, env });
}

/** How long `/fleet doctor` and `/fleet setup` may take: a load and a look, no source read. */
export const ASK_MS = 10_000;

/** What a person is told when the configured interpreter could not run a script. */
function interpreterAdvice(entry: string, detail: string): string {
  return `fleet ${entry} could not run under ${launch.python} (${detail}). Set the plugin's `
    + "Python interpreter option in /config to a Python 3.11 or newer on this machine.";
}

/**
 * Run `/fleet doctor` or `/fleet setup` and answer with what the script printed.
 *
 * Both print lines meant for a person, so their output is the answer. A script
 * that printed nothing is one the interpreter never ran, which is the one thing
 * neither script can say for itself, so that answer names the option that sets
 * the interpreter. A starter just written changes the configuration under the
 * session, so its read times are asked for again before the next read.
 */
async function askEntry($: Engine, state: State, entry: "doctor" | "setup"): Promise<string> {
  let run: Awaited<ReturnType<typeof runEntry>>;
  try {
    run = await runEntry($, entry, [], ASK_MS);
  } catch (error) {
    if (cancelled(error)) {
      return `fleet ${entry} was stopped before it answered.`;
    }
    return interpreterAdvice(entry, error instanceof Error ? error.message : String(error));
  }
  const text = run.stdout.trim();
  if (!text) {
    const said = run.stderr.trim().split("\n")[0] ?? "";
    return interpreterAdvice(entry, "exit " + run.exitCode + (said ? ": " + said : ""));
  }
  if (entry === "setup" && run.exitCode === 0) {
    state.timesKnown = false;
    return text + " The pane reads it on its next read of the machine.";
  }
  return text;
}

/**
 * Reads once, without throwing: a read that failed is a state the pane names.
 *
 * Returns null for the one outcome that is not an answer of any kind, which is
 * the host cancelling the run. Nothing is held and nothing is reported.
 */
async function readOnce($: Engine, timeoutMs: number, extra: string[] = []): Promise<Held | null> {
  try {
    const run = await runEntry($, "snapshot", ["--pretty", ...extra], timeoutMs);
    const at = (await $.clock.now()) / 1000;
    if (run.exitCode !== 0) {
      // The reader answers a refused configuration on its standard output and
      // exits nonzero: the refusal is a result, and the pane draws every error
      // it holds. Only a nonzero exit with nothing usable to show is named by
      // its code, and the exit is what says the run did not succeed.
      const refusal = refusalFrom(run.stdout);
      return refusal === null
        ? { reason: "the read command exited " + run.exitCode, at }
        : { documents: refusal, at };
    }
    const documents: unknown = JSON.parse(run.stdout);
    if (documents === null) {
      // Valid JSON, and not a reading: nothing a reader prints is null. Left as
      // a document it would draw as a read still in flight, which is a failure
      // reported as patience.
      return { reason: "the read command printed no reading", at };
    }
    return { documents, at };
  } catch (error) {
    if (cancelled(error)) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    // A failure carries the time it happened like any other answer: a pane that
    // treated one as always stale would start another read on every paint.
    return { reason: "the read command did not answer: " + message,
             at: (await $.clock.now()) / 1000 };
  }
}

/**
 * The read times from the configuration alone, for a session that has held no reading.
 *
 * The times travel in the reading, so a session with none would give its first
 * read the packaged time, and a configured source slower than that would end
 * every read before the reading carrying the longer time could land. This
 * answer runs no reader, so it comes back quickly. One that fails or is refused
 * leaves the packaged times, and the next read asks again.
 *
 * False only when the host cancelled the run.
 */
async function learnTimes($: Engine, state: State): Promise<boolean> {
  const answer = await readOnce($, SETTINGS_MS, [SETTINGS_ONLY]);
  if (answer === null) {
    return false;
  }
  const documents = "documents" in answer ? answer.documents : null;
  // A reading another session kept may have landed while this was out, and
  // brought the times with it: those stand, and this answer is not laid over them.
  if (!state.timesKnown && typeof documents === "object" && documents !== null && !Array.isArray(documents)
      && !("configErrors" in documents) && "alerts" in documents) {
    state.alerts = alertConfigFrom(documents);
    state.timesKnown = true;
  }
  return true;
}

/**
 * Ask for a reading, and ask the pane to draw again once it lands.
 *
 * Never awaited by a hook: the answer arrives between paints, which is the only
 * place a process may run.
 */
/**
 * Ask the engine for this session's figures, off the paint, and draw again once
 * they land. Never throws: an engine that cannot answer leaves the reading's
 * own session document standing.
 */
function measure($: Engine, state: State): void {
  if (state.measuring) {
    return;
  }
  state.measuring = true;
  state.measured = true;
  void Promise.all([
    $.session.usage(),
    $.session.model().catch(() => null),
    $.session.version().catch(() => null),
    $.clock.now(),
  ]).then(([usage, model, version, now]) => {
    if (typeof model === "string" && model) {
      state.modelId = model;
    }
    const document = sessionDocument(usage, model, version, state.sessionId, now);
    if (document !== null) {
      state.engineSession = document;
      $.ui.invalidate("ui.render");
    }
  }).catch(() => undefined).finally(() => { state.measuring = false; });
}

function stopFrames(state: State): void {
  state.frames?.cancel();
  state.frames = null;
  state.framed = 0;
}

/**
 * The pane with what is moving on it marked, and frames asked for while it moves.
 *
 * Frames are an interval that asks for a paint, started when something begins
 * to move and stopped by the first paint that finds nothing moving. The interval
 * also stops itself after the longest movement there is, so a pane closed in the
 * middle of a slide does not go on asking to be drawn.
 */
function moved($: Engine, state: State, pane: Pane, nowMs: number): Pane {
  const result = animate(pane, state.motion, nowMs);
  if (result.moving && state.frames === null) {
    state.framed = 0;
    state.frames = $.clock.every(FRAME_MS, () => {
      state.framed += 1;
      if (state.framed > FRAME_LIMIT) {
        stopFrames(state);
        return;
      }
      $.ui.invalidate("ui.render");
    });
  } else if (!result.moving && state.frames !== null) {
    stopFrames(state);
  }
  return result.pane;
}

/**
 * Land one more of the held reading's sections on what the pane draws, and
 * date the counts when the step brought the governor's.
 */
function landStep(state: State, held: { documents: unknown; at: number; progressAt?: number },
                  only?: string): string[] {
  const before = state.shown;
  const step = stepStream(before, documentsOf(held), only);
  state.shown = step.documents;
  // The counts are as old as the read that brought them: a live run's counts
  // carry their own time, and a whole reading's are as old as it is.
  if (before === null || (step.documents !== null && before.progress !== step.documents.progress)) {
    state.shownCountsAt = held.progressAt ?? held.at;
  }
  return step.pending;
}

/** A held reading's sections, or null for one that holds no object. */
function documentsOf(held: { documents: unknown }): Record<string, unknown> | null {
  return typeof held.documents === "object" && held.documents !== null
    ? held.documents as Record<string, unknown> : null;
}

function stopStream(state: State): void {
  state.streamTimer?.cancel();
  state.streamTimer = null;
}

/**
 * What the pane draws of the held reading: what changed lands a section at a
 * time, in the order the pane stacks them.
 *
 * The first section that changed lands on the paint that finds it, so a lone
 * change is drawn at once; the rest follow a step apart on a timer that stops
 * once nothing is left to land. A whole reading every twenty seconds otherwise
 * changed every section in one frame, which is the jerk a person sees.
 */
function streamed($: Engine, state: State,
                  held: { documents: unknown; at: number; progressAt?: number }): unknown {
  // A paused source replaces its rows on this paint, without waiting behind
  // another section's transition.
  const target = documentsOf(held);
  if (state.shown !== null && target !== null) {
    for (const source of ["progress", "trials"]) {
      if ((target[source] as { state?: unknown } | null)?.state === "paused") {
        state.shown = { ...state.shown, [source]: target[source] };
        if (source === "progress") {
          state.shownCountsAt = held.progressAt ?? held.at;
        }
      }
    }
  }
  // A paint of the reading already landed has nothing to step, and one while
  // the timer runs leaves the stepping to it.
  if (state.streamTimer !== null || state.shownFrom === held.documents) {
    return state.shown;
  }
  // A first reading lands whole, and one that changed no section lands its
  // settings at once: only the sections ripple.
  const pending = landStep(state, held);
  if (pending.length === 0) {
    state.shownFrom = held.documents;
    return state.shown;
  }
  // The sections land in the order they were found changed. One read again
  // while the stream runs goes to the back of the line rather than the front:
  // stepped by the pane's order each time, a section read faster than the
  // stream steps took the first place on every step, and the ones after it
  // never landed.
  state.streamQueue = pending;
  state.streamTimer = $.clock.every(state.alerts.streamStepMs, () => {
    const now = state.held !== null && !("reason" in state.held) ? state.held : null;
    const next = state.streamQueue.shift();
    if (now !== null && !state.ended && next !== undefined) {
      landStep(state, now, next);
    }
    // What changed again while the line was landing is the next line.
    if (now !== null && !state.ended && state.streamQueue.length === 0) {
      state.streamQueue = pendingSources(state.shown, documentsOf(now));
    }
    if (now === null || state.ended || state.streamQueue.length === 0) {
      state.shownFrom = now?.documents;
      stopStream(state);
    }
    $.ui.invalidate("ui.render");
  });
  return state.shown;
}

/**
 * Keep an open pane drawn once a tick so the ages on it count, and stop when it
 * closes or the session ends.
 */
function keepTime($: Engine, state: State): void {
  if (state.clock !== null && state.clockMs === state.alerts.clockMs) {
    return;
  }
  state.clock?.cancel();
  state.clockMs = state.alerts.clockMs;
  try {
    state.clock = $.clock.every(state.clockMs, () => {
      if (!state.open || state.ended) {
        state.clock?.cancel();
        state.clock = null;
        return;
      }
      $.ui.invalidate("ui.render");
    });
  } catch {
    // No clock: the ages move when something else draws the pane.
    state.clock = null;
  }
}

/**
 * Look at the machine, off the paint, and ask the pane to draw again when what
 * it holds changed.
 *
 * Never awaited by a hook: the answer arrives between paints, which is the only
 * place a process may run.
 */
function refresh($: Engine, state: State, from: "timer" | "paint" = "timer"): void {
  // Every paint of a stale pane lands here while a look is out, so nothing
  // before this line may ask for a frame: asking on every paint drew sixty
  // frames a second until the read landed. A paint asks only because the whole
  // reading is old, and while this session is reading it the read's landing is
  // what draws the pane again: a look per paint would ask the store the same
  // question on every frame of a slide.
  if (state.looking || state.ended || (from === "paint" && state.readingWhole)) {
    return;
  }
  state.looking = true;
  void share($, state)
    .catch(() => undefined)
    .finally(() => { state.looking = false; });
}

/**
 * One look, shared with every other session on the machine.
 *
 * Each session used to read the machine on its own timer and draw what it read,
 * so two panes side by side showed two moments, up to an interval apart, and
 * every session paid for a read. Now the store holds one reading for all of
 * them: a session draws the newest one there, and only a session that finds it
 * old reads the machine, under a claim the others respect, and writes what it
 * read back for everyone. While a governor run is live its counts are read on
 * their own every second, the same way, which is a read of one file, and kept
 * under their own key.
 */
async function share($: Engine, state: State): Promise<void> {
  const [stored, counts, replied] = await Promise.all([
    $.store.get(READING_KEY).catch(() => undefined),
    $.store.get(COUNTS_KEY).catch(() => undefined),
    $.store.get(REPLIED_KEY).catch(() => undefined),
  ]);
  heardReplies($, state, replied);
  if (isCarried(stored) && newer(stored, state.held)) {
    adopt($, state, stored);
  }
  if (isCounts(counts)) {
    fold($, state, counts);
  }
  // Read once the store has answered: a reading another session wrote during
  // that round trip is dated after a clock read taken before it.
  const now = (await $.clock.now()) / 1000;
  try {
    look($, state, now);
  } finally {
    // The look runs faster while an open pane shows a live run, and slows again
    // once it does not, whichever way this look went.
    arm($, state);
  }
}

/**
 * Start a read of what is old: the whole machine, a live run's counts while a
 * pane shows them, or both.
 *
 * Neither waits for the other. A whole read takes one to three seconds, and the
 * counts used to wait it out, so a pane streaming a run's counts every second
 * froze for that long every twenty seconds and then jumped.
 */
function look($: Engine, state: State, now: number): void {
  // A probe `/worktrees` asked for is a whole read already, whatever the age.
  readFresh($, state);
  const held = state.held;
  const interval = state.alerts.snapshotSeconds;
  const age = held === null ? Number.POSITIVE_INFINITY : now - held.at;
  // A reading dated well ahead of this clock is as unusable as an old one: every
  // age drawn from it is negative, and it never ages into being read again.
  if ((age >= interval || age < -AHEAD_SECONDS) && !state.readingWhole) {
    state.readingWhole = true;
    void underClaim($, state, CLAIM_KEY, now, () => readWhole($, state))
      .finally(() => {
        state.readingWhole = false;
        arm($, state);
        // A probe `/worktrees` asked for while this read was out starts now.
        readFresh($, state);
      });
  }
  // The counts are dated when the look decided to read them, and are due half
  // an interval early: dated when the read finished, a look one interval later
  // would find them a read's length short of due and skip, and the counts would
  // move every other interval.
  const every = state.alerts.progressMs / 1000;
  if (state.open && held !== null && "documents" in held && liveRuns(held.documents)
      && now - (held.progressAt ?? held.at) >= every / 2 && !state.counting) {
    state.counting = true;
    void underClaim($, state, PROGRESS_CLAIM_KEY, now, () => readProgress($, state, now))
      .finally(() => {
        state.counting = false;
        arm($, state);
      });
  }
}

/**
 * Read the whole machine now, with every worktree probed rather than answered
 * from its cache, whatever age the shared reading is, once `/worktrees` asked.
 *
 * Started by a look, never by the command: a probe of every worktree takes
 * seconds per worktree, and a process the command starts is the command's own
 * work. In a live session a probe the command waited for ended at 15 seconds
 * with nothing printed, and under the host's test kit one it left running never
 * ran. A look is where every read of the machine starts.
 *
 * It takes no claim, since another session's read in flight may be answering
 * from the cache. A read of this session's own in flight is let finish first,
 * and this one starts as it lands, so two reads never write this session's
 * reading at once.
 */
function readFresh($: Engine, state: State): void {
  if (!state.freshAsked || state.readingWhole || state.ended) {
    return;
  }
  state.freshAsked = false;
  state.readingWhole = true;
  void readWhole($, state, true)
    .catch(() => undefined)
    .finally(() => {
      state.readingWhole = false;
      arm($, state);
    });
}

/** Run a read under a claim for every session, and let the claim go after, whatever the read did. */
async function underClaim($: Engine, state: State, key: string, now: number,
                          read: () => Promise<void>): Promise<void> {
  try {
    if (!(await claim($, state, key, now))) {
      return;
    }
    try {
      await read();
    } finally {
      await release($, state, key);
    }
  } catch {
    // A read that threw leaves what this session holds standing.
  }
}

/** When a reading's newest part was read: the whole, or its governor counts since. */
function readAt(held: Held | Carried): number {
  return Math.max(held.at, "progressAt" in held && typeof held.progressAt === "number"
    ? held.progressAt : 0);
}

/**
 * Whether the shared reading is a newer whole reading than this session holds.
 *
 * By when the whole was read: counts this session folded in since are kept apart
 * and say nothing about the rest. The same whole reading is newer only when a
 * session from before the counts were kept apart folded fresher counts into it.
 */
function newer(stored: Carried, held: Held | null): boolean {
  if (held === null) {
    return true;
  }
  if (stored.at !== held.at) {
    return stored.at > held.at;
  }
  return readAt(stored) > readAt(held);
}

/**
 * A whole reading's documents with the counts this session already holds, when
 * those were read after the whole reading's own.
 *
 * A whole read reads the counts as it starts and lands up to a few seconds later,
 * so taking its counts over ones read meanwhile would step a run backwards.
 */
function withNewerCounts(before: Held | null, documents: unknown,
                         progressAt: number): { documents: unknown; progressAt: number } {
  if ((documents as { progress?: { state?: unknown } } | null)?.progress?.state === "paused") {
    return { documents, progressAt };
  }
  if (before === null || !("documents" in before) || before.progressAt === undefined
      || before.progressAt <= progressAt) {
    return { documents, progressAt };
  }
  const progress = (before.documents as { progress?: unknown } | null)?.progress;
  return { documents: { ...(documents as Record<string, unknown>), progress },
           progressAt: before.progressAt };
}

/** Fold counts another session read into what this session draws, when they are newer. */
function fold($: Engine, state: State, counts: Counts): void {
  const held = state.held;
  if (held === null || !("documents" in held) || counts.at <= (held.progressAt ?? held.at)) {
    return;
  }
  state.held = { documents: { ...(held.documents as Record<string, unknown>),
                              progress: counts.progress },
                 at: held.at, progressAt: counts.at };
  $.ui.invalidate("ui.render");
  // A run's failures are band items, so new counts can move the tab's level.
  void tint($, state);
}

/**
 * Draw a reading another session took, as though this one had.
 *
 * Its news is raised here like a reading of this session's own, since this
 * session may never read the machine itself; what was already seen is not
 * raised again, and the first reading a session holds starts its record.
 */
function adopt($: Engine, state: State, stored: Carried): void {
  const fresh = state.held === null || !("documents" in state.held) || stored.at > state.held.at;
  const kept = withNewerCounts(state.held, stored.documents,
                               typeof stored.progressAt === "number" ? stored.progressAt : stored.at);
  state.held = { documents: kept.documents, at: stored.at, progressAt: kept.progressAt };
  state.alerts = alertConfigFrom(stored.documents);
  state.timesKnown = true;
  limitHidden(state, stored.documents);
  void raise($, state, stored.documents as ReaderDocuments, readAt(stored));
  void tint($, state);
  // The session's own figures are asked for with each whole reading, so they
  // age with it rather than freezing at the first paint.
  if (fresh) {
    remeasure($, state);
  }
  $.ui.invalidate("ui.render");
}

/** Ask the engine for this session's figures, without letting a fault stop a reading. */
function remeasure($: Engine, state: State): void {
  try {
    measure($, state);
  } catch {
    // An engine with no session figures: the reading's document stands.
  }
}

/**
 * Read the whole machine, hold it, raise its news, and share it.
 *
 * `fresh` has the worktrees probed now rather than answered from their cache,
 * which is what `/worktrees` asks for.
 */
async function readWhole($: Engine, state: State, fresh = false): Promise<void> {
  remeasure($, state);
  if (!state.timesKnown && !(await learnTimes($, state))) {
    // Cancelled with the paint that started it, as the read below may be.
    $.ui.invalidate("ui.render");
    return;
  }
  // The read reads the counts as it starts, so its counts are dated then.
  const started = (await $.clock.now()) / 1000;
  // A probe of every worktree takes longer than a read from their cache.
  const asked = state.sessionId;
  const result = await readOnce($, fresh ? state.alerts.worktreeHelperMs : state.alerts.helperMs,
                               [...(fresh ? [FRESH_WORKTREES] : []),
                                "--session", state.sessionId, "--model", state.modelId ?? ""])
    .catch(async (error: unknown): Promise<Held | null> => cancelled(error)
      ? null
      : { reason: "the read command did not answer: " + String(error),
          at: (await $.clock.now()) / 1000 });
  if (result === null) {
    // The host stopped the run because the paint that started it was
    // superseded. Nothing was read and nothing was refused, so nothing is
    // recorded: what the pane held stays held, and a cancelled read is not
    // kept in the store as though it were a fleet.
    //
    // One repaint is asked for, because this is the paint that has to ask
    // again and it may already have gone by while the run was dying. It is
    // one: a fresh read is started by that paint, and it is not aborted by
    // the paint it belongs to.
    $.ui.invalidate("ui.render");
    return;
  }
  // Which session this reading priced, so one taken before the identifier
  // landed is known for what it is and read again with it.
  state.sessionIdRead = asked;
  if ("documents" in result) {
    const progressAt = (result.documents as { progress?: { state?: unknown } })?.progress?.state
      === "paused" ? result.at : started;
    const kept = withNewerCounts(state.held, result.documents, progressAt);
    state.held = { documents: kept.documents, at: result.at, progressAt: kept.progressAt };
  } else {
    state.held = result;
  }
  if ("documents" in result && isReading(result.documents as ReaderDocuments | null)) {
    // Only a fresh read is news. The reading carried over from the last
    // session is never raised: what it holds already happened.
    state.alerts = alertConfigFrom(result.documents);
    state.timesKnown = true;
    limitHidden(state, result.documents);
    void raise($, state, result.documents as ReaderDocuments, result.at);
    void tint($, state);
    // Kept for every session to draw, and for the next session to open on. A
    // failure is not kept, and neither is a refused configuration: neither one
    // left a fleet, and a stored refusal would outlive the machine's mood. It is
    // written before the claim is let go, so a session that claims next finds it,
    // and not over a newer whole reading: two sessions read at once when a claim
    // lapses, and the one that finishes last is not the one that read last.
    const stored: unknown = await $.store.get(READING_KEY).catch(() => undefined);
    if (!(isCarried(stored) && stored.at > result.at)) {
      const progressAt = (result.documents as { progress?: { state?: unknown } })?.progress?.state
        === "paused" ? result.at : started;
      await $.store.set(READING_KEY, { at: result.at, progressAt,
                                       documents: result.documents })
        .catch(() => undefined);
    }
  }
  // The pane is drawn again on the next frame with what just arrived.
  $.ui.invalidate("ui.render");
}

/** The progress states a read that worked answers with: runs counted, or none to count. */
const READ_STATES: ReadonlySet<unknown> = new Set(["ready", "empty", "paused"]);

/** Whether a reading holds a governor run that is live now. */
function liveRuns(documents: unknown): boolean {
  const progress = (documents as { progress?: { runs?: unknown } } | null)?.progress;
  return Array.isArray(progress?.runs) && progress.runs.length > 0;
}

/**
 * Read a live governor run's counts on their own, draw them, and keep them under
 * their own key for every session.
 *
 * A read that fails leaves the whole reading standing: the counts it held are
 * older, not wrong, and the next whole read says what the machine says. That
 * includes a reader that failed inside the read command, which answers with a
 * document naming the failure rather than with an exit code.
 */
async function readProgress($: Engine, state: State, progressAt: number): Promise<void> {
  const run = await runEntry($, "snapshot", ["--only", "progress"], 10_000)
    .catch(() => null);
  if (run === null || run.exitCode !== 0) {
    return;
  }
  let part: unknown;
  try {
    part = JSON.parse(run.stdout);
  } catch {
    return;
  }
  const progress = (part as { progress?: unknown } | null)?.progress;
  const held = state.held;
  if (typeof progress !== "object" || progress === null || held === null
      || !("documents" in held)
      || !READ_STATES.has((progress as { state?: unknown }).state)) {
    return;
  }
  const counts: Counts = { at: progressAt, progress: progress as Record<string, unknown> };
  fold($, state, counts);
  // Kept only when no newer counts are there: two sessions count at once when a
  // claim lapses, and the one that finishes last is not the one that read last.
  const stored: unknown = await $.store.get(COUNTS_KEY).catch(() => undefined);
  if (!(isCounts(stored) && stored.at >= progressAt)) {
    await $.store.set(COUNTS_KEY, counts).catch(() => undefined);
  }
}

/**
 * Claim a read for every session, unless another session holds a claim.
 *
 * The store is not a lock: two sessions can both find no claim and both read.
 * That costs a read and nothing else, since both write what the machine said;
 * what the claim prevents is every session reading at once on every interval.
 * A store that cannot be read claims nothing and reads, so a fault is a reading
 * rather than a pane that never reads again.
 */
async function claim($: Engine, state: State, key: string, now: number): Promise<boolean> {
  const current = await $.store.get(key).catch(() => undefined) as
    { at?: unknown; by?: unknown } | undefined;
  if (typeof current === "object" && current !== null && typeof current.at === "number"
      && current.by !== state.token && current.at <= now + AHEAD_SECONDS
      && now - current.at < CLAIM_SECONDS) {
    return false;
  }
  await $.store.set(key, { at: now, by: state.token }).catch(() => undefined);
  return true;
}

/**
 * Let a claim go, so the next session that finds the reading old may read.
 *
 * Only this session's own: a read that outran the claim's age had it taken over,
 * and letting the other session's claim go would let a third read beside it.
 */
async function release($: Engine, state: State, key: string): Promise<void> {
  const current = await $.store.get(key).catch(() => undefined) as { by?: unknown } | undefined;
  if (typeof current === "object" && current !== null && current.by !== state.token) {
    return;
  }
  await $.store.set(key, { at: 0, by: state.token }).catch(() => undefined);
}

/**
 * Draw the reading the last session left, if this one has not read yet.
 *
 * Started off the paint like the read itself, and only while nothing is held:
 * a paint answers from what it holds, and this is a store read this process does
 * not wait for either. When nothing is stored, the read is what the pane falls
 * back on, which is why this asks for one rather than leaving the pane on a
 * sentence forever.
 */
function hydrate($: Engine, state: State): void {
  if (state.hydrated) {
    return;
  }
  state.hydrated = true;
  void $.store.get(READING_KEY)
    .catch(() => undefined)
    .then((stored: unknown) => {
      if (state.held === null && isCarried(stored)) {
        state.held = { documents: stored.documents, at: stored.at,
                       ...(typeof stored.progressAt === "number"
                         ? { progressAt: stored.progressAt } : {}) };
        // The settings travel with the reading, so a pane opened on the one the
        // last session left times its toasts as that reading says, not as the
        // packaged default does until the next look.
        state.alerts = alertConfigFrom(stored.documents);
        state.timesKnown = true;
        limitHidden(state, stored.documents);
        $.ui.invalidate("ui.render");
      } else if (state.held === null) {
        refresh($, state);
      }
    });
}

/**
 * The fold each section starts in, which is the one the configuration declares.
 *
 * One place decides, so a press flips the same value the pane drew rather than
 * a second guess at it. A reading that carried the pane's configuration decides
 * the order and every section's start; a reading that carried none, which is
 * what an older one looks like, falls back to the packaged default.
 */
function startFolded(width: number, now: number, pane: PaneConfig | null): Fold {
  const base = paneOptions(width, now, pane).sections;
  return Object.fromEntries(sectionNames(pane).map(
    (name) => [name, base[name]?.collapsed ?? false]));
}

/** The sections this pane draws, which a resolved configuration may reorder. */
function sectionNames(pane: PaneConfig | null): string[] {
  // An absent configuration is all eight. A configuration that is there
  // decides, including one that names no sections at all.
  return pane === null ? SECTIONS : pane.order;
}

/**
 * The fold the pane draws with.
 *
 * One place decides, so a press flips the same value the pane drew rather than a
 * second guess at it: what a person pressed outranks the configuration, and a
 * section nobody pressed is wherever its configuration starts it.
 */
function foldDrawn(pressed: Fold, configured: Fold, names: string[]): Fold {
  return Object.fromEntries(names.map(
    (name) => [name, pressed[name] ?? configured[name] ?? false]));
}

/**
 * Fold what a press named, say whether it changed anything this pane drew, and
 * name the sections it pressed, which are what it writes.
 */
function folded(pressed: Fold, configured: Fold, element: string,
                names: string[]): { pressed: Fold; changed: boolean; named: string[] } {
  const drawn = foldDrawn(pressed, configured, names);
  if (element.startsWith(TOGGLE_PREFIX)) {
    const name = element.slice(TOGGLE_PREFIX.length);
    if (!names.includes(name)) {
      return { pressed, changed: false, named: [] };
    }
    // The flip is off what is drawn, not off what happens to be in the pressed
    // map: a section the configuration folded and nobody has pressed draws
    // folded, so the first press on it opens it rather than folding it again.
    return { pressed: { ...pressed, [name]: !(drawn[name] ?? false) }, changed: true, named: [name] };
  }
  if (element === TOGGLE_ALL + ".collapse" || element === TOGGLE_ALL + ".expand") {
    const to = element.endsWith(".collapse");
    if (!names.length) {
      return { pressed, changed: false, named: [] };
    }
    // Every section this pane draws gets a press of its own, and a section the
    // pane is not drawing keeps the one it already had: the order can change
    // under a session, and a control that replaced the whole map would drop the
    // fold of a section that is merely out of sight for now, so it came back
    // wherever its configuration started it rather than where it was left.
    const next = { ...pressed,
                   ...Object.fromEntries(names.map((name) => [name, to])) };
    // The press is recorded even when every section already draws that way, so
    // the person's last action stands if a later configuration disagrees. Only
    // the redraw is skipped: a pane redrawn for a press that changed nothing is
    // redrawn for nothing.
    const already = names.every((name) => (drawn[name] ?? false) === to);
    return { pressed: next, changed: !already, named: names };
  }
  return { pressed, changed: false, named: [] };
}

/**
 * Whether a value the host handed back is a fold this pane can draw with.
 *
 * The session's own memory crosses a reload, not a process, so it is this
 * plugin's shape rather than anything else's. A value that is not a fold is
 * refused and the configuration decides instead, because a pane drawing half of
 * somebody else's object would fold sections on the strength of a guess.
 */
function isFold(value: unknown): value is Fold {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>)
    .every((entry) => typeof entry === "boolean");
}

/**
 * Take back the fold this session was left in, if it was left in one.
 *
 * The host holds this, so it survives a hot reload of the plugin, which rebuilds
 * the module and with it everything a registration remembers. A session the
 * host holds no fold for is a new one, and it opens with the folds the last
 * session left, from the store. It is read once per registration, off the
 * paint: a paint answers from what it holds, and the configured fold is what it
 * holds until this lands.
 *
 * The reference is written out here rather than named by a constant, because the
 * host lists the values a module reads and writes by reading them off its
 * source: a key it cannot see is a value nobody can list.
 */
/**
 * Ask the host which sections were left drawn in full, once per session.
 *
 * A press made while this read is out is newer than what the host held, so the
 * two are merged with the press winning, and the pane is redrawn only when that
 * changed what it draws.
 */
function restoreShownAll($: Engine, state: State): void {
  if (state.shownAllRestored) {
    return;
  }
  state.shownAllRestored = true;
  $.state.get(SHOWN_ALL).then((held) => {
    if (!isFold(held.value)) {
      return;
    }
    const merged = { ...held.value, ...state.shownAll };
    const same = JSON.stringify(merged) === JSON.stringify(state.shownAll);
    state.shownAll = merged;
    if (!same) {
      $.ui.invalidate("ui.render");
    }
  }).catch(() => undefined);
}

function restoreFold($: Engine, state: State): void {
  if (state.restored) {
    return;
  }
  state.restored = true;
  let restored: Fold = {};
  state.foldRestore = $.state.get(FOLDED)
    .then(async (held): Promise<{ value: unknown }> => isFold(held.value) ? held
      : { value: await $.store.get(FOLDS_KEY).catch(() => undefined) })
    .then((held) => {
      if (!isFold(held.value)) {
        return;
      }
      // A press that landed while this was in flight is newer than what the host
      // still holds, so it wins: what is taken from the host is the sections
      // nobody has pressed since. Reading this into state blindly would undo a
      // press the person can see, while the host kept the newer value.
      const merged = { ...held.value, ...state.pressed };
      // Redrawn only when the fold actually changed, so a session that pressed
      // nothing is not repainted for a value it already had.
      const same = JSON.stringify(merged) === JSON.stringify(state.pressed);
      state.pressed = merged;
      if (!same) {
        // What the host holds is written again with the merge in it: a press
        // made while this read was out was written on its own, and the sections
        // this read brought back would be lost by the next reload if they were
        // only ever held here.
        // This read was started by a paint, and the host refuses a write that
        // work a paint started makes, so it is made at the next tick.
        restored = held.value;
        const brought = held.value;
        afterPaint($, state, () => {
          queueFold($, state, {}, brought);
        });
        $.ui.invalidate("ui.render");
      }
    })
    .catch(() => undefined)
    .finally(() => {
      state.foldsLoaded = true;
      // A press that landed before this read kept its fold in the host alone:
      // saved now, with what was read merged under it, so the next session
      // opens with both rather than with the press over nothing.
      if (state.foldsDirty) {
        state.foldsDirty = false;
        const pending = state.foldsPending;
        state.foldsPending = {};
        saveFolds($, state, pending, restored);
      }
    });
}

/**
 * Write a change to the session's held fold: `over` is what a press set, laid
 * over what is held, and `under` is what a restore brought, laid only where
 * nothing stands.
 *
 * Every load of the session writes the same held fold, and each holds its own
 * picture of it, so no load writes its whole picture: the fold is read, the
 * change applied to what is held, and the write made at the version read,
 * read again if another write landed first.
 */
async function writeFold($: Engine, over: FleetFold, under: FleetFold): Promise<void> {
  try {
    for (;;) {
      const read = await $.state.get(FOLDED);
      const current: FleetFold = isFold(read.value) ? read.value : {};
      const kept: FleetFold = { ...under, ...current, ...over };
      if (JSON.stringify(kept) === JSON.stringify(current)) {
        break;
      }
      const written = await $.state.set(FOLDED, kept, { ifVersion: read.version });
      if (written.isSet || written.version === read.version) {
        break;
      }
    }
  } catch {
    // The host would not hold it: this load still draws the fold it restored.
  }
}

/**
 * Write a change to the held fold after every change this load made before it.
 *
 * A write refused at a moved version reads again and is made once more; left to
 * run beside a later press's write, an earlier press could land after it and
 * undo it. One at a time, in the order made, each lands over the last.
 */
function queueFold($: Engine, state: State, over: FleetFold, under: FleetFold): void {
  state.foldWrites = state.foldWrites
    .then(() => writeFold($, over, under))
    .catch(() => undefined);
}

/**
 * Wait for this load's writes still out, the held fold, the stored folds and
 * the last look, at most `END_WRITES_MS`: a session's end lets go of them, and
 * a write held by a host that stopped answering must not hold the end with it.
 * With no clock to bound the wait, the end does not wait.
 *
 * A fold read still out when the end starts adds writes of its own when it
 * lands, so the chains are read again after each wait, until a wait ends with
 * none of them moved.
 */
function writesLanded($: Engine, state: State): Promise<void> {
  const chains = (): Promise<unknown>[] =>
    [state.foldRestore, state.foldWrites, state.foldSaves, state.seenWrite];
  return new Promise<void>((resolve) => {
    let bound: { cancel(): void } | null = null;
    let over = false;
    const done = (): void => {
      over = true;
      bound?.cancel();
      resolve();
    };
    try {
      bound = $.clock.every(END_WRITES_MS, done);
    } catch {
      resolve();
      return;
    }
    void (async () => {
      for (;;) {
        const waited = chains();
        await Promise.all(waited).catch(() => undefined);
        if (over) {
          return;
        }
        if (chains().every((chain, index) => chain === waited[index])) {
          break;
        }
      }
      done();
    })();
  });
}

/**
 * Make a write a paint asked for at the next tick of the clock.
 *
 * The host refuses a write of its own values made while a render hook draws,
 * and work a paint started is still that paint's when it lands; a tick is an
 * event of its own. Every write waiting goes at one tick, in the order asked.
 * With no clock they wait for the next event that is not a paint, a prompt or
 * the session's end, which `drainAfterPaint` runs; written from the paint they
 * would only be refused.
 */
function afterPaint($: Engine, state: State, write: () => void): void {
  // An ended session draws nothing more and nothing later drains the queue, so
  // a read that lands after the end writes at once: it was started by the
  // session's start, not by a paint, unless no start ever came.
  if (state.ended) {
    write();
    return;
  }
  state.afterPaint.push(write);
  if (state.afterPaintTick !== null) {
    return;
  }
  try {
    const tick = $.clock.every(AFTER_PAINT_MS, () => {
      // One tick is all it waits for, and a tick of one already cancelled
      // never runs another's writes.
      if (state.afterPaintTick !== tick) {
        return;
      }
      drainAfterPaint(state);
    });
    state.afterPaintTick = tick;
  } catch {
    // No clock: the writes wait for the next event that is not a paint.
  }
}

/**
 * Make every write a paint asked for now, from an event that is not a paint,
 * and stop the tick that was waiting to.
 */
function drainAfterPaint(state: State): void {
  state.afterPaintTick?.cancel();
  state.afterPaintTick = null;
  for (const queued of state.afterPaint.splice(0)) {
    queued();
  }
}

/**
 * Keep the folds as they stand now: in the host for this session, and in the
 * store for the next one.
 *
 * Neither write is waited for, and a refusal never undoes the fold: the pane a
 * person is looking at folds whatever the host or the store says. The store
 * writes go one after another, so two quick presses land in the order they
 * were pressed, and a store that refuses is said in a toast, once until a save
 * lands again, since the folds then last only for this session.
 */
function keepFold($: Engine, state: State, named: string[]): void {
  // Only the sections this press named: the rest of this load's picture may be
  // older than what another load of the session pressed since. A section it
  // named is written even where this load already drew it that way, since
  // another load may have moved it, and the press is the person's last word.
  const pressed: Fold = {};
  for (const name of named) {
    const value = state.pressed[name];
    if (value !== undefined) {
      pressed[name] = value;
    }
  }
  queueFold($, state, pressed, {});
  // Before the folds the last session left are read, a store write would put
  // this press alone over them; the merge is saved once they land.
  if (!state.foldsLoaded) {
    state.foldsDirty = true;
    state.foldsPending = { ...state.foldsPending, ...pressed };
    return;
  }
  saveFolds($, state, pressed, {});
}

/**
 * Save a change to the folds the next session opens with, in the store, which
 * a paint may write: only the host's own values are refused it.
 *
 * As with the held fold, `over` is what was pressed and `under` what a restore
 * brought, applied to what the store holds now rather than written whole: a
 * session's picture can be older than another's save. A store that cannot say
 * what it holds is not written, and that is said as a refused save is.
 */
function saveFolds($: Engine, state: State, over: Fold, under: Fold): void {
  state.foldSaves = state.foldSaves
    .then(async () => {
      const stored: unknown = await $.store.get(FOLDS_KEY);
      const current: Fold = isFold(stored) ? stored : {};
      await $.store.set(FOLDS_KEY, { ...under, ...current, ...over });
    })
    .then(() => { state.foldToast = false; })
    .catch(() => {
      if (state.foldToast) {
        return;
      }
      state.foldToast = true;
      return $.ui.toast("fleet: section folds kept for this session; could not save them.",
                        { timeoutMs: state.alerts.toastMs }).catch(() => undefined);
    });
}

/** A last look the store handed back: `{ at }` with a finite time, or nothing usable. */
function seenFrom(value: unknown): number | null {
  const at = typeof value === "object" && value !== null ? (value as { at?: unknown }).at : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

/**
 * Ask for the person's last look, once per opening of the pane.
 *
 * Asked again after each close, since another session may have moved the
 * shared look while this pane was shut. The latest of the session's own look,
 * the shared one, and what this load holds stands. Until they answer the digest
 * draws nothing: a first look drawn for the moment the host took would show
 * someone every event they have seen.
 */
function restoreSeen($: Engine, state: State): void {
  if (state.seenAsked) {
    return;
  }
  state.seenAsked = true;
  void Promise.all([
    $.state.get(SEEN_HELD).then((read) => seenFrom(read.value), () => null),
    $.store.get(SEEN_KEY).then(seenFrom, () => null),
  ]).then(([own, shared]) => {
    const looks = [state.lastSeen ?? null, own, shared].filter((at): at is number => at !== null);
    const next = looks.length ? Math.max(...looks) : null;
    if (next === state.lastSeen) {
      return;
    }
    state.lastSeen = next;
    // Only a reading that carries events draws a digest, so only then can the
    // look change what is on the pane.
    const documents = state.held !== null && "documents" in state.held
      ? state.held.documents as { events?: unknown } | null : null;
    if (documents?.events !== undefined && documents.events !== null) {
      $.ui.invalidate("ui.render");
    }
  });
}

/**
 * The pane closed: the newest event its digest drew is now seen.
 *
 * This is the one moment the last look moves. A digest still on screen has not
 * been read yet, and moving the look while it is would make a pane left open
 * all afternoon lose what happened after lunch. Only what was drawn moves it, so
 * a pane closed before the digest landed, or on a digest that could not read
 * its events, moves nothing. This load's writes are chained so a later close
 * never lands before an earlier one. A close the band found while it drew is
 * written at the next tick, since the host refuses a write a paint makes; this
 * load draws from the look it holds meanwhile.
 */
function markSeen($: Engine, state: State, fromPaint = false): void {
  const through = state.digestThrough;
  // Asked again on the next open, for what another session moved meanwhile.
  state.seenAsked = false;
  if (through === null) {
    return;
  }
  state.digestThrough = null;
  const at = state.lastSeen === undefined || state.lastSeen === null ? through
    : Math.max(state.lastSeen, through);
  state.lastSeen = at;
  const write = (): void => {
    state.seenWrite = state.seenWrite
      .then(() => keepSeen($, at))
      .catch(() => undefined);
  };
  if (fromPaint) {
    afterPaint($, state, write);
  } else {
    write();
  }
}

/**
 * Keep `at` as the session's own look and as the shared one, never moving
 * either back.
 *
 * The session's own is written only at the version it was read at: another
 * load of the session that wrote first refuses the write, and the look is read
 * again. Each refusal is another load's write that landed, and a session closes
 * its pane a bounded number of times, so this ends; a refusal that names the
 * version it read is no race, and is not tried again. A host that will not hold
 * the look still has the shared one written, since that is what the next
 * session starts from. A store that cannot say what it holds is not written:
 * blind, a write could move back a look another session moved further.
 */
async function keepSeen($: Engine, at: number): Promise<void> {
  try {
    for (;;) {
      const read = await $.state.get(SEEN_HELD);
      const held = seenFrom(read.value);
      if (held !== null && held >= at) {
        break;
      }
      const seen: FleetDigestSeen = { at };
      const written = await $.state.set(SEEN_HELD, seen, { ifVersion: read.version });
      if (written.isSet || written.version === read.version) {
        break;
      }
    }
  } catch {
    // The host would not hold it: this load still holds it, and the shared look
    // below is what any other load or session starts from.
  }
  let shared: number | null;
  try {
    shared = seenFrom(await $.store.get(SEEN_KEY));
  } catch {
    return;
  }
  if (shared === null || shared < at) {
    const seen: FleetDigestSeen = { at };
    await $.store.set(SEEN_KEY, seen);
  }
}

/**
 * Ask for what the band leaves out: this session's own job, and what was
 * dismissed here or in an earlier session.
 *
 * Neither is waited for; the band draws without them until they land, which
 * costs at most one frame of an item that is about to go. Neither may throw
 * either: this runs inside session.start, ahead of the engine's own startup,
 * and a throw there skips the command the session registered with it, so the
 * pane would lose its command over a lookup the band can draw without.
 */
function rememberBand($: Engine, state: State): void {
  try {
    void $.session.id().then((id) => {
      state.sessionId = typeof id === "string" ? id : "";
      if (state.held !== null) {
        $.ui.invalidate("ui.render");
      }
      // A reading taken before the identifier arrived priced the transcript
      // rather than this session's own spend; it is read again with the id.
      if (needsSessionRead(state.held !== null && "documents" in state.held,
                           state.sessionId, state.sessionIdRead)) {
        refresh($, state);
      }
    }).catch(() => undefined);
  } catch {
    // No identifier: the band shows this session's own job, which is the
    // lesser fault than a session with no command.
  }
  try {
    void $.store.get(REPLIED_KEY).then((value) => heardReplies($, state, value))
      .catch(() => undefined);
  } catch {
    // Nothing replied is remembered; a waiting job keeps its field.
  }
  try {
    void $.store.get(HIDDEN_KEY).then((value) => {
      if (Array.isArray(value)) {
        // Kept within the limit a held reading carries; with none held yet the
        // reading cuts them when it lands, so the limit wins whichever is first.
        state.hidden = value.filter((key): key is string => typeof key === "string");
        limitHidden(state, state.held !== null && "documents" in state.held
          ? state.held.documents : null);
        // Only a band drawn from a reading can change: with nothing held there
        // is no item for a dismissal to hide.
        if (state.held !== null) {
          $.ui.invalidate("ui.render");
        }
      }
    }).catch(() => undefined);
  } catch {
    // Nothing dismissed is remembered; the band shows everything it holds.
  }
}

/**
 * Take in the replies the store holds, and redraw when they differ from what
 * this session drew: a reply sent in another session takes the field away here.
 */
function heardReplies($: Engine, state: State, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const keys = value.filter((key): key is string => typeof key === "string");
  if (JSON.stringify(keys) !== JSON.stringify(state.replied)) {
    state.replied = keys;
    $.ui.invalidate("ui.render");
  }
}

/**
 * A toast, in the words the pane would draw: through the same masker, since a
 * toast quotes a job's name, its suggested reply and its command, and none of
 * them may show there what the pane hides.
 */
async function say($: Engine, text: string, timeoutMs: number): Promise<void> {
  await $.ui.toast(mask(text).text, { timeoutMs });
}

/**
 * Copy a line to the clipboard of the surface the press came from, and say so
 * for as long as the configuration gives a copy's toast.
 *
 * A surface that could not take it is told why, with the line itself, so a
 * person can still select it from the toast: a press that copied nothing and
 * said nothing is a press that looks broken.
 */
async function copyLine($: Engine, state: State, surface: string, text: string,
                        what: string): Promise<void> {
  const timeoutMs = state.alerts.copyToastMs;
  try {
    // The clipboard gets the real line; only what is said about it is masked.
    const copied = await $.ui.copy({ text, surface });
    if (copied.isCopied) {
      await say($, "fleet: copied " + what + ": " + text, timeoutMs);
      return;
    }
    await say($, "fleet: could not copy " + what + " ("
              + (copied.reason ?? "no reason given") + "): " + text, timeoutMs);
  } catch {
    await say($, "fleet: could not copy " + what + ": " + text, timeoutMs);
  }
}

/**
 * Send a waiting job its reply, in its own session, and say what happened.
 *
 * The pane draws a reading that can be seconds old, so the reply is checked
 * against the job as it stands before it goes:
 *
 * - A second submit in this pane is refused while the first is out.
 * - The helper reads the job's own file: the session it names now must be the
 *   one the reading named, and the hash of its whole question the one the reply
 *   was typed for. It then records that question as answered by this pane, with
 *   a marker file made by an exclusive create in the state directory: the store
 *   has no compare-and-set, so two panes could both find a store key free.
 * - Only the pane the helper answers as holding the reply sends. A question
 *   already answered, or with a reply on its way, sends nothing, whichever pane
 *   asks and however long after; a new question is free.
 * - A send the host refused, one this pane's own check stopped, and a helper that
 *   never answered each give the marker back (`release --failed`) so the person
 *   can try again; a send that went is recorded as sent (`confirm`). A give-back
 *   or a record that fails is said in a toast, and the row shows what stands: a
 *   reply on its way, and past `pane.replyPendingSeconds` one that may not have
 *   been sent, with a press that clears it and sends again.
 * - The pane checks the answer again, and nothing is awaited between it and the send.
 *
 * What remains is the job moving on between the helper's read and the message
 * landing, which no check from outside the job can close; the message then
 * waits in the job's queue for its next turn.
 */
async function sendReply($: Engine, state: State, job: Job, typed: string): Promise<void> {
  const timeoutMs = state.alerts.toastMs;
  const text = replyText(typed, job.suggested_reply);
  if (text === null) {
    await say($, "fleet: nothing to send to " + job.name + ": type a reply first", timeoutMs);
    return;
  }
  const held = state.held;
  const documents = held !== null && "documents" in held ? held.documents : null;
  const limit = paneNumberFrom(documents, "replyMaxChars", REPLY_MAX_CHARS);
  const length = [...text].length;
  if (length > limit) {
    await say($, "fleet: the reply to " + job.name + " is " + length + " characters, over the limit of "
              + limit + " (pane.replyMaxChars); nothing was sent", timeoutMs);
    return;
  }
  const opens = job.attach_command ? "; run " + job.attach_command : "";
  if (!job.session_id) {
    await say($, "fleet: could not reach " + job.name + ": the roster gave no session" + opens,
              timeoutMs);
    return;
  }
  if (!job.needs_hash) {
    await say($, "fleet: could not confirm what " + job.name + " asks; nothing was sent, "
              + "and the pane reads it again in a moment", timeoutMs);
    refresh($, state);
    return;
  }
  const key = job.provider + ":" + job.id;
  // Checked and taken with nothing awaited between, so two submits here cannot
  // both find the job free.
  if (state.replying.has(key)) {
    await say($, "fleet: a reply to " + job.name + " is already being sent; nothing more was sent",
              timeoutMs);
    return;
  }
  state.replying.add(key);
  try {
    await deliver($, state, job, job.session_id, job.needs_hash, text, opens, timeoutMs);
  } finally {
    state.replying.delete(key);
  }
}

/**
 * Have the helper mark the question answered and say what the job asks now, and
 * send the reply only when this pane holds it, to that question, in that
 * session; give the marker back only when nothing was sent.
 */
async function deliver($: Engine, state: State, job: Job, session: string, digest: string,
                       text: string, opens: string, timeoutMs: number): Promise<void> {
  const asked = await helper($, ["question", job.provider, job.id, "--holder", state.token,
                                 ...(state.sessionId ? ["--session", state.sessionId] : []),
                                 "--hash", digest, "--job-session", session]);
  type Asked = { state?: unknown; held?: unknown; needsHash?: unknown; sessionId?: unknown;
                 reason?: unknown };
  let now: Asked | null = null;
  try {
    now = JSON.parse(asked.stdout) as Asked;
  } catch {
    now = null;
  }
  const answered = now?.state;
  if (answered === "answered" || (answered === "ready" && now?.held !== true)) {
    await say($, "fleet: " + job.name + " was already answered, or a reply to it is on its way;"
              + " nothing was sent", timeoutMs);
    return;
  }
  // Every unreadable record this pane cleared for the question, whichever file it was.
  const unread = replyKey(job) + "@unreadable:";
  if (answered === "unreadable") {
    // A record there that does not read holds the question; its row offers the
    // press that clears it, this pane's own earlier clearing no longer standing.
    state.cleared = state.cleared.filter((entry) => !entry.startsWith(unread));
    $.ui.invalidate("ui.render");
    await say($, "fleet: the reply record for " + job.name + " could not be read; nothing was sent."
              + " Clear it from its row once the next reading shows it", timeoutMs);
    refresh($, state);
    return;
  }
  if (answered === "session-changed") {
    await say($, "fleet: " + job.name + ": this job's session changed; nothing sent", timeoutMs);
    refresh($, state);
    return;
  }
  if (answered === "question-changed") {
    await say($, "fleet: " + job.name + " is no longer asking that; nothing was sent, "
              + "and the pane shows its question in a moment", timeoutMs);
    refresh($, state);
    return;
  }
  if (answered === "full" || answered === "locked") {
    // A refusal for the whole machine: the rows say so until it ends, not only
    // this toast. Too many held replies is cleared by a press; a lock the
    // helper will not use names its fix and ends when a retry goes.
    const why = typeof now?.reason === "string" ? now.reason
      : answered === "full" ? "too many replies are held" : "a lock could not be used";
    state.paused = { kind: answered === "full" ? "full" : "lock", reason: why };
    $.ui.invalidate("ui.render");
    await say($, "fleet: could not send to " + job.name + " (" + why + "); nothing was sent", timeoutMs);
    return;
  }
  const marker = ["--job-session", session, "--hash", digest, "--holder", state.token];
  if (asked.exitCode !== 0 || now === null || answered !== "ready") {
    const why = typeof now?.reason === "string" ? now.reason : "its question could not be read";
    await say($, "fleet: could not reach " + job.name + " (" + why + ")" + opens, timeoutMs);
    if (now === null) {
      // A helper that never answered may have recorded the reply before it
      // stopped; nothing was sent, so it is given back. Finding none is fine.
      await giveBack($, job, marker, false, timeoutMs);
    }
    return;
  }
  // Held from here: replies are open again, a reply that went is recorded as
  // sent, and one that did not gives its question back.
  if (state.paused !== null) {
    state.paused = null;
    $.ui.invalidate("ui.render");
  }
  // A record this pane cleared is gone: a new one is drawn as the reading has it.
  state.cleared = state.cleared.filter((entry) => !entry.startsWith(unread));
  const outcome = { delivered: false };
  try {
    await sendHeld($, state, job, now, text, opens, timeoutMs, outcome);
  } finally {
    if (outcome.delivered) {
      const confirmed = await helper($, ["confirm", job.provider, job.id, ...marker]);
      if (confirmed.exitCode !== 0) {
        await say($, "fleet: sent to " + job.name + ", but it could not be recorded as sent ("
                  + helperWhy(confirmed.exitCode, "the helper refused it") + "); this pane shows it"
                  + " as replied", timeoutMs);
      }
    } else {
      await giveBack($, job, marker, true, timeoutMs);
    }
  }
}

/** Why a helper call did not do what it was asked, in words a toast can carry. */
function helperWhy(exitCode: number, refused: string): string {
  if (exitCode === 1) {
    return refused;
  }
  return exitCode === -1 ? "the helper did not answer" : "the helper exited " + exitCode;
}

/**
 * Give back a reply that did not go, so the question can take one again; a
 * give-back that fails is said, since the row then shows a reply on its way
 * until it reads as maybe not sent. `held` is whether the helper said this pane
 * held it: when it never answered, finding nothing to give back is no failure.
 */
async function giveBack($: Engine, job: Job, marker: string[], held: boolean,
                        timeoutMs: number): Promise<void> {
  const released = await helper($, ["release", job.provider, job.id, ...marker, "--failed"]);
  if (released.exitCode === 0 || (!held && released.exitCode === 1)) {
    return;
  }
  await say($, "fleet: could not give back the reply to " + job.name + " ("
            + helperWhy(released.exitCode, "the helper found no reply of this pane's to give back")
            + "); its row will say it may not have been sent and offer Send again", timeoutMs);
}

/**
 * Forget the sent replies that answer nothing any more, so replies open again.
 *
 * The helper removes only sent markers of jobs that left their home or moved to
 * another question or session, never a pending one; a press that removes none
 * leaves replies paused and says why.
 */
async function clearAnswered($: Engine, state: State): Promise<void> {
  const timeoutMs = state.alerts.toastMs;
  const cleared = await helper($, ["release", "--prune-sent"]);
  let removed = 0;
  try {
    const answer = JSON.parse(cleared.stdout) as { removed?: unknown };
    removed = typeof answer.removed === "number" ? answer.removed : 0;
  } catch {
    removed = 0;
  }
  if (cleared.exitCode !== 0 || removed < 1) {
    const why = cleared.exitCode === 1 || cleared.exitCode === 0
      ? "every recorded reply is still on its way or still answers its question"
      : helperWhy(cleared.exitCode, "");
    await say($, "fleet: no answered reply could be cleared (" + why + "); replies stay paused", timeoutMs);
    return;
  }
  state.paused = null;
  $.ui.invalidate("ui.render");
  await say($, "fleet: cleared " + removed + " answered " + (removed === 1 ? "reply" : "replies")
            + "; replies are open again", timeoutMs);
}

/**
 * Clear a reply that may not have been sent, so the question takes one again.
 *
 * The helper clears only a reply pending past `pane.replyPendingSeconds` and
 * never one recorded as sent, so a press here cannot open a second reply to a
 * question that has one. Cleared, the row offers its field at once; refused, it
 * keeps saying what stands, and the toast says why.
 */
async function resendReply($: Engine, state: State, job: Job): Promise<void> {
  const timeoutMs = state.alerts.toastMs;
  const reply = job.reply;
  if (!reply || reply.state !== "pending" || !job.needs_hash) {
    await say($, "fleet: no unsent reply to " + job.name + " to clear", timeoutMs);
    return;
  }
  const cleared = await helper($, ["release", job.provider, job.id,
                                   ...(job.session_id ? ["--job-session", job.session_id] : []),
                                   "--hash", job.needs_hash, "--stale"]);
  if (cleared.exitCode !== 0) {
    await say($, "fleet: could not clear the reply to " + job.name + " ("
              + helperWhy(cleared.exitCode, "it was sent, or is still on its way")
              + "); nothing was sent", timeoutMs);
    return;
  }
  state.cleared = [...state.cleared, replyKey(job) + "@" + reply.at].slice(-REPLIED_LIMIT);
  $.ui.invalidate("ui.render");
  await say($, "fleet: cleared the reply to " + job.name + " that may not have been sent;"
            + " type it again to send it", timeoutMs);
}

/**
 * Clear a reply's record that does not read, so the question can take a reply.
 *
 * The helper removes the record only when it is there and does not read; one
 * that reads, pending or sent, is never removed this way, so a press here
 * cannot open a second reply to a question with a reply on record. Cleared,
 * the row offers its field at once; refused, it keeps saying what stands.
 */
async function clearUnreadable($: Engine, state: State, job: Job): Promise<void> {
  const timeoutMs = state.alerts.toastMs;
  if (job.reply?.state !== "unreadable" || !job.needs_hash) {
    await say($, "fleet: no unreadable reply record for " + job.name + " to clear", timeoutMs);
    return;
  }
  const cleared = await helper($, ["release", job.provider, job.id,
                                   ...(job.session_id ? ["--job-session", job.session_id] : []),
                                   "--hash", job.needs_hash, "--unreadable"]);
  if (cleared.exitCode !== 0) {
    await say($, "fleet: could not clear the reply record for " + job.name + " ("
              + helperWhy(cleared.exitCode, "it reads now, or is gone") + "); nothing was sent",
              timeoutMs);
    return;
  }
  if (job.reply.id !== null) {
    state.cleared = [...state.cleared, unreadableKey(job, job.reply.id)].slice(-REPLIED_LIMIT);
  }
  $.ui.invalidate("ui.render");
  await say($, "fleet: cleared the reply record for " + job.name + " that could not be read;"
            + " type a reply to send one", timeoutMs);
}

/**
 * The send itself, for a reply this pane holds, checked once more against what
 * the helper read; `outcome` says the host took the message the moment it did.
 */
async function sendHeld($: Engine, state: State, job: Job,
                        now: { needsHash?: unknown; sessionId?: unknown }, text: string,
                        opens: string, timeoutMs: number,
                        outcome: { delivered: boolean }): Promise<void> {
  // From here to the send nothing is awaited except a refusal that returns.
  const destination = typeof now.sessionId === "string" && now.sessionId ? now.sessionId : null;
  if (destination === null || destination !== job.session_id) {
    await say($, "fleet: " + job.name + ": this job's session changed; nothing sent", timeoutMs);
    refresh($, state);
    return;
  }
  if (now.needsHash !== job.needs_hash) {
    await say($, "fleet: " + job.name + " is no longer asking that; nothing was sent, "
              + "and the pane shows its question in a moment", timeoutMs);
    refresh($, state);
    return;
  }
  try {
    const sent = await $.session.send({ to: { sessionId: destination }, text });
    if (!sent.isDelivered) {
      await say($, "fleet: could not reach " + job.name + " (" + sent.reason + ")" + opens, timeoutMs);
      return;
    }
    outcome.delivered = true;
  } catch (error) {
    await say($, "fleet: could not reach " + job.name + " ("
              + (error instanceof Error ? error.message : String(error)) + ")" + opens, timeoutMs);
    return;
  }
  const remembered = replyKey(job);
  const held = state.held;
  const limit = repliedLimitFrom(held !== null && "documents" in held ? held.documents : null);
  const stored: unknown = await $.store.get(REPLIED_KEY).catch(() => undefined);
  const before = Array.isArray(stored)
    ? stored.filter((entry): entry is string => typeof entry === "string") : state.replied;
  state.replied = [...before.filter((entry) => entry !== remembered), remembered].slice(-limit);
  await $.store.set(REPLIED_KEY, state.replied).catch(() => undefined);
  $.ui.invalidate("ui.render");
  // Delivered is a message in its queue, not yet an answer: it may wait there.
  await say($, "fleet: sent to " + job.name + " as a message; if it stays waiting"
            + (job.attach_command ? ", run " + job.attach_command : ", open it"), timeoutMs);
}

/** The presses a pane drawn on `surface` answers, each one run off the paint. */
function paneActions($: Engine, state: State, surface: string): PaneActions {
  return {
    copy: (text, what) => { void copyLine($, state, surface, text, what).catch(() => undefined); },
    refuse: (why) => {
      void Promise.resolve()
        .then(() => say($, "fleet: " + why, state.alerts.copyToastMs))
        .catch(() => undefined);
    },
    reply: (job, typed) => { void sendReply($, state, job, typed).catch(() => undefined); },
    resend: (job) => { void resendReply($, state, job).catch(() => undefined); },
    clearAnswered: () => { void clearAnswered($, state).catch(() => undefined); },
    clearUnreadable: (job) => { void clearUnreadable($, state, job).catch(() => undefined); },
  };
}

/**
 * How many items the band holds that a person dismissed from it: the ones a
 * reading still names, since a dismissal of something long gone hides nothing.
 */
function hiddenCount(state: State, documents: unknown, at: number): number {
  if (!state.hidden.length || !isReading(documents as ReaderDocuments | null)) {
    return 0;
  }
  const live = new Set(bandItems(snapshotFrom(documents as ReaderDocuments, at), [],
                                 state.sessionId).map((item) => item.key));
  return state.hidden.filter((key) => live.has(key)).length;
}

/**
 * Ask which terminal the session runs in, and which tab, once, at startup.
 *
 * The tab is what sessions sharing it key their shared record by: inside tmux
 * the terminal tmux's client draws on, since every pane of one tmux window
 * shows in one tab; outside it iTerm's own session identifier. A tab neither
 * names is this session's alone.
 *
 * Never throws: an engine that cannot read the environment leaves the terminal
 * unknown, and an unknown terminal is never written to.
 */
async function detectTerminal($: Engine, state: State): Promise<void> {
  try {
    const env = { termProgram: await $.env.get("TERM_PROGRAM"),
                  lcTerminal: await $.env.get("LC_TERMINAL"),
                  tmux: await $.env.get("TMUX") };
    const plain = tabTerminal(env, false);
    if (!plain.tmux || !tabTerminal(env, true).supported) {
      // Outside tmux, or inside it around a terminal that draws no tab color
      // either way: tmux need not be asked.
      state.terminal = plain;
    } else {
      // iTerm around tmux: the tint reaches iTerm only when tmux passes it on.
      const shown = await $.process.run(["tmux", "show-options", "-gqv", "allow-passthrough"],
                                        { timeoutMs: state.alerts.tabCommandMs })
        .catch(() => null);
      state.terminal = tabTerminal(env, shown !== null && shown.exitCode === 0
                                         && passesThrough(shown.stdout));
    }
    if (state.terminal.supported) {
      state.tabId = await tabIdentity($, state, state.terminal.tmux);
    }
  } catch {
    state.terminal = null;
  }
  // A reading that landed while this was asked is tinted now.
  void tint($, state);
}

/** What names the tab this session draws in, or null when nothing does. */
async function tabIdentity($: Engine, state: State, tmux: boolean): Promise<string | null> {
  if (tmux) {
    const client = await $.process.run(["tmux", "display-message", "-p", "#{client_tty}"],
                                       { timeoutMs: state.alerts.tabCommandMs })
      .catch(() => null);
    const tty = client !== null && client.exitCode === 0 ? client.stdout.trim() : "";
    return tty === "" ? null : "tmux:" + tty;
  }
  const iterm = await $.env.get("ITERM_SESSION_ID");
  return typeof iterm === "string" && iterm !== "" ? "iterm:" + iterm : null;
}

/** Tell the helper something about the tab; true when it exited 0, never a throw. */
async function runTab($: Engine, state: State, words: string[]): Promise<boolean> {
  try {
    const run = await runEntry($, "tab", words, state.alerts.tabCommandMs);
    return run.exitCode === 0;
  } catch {
    return false;
  }
}

/** The tab this session draws in, as the helper keys its record: one nothing names is the session's own. */
function tabName(state: State): string {
  return state.tabId ?? "session:" + state.sessionId;
}

/**
 * The level this session's band puts the tab at, or undefined when it holds no
 * reading: a read that failed says nothing about the fleet, so the entry this
 * session holds stands. The session's own job is left out as the band leaves it.
 */
function ownLevel(state: State): TabLevel | undefined {
  const held = state.held;
  if (held === null || !("documents" in held)
      || !isReading(held.documents as ReaderDocuments | null)) {
    return undefined;
  }
  const snapshot = snapshotFrom(held.documents as ReaderDocuments, held.at);
  return state.alerts.tint.enabled
    ? tabLevel(bandItems(snapshot, state.hidden, state.sessionId)) : null;
}

/** The terminal this session may tell the helper about: one that draws a tab color, in a session with an id to key its entry by. */
function tabTerminalOf(state: State): TabTerminal | null {
  const terminal = state.terminal;
  return terminal !== null && terminal.supported && state.sessionId !== "" ? terminal : null;
}

/** Stop the tab's heartbeat: the session is ending, or its terminal draws no tab color. */
function stopTabBeat(state: State): void {
  state.tabBeat?.cancel();
  state.tabBeat = null;
  state.tabBeatMs = 0;
}

/**
 * Run the tab's heartbeat on its own timer, at a third of the staleness the
 * reading carries, apart from the poll: a look's interval follows the reading's
 * refresh and an open pane, and neither has anything to do with how long the
 * helper keeps an entry. A reading that changes the staleness re-arms it.
 */
function armTabBeat($: Engine, state: State): void {
  const ms = (state.alerts.tint.staleSeconds * 1000) / 3;
  if (state.ended || (state.tabBeat !== null && state.tabBeatMs === ms)) {
    return;
  }
  stopTabBeat(state);
  try {
    state.tabBeatMs = ms;
    state.tabBeat = $.clock.every(ms, () => {
      void tint($, state);
    });
  } catch {
    // No timer: the level is still said whenever a reading moves it.
    state.tabBeat = null;
    state.tabBeatMs = 0;
  }
}

/**
 * Tell the helper this session's level for the tab, after whatever it is
 * telling it now.
 *
 * The helper keeps the tab's record for every session in it, under a lock, and
 * paints the highest live level; this session only says its own, when it moves
 * and on the heartbeat, every third of the staleness. A paint the helper says
 * failed is asked for once more at once.
 */
function tint($: Engine, state: State): Promise<void> {
  if (tabTerminalOf(state) === null) {
    return Promise.resolve();
  }
  armTabBeat($, state);
  return serially(state.tab, async () => {
    const terminal = tabTerminalOf(state);
    const level = ownLevel(state);
    if (terminal === null || level === undefined || state.ended) {
      return;
    }
    const now = (await $.clock.now()) / 1000;
    const mode = nextSend(state.tab, level, now, state.alerts.tint.staleSeconds,
                          state.alerts.tint.enabled);
    if (mode === null) {
      return;
    }
    const words = tabArgs("set", tabName(state), state.sessionId, level, terminal,
                          mode === "record");
    const landed = await runTab($, state, words);
    afterSend(state.tab, level, now, mode, landed);
    if (mode === "paint" && !landed) {
      afterSend(state.tab, level, now, mode, await runTab($, state, words));
    }
  });
}

/**
 * Take this session's entry out of the tab's record as the session ends, and
 * have the helper paint what the other sessions still hold.
 *
 * Told once whatever this session gave up on, since nothing will tell it after.
 */
function untint($: Engine, state: State): Promise<void> {
  if (tabTerminalOf(state) === null) {
    return Promise.resolve();
  }
  return serially(state.tab, async () => {
    const terminal = tabTerminalOf(state);
    if (terminal === null || !endNeeded(state.tab)) {
      return;
    }
    const now = (await $.clock.now()) / 1000;
    const landed = await runTab($, state, tabArgs("end", tabName(state), state.sessionId, null,
                                                  terminal));
    afterSend(state.tab, null, now, "paint", landed);
  });
}

/**
 * Cut the dismissed keys to the limit a reading carries, keeping the newest.
 *
 * Run whenever a reading lands and when the keys are read, so the configured
 * limit holds whichever arrives first. A reading that carries no limit cuts
 * nothing: the declared default is not a reason to drop what a larger
 * configured limit kept.
 */
function limitHidden(state: State, documents: unknown): void {
  const limit = hiddenLimitFrom(documents);
  if (limit !== null && state.hidden.length > limit) {
    state.hidden = state.hidden.slice(-limit);
  }
}

/** Run the alerts helper; never throws, and a failure reads as a refusal. */
async function helper($: Engine, args: string[], timeoutMs = 10_000) {
  try {
    return await runEntry($, "alerts", args, timeoutMs);
  } catch {
    return { exitCode: -1, stdout: "", stderr: "" };
  }
}

/**
 * Look at the shared reading on an interval, drawn or not.
 *
 * The band and the pane look when they paint, and a session that is not being
 * looked at does not paint, so without this a job that blocks while the person
 * is away would wait for their return to be announced. A look that finds
 * nothing new draws nothing, so a pane at rest is not painted by it.
 */
function arm($: Engine, state: State): void {
  if (state.ended) {
    return;
  }
  // A session with nobody at the prompt looks at nothing on a timer.
  if (!state.interactive) {
    return;
  }
  const held = state.held;
  const live = state.open && held !== null && "documents" in held && liveRuns(held.documents);
  const ms = live ? Math.min(state.alerts.snapshotMs, state.alerts.progressMs)
    : state.alerts.snapshotMs;
  if (state.timer !== null && state.timerMs === ms) {
    return;
  }
  try {
    state.timer?.cancel();
    state.timerMs = ms;
    state.timer = $.clock.every(ms, () => refresh($, state));
  } catch {
    // No timer: the reading stays as fresh as the paints keep it.
    state.timer = null;
  }
}

/** Raise what is new in a fresh reading: a toast here, a notification and the voice once per machine. */
async function raise($: Engine, state: State, documents: ReaderDocuments, at: number) {
  // Without this session's identifier its own job would be news to it; the
  // first reading after it lands is the one that starts the record.
  if (state.sessionId === "") {
    return;
  }
  const { fresh, seen } = newEvents(state.seen, snapshotFrom(documents, at), state.sessionId);
  state.seen = seen;
  for (const event of fresh) {
    await alert($, state, event).catch(() => undefined);
  }
}

async function alert($: Engine, state: State, event: FleetEvent) {
  const config = state.alerts;
  // A toast belongs in the session the person is typing in, not every one open.
  if (config.toast && (await helper($, ["focused", state.sessionId])).exitCode === 0) {
    void say($, "fleet: " + event.text, config.toastMs).catch(() => undefined);
  }
  if (!config.notify || !state.notify) {
    return;
  }
  if ((await helper($, ["claim", event.key])).exitCode !== 0) {
    return;
  }
  await $.ui.notify(mask(event.text).text, { title: "fleet" }).catch(() => undefined);
  // Said aloud by the one session that took the claim, so the machine says it
  // once. Not awaited: a voice that is slow must not hold up the next alert.
  if (event.spoken !== undefined) {
    const spoken = event.spoken;
    void voiced($, state).then((setting) => setting?.isOn ? speak($, state, spoken, setting) : null)
      .catch(() => undefined);
  }
}

/**
 * Whether speech is on in every session, read from the store each time.
 *
 * A store that cannot be read is off, so a fault is silence rather than a voice
 * nobody can stop. A change redraws the band, so its word follows a press in
 * another session, and speech going off stops the clip playing here.
 */
async function speechOn($: Engine, state: State): Promise<boolean> {
  const isOn = speechIsOn(await $.store.get(SPEECH_ON_KEY).catch(() => undefined), state.startedAt);
  heard($, state, isOn);
  return isOn;
}

/**
 * Take in how speech stands, and redraw a word that changed.
 *
 * Off is a hard stop: the clip playing stops, and every line asked for before
 * it is dropped, waiting or being made, even when speech is on again by the
 * time its turn comes. The queue starts over, so a line asked for after it
 * waits behind nothing that was dropped.
 */
function heard($: Engine, state: State, isOn: boolean): void {
  if (!isOn) {
    state.playing?.abort();
    state.speechEpoch += 1;
    state.voiceQueue = Promise.resolve();
  }
  // The band draws an unread switch as off, so learning that it is off is no
  // reason to draw again.
  const drawn = state.speechOn === true;
  state.speechOn = isOn;
  if (isOn !== drawn) {
    $.ui.invalidate("ui.render");
  }
}

/** Follow the switch: read it now, and again on an interval, for a press in another session. */
function followSpeech($: Engine, state: State): void {
  void speechOn($, state).catch(() => undefined);
  try {
    state.speechTimer?.cancel();
    state.speechTimer = $.clock.every(SPEECH_POLL_MS, () => {
      void speechOn($, state).catch(() => undefined);
    });
  } catch {
    // No timer: the band's word follows this session's own presses and alerts.
    state.speechTimer = null;
  }
}

/** Switch speech on or off in every session, from this one. */
async function switchSpeech($: Engine, state: State, isOn: boolean): Promise<void> {
  heard($, state, isOn);
  await $.store.set(SPEECH_ON_KEY, isOn ? await $.clock.now() : false);
}

/**
 * What speech is on this machine and the voice this session picked, with
 * whether speech is on now. The voices are asked once; the session's pick is
 * read once its identifier is known, from its own key, else from the pick kept
 * before picks were each session's own.
 */
async function voiced($: Engine, state: State): Promise<VoiceSetting | null> {
  if (state.speech === null) {
    const info = speechInfo((await helper($, ["voices"])).stdout);
    if (info === null) {
      return null;
    }
    state.speech = info;
  }
  if (state.voice === null || state.voiceFor !== state.sessionId) {
    const own = state.sessionId === "" ? undefined
      : await $.store.get(sessionVoiceKey(state.sessionId)).catch(() => undefined);
    const stored = own ?? await $.store.get(VOICE_KEY).catch(() => undefined);
    state.voice = voiceSetting(stored, state.speech);
    state.voiceFor = state.sessionId;
  }
  const isOn = await speechOn($, state);
  return state.speech.state === "ready" ? { ...state.voice, isOn } : null;
}

/** Say a line after whatever this session is saying now, never over it. */
function speak($: Engine, state: State, text: string | ((voice: string) => string),
               setting: VoiceSetting, generation = state.voiceSelection,
): Promise<{ voice: string | null; reason: string | null }> {
  // The pick a line belongs to is the one standing when the line is asked
  // for, not when its turn comes: a pick made while it waits is newer. So is
  // the switch: a line asked for before speech went off is never said.
  const epoch = state.speechEpoch;
  const turn = state.voiceQueue.then(() => sayNow($, state, text, setting, generation, epoch));
  state.voiceQueue = turn.catch(() => undefined);
  return turn;
}

/** Say hello in this session's voice once speech is on, or say why it could not. */
function greet($: Engine, state: State): void {
  void voiced($, state).then(async (setting) => {
    if (setting === null) {
      await say($, "fleet: " + voiceReply(null, state.speech?.reason ?? null),
                state.alerts.toastMs);
      return;
    }
    if (!setting.isOn) {
      return;
    }
    const spoke = await speak($, state, (voice) => "Speech is on. It's " + firstName(voice) + ".",
                              setting);
    if (spoke.voice === null) {
      await say($, "fleet: " + voiceReply(null, spoke.reason), state.alerts.toastMs);
    }
  }).catch(() => undefined);
}

/**
 * Say a line, trying the voice that spoke last first, then the rest of the group.
 *
 * The helper synthesizes to a file, waiting for the machine's voice to be free,
 * and the engine plays its bytes; the file is discarded whatever happens. The
 * switch is read before each synthesis and again before the clip plays, since a
 * synthesis takes seconds and speech may go off while it runs. Resolves the
 * voice that spoke, or why none did.
 */
async function sayNow($: Engine, state: State, text: string | ((voice: string) => string),
                      setting: VoiceSetting, generation: number, epoch: number,
): Promise<{ voice: string | null; reason: string | null }> {
  const info = state.speech;
  if (info === null) {
    return { voice: null, reason: "speech has not been read" };
  }
  let reason: string | null = null;
  for (const voice of voiceOrder(setting, state.voiceName, info.voices)) {
    if (!(await speechOn($, state)) || state.speechEpoch !== epoch) {
      return { voice: null, reason: "speech is off" };
    }
    const line = typeof text === "string" ? text : text(voice);
    const run = await helper($, ["speak", "--voice=" + voice, "--", line],
                             state.alerts.synthesisMs + 5_000);
    let file: string | null = null;
    try {
      const answer = JSON.parse(run.stdout) as { file?: unknown; reason?: unknown };
      file = typeof answer.file === "string" ? answer.file : null;
      reason = typeof answer.reason === "string" ? answer.reason : reason;
    } catch {
      reason = "the voice helper did not answer";
    }
    if (file === null) {
      continue;
    }
    const stop = new AbortController();
    try {
      if (!(await speechOn($, state)) || state.speechEpoch !== epoch) {
        return { voice: null, reason: "speech is off" };
      }
      const { base64 } = await $.fs.read(file, { as: "bytes" });
      state.playing = stop;
      await $.audio.play({ base64, mime: "audio/wav" }, { signal: stop.signal });
      if (stop.signal.aborted) {
        return { voice: null, reason: "speech is off" };
      }
      // Only when no voice was picked while this line was made and played: the
      // pick is the newer word, and the next line tries it first.
      if (state.voiceSelection === generation) {
        state.voiceName = voice;
      }
      return { voice, reason: null };
    } catch (error) {
      // A clip stopped by the switch is not a voice that failed: no other voice
      // is tried in its place.
      if (stop.signal.aborted) {
        return { voice: null, reason: "speech is off" };
      }
      reason = "the clip did not play: " + (error instanceof Error ? error.message : String(error));
    } finally {
      if (state.playing === stop) {
        state.playing = null;
      }
      await helper($, ["discard", file]);
    }
  }
  return { voice: null, reason };
}

/** The pane's keys as the reading this session holds resolves them, or the packaged ones. */
function currentKeys(state: State, now: number): PaneOptions["keys"] {
  const held = state.held !== null && "documents" in state.held ? state.held : null;
  return paneOptions(0, now, paneConfigFrom(held?.documents)).keys;
}

/** The pane's options with the person's own word on the tips taken in. */
function withTipsWord(state: State, options: PaneOptions): PaneOptions {
  return { ...options, keys: { ...options.keys,
                               tipsEnabled: tipsShown(options.keys.tipsEnabled, state.tipsWord) } };
}

/** The tips the hint line rotates through now: none when either answer is off. */
function tipsNow(state: State, now: number): string[] {
  const keys = currentKeys(state, now);
  return tipsShown(keys.tipsEnabled, state.tipsWord) ? keys.tips : [];
}

/** Stop moving the key tip on: no draft, no tips, or no session. */
function stopTips(state: State): void {
  state.tipTimer?.cancel();
  state.tipTimer = null;
  state.tipMs = 0;
}

/**
 * Move the key tip on every `refresh.keyTipMs` while a draft is typed.
 *
 * Started by the hint line's paint and stopped by the first paint without a
 * draft, so a prompt at rest runs no timer at all.
 */
function armTips($: Engine, state: State): void {
  const ms = state.alerts.keyTipMs;
  if (state.ended || (state.tipTimer !== null && state.tipMs === ms)) {
    return;
  }
  stopTips(state);
  try {
    state.tipMs = ms;
    state.tipTimer = $.clock.every(ms, () => {
      state.tipTurn += 1;
      $.ui.invalidate("ui.render");
    });
  } catch {
    // No timer: the tip stands where it is.
    state.tipTimer = null;
    state.tipMs = 0;
  }
}

/** The heading a section is named by in the commands that open the pane on it. */
const ONE_SECTION_TITLES: Record<string, string> = { worktrees: "Worktrees", keys: "Keys" };

/**
 * Open the pane on one section, or close it when it is already open on that one.
 *
 * Every other section is folded, so the one asked for is in view without
 * scrolling, and the folds are kept as a press keeps them: a person who left the
 * pane on Worktrees finds it there in the next session. A second run, with the
 * pane open and the section unfolded, closes the pane, the way `/fleet` does.
 */
async function openOn($: Engine, state: State, section: string): Promise<{ text: string }> {
  const title = ONE_SECTION_TITLES[section] ?? section;
  const now = (await $.clock.now()) / 1000;
  const held = state.held !== null && "documents" in state.held ? state.held : null;
  const pane = paneConfigFrom(held?.documents);
  const names = sectionNames(pane);
  if (!names.includes(section)) {
    return { text: `The fleet pane draws no ${title} section: the configuration leaves it out `
      + `of pane.sectionOrder (${MARK}).` };
  }
  // A section the configuration hides draws nothing however it is folded, so
  // folding the rest around it would open an empty pane and keep that fold.
  if (pane?.sections[section]?.visible === false) {
    return { text: `The fleet pane hides its ${title} section: set pane.sections.${section}.visible `
      + `to true to show it (${MARK}).` };
  }
  const isOpen = await $.ui.panes()
    .then((panes) => panes.some((drawn) => drawn.id === PANE), () => state.open);
  const drawn = foldDrawn(state.pressed, startFolded(0, now, pane), names);
  if (isOpen && drawn[section] === false) {
    state.open = false;
    markSeen($, state);
    // A probe asked for by the run that opened it is not wanted once it is shut.
    state.freshAsked = false;
    await $.ui.close({ id: PANE });
    $.ui.invalidate("ui.render");
    return { text: `Fleet pane closed (${MARK}).` };
  }
  state.pressed = { ...state.pressed,
                    ...Object.fromEntries(names.map((name) => [name, name !== section])) };
  keepFold($, state, names);
  state.open = true;
  const opened = await $.ui.open({ id: PANE, title: `Fleet (${MARK})`, closeOnEscape: true });
  $.ui.invalidate("ui.render");
  return { text: opened.isPlaced ? `Fleet pane opened on ${title} (${MARK}).`
    : `Fleet pane opens on ${title} once the terminal is wider (${MARK}).` };
}

/**
 * One `/speak`, run after every pick asked for before it.
 *
 * A pick takes its number before anything is awaited, and picks run one at a
 * time on one chain, so two never interleave. Each write, to this session and
 * to the store, is made only while the pick is still the newest: a pick a
 * newer one overtook while it waited writes nothing and greets nobody.
 * Resolves the reply, or the greeting to wait for, which is said on the voice
 * queue and so is not waited for on the chain.
 */
async function selectVoice($: Engine, state: State, args: string, generation: number): Promise<
  { text: string } | { greeting: Promise<{ voice: string | null; reason: string | null }> }> {
  const newest = () => generation === state.voiceSelection;
  const overtaken = { text: "A newer /speak pick replaced this one. " + SPEAK_USAGE };
  const current = await voiced($, state).catch(() => null) ?? state.voice;
  const info = state.speech;
  if (info === null || current === null) {
    return { text: info === null ? "Fleet could not read its voices. " + SPEAK_USAGE
      : speakStatus(state.voice ?? voiceSetting(undefined, info), state.voiceName, info) };
  }
  const asked = speakRequest(args, current, info.voices);
  if (asked === null) {
    return { text: SPEAK_USAGE };
  }
  if (asked === "list") {
    return { text: voiceList(current, state.voiceName, info.voices) };
  }
  if (asked === "status") {
    return { text: speakStatus(current, state.voiceName, info) };
  }
  if (!newest()) {
    return overtaken;
  }
  if (asked.voice !== current.voice) {
    state.voiceName = null;
  }
  if (asked.name !== undefined) {
    state.voiceName = asked.name;
  }
  // The voice is this session's; on and off are every session's.
  const choice = { voice: asked.voice, ...(asked.name !== undefined ? { name: asked.name } : {}) };
  state.voice = { isOn: asked.isOn, ...choice };
  if (state.sessionId !== "") {
    await $.store.set(sessionVoiceKey(state.sessionId), choice).catch(() => undefined);
  }
  if (asked.isOn !== current.isOn) {
    if (!newest()) {
      return overtaken;
    }
    const switched = await switchSpeech($, state, asked.isOn).then(() => true, () => false);
    if (!switched) {
      return { text: "Fleet could not switch speech: the store refused it. " + SPEAK_USAGE };
    }
  }
  if (!asked.isOn) {
    return { text: "Speech is off in every session. Alerts still show; "
      + "/speak on or the band's Speak button brings it back." };
  }
  if (!newest()) {
    return overtaken;
  }
  return { greeting: speak($, state,
                           (voice) => "Hi, it's " + firstName(voice)
                             + ". I'll let you know when a job needs you.", asked) };
}

export const register: Register = (on, options) => {
  launch = launchFrom(options);
  const state: State = { held: null, looking: false, readingWhole: false, counting: false, hydrated: false, pressed: {},
                         restored: false, shownAll: {}, shownAllRestored: false,
                         focus: null, details: {},
                         hidden: [], replied: [], replying: new Set(), cleared: [],
                         paused: null,
                         sessionId: "", sessionIdRead: "", open: false,
                         seen: null, alerts: ALERT_DEFAULTS, timesKnown: false, notify: options?.notify !== false,
                         speech: null, voice: null, voiceName: null, voiceSelection: 0, voiceFor: "",
                         speechOn: null, playing: null, voiceQueue: Promise.resolve(),
                         startedAt: null, speechEpoch: 0,
                         voicePicks: Promise.resolve(),
                         speechTimer: null, timer: null, timerMs: 0, ended: false,
                         token: Math.random().toString(36).slice(2),
                         engineSession: null, measuring: false, measured: false,
                         motion: motionMemory(), frames: null, framed: 0,
                         shown: null, shownFrom: undefined, shownCountsAt: undefined, streamTimer: null, streamQueue: [],
                         clock: null, clockMs: 0,
                         interactive: true, freshAsked: false, terminal: null,
                         tab: tabSender(), tabBeat: null, tabBeatMs: 0, tabId: null, tipsWord: undefined, tipsSet: false, tipTurn: 0, tipTimer: null,
                         tipMs: 0, foldSaves: Promise.resolve(), foldToast: false,
                         foldsLoaded: false, foldsDirty: false, foldsPending: {}, foldWrites: Promise.resolve(),
                         foldRestore: Promise.resolve(),
                         lastSeen: undefined, seenAsked: false, digestThrough: null,
                         seenWrite: Promise.resolve(), afterPaint: [], afterPaintTick: null };
  on("session.start", async ($, event, next) => {
    // Taken first, so speech is off here until a press made from now on; a
    // clock that cannot say leaves it off for the whole session.
    state.startedAt = await $.clock.now().catch(() => null);
    await $.command.register({
      name: "fleet",
      description: "Background jobs, trials and PRs across this machine, in a pane",
      argumentHint: "[close|unhide|doctor|setup]",
      immediate: true,
    });
    await $.command.register({
      name: "speak",
      description: "Pick this session's voice, or switch speech on or off in every session",
      argumentHint: "[on|off|female|male|list|<voice>]",
      immediate: true,
    });
    await $.command.register({
      name: "worktrees",
      description: "Open the fleet pane on Worktrees, probed now; run again to close it",
      immediate: true,
    });
    await $.command.register({
      name: "keys",
      description: "Open the fleet pane on Keys, or switch the key tip under the prompt",
      argumentHint: "[tips off|on]",
      immediate: true,
    });
    // A `-p` run or an SDK host has nobody at the prompt: no pane, no band and
    // no tab to show anything in, so it starts no timer and reads nothing on its
    // own. The commands stay, since a command run there is a person asking.
    state.interactive = event.isInteractive !== false;
    if (state.interactive) {
      // The first look starts with the session, so the pane has something to
      // draw the moment it is opened, and the looks go on from here.
      refresh($, state);
      arm($, state);
    }
    restoreFold($, state);
    restoreShownAll($, state);
    rememberBand($, state);
    if (state.interactive) {
      followSpeech($, state);
      void detectTerminal($, state);
      try {
        void $.store.get(TIPS_KEY).then((word) => {
          // `/keys tips` run while this read was out is newer than what it read.
          if (state.tipsSet) {
            return;
          }
          state.tipsWord = word;
          if (word === false) {
            $.ui.invalidate("ui.render");
          }
        }).catch(() => undefined);
      } catch {
        // No store: the configuration alone decides the tips.
      }
    }
    // The engine's own startup result is what a session.start hook returns. A
    // hook that answers with a value of its own is skipped, and the command it
    // registered with it is skipped too.
    return next(event);
  });

  // The session the person types in is the one toasts go to. Not awaited: a
  // prompt never waits on the fleet.
  on("prompt.submit", async ($, event, next) => {
    // A -p run or an SDK host has nobody typing in it: it is never the session
    // toasts go to, and it writes no focus every session reads.
    if (state.sessionId !== "" && state.interactive) {
      void helper($, ["focus", state.sessionId]);
    }
    // A prompt is not a paint, so what a paint left waiting is written here
    // too, which is all that writes it where the host gives no clock.
    drainAfterPaint(state);
    return next(event);
  });

  on("session.end", async ($, event, next) => {
    // Written before the timers stop, so nothing a paint asked for is lost.
    drainAfterPaint(state);
    state.ended = true;
    state.timer?.cancel();
    state.timer = null;
    state.speechTimer?.cancel();
    state.speechTimer = null;
    stopFrames(state);
    stopStream(state);
    state.clock?.cancel();
    state.clock = null;
    stopTips(state);
    stopTabBeat(state);
    // The tab gets its own color back before the session lets go of it. The
    // helper is bounded by its own timeout, so an end is never held for long.
    // The folds and the last look still being written land before the end
    // does, for as long as `END_WRITES_MS` allows.
    await Promise.all([
      untint($, state).catch(() => undefined),
      writesLanded($, state),
    ]);
    return next(event);
  });

  on("command.run", { command: "worktrees" }, async ($) => {
    const answer = await openOn($, state, "worktrees");
    // Opened, the worktrees are probed on the next look, within one look's
    // interval: a person who asks for them is asking how they stand, not how
    // they stood at the last cached probe. The pane opens on the reading it
    // holds meanwhile. Not started here: a probe takes seconds per worktree,
    // longer than the host lets the command's own work run (see readFresh).
    if (state.open) {
      state.freshAsked = true;
    }
    return answer;
  });

  on("command.run", { command: "keys" }, async ($, event) => {
    const asked = keysRequest(event.args ?? "");
    if (asked === null) {
      return { text: KEYS_USAGE };
    }
    if (asked === "open") {
      return openOn($, state, "keys");
    }
    state.tipsWord = asked.tips;
    state.tipsSet = true;
    if (!asked.tips) {
      stopTips(state);
    }
    $.ui.invalidate("ui.render");
    const word = asked.tips ? "on" : "off";
    const saved = await $.store.set(TIPS_KEY, asked.tips).then(() => true, () => false);
    if (!saved) {
      return { text: `Key tips ${word} for this session; the store refused the preference, `
        + `so the next session will not keep it (${MARK}).` };
    }
    if (asked.tips && !currentKeys(state, (await $.clock.now()) / 1000).tipsEnabled) {
      return { text: `Key tips on, but the configuration turns them off (keys.tipsEnabled), `
        + `so none show (${MARK}).` };
    }
    return { text: `Key tips ${word} (${MARK}).` };
  });

  // The key tip after the hint line, while a draft is typed: the tips the pane's
  // Keys section lists, one at a time. Anything else leaves the line as it is.
  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const tips = state.interactive && e.props.isDraft
      ? tipsNow(state, (await $.clock.now()) / 1000) : [];
    const tip = tipAt(tips, state.tipTurn);
    if (tip === null) {
      stopTips(state);
      return next(e);
    }
    armTips($, state);
    return next({ ...e, props: { ...e.props, tail: withTip(e.props.tail, tip) } });
  });

  on("command.run", { command: "speak" }, async ($, event) => {
    // Asking how speech stands, or for the list, is not a pick: it is answered
    // at once and waits for no pick.
    const args = event.args ?? "";
    const picks = !/^\s*(list)?\s*$/i.test(args);
    const generation = picks ? ++state.voiceSelection : state.voiceSelection;
    let answer: Awaited<ReturnType<typeof selectVoice>>;
    if (picks) {
      const turn = state.voicePicks.then(() => selectVoice($, state, args, generation));
      state.voicePicks = turn.catch(() => undefined);
      answer = await turn;
    } else {
      answer = await selectVoice($, state, args, generation);
    }
    if ("text" in answer) {
      return answer;
    }
    const spoke = await answer.greeting;
    return { text: voiceReply(spoke.voice, spoke.reason) };
  });

  on("command.run", { command: "fleet" }, async ($, event) => {
    // What a person dismissed from the band comes back, here and in the store,
    // so the next session draws it too.
    const asked = (event.args ?? "").trim();
    if (asked === "doctor" || asked === "setup") {
      return { text: await askEntry($, state, asked) };
    }
    if (asked === "unhide") {
      const count = state.hidden.length;
      state.hidden = [];
      await $.store.set(HIDDEN_KEY, []).catch(() => undefined);
      $.ui.invalidate("ui.render");
      // What came back may need the person, so the tab follows the band. Waited
      // for, since a write the command left running is the command's own work.
      await tint($, state);
      return { text: `${count} dismissed band item${count === 1 ? "" : "s"} shown again (${MARK}).` };
    }
    // The pane is open and closed by the same word, so it follows the band's
    // switch; `close` only closes. The band is asked to draw again either way,
    // so its switch says which way the command went.
    const isOpen = (await $.ui.panes()).some((pane) => pane.id === PANE);
    state.open = asked === "close" ? false : !isOpen;
    if (!state.open) {
      markSeen($, state);
      await $.ui.close({ id: PANE });
      $.ui.invalidate("ui.render");
      return { text: `Fleet pane closed (${MARK}).` };
    }
    const opened = await $.ui.open({ id: PANE, title: `Fleet (${MARK})`, closeOnEscape: true });
    $.ui.invalidate("ui.render");
    // A surface too narrow to draw the pane opens once the terminal is wider.
    return { text: opened.isPlaced ? `Fleet pane opened (${MARK}).`
                          : `Fleet pane opens once the terminal is wider (${MARK}).` };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const primitives = bindPrimitives($.ui.resolve(e) as unknown as HostElements, e.surface);
    const now = (await $.clock.now()) / 1000;
    // A pane opened on the reading the last session left has had no read to
    // ask alongside, so its first paint asks for this session's figures itself.
    if (state.engineSession === null && !state.measured) {
      try {
        measure($, state);
      } catch {
        // No session figures: the reading's document stands.
      }
    }
    // The width is the surface's minus the columns the configuration reserves
    // for what it draws around the pane, floored at the width below which the
    // configuration says the pane cannot be drawn. Both numbers are declared and
    // both were literals here, which is a pane drawing at a width nobody chose.
    const held = state.held !== null && !("reason" in state.held) ? state.held : null;
    const geometry = paneConfigFrom(held?.documents)?.geometry ?? GEOMETRY;
    // The one press a pane drawn without a reading answers: the close control.
    const closer = (element: string): void => {
      if (element === CLOSE) {
        state.open = false;
        markSeen($, state);
        void $.ui.close({ id: PANE })
          .then(() => $.ui.invalidate("ui.render"))
          .catch(() => undefined);
      }
    };
    const width = Math.max(geometry.minimumColumns,
                           e.props.bodyColumns - geometry.horizontalReserve);
    // Nothing is awaited here: a paint answers from what it holds. A reading
    // that failed goes stale like any other, so a machine that keeps refusing
    // is asked again on the same interval rather than on every paint.
    if (state.held === null) {
      if (state.hydrated) {
        refresh($, state, "paint");
      } else {
        // Nothing to draw, and this process has not yet looked for what the last
        // one left. The read waits for that look: one started here would race
        // the store for what the next paint draws, and the store is the cheaper
        // answer while the read is only the fresher one. A store holding nothing
        // starts the read itself.
        hydrate($, state);
      }
      // A read still in flight, named as such: never an empty fleet.
      return surfaceTree({ documents: null, width, now, onPress: closer }, primitives);
    }
    // Too old to draw as current, and too new to be true: a reading dated ahead
    // of this clock makes every age negative, and one that never ages is held
    // for the whole session while the machine moves under it. The store crosses
    // process boundaries, so its timestamp is another session's clock.
    const age = now - state.held.at;
    if (age > state.alerts.snapshotSeconds || age < 0) {
      refresh($, state, "paint");
    }
    if ("reason" in state.held) {
      return surfaceTree({ documents: null, width, now, reason: state.held.reason,
                           onPress: closer }, primitives);
    }
    // What the pane's own configuration resolves to, read off the reading: it
    // travels with the reading because a plugin has no file of its own to read.
    // A reading that carries none is one from before this existed, and the
    // packaged default is what it draws.
    const pane = paneConfigFrom(state.held.documents);
    const names = sectionNames(pane);
    // What the configuration starts each section at, recomputed from the reading
    // this paint is drawing: a fresh reading brings its own configuration, and a
    // fold taken from the first one the pane ever saw would go on deciding the
    // layout after the reading that said so had been replaced.
    const configured = startFolded(width, now, pane);
    // Asked for once, and drawn from what is held until it lands: a paint that
    // waited on the host would be a pane drawn empty while it waited.
    restoreFold($, state);
    restoreShownAll($, state);
    // The digest's last look, asked for once per opening and drawn once it lands.
    restoreSeen($, state);
    const drawnFolds = foldDrawn(state.pressed, configured, names);
    // Drawn while open, so the ages on it count between readings.
    keepTime($, state);
    const shown = streamed($, state, state.held);
    // The age drawn beside the counts is the reading's, not this paint's: a
    // reading carried over from the last session is that old, and a reading
    // whose own clock is missing is still no newer than when it was read.
    return surfaceTree({ documents: withSession(shown, state.engineSession) as never,
                         width, now,
                         takenAt: state.held.at,
                         transform: (drawn: Pane) => {
                           // What the digest drew is what closing the pane marks seen.
                           const through = drawn.digest?.through ?? null;
                           if (through !== null) {
                             state.digestThrough = Math.max(state.digestThrough ?? through, through);
                           }
                           return moved($, state, drawn, now * 1000);
                         },
                         onPress: (element: string) => {
                           // The host runs this in the plugin's environment when
                           // a button is pressed, which is how the pane hears
                           // about it. The close control is the one press that
                           // does not change what is drawn but ends it, so it is
                           // answered here rather than falling through to the
                           // fold, which would report it as a press on nothing.
                           if (element === CLOSE) {
                             closer(element);
                             return;
                           }
                           // Nothing about the pane changed unless the press
                           // named a control it drew, so only then is it asked to
                           // draw again.
                           // A section's "show all rows" control raises its
                           // ceiling for the rest of the session, and stands
                           // against a later reading the same way a fold does.
                           if (element.startsWith(SHOW_ALL_PREFIX)) {
                             const name = element.slice(SHOW_ALL_PREFIX.length);
                             if (names.includes(name) && state.shownAll[name] !== true) {
                               state.shownAll = { ...state.shownAll, [name]: true };
                               $.state.set(SHOWN_ALL, state.shownAll).catch(() => undefined);
                               $.ui.invalidate("ui.render");
                             }
                             return;
                           }
                           // A press on a headline figure narrows the pane to the
                           // rows it counted, and the same press widens it again:
                           // the figure is a toggle a person can see the state of
                           // in the line under the controls.
                           if (element === FOCUS_CLEAR) {
                             if (state.focus !== null) {
                               state.focus = null;
                               $.ui.invalidate("ui.render");
                             }
                             return;
                           }
                           if (element.startsWith(FOCUS_PREFIX)) {
                             const which = element.slice(FOCUS_PREFIX.length);
                             const known: Focus[] = ["working", "waiting", "failed"];
                             const next = known.find((name) => name === which) ?? null;
                             const wanted = next !== null && next !== state.focus ? next : null;
                             if (wanted !== state.focus) {
                               state.focus = wanted;
                               $.ui.invalidate("ui.render");
                             }
                             return;
                           }
                           // A press on a row's figures opens the rest of what the
                           // row knows, and the same press closes it.
                           if (element.startsWith(DETAILS_PREFIX)) {
                             const id = element.slice(DETAILS_PREFIX.length);
                             if (id !== "") {
                               const open = { ...state.details };
                               if (open[id] === true) {
                                 delete open[id];
                               } else {
                                 open[id] = true;
                               }
                               state.details = open;
                               $.ui.invalidate("ui.render");
                             }
                             return;
                           }
                           const press = folded(state.pressed, configured, element, names);
                           // What the host holds is the presses, so a press is
                           // written whenever it recorded anything at all, even
                           // when every section already drew that way: the press
                           // is the person's last word on those sections, and a
                           // later configuration that disagrees must not walk
                           // over it.
                           if (press.pressed !== state.pressed) {
                             state.pressed = press.pressed;
                             keepFold($, state, press.named);
                           }
                           // Only a press that changed what is drawn asks for a
                           // frame.
                           if (press.changed) {
                             $.ui.invalidate("ui.render");
                           }
                         },
                         options: withTipsWord(state, {
                           ...paneOptions(width, now, pane), folded: drawnFolds,
                           shownAll: state.shownAll,
                           focus: state.focus,
                           details: state.details,
                           countsAt: state.shownCountsAt,
                           actions: paneActions($, state, e.surface),
                           replied: state.replied,
                           replyPendingSeconds: paneNumberFrom(state.held.documents, "replyPendingSeconds",
                                                               REPLY_PENDING_SECONDS),
                           cleared: state.cleared,
                           paused: state.paused,
                           hidden: hiddenCount(state, state.held.documents, state.held.at),
                           fields: drawsFields(e.surface),
                           lastSeen: state.lastSeen }) },
                       primitives);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    // A survey holds the band while it asks; the fleet waits its turn.
    if (e.props.hasSurvey) {
      return next(e);
    }
    const primitives = bindPrimitives($.ui.resolve(e) as unknown as HostElements, e.surface);
    const now = (await $.clock.now()) / 1000;
    // Which way the switch points is the engine's answer when it gives one, and
    // the last press otherwise: a band that threw here would draw no switch at
    // all, which is the one thing it exists to draw.
    const open = await $.ui.panes()
      .then((panes) => panes.some((pane) => pane.id === PANE))
      .catch(() => state.open);
    // Escape closes the pane without a word to the plugin, so a pane found shut
    // that was open at the last answer was closed by the person: what its
    // digest drew is seen.
    if (state.open && !open) {
      markSeen($, state, true);
    }
    state.open = open;
    // The band is on screen for the whole session, so it is what keeps the
    // reading fresh while the pane is shut: the same interval, the same read.
    if (state.held === null) {
      if (state.hydrated) {
        refresh($, state, "paint");
      } else {
        hydrate($, state);
      }
    } else if (now - state.held.at > state.alerts.snapshotSeconds || now - state.held.at < 0) {
      refresh($, state, "paint");
    }
    const held = state.held !== null && "documents" in state.held
      && isReading(state.held.documents as ReaderDocuments | null) ? state.held : null;
    const snapshot = held ? snapshotFrom(held.documents as ReaderDocuments, held.at) : null;
    // How long a waiting job leads the band, and how many dismissals are kept,
    // travel with the reading.
    const band = { ...bandConfigFrom(held ? held.documents : null), now };
    const items = snapshot ? bandItems(snapshot, state.hidden, state.sessionId, band) : [];
    // The band draws states in the pane's tones, so a theme recolors both.
    const theme = paneConfigFrom(held?.documents)?.theme ?? THEME;
    return mount(recolor(bandTree({
      items,
      counts: snapshot ? bandCounts(snapshot, state.sessionId) : null,
      note: snapshot ? "Roster unread" : state.held === null ? "Reading the machine..."
        : "The fleet read failed",
      open,
      width: e.props.bodyColumns,
      surface: e.surface,
      speaking: state.speechOn === true,
      onSpeak: () => {
        // Which way it goes is read from the store at the press, not from the
        // paint: another session may have switched it since this band drew.
        return $.store.get(SPEECH_ON_KEY)
          .then((value) => speechIsOn(value, state.startedAt), () => state.speechOn === true)
          .then(async (wasOn) => {
            await switchSpeech($, state, !wasOn);
            if (!wasOn) {
              greet($, state);
            }
          })
          .catch(() => undefined);
      },
      onToggle: () => {
        // The press runs in the plugin at once, turn or no turn, which is the
        // whole point of the switch; the band redraws to say which way it went.
        //
        // Which way it goes is asked of the engine at the press, not taken from
        // the paint: Escape closes the pane without the band hearing of it, and
        // a press that trusted the paint would close a pane already closed.
        const flip = (isOpen: boolean) => {
          state.open = !isOpen;
          if (isOpen) {
            markSeen($, state);
          }
          $.ui.invalidate("ui.render");
          return isOpen ? $.ui.close({ id: PANE })
            : $.ui.open({ id: PANE, title: `Fleet (${MARK})`, closeOnEscape: true });
        };
        return $.ui.panes()
          .then((panes) => panes.some((pane) => pane.id === PANE), () => open)
          .then(flip)
          // Asked again once the engine has done it, so the word follows the
          // engine's answer rather than the press when the two disagree.
          .then(() => $.ui.invalidate("ui.render"))
          .catch(() => undefined);
      },
      onOpen: (focus?: Focus) => {
        // The band is read while the pane is shut, so a figure here is the
        // moment a person wants its rows: open the pane already narrowed to
        // them, and let the clear control inside widen it.
        state.focus = focus ?? null;
        state.open = true;
        $.ui.invalidate("ui.render");
        return $.ui.open({ id: PANE, title: `Fleet (${MARK})`, closeOnEscape: true })
          .catch(() => undefined);
      },
      onDismiss: () => {
        // A key that names nothing the band could show now hides nothing, so
        // it is let go here rather than kept until the limit pushes it out.
        const current = snapshot
          ? bandItems(snapshot, [], state.sessionId, band).map((item) => item.key) : [];
        // Only a source that answered this reading can say its item has gone;
        // a key from one that failed is kept for when it answers again.
        state.hidden = keptHidden(state.hidden, current, items.map((item) => item.key),
                                  band.hiddenLimit,
                                  snapshot ? answeredSources(snapshot) : new Set<string>());
        void $.store.set(HIDDEN_KEY, state.hidden).catch(() => undefined);
        // What was dismissed no longer needs the person, so the tab follows the band.
        void tint($, state);
        $.ui.invalidate("ui.render");
      },
    }), theme), primitives);
  });
};
