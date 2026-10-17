/**
 * The engine contract this entry writes against, declared here rather than
 * imported.
 *
 * The engine publishes a generated declaration of its whole API. Publishing a
 * copy of it, or importing the file from this repository, is what the host
 * binding rule refuses: a 622 KB generated file is not reviewable through an
 * allowlist, and a copy drifts in silence. So this file declares the narrow
 * subset the entry actually calls, and `scripts/host-drift.py` fails by name when
 * the engine no longer carries one of them.
 *
 * Only what the pane entry uses is here. Adding a call means adding it to this
 * file first, which is the point: the surface the repository depends on stays
 * small enough to read.
 */

export type RenderedSurface = {
  /** Whether the host found room to place the surface. */
  isPlaced: boolean;
};

export type CommandRegistration = {
  name: string;
  description: string;
  argumentHint?: string;
  /**
   * Runs the command while a turn streams, rather than queued behind it. A
   * switch that waits for the model to finish is not a switch.
   */
  immediate?: true;
};

export type PaneRequest = {
  id: string;
  title?: string;
  focus?: boolean;
  closeOnEscape?: boolean;
};

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Whether a copy reached a clipboard, and why not when it did not. */
export type CopyResult = { isCopied: true } | { isCopied: false; reason?: string };

/** Whether a message reached the other session's queue, and why not when it did not. */
export type SendResult = { isDelivered: true } | { isDelivered: false; reason: string };

/** One value the host holds for this plugin, and the version it stands at. */
export type StateRead = {
  value: unknown;
  version: number;
};

export type StateSetResult = {
  /** False when an `ifVersion` write found a different version standing. */
  isSet: boolean;
  version: number;
};

/** A value is named by the plugin that owns it and the key it is kept under. */
export type StateRef = {
  plugin: string;
  key: string;
};

export type Engine = {
  command: {
    register(options: CommandRegistration): Promise<unknown>;
  };
  ui: {
    open(request: PaneRequest): Promise<RenderedSurface>;
    close(request: { id: string }): Promise<unknown>;
    panes(): Promise<{ id: string }[]>;
    /** The element constructors a render hook draws with. */
    resolve(event: unknown): unknown;
    /**
     * Re-runs the render hooks this plugin may draw again, so a pane whose
     * reading changed is painted once more.
     */
    invalidate(event: string): void;
    toast(message: string, options?: { timeoutMs?: number }): Promise<unknown>;
    /** A native notification through the person's own terminal. */
    notify(text: string, options?: { title?: string }): Promise<unknown>;
    /**
     * Puts a line on the clipboard of the surface a press came from, and says
     * whether it took: a remote surface with no path yet answers why not.
     */
    copy(args: { text: string; surface?: string }): Promise<CopyResult>;
  };
  clock: {
    now(): Promise<number>;
    /** Calls `fn` every `ms` milliseconds until cancelled. */
    every(ms: number, fn: () => void): { cancel(): void };
  };
  fs: {
    /** A file's bytes, base64, which is how a synthesized line reaches the player. */
    read(path: string, options: { as: "bytes" }): Promise<{ base64: string }>;
  };
  audio: {
    /** Plays one clip from its bytes; resolves once played, and stops when `signal` aborts. */
    play(clip: { base64: string; mime: string }, options?: { signal?: AbortSignal }): Promise<void>;
  };
  session: {
    /** This session's identifier, which is how the band leaves out its own job. */
    id(): Promise<string>;
    /** What this session has cost, its context window and its rate-limit windows. */
    usage(): Promise<unknown>;
    /** The model this session runs. */
    model(): Promise<string>;
    /** The engine's own version. */
    version(): Promise<{ version: string }>;
    /**
     * Sends one plain-text message to another session, by its full identifier.
     * Delivered means queued at that session, never read: its turn is its own.
     */
    send(args: { to: { sessionId: string }; text: string }): Promise<SendResult>;
  };
  process: {
    /** `env` is set over the host process's own environment, never in place of it. */
    run(argv: string[], init?: { timeoutMs?: number; env?: Record<string, string> }): Promise<ProcessResult>;
  };
  /**
   * The session's environment, read by literal name: which terminal draws the
   * session decides whether its tab can be tinted.
   */
  env: {
    get(name: string): Promise<string | undefined>;
  };
  plugin: {
    /** This plugin's own directory, which is where its readers live. */
    root: string;
  };
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
  };
  /**
   * The values the host holds for the session, kept by plugin and key.
   *
   * Where the store outlives the process, this outlives the registration: it is
   * the host's, so a hot reload of this plugin rebuilds the module and finds it
   * still standing. Writing is refused while a render hook draws, which is why
   * a press writes from the closure the host ran rather than from the paint.
   */
  state: {
    get(ref: StateRef): Promise<StateRead>;
    set(ref: StateRef, value: unknown,
        options?: { ifVersion?: number }): Promise<StateSetResult>;
  };
};

/** What a render hook is handed: the surface it draws on, and the room it has. */
export type RenderEvent = {
  surface: string;
  props: {
    /** The columns the surface gives the pane's body, before the pane's own inset. */
    bodyColumns: number;
  };
};

/** What the band's render hook is handed: the room it has, and whether a survey holds it. */
export type BandEvent = {
  surface: string;
  props: {
    /** The cells the band's tree is laid out in. */
    bodyColumns: number;
    /** True while a survey holds the band; the band yields to it. */
    hasSurvey: boolean;
  };
};

export type StartupEvent = {
  surface: string | null;
  /**
   * Whether a person is at the prompt: false for a `-p` run or the SDK, which
   * have nobody to show a pane, a band or a tab color to.
   */
  isInteractive?: boolean;
};

/** What the hint line under the prompt is handed, and what a hook may add to it. */
export type PromptHintEvent = {
  surface: string;
  props: {
    /** True while the prompt holds typed text. */
    isDraft: boolean;
    /** True while a model turn runs. */
    isWorking: boolean;
    /** The line as the engine draws it. */
    hint: string;
    /** Text drawn dim after the line; absent as the engine hands it. */
    tail?: string;
  };
};

/** A prompt the person submitted: the sign of which session they are typing in. */
export type PromptEvent = {
  text: string;
};

export type CommandEvent = {
  surface: string;
  /** What followed the command's name, as typed; empty when nothing did. */
  args: string;
};


export type Hook = (engine: Engine, event: never) => Promise<unknown> | unknown;

/**
 * The engine's own continuation for a hook.
 *
 * A hook that runs the engine's work itself returns what `next` returns. A hook
 * that returns a value of its own instead is skipped by the engine, which is
 * silent: the pane's command simply never appears.
 */
export type Next = (event: unknown) => Promise<unknown>;

export type On = {
  (event: "session.start",
   handler: (engine: Engine, event: StartupEvent, next: Next) => Promise<unknown> | unknown): void;
  (event: "command.run", match: { command: string },
   handler: (engine: Engine, event: CommandEvent) => Promise<unknown> | unknown): void;
  (event: "ui.render", match: { component: string; requestId: string },
   handler: (engine: Engine, event: RenderEvent) => Promise<unknown> | unknown): void;
  (event: "ui.render", match: { component: "AbovePrompt" },
   handler: (engine: Engine, event: BandEvent, next: Next) => Promise<unknown> | unknown): void;
  (event: "ui.render", match: { component: "PromptHint" },
   handler: (engine: Engine, event: PromptHintEvent, next: Next) => Promise<unknown> | unknown): void;
  (event: "prompt.submit",
   handler: (engine: Engine, event: PromptEvent, next: Next) => Promise<unknown> | unknown): void;
  (event: "session.end",
   handler: (engine: Engine, event: unknown, next: Next) => Promise<unknown> | unknown): void;
};

export type Register = (on: On, options?: { notify?: boolean }) => void;
