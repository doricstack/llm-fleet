/**
 * The Python scripts this plugin has, and the one way it starts them.
 *
 * Every script is named here and nowhere else, and every command that starts
 * one is built by `entryArgv`: the boundary check refuses a script name or a
 * Python interpreter in any other module the host loads, and the standalone
 * proof runs each entry below from a lone copy of the plugin folder, so a
 * script an install would not carry cannot be started without a test noticing.
 *
 * The pane starts the read command, the alerts helper and the tab helper. The
 * statusline entries are started by the statusline command line, not by the
 * pane; they are here because they are the plugin's to carry all the same.
 *
 * The table keeps one entry per line in this exact shape, because the
 * standalone proof reads it as written.
 */

/** The interpreter every entry runs under. */
export const PYTHON = "python3";

export const ENTRIES = {
  snapshot: "readers/snapshot.py",
  alerts: "readers/alerts.py",
  tab: "readers/tab.py",
  host: "readers/host.py",
  session: "readers/session.py",
  transcript: "readers/transcript.py",
  doctor: "readers/doctor.py",
  setup: "readers/setup.py",
  governance: "readers/governance.py",
} as const;

/** A key of the table, which is the only thing a caller names. */
export type Entry = keyof typeof ENTRIES;

/**
 * How an entry is started, as the person's plugin options set it.
 *
 * `python` is the interpreter, a name on the PATH or a full path; `configPath`
 * is the configuration file every entry reads, empty for the default place.
 */
export type Launch = { python: string; configPath: string };

/** The packaged launch: the interpreter on the PATH, and the default configuration. */
export const LAUNCH: Launch = { python: PYTHON, configPath: "" };

/** One option as a trimmed, non-empty string, or nothing. */
function optionText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * The launch the plugin's options declare, field by field.
 *
 * The host validates each option against the manifest before the module loads,
 * so a value of the wrong kind arrives only from a host that did not; it, and an
 * empty one, leave the packaged choice for that field.
 */
export function launchFrom(options: Readonly<Record<string, unknown>> | undefined): Launch {
  return {
    python: optionText(options?.python) ?? LAUNCH.python,
    configPath: optionText(options?.configPath) ?? LAUNCH.configPath,
  };
}

/** The command that starts an entry from the plugin root, with its arguments after it. */
export function entryArgv(root: string, entry: Entry, args: readonly string[] = [],
                          launch: Launch = LAUNCH): string[] {
  return [launch.python, `${root}/${ENTRIES[entry]}`, ...args];
}

/**
 * The variables an entry is started with: the configuration file the person
 * named, through the selector the loader reads, or none at all. The loader
 * refuses a relative path there by name, so a mistyped option is drawn as a
 * refused configuration rather than read from wherever the session started.
 */
export function entryEnv(launch: Launch): Record<string, string> | undefined {
  return launch.configPath ? { FLEET_CONFIG: launch.configPath } : undefined;
}
