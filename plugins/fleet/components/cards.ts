/**
 * The pieces a tile is built from: a stat card, a status dot, a rate bar.
 *
 * These are drawn with the surface's own elements rather than assembled out of
 * characters. A card is a bordered box and a bar is a run of filled cells in a
 * theme color. A bar and a strip also carry a vector drawing of themselves, built
 * from the same counts, which the mount draws instead of the cells on a surface
 * that draws vectors; neither this file nor the layout it serves has to know
 * which surface is drawing it.
 *
 * The border characters are written as code points because this repository's
 * source is plain ASCII: a literal box-drawing character in a source file is
 * what the format rule refuses, and naming it is what the rule asks for instead.
 */

import type { Color, Node } from "./host.ts";
// Type-only, so the cycle with layout.ts is erased rather than evaluated: the
// layout draws with the pieces here, so the pieces cannot draw with it.
import type { History, PaneCard, Slot } from "./layout.ts";
import { box, fit, text } from "./layout.ts";
import { barVector, stripVector } from "./vector.ts";

/**
 * The mark a bar is drawn with, filled and track alike: a heavy line on the
 * middle of the cell. A full block read as a slab beside the text and a light
 * line as a rule; the half block sat on the cell's floor, so a bar touched the
 * row under it and read as that row's underline. The filled part is told from
 * the track by its color, and the track is the same mark drawn dim.
 */
export const BAR_FILLED = "\u2501";
export const BAR_TRACK = "\u2501";

/**
 * The mark a heading or a state is drawn behind: a thin bar of its color at the
 * left of the word, where a chip put the whole word on a block of it. A section
 * of chips was a column of yellow and green slabs louder than the counts beside
 * them.
 */
export const ACCENT = "\u258e";

/** The dot that says what an item is doing, without a word for it. */
export const DOT_FILLED = "●";

/** The mark a folded section's heading carries. */
export const FOLDED = "▸";
/** The mark an open section's heading carries. */
export const OPENED = "▾";

/**
 * What a state is drawn as: one color per meaning, never a literal.
 *
 * A state the pane does not recognize draws as the quiet token rather than as a
 * success: an unread state is not good news, and a dot that went green for a
 * word nobody knows would be the pane inventing a verdict.
 */
export function stateColor(state: string): Color {
  switch (state) {
    case "working":
    case "running":
    case "ready":
    case "active":
    case "passed":
    case "green":
      return "success";
    case "waiting":
    case "blocked":
    case "stale":
    case "pending":
    case "draft":
    case "expired":
    case "held":
    case "unknown":
      return "warning";
    case "failed":
    case "error":
      return "error";
    case "merged":
    case "preserved":
      return "merged";
    default:
      return "subtle";
  }
}

/** The dot for a state, drawn in that state's own color. */
export function statusDot(state: string): Node {
  return text({ color: stateColor(state) }, DOT_FILLED);
}

/**
 * A word on a fill of its own color: the mark a live state and a headline
 * figure are drawn with, as the host draws a working session's name.
 *
 * The fill repeats a word that is already there, so nothing is carried by the
 * color alone; the text on it is the theme's own inverse, which the theme keeps
 * legible on every fill it defines.
 */
export function chip(value: string, color: Color): Node {
  // The cell of fill at each side is its own text, so the word is the word: a
  // reader of the tree, or a search of what the pane says, finds "Waiting" and
  // not the padding it is drawn with.
  const fill = { backgroundColor: color, color: "inverseText" as const };
  return box({ flexDirection: "row", gap: 0, flexShrink: 0 }, [
    text(fill, " "), text({ ...fill, bold: true }, value), text(fill, " "),
  ]);
}

/**
 * A word in its color behind the accent, on no fill: the mark a heading and a
 * state are drawn with. It takes the width a chip took, so nothing beside it
 * moves; the chip is kept for the short figures, where a block is one cell or two.
 */
export function tag(value: string, color: Color): Node {
  return box({ flexDirection: "row", gap: 0, flexShrink: 0 }, tagTexts(value, color));
}

/** A tag's texts alone, for a control or a link, which may hold texts and no box. */
export function tagTexts(value: string, color: Color): Node[] {
  return [text({ color }, ACCENT), text({}, " "), text({ color, bold: true }, value)];
}

/**
 * The states drawn as a chip on a row's title: work that is live, or waiting on
 * a person, or broken. A finished or merged item keeps a plain title, because a
 * list of finished things each on a fill is a list where nothing stands out.
 */
// Only the states that need a person, or that failed: a fill on every live item
// is a section of green bars where the one that needs you does not stand out.
const CHIP_STATES = new Set(["waiting", "blocked",
                             "failed", "error"]);

/** The fill a row's title is drawn on, or none for a state that earns no chip. */
export function titleChip(state: string): Color | null {
  return CHIP_STATES.has(state) ? stateColor(state) : null;
}

/** One figure: its value on a chip in its own color, and the word for it. */
function statCell(card: PaneCard, each: number): Node {
  const cell = box({ flexDirection: "row", gap: 1 }, [
    chip(fit(card.value, 6), card.color ?? "subtle"),
    text({ dimColor: true }, fit(card.label, Math.max(4, each - card.value.length - 3))),
  ]);
  // A figure that is a way into what it counts is drawn as the control it is:
  // the whole cell is the press, so a person presses the number they read.
  return card.press
    ? { type: "Button", props: { key: card.press.key, label: card.press.label,
                                 onPress: card.press.onPress, hover: { color: "claude" } },
        children: [cell] }
    : cell;
}

/** The least a label keeps when the figures share one line. */
const STATS_LABEL_FLOOR = 8;

/**
 * The width each figure takes on one line, or null when they must stack.
 *
 * A figure's label is the word that makes its number mean something, so the
 * cards are sized to their own labels rather than to an equal share. A share
 * chosen for the longest label leaves the short ones' room unread; a share
 * chosen for the shortest cuts the long one, and "Failed trials..." is the
 * label the pane exists to state.
 *
 * The spare width goes to the card furthest from whole, one cell at a time, so
 * every label is cut by about the same amount rather than the longest by all of
 * it.
 */
function shareWidths(cards: { label: string; value: string }[], width: number): number[] | null {
  const gaps = 3 * Math.max(0, cards.length - 1);
  const needed = cards.map((card) => card.value.length + 2 + 1 + card.label.length);
  const least = cards.map((card) => card.value.length + 2 + 1 + STATS_LABEL_FLOOR);
  const floor = least.reduce((sum, cells) => sum + cells, 0) + gaps;
  if (cards.length === 0 || width < floor) {
    return null;
  }
  const sizes = [...least];
  let spare = width - floor;
  while (spare > 0) {
    let pick = -1;
    for (const [index, size] of sizes.entries()) {
      if (size >= needed[index]) {
        continue;
      }
      if (pick < 0 || needed[index] - size > needed[pick] - sizes[pick]) {
        pick = index;
      }
    }
    if (pick < 0) {
      break;
    }
    sizes[pick] += 1;
    spare -= 1;
  }
  return sizes;
}

/**
 * The head of a pane: every headline figure on one line, each on its chip.
 *
 * They are drawn as one line rather than as a card each, and with no rule round
 * them: three cards holding a single digit divide the pane into three empty
 * boxes, and a rule round one line spends two rows the sections below need. The
 * chip is what makes a figure read first; the label beside it names what it
 * counts, written rather than cut, because "Failed trials and runs" is the label
 * and "Failed tri..." is the thing this replaced.
 *
 * Too narrow for three side by side, the figures stack rather than shrinking to
 * initials: a pane a third of the width it wants still has figures worth reading.
 */
export function statStrip(cards: PaneCard[], width: number, measured = false): Node {
  // A caller that measured the figures against its own line already knows they
  // fit there whole, so each label keeps its full length rather than a share.
  if (measured) {
    return box({ flexDirection: "row", gap: 3 },
               cards.map((card) => statCell(card, card.label.length + 10)));
  }
  const sizes = shareWidths(cards, width);
  if (sizes === null) {
    return box({ flexDirection: "column", gap: 0 },
               cards.map((card) => statCell(card, width)));
  }
  return box({ flexDirection: "row", gap: 3 },
             cards.map((card, index) => statCell(card, sizes[index])));
}

/**
 * A stretch of the recent past, one cell per bucket, oldest first.
 *
 * The cells are the bar's own alphabet: a bucket that held nothing failed is
 * filled, one that held a failure is filled in the error color, and one nobody
 * tried anything in is left as track. That last one is why this is not a bar: an
 * empty bucket drawn as filled would say the hour went well, and the pane has no
 * basis for that. The caption states what the buckets add up to, because twelve
 * cells cannot say how many trials they are.
 */
export function historyStrip(history: History, width: number): Node | null {
  if (!history.cells.length || history.outcomes <= 0) {
    return null;
  }
  const room = Math.max(1, width);
  // One cell per bucket, oldest first. Too narrow for all of them, the oldest
  // are dropped and the caption says which stretch is left: a strip of eight
  // cells under the words "Last 12 hours" is a label claiming hours it is not
  // showing, and the cells a reader counts would not be the ones they think.
  const shown = history.cells.slice(-room);
  const dropped = history.cells.length - shown.length;
  const drawn = box({ flexDirection: "row", gap: 0 },
                    shown.map((cell) => text(
                      cell.outcomes === 0 ? { dimColor: true }
                        : { color: cell.failed > 0 ? "error" : "success" },
                      cell.outcomes === 0 ? BAR_TRACK : BAR_FILLED)));
  const caption: Slot[] = [
    { text: dropped > 0 ? "Last " + shown.length + " hours" : history.label, dim: true },
    { text: " " + history.outcomes + (history.outcomes === 1 ? " outcome" : " outcomes") },
  ];
  if (history.failed > 0) {
    caption.push({ text: "  " + history.failed + " failed", color: "error" });
  }
  // The vector says in its alt what the caption says, since a reader of the
  // drawing alone has no caption.
  const vector = stripVector(shown, caption.map((slot) => slot.text.trim()).join(", "));
  return box({ flexDirection: "column", gap: 0 },
             [vector ? { ...drawn, vector } : drawn, stripLine(caption)]);
}

/** The caption under a strip, laid out as one line of text. */
function stripLine(slots: Slot[]): Node {
  return box({ flexDirection: "row", gap: 0 },
             slots.map((slot, index) => text(
               { ...(slot.color ? { color: slot.color } : {}),
                 ...(slot.dim ? { dimColor: true } : {}) },
               index === 0 || slot.text.startsWith(" ") ? slot.text : " " + slot.text)));
}

/** The small dot a check run is drawn as, one per check, side by side. */
export const CHECK_DOT = "•";

/** A check run's color: passed, failed and pending in their own, anything else quiet. */
export function checkColor(state: string): Color {
  switch (state) {
    case "pass":
      return "success";
    case "fail":
      return "error";
    case "pending":
      return "warning";
    default:
      return "subtle";
  }
}

/** How bad a check is, so a cap keeps the worst: failing, then pending, then the rest. */
function checkSeverity(state: string): number {
  return state === "fail" ? 2 : state === "pending" ? 1 : 0;
}

/**
 * A pull request's checks as a run of dots, one per check in its own color, and
 * the count of those not drawn.
 *
 * Too many for the room, the failing checks are kept first and then the pending
 * ones, in the order they were listed, and what was left out joins the count the
 * reader already left out, so every check is either a dot or a figure. Null when
 * there is nothing to draw or not even the count fits.
 */
export function checkDots(states: string[], more: number,
                          room: number): { node: Node; width: number } | null {
  const counted = (left: number): string => left > 0 ? " +" + left : "";
  let kept = states.length;
  while (kept > 0 && kept + counted(states.length - kept + more).length > room) {
    kept -= 1;
  }
  const tail = counted(states.length - kept + more);
  // The count's leading space parts it from a dot; with no dot it has nothing to part from.
  const width = kept ? kept + tail.length : tail.trimStart().length;
  if (width === 0 || width > room) {
    return null;
  }
  const order = states.map((state, index) => ({ state, index }))
    .sort((left, right) => checkSeverity(right.state) - checkSeverity(left.state)
                           || left.index - right.index)
    .slice(0, kept)
    .sort((left, right) => left.index - right.index);
  const parts = order.map((entry) => text({ color: checkColor(entry.state) }, CHECK_DOT));
  if (tail) {
    parts.push(text({ dimColor: true }, tail.trimStart()));
  }
  // The count is its own text, a cell from the last dot, so it reads as a figure.
  const node = box({ flexDirection: "row", gap: 0 }, tail && kept
    ? [...parts.slice(0, -1), text({}, " "), parts.at(-1) as Node] : parts);
  return { node, width };
}

/** The eight heights a spend bucket is drawn at, lowest first. */
export const SPARK_GLYPHS = ["▁", "▂", "▃", "▄",
                             "▅", "▆", "▇", "█"];

/**
 * A series as one line of block glyphs, each scaled to the busiest cell.
 *
 * Too long for the room, neighboring buckets are summed so the whole window is
 * still drawn, grouped from the newest end so the last cell ends at the reading.
 * A cell that held nothing is the lowest glyph drawn quiet, so it is not read as
 * the least spend; any spend at all is at least the lowest glyph in color. The
 * scale is the busiest cell and nothing else: no budget is drawn against.
 */
export function sparkline(values: number[], room: number, color: Color = "suggestion"): Node | null {
  const cells = Math.floor(room);
  if (!values.length || cells < 1) {
    return null;
  }
  const size = Math.ceil(values.length / cells);
  const sums: number[] = [];
  for (let end = values.length; end > 0; end -= size) {
    sums.unshift(values.slice(Math.max(0, end - size), end).reduce((sum, value) => sum + value, 0));
  }
  const peak = Math.max(...sums);
  return box({ flexDirection: "row", gap: 0 }, sums.map((sum) => {
    if (!(sum > 0) || !(peak > 0)) {
      return text({ dimColor: true }, SPARK_GLYPHS[0] as string);
    }
    const level = Math.min(SPARK_GLYPHS.length, Math.max(1, Math.ceil((sum / peak) * SPARK_GLYPHS.length)));
    return text({ color }, SPARK_GLYPHS[level - 1] as string);
  }));
}

/** The marks a timeline is drawn with: work and waiting heavy, idle light, unknown dashed. */
export const TIMELINE_HEAVY = "━";
export const TIMELINE_LIGHT = "─";
export const TIMELINE_UNKNOWN = "┄";

/** A stretch of a session's time, in seconds, and what it was doing. */
export type Stretch = { start: number; end: number; state: string };

/** What each state is drawn as on a timeline. */
function stretchLook(state: string | null): { glyph: string; props: { color?: Color; dimColor?: boolean } } {
  switch (state) {
    case "working":
      return { glyph: TIMELINE_HEAVY, props: { color: "success" } };
    case "waiting":
      return { glyph: TIMELINE_HEAVY, props: { color: "warning" } };
    case "idle":
      return { glyph: TIMELINE_LIGHT, props: { color: "subtle" } };
    default:
      return { glyph: TIMELINE_UNKNOWN, props: { dimColor: true } };
  }
}

/** Which state wins a cell two stretches share equally: the one that needs a person, then work. */
const STRETCH_RANK: Record<string, number> = { waiting: 3, working: 2, idle: 1 };

/**
 * A session's time from `from` to `to` as one line of cells, each in the state
 * that covered most of it.
 *
 * Time no stretch covers is drawn as unknown rather than as idle: a session
 * nothing was recorded for may have been doing anything. Null when the span is
 * empty or there is no room.
 */
export function timelineStrip(stretches: Stretch[], from: number, to: number, room: number,
                              dim = false): Node | null {
  const cells = Math.floor(room);
  if (cells < 1 || !(to > from) || !stretches.length) {
    return null;
  }
  const step = (to - from) / cells;
  const parts: Node[] = [];
  for (let cell = 0; cell < cells; cell += 1) {
    const left = from + cell * step;
    const right = left + step;
    const covered: Record<string, number> = {};
    for (const stretch of stretches) {
      const overlap = Math.min(right, stretch.end) - Math.max(left, stretch.start);
      if (overlap > 0) {
        covered[stretch.state] = (covered[stretch.state] ?? 0) + overlap;
      }
    }
    const unknown = step - Object.values(covered).reduce((sum, value) => sum + value, 0);
    let state: string | null = null;
    let most = unknown;
    for (const [name, share] of Object.entries(covered)) {
      const rank = STRETCH_RANK[name] ?? 0;
      const held = state === null ? 0 : STRETCH_RANK[state] ?? 0;
      if (share > most || (share === most && rank > held)) {
        state = name;
        most = share;
      }
    }
    const look = stretchLook(state);
    parts.push(text({ ...look.props, ...(dim ? { dimColor: true } : {}) }, look.glyph));
  }
  return box({ flexDirection: "row", gap: 0 }, parts);
}

/**
 * A rate bar across the width it was given.
 *
 * The filled part carries the run's own color and the rest is drawn quiet, so a
 * share is read at a glance. Two things draw no bar at all, and both return null:
 * a run with no denominator to divide by, because an empty track under it reads
 * as nought done rather than as nothing known, and a run whose counts cannot
 * both be true, because a bar is the one thing on the pane that shows progress
 * as a proportion and a proportion of an impossible pair means nothing. What a
 * row does instead is state the two numbers and let them be read.
 */
export function rateBar(done: number, total: number, color: Color | undefined,
                        width: number): Node | null {
  if (!(total > 0) || !Number.isFinite(done) || !Number.isFinite(total)) {
    return null;
  }
  if (done < 0 || done > total) {
    return null;
  }
  // The width is the length the caller declared, and nothing else: overriding it
  // with a minimum of four drew a four-cell bar for a setting that asked for
  // two. A length of no cells is no bar at all rather than a bar of one, because
  // a single filled cell is a claim about a proportion nothing was measured for.
  const cells = Math.floor(width);
  if (cells < 1) {
    return null;
  }
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  const parts: Node[] = [];
  if (filled > 0) {
    parts.push(text({ color: color ?? "success" }, BAR_FILLED.repeat(filled)));
  }
  if (filled < cells) {
    parts.push(text({ dimColor: true }, BAR_TRACK.repeat(cells - filled)));
  }
  if (!parts.length) {
    return null;
  }
  const drawn = box({ flexDirection: "row", gap: 0 }, parts);
  const vector = barVector(done, total, color ?? "success", cells);
  return vector ? { ...drawn, vector } : drawn;
}
