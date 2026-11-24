/**
 * The pane as a surface: reader documents in, a host tree out.
 *
 * This is the half of the engine entry that can be tested without the engine. The
 * entry is a handful of lines of glue because everything it draws is decided
 * here: which tree a set of documents becomes, what the surface shows while the
 * first read is still running, and what it shows when that read was refused.
 *
 * Two rules it holds. A read that has not answered yet is not an empty fleet:
 * saying "nothing is running" while a read is in flight is the claim this surface
 * must not make, so it says it is reading. A refused configuration is not a fleet
 * either, and it names every error the loader found rather than the first one.
 */

import type { Primitives } from "./host.ts";
import { renderPane, type Group, type Pane } from "./layout.ts";
import { mount } from "./mount.ts";
import { recolor, THEME } from "./palette.ts";
import { CLOSE, DEFAULT_KEYS, paneFrom, type PaneOptions } from "./pane.ts";
import { paneOptions } from "./options.ts";
import { snapshotFrom, type ReaderDocuments } from "./snapshot.ts";
import { FOOTER_TEXT } from "./version.ts";

export type SurfaceInput = {
  /** What the read command printed, or nothing when it has not answered yet. */
  documents: ReaderDocuments | null;
  /** The columns the surface has for the pane. */
  width: number;
  /** The clock the ages are read against. */
  now: number;
  /**
   * When this reading was taken, when that is not now.
   *
   * A pane can open on a reading the last session left, and the age beside the
   * counts is that reading's. Falling back to the clock above would date it to
   * the paint, which is a fleet labeled current that is hours old.
   */
  takenAt?: number;
  /** Why there is no reading, when the read itself failed. */
  reason?: string;
  /** What a press on one of the pane's controls does, when the caller answers. */
  onPress?: (element: string) => void;
  /**
   * The surface drawing the pane. A picture surface draws its sections as
   * cards; the terminal, and a caller that names none, draws them as the runs
   * of lines a terminal reads best.
   */
  surface?: string;
  options?: PaneOptions;
  /** What the caller changes on the pane before it is drawn, such as what is moving. */
  transform?: (pane: Pane) => Pane;
};

/** A pane holding one group and one sentence, which is all a reader needs here. */
function notice(state: Group["state"], text: string, input: SurfaceInput,
                primitives: Primitives, messageLines?: string[]) {
  const group: Group = {
    name: "the fleet",
    title: "llm-fleet",
    summary: [],
    rows: [],
    state,
    emptyText: text,
    failure: text,
    ...(messageLines === undefined ? {} : { messageLines }),
  };
  // The close control is drawn while the machine is read too: a pane that can
  // only be closed once a reading lands is a pane the person waits on.
  const close = input.options?.keys.close ?? DEFAULT_KEYS.close;
  const pane: Pane = {
    title: "llm-fleet",
    counts: [],
    updated: { text: "" },
    controls: [{ key: CLOSE, label: "Close", hotkey: close, dim: true,
                 onPress: () => input.onPress?.(CLOSE) }],
    hint: "Esc or " + close + " closes this pane",
    footer: { text: FOOTER_TEXT, dim: true },
    groups: [group],
    width: input.width,
    narrowAt: 60,
  };
  return mount(recolor(renderPane(pane, input.surface), input.options?.theme ?? THEME), primitives);
}

/** Whether the documents are the loader's refusal, rather than a reading. */
export function isRefusal(documents: ReaderDocuments | null): boolean {
  return documents !== null && typeof documents === "object" && !Array.isArray(documents)
    && "configErrors" in documents;
}

/**
 * The documents a reading is made of: the sources the reader answers with.
 *
 * A value carrying none of them is not a reading, whatever else it holds. The
 * reader always prints every one, so an object naming no source came from
 * somewhere else, and drawing it as a fleet would report zero of everything the
 * machine never said.
 */
const READER_DOCUMENTS = ["roster", "session", "pacer", "prs", "skills", "worktrees",
                          "load", "custom", "events"] as const;

/**
 * Whether the documents are a reading, rather than a refusal or nothing yet.
 *
 * At least one source has to be there and be something: a key present with
 * nothing under it names no source either, and the assembly reads a missing
 * document as a source that had nothing to report. Four keys set to null would
 * otherwise draw a quiet machine that no reader ever described.
 */
export function isReading(documents: ReaderDocuments | null): boolean {
  return documents !== null && typeof documents === "object" && !Array.isArray(documents)
    && !("configErrors" in documents)
    && READER_DOCUMENTS.some((name) => {
      const source = (documents as Record<string, unknown>)[name];
      return typeof source === "object" && source !== null;
    });
}

/**
 * Every error the loader named, as one sentence.
 *
 * The list is read as untrusted like the documents holding it: a refusal whose
 * errors are not a list, or whose entries are not objects, is named as a refusal
 * this pane could not read. Reading a field off whatever happens to be there
 * throws inside a paint, and a throw there is a blank pane.
 *
 * Each code carries the sentence the schema pairs with it. A code alone says
 * nothing a person can act on, and E_CONFIG_MALFORMED stands for two causes the
 * pane could not otherwise tell apart: bytes that are not UTF-8 and a document
 * that is not JSON. Found by review, 2026-11-23.
 */
const REFUSAL_MEANINGS: Record<string, string> = {
  E_CONFIG_VERSION: "schemaVersion is not a supported version",
  E_CONFIG_FILE_NOT_FOUND: "the selected config file does not exist",
  E_CONFIG_FILE_NOT_REGULAR: "the selected config path is not a regular file",
  E_CONFIG_UNREADABLE: "the selected config file could not be read",
  E_CONFIG_MALFORMED: "the file is not valid JSON, or its bytes are not UTF-8",
  E_CONFIG_ROOT_TYPE: "the document root is not an object",
  E_CONFIG_UNKNOWN_KEY: "a key is not declared by this schema",
  E_CONFIG_TYPE: "a value has the wrong JSON type",
  E_CONFIG_VALUE: "a value is outside the declared bounds or form",
  E_CONFIG_REQUIRED: "an enabled group or provider is missing a required field",
  E_CONFIG_UNRESOLVED_VAR: "a path references an undeclared or unset variable",
  E_CONFIG_RULE: "two fields contradict each other",
};

/** Which cause a malformed file was, when the loader could tell. */
const MALFORMED_DETAILS: Record<string, string> = {
  bytes: "the file's bytes are not UTF-8",
  json: "the file is not valid JSON",
};

function refusalTexts(documents: ReaderDocuments): string[] {
  const errors = (documents as { configErrors?: unknown }).configErrors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  return errors.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return "an error this pane could not read";
    }
    const { code, path, detail } = entry as { code?: unknown; path?: unknown; detail?: unknown };
    // The loader knows which cause it hit; the code alone names both. Naming
    // the wrong repair for a file whose bytes are fine is worse than silence.
    const malformed = typeof detail === "string"
      ? MALFORMED_DETAILS[detail] : undefined;
    const meaning = malformed ?? (typeof code === "string" ? REFUSAL_MEANINGS[code] : undefined);
    return (typeof code === "string" ? code : "an unnamed error")
         + (typeof path === "string" ? " " + path : "")
         + (meaning === undefined ? "" : ": " + meaning);
  });
}

function refusals(documents: ReaderDocuments): string {
  const texts = refusalTexts(documents);
  return texts.length === 0 ? "no error this pane could read" : texts.join(", ");
}

export function surfaceTree(input: SurfaceInput, primitives: Primitives) {
  if (input.documents === null) {
    // A read still running and a read that failed are different states with
    // different sentences, and neither is an empty fleet.
    const pending = input.reason === undefined;
    return notice(pending ? "empty" : "failed",
                  pending ? "Reading the machine..."
                          : "the fleet (the read did not answer: " + input.reason + ")",
                  input, primitives);
  }
  if (isRefusal(input.documents)) {
    // Each refusal gets its own line: joined into one sentence it was cut at
    // the pane's width, and the meaning at the end is the part a person needs.
    // Found by review, 2026-11-23.
    const texts = refusalTexts(input.documents);
    return notice("unavailable", "the configuration, which was refused: "
                                + refusals(input.documents), input, primitives,
                  texts.length === 0 ? ["the configuration was refused: no error this pane could read"]
                    : ["the configuration was refused:", ...texts]);
  }
  if (!isReading(input.documents)) {
    // Neither of the two shapes a read can answer with. That is a broken read,
    // and calling it a refused configuration, or an empty fleet, would both be
    // claims the machine did not make.
    return notice("failed", "the fleet (the read did not print a reading)", input, primitives);
  }
  const snapshot = snapshotFrom(input.documents, input.takenAt ?? input.now);
  const base = input.options ?? paneOptions(input.width, input.now);
  // The caller's press handler is merged rather than expected in the options, so
  // a caller that passes its own options still gets working controls.
  const options = input.onPress ? { ...base, onPress: input.onPress } : base;
  const pane = paneFrom(snapshot, options);
  return mount(recolor(renderPane(input.transform ? input.transform(pane) : pane, input.surface),
                       options.theme ?? THEME),
               primitives);
}
