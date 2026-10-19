/**
 * The engine entry, driven by a stub engine.
 *
 * The engine itself cannot be loaded here, so this drives the entry with a stub
 * that implements the declared subset and records what the entry asked for. That
 * is enough to hold the contract the pane depends on: the command is registered,
 * the pane opens and closes, and a render hook answers a paint from what it
 * already holds rather than waiting inside the paint for a process.
 *
 * The stub is built from `engine.ts`'s own types, so an entry that calls the
 * engine in a way this repository has not declared fails to compile against the
 * stub rather than failing in a live session.
 *
 * Run with: node --test components/llm-fleet.test.ts
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";

import { elementTypes, renderedText } from "../plugins/llm-fleet/components/layout.ts";
import { recordingPrimitives } from "../plugins/llm-fleet/components/mount.ts";
import { SECTIONS } from "../plugins/llm-fleet/components/options.ts";
import { AFTER_PAINT_MS, AHEAD_SECONDS, CLAIM_KEY, END_WRITES_MS, COUNTS_KEY, FOLDS_KEY, FRAME_MS, FRESH_WORKTREES, HIDDEN_KEY, LIVE_MS, LOOK_MS,
         MARK, PANE, PROGRESS_CLAIM_KEY, READER, READING_KEY, REPLIED_LIMIT, SPEECH_ON_KEY, SPEECH_POLL_MS,
         SETTINGS_MS, SETTINGS_ONLY, STALE_SECONDS, TAB_HELPER, TIPS_KEY, alertConfigFrom, repliedLimitFrom,
         CLOCK_MS, STREAM_MS, needsSessionRead,
         register } from "../plugins/llm-fleet/hooks/llm-fleet.ts";
import { BAND_DISMISS, BAND_SPEAK, BAND_TOGGLE } from "../plugins/llm-fleet/components/band.ts";
import type { CommandEvent, Engine, Next, On, PromptHintEvent, RenderEvent, StartupEvent }
  from "../plugins/llm-fleet/hooks/engine.ts";

// Every whole read names the session and the model it is drawn for: a routed
// session's spend lives in a file the status line keeps for that session, and
// the read is what prices it.
const READ_ARGV = ["--pretty", "--session", "stub-session", "--model", "stub-model"];

type Calls = {
  commands: string[];
  /** The commands registered to run while a turn streams. */
  immediate: string[];
  opened: string[];
  closed: string[];
  argv: string[][];
  /** The time each process run was given, in the order the runs were asked. */
  runTimeouts: (number | undefined)[];
  /**
   * The time each settings-only read was given. Kept apart from the reads of the
   * machine, so a case counting those counts what it always counted.
   */
  settings: (number | undefined)[];
  /** How every process was started: its command and the variables set over the host's. */
  launches: { argv: string[]; env: Record<string, string> | undefined }[];
  invalidated: string[];
  stored: { key: string; value: unknown }[];
  /** The claims written to read for every session, apart from what was kept. */
  claims: { key: string; value: unknown }[];
  /** What the plugin asked the host to hold for the session. */
  stated: { key: string; value: unknown }[];
  toasts: string[];
  notified: string[];
  played: number;
  /** The signal each clip was played with, so a case can see one stopped. */
  signals: (AbortSignal | undefined)[];
  /** Each interval a timer was started at, and how many timers were stopped. */
  every: number[];
  cancelled: number;
  /** Each timer's interval and the function it runs, so a case can let one fire. */
  timers: { ms: number; fn: () => void; cancelled: boolean }[];
  /** Every key the plugin asked the store for, in order. */
  gets: string[];
  /** How many times the engine was asked for this session's figures. */
  usage: number;
  /** Every store write and claim as it finished, in order, by key and what it wrote. */
  written: { key: string; value: unknown }[];
  /** How long each toast was asked to stay up, in the order they were raised. */
  toastMs: (number | undefined)[];
  /** What a press put on the clipboard, and the surface it named. */
  copied: { text: string; surface?: string }[];
  /** What was sent to another session, and to which. */
  sent: { to: { sessionId: string }; text: string }[];
  /** Every write of the host's values asked for, by key, whether or not it was made. */
  stateSets: string[];
  /** The host's values a paint, or work a paint started, tried to write. */
  refusedInRender: string[];
};

type Stub = {
  engine: Engine;
  calls: Calls;
  render: (columns?: number) => Promise<unknown>;
  start: () => Promise<unknown>;
  run: (args?: string) => Promise<unknown>;
  /** Submits a prompt through the entry's hook, with the engine's own continuation. */
  prompt: (text: string) => Promise<unknown>;
  /** Resolves once the read this entry started has landed. */
  settle: () => Promise<void>;
  /** Resolves once the pane has been asked to draw again, without landing the read. */
  repainted: () => Promise<void>;
  /** Draws until the pane stops asking to be drawn again, and answers that tree. */
  quiesce: (columns?: number) => Promise<unknown>;
  /** Draws the band above the prompt, on a surface a case names. */
  band: (columns?: number, surface?: string) => Promise<unknown>;
  /** Presses a band button, by its address, as the host runs a press. */
  pressBand: (key: string) => Promise<unknown>;
  /** Runs `/speak` with these words. */
  speak: (args?: string) => Promise<unknown>;
  /** Ends the session through the entry's own hook. */
  end: () => Promise<unknown>;
  /** Runs `/worktrees` or `/keys` with these words. */
  command: (name: "worktrees" | "keys", args?: string) => Promise<unknown>;
  /** Draws the hint line under the prompt, and answers the props the engine is handed on. */
  hint: (props: Partial<PromptHintEvent["props"]>) => Promise<unknown>;
  /** Fires every timer started at this interval once. */
  tick: (ms: number) => void;
  /** Moves the clock the entry reads, so an interval can be crossed. */
  advance: (seconds: number) => void;
  /** Presses a control the pane drew, by running the closure the host would. */
  press: (element: string) => Promise<void>;
  /** Submits a field the pane drew, as Enter in it would. */
  type: (element: string, value: string) => Promise<void>;
  /** Evaluates the plugin again over the same host, which is a hot reload. */
  reload: () => void;
  /** Lets a state read this stub held answer, with what stood when it was asked. */
  releaseState: () => void;
};

/** The heading each section draws under, by the section's name. */
const TITLES: Record<string, string> = {
  prs: "Pull requests", sessions: "Background sessions", trials: "Trials", running: "Running",
  session: "This session", worktrees: "Worktrees", skills: "Skills", warnings: "Warnings",
  keys: "Keys", load: "Load", governance: "Governance",
};
/**
 * The sections a reading with nothing wrong in it draws, in pane order: the
 * warnings keep out of sight while there are none, which is what the stub's
 * reading holds.
 */
// Two sections keep out of sight while they hold nothing: warnings, and the
// machine's load, which is switched off unless a person asked for it.
const DRAWN = SECTIONS.filter((name) => name !== "warnings" && name !== "load");
const SECTION_TITLES = DRAWN.map((name) => TITLES[name] as string);

const OUTPUT = {
  generated_at: 1790000000,
  roster: {
    state: "ready",
    providers: { one: { state: "ready", jobs: 1 } },
    jobs: [{
      provider: "one", id: "job-1", name: "Review adapter behavior", state: "working",
      label: "Working", started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/p",
    }],
    sources: { jobs: "ready", interactive: "empty" },
    interactive: { one: 1 },
  },
  trials: { state: "empty" }, progress: { state: "empty" }, prs: { state: "empty" },
  skills: { state: "empty" }, worktrees: { state: "empty" },
  governance: { state: "ready", governor: true, controller: true, source: "config",
                path: "/tmp/switch.json", updated_at: null, by: null, errors: [] },
};

/**
 * A reading whose pane configuration is a person's own.
 *
 * Ordered warnings first, with sessions folded, and the other six sections left
 * out of the order entirely. Anything the pane draws beyond these two is a
 * packaged default standing in for a choice somebody made.
 */
const CONFIGURED = {
  ...OUTPUT,
  pane: {
    state: "ready",
    order: ["warnings", "sessions"],
    sections: {
      warnings: { visible: true, collapsed: false },
      sessions: { visible: true, collapsed: true },
    },
  },
};

/**
 * The version each of a session's values stands at, kept beside the values so
 * two loads handed one session share them as they share the values.
 */
const VERSIONS = new WeakMap<object, Record<string, number>>();

/**
 * Set for a render hook's paint and for every piece of work it starts, as the
 * host tells a write made while drawing from one made by a press or a timer.
 */
const DRAWING = new AsyncLocalStorage<boolean>();
function versionsOf(session: object): Record<string, number> {
  let versions = VERSIONS.get(session);
  if (versions === undefined) {
    versions = {};
    VERSIONS.set(session, versions);
  }
  return versions;
}

function stub(options: { exitCode?: number; stdout?: string; placed?: boolean;
                         panes?: { id: string }[]; held?: boolean;
                         stored?: unknown; session?: Record<string, unknown>;
                         refusesState?: boolean; heldState?: boolean;
                         sessionThrows?: boolean; notify?: boolean; usage?: unknown;
                         memory?: Record<string, unknown>; sessionId?: string;
                         play?: (signal: AbortSignal | undefined) => Promise<void>;
                         answer?: (argv: string[]) => { exitCode: number; stdout: string } | undefined
                           | Promise<{ exitCode: number; stdout: string } | undefined>;
                         /** The answer to a settings-only read; the reading's own alerts part otherwise. */
                         settings?: () => Promise<{ exitCode: number; stdout: string }>;
                         /** The plugin's options, as the host hands them to `register`. */
                         pluginOptions?: Record<string, string | boolean>;
                         surface?: string;
                         /** Whether a write of the reading takes a few turns to finish. */
                         slowStore?: boolean;
                         /** Why the clipboard refused a copy, when a case has it refuse. */
                         copyRefused?: string;
                         /** How a send to another session ends: delivered, refused with a reason, or thrown. */
                         send?: "delivered" | "throws" | { reason: string };
                         /** The store keys whose writes the store refuses. */
                         refuses?: string[];
                         /** The session's environment, as the engine reads it. */
                         env?: Record<string, string>;
                         /** Whether a person is at the prompt; absent is what an older engine sends. */
                         interactive?: boolean;
                         /** The store keys a read of answers a few turns late. */
                         slowKeys?: string[];
                         /** Turns a read of the dismissed keys takes, so a reading can land first. */
                         hiddenDelayTurns?: number;
                         /** Turns each read of the shared reading takes, in the order they are asked. */
                         readingDelays?: number[];
                         /** Holds a write until the promise it answers settles, for a key it names. */
                         gateStore?: (key: string) => Promise<void> | undefined;
                         /** Holds a read until the promise it answers settles, for a key it names. */
                         gateGet?: (key: string) => Promise<void> | undefined;
                         /** Holds a store read and answers it with what the store held when asked. */
                         gateGetStale?: (key: string) => Promise<void> | undefined;
                         /** Holds a write of the host's session values until it settles. */
                         gateState?: (key: string) => Promise<void> | undefined;
                         /** A host that refuses every versioned write at the version it was read at. */
                         stateStuck?: boolean;
                         /** How many versioned writes find another load's write landed first. */
                         stateConflicts?: number;
                         /** A host with no clock to tick. */
                         noClock?: boolean;
                       } = {}): Stub {
  const calls: Calls = { commands: [], immediate: [], opened: [], closed: [], argv: [], runTimeouts: [], settings: [], launches: [],
                         invalidated: [],
                         stored: [], claims: [], stated: [], toasts: [], notified: [], played: 0,
                         signals: [], every: [], cancelled: 0, timers: [],
                         usage: 0, written: [], gets: [], toastMs: [], copied: [], sent: [],
                         stateSets: [], refusedInRender: [] };
  // The plugin's store as every session on the machine shares it: a case hands
  // two stubs one memory to stand for two sessions.
  const memory = options.memory ?? {};
  let startHandler: ((engine: Engine, event: StartupEvent, next: Next) => unknown) | null = null;
  let commandHandler: ((engine: Engine, event: CommandEvent) => unknown) | null = null;
  let renderHandler: ((engine: Engine, event: RenderEvent) => unknown) | null = null;
  let promptHandler: ((engine: Engine, event: { text: string }, next: Next) => unknown) | null = null;
  let speakHandler: ((engine: Engine, event: CommandEvent) => unknown) | null = null;
  let bandHandler: ((engine: Engine, event: unknown, next: Next) => unknown) | null = null;
  let endHandler: ((engine: Engine, event: unknown, next: Next) => unknown) | null = null;
  const commandHandlers: Record<string, (engine: Engine, event: CommandEvent) => unknown> = {};
  let hintHandler: ((engine: Engine, event: PromptHintEvent, next: Next) => unknown) | null = null;
  let banded: unknown = null;
  // The last tree the pane drew, so a press can reach the button it drew: the
  // host runs a button's own closure, and a case that pressed any other way
  // would not be exercising what a person's press does.
  let drawn: unknown = null;
  let landed: (() => void) | null = null;
  // The clock only moves when a case moves it, so "stale" is a decision a case
  // makes rather than something the suite waits for.
  let nowSeconds = 1790000000;
  // The host's own memory of this plugin's values, which is what a reload keeps
  // and a registration does not. A case passes one in to share it across a
  // reload; without one, this stub is a session that has just started.
  const session = options.session ?? {};
  // A host whose answer to the first state read is held until the case lets it
  // go, so what a paint draws while that answer is out is a thing a case can
  // look at.
  let holding = options.heldState === true;
  let release: (() => void) | null = null;

  const on: On = ((event: string, matchOrHandler: unknown, maybeHandler?: unknown) => {
    const handler = (maybeHandler ?? matchOrHandler) as (...args: never[]) => unknown;
    if (event === "session.start") {
      startHandler = handler as typeof startHandler;
    } else if (event === "session.end") {
      endHandler = handler as typeof endHandler;
    } else if (event === "prompt.submit") {
      promptHandler = handler as typeof promptHandler;
    } else if (event === "command.run"
               && (matchOrHandler as { command?: string }).command === "llm-fleet") {
      // `/speak` registers on the same event; these cases run the pane's.
      commandHandler = handler as typeof commandHandler;
    } else if (event === "command.run"
               && (matchOrHandler as { command?: string }).command === "speak") {
      speakHandler = handler as typeof speakHandler;
    } else if (event === "command.run") {
      commandHandlers[(matchOrHandler as { command: string }).command] =
        handler as (engine: Engine, event: CommandEvent) => unknown;
    } else if (event === "ui.render"
               && (matchOrHandler as { component?: string }).component === "PromptHint") {
      hintHandler = handler as typeof hintHandler;
    } else if (event === "ui.render"
               && (matchOrHandler as { component?: string }).component === "AbovePrompt") {
      bandHandler = handler as typeof bandHandler;
    } else if (event === "ui.render"
               && (matchOrHandler as { component?: string }).component === "Pane") {
      // The band registers on the same event; the pane's is the one these
      // cases paint, chosen by its component as the engine chooses it.
      renderHandler = handler as typeof renderHandler;
    }
  }) as On;

  // A read that answers at once unless the case says otherwise, so a paint that
  // waits for it can be told from a paint that does not.
  const answered = options.held !== false;

  const engine: Engine = {
    command: {
      register: async (registration) => {
        calls.commands.push(registration.name);
        if (registration.immediate === true) {
          calls.immediate.push(registration.name);
        }
      },
    },
    ui: {
      open: async (request) => {
        calls.opened.push(request.id);
        return { isPlaced: options.placed !== false };
      },
      close: async (request) => { calls.closed.push(request.id); },
      panes: async () => options.panes ?? [],
      // The engine completes every surface's table with every element name, the
      // terminal's included, so the stub's table holds an Svg on every surface too.
      resolve: () => recordingPrimitives({ vectors: true, fields: true }),
      invalidate: (event) => { calls.invalidated.push(event); },
      toast: async (message, toasted) => {
        calls.toasts.push(message);
        calls.toastMs.push(toasted?.timeoutMs);
      },
      copy: async (args) => {
        calls.copied.push(args);
        return options.copyRefused === undefined ? { isCopied: true as const }
          : { isCopied: false as const, reason: options.copyRefused };
      },
      notify: async (text) => { calls.notified.push(text); },
    },
    clock: { now: async () => nowSeconds * 1000,
             every: (ms: number, fn: () => void) => {
               if (options.noClock === true) {
                 throw new Error("no clock here");
               }
               calls.every.push(ms);
               const timer = { ms, fn, cancelled: false };
               calls.timers.push(timer);
               return { cancel: () => { calls.cancelled += 1; timer.cancelled = true; } };
             } },
    fs: { read: async () => ({ base64: "" }) },
    audio: { play: async (_clip, played) => {
      calls.played += 1;
      calls.signals.push(played?.signal);
      await options.play?.(played?.signal);
    } },
    session: { id: options.sessionThrows
      ? () => { throw new Error("no session here"); }
      : async () => {
        return options.sessionId ?? "stub-session";
      },
      usage: async () => { calls.usage += 1; return options.usage ?? null; },
      model: async () => "stub-model",
      version: async () => ({ version: "0.0.0" }),
      send: async (args) => {
        calls.sent.push(args);
        const outcome = options.send ?? "delivered";
        if (outcome === "throws") {
          throw new Error("the socket closed");
        }
        return outcome === "delivered" ? { isDelivered: true as const }
          : { isDelivered: false as const, reason: outcome.reason };
      } },
    process: {
      run: async (argv, ran) => {
        calls.launches.push({ argv, env: ran?.env });
        if (argv.includes(SETTINGS_ONLY)) {
          calls.settings.push(ran?.timeoutMs);
          if (options.settings) {
            return { ...(await options.settings()), stderr: "" };
          }
          // What the read command prints with no reader run: the configuration's
          // parts, which are the reading's own when the case gave one.
          let parts: Record<string, unknown> = {};
          try {
            const reading = JSON.parse(options.stdout ?? JSON.stringify(OUTPUT));
            parts = { alerts: reading?.alerts ?? {} };
          } catch {
            parts = { alerts: {} };
          }
          return { exitCode: 0, stdout: JSON.stringify(parts), stderr: "" };
        }
        calls.argv.push(argv);
        calls.runTimeouts.push(ran?.timeoutMs);
        const custom = await options.answer?.(argv);
        if (custom !== undefined) {
          return { ...(await custom), stderr: "" };
        }
        const answer = { exitCode: options.exitCode ?? 0,
                         stdout: options.stdout ?? JSON.stringify(OUTPUT), stderr: "" };
        if (answered) {
          return answer;
        }
        return new Promise((resolve) => { landed = () => resolve(answer); });
      },
    },
    env: { get: async (name) => options.env?.[name] },
    plugin: { root: "/plugin/llm-fleet" },
    // Only the key the entry documents is answered, so a case that passes a
    // stored reading also proves the entry reads it under that key.
    store: {
      // What another session wrote under the reading's key, when a case wrote
      // one, and the reading the case started with otherwise.
      get: async (key) => {
        calls.gets.push(key);
        const stale = options.gateGetStale?.(key);
        if (stale !== undefined) {
          const asked = memory[key];
          await stale;
          return asked;
        }
        await options.gateGet?.(key);
        const delay = key === HIDDEN_KEY ? options.hiddenDelayTurns ?? 0
          : key === READING_KEY ? options.readingDelays?.shift() ?? 0 : 0;
        for (let turn = 0; turn < delay; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        const value = key === READING_KEY
          ? (READING_KEY in memory ? memory[READING_KEY] : options.stored) : memory[key];
        // A store that answers this key a few turns late, with what it held when
        // asked, so whatever the plugin does meanwhile happens before it lands.
        if (options.slowKeys?.includes(key)) {
          for (let turn = 0; turn < 10; turn += 1) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        return value;
      },
      set: async (key, value) => {
        // A claim is how sessions take turns reading, not something kept for the
        // pane, so it is recorded apart and answered from memory like the store.
        if (key === CLAIM_KEY || key === PROGRESS_CLAIM_KEY) {
          calls.claims.push({ key, value });
          calls.written.push({ key, value });
          memory[key] = value;
          return;
        }
        if (options.refuses?.includes(key)) {
          throw new Error("the store refused " + key);
        }
        await options.gateStore?.(key);
        if (key === READING_KEY && options.slowStore === true) {
          // A store that answers a few turns later, so a write that is not
          // waited for finishes after whatever the plugin did next.
          for (let turn = 0; turn < 5; turn += 1) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        calls.written.push({ key, value });
        calls.stored.push({ key, value });
        if (key !== READING_KEY) {
          memory[key] = value;
        }
      },
    },
    // The host's values, keyed by owner and key exactly as the engine does, so
    // a case can tell what the plugin kept from what it wrote to disk. A read
    // the case holds answers with what stood when it was issued, not with what
    // stands when it is let go: a host that answers late answers with the value
    // it had, which is the case a press has to outlive.
    state: {
      get: async (ref) => {
        const key = ref.plugin + "/" + ref.key;
        const value = session[key];
        const version = versionsOf(session)[key] ?? 0;
        if (!options.heldState || !holding) {
          return { value, version };
        }
        holding = false;
        return new Promise((resolve) => {
          release = () => resolve({ value, version });
        });
      },
      // Each value stands at a version, and a write that names one is made only
      // while the value still stands there, as the host's own does: two loads of
      // one session share these values, and only this tells a stale write.
      set: async (ref, value, setOptions) => {
        const key = ref.plugin + "/" + ref.key;
        if (DRAWING.getStore() === true) {
          // The host refuses a write made while a render hook draws, and work a
          // paint started is still that paint's when it lands.
          calls.refusedInRender.push(key);
          throw new Error("refused while a ui.render hook draws");
        }
        await options.gateState?.(key);
        calls.stateSets.push(key);
        if (options.refusesState) {
          // A host that will not hold this value: the plugin hears about it and
          // is expected to carry on, because the pane it is drawing is the one
          // in front of the person who pressed.
          throw new Error("the host refused to hold that");
        }
        const versions = versionsOf(session);
        const current = versions[key] ?? 0;
        if (setOptions?.ifVersion !== undefined && (options.stateConflicts ?? 0) > 0) {
          // Another load wrote first: the version moved, and this write is refused.
          options.stateConflicts = (options.stateConflicts ?? 0) - 1;
          versions[key] = current + 1;
          return { isSet: false, version: current + 1 };
        }
        if (setOptions?.ifVersion !== undefined
            && (setOptions.ifVersion !== current || options.stateStuck === true)) {
          return { isSet: false, version: current };
        }
        versions[key] = current + 1;
        session[key] = value;
        calls.stated.push({ key, value });
        return { isSet: true, version: current + 1 };
      },
    },
  };

  // Loaded once, and loaded again by a reload: the engine is the same object and
  // the module is evaluated afresh, which is exactly what a hot reload does to
  // everything a registration was holding.
  const load = (): void => {
    register(on, { notify: options.notify ?? false, ...(options.pluginOptions ?? {}) });
    assert.notEqual(startHandler, null, "the entry registered no session.start handler");
    assert.notEqual(commandHandler, null, "the entry registered no command.run handler");
    assert.notEqual(renderHandler, null, "the entry registered no ui.render handler");
  };
  load();

  // A read runs off the paint, so a case waits for the pane to be asked to draw
  // again. Bounded rather than a fixed number of turns: the chain has as many
  // hops as the read has awaits, and a case that guessed wrong would pass or
  // fail on timing instead of on behavior.
  // Waits for an invalidation this case has not already seen, so a second call
  // waits for the second one rather than returning on the first. A case that
  // reads what a paint drew after another paint has already asked for one would
  // otherwise read the tree from before the work it is waiting for.
  // Waits for the pane to be asked to draw again beyond a count the caller took
  // first. A wait that gave up is a failure, not a pass: returning quietly would
  // let a case read the tree from before the work it was waiting for, which is
  // how a case asserts nothing while looking like it asserts something.
  const drawnSince = async (before: number, what: string): Promise<void> => {
    for (let turn = 0; turn < 50 && calls.invalidated.length === before; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.notEqual(calls.invalidated.length, before, what);
  };

  /**
   * Resolves once the pane has been asked to draw again, without landing the read.
   *
   * For a repaint that may already have happened by the time this is called,
   * which is the case whenever the work being waited for runs inside the render
   * it was started from.
   */
  const repainted = (): Promise<void> =>
    drawnSince(0, "the pane was never asked to draw again");

  const settle = async (): Promise<void> => {
    // A look at the shared reading comes before a read, so the read this case
    // holds may not have started yet: it is given room to start before being
    // taken for one that answered on its own.
    for (let turn = 0; turn < 50 && landed === null && answered === false; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (landed === null) {
      // The read answered on its own, so its repaint may already have happened
      // before this was called: what is waited for is any repaint, not a new one.
      await repainted();
      return;
    }
    const before = calls.invalidated.length;
    landed();
    landed = null;
    await drawnSince(before, "the read landed and the pane was never redrawn for it");
  };

  /** One paint, with the tree it drew kept where a press can reach it. */
  const renderTree = async (columns: number): Promise<unknown> => {
    drawn = await DRAWING.run(true, () => (renderHandler as NonNullable<typeof renderHandler>)(engine, {
      surface: options.surface ?? "terminal", props: { bodyColumns: columns },
    }));
    return drawn;
  };

  /**
   * Draws until two paints in a row say the same thing.
   *
   * A paint may start work that asks for another paint, and the chain is as long
   * as the work has hops: a reload has the reading and the fold the session is in
   * to land, and each one asks for a frame. Counting those hops would make a case
   * pass or fail on timing, and counting invalidations is not enough either,
   * because one can land inside the paint it was asked for by. So this draws,
   * gives what is in flight room to land, and draws again: what it answers is the
   * first tree a further paint did not change.
   */
  const quiesce = async (columns = 108): Promise<unknown> => {
    let tree = await renderTree(columns);
    for (let turn = 0; turn < 20; turn += 1) {
      for (let hop = 0; hop < 12; hop += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const again = await renderTree(columns);
      if (JSON.stringify(again) === JSON.stringify(tree)) {
        return again;
      }
      tree = again;
    }
    assert.fail("the pane never stopped changing from one paint to the next");
  };

  return {
    engine,
    calls,
    settle,
    repainted,
    quiesce,
    reload: load,
    /** Lets a held state read answer, with what stood when it was asked. */
    releaseState: () => { release?.(); release = null; },
    advance: (seconds: number) => { nowSeconds += seconds; },
    press: async (element: string) => {
      const button = buttonAddressing(drawn, element);
      assert.notEqual(button, null, "the pane drew no control at " + element);
      (button as { onPress?: () => void }).onPress?.();
    },
    type: async (element: string, value: string) => {
      const field = fieldAddressing(drawn, element);
      assert.notEqual(field, null, "the pane drew no field at " + element);
      (field as { onSubmit: (value: string) => void }).onSubmit(value);
    },
    // The engine hands a session.start hook its own continuation, and only that
    // hook's result is used: this stands in for it, so a hook that answers with
    // a value of its own is caught here rather than in a live session.
    start: async () => (startHandler as NonNullable<typeof startHandler>)(
      engine, options.interactive === undefined ? { surface: "terminal" }
        : { surface: options.interactive ? "terminal" : null, isInteractive: options.interactive },
      async (event: unknown) => ({ continued: true, event })),
    run: async (args?: string) =>
      (commandHandler as NonNullable<typeof commandHandler>)(engine, { surface: "terminal",
                                                                      args: args ?? "" }),
    render: async (columns = 108) => renderTree(columns),
    band: async (columns = 140, surface = "terminal") => {
      banded = await DRAWING.run(true, () => (bandHandler as NonNullable<typeof bandHandler>)(
        engine, { surface, props: { bodyColumns: columns, hasSurvey: false } },
        async () => null));
      return banded;
    },
    pressBand: async (key: string) => {
      const button = buttonAddressing(banded, key);
      assert.notEqual(button, null, "the band drew no control at " + key);
      return (button as { onPress?: () => unknown }).onPress?.();
    },
    speak: async (args?: string) =>
      (speakHandler as NonNullable<typeof speakHandler>)(engine, { surface: "terminal",
                                                                  args: args ?? "" }),
    end: async () => (endHandler as NonNullable<typeof endHandler>)(
      engine, {}, async (event: unknown) => ({ continued: true, event })),
    command: async (name, args) => {
      const handler = commandHandlers[name];
      assert.notEqual(handler, undefined, "the entry registered no /" + name + " handler");
      return (handler as NonNullable<typeof handler>)(engine, { surface: "terminal",
                                                               args: args ?? "" });
    },
    hint: async (props) => DRAWING.run(true, () => (hintHandler as NonNullable<typeof hintHandler>)(
      engine, { surface: "terminal",
                props: { isDraft: false, isWorking: false, hint: "? for shortcuts", ...props } },
      async (event: unknown) => (event as PromptHintEvent).props)),
    tick: (ms: number) => {
      for (const timer of calls.timers.filter((entry) => entry.ms === ms)) {
        timer.fn();
      }
    },
    prompt: async (text: string) => (promptHandler as NonNullable<typeof promptHandler>)(
      engine, { text }, async (event: unknown) => ({ continued: true, event })),
  };
}

/** The control a pane drew at this address, as a press would reach it. */
/** The props of the field a tree draws under one address, or null. */
function fieldAddressing(tree: unknown, element: string): unknown {
  if (tree === null || typeof tree !== "object") {
    return null;
  }
  const node = tree as { type?: string; props?: { key?: unknown }; children?: unknown[] };
  if (node.type === "Input" && node.props?.key === element) {
    return node.props;
  }
  for (const child of node.children ?? []) {
    const found = fieldAddressing(child, element);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function buttonAddressing(tree: unknown, element: string): unknown {
  if (tree === null || typeof tree !== "object") {
    return null;
  }
  const record = tree as { type?: string; props?: { key?: unknown }; children?: readonly unknown[] };
  if (record.type === "Button" && record.props?.key === element) {
    return record.props;
  }
  for (const child of record.children ?? []) {
    const found = buttonAddressing(child, element);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * A promise that must settle, or the case says why it did not.
 *
 * A paint that waits for a process does not fail, it never returns, and a case
 * that hung would read as a slow suite rather than a broken hook. This makes it
 * a named failure in two seconds.
 */
function within<T>(work: Promise<T>, what: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  return Promise.race([work, deadline])
    .finally(() => { if (timer !== undefined) { clearTimeout(timer); } }) as Promise<T>;
}

test("the entry registers the command that opens the pane", async () => {
  const driven = stub();
  await driven.start();
  assert.deepEqual(driven.calls.commands, ["llm-fleet", "speak", "worktrees", "keys"]);
  // A command queued behind a running turn is a switch that waits for the
  // model, so every one runs at once.
  assert.deepEqual(driven.calls.immediate, ["llm-fleet", "speak", "worktrees", "keys"]);
});

test("a session whose identifier cannot be read still gets its command", async () => {
  // The band asks for the session's identifier at startup, inside the hook that
  // registers the command. An engine that throws there must cost the band its
  // own-job filter, never the session its command.
  // The engine drops the command of a startup hook that throws, so the proof is
  // the hook finishing and handing on to the engine, not the registration call.
  const driven = stub({ sessionThrows: true });
  const result = await driven.start() as { continued?: boolean };
  assert.equal(result?.continued, true);
  assert.deepEqual(driven.calls.commands, ["llm-fleet", "speak", "worktrees", "keys"]);
});

test("unhide brings back what was dismissed from the band, and opens nothing", async () => {
  const driven = stub();
  await driven.start();
  const answer = await driven.run("unhide") as { text: string };
  assert.match(answer.text, /^0 dismissed band items shown again/);
  // The store is emptied under the band's key, so the next session draws them too.
  assert.deepEqual(driven.calls.stored.filter((entry) => entry.key === "band-hidden"),
                   [{ key: "band-hidden", value: [] }]);
  assert.deepEqual(driven.calls.opened, []);
  assert.deepEqual(driven.calls.closed, []);
});

test("the entry continues the engine's own startup rather than answering for it", async () => {
  const driven = stub();
  // The engine uses a session.start hook's result and skips a hook that returns
  // a value of its own. That skip is silent in a live session: the command the
  // hook registered goes with it, and the pane's key opens nothing.
  const result = await driven.start() as { continued?: boolean };
  assert.equal(result?.continued, true);
});

test("the command opens the pane, and closes it when it is already open", async () => {
  const opening = stub();
  const opened = await opening.run() as { text: string };
  assert.deepEqual(opening.calls.opened, [PANE]);
  // The marker is the difference between this plugin and the one it replaces,
  // so it is asserted rather than left to a person to notice.
  assert.equal(opened.text, `llm-fleet pane opened (${MARK}).`);

  const closing = stub({ panes: [{ id: PANE }] });
  const closed = await closing.run() as { text: string };
  assert.deepEqual(closing.calls.closed, [PANE]);
  assert.equal(closed.text, `llm-fleet pane closed (${MARK}).`);
});

test("the pane is opened under a title that names this plugin", async () => {
  const driven = stub();
  let title = "";
  driven.engine.ui.open = async (request) => {
    title = request.title ?? "";
    return { isPlaced: true };
  };
  await driven.run();
  assert.equal(title, `llm-fleet (${MARK})`);
});

test("a surface too narrow to place the pane says so rather than claiming it opened", async () => {
  const driven = stub({ placed: false });
  const result = await driven.run() as { text: string };
  assert.equal(result.text.includes("wider"), true);
});

test("the engine's own startup reads the machine through the plugin's own reader", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  assert.equal(driven.calls.argv.length, 1);
  const argv = driven.calls.argv[0];
  assert.equal(argv[0], "python3");
  assert.equal(argv[1], "/plugin/llm-fleet/" + READER);
});

test("a paint that has no reading yet says it is reading rather than waiting", async () => {
  const driven = stub({ held: false });
  // The read never answers in this case: a paint that awaited it would never
  // return, and the surface would draw the pane empty while it waited.
  const tree = await within(driven.render(), "the paint waited for the read");
  const text = renderedText(tree as never).join("\n");
  assert.equal(text.includes("Reading the machine"), true);
  // The read starts off the paint, after a look at the reading the sessions share.
  await drain();
  assert.equal(driven.calls.argv.length, 1);
});

test("a reading that lands is drawn on the next paint, and the pane is asked to draw again", async () => {
  const driven = stub({ held: false });
  const first = renderedText(await within(driven.render(), "the paint waited for the read") as never).join("\n");
  assert.equal(first.includes("Reading the machine"), true);
  await driven.settle();
  assert.deepEqual(driven.calls.invalidated, ["ui.render"]);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Review adapter behavior"), true);
  assert.equal(text.includes("llm-fleet"), true);
});

test("the reading the last session left is drawn while this session's read is still out", async () => {
  // The store keeps a plugin's own values between sessions. A pane that opened
  // on a sentence every time and waited a second for the same fleet it drew a
  // moment ago is the case this covers.
  const driven = stub({ held: false, stored: { at: 1790000000, documents: OUTPUT } });
  const first = renderedText(await within(driven.render(), "the paint waited for the read") as never).join("\n");
  assert.equal(first.includes("Reading the machine"), true);
  assert.deepEqual(driven.calls.invalidated, ["ui.render"]);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Review adapter behavior"), true);
  assert.equal(text.includes("Reading the machine"), false);
});

test("a reading too old to be current is drawn and then read again", async () => {
  const carried = { at: 1790000000, documents: OUTPUT };
  const driven = stub({ held: false, stored: carried });
  await driven.render();
  await driven.settle();
  driven.advance(STALE_SECONDS + 1);
  // Old enough to be replaced and drawn anyway: what the pane shows while the
  // new read is still out is the fleet as it last stood, with the age the
  // reading carries, never an empty one.
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Review adapter behavior"), true);
  await drain();
  assert.equal(driven.calls.argv.length, 1);
});

test("a reading dated ahead of this session's clock is read again rather than trusted", async () => {
  // The store crosses process boundaries, so its timestamp is another session's
  // reading of another clock. One dated ahead makes every age negative, and a
  // reading that never ages is one the pane holds for the whole session while
  // the machine moves under it.
  const ahead = { at: 1790000000 + 3600, documents: OUTPUT };
  const driven = stub({ held: false, stored: ahead });
  await driven.render();
  await driven.settle();
  const reads = driven.calls.argv.length;
  await driven.render();
  await driven.settle();
  assert.equal(driven.calls.argv.length, reads + 1);
});

test("a carried-over reading is drawn with its own age, not this paint's", async () => {
  // The reading the store hands back carries the time it was taken. A pane that
  // drew it with the clock of the paint would call an hour-old fleet current,
  // which is the claim the age line exists to avoid.
  const documents = { ...OUTPUT } as Record<string, unknown>;
  delete documents.generated_at;
  const driven = stub({ stored: { at: 1790000000 - 3600, documents } });
  await driven.render();
  await driven.repainted();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Updated 1h ago"), true);
});

test("a reading that lands is kept for the next session to open on", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  assert.equal(driven.calls.stored.length, 1);
  const kept = driven.calls.stored[0];
  assert.equal(kept.key, READING_KEY);
  // The documents as the reader printed them, the time they were read, and the
  // time the read began, which is when its counts were read: what the next
  // session draws, the age it draws beside them, and how old the counts are.
  assert.deepEqual(kept.value, { at: 1790000000, progressAt: 1790000000, documents: OUTPUT });
});

test("a read that failed is not kept for the next session to open on", async () => {
  const driven = stub({ exitCode: 1 });
  await driven.start();
  await driven.settle();
  // A machine that refused once left no fleet, and a kept refusal would outlive
  // the machine's mood.
  assert.deepEqual(driven.calls.stored, []);
});

test("a carried-over reading is drawn, then replaced by the one this session reads", async () => {
  // Old enough that no session has read since: a fresh shared reading is drawn
  // without a read of this session's own, which is the case further down.
  const carried = { at: 1790000000 - STALE_SECONDS - 1,
                    documents: { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [] } } };
  const driven = stub({ held: false, stored: carried });
  // The session's own read is in flight and does not land until settle below.
  await driven.start();
  await driven.render();
  await driven.repainted();
  const before = renderedText(await driven.render() as never).join("\n");
  // The carried reading, drawn as a fleet: the counts it carried, its age, and
  // the row it did not have. A pane that waited for the read instead would say
  // it was reading.
  assert.equal(before.includes("Reading the machine"), false);
  assert.equal(before.includes("Updated"), true);
  assert.equal(before.includes("Review adapter behavior"), false);
  await driven.settle();
  const after = renderedText(await driven.render() as never).join("\n");
  assert.equal(after.includes("Review adapter behavior"), true);
});

test("a stored value that is not a reading is not drawn as one", async () => {
  // Anything can be under the key: a half-written value, a version of this
  // plugin that stored a different shape, or a value that is not a reading at
  // all. Each falls back to reading the machine.
  const wrong = [
    { at: "yesterday", documents: OUTPUT },
    { at: 1790000000, documents: 7 },
    { at: 1790000000, documents: [1, 2] },
    { at: 1790000000, documents: { configErrors: [{ code: "E", path: "p" }] } },
    { documents: OUTPUT },
  ];
  for (const stored of wrong) {
    const driven = stub({ held: false, stored });
    await driven.render();
    await driven.render();
    const text = renderedText(await driven.render() as never).join("\n");
    assert.equal(text.includes("Review adapter behavior"), false, JSON.stringify(stored));
    // Not drawn as a fleet either. A value the store handed back that is not a
    // reading must leave the pane saying it is reading, not reporting zero jobs
    // and an empty machine.
    assert.equal(text.includes("0 working"), false, JSON.stringify(stored));
    assert.equal(text.includes("Reading the machine"), true, JSON.stringify(stored));
  }
});

test("pressing a section heading folds it, and pressing again opens it", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  const open = renderedText(await driven.render() as never).join("\n");
  assert.equal(open.includes("Review adapter behavior"), true);
  await driven.press("fleet.section.sessions");
  const folded = renderedText(await driven.render() as never).join("\n");
  // The row is gone and the heading says which way it is folded, so what a
  // person reads is the state rather than a word needing a legend.
  assert.equal(folded.includes("Review adapter behavior"), false);
  assert.equal(folded.includes("\u25b8\nBackground sessions"), true);
  await driven.press("fleet.section.sessions");
  const again = renderedText(await driven.render() as never).join("\n");
  assert.equal(again.includes("Review adapter behavior"), true);
  assert.equal(again.includes("\u25be\nBackground sessions"), true);
});

/** Every control address a drawn tree carries, in drawing order. */
function buttonKeys(tree: unknown, found: string[] = []): string[] {
  if (tree === null || typeof tree !== "object") {
    return found;
  }
  const node = tree as { type?: string; props?: { key?: unknown }; children?: unknown };
  if (node.type === "Button" && typeof node.props?.key === "string") {
    found.push(node.props.key);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      buttonKeys(child, found);
    }
  }
  return found;
}

test("a press on a headline figure narrows the pane, and its clear control widens it", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  const all = renderedText(await driven.render() as never).join("\n");
  assert.equal(all.includes("Showing working only."), false);
  assert.equal(buttonKeys(await driven.render()).includes("fleet.focus.working"), true);
  await driven.press("fleet.focus.working");
  const narrowed = renderedText(await driven.render() as never).join("\n");
  assert.equal(narrowed.includes("Showing working only."), true);
  assert.equal(narrowed.includes("Show all"), true);
  // The row in that state is still drawn, so the press narrowed the pane rather
  // than blanking it.
  assert.equal(narrowed.includes("Review adapter behavior"), true);
  await driven.press("fleet.focus.clear");
  const wide = renderedText(await driven.render() as never).join("\n");
  assert.equal(wide.includes("Showing working only."), false);
  assert.equal(wide.includes("Review adapter behavior"), true);
});

test("a press on a row's figures opens what the row holds in full, and closes it again", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  const key = buttonKeys(await driven.render()).find((address) =>
    address.startsWith("fleet.details."));
  assert.notEqual(key, undefined);
  const before = renderedText(await driven.render() as never).join("\n");
  assert.equal(before.includes("provider one"), false);
  await driven.press(key as string);
  const open = renderedText(await driven.render() as never).join("\n");
  assert.equal(open.includes("provider one"), true);
  await driven.press(key as string);
  const shut = renderedText(await driven.render() as never).join("\n");
  assert.equal(shut.includes("provider one"), false);
});

test("a press on the band's figure opens the pane narrowed to it", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  await driven.band();
  await driven.pressBand("fleet.band.focus.working");
  assert.deepEqual(driven.calls.opened, [PANE]);
  const words = renderedText(await driven.render() as never).join("\n");
  assert.equal(words.includes("Showing working only."), true);
});

test("the controls that act on every section fold them all, and open them all", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  await driven.render();
  // Open everything first. Three sections start folded by default, so a
  // collapse-all that folded five of eight and left those three alone would
  // satisfy a check written against the folded pane it started from.
  await driven.press("fleet.all.expand");
  const allOpen = renderedText(await driven.render() as never).join("\n");
  assert.equal((allOpen.match(/\u25b8/g) ?? []).length, 0);
  await driven.press("fleet.all.collapse");
  const folded = renderedText(await driven.render() as never).join("\n");
  assert.equal(folded.includes("Review adapter behavior"), false);
  // Every section, not just the one that happens to hold a row: a collapse-all
  // that folded one section would pass a check written against rows alone.
  for (const name of SECTION_TITLES) {
    assert.equal(folded.includes("\u25b8\n" + name), true, name);
  }
  const shut = (folded.match(/\u25b8/g) ?? []).length;
  // A press that asks for the fold everything is already in changes nothing.
  const reads = driven.calls.invalidated.length;
  await driven.press("fleet.all.collapse");
  assert.equal(driven.calls.invalidated.length, reads);
  await driven.press("fleet.all.expand");
  const opened = renderedText(await driven.render() as never).join("\n");
  assert.equal(opened.includes("Review adapter behavior"), true);
  // Every section the collapse folded is one the expand opened.
  assert.equal((opened.match(/\u25b8/g) ?? []).length, 0);
  assert.equal(shut > 0, true);
});

test("each heading folds its own section and no other", async () => {  for (const [index, name] of DRAWN.entries()) {
    const driven = stub();
    await driven.start();
    await driven.settle();
    await driven.render();
    // Open everything, so a press that folds the wrong section is visible as a
    // heading that did not move rather than hidden by the three that start shut.
    await driven.press("fleet.all.expand");
    await driven.press("fleet.section." + name);
    const text = renderedText(await driven.render() as never).join("\n");
    for (const [other, title] of SECTION_TITLES.entries()) {
      // The pressed heading folds; every other heading stays open. A dispatch
      // that ignored the address, or read it off by one, fails here by name.
      assert.equal(text.includes((other === index ? "\u25b8\n" : "\u25be\n") + title), true,
                   name + " -> " + title);
    }
  }
});

test("every section the pane drew carries a control that folds it", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  const drawn = await driven.render() as never;
  const addresses = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    const record = node as { type?: string; props?: { key?: unknown };
                             children?: readonly unknown[] };
    if (record.type === "Button" && typeof record.props?.key === "string") {
      addresses.add(record.props.key);
    }
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(drawn);
  for (const name of DRAWN) {
    assert.equal(addresses.has("fleet.section." + name), true, name);
  }
  // The warnings hold no error, and they do hold the roster's interactive count,
  // which the legend promises: the section is drawn, with a heading to press.
  assert.equal(addresses.has("fleet.section.warnings"), true);
  assert.equal(addresses.has("fleet.all.collapse"), true);
  assert.equal(addresses.has("fleet.all.expand"), true);
});

test("a section starts folded where the configuration says, not where this build guessed", async () => {
  // The plugin has no configuration file to read, so a reading that carries the
  // pane's configuration is the only way a person's own choice reaches it. Here
  // sessions is configured folded and the order puts warnings first: a pane
  // drawing its packaged default would show the session row.
  const driven = stub({ stdout: JSON.stringify(CONFIGURED) });
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("\u25b8\nBackground sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), false);
  // The order is the configuration's too, so warnings is met before sessions.
  assert.equal(text.indexOf("Warnings") < text.indexOf("Background sessions"), true);
  // And a section the order does not name is not drawn: this is the whole of
  // what a person chose, not a starting point to add the rest back to.
  assert.equal(text.includes("Keys"), false);
});

test("a press folds a section the configuration had open, and outranks it", async () => {
  const driven = stub({ stdout: JSON.stringify(CONFIGURED) });
  await driven.start();
  await driven.settle();
  await driven.render();
  await driven.press("fleet.section.sessions");
  const text = renderedText(await driven.render() as never).join("\n");
  // The configuration said folded and the press opened it: what a person
  // pressed is what the pane draws.
  assert.equal(text.includes("\u25be\nBackground sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), true);
});

test("a reading taken before the session's identifier was known is read again with it", () => {
  // The reader prices a routed session from the status line's file for the
  // session it is told about, and prices the transcript when it is told no
  // session. A read that ran before the identifier landed is that second case,
  // and its figure is not the money this session spends.
  assert.equal(needsSessionRead(true, "abc-123", ""), true);
  assert.equal(needsSessionRead(true, "abc-123", "abc-123"), false);
  assert.equal(needsSessionRead(false, "abc-123", ""), false);
  assert.equal(needsSessionRead(true, "", ""), false);
});

test("a press that shows a section in full reaches the entry", async () => {
  // The whole path: a section past its ceiling draws the control, the press
  // reaches the entry, is kept where the next paint reads it, and the row the
  // ceiling withheld is drawn after it. The first cut of this case counted
  // every control on the pane, including two other sections' own.
  const documents = { ...CONFIGURED,
                      roster: { ...OUTPUT.roster,
                                jobs: [OUTPUT.roster.jobs[0],
                                       { ...OUTPUT.roster.jobs[0], id: "job-2" }] },
                      pane: { ...CONFIGURED.pane, order: ["sessions"],
                              sections: { sessions: { visible: true, collapsed: false,
                                                      maxRows: 1 } } } };
  const session: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents }, session });
  const before = (renderedText(await driven.render() as never).join("\n")
    .match(/Review adapter behavior/g) ?? []).length;
  await driven.quiesce();
  await driven.press("fleet.showall.sessions");
  await driven.quiesce();
  assert.deepEqual(session["llm-fleet/shownAll"], { sessions: true });
  // The withheld row is the second job, drawn only once the section is shown in
  // full: before the press it is counted, after it it is drawn.
  const during = (renderedText(await driven.render() as never).join("\n")
    .match(/Review adapter behavior/g) ?? []).length;
  assert.equal(during > before, true, before + " then " + during);
});

test("a fold pressed in this session is still folded after the plugin is reloaded", async () => {
  const session: Record<string, unknown> = {};
  const carried = { at: 1790000000, documents: OUTPUT };
  const driven = stub({ stored: carried, session });
  await driven.render();
  await driven.quiesce();
  await driven.press("fleet.section.sessions");
  assert.equal(renderedText(await driven.render() as never).join("\n")
                 .includes("\u25b8\nBackground sessions"), true);

  // A reload evaluates the plugin again over the same host: everything a
  // registration was holding is gone, and the fold is not one of those things.
  driven.reload();
  await driven.render();
  const after = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(after.includes("\u25b8\nBackground sessions"), true);
  assert.equal(after.includes("Review adapter behavior"), false);
});

test("a fold pressed in one session is the next session's fold", async () => {
  const carried = { at: 1790000000, documents: OUTPUT };
  // One store, as every session on the machine shares it; a host of its own each.
  const memory: Record<string, unknown> = {};
  const first = stub({ stored: carried, session: {}, memory });
  await first.render();
  await first.quiesce();
  await first.press("fleet.section.sessions");
  assert.equal(renderedText(await first.render() as never).join("\n")
                 .includes("\u25b8\nBackground sessions"), true);

  // A second session is a second registration with a host of its own, which
  // holds no fold. It opens with the folds the last person left, from the store.
  const second = stub({ stored: carried, session: {}, memory });
  const text = renderedText(await second.quiesce() as never).join("\n");
  assert.equal(text.includes("\u25b8\nBackground sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), false);
});

test("a session's own fold outranks the one the last session left", async () => {
  // The host holds this session's fold across a reload, and the store holds the
  // last session's: a reload must not hand the session back someone else's.
  const carried = { at: 1790000000, documents: OUTPUT };
  const memory: Record<string, unknown> = { [FOLDS_KEY]: { sessions: true } };
  const driven = stub({ stored: carried, session: { "llm-fleet/folded": { sessions: false } },
                        memory });
  const text = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(text.includes("\u25be\nBackground sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), true);
});

test("a fold is kept for this session in the host and for the next in the store", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ stdout: JSON.stringify(CONFIGURED), session: {}, memory });
  await driven.start();
  await driven.settle();
  await driven.render();
  await driven.press("fleet.section.sessions");
  await new Promise((resolve) => setImmediate(resolve));
  // The host holds it for this session, and across a reload of the plugin.
  assert.deepEqual(driven.calls.stated.map((entry) => entry.key), ["llm-fleet/folded"]);
  assert.equal(driven.calls.stated[0]?.value !== null, true);
  // The store holds the same presses for the next session, and nothing else
  // a press wrote.
  assert.deepEqual(driven.calls.stored.map((entry) => entry.key), [READING_KEY, FOLDS_KEY]);
  assert.deepEqual(memory[FOLDS_KEY], driven.calls.stated[0]?.value);
  assert.deepEqual(driven.calls.toasts, []);
});

test("a store that refuses a fold says so once, and the pane still folds", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ stdout: JSON.stringify(CONFIGURED), session: {}, memory,
                        refuses: [FOLDS_KEY] });
  await driven.start();
  await driven.settle();
  await driven.render();
  await driven.press("fleet.section.sessions");
  await driven.press("fleet.section.sessions");
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The person hears the folds will not outlive this session, once rather
  // than on every press, and the press they made still took.
  assert.deepEqual(driven.calls.toasts,
                   ["fleet: section folds kept for this session; could not save them."]);
  assert.equal(FOLDS_KEY in memory, false);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("\u25b8\nBackground sessions"), true);
});

test("a host that will not hold a fold still folds the pane", async () => {
  const driven = stub({ stdout: JSON.stringify(CONFIGURED), session: {},
                        refusesState: true });
  await driven.start();
  await driven.settle();
  await driven.render();
  await driven.press("fleet.section.sessions");
  // The write is refused, and the pane a person is looking at still folds: a
  // fold that needed the host to agree before it happened would be a keypress
  // that did nothing.
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("\u25be\nBackground sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), true);
});

test("a fresh reading's configuration decides the sections nobody has pressed", async () => {
  // The pane opens on the last session's reading, which carried that session's
  // configuration, and the fresh read lands with a different one. A fold taken
  // from whichever reading happened to arrive first would go on deciding the
  // layout after the reading that said so had been replaced.
  // The carried reading is old enough that the pane asks the machine again, so
  // what it draws first is the carried reading and what it draws after the read
  // lands is the fresh one. The read is held until this case lets it go.
  const carried = { at: 1790000000 - 60, documents: CONFIGURED };
  const driven = stub({ stored: carried, stdout: JSON.stringify(OUTPUT), held: false });
  const first = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(first.includes("\u25b8\nBackground sessions"), true);
  assert.equal(first.includes("Review adapter behavior"), false);

  // The fresh reading lands, carrying no pane configuration of its own, so what
  // stands is the packaged default. Nobody has pressed sessions, so it opens:
  // the configuration being drawn is the one the reading the pane is drawing
  // carried, not the one the first reading it ever saw did.
  await driven.settle();
  const second = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(second.includes("\u25be\nBackground sessions"), true);
  assert.equal(second.includes("Review adapter behavior"), true);
});

test("a press stands while a fresh reading replaces the configuration under it", async () => {
  // The carried reading is old enough that the pane asks the machine again, so
  // a replacement read really is in flight; the fresh read is held until this
  // case lets it go.
  const carried = { at: 1790000000 - 60, documents: CONFIGURED };
  const driven = stub({ stored: carried, stdout: JSON.stringify(CONFIGURED), held: false });
  // The read the pane starts for a reading this old is in flight from here.
  const reads = driven.calls.argv.length;
  const before = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(before.includes("\u25b8\nBackground sessions"), true);
  assert.equal(driven.calls.argv.length > reads, true, "no replacement read started");

  // A press opens the section its configuration folded.
  await driven.press("fleet.section.sessions");
  assert.equal(renderedText(await driven.render() as never).join("\n")
                 .includes("\u25be\nBackground sessions"), true);

  // The fresh read lands saying sessions starts folded, which is what the press
  // overrode. A configuration that overruled a press, or a refresh that dropped
  // the presses with the reading it replaced, would fold a section the person
  // had just opened, in front of them.
  await driven.settle();
  const after = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(after.includes("\u25be\nBackground sessions"), true);
  assert.equal(after.includes("Review adapter behavior"), true);
});

test("a section the configuration folded opens on its first press", async () => {
  // Nobody has pressed worktrees, so what the pane draws is what the
  // configuration says: folded. The first press has to open it, and a press that
  // read the pressed map rather than the drawing would find nothing there, treat
  // it as open, and fold a section that was already folded.
  const driven = stub({ stdout: JSON.stringify(OUTPUT) });
  await driven.start();
  await driven.settle();
  const before = renderedText(await driven.render() as never).join("\n");
  assert.equal(before.includes("\u25b8\nWorktrees"), true);
  await driven.press("fleet.section.worktrees");
  const after = renderedText(await driven.render() as never).join("\n");
  assert.equal(after.includes("\u25be\nWorktrees"), true);
  await driven.press("fleet.section.worktrees");
  const again = renderedText(await driven.render() as never).join("\n");
  assert.equal(again.includes("\u25b8\nWorktrees"), true);
});

test("Expand all opens a section the configuration folded and nobody pressed", async () => {
  const driven = stub({ stdout: JSON.stringify(OUTPUT) });
  await driven.start();
  await driven.settle();
  await driven.render();
  // Worktrees starts folded from the configuration, with nothing in the pressed
  // map. A control that compared the pressed map alone would find every section
  // already open and return without drawing anything.
  await driven.press("fleet.all.expand");
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal((text.match(/\u25b8/g) ?? []).length, 0);
  assert.equal(text.includes("\u25be\nWorktrees"), true);
});

test("a fold a person pressed is not undone by a slow host answering late", async () => {
  // What the host held before the press: worktrees folded, sessions folded.
  const session: Record<string, unknown> = {
    "llm-fleet/folded": { worktrees: true, sessions: true } };
  const carried = { at: 1790000000, documents: OUTPUT };
  // The host's answer is held until this case lets it go, which is what a slow
  // host looks like from inside a paint.
  const driven = stub({ stored: carried, session, heldState: true });
  await driven.quiesce();
  // Pressed while the host's answer is still out: worktrees, which the packaged
  // default folds, so the press opens it.
  await driven.press("fleet.section.worktrees");
  const pressed = renderedText(await driven.render() as never).join("\n");
  assert.equal(pressed.includes("\u25be\nWorktrees"), true);

  // The host now answers with what it held before the press. That answer is
  // older than the press, so where the two disagree the press is what stands;
  // a host that overwrote it would fold a section the person had just opened.
  driven.releaseState();
  const after = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(after.includes("\u25be\nWorktrees"), true);
  // And what the answer carried is applied where nobody has pressed: sessions
  // was folded by the host, and nothing has touched it since.
  assert.equal(after.includes("\u25b8\nBackground sessions"), true);

  // A reload is what proves the answer was kept rather than only held here: the
  // press wrote itself to the host on its own, and the section this answer
  // brought back was never written again, so the next registration finds the
  // press and loses the fold it had restored. The merge was read for a paint,
  // so it is written at the next tick.
  driven.tick(AFTER_PAINT_MS);
  await settles();
  driven.reload();
  const reloaded = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(reloaded.includes("\u25be\nWorktrees"), true);
  assert.equal(reloaded.includes("\u25b8\nBackground sessions"), true);
});

test("a configuration that places no sections draws a pane with none", async () => {
  // An empty order is somebody asking for a pane with no sections in it, which
  // the schema resolves. A pane that answered with all eight would be drawing a
  // layout nobody asked for, and one that drew the controls anyway would offer
  // to fold sections that are not there.
  const empty = { ...OUTPUT, pane: { state: "ready", order: [], sections: {} } };
  const driven = stub({ stdout: JSON.stringify(empty) });
  await driven.start();
  await driven.settle();
  const tree = await driven.render();
  const text = renderedText(tree as never).join("\n");
  assert.equal(text.includes("Background sessions"), false);
  assert.equal(text.includes("Worktrees"), false);
  assert.equal(text.includes("Collapse all"), false);
  // The pane still says what it is: an empty pane is not a broken one.
  assert.equal(text.includes("llm-fleet"), true);
});

test("a section the order leaves out keeps the fold it was left in", async () => {
  // The pane draws two sections, folds one, and then the configuration changes
  // to place only the other. The section that went out of the order keeps the
  // press it had: it is out of sight for now, not unfolded, and a control that
  // replaced the whole map would bring it back wherever its configuration
  // starts it.
  const session: Record<string, unknown> = { "llm-fleet/folded": { sessions: true } };
  const both = { ...OUTPUT, pane: { state: "ready",
                                    order: ["warnings", "sessions"],
                                    sections: { warnings: { visible: true, collapsed: false },
                                                sessions: { visible: true, collapsed: true } } } };
  const onlyWarnings = { ...OUTPUT, pane: { state: "ready",
                                            order: ["warnings"],
                                            sections: { warnings: { visible: true,
                                                                    collapsed: false } } } };
  const driven = stub({ stored: { at: 1790000000 - 60, documents: both },
                        stdout: JSON.stringify(onlyWarnings), held: false, session });
  // Sessions is folded by the host and draws folded; a press opens it.
  await driven.quiesce();
  await driven.press("fleet.section.sessions");
  assert.equal(renderedText(await driven.render() as never).join("\n")
                 .includes("\u25be\nBackground sessions"), true);

  // The fresh reading places only warnings, so sessions is not drawn at all once
  // it has slid out, which takes a moment of the clock.
  await driven.settle();
  await driven.render();
  driven.advance(1);
  const narrow = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(narrow.includes("Background sessions"), false);

  // A control that acts on every section acts on the ones being drawn.
  await driven.press("fleet.all.collapse");
  assert.equal(renderedText(await driven.render() as never).join("\n")
                 .includes("\u25b8\nWarnings"), true);
  // What the host holds still carries the press on the section out of the
  // order, because a control on the sections being drawn is not a statement
  // about the ones that are not.
  const heldFold = session["llm-fleet/folded"] as Record<string, boolean>;
  assert.equal(heldFold["sessions"], false, "the press on sessions was dropped");
  assert.equal(heldFold["warnings"], true);
});

test("a press that changes nothing is still the person's last word", async () => {
  // Sessions is configured folded and nobody has pressed it, so Collapse all
  // finds every section already where it asks and redraws nothing. The press is
  // still recorded: a later configuration that opens sessions must not walk
  // over the last thing the person asked for.
  const foldedAlready = { ...OUTPUT, pane: { state: "ready",
                                             order: ["sessions", "warnings"],
                                             sections: { sessions: { visible: true,
                                                                     collapsed: true },
                                                         warnings: { visible: true,
                                                                     collapsed: true } } } };
  const session: Record<string, unknown> = {};
  const driven = stub({ stdout: JSON.stringify(foldedAlready), session });
  await driven.start();
  await driven.settle();
  await driven.render();
  const frames = driven.calls.invalidated.length;
  await driven.press("fleet.all.collapse");
  // Nothing moved, so nothing is redrawn.
  assert.equal(driven.calls.invalidated.length, frames);
  // And the press is written all the same, once the held fold has been read.
  await settles();
  assert.equal(driven.calls.stated.length > 0, true);
  const written = driven.calls.stated[driven.calls.stated.length - 1]?.value as
    Record<string, boolean>;
  assert.equal(written["sessions"], true);
  assert.equal(written["warnings"], true);
});

test("the pane is drawn from what the reader printed", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  const tree = await driven.render();
  // Every section heading is a control, so the pane draws the three elements
  // the subset carries and no others.
  assert.deepEqual(elementTypes(tree as never), ["Box", "Button", "Text"]);
  const text = renderedText(tree as never).join("\n");
  assert.equal(text.includes("Review adapter behavior"), true);
  assert.equal(text.includes("llm-fleet"), true);
});

test("a read that failed is named, never drawn as an empty fleet", async () => {
  const driven = stub({ exitCode: 1 });
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("the read did not answer"), true);
  assert.equal(text.includes("exited 1"), true);
  assert.equal(text.includes("Reading the machine"), false);
});

test("a machine that keeps failing is asked again on the interval, not on every paint", async () => {
  const driven = stub({ exitCode: 1 });
  await driven.start();
  await driven.settle();
  const reads = driven.calls.argv.length;
  // The clock has not moved between these paints. A failure that carried no
  // time would read as stale forever, so each paint would start another read
  // and a machine that refuses would be hammered for as long as the pane is up.
  await driven.render();
  await driven.render();
  await driven.settle();
  assert.equal(driven.calls.argv.length, reads);
});

test("a machine that keeps failing is read again once the interval has passed", async () => {
  const driven = stub({ exitCode: 1 });
  await driven.start();
  await driven.settle();
  const reads = driven.calls.argv.length;
  // Holding the interval is one half of the rule and the cheaper half to test.
  // This is the other: time passing is the only thing that makes a failure
  // stale, so a pane that held forever would leave a fleet the machine had
  // already moved on from on screen until the session ended.
  driven.advance(STALE_SECONDS + 1);
  await driven.render();
  await drain();
  assert.equal(driven.calls.argv.length, reads + 1);
});

/** A reading as the store holds it for every session, with a governor run live in it. */
function liveReading(at: number, done: number): Record<string, unknown> {
  return { at, documents: { ...OUTPUT, progress: { state: "ready", errors: [], runs: [{
    key: "e8623195", repo: "owner/project", branch: "", label: "tests", display: "tests",
    done, total: 3444, failed: 0, first_failure: "", elapsed: 22, eta_minutes: 3,
    phase: "run", kind: "run", command_class: "targeted-test",
  }] } } };
}

test("a paused live reading replaces cached governor rows and is shared", async () => {
  const memory: Record<string, unknown> = {};
  const paused = { state: "paused", runs: [], errors: [] };
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory,
    answer: (argv) => argv.includes("--only")
      ? { exitCode: 0, stdout: JSON.stringify({ progress: paused }) } : undefined });
  await driven.start();
  await driven.run();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Running is paused."), true, text);
  assert.equal(text.includes("290"), false, text);
  assert.deepEqual((memory[COUNTS_KEY] as { progress: unknown }).progress, paused);
});

test("a paused stored reading replaces live counts and resumes on a later ready reading", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory });
  await driven.start();
  await drain();
  memory[COUNTS_KEY] = { at: 1790000000,
    progress: (liveReading(0, 350).documents as { progress: unknown }).progress };
  driven.tick(LOOK_MS);
  await drain();
  await driven.render();
  memory[READING_KEY] = { at: 1790000001, progressAt: 1790000001, documents: {
    ...OUTPUT, progress: { state: "paused", runs: [], errors: [] },
    trials: { state: "paused", running: [], recent: [], changes: [], errors: [] },
  } };
  driven.advance(1);
  driven.tick(LOOK_MS);
  await drain();
  let text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Running is paused."), true, text);
  assert.equal(text.includes("350"), false, text);
  assert.equal(text.includes("Trials is paused."), true, text);
  memory[READING_KEY] = liveReading(1790000002, 500);
  driven.advance(1);
  driven.tick(LOOK_MS);
  await drain();
  text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("500"), true, text);
  assert.equal(text.includes("Running is paused."), false, text);
});

test("a paused whole reading clears counts read while it was running", async () => {
  const paused = { ...OUTPUT, progress: { state: "paused", runs: [], errors: [] },
                   trials: { state: "paused", running: [], recent: [], changes: [], errors: [] } };
  const driven = stub({ held: false, stored: liveReading(1790000000 - STALE_SECONDS, 290),
    stdout: JSON.stringify(paused),
    answer: (argv) => argv.includes("--only") ? countsAnswer(400) : undefined });
  await driven.start();
  await driven.run();
  await drain();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  driven.tick(LIVE_MS);
  await drain();
  await driven.settle();
  await drain();
  await driven.render();
  driven.tick(STREAM_MS);
  driven.advance(1);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Running is paused."), true, text);
  assert.equal(text.includes("Trials is paused."), true, text);
  assert.equal(text.includes("400"), false, text);
});

test("a fresh reading another session took is drawn here without reading the machine again", async () => {
  // Two panes side by side showed two moments, an interval apart, because each
  // session read the machine on its own. The one the store holds is the one
  // every session draws while it is fresh.
  const driven = stub({ held: false, stored: { at: 1790000000 - 5, documents: OUTPUT } });
  await driven.start();
  await drain();
  assert.equal(driven.calls.argv.length, 0);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Review adapter behavior"), true);
  assert.equal(text.includes("Updated 5s ago"), true);
});

test("a session reads the machine for everyone only while no other session has claimed it", async () => {
  const driven = stub({ held: false, memory: { [CLAIM_KEY]: { at: 1790000000 - 2, by: "another" } } });
  await driven.start();
  await drain();
  assert.equal(driven.calls.argv.length, 0, "read while another session held the claim");
  // A claim older than a read could take is one whose session died mid-read.
  driven.advance(40);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 1);
  assert.equal(driven.calls.claims.at(-1)?.key, CLAIM_KEY);
});

test("a session that read lets its claim go and writes the reading before it does", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  await drain();
  const claims = driven.calls.claims.filter((entry) => entry.key === CLAIM_KEY)
    .map((entry) => (entry.value as { at: number }).at);
  // Taken at this clock, then let go: the next session to find the reading old
  // may read without waiting out a claim nobody holds.
  assert.deepEqual(claims, [1790000000, 0]);
  assert.equal(driven.calls.stored.filter((entry) => entry.key === READING_KEY).length, 1);
});

test("a newer reading another session wrote is drawn on the next look, and an older one is not", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: OUTPUT }, memory });
  await driven.start();
  await drain();
  const invalidated = driven.calls.invalidated.length;
  driven.tick(LOOK_MS);
  await drain();
  // Nothing new: a look that finds the same reading draws nothing.
  assert.equal(driven.calls.invalidated.length, invalidated);
  const before = renderedText(await driven.render() as never).join("\n");
  assert.equal(before.includes("Review adapter behavior"), true);
  // An older one than this session holds is not drawn over it.
  memory[READING_KEY] = { at: 1790000000 - 60,
                          documents: { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [] } } };
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.invalidated.length, invalidated);
  // Another session read the machine since: the next look draws what it read.
  memory[READING_KEY] = { at: 1790000000,
                          documents: { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [] } } };
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.invalidated.length, invalidated + 1);
  // The row that left slides out first; once it has, it is gone.
  await driven.render();
  driven.advance(1);
  const after = renderedText(await driven.render() as never).join("\n");
  assert.equal(after.includes("Review adapter behavior"), false);
  assert.equal(driven.calls.argv.length, 0);
});

test("while a governor run is live its counts are read on their own, every few seconds", async () => {
  let done = 290;
  const driven = stub({
    held: false, stored: liveReading(1790000000 - 1, 290),
    answer: (argv) => argv.includes("--only")
      ? { exitCode: 0, stdout: JSON.stringify({ generated_at: 1790000000,
                                               progress: (liveReading(0, done).documents as
                                                 { progress: unknown }).progress }) }
      : undefined,
  });
  await driven.start();
  await driven.run();
  await drain();
  // Fresh as a whole: no whole read, and the counts not yet old.
  assert.equal(driven.calls.argv.length, 0);
  done = 388;
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.argv.map((argv) => argv.slice(2)), [["--only", "progress"]]);
  // The counts are kept under their own key with their own time, and the whole
  // reading is not written at all: a count read has nothing to say about the rest.
  const kept = driven.calls.stored.filter((entry) => entry.key === COUNTS_KEY).at(-1)?.value as
    { at: number; progress: { runs: { done: number }[] } };
  assert.equal(kept.at, 1790000000 + LIVE_MS / 1000);
  assert.equal(kept.progress.runs[0].done, 388);
  assert.deepEqual(driven.calls.stored.filter((entry) => entry.key === READING_KEY), []);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("388"), true);
});

test("the whole reading still ages while a governor run's counts are read on their own", async () => {
  const driven = stub({
    held: false, stored: liveReading(1790000000 - 1, 290),
    answer: (argv) => argv.includes("--only")
      ? { exitCode: 0, stdout: JSON.stringify({ generated_at: 1790000000,
                                               progress: (liveReading(0, 300).documents as
                                                 { progress: unknown }).progress }) }
      : undefined,
  });
  await driven.start();
  await driven.run();
  await drain();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.argv.map((argv) => argv.slice(2)), [["--only", "progress"]]);
  // Fresh counts are not a fresh reading: the rest of the pane was read when it
  // was, and once that is old the whole machine is read, live run or not.
  // Twenty seconds after the whole reading was read, nineteen after the counts:
  // the rest of the pane is due, though the counts on their own would not be.
  driven.advance(STALE_SECONDS - LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.argv.at(-1)?.slice(2), READ_ARGV);
});

test("a count read never writes the whole reading, so a newer one another session wrote stands", async () => {
  // Another session reads the whole machine while this one reads the counts. A
  // count read that wrote the whole reading back could put this session's older
  // fleet over the newer one, and every session would draw it.
  const memory: Record<string, unknown> = {};
  // Its read began before this session's counts were read, so its own counts are older.
  const newer = { at: 1790000000 + 1, progressAt: 1790000000,
                  documents: { ...liveReading(0, 0).documents as Record<string, unknown>,
                               roster: { ...OUTPUT.roster, jobs: [] } } };
  const driven = stub({
    held: false, stored: liveReading(1790000000 - 1, 290), memory,
    answer: (argv) => {
      if (!argv.includes("--only")) {
        return undefined;
      }
      memory[READING_KEY] = newer;
      return { exitCode: 0, stdout: JSON.stringify({ generated_at: 1790000000,
                                                    progress: (liveReading(0, 388).documents as
                                                      { progress: unknown }).progress }) };
    },
  });
  await driven.start();
  await driven.run();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.stored.filter((entry) => entry.key === READING_KEY), []);
  assert.equal(memory[READING_KEY], newer);
  // The next look draws the newer fleet, with the counts this session read on it.
  driven.tick(LIVE_MS);
  await drain();
  await driven.render();
  driven.advance(1);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("Review adapter behavior"), false);
  assert.equal(text.includes("388"), true);
});

test("a live run's counts younger than the progress interval are not read again", async () => {
  const driven = stub({ held: false, stored: liveReading(1790000000, 290) });
  await driven.start();
  await driven.run();
  driven.tick(LOOK_MS);
  await drain();
  // Read this second: the pane draws them as they are until a second has passed.
  assert.equal(driven.calls.argv.length, 0);
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.argv.map((argv) => argv.slice(2)), [["--only", "progress"]]);
});

test("a reading the paint found keeps its counts' own age, so a live run's counts are read when due", async () => {
  // The paint finds the reading the last session left before the session's
  // first look, so the look finds nothing newer and keeps what the paint held.
  // Its counts are older than the reading itself, and due.
  const driven = stub({ held: false,
                        stored: { ...liveReading(1790000000, 290), progressAt: 1789999995 } });
  await driven.band();
  await drain();
  await driven.start();
  await drain();
  await driven.run();
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.argv.map((argv) => argv.slice(2)), [["--only", "progress"]]);
});

test("with the pane shut, a live run's counts wait for the whole reading", async () => {
  // The band does not draw a run's counts, so reading them every second for a
  // pane nobody opened would be a read nothing shows.
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290) });
  await driven.start();
  await drain();
  assert.deepEqual(driven.calls.every.filter((ms) => ms === LIVE_MS), []);
  driven.advance(LIVE_MS / 1000 + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 0);
});

test("the look runs every few seconds, and every second while an open pane shows a live run", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({
    held: false, stored: liveReading(1790000000 - 1, 290), memory,
    answer: (argv) => argv.includes("--only")
      ? { exitCode: 0, stdout: JSON.stringify({ generated_at: 1790000000,
                                               progress: (liveReading(0, 300).documents as
                                                 { progress: unknown }).progress }) }
      : undefined,
  });
  await driven.start();
  await drain();
  assert.deepEqual(driven.calls.every.filter((ms) => ms === LOOK_MS || ms === LIVE_MS), [LOOK_MS]);
  await driven.run();
  driven.tick(LOOK_MS);
  await drain();
  // The faster look starts once there is a run to show and a pane to show it.
  assert.deepEqual(driven.calls.every.filter((ms) => ms === LOOK_MS || ms === LIVE_MS),
                   [LOOK_MS, LIVE_MS]);
  // And the look slows again once there is not: the run ended.
  memory[READING_KEY] = { at: 1790000000 + 1, documents: OUTPUT };
  driven.advance(1);
  const cancelled = driven.calls.cancelled;
  driven.tick(LIVE_MS);
  await drain();
  assert.equal(driven.calls.cancelled > cancelled, true, "the fast look was never stopped");
  assert.deepEqual(driven.calls.every.filter((ms) => ms === LOOK_MS || ms === LIVE_MS),
                   [LOOK_MS, LIVE_MS, LOOK_MS]);
});

test("how old the shared reading may get comes from the reading", async () => {
  // A configuration that lets the reading age longer is one every session keeps
  // to, since every session draws the reading that carries it.
  const documents = { ...OUTPUT, alerts: { state: "ready", snapshotSeconds: 45 } };
  const driven = stub({ held: false, stored: { at: 1790000000, documents } });
  await driven.start();
  await drain();
  driven.advance(STALE_SECONDS + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 0, "read before the configured age");
  driven.advance(45 - STALE_SECONDS);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 1);
});

test("with no governor run live, the counts are not read on their own", async () => {
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: OUTPUT } });
  await driven.start();
  await drain();
  driven.advance(LIVE_MS / 1000 + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 0);
});

test("a reader that printed valid JSON which is not a reading is named", async () => {
  // "null" parses. Left as a document it draws as a read still in flight, so a
  // reader that answered with nothing would look like a machine being patient.
  for (const stdout of ["null", "[]", "{}"] as string[]) {
    const driven = stub({ stdout });
    await driven.start();
    await driven.settle();
    const text = renderedText(await driven.render() as never).join("\n");
    assert.equal(text.includes("Reading the machine"), false, stdout);
    assert.equal(text.includes("0 working"), false, stdout);
    assert.equal(text.includes("Could not read"), true, stdout);
  }
});

test("a reader that printed something other than JSON is named too", async () => {
  const driven = stub({ stdout: "not json at all" });
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  // Named as a failure, not drawn as a quiet machine.
  assert.equal(text.includes("the read did not answer"), true);
  assert.equal(text.includes("Review adapter behavior"), false);
});

test("a reader that throws is named rather than left as a blank pane", async () => {
  const driven = stub();
  driven.engine.process.run = async () => { throw new Error("python3 is not on the path"); };
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("python3 is not on the path"), true);
});

test("a run the host cancelled is not drawn as a failed read", async () => {
  // Scrolling the pane supersedes the paint a read was started from, and the
  // host kills the child. Nothing was read and nothing was refused, so the pane
  // must not report a fleet it never asked about: it holds what it held and
  // asks again. Drawn as a failure, this read "Could not read the fleet" over a
  // machine that was never consulted.
  const driven = stub();
  const abort = Object.assign(new Error("fleet: $.process.run(python3) aborted"),
                              { name: "AbortError" });
  driven.engine.process.run = async (): Promise<never> => { throw abort; };
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("aborted"), false);
  assert.equal(text.includes("Could not read"), false);
  assert.equal(text.includes("Reading the machine"), true);
});

test("a refused configuration is drawn as the refusal it is", async () => {
  // The reader answers a refusal on its standard output and exits nonzero, so
  // the errors it printed arrive with a failing exit. Reading only the code
  // would throw them away and leave the pane naming an exit status.
  const driven = stub({ exitCode: 2,
                        stdout: JSON.stringify({ configErrors: [{ code: "E_CONFIG_TYPE", path: "pane.width" }] }) });
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("E_CONFIG_TYPE pane.width"), true);
  assert.equal(text.includes("exited 2"), false);
});

test("a failed run that printed nothing usable is named by its exit code", async () => {
  const driven = stub({ exitCode: 2, stdout: "the config file is not readable" });
  await driven.start();
  await driven.settle();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("exited 2"), true);
});

test("a refused configuration is not kept for the next session to open on", async () => {
  const driven = stub({ exitCode: 2,
                        stdout: JSON.stringify({ configErrors: [{ code: "E_CONFIG_TYPE", path: "pane.width" }] }) });
  await driven.start();
  await driven.settle();
  assert.deepEqual(driven.calls.stored, []);
});

test("the pane is drawn into the room the surface reports", async () => {
  const driven = stub();
  await driven.start();
  await driven.settle();
  const tree = await driven.render(60);
  const lines = renderedText(tree as never);
  // The pane's own inset is eight columns; a narrow surface still draws rows.
  assert.equal(lines.length > 1, true);
  assert.equal(lines.some((line) => line.includes("Review adapter behavior")), true);
});

/** Lets every chain in flight run, a bounded number of turns. */
/** What the read command prints when it reads a live run's counts alone. */
function countsAnswer(done: number, state = "ready"): { exitCode: number; stdout: string } {
  const progress = state === "ready"
    ? (liveReading(0, done).documents as { progress: unknown }).progress
    : { state, runs: [], errors: [{ source: "progress", reason: "could not list the directory" }] };
  return { exitCode: 0, stdout: JSON.stringify({ generated_at: 1790000000, progress }) };
}

/**
 * Lands one more reading another session took, so this session's record of
 * what it has seen starts from it: the reading a session starts on is drawn
 * before the session's identifier is known, and the first one after is the
 * record rather than news.
 */
async function recorded(driven: Stub, memory: Record<string, unknown>,
                        documents: unknown): Promise<void> {
  memory[READING_KEY] = { at: 1790000000 - 0.5, documents };
  driven.tick(LOOK_MS);
  await drain();
}

/** A job that has started waiting on a person, for the cases that look for its news. */
const WAITING = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
  { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
    started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
] } };

test("a live run's counts are read on every look, though the timer fires a little early", async () => {
  // A timer is not exact: one that fires a few milliseconds short of its
  // interval found the counts not yet due and skipped, so they moved every
  // other interval.
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290),
                        answer: (argv) => argv.includes("--only") ? countsAnswer(300) : undefined });
  await driven.start();
  await driven.run();
  await drain();
  for (let look = 0; look < 4; look += 1) {
    driven.advance(LIVE_MS / 1000 - 0.05);
    driven.tick(LOOK_MS);
    driven.tick(LIVE_MS);
    await drain();
  }
  assert.equal(driven.calls.argv.filter((argv) => argv.includes("--only")).length, 4);
});

test("a live run's counts are dated when the look read them, not when the read came back", async () => {
  // A read that takes most of an interval, dated when it finished, leaves the
  // next look short of due, and the counts move every other interval. The
  // clock moves one interval from look to look, the read's time included.
  let driven: Stub | null = null;
  let spent = 0;
  driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), answer: (argv) => {
    if (!argv.includes("--only")) {
      return undefined;
    }
    spent = 0.6;
    driven?.advance(spent);
    return countsAnswer(300);
  } });
  await driven.start();
  await driven.run();
  await drain();
  for (let look = 0; look < 4; look += 1) {
    spent = 0;
    driven.tick(LOOK_MS);
    driven.tick(LIVE_MS);
    await drain();
    driven.advance(LIVE_MS / 1000 - spent);
  }
  assert.equal(driven.calls.argv.filter((argv) => argv.includes("--only")).length, 4);
});

test("a count read takes the counts' own claim, lets it go, and waits while another session holds it", async () => {
  const memory: Record<string, unknown> = {
    [PROGRESS_CLAIM_KEY]: { at: 1790000000, by: "another" } };
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory,
                        answer: (argv) => argv.includes("--only") ? countsAnswer(300) : undefined });
  await driven.start();
  await driven.run();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 0, "read the counts while another session held their claim");
  memory[PROGRESS_CLAIM_KEY] = { at: 0, by: "another" };
  driven.advance(LIVE_MS / 1000);
  driven.tick(LIVE_MS);
  await drain();
  assert.deepEqual(driven.calls.argv.map((argv) => argv.slice(2)), [["--only", "progress"]]);
  const own = driven.calls.claims.filter((entry) => entry.key === PROGRESS_CLAIM_KEY)
    .map((entry) => (entry.value as { at: number }).at);
  assert.deepEqual(own, [1790000000 + 2 * LIVE_MS / 1000, 0]);
});

test("a session whose claim was taken over mid-read leaves the other session's claim standing", async () => {
  // Letting it go would let a third session read beside the one that took it.
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, memory });
  await driven.start();
  await drain();
  assert.equal(driven.calls.argv.length, 1);
  const taken = { at: 1790000000 + 40, by: "another" };
  memory[CLAIM_KEY] = taken;
  await driven.settle();
  await drain();
  assert.deepEqual(memory[CLAIM_KEY], taken);
});

test("the reading is written before the claim is let go, so the next session to claim finds it", async () => {
  const driven = stub({ slowStore: true });
  await driven.start();
  await driven.settle();
  await drain();
  const keys = driven.calls.written.map((entry) => entry.key === CLAIM_KEY
    ? (entry.value as { at: number }).at === 0 ? "released" : "claimed" : entry.key);
  assert.deepEqual(keys.filter((key) => key === READING_KEY || key === "claimed" || key === "released"),
                   ["claimed", READING_KEY, "released"]);
});

test("a reading from a build that read on its own interval does not slow every session", async () => {
  // That build carried its thirty-second interval in every reading, and a
  // session drawing it would look every thirty seconds, and drift apart again.
  const memory: Record<string, unknown> = {};
  const old = { ...OUTPUT, alerts: { state: "ready", snapshotMs: 30_000 } };
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: old }, memory });
  await driven.start();
  await drain();
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.every.filter((ms) => ms === 30_000), []);
  // A reading of this build carries an interval it means.
  memory[READING_KEY] = { at: 1790000000, documents: { ...OUTPUT, alerts: {
    state: "ready", snapshotMs: 6_000, snapshotSeconds: STALE_SECONDS, progressMs: LIVE_MS } } };
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.every.at(-1), 6_000);
});

test("how old the reading may get comes from a reading this session took too", async () => {
  const driven = stub({ stdout: JSON.stringify({ ...OUTPUT, alerts: {
    state: "ready", snapshotSeconds: 45, progressMs: LIVE_MS } }) });
  await driven.start();
  await driven.settle();
  await drain();
  assert.equal(driven.calls.argv.length, 1);
  driven.advance(STALE_SECONDS + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 1, "read before the configured age");
  driven.advance(45 - STALE_SECONDS);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 2);
});

test("a reading or a claim dated a moment ahead is current, and one dated far ahead is not", async () => {
  // Another session writes between this session's clock and its store read, so
  // a reading dated a moment ahead is the store being quick: reading the whole
  // machine again for it cost a read of up to a few seconds.
  const quick = stub({ held: false, stored: { at: 1790000000 + AHEAD_SECONDS / 2, documents: OUTPUT } });
  await quick.start();
  await drain();
  assert.equal(quick.calls.argv.length, 0, "read again for a reading a moment ahead");
  const claimed = stub({ held: false, memory: {
    [CLAIM_KEY]: { at: 1790000000 + AHEAD_SECONDS / 2, by: "another" } } });
  await claimed.start();
  await drain();
  assert.equal(claimed.calls.argv.length, 0, "took over a claim a moment ahead");
  // A claim dated an hour ahead is a clock that is wrong, and it would hold
  // every session off for that hour.
  const wrong = stub({ held: false, memory: { [CLAIM_KEY]: { at: 1790000000 + 3600, by: "another" } } });
  await wrong.start();
  await drain();
  assert.equal(wrong.calls.argv.length, 1);
});

test("a look still out when the session ends does not start the timer again", async () => {
  const driven = stub({ held: false });
  await driven.start();
  await drain();
  const started = driven.calls.every.length;
  await driven.end();
  await driven.settle();
  await drain();
  // The end's own bound on the writes it waits for is no look timer.
  assert.equal(driven.calls.every.filter((ms) => ms !== END_WRITES_MS).length, started);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 1, "looked after the session ended");
});

test("a count read the read command reports failed leaves the counts and the pace standing", async () => {
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290),
                        answer: (argv) => argv.includes("--only") ? countsAnswer(0, "failed") : undefined });
  await driven.start();
  await driven.run();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.filter((argv) => argv.includes("--only")).length, 1);
  assert.deepEqual(driven.calls.stored.filter((entry) => entry.key === READING_KEY), []);
  assert.equal(driven.calls.every.at(-1), LIVE_MS);
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("290"), true);
});

test("an open pane with no run counting does not read counts", async () => {
  // The read command answers a progress directory with nothing live as an empty
  // list of runs, not as no list.
  const none = { ...OUTPUT, progress: { state: "empty", runs: [], errors: [] } };
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: none } });
  await driven.start();
  await driven.run();
  driven.advance(LIVE_MS / 1000 + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.length, 0);
  assert.deepEqual(driven.calls.every.filter((ms) => ms === LIVE_MS), []);
});

test("news in a reading another session took is raised here, where this session never reads", async () => {
  const memory: Record<string, unknown> = {};
  // The read is held, so a read of the machine would never answer: the helper
  // that says this session is focused answers at once.
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: OUTPUT }, memory,
                        answer: (argv) => argv[1]?.endsWith("alerts.py")
                          ? { exitCode: 0, stdout: "" } : undefined });
  await driven.start();
  await drain();
  await recorded(driven, memory, OUTPUT);
  assert.deepEqual(driven.calls.toasts, []);
  driven.advance(1);
  memory[READING_KEY] = { at: 1790000000 + 1, documents: WAITING };
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.toasts, ["fleet: Job needs you: Port the voice"]);
  assert.equal(driven.calls.argv.filter((argv) => !argv[1]?.endsWith("alerts.py")).length, 0);
});

test("news in a newer reading written while this session counted is raised on the next look", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory,
    answer: (argv) => {
      if (argv[1]?.endsWith("alerts.py")) {
        return { exitCode: 0, stdout: "" };
      }
      if (!argv.includes("--only")) {
        return undefined;
      }
      memory[READING_KEY] = { at: 1790000000 + 1, documents: {
        ...WAITING, progress: (liveReading(0, 0).documents as { progress: unknown }).progress } };
      return countsAnswer(388);
    } });
  await driven.start();
  await drain();
  await recorded(driven, memory, liveReading(0, 290).documents);
  assert.deepEqual(driven.calls.toasts, []);
  await driven.run();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  // The count read drew its counts and nothing else; the next look finds the
  // newer whole reading and raises what is new in it.
  assert.deepEqual(driven.calls.toasts, []);
  driven.tick(LIVE_MS);
  await drain();
  assert.deepEqual(driven.calls.toasts, ["fleet: Job needs you: Port the voice"]);
});

test("a count read redraws the pane once, and a look after it with nothing new draws nothing", async () => {
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290),
                        answer: (argv) => argv.includes("--only") ? countsAnswer(300) : undefined });
  await driven.start();
  await driven.run();
  await drain();
  const before = driven.calls.invalidated.length;
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.invalidated.length, before + 1);
  driven.tick(LIVE_MS);
  await drain();
  assert.equal(driven.calls.invalidated.length, before + 1);
  assert.equal(driven.calls.argv.length, 1);
});

test("this session's figures are asked for with a new whole reading, not with new counts", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory });
  await driven.start();
  await drain();
  const asked = driven.calls.usage;
  assert.equal(asked > 0, true);
  memory[READING_KEY] = { ...liveReading(1790000000 - 1, 300), progressAt: 1790000000 };
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.usage, asked, "asked again for new counts alone");
  driven.advance(1);
  memory[READING_KEY] = liveReading(1790000000 + 1, 300);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.usage, asked + 1);
});

test("a live run's counts keep streaming while the whole machine is read", async () => {
  // A whole read takes one to three seconds. The counts used to wait it out, so a
  // pane streaming a run's counts froze for that long every twenty seconds and
  // then jumped.
  let done = 290;
  const driven = stub({ held: false, stored: liveReading(1790000000 - STALE_SECONDS, 290),
                        answer: (argv) => argv.includes("--only") ? countsAnswer(done) : undefined });
  await driven.start();
  await driven.run();
  await drain();
  // The whole reading is due, and its read is out and held.
  assert.deepEqual(driven.calls.argv.map((argv) => argv.slice(2)), [READ_ARGV]);
  for (const next of [300, 310, 320]) {
    done = next;
    driven.advance(LIVE_MS / 1000);
    driven.tick(LOOK_MS);
    driven.tick(LIVE_MS);
    await drain();
    const text = renderedText(await driven.render() as never).join("\n");
    assert.equal(text.includes(String(next)), true, `the counts stood still at ${next}`);
  }
  assert.equal(driven.calls.argv.filter((argv) => argv.includes("--pretty")).length, 1);
});

test("a whole read that lands keeps the counts read while it ran, never stepping a run back", async () => {
  // The whole read reads the counts as it starts. Counts read since are newer,
  // and drawing the whole read's own would step the run backwards for a second.
  const driven = stub({ held: false, stored: liveReading(1790000000 - STALE_SECONDS, 290),
                        stdout: JSON.stringify(liveReading(0, 295).documents),
                        answer: (argv) => argv.includes("--only") ? countsAnswer(400) : undefined });
  await driven.start();
  await driven.run();
  await drain();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  driven.tick(LIVE_MS);
  await drain();
  assert.equal(renderedText(await driven.render() as never).join("\n").includes("400"), true);
  await driven.settle();
  await drain();
  const text = renderedText(await driven.render() as never).join("\n");
  assert.equal(text.includes("400"), true, "the counts stepped back to the whole read's own");
  assert.equal(text.includes("295"), false);
});

test("a whole read is not written over a newer whole reading another session wrote", async () => {
  // Two sessions read at once when a claim lapses, and the one that finishes
  // last is not the one that read last.
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, memory });
  await driven.start();
  await drain();
  const newer = { at: 1790000000 + 1, progressAt: 1790000000, documents: OUTPUT };
  memory[READING_KEY] = newer;
  await driven.settle();
  await drain();
  assert.deepEqual(driven.calls.stored.filter((entry) => entry.key === READING_KEY), []);
  assert.equal(memory[READING_KEY], newer);
});

test("a count read is not written over newer counts another session wrote", async () => {
  const memory: Record<string, unknown> = {};
  const newer = { at: 1790000000 + 5,
                  progress: (liveReading(0, 500).documents as { progress: unknown }).progress };
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory,
    answer: (argv) => {
      if (!argv.includes("--only")) {
        return undefined;
      }
      memory[COUNTS_KEY] = newer;
      return countsAnswer(388);
    } });
  await driven.start();
  await driven.run();
  driven.advance(LIVE_MS / 1000);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.stored.filter((entry) => entry.key === COUNTS_KEY), []);
  assert.equal(memory[COUNTS_KEY], newer);
});

test("counts another session read are drawn here, and older ones are not", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory });
  await driven.start();
  await drain();
  memory[COUNTS_KEY] = { at: 1790000000,
                         progress: (liveReading(0, 350).documents as { progress: unknown }).progress };
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(renderedText(await driven.render() as never).join("\n").includes("350"), true);
  // Counts read before the ones drawn are not drawn over them.
  memory[COUNTS_KEY] = { at: 1790000000 - 0.5,
                         progress: (liveReading(0, 340).documents as { progress: unknown }).progress };
  const before = driven.calls.invalidated.length;
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.invalidated.length, before);
  assert.equal(renderedText(await driven.render() as never).join("\n").includes("350"), true);
  // A count read that failed is not drawn as counts.
  memory[COUNTS_KEY] = { at: 1790000000 + 1, progress: { state: "failed", runs: [] } };
  driven.tick(LOOK_MS);
  await drain();
  // Past any slide: a run row that left would still be drawn while it slides out.
  await driven.render();
  driven.advance(1);
  assert.equal(renderedText(await driven.render() as never).join("\n").includes("350"), true);
  assert.equal(driven.calls.argv.length, 0);
});

test("paints while this session reads the whole machine do not each look at the store", async () => {
  const driven = stub({ held: false, stored: { at: 1790000000 - STALE_SECONDS - 1, documents: OUTPUT } });
  await driven.start();
  await drain();
  assert.equal(driven.calls.argv.length, 1);
  const looked = driven.calls.gets.filter((key) => key === READING_KEY).length;
  for (let paint = 0; paint < 5; paint += 1) {
    await driven.render();
    await drain();
  }
  assert.equal(driven.calls.gets.filter((key) => key === READING_KEY).length, looked);
  assert.equal(driven.calls.argv.length, 1);
});

test("a reading from a build that folded its counts into the whole reading is still drawn", async () => {
  // Sessions started before the counts were kept apart write them into the
  // whole reading, under its own time, with the counts' time beside it.
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290), memory });
  await driven.start();
  await drain();
  memory[READING_KEY] = { ...liveReading(1790000000 - 1, 360), progressAt: 1790000000 };
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(renderedText(await driven.render() as never).join("\n").includes("360"), true);
});

async function drain(turns = 60): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a job that starts waiting is toasted here, and notified and said by the session that claims it", async () => {
  let reading: unknown = OUTPUT;
  const helped: string[][] = [];
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
  ] } };
  const driven = stub({ notify: true, memory: { [SPEECH_ON_KEY]: SPOKEN }, answer: (argv) => {
    if (!argv[1]?.endsWith("alerts.py")) {
      return { exitCode: 0, stdout: JSON.stringify(reading) };
    }
    helped.push(argv.slice(2));
    if (argv[2] === "voices") {
      return { exitCode: 0, stdout: JSON.stringify({ state: "ready", reason: null, group: "female",
        voice: null, voices: { female: ["af_sky"], male: [] } }) };
    }
    if (argv[2] === "speak") {
      return { exitCode: 0, stdout: JSON.stringify({ file: "/t/fleet-speak-a.wav", reason: null }) };
    }
    return { exitCode: 0, stdout: "" };
  } });
  await driven.start();
  await drain();
  // The first fresh reading this session sees is the record, not news.
  driven.advance(60);
  await driven.render();
  await drain();
  assert.deepEqual(driven.calls.toasts, []);
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.deepEqual(driven.calls.toasts, ["fleet: Job needs you: Port the voice"]);
  assert.deepEqual(driven.calls.notified, ["Job needs you: Port the voice"]);
  assert.equal(driven.calls.played, 1);
  const spoken = helped.find((args) => args[0] === "speak");
  assert.deepEqual(spoken, ["speak", "--voice=af_sky", "--", "Hey, Port the voice is waiting on you."]);
  assert.ok(helped.some((args) => args[0] === "discard" && args[1] === "/t/fleet-speak-a.wav"));
  // The same reading again is not news a second time.
  driven.advance(60);
  await driven.render();
  await drain();
  assert.equal(driven.calls.toasts.length, 1);
  assert.equal(driven.calls.played, 1);
});

test("a session that did not take the claim neither notifies nor speaks, and an unfocused one shows no toast", async () => {
  let reading: unknown = OUTPUT;
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
  ] } };
  const driven = stub({ notify: true, answer: (argv) => {
    if (!argv[1]?.endsWith("alerts.py")) {
      return { exitCode: 0, stdout: JSON.stringify(reading) };
    }
    // Another session is focused, and another session took the claim.
    return { exitCode: 1, stdout: "" };
  } });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.deepEqual(driven.calls.toasts, []);
  assert.deepEqual(driven.calls.notified, []);
  assert.equal(driven.calls.played, 0);
});

test("a prompt marks this session as the one the person is typing in", async () => {
  const helped: string[][] = [];
  const driven = stub({ answer: (argv) => {
    if (argv[1]?.endsWith("alerts.py")) {
      helped.push(argv.slice(2));
      return { exitCode: 0, stdout: "" };
    }
    return undefined;
  } });
  await driven.start();
  await drain();
  const result = await driven.prompt("hello") as { continued?: boolean };
  assert.equal(result.continued, true);
  await drain(5);
  assert.deepEqual(helped, [["focus", "stub-session"]]);
});


test("this session's section draws what the engine reports, not an empty file", async () => {
  const driven = stub({ usage: { startedAt: 1789996400000, cost: { usd: 2.5 },
                                 context: { window: 200000, percent: 10 }, rateLimits: [] } });
  await driven.start();
  await drain();
  const text = renderedText(await driven.quiesce(120) as never).join("\n");
  assert.equal(text.includes("$2.50"), true, text);
  assert.equal(text.includes("stub-model"), true);
});

/** Every alt of every Svg a drawing holds. */
function vectorAlts(node: unknown): string[] {
  if (node === null || typeof node !== "object") {
    return [];
  }
  const record = node as { type?: string; props?: { alt?: unknown }; children?: unknown };
  const own = record.type === "Svg" && typeof record.props?.alt === "string" ? [record.props.alt] : [];
  const children = Array.isArray(record.children) ? record.children : [];
  return [...own, ...children.flatMap(vectorAlts)];
}

test("the entry hands the surface's name to the binding: vectors on the desktop, cells on the terminal", async () => {
  const usage = { startedAt: 1789996400000, cost: { usd: 2.5 },
                  context: { window: 200000, percent: 10 }, rateLimits: [] };
  const desktop = stub({ usage, surface: "desktop" });
  await desktop.start();
  await drain();
  const drawn = await desktop.quiesce(120);
  assert.equal(vectorAlts(drawn).some((alt) => alt.startsWith("Cost (API):")), true,
               JSON.stringify(vectorAlts(drawn)));
  const terminal = stub({ usage });
  await terminal.start();
  await drain();
  const cells = await terminal.quiesce(120);
  assert.deepEqual(vectorAlts(cells), []);
  assert.equal(renderedText(cells as never).includes("Cost (API)"), true);
});

test("an engine that reports no usage leaves the reading's session document standing", async () => {
  const driven = stub();
  await driven.start();
  await drain();
  const text = renderedText(await driven.quiesce(120) as never).join("\n");
  assert.equal(text.includes("stub-model"), false);
});

test("paints while a read is out ask the engine for this session once, not on every frame", async () => {
  // A paint while the reading is stale asks for a reading, and each ask used to
  // ask the engine for this session's figures too, whose answer asked for a
  // paint: sixty frames a second for as long as the read was out.
  const driven = stub({ held: false, usage: { startedAt: 1789996400000, cost: { usd: 1 },
                                              context: { window: 200000, percent: 5 },
                                              rateLimits: [] } });
  let asked = 0;
  const usage = driven.engine.session.usage;
  driven.engine.session.usage = async (...args) => { asked += 1; return usage(...args); };
  await driven.start();
  await drain();
  for (let paint = 0; paint < 20; paint += 1) {
    await driven.render();
    await drain(5);
  }
  assert.equal(asked, 1, "the engine was asked for this session " + asked + " times");
  // One frame for the figures landing; the read is still out, so nothing else.
  assert.ok(driven.calls.invalidated.length <= 1,
            driven.calls.invalidated.length + " frames asked for while one read was out");
  // Once the read lands the pane draws again, and the figures are still there.
  await driven.settle();
  const text = renderedText(await driven.quiesce(120) as never).join("\n");
  assert.equal(text.includes("$1.00"), true, text);
});

test("a row that arrives runs frames while it slides in, and they stop once it is in place", async () => {
  let reading: unknown = OUTPUT;
  const driven = stub({ answer: (argv) => argv[1]?.endsWith("alerts.py")
    ? { exitCode: 0, stdout: "" }
    : { exitCode: 0, stdout: JSON.stringify(reading) } });
  await driven.start();
  await drain();
  await driven.quiesce(120);
  // The first reading is what the pane opened on: nothing arrived, nothing runs.
  assert.equal(driven.calls.every.filter((ms) => ms === FRAME_MS).length, 0);
  reading = { ...OUTPUT, prs: { state: "ready", errors: [], prs: [
    { repo: "owner/project", number: 7, title: "New pull request", branch: "b", head: "",
      is_draft: false, checks: "pass" }] } };
  driven.advance(STALE_SECONDS + 1);
  await driven.render(120);
  await drain();
  await driven.render(120);
  assert.equal(driven.calls.every.filter((ms) => ms === FRAME_MS).length, 1,
               "no frames were asked for while the new row slid in");
  // Painted again mid-slide, the frames already running are not started twice.
  await driven.render(120);
  assert.equal(driven.calls.every.filter((ms) => ms === FRAME_MS).length, 1);
  const before = driven.calls.cancelled;
  driven.advance(5);
  await driven.render(120);
  assert.equal(driven.calls.cancelled, before + 1, "the frames went on after the row was in place");
});

/** Speech switched on at the moment the stub's sessions start, so they hear it. */
const SPOKEN = 1790000000 * 1000;

test("a session starts with speech off, whatever an earlier session left on", async () => {
  for (const left of [SPOKEN - 1, true, "on"]) {
    const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: left };
    const helped: string[][] = [];
    const driven = stub({ memory, answer: machine(helped) });
    await driven.start();
    await drain();
    assert.equal(speakWord(await driven.band()), "♪ Speak: off", String(left));
    const reply = await driven.speak("male") as { text: string };
    // Picking a voice turns speech on, so the one line it says is the reply's.
    assert.equal(voicesSaid(helped).length, 1, String(left));
    assert.equal(reply.text.includes("speech is off"), false, reply.text);
    // A switch left on before this session never reaches it: the press that
    // just turned it on is what speaks, stamped now.
    assert.equal(memory[SPEECH_ON_KEY], SPOKEN);
  }
});

test("speech switched off is a hard stop: lines asked for before it are dropped, even when it is on again", async () => {
  let reading: unknown = OUTPUT;
  const helped: string[][] = [];
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: SPOKEN };
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
    { provider: "one", id: "job-3", name: "Ship the band", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/r", since: 1789999991 },
    { provider: "one", id: "job-4", name: "Fold the queue", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/s", since: 1789999992 },
  ] } };
  const driven = stub({ notify: true, memory, answer: machine(helped, () => reading),
                        play: (signal) => new Promise((resolve) => {
                          signal?.addEventListener("abort", () => resolve());
                        }) });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  // One line playing and two waiting behind it.
  assert.equal(driven.calls.played, 1);
  assert.equal(voicesSaid(helped).length, 1);
  // Off, and on again before the waiting lines have had their turn.
  await driven.band();
  await driven.pressBand(BAND_SPEAK);
  await driven.pressBand(BAND_SPEAK);
  await drain();
  assert.equal(driven.calls.signals[0]?.aborted, true);
  assert.equal(typeof memory[SPEECH_ON_KEY], "number");
  // The playing line and the hello the second press says, and neither line
  // that was waiting when speech went off.
  assert.equal(voicesSaid(helped).length, 2);
  assert.equal(driven.calls.played, 2);
  assert.equal(driven.calls.signals[1]?.aborted, false);
});

test("a line made while speech went off and on again is dropped before it plays", async () => {
  let reading: unknown = OUTPUT;
  const helped: string[][] = [];
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: SPOKEN };
  // The look at the switch the line takes once it is made, just before it
  // plays, is held; the presses below happen while it is out.
  let release: (() => void) | null = null;
  let held = false;
  const driven = stub({ notify: true, memory, answer: machine(helped, () => reading),
                        gateGet: (key) => {
                          if (key !== SPEECH_ON_KEY || held || voicesSaid(helped).length !== 1) {
                            return undefined;
                          }
                          held = true;
                          return new Promise((resolve) => { release = () => resolve(); });
                        } });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = WAITING;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.equal(held, true);
  assert.equal(driven.calls.played, 0);
  await driven.band();
  await driven.pressBand(BAND_SPEAK);
  await driven.pressBand(BAND_SPEAK);
  await drain();
  // Speech is on again when the held look answers, and the line was still
  // asked for before it went off.
  assert.equal(typeof memory[SPEECH_ON_KEY], "number");
  (release as (() => void) | null)?.();
  await drain();
  // Only the hello the second press said played.
  assert.equal(voicesSaid(helped).length, 2);
  assert.equal(driven.calls.played, 1);
});

/** The voices every speech case offers: one in each group. */
const VOICES = { state: "ready", reason: null, group: "female", voice: null,
                 voices: { female: ["af_sky"], male: ["am_adam"] } };

/**
 * A machine whose reader prints `reading()` and whose alerts helper answers
 * every question yes, synthesizing each line to a file, with each helper call
 * kept in `helped` so a case can see which voice said what.
 */
function machine(helped: string[][], reading: () => unknown = () => OUTPUT) {
  return (argv: string[]) => {
    if (!argv[1]?.endsWith("alerts.py")) {
      return { exitCode: 0, stdout: JSON.stringify(reading()) };
    }
    helped.push(argv.slice(2));
    if (argv[2] === "voices") {
      return { exitCode: 0, stdout: JSON.stringify(VOICES) };
    }
    if (argv[2] === "speak") {
      return { exitCode: 0, stdout: JSON.stringify({ file: "/t/fleet-speak-" + helped.length + ".wav",
                                                     reason: null }) };
    }
    return { exitCode: 0, stdout: "" };
  };
}

/** The voices a session's helper was asked to say lines in, in order. */
function voicesSaid(helped: string[][]): string[] {
  return helped.filter((args) => args[0] === "speak").map((args) => args[1] ?? "");
}

/** The word on the band's speech switch, as last drawn. */
function speakWord(tree: unknown): unknown {
  return (buttonAddressing(tree, BAND_SPEAK) as { label?: unknown } | null)?.label;
}

test("the band draws the speech switch beside the fleet's, off until someone turns it on", async () => {
  const driven = stub({ answer: machine([]) });
  await driven.start();
  await drain();
  assert.equal(speakWord(await driven.band()), "♪ Speak: off");
  assert.equal(speakWord(await driven.band(140, "desktop")), "\u{1F507} Speak: off");
  const fleet = buttonAddressing(await driven.band(140, "desktop"), BAND_TOGGLE) as { label?: string };
  assert.equal(fleet.label, "\u{1F4CB} Open llm-fleet");
});

test("a press on Speak in one session switches speech in every session", async () => {
  const memory: Record<string, unknown> = {};
  const helpedA: string[][] = [];
  const first = stub({ memory, sessionId: "session-a", answer: machine(helpedA) });
  const second = stub({ memory, sessionId: "session-b", answer: machine([]) });
  await first.start();
  await second.start();
  await drain();
  await first.band();
  await second.band();
  await first.pressBand(BAND_SPEAK);
  await drain();
  // Kept where every session reads it, and this session says so at once.
  assert.equal(memory[SPEECH_ON_KEY], SPOKEN);
  assert.equal(speakWord(await first.band()), "♪ Speak: on");
  // Turning it on says hello in this session's voice.
  assert.deepEqual(voicesSaid(helpedA), ["--voice=af_sky"]);
  assert.equal(first.calls.played, 1);
  // The other session hears of it on its next look, with no press of its own.
  second.tick(SPEECH_POLL_MS);
  await drain();
  assert.equal(speakWord(await second.band()), "♪ Speak: on");
  // And a press there turns it off here.
  await second.pressBand(BAND_SPEAK);
  await drain();
  assert.equal(memory[SPEECH_ON_KEY], false);
  first.tick(SPEECH_POLL_MS);
  await drain();
  assert.equal(speakWord(await first.band()), "♪ Speak: off");
  // Off says nothing.
  assert.equal(second.calls.played, 0);
});

for (const ending of ["resolves", "rejects"] as const) {
test(`speech switched off in another session stops the clip playing here, and no other voice stands in (a stopped clip ${ending})`, async () => {
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: SPOKEN };
  const helped: string[][] = [];
  const speaking = stub({ memory, sessionId: "session-a", answer: machine(helped),
                          // A clip that plays until it is stopped, ending either
                          // way an engine may end one.
                          play: (signal) => new Promise((resolve, reject) => {
                            signal?.addEventListener("abort", () => (ending === "resolves"
                              ? resolve() : reject(new Error("The clip was stopped"))));
                          }) });
  const other = stub({ memory, sessionId: "session-b", answer: machine([]) });
  await speaking.start();
  await other.start();
  await drain();
  const reply = speaking.speak("male");
  await drain();
  assert.equal(speaking.calls.played, 1);
  assert.equal(speaking.calls.signals[0]?.aborted, false);
  await other.band();
  await other.pressBand(BAND_SPEAK);
  await drain();
  assert.equal(memory[SPEECH_ON_KEY], false);
  speaking.tick(SPEECH_POLL_MS);
  await drain();
  assert.equal(speaking.calls.signals[0]?.aborted, true);
  const answer = await within(reply as Promise<{ text: string }>, "the stopped clip never ended");
  assert.equal(answer.text.includes("speech is off"), true, answer.text);
  // The stopped clip was the only one: a switch turned off is not a voice that failed.
  assert.deepEqual(voicesSaid(helped), ["--voice=am_adam"]);
  assert.equal(speaking.calls.played, 1);
});
}

test("each session keeps the voice it picked, and speech coming back on speaks in it", async () => {
  const memory: Record<string, unknown> = {};
  const helpedA: string[][] = [];
  const helpedB: string[][] = [];
  const first = stub({ memory, sessionId: "session-a", answer: machine(helpedA) });
  const second = stub({ memory, sessionId: "session-b", answer: machine(helpedB) });
  await first.start();
  await second.start();
  await drain();
  await first.speak("male");
  await second.speak("female");
  assert.deepEqual(memory["voice:session-a"], { voice: "male" });
  assert.deepEqual(memory["voice:session-b"], { voice: "female" });
  // Picking a voice turns speech on, for everyone.
  assert.equal(memory[SPEECH_ON_KEY], SPOKEN);
  // Off and on again from the band: the hello is in this session's own voice.
  await first.band();
  await first.pressBand(BAND_SPEAK);
  await drain();
  await first.band();
  await first.pressBand(BAND_SPEAK);
  await drain();
  assert.deepEqual(voicesSaid(helpedA), ["--voice=am_adam", "--voice=am_adam"]);
  assert.deepEqual(voicesSaid(helpedB), ["--voice=af_sky"]);
  // A session that starts again under the same identifier finds its voice.
  const again = stub({ memory, sessionId: "session-a", answer: machine([]) });
  await again.start();
  await drain();
  const status = await again.speak("") as { text: string };
  assert.equal(status.text.includes("male"), true, status.text);
});

test("off in one session is off everywhere, whatever voice each session picked", async () => {
  const memory: Record<string, unknown> = {};
  const first = stub({ memory, sessionId: "session-a", answer: machine([]) });
  const second = stub({ memory, sessionId: "session-b", answer: machine([]) });
  await first.start();
  await second.start();
  await drain();
  await second.speak("male");
  const reply = await first.speak("off") as { text: string };
  assert.equal(memory[SPEECH_ON_KEY], false);
  assert.equal(reply.text.includes("every session"), true, reply.text);
  // The other session's voice is still its own for when speech comes back.
  assert.deepEqual(memory["voice:session-b"], { voice: "male" });
});

test("a waiting job is not said aloud while speech is off, and is still shown", async () => {
  let reading: unknown = OUTPUT;
  const helped: string[][] = [];
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
  ] } };
  const driven = stub({ notify: true, answer: machine(helped, () => reading) });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.deepEqual(driven.calls.notified, ["Job needs you: Port the voice"]);
  assert.equal(driven.calls.played, 0);
  assert.deepEqual(voicesSaid(helped), []);
});

test("two jobs that start waiting together are said one after the other, never over each other", async () => {
  let reading: unknown = OUTPUT;
  const finish: (() => void)[] = [];
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
    { provider: "one", id: "job-3", name: "Ship the band", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/r", since: 1789999991 },
  ] } };
  const driven = stub({ notify: true, memory: { [SPEECH_ON_KEY]: SPOKEN },
                        answer: machine([], () => reading),
                        play: () => new Promise((resolve) => { finish.push(() => resolve()); }) });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.equal(driven.calls.notified.length, 2);
  // The second waits for the first to end.
  assert.equal(driven.calls.played, 1);
  finish.shift()?.();
  await drain();
  assert.equal(driven.calls.played, 2);
  finish.shift()?.();
  await drain();
});

test("a line waiting its turn is never made once speech goes off", async () => {
  let reading: unknown = OUTPUT;
  const helped: string[][] = [];
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: SPOKEN };
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
    { provider: "one", id: "job-3", name: "Ship the band", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/r", since: 1789999991 },
  ] } };
  const driven = stub({ notify: true, memory, answer: machine(helped, () => reading),
                        play: (signal) => new Promise((resolve) => {
                          signal?.addEventListener("abort", () => resolve());
                        }) });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.equal(driven.calls.played, 1);
  // Off in another session, heard here on the next look.
  memory[SPEECH_ON_KEY] = false;
  driven.tick(SPEECH_POLL_MS);
  await drain();
  assert.equal(driven.calls.signals[0]?.aborted, true);
  // The second line was never synthesized: no voice was held for it.
  assert.equal(voicesSaid(helped).length, 1);
  assert.equal(driven.calls.played, 1);
});

/** A reading with a waiting job to answer and a job to open, and the settings presses read. */
const PRESSED = {
  ...OUTPUT,
  roster: {
    ...OUTPUT.roster,
    jobs: [
      { provider: "one", id: "job-2", name: "Draft the migration", state: "blocked", label: "One",
        started_at: 1789999000, since: 1789999700, session_id: "job-2-session",
        needs: "Merge now?", needs_hash: "hash-merge", suggested_reply: "wait",
        attach_command: "CLAUDE_CONFIG_DIR=/h claude attach job-2" },
      { ...OUTPUT.roster.jobs[0], attach_command: "CLAUDE_CONFIG_DIR=/h claude attach job-1" },
    ],
  },
  alerts: { state: "ready", toast: true, notify: false, toastMs: 7777, copyToastMs: 4321,
            snapshotMs: 3000, snapshotSeconds: 20, progressMs: 1000, synthesisMs: 30000 },
  pane: { repliedLimit: 2, replyMaxChars: 10 },
};
const REPLY_KEY = "one:job-2:job-2-session:hash-merge";

/** Lets work a press left running settle, up to a bound, until `ready` holds. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(ready(), true, what);
}

/**
 * Answers the helper's question with what the job asks now, the hash of all of
 * it and the session its own file names, and anything else as the stub does.
 */
function asking(needs: string | null, exitCode = 0,
                overrides: { needsHash?: string | null; sessionId?: string | null;
                             held?: boolean } = {}) {
  const needsHash = "needsHash" in overrides ? overrides.needsHash
    : needs === "Merge now?" ? "hash-merge" : needs === null ? null : "hash-other";
  const sessionId = "sessionId" in overrides ? overrides.sessionId : "job-2-session";
  return (argv: string[]) => argv[2] === "question"
    ? { exitCode, stdout: JSON.stringify(exitCode === 0
      ? { state: "ready", needs, needsHash, sessionId, reason: null,
          // The helper marks the question answered for whoever named a holder.
          held: overrides.held ?? argv.includes("--holder") }
      : { state: "unavailable", needs: null, needsHash: null, sessionId: null, held: false,
          reason: "provider one is not ready" }) }
    : undefined;
}

/** The helper refusing to mark the question, in the state it names. */
function refusing(state: string, reason: string) {
  return (argv: string[]) => argv[2] === "question"
    ? { exitCode: 1, stdout: JSON.stringify({ state, needs: null, needsHash: null, sessionId: null,
                                              held: false, reason }) }
    : undefined;
}

/** How many times the helper was asked what a job asks. */
function questionsAsked(driven: { calls: { argv: string[][] } }): number {
  return driven.calls.argv.filter((argv) => argv[2] === "question").length;
}

/** The releases the pane asked the helper for, each as the job, question and holder named. */
function releases(driven: { calls: { argv: string[][] } }): string[][] {
  return driven.calls.argv.filter((argv) => argv[2] === "release").map((argv) => argv.slice(3));
}

/** The confirmations the pane asked the helper for, each as the job, question and holder named. */
function confirms(driven: { calls: { argv: string[][] } }): string[][] {
  return driven.calls.argv.filter((argv) => argv[2] === "confirm").map((argv) => argv.slice(3));
}

/** The helper answering one subcommand as given, and the question as `asked` does. */
function answering(name: string, exitCode: number, asked = asking("Merge now?")) {
  return (argv: string[]) => argv[2] === name ? { exitCode, stdout: "" } : asked(argv);
}

/** The holder this pane named when it asked to mark a question answered. */
function holderOf(driven: { calls: { argv: string[][] } }): string | undefined {
  const asked = driven.calls.argv.find((argv) => argv[2] === "question") ?? [];
  return asked[asked.indexOf("--holder") + 1];
}

async function pressedPane(options: Parameters<typeof stub>[0] = {}) {
  const driven = stub({ stdout: JSON.stringify(PRESSED), ...options });
  await driven.start();
  await driven.settle();
  await driven.quiesce(140);
  return driven;
}

test("a press on a job copies its line on the surface it came from, for the copy's toast time", async () => {
  const driven = await pressedPane({ surface: "desktop" });
  await driven.press("fleet.job.one.job-1");
  await until(() => driven.calls.toasts.length > 0, "the copy was never said");
  assert.deepEqual(driven.calls.copied, [{ text: "CLAUDE_CONFIG_DIR=/h claude attach job-1",
                                           surface: "desktop" }]);
  assert.deepEqual(driven.calls.toasts, ["fleet: copied the command that opens Review adapter behavior: "
                                         + "CLAUDE_CONFIG_DIR=/h claude attach job-1"]);
  assert.deepEqual(driven.calls.toastMs, [4321]);
});

test("a copy the clipboard refused says why, with the line to select by hand", async () => {
  const driven = await pressedPane({ copyRefused: "no-clipboard" });
  await driven.press("fleet.job.one.job-2");
  await until(() => driven.calls.toasts.length > 0, "the refusal was never said");
  assert.deepEqual(driven.calls.toasts, ["fleet: could not copy the command that opens Draft the "
                                         + "migration (no-clipboard): CLAUDE_CONFIG_DIR=/h claude attach job-2"]);
});

test("a reply is sent to the job's session once its question still stands, and remembered", async () => {
  const driven = await pressedPane({ answer: asking("Merge now?"),
                                     memory: { replied: ["a", "b"] } });
  await driven.type("fleet.reply.one.job-2", "  ");
  await until(() => driven.calls.toasts.length > 0, "the reply was never said");
  // The helper is asked to mark the question answered by this pane, for the
  // question and session the reading drew.
  const asked = driven.calls.argv.filter((argv) => argv[2] === "question");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]?.slice(3, 5), ["one", "job-2"]);
  const flag = (name: string) => asked[0]?.[(asked[0]?.indexOf(name) ?? -2) + 1];
  assert.deepEqual([flag("--hash"), flag("--job-session"), flag("--session")],
                   ["hash-merge", "job-2-session", "stub-session"]);
  assert.match(holderOf(driven) ?? "", /^[A-Za-z0-9_-]+$/);
  // An empty field sends the job's own suggestion.
  assert.deepEqual(driven.calls.sent, [{ to: { sessionId: "job-2-session" }, text: "wait" }]);
  assert.equal(driven.calls.toasts[0]?.startsWith("fleet: sent to Draft the migration as a message"), true);
  assert.deepEqual(driven.calls.toastMs, [7777]);
  // Remembered for every session, within the reading's limit of two.
  const kept = driven.calls.stored.filter((entry) => entry.key === "replied").at(-1);
  assert.deepEqual(kept?.value, ["b", REPLY_KEY]);
  const text = renderedText(await driven.quiesce(140) as never);
  assert.equal(text.some((value) => value.startsWith("replied;")), true);
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), false);
  // A reply that went is recorded as sent, for this holder and question, and never released.
  assert.deepEqual(confirms(driven), [["one", "job-2", "--job-session", "job-2-session",
                                       "--hash", "hash-merge", "--holder", holderOf(driven) as string]]);
  assert.deepEqual(releases(driven), []);
});

test("a reply to a question the job no longer asks is not sent", async () => {
  const driven = await pressedPane({ answer: asking("Which branch?") });
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.toasts.length > 0, "nothing was said");
  assert.deepEqual(driven.calls.sent, []);
  assert.equal(driven.calls.toasts[0]?.includes("is no longer asking that"), true);
  assert.equal(driven.calls.stored.some((entry) => entry.key === "replied"), false);
});

test("a job whose question cannot be read, or whose session cannot be reached, is named with how to open it", async () => {
  for (const [options, words] of [
    [{ answer: asking(null, 1) }, "could not reach Draft the migration (provider one is not ready)"],
    [{ answer: asking("Merge now?"), send: { reason: "no such session" } },
     "could not reach Draft the migration (no such session)"],
    [{ answer: asking("Merge now?"), send: "throws" as const },
     "could not reach Draft the migration (the socket closed)"],
  ] as const) {
    const driven = await pressedPane(options as never);
    await driven.type("fleet.reply.one.job-2", "yes");
    await until(() => driven.calls.toasts.length > 0, "nothing was said for " + words);
    assert.equal(driven.calls.toasts[0], "fleet: " + words
                 + "; run CLAUDE_CONFIG_DIR=/h claude attach job-2");
    assert.equal(driven.calls.stored.some((entry) => entry.key === "replied"), false);
  }
});

test("a reply goes only to the session the job's own file names, and not when that changed", async () => {
  for (const sessionId of ["job-2-restarted", null]) {
    const driven = await pressedPane({ answer: asking("Merge now?", 0, { sessionId }) });
    await driven.type("fleet.reply.one.job-2", "yes");
    await until(() => driven.calls.toasts.length > 0, "nothing was said for " + sessionId);
    assert.deepEqual(driven.calls.sent, [], String(sessionId));
    assert.equal(driven.calls.toasts[0],
                 "fleet: Draft the migration: this job's session changed; nothing sent");
    assert.equal(driven.calls.stored.some((entry) => entry.key === "replied"), false);
  }
});

test("a reply is sent only when the whole question's hash still matches, whatever the drawn words say", async () => {
  // The drawn words are the same; the question past what a row shows is not.
  const driven = await pressedPane({ answer: asking("Merge now?", 0, { needsHash: "hash-longer" }) });
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.toasts.length > 0, "nothing was said");
  assert.deepEqual(driven.calls.sent, []);
  assert.equal(driven.calls.toasts[0]?.includes("is no longer asking that"), true);
  // A reading that carries no hash cannot say which question a reply is for.
  const bare = { ...PRESSED, roster: { ...PRESSED.roster, jobs: PRESSED.roster.jobs.map((job) =>
    job.id === "job-2" ? { ...job, needs_hash: undefined } : job) } };
  const unsure = await pressedPane({ stdout: JSON.stringify(bare), answer: asking("Merge now?") });
  await unsure.type("fleet.reply.one.job-2", "yes");
  await until(() => unsure.calls.toasts.length > 0, "nothing was said without a hash");
  assert.deepEqual(unsure.calls.sent, []);
  assert.equal(unsure.calls.toasts[0]?.startsWith("fleet: could not confirm what Draft the migration asks;"
                                                  + " nothing was sent"), true);
});

test("a second reply while the first is out is refused, and the one that went is not released", async () => {
  let letGo: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { letGo = resolve; });
  const answered = asking("Merge now?");
  const driven = await pressedPane({ answer: (argv) => argv[2] === "question"
    ? held.then(() => answered(argv) as { exitCode: number; stdout: string }) : undefined });
  await driven.type("fleet.reply.one.job-2", "yes");
  await driven.type("fleet.reply.one.job-2", "no");
  await until(() => driven.calls.toasts.length > 0, "the second reply was never refused");
  assert.equal(driven.calls.toasts[0],
               "fleet: a reply to Draft the migration is already being sent; nothing more was sent");
  letGo();
  await until(() => driven.calls.toasts.length > 1, "the first reply was never said");
  assert.deepEqual(driven.calls.sent.map((sent) => sent.text), ["yes"]);
  assert.equal(questionsAsked(driven), 1);
  await driven.quiesce(140);
  assert.deepEqual(releases(driven), []);
});

test("a question already answered, or not held by this pane, is not sent to or released", async () => {
  const ANSWERED = "fleet: Draft the migration was already answered, or a reply to it is on its way;"
    + " nothing was sent";
  const answered = await pressedPane({ answer: refusing("answered", "already answered") });
  await answered.type("fleet.reply.one.job-2", "yes");
  await until(() => answered.calls.toasts.length > 0, "nothing was said");
  assert.equal(answered.calls.toasts[0], ANSWERED);
  assert.deepEqual(answered.calls.sent, []);
  await answered.quiesce(140);
  assert.deepEqual(releases(answered), []);
  // An answer that does not say this pane holds the reply sends nothing either.
  const unheld = await pressedPane({ answer: asking("Merge now?", 0, { held: false }) });
  await unheld.type("fleet.reply.one.job-2", "yes");
  await until(() => unheld.calls.toasts.length > 0, "nothing was said when not held");
  assert.equal(unheld.calls.toasts[0], ANSWERED);
  assert.deepEqual(unheld.calls.sent, []);
  await unheld.quiesce(140);
  assert.deepEqual(releases(unheld), []);
});

test("the helper's own refusals name what moved, and leave nothing for the pane to let go", async () => {
  for (const [state, words] of [
    ["session-changed", "fleet: Draft the migration: this job's session changed; nothing sent"],
    ["question-changed", "fleet: Draft the migration is no longer asking that; nothing was sent, "
                         + "and the pane shows its question in a moment"],
  ] as const) {
    const driven = await pressedPane({ answer: refusing(state, "moved") });
    await driven.type("fleet.reply.one.job-2", "yes");
    await until(() => driven.calls.toasts.length > 0, "nothing was said for " + state);
    assert.equal(driven.calls.toasts[0], words);
    assert.deepEqual(driven.calls.sent, []);
    assert.deepEqual(releases(driven), []);
  }
});

test("a helper that never answered the question has the reply released, and says so if that fails", async () => {
  // The helper may have recorded the reply before it timed out: it is given back.
  const lost = await pressedPane({ answer: answering("question", -1, asking("Merge now?")) });
  await lost.type("fleet.reply.one.job-2", "yes");
  await until(() => releases(lost).length > 0, "nothing was released after the helper timed out");
  assert.deepEqual(releases(lost), [["one", "job-2", "--job-session", "job-2-session",
                                     "--hash", "hash-merge", "--holder", holderOf(lost) as string,
                                     "--failed"]]);
  assert.deepEqual(lost.calls.sent, []);
  await until(() => lost.calls.toasts.length > 0, "nothing was said");
  assert.equal(lost.calls.toasts[0]?.startsWith("fleet: could not reach Draft the migration"), true);
  // Finding nothing to give back after a helper that never answered is no failure.
  const unrecorded = await pressedPane({ answer: (argv) => argv[2] === "question"
    ? { exitCode: -1, stdout: "" } : argv[2] === "release" ? { exitCode: 1, stdout: "" } : undefined });
  await unrecorded.type("fleet.reply.one.job-2", "yes");
  await until(() => releases(unrecorded).length > 0, "nothing was released");
  await unrecorded.quiesce(140);
  assert.equal(unrecorded.calls.toasts.length, 1);
  // A release that fails too is named, and the row is left to say what stands.
  const stuck = await pressedPane({ answer: (argv) => argv[2] === "question" || argv[2] === "release"
    ? { exitCode: -1, stdout: "" } : undefined });
  await stuck.type("fleet.reply.one.job-2", "yes");
  await until(() => stuck.calls.toasts.length > 1, "the failed release was never said");
  assert.equal(stuck.calls.toasts[1], "fleet: could not give back the reply to Draft the migration"
               + " (the helper did not answer); its row will say it may not have been sent"
               + " and offer Send again");
});

test("a reply that went but could not be recorded as sent says so, and still reads as replied here", async () => {
  const driven = await pressedPane({ answer: answering("confirm", 1) });
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.toasts.length > 1, "the failed confirm was never said");
  assert.deepEqual(driven.calls.sent.map((sent) => sent.text), ["yes"]);
  assert.equal(driven.calls.toasts.includes("fleet: sent to Draft the migration, but it could not be"
                                            + " recorded as sent (the helper refused it); this pane"
                                            + " shows it as replied"), true);
  assert.deepEqual(releases(driven), []);
  const text = renderedText(await driven.quiesce(140) as never);
  assert.equal(text.some((value) => value.startsWith("replied;")), true);
});

test("too many held replies pause replies on the row, and clearing the answered ones opens them", async () => {
  let pruned: { exitCode: number; stdout: string } = { exitCode: 0, stdout: JSON.stringify({ removed: 2 }) };
  const full = refusing("full", "3 replies are held for jobs still waiting");
  const driven = await pressedPane({ answer: (argv) => argv[2] === "release" && argv.includes("--prune-sent")
    ? pruned : full(argv) });
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.toasts.length > 0, "nothing was said");
  assert.equal(driven.calls.toasts[0], "fleet: could not send to Draft the migration (3 replies"
               + " are held for jobs still waiting); nothing was sent");
  assert.deepEqual(driven.calls.sent, []);
  // The row says so, with the press that clears answered replies, and no field.
  const words = renderedText(await driven.quiesce(140) as never);
  assert.equal(words.includes("replies are paused: 3 replies are held for jobs still waiting"), true);
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), false);
  assert.deepEqual(releases(driven), []);
  // A press that clears nothing says so, and replies stay paused.
  pruned = { exitCode: 1, stdout: JSON.stringify({ removed: 0 }) };
  await driven.press("fleet.prune.one.job-2");
  await until(() => driven.calls.toasts.length > 1, "the empty clearing was never said");
  assert.equal(driven.calls.toasts[1], "fleet: no answered reply could be cleared (every recorded reply"
               + " is still on its way or still answers its question); replies stay paused");
  assert.equal(renderedText(await driven.quiesce(140) as never)
    .includes("replies are paused: 3 replies are held for jobs still waiting"), true);
  // One that clears some opens replies again, and the field is back.
  pruned = { exitCode: 0, stdout: JSON.stringify({ removed: 2 }) };
  await driven.press("fleet.prune.one.job-2");
  await until(() => driven.calls.toasts.length > 2, "the clearing was never said");
  assert.equal(driven.calls.toasts[2], "fleet: cleared 2 answered replies; replies are open again");
  assert.deepEqual(driven.calls.argv.filter((argv) => argv.includes("--prune-sent")).map((argv) => argv.slice(2)),
                   [["release", "--prune-sent"], ["release", "--prune-sent"]]);
  await driven.quiesce(140);
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), true);
});

test("a lock the helper will not use pauses replies on the row with its fix, until a reply goes", async () => {
  let answer = refusing("locked", "reply-answers is a link; remove the link");
  // Every send is refused by the host, so the row after the retry is the field
  // and not a reply remembered: only the pause would draw on it.
  const driven = await pressedPane({ answer: (argv) => answer(argv), send: { reason: "no such session" } });
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.toasts.length > 0, "nothing was said");
  assert.equal(driven.calls.toasts[0], "fleet: could not send to Draft the migration (reply-answers is a"
               + " link; remove the link); nothing was sent");
  const words = renderedText(await driven.quiesce(140) as never);
  assert.equal(words.includes("replies are paused: reply-answers is a link; remove the link"), true);
  // No press clears a lock; the field stays for the retry once it is fixed.
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), true);
  answer = asking("Merge now?");
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.sent.length > 0 && releases(driven).length > 0, "the retry never went");
  assert.equal(renderedText(await driven.quiesce(140) as never)
    .some((value) => value.startsWith("replies are paused")), false);
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), true);
});

/** The reading with job-2's reply recorded as pending since `at`, waiting `seconds` before it is stale. */
function pendingReading(at: number, seconds?: number) {
  return { ...PRESSED,
           pane: { ...PRESSED.pane, ...(seconds === undefined ? {} : { replyPendingSeconds: seconds }) },
           roster: { ...PRESSED.roster, jobs: PRESSED.roster.jobs.map((job) => job.id === "job-2"
             ? { ...job, reply: { state: "pending", at } } : job) } };
}

test("a reply pending past the configured time is offered again, cleared once and resent once", async () => {
  // Inside the configured five minutes it is on its way; the packaged two would call it stale.
  const young = await pressedPane({ stdout: JSON.stringify(pendingReading(1790000000 - 200, 300)) });
  const words = renderedText(await young.quiesce(140) as never);
  assert.equal(words.includes("a reply is on its way"), true);
  assert.equal(words.includes("your reply may not have been sent"), false);
  const driven = await pressedPane({ stdout: JSON.stringify(pendingReading(1790000000 - 600, 300)),
                                     answer: asking("Merge now?") });
  assert.equal(renderedText(await driven.quiesce(140) as never)
    .includes("your reply may not have been sent"), true);
  await driven.press("fleet.resend.one.job-2");
  await until(() => driven.calls.toasts.length > 0, "the clearing was never said");
  const cleared = driven.calls.argv.filter((argv) => argv[2] === "release");
  assert.deepEqual(cleared.map((argv) => argv.slice(3)),
                   [["one", "job-2", "--job-session", "job-2-session", "--hash", "hash-merge", "--stale"]]);
  assert.equal(driven.calls.toasts[0], "fleet: cleared the reply to Draft the migration that may not"
               + " have been sent; type it again to send it");
  // The field is back before the next reading, and one reply goes.
  await driven.quiesce(140);
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.sent.length > 0, "the reply was never sent again");
  await driven.quiesce(140);
  assert.deepEqual(driven.calls.sent.map((sent) => sent.text), ["yes"]);
  assert.equal(questionsAsked(driven), 1);
});

test("a reply the helper will not clear is named, and the row still offers what stands", async () => {
  for (const [exitCode, why] of [[1, "it was sent, or is still on its way"],
                                 [-1, "the helper did not answer"]] as const) {
    const driven = await pressedPane({ stdout: JSON.stringify(pendingReading(1790000000 - 600)),
                                       answer: answering("release", exitCode) });
    await driven.quiesce(140);
    await driven.press("fleet.resend.one.job-2");
    await until(() => driven.calls.toasts.length > 0, "the refusal was never said");
    assert.equal(driven.calls.toasts[0], "fleet: could not clear the reply to Draft the migration ("
                 + why + "); nothing was sent");
    assert.equal(renderedText(await driven.quiesce(140) as never)
      .includes("your reply may not have been sent"), true);
    assert.deepEqual(driven.calls.sent, []);
  }
});

/** The reading with job-2's reply record there but not readable. */
function unreadableReading() {
  return { ...PRESSED,
           roster: { ...PRESSED.roster, jobs: PRESSED.roster.jobs.map((job) => job.id === "job-2"
             ? { ...job, reply: { state: "unreadable", at: null, id: "7-1" } } : job) } };
}

test("a reply whose record does not read is cleared by its press, and then one reply goes", async () => {
  const driven = await pressedPane({ stdout: JSON.stringify(unreadableReading()),
                                     answer: asking("Merge now?") });
  assert.equal(renderedText(await driven.quiesce(140) as never)
    .includes("this reply's record could not be read"), true);
  // The record holds the question: no field until it is cleared.
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), false);
  await driven.press("fleet.unreadable.one.job-2");
  await until(() => driven.calls.toasts.length > 0, "the clearing was never said");
  assert.deepEqual(releases(driven),
                   [["one", "job-2", "--job-session", "job-2-session", "--hash", "hash-merge",
                     "--unreadable"]]);
  assert.equal(driven.calls.toasts[0], "fleet: cleared the reply record for Draft the migration that"
               + " could not be read; type a reply to send one");
  await driven.quiesce(140);
  assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), true);
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.sent.length > 0, "the reply was never sent");
  assert.deepEqual(driven.calls.sent.map((sent) => sent.text), ["yes"]);
  assert.equal(questionsAsked(driven), 1);
});

test("a record the helper will not clear is named, and the row still says it does not read", async () => {
  for (const [exitCode, why] of [[1, "it reads now, or is gone"],
                                 [-1, "the helper did not answer"]] as const) {
    const driven = await pressedPane({ stdout: JSON.stringify(unreadableReading()),
                                       answer: answering("release", exitCode) });
    await driven.quiesce(140);
    await driven.press("fleet.unreadable.one.job-2");
    await until(() => driven.calls.toasts.length > 0, "the refusal was never said");
    assert.equal(driven.calls.toasts[0], "fleet: could not clear the reply record for Draft the migration ("
                 + why + "); nothing was sent");
    assert.equal(renderedText(await driven.quiesce(140) as never)
      .includes("this reply's record could not be read"), true);
    assert.equal(elementTypes(await driven.render(140) as never).includes("Input"), false);
  }
});

test("a send the helper refuses for a record that does not read says where to clear it", async () => {
  const driven = await pressedPane({ answer: refusing("unreadable", "the reply's marker could not be"
                                                       + " read; clear it from the job's row") });
  await driven.type("fleet.reply.one.job-2", "yes");
  await until(() => driven.calls.toasts.length > 0, "nothing was said");
  assert.equal(driven.calls.toasts[0], "fleet: the reply record for Draft the migration could not be"
               + " read; nothing was sent. Clear it from its row once the next reading shows it");
  assert.deepEqual(driven.calls.sent, []);
  assert.deepEqual(releases(driven), []);
});

test("a reply that was not sent is released as failed, for this holder and question", async () => {
  for (const send of ["throws", { reason: "no such session" }] as const) {
    const failed = await pressedPane({ answer: asking("Merge now?"), send });
    await failed.type("fleet.reply.one.job-2", "yes");
    await until(() => releases(failed).length > 0, "nothing was released after a failed send");
    assert.deepEqual(releases(failed), [["one", "job-2", "--job-session", "job-2-session",
                                         "--hash", "hash-merge", "--holder", holderOf(failed) as string,
                                         "--failed"]]);
  }
  // A release that fails after a failed send is named.
  const unreleased = await pressedPane({ answer: answering("release", 1), send: "throws" });
  await unreleased.type("fleet.reply.one.job-2", "yes");
  await until(() => unreleased.calls.toasts.length > 1, "the failed release was never said");
  assert.equal(unreleased.calls.toasts[1], "fleet: could not give back the reply to Draft the migration"
               + " (the helper found no reply of this pane's to give back); its row will say it may"
               + " not have been sent and offer Send again");
  // The helper marked it but answered for another question: nothing goes, and it is released.
  const moved = await pressedPane({ answer: asking("Merge now?", 0, { needsHash: "hash-longer" }) });
  await moved.type("fleet.reply.one.job-2", "yes");
  await until(() => releases(moved).length > 0, "nothing was released after a refused check");
  assert.deepEqual(moved.calls.sent, []);
});

test("a reply is sent as typed, and one over the configured length is refused with the limit named", async () => {
  const driven = await pressedPane({ answer: asking("Merge now?") });
  await driven.type("fleet.reply.one.job-2", "x".repeat(11));
  await until(() => driven.calls.toasts.length > 0, "nothing was said");
  assert.equal(driven.calls.toasts[0], "fleet: the reply to Draft the migration is 11 characters,"
               + " over the limit of 10 (pane.replyMaxChars); nothing was sent");
  assert.deepEqual(driven.calls.sent, []);
  assert.equal(questionsAsked(driven), 0);
  // Exactly at the limit is sent, spacing and line break included.
  await driven.type("fleet.reply.one.job-2", " yes, go\n ");
  await until(() => driven.calls.sent.length > 0, "the reply at the limit was not sent");
  assert.deepEqual(driven.calls.sent, [{ to: { sessionId: "job-2-session" }, text: " yes, go\n " }]);
});

test("a toast says what the pane would say: masked, while the copy holds the real line", async () => {
  const masked = { ...PRESSED, roster: { ...PRESSED.roster, jobs: PRESSED.roster.jobs.map((job) =>
    job.id === "job-2"
      ? { ...job, name: "Ship org_ABC123", attach_command: "claude attach job-2 --token=abc123def456" }
      : job) } };
  const driven = await pressedPane({ stdout: JSON.stringify(masked) });
  await driven.press("fleet.job.one.job-2");
  await until(() => driven.calls.toasts.length > 0, "the copy was never said");
  assert.deepEqual(driven.calls.copied.map((copy) => copy.text),
                   ["claude attach job-2 --token=abc123def456"]);
  const said = driven.calls.toasts[0] ?? "";
  assert.equal(said.includes("abc123def456") || said.includes("org_ABC123"), false, said);
  assert.equal(said.includes("[masked]"), true, said);
});

test("the reply limit and the copy toast fall back to the packaged values on a reading without them", () => {
  assert.equal(repliedLimitFrom(PRESSED), 2);
  assert.equal(repliedLimitFrom(OUTPUT), REPLIED_LIMIT);
  assert.equal(repliedLimitFrom({ pane: { repliedLimit: 0 } }), REPLIED_LIMIT);
  assert.equal(repliedLimitFrom({ pane: { repliedLimit: 2.5 } }), REPLIED_LIMIT);
  assert.equal(alertConfigFrom(PRESSED).copyToastMs, 4321);
  assert.equal(alertConfigFrom(OUTPUT).copyToastMs, 6000);
});

test("the pane's clock and its stream step are the reading's, and the packaged ones before it", async () => {
  assert.equal(alertConfigFrom(OUTPUT).clockMs, CLOCK_MS);
  assert.equal(alertConfigFrom(OUTPUT).streamStepMs, STREAM_MS);
  const paced = { ...OUTPUT, alerts: { ...(OUTPUT as { alerts?: object }).alerts, progressMs: 1000,
                                       clockMs: 500, streamStepMs: 90 } };
  assert.equal(alertConfigFrom(paced).clockMs, 500);
  assert.equal(alertConfigFrom(paced).streamStepMs, 90);
  assert.equal(alertConfigFrom({ alerts: { clockMs: 0, streamStepMs: -1 } }).clockMs, CLOCK_MS);
  assert.equal(alertConfigFrom({ alerts: { clockMs: 0, streamStepMs: -1 } }).streamStepMs, STREAM_MS);
  // The timer a pane draws on runs at the reading's interval, not the packaged one.
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: paced } });
  await driven.start();
  await driven.run();
  await drain();
  await driven.render();
  assert.equal(driven.calls.every.includes(500), true);
});

test("the pane counts what the band hides that the reading still names", async () => {
  const driven = await pressedPane({ memory: { [HIDDEN_KEY]: ["job:job-2:blocked:1789999700",
                                                              "job:gone:blocked:1"] } });
  const text = renderedText(await driven.quiesce(140) as never);
  assert.equal(text.includes("1 hidden from the band; /llm-fleet unhide shows them again."), true);
});

/** A pull request whose checks fail: a failure the band leads with. */
const FAILING = { ...OUTPUT, prs: { state: "ready", prs: [
  { repo: "owner/project", number: 7, title: "Fix it", branch: "fix", head: "abc",
    is_draft: false, checks: "fail" },
] } };

/** iTerm, outside tmux: the terminal that draws a tab color. */
const ITERM = { TERM_PROGRAM: "iTerm.app" };

/**
 * A machine whose reading a case changes, a tab helper whose exit a case
 * chooses, and a tmux that answers whether it passes escapes through and which
 * client's terminal the tab is, with what each was asked kept in order.
 */
function tabMachine(reading: () => unknown, options: { tabExit?: () => number;
                                                        passthrough?: string;
                                                        client?: string } = {}) {
  const tabs: string[][] = [];
  const tmux: string[][] = [];
  const answer = (argv: string[]) => {
    if (argv[0] === "tmux") {
      tmux.push(argv.slice(1));
      const stdout = argv[1] === "display-message" ? options.client ?? "/dev/ttys004\n"
        : options.passthrough ?? "";
      return { exitCode: 0, stdout };
    }
    if (argv[1]?.endsWith(TAB_HELPER)) {
      tabs.push(argv.slice(2));
      return { exitCode: options.tabExit?.() ?? 0, stdout: "" };
    }
    if (argv[1]?.endsWith("alerts.py")) {
      return { exitCode: 1, stdout: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify(reading()) };
  };
  return { tabs, tmux, answer };
}

/** What the helper is told for this session's level, in the tab nothing else names. */
function told(level: "none" | "waiting" | "failed", tab = "session:stub-session",
              extra: string[] = []): string[] {
  return ["set", "--tab", tab, "--session", "stub-session", "--level", level, ...extra];
}

/** What the helper is told as this session ends. */
function ended(tab = "session:stub-session", extra: string[] = []): string[] {
  return ["end", "--tab", tab, "--session", "stub-session", ...extra];
}

/**
 * Let a fresh read land: the reading is older than its interval, and a paint
 * asks for it. Less than a third of the staleness, so a held level is not
 * said again for its age alone.
 */
async function readAgain(driven: Stub): Promise<void> {
  driven.advance(25);
  await driven.render();
  await drain();
}

/** Let the tab's heartbeat run, at its own interval, the clock moved on by this much. */
async function beatAfter(driven: Stub, seconds: number, beatMs: number): Promise<void> {
  driven.advance(seconds);
  driven.tick(beatMs);
  await drain();
}

/** Let a look run, the clock moved on by this much, with no new reading. */
async function lookAfter(driven: Stub, seconds: number): Promise<void> {
  driven.advance(seconds);
  driven.tick(LOOK_MS);
  await drain();
}

test("the helper is told none as the session starts, then failed, waiting and none as the band moves", async () => {
  // A staleness long enough that no level is said again for its age here.
  const patient = (body: Record<string, unknown>) => ({ ...body, alerts: { state: "ready",
    progressMs: 1000, tabTint: { enabled: true, staleSeconds: 600 } } });
  let reading: unknown = patient(OUTPUT);
  const machine = tabMachine(() => reading);
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  // A band with nothing in it says none, which lets the helper prune a
  // failure a session that is gone left on the tab.
  assert.deepEqual(machine.tabs, [told("none")]);
  reading = patient(FAILING);
  await readAgain(driven);
  assert.deepEqual(machine.tabs, [told("none"), told("failed")]);
  // The same level again is not told again.
  await readAgain(driven);
  assert.deepEqual(machine.tabs, [told("none"), told("failed")]);
  reading = patient(WAITING);
  await readAgain(driven);
  reading = patient(OUTPUT);
  await readAgain(driven);
  assert.deepEqual(machine.tabs, [told("none"), told("failed"), told("waiting"), told("none")]);
  // iTerm outside tmux: tmux is never asked anything.
  assert.deepEqual(machine.tmux, []);
});

test("a tint switched off tells the helper none, and one off from the start tells it nothing", async () => {
  const off = (enabled: boolean) => ({ ...FAILING, alerts: { state: "ready", progressMs: 1000,
    tabTint: { enabled } } });
  let reading: unknown = off(true);
  const machine = tabMachine(() => reading);
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  reading = off(false);
  await readAgain(driven);
  assert.deepEqual(machine.tabs, [told("failed"), told("none")]);

  const quiet = tabMachine(() => off(false));
  const other = stub({ env: ITERM, answer: quiet.answer });
  await other.start();
  await drain();
  await other.end();
  assert.deepEqual(quiet.tabs, []);
});

test("the session's end takes its entry out, and a session that held no level says nothing", async () => {
  const machine = tabMachine(() => FAILING);
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  const result = await driven.end() as { continued?: boolean };
  assert.equal(result.continued, true);
  assert.deepEqual(machine.tabs, [told("failed"), ended()]);
  // The heartbeat stops with the session.
  const beats = driven.calls.timers.filter((timer) => timer.ms === 40_000);
  assert.equal(beats.length > 0 && beats.every((timer) => timer.cancelled), true,
               JSON.stringify(beats));

  // A session that only ever said none holds no entry, so its end says nothing.
  const clear = tabMachine(() => OUTPUT);
  const untinted = stub({ env: ITERM, answer: clear.answer });
  await untinted.start();
  await drain();
  await untinted.end();
  assert.deepEqual(clear.tabs, [told("none")]);
});

test("inside tmux the tab is tmux's client terminal and the escape is wrapped, only where tmux passes it", async () => {
  const tmuxEnv = { LC_TERMINAL: "iTerm2", TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-1/default,1,0" };
  const passing = tabMachine(() => FAILING, { passthrough: "on\n" });
  const driven = stub({ env: tmuxEnv, answer: passing.answer });
  await driven.start();
  await drain();
  // Asked whether it passes escapes through, then which client's terminal the
  // tab is, which is what sessions in that tab key the helper's record by.
  assert.deepEqual(passing.tmux, [["show-options", "-gqv", "allow-passthrough"],
                                  ["display-message", "-p", "#{client_tty}"]]);
  await driven.end();
  assert.deepEqual(passing.tabs, [told("failed", "tmux:/dev/ttys004", ["--tmux"]),
                                  ended("tmux:/dev/ttys004", ["--tmux"])]);

  // A tmux that keeps escapes to itself would drop the tint: nothing is told.
  const blocking = tabMachine(() => FAILING, { passthrough: "off\n" });
  const blocked = stub({ env: tmuxEnv, answer: blocking.answer });
  await blocked.start();
  await drain();
  await blocked.end();
  assert.equal(blocking.tmux.length, 1);
  assert.deepEqual(blocking.tabs, []);
});

test("outside tmux iTerm's own session identifier names the tab", async () => {
  const machine = tabMachine(() => FAILING);
  const driven = stub({ env: { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:fixture-tab" },
                        answer: machine.answer });
  await driven.start();
  await drain();
  assert.deepEqual(machine.tabs, [told("failed", "iterm:w0t0p0:fixture-tab")]);
});

test("a terminal that draws no tab color is never told anything", async () => {
  for (const env of [{ TERM_PROGRAM: "Apple_Terminal" }, {},
                     { TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-1/default,1,0" }]) {
    const machine = tabMachine(() => FAILING, { passthrough: "on\n" });
    const driven = stub({ env, answer: machine.answer });
    await driven.start();
    await drain();
    await readAgain(driven);
    await driven.end();
    assert.deepEqual(machine.tabs, [], JSON.stringify(env));
    // Not iTerm, so tmux is not asked either.
    assert.deepEqual(machine.tmux, [], JSON.stringify(env));
  }
});

test("a held level is said again every third of the staleness, which is the reading's", async () => {
  const reading = { ...FAILING, alerts: { state: "ready", progressMs: 1000,
    tabTint: { enabled: true, staleSeconds: 30 } } };
  const machine = tabMachine(() => reading);
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  assert.deepEqual(machine.tabs, [told("failed")]);
  // The heartbeat runs on its own timer, at a third of the staleness.
  assert.equal(driven.calls.every.includes(10_000), true, JSON.stringify(driven.calls.every));
  await beatAfter(driven, 9, 10_000);
  assert.equal(machine.tabs.length, 1);
  // A look, past the third, is the poll and says nothing about the tab.
  await lookAfter(driven, 1);
  assert.equal(machine.tabs.length, 1);
  await beatAfter(driven, 0, 10_000);
  assert.deepEqual(machine.tabs, [told("failed"), told("failed")]);
});

test("the heartbeat follows the staleness a new reading carries", async () => {
  let stale = 30;
  const reading = () => ({ ...FAILING, alerts: { state: "ready", progressMs: 1000,
    tabTint: { enabled: true, staleSeconds: stale } } });
  const machine = tabMachine(reading);
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  assert.equal(driven.calls.every.includes(10_000), true);
  const cancelled = driven.calls.cancelled;
  stale = 90;
  await readAgain(driven);
  assert.equal(driven.calls.every.includes(30_000), true, JSON.stringify(driven.calls.every));
  assert.equal(driven.calls.cancelled > cancelled, true, "the old beat was never stopped");
});

test("a session holding no level says none every third of the staleness, so a dead session's failure is let go", async () => {
  const reading = { ...OUTPUT, alerts: { state: "ready", progressMs: 1000,
    tabTint: { enabled: true, staleSeconds: 30 } } };
  const clear = tabMachine(() => reading);
  const survivor = stub({ env: ITERM, answer: clear.answer });
  await survivor.start();
  await drain();
  assert.deepEqual(clear.tabs, [told("none")]);
  await beatAfter(survivor, 9, 10_000);
  assert.equal(clear.tabs.length, 1);
  await beatAfter(survivor, 1, 10_000);
  await beatAfter(survivor, 10, 10_000);
  assert.deepEqual(clear.tabs, [told("none"), told("none"), told("none")]);
  // With tinting off there is no tab to keep, and no heartbeat.
  const off = { ...OUTPUT, alerts: { state: "ready", progressMs: 1000,
    tabTint: { enabled: false, staleSeconds: 30 } } };
  const quiet = tabMachine(() => off);
  const untinted = stub({ env: ITERM, answer: quiet.answer });
  await untinted.start();
  await drain();
  await beatAfter(untinted, 200, 10_000);
  await lookAfter(untinted, 200);
  assert.deepEqual(quiet.tabs, []);
});

test("a paint the helper says failed is asked once more, then the entry is only kept alive until the level moves", async () => {
  let reading: unknown = FAILING;
  const machine = tabMachine(() => reading, { tabExit: () => 1 });
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  assert.deepEqual(machine.tabs, [told("failed"), told("failed")]);
  // The same level on the next reading is not tried a third time.
  await readAgain(driven);
  assert.equal(machine.tabs.length, 2);
  // Past a third of the staleness the entry is kept alive, and not painted.
  await beatAfter(driven, 20, 40_000);
  assert.deepEqual(machine.tabs.slice(2), [told("failed", undefined, ["--record-only"])]);
  // A new level is painted again, and once more on failure.
  reading = WAITING;
  await readAgain(driven);
  assert.deepEqual(machine.tabs.slice(3), [told("waiting"), told("waiting")]);
});

test("a session that gave up on its paints still takes its entry out as it ends", async () => {
  const machine = tabMachine(() => FAILING, { tabExit: () => 1 });
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  await driven.end();
  assert.deepEqual(machine.tabs, [told("failed"), told("failed"), ended()]);
});

test("a clear the helper could not paint is still ended, so the tab is restored", async () => {
  let reading: unknown = FAILING;
  let exit = 0;
  const machine = tabMachine(() => reading, { tabExit: () => exit });
  const driven = stub({ env: ITERM, answer: machine.answer });
  await driven.start();
  await drain();
  exit = 1;
  reading = OUTPUT;
  await readAgain(driven);
  exit = 0;
  await driven.end();
  assert.deepEqual(machine.tabs, [told("failed"), told("none"), told("none"), ended()]);
});

test("a -p or SDK session starts no timer and reads nothing on its own", async () => {
  const machine = tabMachine(() => FAILING);
  const driven = stub({ env: ITERM, interactive: false, answer: machine.answer });
  const result = await driven.start() as { continued?: boolean };
  await drain();
  assert.equal(result.continued, true);
  // The commands are still there for a person who runs one.
  assert.deepEqual(driven.calls.commands, ["llm-fleet", "speak", "worktrees", "keys"]);
  assert.deepEqual(driven.calls.every, []);
  assert.deepEqual(driven.calls.argv, []);
  assert.deepEqual(machine.tabs, []);
  // An interactive session, by contrast, looks and arms its timers.
  const live = stub({ interactive: true });
  await live.start();
  await drain();
  assert.equal(live.calls.every.length > 0, true);
  assert.equal(live.calls.argv.length > 0, true);
});

/** The packaged tips, in the order the pane's Keys section lists them. */
const FIRST_TIP = "Ctrl+U clears the line before the cursor.";
const SECOND_TIP = "Ctrl+K clears the text after the cursor.";

test("a typed draft ends the hint line with a key tip that moves on at the configured interval", async () => {
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT } });
  await driven.start();
  await drain();
  // No draft: the line is the engine's, and no timer runs for it.
  const plain = await driven.hint({ isDraft: false }) as { tail?: string };
  assert.equal(plain.tail, undefined);
  assert.equal(driven.calls.every.includes(30_000), false);
  const drafted = await driven.hint({ isDraft: true, tail: "pill" }) as { tail?: string };
  assert.equal(drafted.tail, "pill  " + FIRST_TIP);
  assert.equal(driven.calls.every.filter((ms) => ms === 30_000).length, 1);
  driven.tick(30_000);
  const moved = await driven.hint({ isDraft: true }) as { tail?: string };
  assert.equal(moved.tail, "  " + SECOND_TIP);
  // The draft cleared: the timer stops, and the line is the engine's again.
  const before = driven.calls.cancelled;
  const cleared = await driven.hint({ isDraft: false }) as { tail?: string };
  assert.equal(cleared.tail, undefined);
  assert.equal(driven.calls.cancelled, before + 1);
});

test("a draft after the session ends starts no key tip timer", async () => {
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT } });
  await driven.start();
  await drain();
  await driven.hint({ isDraft: true });
  assert.equal(driven.calls.every.filter((ms) => ms === 30_000).length, 1);
  await driven.end();
  const tips = driven.calls.timers.filter((timer) => timer.ms === 30_000);
  assert.equal(tips.every((timer) => timer.cancelled), true);
  await driven.hint({ isDraft: true });
  assert.equal(driven.calls.every.filter((ms) => ms === 30_000).length, 1);
});

test("the key tip interval is the reading's refresh.keyTipMs", async () => {
  const reading = { ...OUTPUT, alerts: { state: "ready", progressMs: 1000, keyTipMs: 4500 } };
  const driven = stub({ stdout: JSON.stringify(reading) });
  await driven.start();
  await driven.settle();
  await driven.hint({ isDraft: true });
  assert.equal(driven.calls.every.includes(4500), true);
  assert.equal(driven.calls.every.includes(30_000), false);
});

test("/keys tips off hides the tip here and in the next session, and /keys tips on brings it back", async () => {
  const memory: Record<string, unknown> = {};
  const carried = { at: 1790000000, documents: OUTPUT };
  const driven = stub({ stored: carried, memory });
  await driven.start();
  await drain();
  const off = await driven.command("keys", "tips off") as { text: string };
  assert.equal(off.text, `Key tips off (${MARK}).`);
  assert.equal(memory[TIPS_KEY], false);
  assert.equal((await driven.hint({ isDraft: true }) as { tail?: string }).tail, undefined);
  // The Keys section says so too: one word for both places.
  await driven.render();
  await driven.press("fleet.all.expand");
  assert.equal(renderedText(await driven.render() as never).join("\n").includes("tips off"), true);

  const next = stub({ stored: carried, memory });
  await next.start();
  await drain();
  assert.equal((await next.hint({ isDraft: true }) as { tail?: string }).tail, undefined);
  const on = await next.command("keys", "tips on") as { text: string };
  assert.equal(on.text, `Key tips on (${MARK}).`);
  assert.equal(memory[TIPS_KEY], true);
  assert.equal((await next.hint({ isDraft: true }) as { tail?: string }).tail, "  " + FIRST_TIP);
});

test("/keys answers words it does not take with its usage, and says when the store or the configuration stands in the way", async () => {
  const driven = stub({ refuses: [TIPS_KEY] });
  await driven.start();
  for (const words of ["tips", "tips sideways", "open", "tips on now"]) {
    assert.equal((await driven.command("keys", words) as { text: string }).text,
                 "Use /keys to open the llm-fleet pane on its keys, or /keys tips off|on.");
  }
  const refused = await driven.command("keys", "tips off") as { text: string };
  assert.match(refused.text, /^Key tips off for this session; the store refused/);

  const reading = { ...OUTPUT, pane: { state: "ready", order: ["keys"],
    sections: { keys: { visible: true, collapsed: false } },
    keys: { tipsEnabled: false, tips: [FIRST_TIP] } } };
  const configured = stub({ stored: { at: 1790000000, documents: reading } });
  await configured.start();
  await drain();
  const on = await configured.command("keys", "tips on") as { text: string };
  assert.match(on.text, /configuration turns them off \(keys\.tipsEnabled\)/);
  assert.equal((await configured.hint({ isDraft: true }) as { tail?: string }).tail, undefined);
});

/** What the pane draws, as text, once it stops changing. */
async function drawnText(driven: Stub): Promise<string> {
  return renderedText(await driven.quiesce() as never).join("\n");
}

test("the machine is read within the configured time, and a worktree probe within its own", async () => {
  // Before any reading lands, the packaged times stand.
  const first = stub({});
  await first.start();
  await drain();
  const readerAt = first.calls.argv.findIndex((argv) => argv[1] === "/plugin/llm-fleet/" + READER);
  assert.notEqual(readerAt, -1);
  assert.equal(first.calls.runTimeouts[readerAt], 25_000);
  // A reading that carries the times sets them for the reads after it.
  const tuned = { ...OUTPUT, alerts: { helperMs: 4_000, worktreeHelperMs: 90_000 } };
  const driven = stub({ stored: { at: 1790000000, documents: tuned }, memory: {},
                        stdout: JSON.stringify(tuned) });
  await driven.start();
  await drain();
  const reads = driven.calls.argv.length;
  await driven.command("worktrees");
  driven.tick(LOOK_MS);
  await drain();
  const probed = driven.calls.argv.findIndex((argv, index) => index >= reads
                                              && argv.includes(FRESH_WORKTREES));
  assert.notEqual(probed, -1);
  assert.equal(driven.calls.runTimeouts[probed], 90_000);
  // An ordinary read takes the configured helper time.
  driven.advance(STALE_SECONDS + 1);
  driven.tick(LOOK_MS);
  await drain();
  const plain = driven.calls.argv.findIndex((argv, index) => index > probed
    && argv[1] === "/plugin/llm-fleet/" + READER && !argv.includes(FRESH_WORKTREES));
  assert.notEqual(plain, -1);
  assert.equal(driven.calls.runTimeouts[plain], 4_000);
});

test("a session with no reading learns its read time from the settings before its first read", async () => {
  // A configured source slower than the packaged time would end every first
  // read before the reading that carries the longer time could land.
  const slow = stub({ settings: async () => ({ exitCode: 0,
                                                stdout: JSON.stringify({ alerts: { helperMs: 90_000 } }) }) });
  await slow.start();
  await drain();
  assert.deepEqual(slow.calls.settings, [SETTINGS_MS]);
  const first = slow.calls.argv.findIndex((argv) => argv[1] === "/plugin/llm-fleet/" + READER);
  assert.notEqual(first, -1);
  assert.equal(slow.calls.runTimeouts[first], 90_000);
  // Known once, so the reads after it ask the machine alone.
  slow.advance(STALE_SECONDS + 1);
  slow.tick(LOOK_MS);
  await drain();
  assert.deepEqual(slow.calls.settings, [SETTINGS_MS]);
  // Settings that landed stand even while the machine keeps failing to read:
  // asking again would add a process to every failed read for nothing.
  const failing = stub({ exitCode: 1, stdout: "",
                         settings: async () => ({ exitCode: 0,
                                                  stdout: JSON.stringify({ alerts: { helperMs: 90_000 } }) }) });
  await failing.start();
  await drain();
  failing.advance(STALE_SECONDS + 1);
  failing.tick(LOOK_MS);
  await drain();
  const reads = failing.calls.argv.flatMap((argv, index) =>
    argv[1] === "/plugin/llm-fleet/" + READER ? [failing.calls.runTimeouts[index]] : []);
  assert.ok(reads.length >= 2);
  assert.ok(reads.every((ms) => ms === 90_000));
  assert.deepEqual(failing.calls.settings, [SETTINGS_MS]);
});

test("settings that answer after another session's reading landed do not replace its times", async () => {
  let answer: (() => void) | null = null;
  const memory: Record<string, unknown> = {};
  const driven = stub({ memory,
    settings: () => new Promise((resolve) => {
      answer = () => resolve({ exitCode: 0, stdout: JSON.stringify({ alerts: { helperMs: 90_000 } }) });
    }) });
  await driven.start();
  await drain();
  assert.deepEqual(driven.calls.settings, [SETTINGS_MS]);
  memory[READING_KEY] = { at: 1790000000 + 1, documents: { ...OUTPUT, alerts: { helperMs: 4_000 } } };
  driven.tick(LOOK_MS);
  await drain();
  // Assigned inside the stub's promise, which the checker cannot follow.
  const release = answer as unknown as (() => void) | null;
  if (release === null) {
    throw new Error("the settings read was never asked");
  }
  release();
  await drain();
  const first = driven.calls.argv.findIndex((argv) => argv[1] === "/plugin/llm-fleet/" + READER);
  assert.notEqual(first, -1);
  assert.equal(driven.calls.runTimeouts[first], 4_000);
});

test("every script starts under the person's interpreter and with their configuration file", async () => {
  const driven = stub({ pluginOptions: { python: "/opt/py/bin/python3.12", configPath: "/etc/llm-fleet/config.json" } });
  await driven.start();
  await drain();
  await driven.command("worktrees");
  driven.tick(LOOK_MS);
  await drain();
  const scripts = driven.calls.launches.filter((run) => run.argv[1]?.startsWith("/plugin/llm-fleet/readers/"));
  // The settings read, the whole read and the tab helper at least, each started the same way.
  assert.ok(scripts.length >= 3, String(scripts.length));
  for (const run of scripts) {
    assert.equal(run.argv[0], "/opt/py/bin/python3.12", run.argv.join(" "));
    assert.deepEqual(run.env, { FLEET_CONFIG: "/etc/llm-fleet/config.json" }, run.argv.join(" "));
  }
  assert.ok(scripts.some((run) => run.argv.includes(SETTINGS_ONLY)));
  // Options left out start every script as the package does, with no variables set.
  const plain = stub({});
  await plain.start();
  await drain();
  const packaged = plain.calls.launches.filter((run) => run.argv[1]?.startsWith("/plugin/llm-fleet/readers/"));
  assert.ok(packaged.length >= 2);
  for (const run of packaged) {
    assert.equal(run.argv[0], "python3");
    assert.equal(run.env, undefined);
  }
});

test("/llm-fleet doctor answers with the doctor's own lines, started like every other script", async () => {
  const report = "Fleet doctor: 1 thing to fix\n  Source jobs: unconfigured; fix: add a provider";
  const driven = stub({ pluginOptions: { python: "/opt/py/bin/python3.12" },
                        answer: (argv) => (argv[1]?.endsWith("readers/doctor.py")
                          ? { exitCode: 1, stdout: report + "\n" } : undefined) });
  await driven.start();
  await drain();
  const answer = await driven.run("doctor") as { text: string };
  assert.equal(answer.text, report);
  const doctorRuns = driven.calls.launches.filter((run) => run.argv[1]?.endsWith("readers/doctor.py"));
  assert.equal(doctorRuns.length, 1);
  assert.equal(doctorRuns[0]?.argv[0], "/opt/py/bin/python3.12");
  // The pane was neither opened nor closed by asking.
  assert.deepEqual(driven.calls.opened, []);
  assert.deepEqual(driven.calls.closed, []);
});

test("an interpreter that cannot be started is named with the option that sets it", async () => {
  for (const failure of ["throws", "silent"] as const) {
    const driven = stub({ pluginOptions: { python: "python9" },
      answer: (argv) => {
        if (!argv[1]?.endsWith("readers/doctor.py")) {
          return undefined;
        }
        if (failure === "throws") {
          throw new Error("spawn python9 ENOENT");
        }
        return { exitCode: 127, stdout: "" };
      } });
    await driven.start();
    await drain();
    const answer = await driven.run("doctor") as { text: string };
    assert.match(answer.text, /python9/, failure);
    assert.match(answer.text, /Python interpreter/, failure);
    assert.match(answer.text, /3\.11/, failure);
  }
});

test("/llm-fleet setup answers with what it wrote, and the next read learns the new file's times", async () => {
  const wrote = "Wrote a starter configuration at ~/.config/llm-fleet/config.json with $HOME/.claude.";
  const driven = stub({ answer: (argv) => (argv[1]?.endsWith("readers/setup.py")
    ? { exitCode: 0, stdout: wrote + "\n" } : undefined) });
  await driven.start();
  await drain();
  const asked = driven.calls.settings.length;
  const answer = await driven.run("setup") as { text: string };
  assert.ok(answer.text.startsWith(wrote), answer.text);
  assert.match(answer.text, /next read/);
  driven.advance(STALE_SECONDS + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.settings.length, asked + 1);
  // A file already there is left alone, and nothing is read again for it.
  const kept = stub({ answer: (argv) => (argv[1]?.endsWith("readers/setup.py")
    ? { exitCode: 3, stdout: "A configuration is already at ~/x.json; it was left as it is.\n" }
    : undefined) });
  await kept.start();
  await drain();
  const before = kept.calls.settings.length;
  const left = await kept.run("setup") as { text: string };
  assert.equal(left.text, "A configuration is already at ~/x.json; it was left as it is.");
  kept.advance(STALE_SECONDS + 1);
  kept.tick(LOOK_MS);
  await drain();
  assert.equal(kept.calls.settings.length, before);
});

test("the band draws in the theme the reading carries", async () => {
  const colorsOf = (value: unknown, found: string[] = []): string[] => {
    if (Array.isArray(value)) {
      value.forEach((item) => colorsOf(item, found));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if ((key === "color" || key.endsWith("Color")) && typeof inner === "string") {
          found.push(inner);
        } else if (typeof inner === "object") {
          colorsOf(inner, found);
        }
      }
    }
    return found;
  };
  const pane = { state: "ready", order: [], sections: {},
                 theme: { working: "claude", waiting: "planMode" } };
  const packaged = stub({ stored: { at: 1790000000, documents: { ...OUTPUT, pane: { ...pane, theme: {} } } } });
  await packaged.start();
  await drain();
  const before = colorsOf(await packaged.band());
  const themed = stub({ stored: { at: 1790000000, documents: { ...OUTPUT, pane } } });
  await themed.start();
  await drain();
  const after = colorsOf(await themed.band());
  assert.ok(before.includes("success") || before.includes("warning"), before.join(","));
  assert.ok(!after.includes("success") && !after.includes("warning"), after.join(","));
  assert.ok(after.includes("claude") || after.includes("planMode"), after.join(","));
});

test("settings that fail or are refused leave the packaged time, and the next read asks again", async () => {
  for (const answer of [{ exitCode: 1, stdout: "" },
                        { exitCode: 2, stdout: JSON.stringify({ configErrors: [] }) },
                        { exitCode: 0, stdout: "null" }]) {
    const driven = stub({ settings: async () => answer, exitCode: 1, stdout: "" });
    await driven.start();
    await drain();
    const first = driven.calls.argv.findIndex((argv) => argv[1] === "/plugin/llm-fleet/" + READER);
    assert.notEqual(first, -1, answer.stdout);
    assert.equal(driven.calls.runTimeouts[first], 25_000, answer.stdout);
    driven.advance(STALE_SECONDS + 1);
    driven.tick(LOOK_MS);
    await drain();
    assert.equal(driven.calls.settings.length, 2, answer.stdout);
  }
});

test("a session that opens on a kept reading takes its times from it and asks for no settings", async () => {
  const tuned = { ...OUTPUT, alerts: { helperMs: 4_000 } };
  const driven = stub({ stored: { at: 1790000000, documents: tuned }, memory: {},
                        stdout: JSON.stringify(tuned) });
  await driven.start();
  await drain();
  driven.advance(STALE_SECONDS + 1);
  driven.tick(LOOK_MS);
  await drain();
  assert.deepEqual(driven.calls.settings, []);
});

test("/worktrees opens the pane on Worktrees alone, probes them on the next look, and keeps the folds", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, memory });
  await driven.start();
  await drain();
  const reads = driven.calls.argv.length;
  const answer = await driven.command("worktrees") as { text: string };
  await drain();
  assert.equal(answer.text, `llm-fleet pane opened on Worktrees (${MARK}).`);
  assert.deepEqual(driven.calls.opened, [PANE]);
  // The command starts no process of its own: a probe takes longer than the
  // host lets a command's own work run.
  assert.equal(driven.calls.argv.length, reads);
  // The next look reads the whole machine with every worktree probed now,
  // though the shared reading is new enough to stand.
  driven.tick(LOOK_MS);
  await drain();
  const fresh = driven.calls.argv.slice(reads).filter((argv) => argv.includes(FRESH_WORKTREES));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.[1], "/plugin/llm-fleet/" + READER);
  // Once: the look after it reads nothing while the reading is new.
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.filter((argv) => argv.includes(FRESH_WORKTREES)).length, 1);
  const text = await drawnText(driven);
  assert.equal(text.includes("\u25be\nWorktrees"), true);
  assert.equal(text.includes("\u25b8\nBackground sessions"), true);
  assert.equal(text.includes("Review adapter behavior"), false);
  // Kept for the next session as a press keeps them.
  const kept = memory[FOLDS_KEY] as Record<string, boolean>;
  assert.equal(kept.worktrees, false);
  assert.equal(kept.sessions, true);
});

test("/worktrees run again with the pane open on Worktrees closes it, and probes nothing", async () => {
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, panes: [{ id: PANE }] });
  await driven.start();
  await drain();
  // Open, but on the configured fold, which keeps Worktrees folded: this opens it.
  await driven.command("worktrees");
  assert.deepEqual(driven.calls.closed, []);
  const again = await driven.command("worktrees") as { text: string };
  assert.equal(again.text, `llm-fleet pane closed (${MARK}).`);
  assert.deepEqual(driven.calls.closed, [PANE]);
  // The first run asked for a probe; the pane closed before the look came, so
  // the probe that asked for it is not wanted.
  driven.tick(LOOK_MS);
  await drain();
  assert.equal(driven.calls.argv.some((argv) => argv.includes(FRESH_WORKTREES)), false);
});

test("/worktrees waits for a read in flight, then probes as it lands", async () => {
  const driven = stub({ held: false });
  await driven.start();
  await drain();
  await driven.command("worktrees");
  driven.tick(LOOK_MS);
  await drain();
  // The read the session started is still out: the probe waits behind it.
  assert.equal(driven.calls.argv.some((argv) => argv.includes(FRESH_WORKTREES)), false);
  await driven.settle();
  await drain();
  assert.equal(driven.calls.argv.filter((argv) => argv.includes(FRESH_WORKTREES)).length, 1);
});

test("/keys opens the pane on Keys", async () => {
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT } });
  await driven.start();
  await drain();
  const answer = await driven.command("keys") as { text: string };
  assert.equal(answer.text, `llm-fleet pane opened on Keys (${MARK}).`);
  const text = await drawnText(driven);
  assert.equal(text.includes("\u25be\nKeys"), true);
  assert.equal(text.includes("close this pane"), true);
  assert.equal(text.includes("\u25b8\nBackground sessions"), true);
  // No probe: only /worktrees asks the worktrees how they stand now.
  assert.equal(driven.calls.argv.some((argv) => argv.includes(FRESH_WORKTREES)), false);
});

test("a -p session that submits a prompt runs no helper and writes nothing to the store", async () => {
  const driven = stub({ env: ITERM, interactive: false });
  await driven.start();
  await driven.prompt("summarize this");
  await drain();
  await driven.end();
  await drain();
  // No focus file is written for a session nobody types in, and nothing at all
  // reaches the store every session reads.
  assert.deepEqual(driven.calls.argv, []);
  assert.deepEqual(driven.calls.written, []);
});

test("a fold restored after a press lands in the store with the press, for the next session", async () => {
  const memory: Record<string, unknown> = { [FOLDS_KEY]: { skills: false, worktrees: false } };
  const carried = { at: 1790000000, documents: OUTPUT };
  // The host holds this session's first state read until the case lets it go,
  // so the press lands before the folds the last session left are read.
  const driven = stub({ stored: carried, session: {}, memory, heldState: true });
  await driven.quiesce();
  await driven.press("fleet.section.sessions");
  driven.releaseState();
  await drain();
  assert.deepEqual(memory[FOLDS_KEY], { skills: false, worktrees: false, sessions: true });
  // The next session opens with all three.
  const next = stub({ stored: carried, session: {}, memory });
  const text = renderedText(await next.quiesce() as never).join("\n");
  assert.equal(text.includes("\u25b8\nBackground sessions"), true);
  assert.equal(text.includes("\u25be\nSkills"), true);
  assert.equal(text.includes("\u25be\nWorktrees"), true);
});

test("/keys tips run before the startup read lands is not undone by it", async () => {
  // The person turned the tips off in an earlier session; this one turns them
  // back on before the store has answered what the earlier one left.
  const memory: Record<string, unknown> = { [TIPS_KEY]: false };
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, memory,
                        slowKeys: [TIPS_KEY] });
  await driven.start();
  const on = await driven.command("keys", "tips on") as { text: string };
  assert.equal(on.text, `Key tips on (${MARK}).`);
  await drain();
  assert.equal((await driven.hint({ isDraft: true }) as { tail?: string }).tail, "  " + FIRST_TIP);
  assert.equal(memory[TIPS_KEY], true);
});

/** A reading whose configuration hides Worktrees and Keys. */
const HIDDEN_SECTIONS = { ...OUTPUT, pane: { state: "ready", order: ["sessions", "worktrees", "keys"],
  sections: { sessions: { visible: true, collapsed: false },
              worktrees: { visible: false, collapsed: false },
              keys: { visible: false, collapsed: false } } } };

test("/worktrees and /keys on a section the configuration hides fold nothing and name the key that shows it", async () => {
  for (const [command, section] of [["worktrees", "worktrees"], ["keys", "keys"]] as const) {
    const memory: Record<string, unknown> = {};
    const driven = stub({ stored: { at: 1790000000, documents: HIDDEN_SECTIONS }, memory,
                          session: {} });
    await driven.start();
    await drain();
    const answer = await driven.command(command) as { text: string };
    assert.match(answer.text, new RegExp("pane\\.sections\\." + section + "\\.visible"), command);
    assert.deepEqual(driven.calls.opened, [], command);
    assert.equal(FOLDS_KEY in memory, false, command);
    assert.deepEqual(driven.calls.stated, [], command);
    driven.tick(LOOK_MS);
    await drain();
    assert.equal(driven.calls.argv.some((argv) => argv.includes(FRESH_WORKTREES)), false, command);
  }
});

test("a voice picked while an older line plays is the one the next line tries first", async () => {
  let reading: unknown = OUTPUT;
  const helped: string[][] = [];
  const finish: (() => void)[] = [];
  const twoVoices = { ...VOICES, voices: { female: ["af_sky", "af_bella"], male: ["am_adam"] } };
  const said = machine(helped, () => reading);
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
  ] } };
  const driven = stub({ notify: true, memory: { [SPEECH_ON_KEY]: SPOKEN },
                        answer: (argv) => (argv[1]?.endsWith("alerts.py") && argv[2] === "voices"
                          ? { exitCode: 0, stdout: JSON.stringify(twoVoices) } : said(argv)),
                        play: () => new Promise((resolve) => { finish.push(() => resolve()); }) });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  // The alert is playing in the first voice of the group.
  assert.deepEqual(voicesSaid(helped), ["--voice=af_sky"]);
  // The person picks the other voice while it plays; the greeting waits its turn.
  const reply = driven.speak("af_bella");
  await drain();
  finish.shift()?.();
  await drain();
  // The alert that finished after the pick does not take the pick's place.
  assert.deepEqual(voicesSaid(helped), ["--voice=af_sky", "--voice=af_bella"]);
  finish.shift()?.();
  const answer = await within(reply as Promise<{ text: string }>, "the greeting never ended");
  assert.equal(answer.text, "llm-fleet speaks as af_bella now.");
});

/** A reading with these jobs and this band document, dated at the stub's clock. */
function bandReading(jobs: unknown[], band?: Record<string, unknown>): Record<string, unknown> {
  return { ...OUTPUT, roster: { ...OUTPUT.roster, jobs }, ...(band ? { band } : {}) };
}

function waitingJob(id: string, since: number): Record<string, unknown> {
  return { provider: "one", id, name: "Job " + id, state: "blocked", label: "Blocked",
           started_at: 1789990000, last_seen_at: 1789999995, folder: "/tmp/" + id, since };
}

test("how long a waiting job stays on the band comes from the reading", async () => {
  const jobs = [waitingJob("job-old", 1789999000), waitingJob("job-new", 1789999900)];
  // The band leads with the first item and counts the rest after it.
  const shown = async (band?: Record<string, unknown>) => {
    const driven = stub({ stdout: JSON.stringify(bandReading(jobs, band)) });
    await driven.start();
    await drain();
    const tree = JSON.stringify(await driven.band(400));
    return { lead: ["job-old", "job-new"].filter((id) => tree.includes("Job " + id + " is waiting")),
             more: tree.includes("1 more waiting") };
  };
  // A day by default, so both are on the band.
  assert.deepEqual(await shown(), { lead: ["job-old"], more: true });
  // Ten minutes in the reading leaves the one that blocked a thousand seconds ago in the pane.
  assert.deepEqual(await shown({ state: "ready", hiddenLimit: 200, waitingJobSeconds: 600 }),
                   { lead: ["job-new"], more: false });
});

test("a dismissal keeps the keys that name something current, within the reading's limit", async () => {
  const jobs = [waitingJob("job-a", 1789999900), waitingJob("job-b", 1789999950)];
  const current = ["job:job-a:blocked:1789999900", "job:job-b:blocked:1789999950"];
  const dismissed = async (band: Record<string, unknown> | undefined, before: string[]) => {
    const memory: Record<string, unknown> = { [HIDDEN_KEY]: before };
    const driven = stub({ memory, stdout: JSON.stringify(bandReading(jobs, band)) });
    await driven.start();
    await drain();
    await driven.band(400);
    await driven.pressBand(BAND_DISMISS);
    await drain();
    return memory[HIDDEN_KEY];
  };
  // Keys left from items that have gone hide nothing, so the dismissal drops them.
  assert.deepEqual(await dismissed(undefined, ["trial:gone", "job:job-z:blocked:1"]), current);
  // The newest are kept within the limit the reading carries.
  assert.deepEqual(await dismissed({ state: "ready", hiddenLimit: 1, waitingJobSeconds: 86400 },
                                   []),
                   current.slice(-1));
});

test("a dismissal made while a provider failed keeps the job that provider could not report", async () => {
  const jobA = waitingJob("job-a", 1789999900);
  const failing = { repo: "owner/project", number: 9, title: "Red", branch: "red", head: "abc",
                    is_draft: false, checks: "fail" };
  let reading: Record<string, unknown> = bandReading([jobA]);
  const memory: Record<string, unknown> = {};
  const driven = stub({ memory, answer: machine([], () => reading) });
  await driven.start();
  await drain();
  await driven.band(400);
  await driven.pressBand(BAND_DISMISS);
  await drain();
  assert.deepEqual(memory[HIDDEN_KEY], ["job:job-a:blocked:1789999900"]);
  // The provider fails one read, and something else is dismissed meanwhile.
  reading = { ...OUTPUT, roster: { state: "failed", jobs: [], interactive: {}, providers: {},
                                   errors: [{ source: "jobs:one", reason: "exit 3" }] },
              prs: { state: "ready", prs: [failing] } };
  driven.advance(60);
  await driven.band(400);
  await drain();
  const red = JSON.stringify(await driven.band(400));
  assert.equal(red.includes("checks failing"), true, red);
  await driven.pressBand(BAND_DISMISS);
  await drain();
  assert.deepEqual(memory[HIDDEN_KEY],
                   ["job:job-a:blocked:1789999900", "pr:owner/project#9:abc"]);
  // The provider recovers: the job it could not report is still dismissed.
  reading = { ...bandReading([jobA]), prs: { state: "ready", prs: [failing] } };
  driven.advance(60);
  await driven.band(400);
  await drain();
  const back = JSON.stringify(await driven.band(400));
  assert.equal(back.includes("Job job-a is waiting"), false, back);
  assert.equal(back.includes("checks failing"), false, back);
});

/** Waiting jobs, all blocked at one time, and the band keys they make. */
function manyWaiting(count: number): { jobs: Record<string, unknown>[]; keys: string[] } {
  const jobs = Array.from({ length: count }, (_, index) => waitingJob("job-" + index, 1789999900));
  return { jobs, keys: jobs.map((job) => "job:" + String(job.id) + ":blocked:1789999900") };
}

test("the dismissed keys are cut to the reading's limit, whichever lands first", async () => {
  const { jobs, keys } = manyWaiting(250);
  const drawn = async (limit: number, hiddenFirst: boolean): Promise<string> => {
    const driven = stub({ memory: { [HIDDEN_KEY]: keys },
                          stdout: JSON.stringify(bandReading(jobs, { state: "ready",
                                                                     hiddenLimit: limit,
                                                                     waitingJobSeconds: 86400 })),
                          hiddenDelayTurns: hiddenFirst ? 0 : 150 });
    await driven.start();
    await drain(400);
    return JSON.stringify(await driven.band(400));
  };
  for (const hiddenFirst of [true, false]) {
    // A limit above two hundred keeps all 250: nothing waits on the band.
    const kept = await drawn(300, hiddenFirst);
    assert.equal(kept.includes("is waiting for you"), false, String(hiddenFirst));
    // A limit of ten keeps the newest ten, so 240 wait: one leads, 239 are counted.
    const cut = await drawn(10, hiddenFirst);
    assert.equal(cut.includes("239 more waiting"), true, String(hiddenFirst) + cut.slice(0, 400));
  }
});

test("a reading that carries no limit leaves the dismissed keys as they were", async () => {
  const { jobs, keys } = manyWaiting(250);
  const driven = stub({ memory: { [HIDDEN_KEY]: keys },
                        stdout: JSON.stringify(bandReading(jobs)), hiddenDelayTurns: 150 });
  await driven.start();
  await drain(400);
  const tree = JSON.stringify(await driven.band(400));
  assert.equal(tree.includes("is waiting for you"), false, tree.slice(0, 400));
});

test("an older voice pick held at its write gives way to the newer pick queued behind it", async () => {
  const helped: string[][] = [];
  let release: (() => void) | null = null;
  let held = false;
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: SPOKEN };
  const driven = stub({ memory, sessionId: "session-a",
                        answer: machine(helped),
                        gateStore: (key) => {
                          if (key !== "voice:session-a" || held) {
                            return undefined;
                          }
                          held = true;
                          return new Promise((resolve) => { release = () => resolve(); });
                        } });
  await driven.start();
  await drain();
  // The older pick waits at its write; the newer one waits its turn behind it.
  const older = driven.speak("male");
  await drain();
  const newer = driven.speak("female");
  await drain();
  assert.deepEqual(voicesSaid(helped), []);
  (release as (() => void) | null)?.();
  const replaced = await within(older as Promise<{ text: string }>, "the older pick never finished");
  await within(newer as Promise<unknown>, "the newer pick never finished");
  // The older pick, overtaken, greets nobody; the newer one greets and stands.
  assert.equal(replaced.text.includes("newer"), true, replaced.text);
  assert.deepEqual(voicesSaid(helped), ["--voice=af_sky"]);
  const status = await driven.speak("") as { text: string };
  assert.equal(status.text.startsWith("llm-fleet speaks as af_sky."), true, status.text);
  assert.deepEqual(memory["voice:session-a"], { voice: "female" });
});

test("a pick overtaken while it writes does not switch speech for every session", async () => {
  let release: (() => void) | null = null;
  let held = false;
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: false };
  const driven = stub({ memory, sessionId: "session-a", answer: machine([]),
                        gateStore: (key) => {
                          if (key !== "voice:session-a" || held) {
                            return undefined;
                          }
                          held = true;
                          return new Promise((resolve) => { release = () => resolve(); });
                        } });
  await driven.start();
  await drain();
  // "on" waits at its write while "off" is asked for behind it.
  const on = driven.speak("on");
  await drain();
  const off = driven.speak("off");
  await drain();
  (release as (() => void) | null)?.();
  await within(Promise.all([on, off]) as Promise<unknown>, "the picks never finished");
  assert.equal(memory[SPEECH_ON_KEY], false);
  assert.deepEqual(driven.calls.written.filter((entry) => entry.key === SPEECH_ON_KEY), []);
});

test("three picks, the first held while it reads, end on the last in this session and the store", async () => {
  const helped: string[][] = [];
  let release: (() => void) | null = null;
  let gating = false;
  const memory: Record<string, unknown> = { [SPEECH_ON_KEY]: SPOKEN };
  const driven = stub({ memory, sessionId: "session-a",
                        answer: machine(helped),
                        gateGet: (key) => {
                          if (!gating || key !== SPEECH_ON_KEY) {
                            return undefined;
                          }
                          gating = false;
                          return new Promise((resolve) => { release = () => resolve(); });
                        } });
  await driven.start();
  await drain();
  gating = true;
  // A waits inside its first read; B and C are asked for after it.
  const first = driven.speak("female");
  await drain();
  const second = driven.speak("male");
  await drain();
  const third = driven.speak("am_adam");
  await drain();
  (release as (() => void) | null)?.();
  await within(Promise.all([first, second, third]) as Promise<unknown>, "the picks never finished");
  await drain();
  // Only the last pick wrote, and only the last pick greeted.
  assert.deepEqual(driven.calls.written.filter((entry) => entry.key === "voice:session-a"),
                   [{ key: "voice:session-a", value: { voice: "male", name: "am_adam" } }]);
  assert.deepEqual(memory["voice:session-a"], { voice: "male", name: "am_adam" });
  assert.deepEqual(voicesSaid(helped), ["--voice=am_adam"]);
  const status = await driven.speak("") as { text: string };
  assert.equal(status.text.startsWith("llm-fleet speaks as am_adam."), true, status.text);
  // A later session under the same identifier opens on the last pick too.
  const again = stub({ memory, sessionId: "session-a", answer: machine([]) });
  await again.start();
  await drain();
  const reopened = await again.speak("") as { text: string };
  assert.equal(reopened.text.includes("am_adam"), true, reopened.text);
});

test("asking how speech stands while a line plays is not a pick, so the line's voice is kept", async () => {
  let reading: unknown = OUTPUT;
  const finish: (() => void)[] = [];
  const blocked = { ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [
    ...OUTPUT.roster.jobs,
    { provider: "one", id: "job-2", name: "Port the voice", state: "blocked", label: "Blocked",
      started_at: 1789999400, last_seen_at: 1789999995, folder: "/tmp/q", since: 1789999990 },
  ] } };
  const driven = stub({ notify: true, memory: { [SPEECH_ON_KEY]: SPOKEN },
                        answer: machine([], () => reading),
                        play: () => new Promise((resolve) => { finish.push(() => resolve()); }) });
  await driven.start();
  await drain();
  driven.advance(60);
  await driven.render();
  await drain();
  reading = blocked;
  driven.advance(60);
  await driven.render();
  await drain();
  assert.equal(driven.calls.played, 1);
  const asked = await driven.speak("") as { text: string };
  assert.equal(asked.text.startsWith("llm-fleet speaks as female voice."), true, asked.text);
  await driven.speak("list");
  finish.shift()?.();
  await drain();
  const after = await driven.speak("") as { text: string };
  assert.equal(after.text.startsWith("llm-fleet speaks as af_sky."), true, after.text);
});

test("a reading the paint finds after the keys were read keeps them within its limit", async () => {
  // The band paints before the session starts, so it asks for the reading the
  // last session left; the keys land first, then that reading, and the
  // session's own look finds nothing newer to take.
  const { jobs, keys } = manyWaiting(250);
  const driven = stub({ held: false, memory: { [HIDDEN_KEY]: keys }, readingDelays: [20, 80],
                        stored: { at: 1790000000,
                                  documents: bandReading(jobs, { state: "ready", hiddenLimit: 10,
                                                                 waitingJobSeconds: 86400 }) } });
  await driven.band(400);
  await driven.start();
  await drain(200);
  const tree = JSON.stringify(await driven.band(400));
  assert.equal(tree.includes("239 more waiting"), true, tree.slice(0, 400));
});

test("a reading another session left cuts the dismissed keys to its limit as it is drawn", async () => {
  const { jobs, keys } = manyWaiting(250);
  const driven = stub({ held: false, memory: { [HIDDEN_KEY]: keys },
                        stored: { at: 1790000000,
                                  documents: bandReading(jobs, { state: "ready", hiddenLimit: 10,
                                                                 waitingJobSeconds: 86400 }) } });
  await driven.start();
  await drain(200);
  await driven.band(400);
  await drain(200);
  const tree = JSON.stringify(await driven.band(400));
  assert.equal(tree.includes("239 more waiting"), true, tree.slice(0, 400));
});

test("an open pane is drawn every second so its ages count, and the clock stops when it closes", async () => {
  // Drawn only when a reading landed, the age sat still and then leapt: "4s
  // ago", then "27s ago", then "1s ago".
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: OUTPUT } });
  await driven.start();
  await driven.run();
  await drain();
  await driven.render();
  assert.equal(driven.calls.every.includes(CLOCK_MS), true);
  const before = driven.calls.invalidated.length;
  driven.tick(CLOCK_MS);
  assert.equal(driven.calls.invalidated.length, before + 1);
  driven.advance(3);
  const later = renderedText(await driven.render() as never).join("\n");
  assert.equal(later.includes("Updated 4s ago"), true);
  // Closed, the clock asks for nothing more and lets its timer go.
  await driven.run("close");
  await drain();
  const closed = driven.calls.invalidated.length;
  driven.tick(CLOCK_MS);
  assert.equal(driven.calls.invalidated.length, closed);
  assert.equal(driven.calls.timers.filter((timer) => timer.ms === CLOCK_MS)
    .every((timer) => timer.cancelled), true);
});

test("a reading that changes several sections lands them a step apart, in pane order", async () => {
  // Every section that changed used to change in one frame; now the first lands
  // at once and the rest follow it down the pane.
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: OUTPUT }, memory });
  await driven.start();
  await driven.run();
  await drain();
  await driven.render();
  memory[READING_KEY] = { at: 1790000000, documents: {
    ...OUTPUT,
    roster: { ...OUTPUT.roster, jobs: [] },
    prs: { state: "ready", errors: [], prs: [{ repo: "owner/project", number: 7,
                                               title: "Add check dots", branch: "feat/dots",
                                               head: "abcdef123456", is_draft: false,
                                               checks: "pass" }] },
  } };
  driven.tick(LOOK_MS);
  await drain();
  const first = renderedText(await driven.render() as never).join("\n");
  // Pull requests come before background sessions on the pane, so they land first.
  assert.equal(first.includes("Add check dots"), true);
  assert.equal(first.includes("Review adapter behavior"), true);
  const steps = driven.calls.timers.filter((timer) => timer.ms === STREAM_MS);
  assert.equal(steps.length, 1);
  driven.tick(STREAM_MS);
  await driven.render();
  driven.advance(1);
  const after = renderedText(await driven.render() as never).join("\n");
  assert.equal(after.includes("Review adapter behavior"), false);
  assert.equal(after.includes("Add check dots"), true);
  // Nothing is left to land, so the step timer is let go.
  assert.equal(steps.every((timer) => timer.cancelled), true);
});

test("a section that changes again mid-stream waits its turn, so the sections after it still land", async () => {
  // Stepped toward the latest reading by the pane's order, a section read
  // faster than the stream steps took the first place on every step, and the
  // sections after it never landed.
  const memory: Record<string, unknown> = {};
  const driven = stub({ held: false, stored: { at: 1790000000 - 1, documents: OUTPUT }, memory });
  await driven.start();
  await driven.run();
  await drain();
  await driven.render();
  const pull = (title: string) => ({ state: "ready", errors: [], prs: [{
    repo: "owner/project", number: 7, title, branch: "feat/dots", head: "abcdef123456",
    is_draft: false, checks: "pass" }] });
  memory[READING_KEY] = { at: 1790000000, documents: {
    ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [] }, prs: pull("First title") } };
  driven.tick(LOOK_MS);
  await drain();
  await driven.render();
  memory[READING_KEY] = { at: 1790000001, documents: {
    ...OUTPUT, roster: { ...OUTPUT.roster, jobs: [] }, prs: pull("Second title") } };
  driven.advance(1);
  driven.tick(LOOK_MS);
  await drain();
  driven.tick(STREAM_MS);
  await driven.render();
  // Past the slide, so a row that left is gone from the frame.
  driven.advance(1);
  const after = renderedText(await driven.render() as never).join("\n");
  // The roster was next in line and lands; the pull request that changed again
  // lands after it rather than ahead of it.
  assert.equal(after.includes("Review adapter behavior"), false, after);
  assert.equal(after.includes("First title"), true, after);
  assert.equal(after.includes("Second title"), false, after);
  driven.tick(STREAM_MS);
  await drain();
  await driven.render();
  driven.tick(STREAM_MS);
  const last = renderedText(await driven.render() as never).join("\n");
  assert.equal(last.includes("Second title"), true, last);
});

test("a live run's elapsed time counts on between reads of its counts", async () => {
  const driven = stub({ held: false, stored: liveReading(1790000000 - 1, 290) });
  await driven.start();
  await driven.run();
  await drain();
  const now = renderedText(await driven.render() as never).join("\n");
  assert.equal(now.includes("23s elapsed"), true, now);
  driven.advance(10);
  const later = renderedText(await driven.render() as never).join("\n");
  assert.equal(later.includes("33s elapsed"), true, later);
  assert.equal(driven.calls.argv.length, 0);
});

/** The store key the digest's last look is kept under, as the types contract declares it. */
const SEEN = "digest-seen";
/** Where the host holds this session's own look, keyed as the engine keys its values. */
const HELD_SEEN = "llm-fleet/digestSeen";

/** An ISO time at these epoch seconds, as the readers write one. */
function isoAt(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

/** A reading holding two events, one newer than the last look the cases keep and one older. */
const DIGEST = {
  ...OUTPUT,
  events: { state: "ready", sources: { trials: "ready", prs: "ready", roster: "ready" }, errors: [],
            events: [{ at: isoAt(1789999900), kind: "trial-failed", title: "repo feat/new", ref: "k1" },
                     { at: isoAt(1789990000), kind: "pr-opened", title: "Older pull", ref: "o/p#1" }] },
};

/** A reading whose events are these titles at these epoch seconds. */
function digestOf(...entries: [string, number][]) {
  return { ...DIGEST, events: { ...DIGEST.events,
    events: entries.map(([title, at]) => ({ at: isoAt(at), kind: "pr-opened", title, ref: "o/p#" + at })) } };
}

/** Lets the store writes a press started finish, up to a bound. */
async function storeSettles(memory: Record<string, unknown>, key: string): Promise<void> {
  for (let turn = 0; turn < 50 && !(key in memory); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Lets every write a press started finish. */
async function settles(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("closing the pane keeps the newest event the digest drew, and the next look draws only newer", async () => {
  const memory: Record<string, unknown> = { [SEEN]: { at: 1789995000 } };
  const session: Record<string, unknown> = {};
  const carried = { at: 1790000000, documents: DIGEST };
  const driven = stub({ stored: carried, memory, session });
  await driven.start();
  const text = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(text.includes("Since you left"), true, text);
  assert.equal(text.includes("repo feat/new"), true);
  // Older than the last look, so not news.
  assert.equal(text.includes("Older pull"), false);
  await driven.press("fleet.close");
  await settles();
  // The session's own look, held by the host, and the look every session shares.
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
  assert.deepEqual(memory[SEEN], { at: 1789999900 });
  // The next session shares the store: nothing is newer than that look.
  const next = stub({ stored: carried, memory, sessionId: "session-next" });
  await next.start();
  const again = renderedText(await next.quiesce() as never).join("\n");
  assert.equal(again.includes("Since you left"), false, again);
});

test("a pane Escape closed moves the last look when the band next finds it shut", async () => {
  const memory: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const panes = [{ id: PANE }];
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, session, panes });
  await driven.start();
  await driven.band();
  // No last look yet: the first one shows the newest of what the reading holds.
  const text = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(text.includes("Older pull"), true, text);
  // Escape closes the pane without a word to the plugin; the band sees it gone.
  panes.length = 0;
  await driven.band();
  await settles();
  // The band is a paint, and the host refuses a write a paint makes: nothing
  // is written until the next tick, which is an event of its own.
  assert.equal(SEEN in memory, false);
  assert.equal(HELD_SEEN in session, false);
  driven.tick(AFTER_PAINT_MS);
  await storeSettles(memory, SEEN);
  await settles();
  assert.deepEqual(memory[SEEN], { at: 1789999900 });
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
  assert.deepEqual(driven.calls.refusedInRender, []);
  // One tick is all it waits for: the timer is stopped, not left running.
  const ticks = driven.calls.timers.filter((timer) => timer.ms === AFTER_PAINT_MS);
  assert.equal(ticks.length > 0 && ticks.every((timer) => timer.cancelled), true);
});

test("a restored fold written at the tick never lands over another load's later press", async () => {
  // Two loads of one session share the host's fold and the store. A's restore
  // reads the last session's folds from the store before B presses, and lands
  // after. Written late, it may add only what nobody pressed (skills), and must
  // leave B's presses as B left them, in the store and in the held fold alike.
  const session: Record<string, unknown> = {};
  const memory: Record<string, unknown> = {
    [FOLDS_KEY]: { worktrees: true, sessions: false, skills: true } };
  let releaseStore: () => void = () => undefined;
  const storeHeld = new Promise<void>((resolve) => { releaseStore = resolve; });
  // A's own state writes go through until the case holds the one its tick makes.
  let holding = false;
  let let_go: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { let_go = resolve; });
  const first = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, memory,
                       heldState: true,
                       gateGetStale: (key) => (key === FOLDS_KEY ? storeHeld : undefined),
                       gateState: (key) => (holding && key === "llm-fleet/folded" ? gate : undefined) });
  await first.quiesce();
  await first.press("fleet.section.worktrees");
  await settles();
  // A's restore asks the store now, and is answered with what it held then.
  first.releaseState();
  await settles();
  const second = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, memory });
  await second.quiesce();
  await second.press("fleet.section.sessions");
  await settles();
  assert.equal((memory[FOLDS_KEY] as Record<string, boolean>).sessions, true);
  releaseStore();
  await first.quiesce();
  await settles();
  // The store keeps B's sessions and gains A's worktrees, rather than taking
  // A's picture, which was read before B pressed.
  assert.deepEqual(memory[FOLDS_KEY], { worktrees: false, sessions: true, skills: true });
  // A's tick writes what its restore brought; the case holds that write while
  // B presses again, so it is made at a version that has moved.
  holding = true;
  first.tick(AFTER_PAINT_MS);
  await settles();
  await second.render();
  await second.press("fleet.section.sessions");
  await settles();
  const later = { ...(session["llm-fleet/folded"] as Record<string, boolean>) };
  assert.equal(later.sessions, false);
  assert.equal("skills" in later, false);
  let_go();
  await settles();
  assert.deepEqual(session["llm-fleet/folded"], { ...later, skills: true });
  // A wrote three times: its press, the tick's write refused at the moved
  // version, and the one made after reading again.
  assert.equal(first.calls.stateSets.filter((key) => key === "llm-fleet/folded").length, 3);
  assert.deepEqual(first.calls.refusedInRender, []);
  // B folds sessions once more, so A's picture of it, open, is out of date. A
  // press from A now changes only the section it pressed, in the held fold and
  // in the store.
  await second.render();
  await second.press("fleet.section.sessions");
  await settles();
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, true);
  holding = false;
  await first.render();
  await first.press("fleet.section.worktrees");
  await settles();
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, true);
  assert.equal((memory[FOLDS_KEY] as Record<string, boolean>).sessions, true);
});

test("one load's fold presses land in the order they were pressed", async () => {
  // The first press's write is held; the second is pressed meanwhile. Run side
  // by side, the first would be refused at the moved version, read again, and
  // land its older press over the newer one.
  const session: Record<string, unknown> = {};
  let sets = 0;
  let let_go: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { let_go = resolve; });
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, session,
                        gateState: (key) => {
                          if (key !== "llm-fleet/folded") {
                            return undefined;
                          }
                          sets += 1;
                          return sets === 1 ? gate : undefined;
                        } });
  await driven.start();
  await driven.quiesce();
  await settles();
  await driven.press("fleet.section.sessions");
  const first = driven.calls.stated.length;
  await driven.render();
  await driven.press("fleet.section.sessions");
  await settles();
  // The second waits behind the first rather than landing before it.
  assert.equal(driven.calls.stated.length, first);
  let_go();
  await settles();
  const drawn = renderedText(await driven.render() as never).join("\n");
  const open = drawn.includes("▾\nBackground sessions");
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, !open);
  assert.equal(driven.calls.stated.length, first + 2);
});

test("Collapse all writes every section it names, even one this load already drew folded", async () => {
  // A collapses everything; B opens sessions; A collapses everything again. A
  // drew sessions folded all along, but the press is A's last word on it.
  const session: Record<string, unknown> = {};
  const memory: Record<string, unknown> = {};
  const first = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, memory });
  await first.start();
  await first.quiesce();
  await first.press("fleet.all.collapse");
  await settles();
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, true);
  const second = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, memory });
  await second.quiesce();
  await settles();
  await second.press("fleet.section.sessions");
  await settles();
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, false);
  assert.equal((memory[FOLDS_KEY] as Record<string, boolean>).sessions, false);
  await first.render();
  await first.press("fleet.all.collapse");
  await settles();
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, true);
  assert.equal((memory[FOLDS_KEY] as Record<string, boolean>).sessions, true);
});

test("the session's end waits for a fold write still out, and lets go after its bound", async () => {
  const session: Record<string, unknown> = {};
  let let_go: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { let_go = resolve; });
  let holding = false;
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, session,
                        gateState: (key) => (holding && key === "llm-fleet/folded" ? gate : undefined) });
  await driven.start();
  await driven.quiesce();
  await settles();
  holding = true;
  await driven.press("fleet.section.sessions");
  await settles();
  let ended = false;
  const end = driven.end().then(() => { ended = true; });
  await settles();
  // The write is held, so the end is too.
  assert.equal(ended, false);
  assert.equal(driven.calls.every.includes(END_WRITES_MS), true);
  let_go();
  await end;
  assert.equal(ended, true);
  assert.equal(typeof (session["llm-fleet/folded"] as Record<string, boolean>).sessions, "boolean");

  // A write the host never answers holds the end only until the bound.
  let never: () => void = () => undefined;
  const stuck = new Promise<void>((resolve) => { never = resolve; });
  const other = stub({ stored: { at: 1790000000, documents: OUTPUT }, session: {},
                       gateState: (key) => (key === "llm-fleet/folded" ? stuck : undefined) });
  await other.start();
  await other.quiesce();
  await settles();
  await other.press("fleet.section.sessions");
  let otherEnded = false;
  const otherEnd = other.end().then(() => { otherEnded = true; });
  await settles();
  assert.equal(otherEnded, false);
  other.tick(END_WRITES_MS);
  await otherEnd;
  assert.equal(otherEnded, true);
  never();
});

test("the session's end waits for the writes a fold read lands during the wait", async () => {
  // The fold read is still out when the end starts, and its answer brings a
  // section back, which it writes once it lands: the end has to wait for a
  // write that did not exist when it started.
  // The session holds no fold, so the read goes on to the store, which the
  // case holds.
  const session: Record<string, unknown> = {};
  const memory: Record<string, unknown> = { [FOLDS_KEY]: { sessions: true } };
  let answer: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => { answer = resolve; });
  let let_go: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { let_go = resolve; });
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, memory,
                        gateGet: (key) => (key === FOLDS_KEY ? asked : undefined),
                        gateState: (key) => (key === "llm-fleet/folded" ? gate : undefined) });
  await driven.start();
  await settles();
  let ended = false;
  const end = driven.end().then(() => { ended = true; });
  await settles();
  assert.equal(ended, false);
  answer();
  await settles();
  // The read landed and its write is held, so the end still waits.
  assert.equal(ended, false);
  assert.deepEqual(driven.calls.stateSets, []);
  let_go();
  await end;
  assert.equal(ended, true);
  assert.deepEqual(driven.calls.stateSets, ["llm-fleet/folded"]);
  assert.equal((session["llm-fleet/folded"] as Record<string, boolean>).sessions, true);
});

test("a fold read that lands after the session ended is still written", async () => {
  // The session's end drains what is queued; a read still out then queues its
  // write after that drain, and nothing would ever run it.
  // The session holds no fold, so the restore brings the last session's from the
  // store, and only the restore's own write puts sessions in the held fold.
  const session: Record<string, unknown> = {};
  const memory: Record<string, unknown> = { [FOLDS_KEY]: { worktrees: true, sessions: true } };
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, memory,
                        heldState: true });
  await driven.start();
  await driven.quiesce();
  await driven.press("fleet.section.worktrees");
  // The end waits for the read, but only as long as its bound: here the read
  // outlasts it, so the end is over before the read lands.
  const end = driven.end();
  await settles();
  driven.tick(END_WRITES_MS);
  await within(end, "the end outlasted its bound");
  driven.releaseState();
  await settles();
  assert.deepEqual(session["llm-fleet/folded"], { worktrees: false, sessions: true });
  assert.deepEqual(driven.calls.refusedInRender, []);
  assert.equal(driven.calls.stateSets.filter((key) => key === "llm-fleet/folded").length, 2);
});

test("a close the band found is written at the session's end when no tick came first", async () => {
  const memory: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const panes = [{ id: PANE }];
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, session, panes });
  await driven.start();
  await driven.band();
  await driven.quiesce();
  panes.length = 0;
  await driven.band();
  await driven.end();
  await storeSettles(memory, SEEN);
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
  assert.deepEqual(memory[SEEN], { at: 1789999900 });
});

test("with no clock, a close the band found waits for the next prompt rather than the paint", async () => {
  const memory: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const panes = [{ id: PANE }];
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, session, panes,
                        noClock: true });
  await driven.start();
  await driven.band();
  await driven.quiesce();
  panes.length = 0;
  await driven.band();
  await settles();
  assert.deepEqual(driven.calls.refusedInRender, []);
  assert.equal(HELD_SEEN in session, false);
  await driven.prompt("next");
  await storeSettles(memory, SEEN);
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
});

test("a session's look is kept however many loads write first", async () => {
  // Each refusal is another load's write landing; none of them is a reason to
  // give up on the later look.
  const session: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory: {}, session,
                        stateConflicts: 6 });
  await driven.start();
  await driven.quiesce();
  await driven.press("fleet.close");
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
  assert.equal(driven.calls.stateSets.filter((key) => key === HELD_SEEN).length, 7);
});

test("a press made before the restored fold is written is not undone when it is", async () => {
  // The restore read for a paint, so its write waits for the tick; a press in
  // between wrote itself, and the tick must write the fold as it stands then.
  const session: Record<string, unknown> = {
    "llm-fleet/folded": { worktrees: true, sessions: true } };
  const driven = stub({ stored: { at: 1790000000, documents: OUTPUT }, session, heldState: true });
  await driven.quiesce();
  await driven.press("fleet.section.worktrees");
  driven.releaseState();
  await driven.quiesce();
  // Sessions was folded by the host; the person opens it before the tick.
  await driven.press("fleet.section.sessions");
  driven.tick(AFTER_PAINT_MS);
  await settles();
  driven.reload();
  const reloaded = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(reloaded.includes("▾\nBackground sessions"), true, reloaded);
  assert.equal(reloaded.includes("▾\nWorktrees"), true, reloaded);
});

test("a store that cannot say what it holds has no look written over it", async () => {
  // Blind, a write could move back a look another session moved further.
  const memory: Record<string, unknown> = { [SEEN]: { at: 1790000500 } };
  const session: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, session,
                        gateGet: (key) => (key === SEEN ? Promise.reject(new Error("store down")) : undefined) });
  await driven.start();
  await driven.quiesce();
  await driven.press("fleet.close");
  await settles();
  assert.deepEqual(memory[SEEN], { at: 1790000500 });
  assert.equal(driven.calls.stored.some((entry) => entry.key === SEEN), false);
  // The session's own look is the host's, and it is still kept.
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
});

test("a host that refuses a write without moving its version is not asked again", async () => {
  // Only a version that moved is another load's write; a refusal at the version
  // read is no race, and asking again would never end.
  const session: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory: {}, session,
                        stateStuck: true });
  await driven.start();
  await driven.quiesce();
  await driven.press("fleet.close");
  await settles();
  assert.equal(HELD_SEEN in session, false);
  assert.equal(driven.calls.stateSets.filter((key) => key === HELD_SEEN).length, 1);
});

test("a pane closed before it drew a digest moves no last look", async () => {
  const memory: Record<string, unknown> = { [SEEN]: { at: 1789995000 } };
  const panes: { id: string }[] = [];
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, panes });
  await driven.start();
  await driven.run();
  panes.push({ id: PANE });
  await driven.run("close");
  await settles();
  assert.deepEqual(memory[SEEN], { at: 1789995000 });
  assert.equal(driven.calls.stored.some((entry) => entry.key === SEEN), false);
  assert.equal(driven.calls.stated.some((entry) => entry.key === HELD_SEEN), false);
});

test("a shared look another session moved further is not moved back", async () => {
  const memory: Record<string, unknown> = { [SEEN]: { at: 1789995000 } };
  const session: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, session });
  await driven.start();
  await driven.quiesce();
  // Another session closed its pane on a later event meanwhile.
  memory[SEEN] = { at: 1790000500 };
  await driven.press("fleet.close");
  await settles();
  assert.deepEqual(memory[SEEN], { at: 1790000500 });
  assert.equal(driven.calls.stored.some((entry) => entry.key === SEEN), false);
  // This session still keeps its own look.
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
});

test("two loads of one session closing at once never move its look back", async () => {
  // A hot reload leaves the old load's write in flight while the new load writes.
  // The host's values are shared by both and written only at the version read,
  // so the stale write is refused and re-read rather than landing over the later.
  const memory: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const before = stub({ stored: { at: 1790000000, documents: digestOf(["first", 1789999000]) }, memory,
                        session, gateState: (key) => (key === HELD_SEEN ? held : undefined) });
  const after = stub({ stored: { at: 1790000000,
                                 documents: digestOf(["second", 1789999900], ["first", 1789999000]) },
                       memory, session });
  await before.start();
  await after.start();
  await before.quiesce();
  await after.quiesce();
  await before.press("fleet.close");
  await after.press("fleet.close");
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
  release();
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
  assert.equal(before.calls.stated.some((entry) => entry.key === HELD_SEEN), false,
               "the stale write landed");
  // The shared look is the later one too: the earlier load found it already there.
  assert.deepEqual(memory[SEEN], { at: 1789999900 });
});

test("a load whose later look was refused reads again and keeps it", async () => {
  // The other order: the later look's write is held while the earlier one lands,
  // so the version it read is gone and its write is refused. It must read the
  // earlier look and write over it, or the session keeps the earlier look.
  const memory: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const before = stub({ stored: { at: 1790000000, documents: digestOf(["first", 1789999000]) }, memory,
                        session });
  const after = stub({ stored: { at: 1790000000,
                                 documents: digestOf(["second", 1789999900], ["first", 1789999000]) },
                       memory, session, gateState: (key) => (key === HELD_SEEN ? held : undefined) });
  await before.start();
  await after.start();
  await before.quiesce();
  await after.quiesce();
  await after.press("fleet.close");
  await settles();
  await before.press("fleet.close");
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999000 });
  release();
  await settles();
  assert.deepEqual(session[HELD_SEEN], { at: 1789999900 });
});

test("a pane reopened in its session starts from the session's own look, whatever the shared one says", async () => {
  // The shared look has no compare-and-set, so a close that crossed another can
  // leave it behind; the session's own look, held by the host, does not move back.
  const memory: Record<string, unknown> = { [SEEN]: { at: 1 } };
  const session: Record<string, unknown> = { [HELD_SEEN]: { at: 1789999900 } };
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, session });
  await driven.start();
  const text = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(text.includes("Since you left"), false, text);
  // And with nothing held for the session, the shared look is what it starts from.
  const fresh = stub({ stored: { at: 1790000000, documents: DIGEST },
                       memory: { [SEEN]: { at: 1789999900 } }, session: {} });
  await fresh.start();
  const again = renderedText(await fresh.quiesce() as never).join("\n");
  assert.equal(again.includes("Since you left"), false, again);
});

test("a host that will not hold the session's look still gets the shared one", async () => {
  const memory: Record<string, unknown> = {};
  const driven = stub({ stored: { at: 1790000000, documents: DIGEST }, memory, refusesState: true });
  await driven.start();
  await driven.quiesce();
  await driven.press("fleet.close");
  await storeSettles(memory, SEEN);
  assert.deepEqual(memory[SEEN], { at: 1789999900 });
  // The pane in front of the person carries on: reopened, it has nothing new.
  await driven.run();
  const text = renderedText(await driven.quiesce() as never).join("\n");
  assert.equal(text.includes("Since you left"), false, text);
});
