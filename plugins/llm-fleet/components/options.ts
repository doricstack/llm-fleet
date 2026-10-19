/**
 * The pane options this plugin draws with.
 *
 * These are the choices the host's render hook does not make for us: which
 * sections exist, the order a reader meets them in, and the width below which
 * the pane stops holding two columns. They live in their own module because two
 * surfaces use them: the plugin's render hook, and the review tool that prints
 * the same pane outside a terminal.
 *
 * The pane has no configuration file of its own to read, so a person's choices
 * reach it one way: the read command resolves them and prints them with the
 * reading, and `paneConfigFrom` reads that document. What is here is the
 * packaged default, which is what a pane draws when the reading carries no
 * usable configuration of its own.
 */

import { CUSTOM_PREFIX, DEFAULT_KEYS, type PaneGeometry, type PaneKeys, type PaneOptions,
         type SectionChoice } from "./pane.ts";
import { THEME, themeFrom, type Theme } from "./palette.ts";

/** The sections the pane carries, in the order a reader meets them. */
export const SECTIONS = [
  "load", "prs", "sessions", "trials", "running", "session", "worktrees", "skills", "warnings",
  "governance", "keys",
];

/**
 * The sections a pane starts folded when nothing else says otherwise.
 *
 * The schema declares these, and the read command resolves them, so this is the
 * answer only for a reading that carries no configuration document: an older
 * reading from before the document existed, or one whose section table could
 * not be read. The values are the schema's own defaults at the revision this
 * was written, which is why they are here rather than nowhere.
 */
const FOLDED_AT_START = new Set(["worktrees", "skills", "keys"]);
/** The sections left out while they have nothing to show, under the same terms. */
const HIDDEN_WHEN_EMPTY = new Set(["warnings", "load"]);

export const NARROW_AT = 60;

/**
 * The sections a person added, as the custom document declares them: each one's
 * settings travel with its reading, because the pane document holds only the
 * sections this build ships.
 */
function customChoices(documents: Record<string, unknown>): Record<string, SectionChoice> {
  const custom = documents.custom;
  if (typeof custom !== "object" || custom === null || Array.isArray(custom)) {
    return {};
  }
  const sections = (custom as { sections?: unknown }).sections;
  if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
    return {};
  }
  const choices: Record<string, SectionChoice> = {};
  for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
    const choice = choiceFrom(value);
    if (choice !== null) {
      choices[CUSTOM_PREFIX + key] = choice;
    }
  }
  return choices;
}

/** The pane's own configuration as the reading carries it. */
export type PaneConfig = {
  order: string[];
  sections: Record<string, SectionChoice>;
  keys: PaneKeys;
  geometry: PaneGeometry;
  theme: Theme;
};

/**
 * The packed defaults for the settings the schema declares with these defaults.
 *
 * They are here for a reading written before the settings travelled, which is
 * the same reason the packaged keys are: a pane that received none of them draws
 * what the schema ships rather than nothing.
 */
export const GEOMETRY: PaneGeometry = {
  minimumColumns: 20,
  horizontalReserve: 0,
  progressCells: 16,
  skillRows: 5,
  fanLines: 4,
};

/** One positive integer the configuration declares, or the packaged default. */
function geometryFrom(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return fallback;
  }
  return value < minimum ? fallback : value;
}

function geometryOf(value: unknown): PaneGeometry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return GEOMETRY;
  }
  const body = value as Record<string, unknown>;
  return {
    minimumColumns: geometryFrom(body.minimumColumns, GEOMETRY.minimumColumns, 1),
    horizontalReserve: geometryFrom(body.horizontalReserve, GEOMETRY.horizontalReserve, 0),
    progressCells: geometryFrom(body.progressCells, GEOMETRY.progressCells, 1),
    skillRows: geometryFrom(body.skillRows, GEOMETRY.skillRows, 1),
    fanLines: geometryFrom(body.fanLines, GEOMETRY.fanLines, 0),
  };
}

/**
 * One key binding, or the packaged default when the document does not name one.
 *
 * A binding the host can fire is one character, and the pane draws a hotkey on a
 * control: a longer string is listed in the keys section as a shortcut nothing
 * will ever match, which is worse than no list. A digit is refused as well,
 * because the digits are the pane's own and already fold one section each: two
 * controls bound to one key is one of them silently not working.
 */
function keyFrom(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length !== 1 || /\d/.test(value)) {
    return fallback;
  }
  return value;
}

/**
 * The keys a reading carries, or the packaged defaults.
 *
 * A key is one character the host will match, so anything else is not one this
 * pane can honour and the default stands. The tips are the exception: an empty
 * list is a person who turned the tips off, and drawing the packaged five over
 * that would be the pane overruling a choice it was handed.
 */
function keysFrom(value: unknown): PaneKeys {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_KEYS;
  }
  const body = value as Record<string, unknown>;
  return {
    tipsEnabled: body.tipsEnabled !== false,
    // A list the document did not carry at all is not a person who turned the
    // tips off: that is a reading from before the tips travelled, and the
    // packaged five stand. An empty list is the different answer, and it is
    // honoured, because that is the one somebody wrote.
    tips: Array.isArray(body.tips)
      ? body.tips.filter((tip) => typeof tip === "string")
      : DEFAULT_KEYS.tips,
    close: keyFrom(body.close, DEFAULT_KEYS.close),
    collapse: keyFrom(body.collapse, DEFAULT_KEYS.collapse),
    expand: keyFrom(body.expand, DEFAULT_KEYS.expand),
  };
}

/** One section's configured choice, when the document holds a usable one. */
function choiceFrom(value: unknown): SectionChoice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const body = value as { title?: unknown; visible?: unknown; collapsed?: unknown;
                          legend?: unknown; hideWhenEmpty?: unknown; maxRows?: unknown };
  // Both fields must be booleans. A document that says `"collapsed": "yes"` is
  // not a document this pane understands, and half-reading it would draw a
  // section folded on the strength of a string.
  if (typeof body.visible !== "boolean" || typeof body.collapsed !== "boolean") {
    return null;
  }
  // A legend is prose the pane draws, so a document that carries none, or
  // carries something that is not a string, draws no legend rather than the
  // word "[object Object]" under a heading.
  const legend = typeof body.legend === "string" && body.legend.length > 0 ? body.legend : null;
  // A section's title is the word on its heading, so a document that carries
  // something that is not a word leaves the heading as this build names it,
  // rather than printing whatever the document held there.
  const title = typeof body.title === "string" && body.title.length > 0 ? body.title : null;
  // Optional, so a reading from before the field existed keeps every section.
  const hideWhenEmpty = body.hideWhenEmpty === true;
  // A ceiling is a whole number of rows of at least one, or no ceiling at all.
  const maxRows = typeof body.maxRows === "number" && Number.isInteger(body.maxRows)
    && body.maxRows >= 1 ? body.maxRows : undefined;
  return { title, visible: body.visible, collapsed: body.collapsed, legend, hideWhenEmpty,
           ...(maxRows !== undefined ? { maxRows } : {}) };
}

/**
 * The pane configuration a reading carries, or null when it carries none.
 *
 * The reading is untrusted input like any other: it crosses a process boundary
 * and may have been written by an older version of this plugin. So the document
 * is understood whole or refused whole, and the refusals are the ones that would
 * otherwise draw a pane nobody asked for:
 *
 * - a state other than ready is a reading that did not resolve a configuration,
 *   so nothing in it is applied;
 * - a section the order names whose choice is missing or is not two booleans is
 *   refused rather than skipped, because skipping it drops a section from the
 *   pane, and a section dropped for being unreadable looks exactly like one a
 *   person chose to hide;
 * - an order is honoured as written, including an empty one, which is a person
 *   asking for no sections at all. An absent document is the different thing,
 *   and that is what falls back to the packaged default.
 *
 * A name the order carries that this build cannot draw is dropped, which is the
 * one narrowing here: a section this build has no way to build is not one it can
 * show, and refusing the whole document over a name from a newer build would
 * lose every choice the person did make. A non-empty order whose every name is
 * one this build cannot draw is the different case: nothing in it can be
 * honoured, so the document is refused and the packaged default stands rather
 * than an order that draws no sections at all.
 */
export function paneConfigFrom(documents: unknown): PaneConfig | null {
  if (typeof documents !== "object" || documents === null || Array.isArray(documents)) {
    return null;
  }
  const candidate = (documents as { pane?: unknown }).pane;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const body = candidate as { state?: unknown; order?: unknown; sections?: unknown;
                               keys?: unknown; geometry?: unknown; theme?: unknown };
  if (body.state !== "ready" || !Array.isArray(body.order)
      || typeof body.sections !== "object" || body.sections === null
      || Array.isArray(body.sections)) {
    return null;
  }
  const table = body.sections as Record<string, unknown>;
  const custom = customChoices(documents as Record<string, unknown>);
  const order: string[] = [];
  const sections: Record<string, SectionChoice> = {};
  for (const name of body.order) {
    if (typeof name !== "string" || order.includes(name)) {
      continue;
    }
    if (name.startsWith(CUSTOM_PREFIX)) {
      // The loader refused an order naming a section nobody declared, so a name
      // here whose reading is missing is one whose command could not be read:
      // it keeps its place and draws as not read, under its own key.
      order.push(name);
      sections[name] = custom[name] ?? { title: name.slice(CUSTOM_PREFIX.length), visible: true,
                                         collapsed: false, legend: null, hideWhenEmpty: false };
      continue;
    }
    if (!SECTIONS.includes(name)) {
      continue;
    }
    const choice = choiceFrom(table[name]);
    if (choice === null) {
      return null;
    }
    order.push(name);
    sections[name] = choice;
  }
  if (body.order.length && !order.length) {
    return null;
  }
  // A section a person declared and did not place is drawn after the ones the
  // order names, so declaring one is enough to see it.
  for (const [name, choice] of Object.entries(custom)) {
    if (!order.includes(name)) {
      order.push(name);
      sections[name] = choice;
    }
  }
  return { order, sections, keys: keysFrom(body.keys), geometry: geometryOf(body.geometry),
           theme: themeFrom(body.theme) };
}

/**
 * The options a pane draws with, on the configuration its reading carried.
 *
 * An absent configuration decides nothing, so the packaged default stands for
 * all eight sections. A configuration that is there decides everything: the
 * order, which sections are drawn, and where each one starts.
 */
export function paneOptions(width: number, now: number,
                            resolved: PaneConfig | null = null): PaneOptions {
  if (resolved === null) {
    return {
      width,
      narrowAt: NARROW_AT,
      now,
      sectionOrder: SECTIONS,
      sections: Object.fromEntries(SECTIONS.map((name) => [
        name, { title: null, visible: true, collapsed: FOLDED_AT_START.has(name),
                hideWhenEmpty: HIDDEN_WHEN_EMPTY.has(name) }])),
      keys: DEFAULT_KEYS,
      geometry: GEOMETRY,
      theme: THEME,
    };
  }
  return {
    width,
    narrowAt: NARROW_AT,
    now,
    sectionOrder: resolved.order,
    sections: { ...resolved.sections },
    keys: resolved.keys,
    geometry: resolved.geometry,
    theme: resolved.theme,
  };
}
