/**
 * The four tones a state is drawn in, and what a person's theme draws each as.
 *
 * The pane decides every color in the four default tokens, and the decisions
 * read those tokens back: a card's rule is the loudest tone inside it, and a
 * count is drawn on a chip only in a state's tone. So the theme is not threaded
 * into those decisions. It is one substitution over the finished tree, the last
 * step before the surface draws it, which is what lets every place that colors a
 * failure follow `theme.failure` without any of them knowing the setting exists.
 *
 * The substitution reaches a desktop drawing too. A vector carries its colors in
 * its own markup, since no theme key reaches it, so its style is written again
 * for the tokens the theme asks for.
 */

import type { Color, Node, Tree } from "./host.ts";
import { restyle } from "./vector.ts";

/** A tone, named by what it means rather than how it looks. */
export type Tone = "failure" | "waiting" | "working" | "idle";

/** The token the pane draws each tone in before any theme is applied. */
export const TONE_TOKEN: Record<Tone, Color> = {
  failure: "error",
  waiting: "warning",
  working: "success",
  idle: "subtle",
};

/** The worktree states, each drawn in one tone. */
export type WorktreeState = "active" | "held" | "unknown" | "merged" | "preserved";

/** What a person's theme decides. */
export type Theme = {
  /** The token each tone is drawn as. */
  tones: Record<Tone, Color>;
  /** The tone each worktree state is drawn in. */
  worktrees: Record<WorktreeState, Tone>;
};

/**
 * The packaged theme: every tone drawn in its own token.
 *
 * Here for a reading written before the theme travelled, as the packaged keys
 * and measurements are: a pane that received none draws what the schema ships.
 */
export const THEME: Theme = {
  tones: { ...TONE_TOKEN },
  worktrees: { active: "working", held: "waiting", unknown: "waiting",
               merged: "idle", preserved: "idle" },
};

/** The tokens a tone may be drawn as: the ones that read as a text color. */
const TOKENS = new Set<Color>(["text", "subtle", "inactive", "success", "error", "warning",
                               "merged", "claude", "suggestion", "planMode"]);

const TONES: Tone[] = ["failure", "waiting", "working", "idle"];
const STATES: WorktreeState[] = ["active", "held", "unknown", "merged", "preserved"];

/**
 * The theme a reading carries, entry by entry.
 *
 * The loader refused a document naming a token outside the list, so anything
 * else here came from a reading this build did not write; that entry keeps the
 * packaged choice and the rest of the theme still stands.
 */
export function themeFrom(value: unknown): Theme {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return THEME;
  }
  const body = value as Record<string, unknown>;
  const tones = { ...THEME.tones };
  for (const tone of TONES) {
    const token = body[tone];
    if (typeof token === "string" && TOKENS.has(token as Color)) {
      tones[tone] = token as Color;
    }
  }
  const worktrees = { ...THEME.worktrees };
  const declared = body.worktrees;
  if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
    for (const state of STATES) {
      const tone = (declared as Record<string, unknown>)[state];
      if (typeof tone === "string" && (TONES as string[]).includes(tone)) {
        worktrees[state] = tone as Tone;
      }
    }
  }
  return { tones, worktrees };
}

/** The token a worktree state is drawn in before the substitution. */
export function worktreeToken(theme: Theme, state: WorktreeState): Color {
  return TONE_TOKEN[theme.worktrees[state]];
}

/** The substitution a theme makes, as a token-to-token table. */
function swapOf(theme: Theme): Map<Color, Color> {
  const swap = new Map<Color, Color>();
  for (const tone of TONES) {
    if (theme.tones[tone] !== TONE_TOKEN[tone]) {
      swap.set(TONE_TOKEN[tone], theme.tones[tone]);
    }
  }
  return swap;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string"
    && Array.isArray((value as { children?: unknown }).children);
}

/**
 * One props object with every color it holds swapped.
 *
 * A color is a prop named `color` or ending in `Color`; a nested plain object,
 * the hover props, is walked the same way. A function, the press a control
 * carries, is kept as it is, and so is every other value.
 */
function swapProps(props: Record<string, unknown>, swap: Map<Color, Color>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if ((key === "color" || key.endsWith("Color")) && typeof value === "string") {
      out[key] = swap.get(value as Color) ?? value;
    } else if (key === "children" && Array.isArray(value)) {
      out[key] = value.map((child) => (isNode(child) ? swapNode(child, swap) : child));
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)
               && Object.getPrototypeOf(value) === Object.prototype) {
      out[key] = swapProps(value as Record<string, unknown>, swap);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function swapNode(node: Node, swap: Map<Color, Color>): Node {
  return {
    ...node,
    props: swapProps(node.props as Record<string, unknown>, swap) as Node["props"],
    children: node.children.map((child) => (typeof child === "string" ? child : swapNode(child, swap))),
    ...(node.vector
      ? { vector: { ...node.vector, source: restyle(node.vector.source, (token) => swap.get(token) ?? token) } }
      : {}),
  };
}

/**
 * The tree drawn in a person's theme.
 *
 * The packaged theme changes nothing, so the tree is handed back as it is
 * rather than copied on every paint.
 */
export function recolor(tree: Tree, theme: Theme): Tree {
  const swap = swapOf(theme);
  return swap.size === 0 ? tree : swapNode(tree, swap);
}
