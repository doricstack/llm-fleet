/**
 * The shared layout: descriptors in, Box and Text nodes out.
 *
 * This module is the whole reason the layout is testable without a host. It
 * takes a description of what should be on screen and returns a tree built only
 * from the two primitives in host.ts, so a test can read the structure and
 * assert it, on either surface, at any width.
 *
 * Three rules are structural rather than cosmetic, and the tests exist to keep
 * them that way:
 *
 * - a bar is drawn only when a real denominator exists, and it is never drawn
 *   for a value that contradicts itself (done above total),
 * - a long title is truncated, and never the state, the failure, the source
 *   error, or the denominator,
 * - a group that failed says it failed even while it is collapsed.
 */

import type { BoxProps, ButtonProps, Color, InputProps, Node, TextProps, Tree } from "./host.ts";
import { FOLDED, OPENED, checkDots, chip, historyStrip, rateBar, sparkline, stateColor, statStrip,
         statusDot, tag, tagTexts, timelineStrip, titleChip } from "./cards.ts";
import { tileVector } from "./vector.ts";

/**
 * Something a person can press, and the address a press comes back on.
 *
 * The address is the element's `key`: a `ui.press` hook receives it as
 * `e.element`, which is how the entry knows which section was folded.
 */
export type Control = {
  key: string;
  label: string;
  /** What a press does, run by the host in the plugin's own environment. */
  onPress: () => void;
  /** One digit or one lowercase letter that presses it while the pane has focus. */
  hotkey?: string;
  dim?: boolean;
};

export type Slot = {
  text: string;
  color?: Color;
  dim?: boolean;
  bold?: boolean;
  /**
   * The column this slot is drawn in, in cells, and which end it sits at.
   *
   * A figure drawn at the width it happens to need puts whatever follows it one
   * cell apart from row to row, so a column of percentages walks out of line
   * against the column beside it. A width is a claim that this slot holds a
   * column: the text is padded inside it, and the next slot starts where the
   * column ends.
   */
  width?: number;
  align?: "left" | "right";
};

export type Bar = {
  done: number;
  total: number;
  failed?: number;
  /** Whether the run behind these counts is still going. */
  stopped?: boolean;
  /**
   * What is written under the bar, instead of the counts this file computes.
   *
   * A row that states its own counts beside the bar would say them twice if the
   * computed label were drawn as well, so the label is what a caller overrides.
   * Absent is the computed label and `null` is nothing: those are two different
   * answers, and a row whose only job is the bar has to be able to give the
   * second one.
   */
  label?: Slot | null;
  /**
   * How many cells the bar is drawn with, when the configuration fixes a length.
   *
   * Absent is the width the row was given. A configured length is capped by that
   * width rather than overflowing it, because a bar longer than the card it sits
   * in is a bar whose end nobody sees.
   */
  cells?: number;
};

/**
 * One bucket of a period, for the strip drawn across the top of a section.
 *
 * `outcomes` is how many things landed in the bucket and `failed` how many of
 * them did not pass. A bucket with nothing in it is drawn as track rather than
 * as a pass, because an hour nobody tried anything is not an hour that went
 * well.
 */
export type HistoryCell = {
  outcomes: number;
  failed: number;
};

/**
 * A stretch of the recent past, one cell per bucket, oldest first.
 *
 * It is drawn as its own line under the heading, above the rows, which is where
 * a reader looks for "how has the day gone" before reading any single row. It is
 * drawn only when the period holds something: a strip of empty cells is a claim
 * about twelve hours nobody measured.
 */
export type History = {
  /** What the strip covers, such as "Last 12 hours". */
  label: string;
  cells: HistoryCell[];
  /** What the buckets add up to, which is what the caption states. */
  outcomes: number;
  failed: number;
};

/**
 * A line an item draws at rest under its first two: a subagent task it runs, the
 * reply it suggests, or what happens to it next. A line that carries a press is
 * one control, every word of it, which is how a suggestion is copied on a
 * surface that draws no field to send it from.
 */
export type RowLine = {
  slots: Slot[];
  press?: Control;
  /** Set in italic: the item's own words rather than the pane's. */
  italic?: boolean;
};

/** A text field under an item, such as the reply a waiting job is sent. */
export type Field = Omit<InputProps, "key"> & { key: string };

export type Row = {
  /**
   * What this row is, stable across readings: the address its hover scope and
   * its motion are keyed on. Absent, the row is addressed by its place.
   */
  key?: string;
  title: string;
  /**
   * The project this row belongs to, when the section is drawn as a tree.
   *
   * The renderer prints the root as a heading the first time a project's rows
   * are reached and hangs the rows under it one rail deeper, so the section
   * reads as one tree per project rather than a flat list of items nobody can
   * attribute. `last` is true for the section's last project, whose rail closes
   * into the section's line.
   */
  project?: { root: string; count: number; last: boolean };
  /**
   * What a press on the title does, when it does anything: the title is then a
   * control, every cell of it, so a person presses the thing they read.
   */
  press?: Control;
  /** Where the title links to, when it is a page: drawn as a link, opened by the surface. */
  link?: string;
  /** Lines drawn at rest under the row's first two, each its own. */
  lines?: RowLine[];
  /** A field under the row, on a surface that draws one. */
  field?: Field;
  /** A row of the past, such as a finished job: every part of it drawn quiet. */
  dim?: boolean;
  /**
   * How far the row stands from its place while it slides in or out, in cells,
   * and which way it is going. Absent for a row at rest, which is nearly all.
   */
  motion?: { offset: number; arriving?: boolean; leaving?: boolean };
  /**
   * What this row is doing, for the dot beside it.
   *
   * Absent when the row is not a state at all, which is most of them: a dot for
   * a thing that is not in one of those states would be a verdict this pane has
   * no basis for.
   */
  state?: string;
  meta: Slot[];
  slot: Slot[];
  /** A line of its own, such as what a waiting job asks. */
  detail?: string;
  bar?: Bar;
  /**
   * What the row measured, stated at the right of the bar's line with the bar's
   * own label at the left and the bar across the card under both: the shape the
   * host's Agents panel draws a session in. Absent, the bar keeps its counts
   * beside it or under it.
   */
  figures?: Slot[];
  /** What could not be read or proved about this row. */
  note?: Slot;
  /**
   * What the row holds in full, drawn under it once the row is opened.
   *
   * The two lines at rest are what a person scans; these are what they read
   * after pressing the row's figures, where the facts live that would make
   * every row three lines tall if they were always drawn.
   */
  details?: Slot[];
  /** The press that opens the row, drawn on its figures. */
  detailsPress?: Control;
  /** Whether the details are drawn now. */
  expanded?: boolean;
  /**
   * Checks drawn as dots at the right of the first line, one per check in its
   * state, and how many the reader left out, which are counted beside them.
   */
  checks?: { states: string[]; more: number };
  /**
   * The row's working, idle and waiting stretches, drawn as a line across the
   * card from `from` to `to` (epoch seconds). `tail` is the state from the last
   * stretch to `to`, when the row knows it; time no stretch covers is unknown.
   */
  timeline?: Timeline;
};

export type Timeline = {
  from: number;
  to: number;
  segments: { start: number; end: number; state: string }[];
  tail?: string;
};

/** A series drawn as one line of block glyphs, with the words that say what it adds up to. */
/**
 * A series and its label. `keep` is how many of the label's first segments are
 * drawn whole however narrow the card: the figure, and the mark that says it is
 * a floor, are what the line means, and the series gives up its room first.
 */
export type Spark = { values: number[]; label: Slot[]; keep?: number };

/**
 * What happened while the person was away, drawn under the pane's controls.
 *
 * `through` is the newest event it drew, which the entry keeps as the person's
 * last look when the pane closes; null when it drew no event, as when the
 * events could not be read.
 */
export type Digest = {
  title: string;
  tone: Color;
  heading: Slot[];
  lines: Slot[][];
  through: number | null;
};

export type GroupState = "ready" | "empty" | "disabled" | "failed" | "stale" | "unavailable" | "paused";

export type Group = {
  /**
   * Which half of a blink the section is in while its warnings are new: its rule
   * swaps between the warning and the error color. Absent while it holds still.
   */
  blink?: boolean;
  /** The name used in a sentence about the group, such as "Background jobs". */
  name: string;
  title: string;
  summary: Slot[];
  rows: Row[];
  state: GroupState;
  collapsed?: boolean;
  /**
   * The control that folds this section, when the pane offers one.
   *
   * Its label carries the fold mark, so what a person reads is the state the
   * section is in rather than a word that has to be interpreted.
   */
  toggle?: Control;
  /**
   * The lines the section keeps under its heading while it is open, made up
   * with blank lines when it holds less: a section whose items come and go in
   * seconds otherwise moved every section below it each time.
   */
  reserve?: number;
  /**
   * Names for the figures a section draws in its rows' right-hand columns.
   *
   * A figure whose meaning a person has to infer from its shape, such as a
   * percentage and a byte count in two aligned columns, is named once above the
   * rows. A section whose right slot is a state word or a measured count names
   * nothing: there the slot already says what it is.
   */
  columns?: Slot[];
  /** Rows a stale group still carries, and how old the last good read is. */
  observed?: number;
  staleSeconds?: number;
  /** What failed, when the group failed. */
  failure?: string;
  /** The sentence a section uses when it is switched off, and when it is empty. */
  disabledText?: string;
  emptyText?: string;
  /**
   * What this section's counts mean, as the configuration words it.
   *
   * Drawn under the heading while the section is open. It is the one line that
   * says a count is of trials, or of worktrees, or of sources that could not be
   * read, which is what a row of numbers at the right of a heading cannot say
   * for itself.
   */
  legend?: string | null;
  /**
   * The recent past drawn as a strip, when the section has one to draw.
   *
   * It belongs to the section rather than to a row: no single row is the day.
   */
  history?: History | null;
  /**
   * The section's headline figures, drawn as small cards above its rows: a
   * label and a value each, as the host's Agents panel heads a run with its
   * cost, tokens and time. A figure nobody reported is a tile that says so.
   */
  tiles?: Tile[];
  /**
   * Lines the section draws under its rows while it is open: what the rows do
   * when pressed, and what it knows that is no row of its own, such as how many
   * interactive sessions each provider runs.
   */
  notes?: Slot[][];
  /**
   * Rows the section held back to keep its height, drawn under it while the
   * pointer is on it.
   *
   * A heading that says "3 more" without them is a count a person can only take
   * on trust; the rows are already read and masked, so showing them costs no
   * more than the count did.
   */
  held?: Row[];
  /** A series the section draws under its heading while open, such as spend over the day. */
  spark?: Spark | null;
  /**
   * Whether the section holds something that needs the person: a failed check,
   * a job waiting on input, a failed trial or run. Such a section is drawn above
   * the calm ones.
   */
  attention?: boolean;
};

/** One headline figure of a section. */
export type Tile = { label: string; value: string; color?: Color };

/**
 * A headline figure that is also the way into what it counts.
 *
 * A figure a person reads and cannot act on leaves them to find the rows
 * themselves; pressing the card narrows the pane to the items in that state,
 * which is the thing the number made them want.
 */
export type PaneCard = {
  label: string;
  value: string;
  color?: Color;
  press?: Control;
};

export type Pane = {
  title: string;
  /**
   * The headline figures, drawn as a row of cards under the title.
   *
   * Each is a count the pane is already going to state, given the prominence the
   * figures at the top of a panel get. A figure the machine did not give is not
   * a card: a card is the loudest thing on the pane, and a zero there is the
   * strongest claim it could make.
   */
  cards?: PaneCard[];
  /** The counts as a line of text, for a caller that draws no cards. */
  counts: Slot[];
  updated: Slot;
  warning?: Slot;
  /** The controls that act on every section at once, drawn under the counts. */
  controls?: Control[];
  /** What closes the pane, said beside the controls in the words a person types. */
  hint?: string;
  /**
   * The filter a press on a headline figure set, and the press that clears it.
   *
   * Drawn under the controls, so a narrowed pane never reads as a small fleet:
   * the figures at the top still state the whole machine, and this line says
   * why only some of its rows are under them.
   */
  focus?: { text: string; clear: Control };
  /** What happened since the person last looked, when there is anything to say. */
  digest?: Digest | null;
  /**
   * The line under the last card: what this is, its version and its license.
   *
   * It is the one place a person finds the version to quote when something is
   * wrong, so it is drawn dim and whole wherever the width holds it.
   */
  footer?: Slot;
  groups: Group[];
  /** Columns the surface offers. */
  width: number;
  /** Below this width the right slot moves to its own line. */
  narrowAt: number;
};

export const BAR_FILLED = "#";
export const BAR_EMPTY = "-";
export const TRUNCATION = "...";
/** What sits between two readings on one line: the host's own middle dot. */
export const SEPARATOR = "\u00b7";

export function text(props: TextProps, value: string): Node {
  return { type: "Text", props, children: [value] };
}

export function box(props: BoxProps, children: (Node | string)[]): Node {
  return { type: "Box", props, children };
}

/**
 * A row of segments, each with its own color, on one line.
 *
 * Segments are separated by one space unless a segment asks to be joined to the
 * one before it, which is how a caller writes a punctuation-first segment. Two
 * readings placed next to each other without a gap read as one wrong reading.
 */
export function line(slots: Slot[], props: TextProps = {}): Node {
  return box({ flexDirection: "row", gap: 0 },
             slots.map((slot, index) => text(
               { ...props, ...slotProps(slot) },
               index === 0 || slot.text.startsWith(" ") ? slot.text : " " + slot.text)));
}

export function slotProps(slot: Slot): TextProps {
  const props: TextProps = {};
  if (slot.color) {
    props.color = slot.color;
  }
  if (slot.dim) {
    props.dimColor = true;
  }
  if (slot.bold) {
    props.bold = true;
  }
  return props;
}

/** Text cut to a width, with the cut marked so a reader knows it happened. */
export function fit(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= TRUNCATION.length) {
    return value.slice(0, width);
  }
  return value.slice(0, width - TRUNCATION.length) + TRUNCATION;
}

/**
 * Text cut to a width, without splitting the word the cut lands in.
 *
 * A segment can hold more than one fact, and the strip's last one holds a
 * duration and the word after it. Cut on the character it drew "10h 29m lon...",
 * which reads as a figure rather than as a line that was cut. A cut that lands
 * inside a word backs up to the last boundary; a cut that lands on one keeps the
 * word whole, and a single word with no boundary to back up to is cut where it
 * lands rather than dropped, because a line saying less is worse than a line
 * saying half.
 */
function cutToWord(value: string, width: number): string {
  const fitted = fit(value, width);
  if (fitted.length >= value.length || !fitted.endsWith(TRUNCATION)) {
    return fitted;
  }
  const body = fitted.slice(0, fitted.length - TRUNCATION.length);
  // What the cut landed on decides it: whitespace or the end of the value means
  // the text stopped at a boundary, and anything else means half a word.
  const next = value.charAt(body.length);
  if (next === "" || /\s/.test(next)) {
    return fitted;
  }
  const boundary = body.search(/\s\S*$/);
  return boundary > 0 ? body.slice(0, boundary) + TRUNCATION : fitted;
}

/**
 * A bar's cells for a denominator that can be trusted.
 *
 * A count above its total is not drawn: the caller reports the contradiction
 * instead, because a full-looking bar over impossible counts is exactly the
 * claim this design refuses to make.
 */
export function barCells(cells: number, done: number, total: number): string {
  if (cells <= 0 || total <= 0 || done < 0 || done > total) {
    return "";
  }
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(cells - filled);
}

/** What a row with no trustworthy denominator says instead of a bar. */
export function countLabel(bar: Bar | undefined): Slot {
  if (!bar || !Number.isFinite(bar.total) || !Number.isFinite(bar.done) || bar.total <= 0) {
    return { text: "No counts yet", color: "warning" };
  }
  if (bar.done > bar.total) {
    return { text: `${bar.done} of ${bar.total}`, color: "error" };
  }
  return { text: `${bar.done} / ${bar.total}`, color: "text" };
}

/** The wording a group with nothing to show uses, by why it has nothing. */
export function groupMessage(group: Group): Slot[] {
  const age = ageText(group.staleSeconds ?? 0);
  switch (group.state) {
    case "paused":
      return [{ text: `${group.name} is paused.`, dim: true }];
    case "empty":
      return [{ text: group.emptyText ?? `No ${group.name.toLowerCase()} here.`, dim: true }];
    case "disabled":
      return [{ text: group.disabledText ?? `${group.name} is disabled in configuration.`,
                dim: true }];
    case "unavailable":
      return [{ text: `Could not read ${group.failure ?? group.name}. Count unknown.`,
                color: "warning" }];
    case "failed":
      return [{ text: `Could not read ${group.failure ?? group.name}. Count unknown.`,
                color: "error" }];
    case "stale":
      return [{ text: `${group.observed ?? 0} observed, as of ${age}. Refresh failed.`,
                color: "warning" }];
    default:
      return [];
  }
}

/**
 * A length of time, without saying which way it points.
 *
 * `ageText` answers "how long ago"; a duration is what a sentence like "lease
 * ends in 10m" or "waiting 5m" needs, and joining the two produces the nonsense
 * this pair exists to prevent.
 */
export function durationText(seconds: number): string {
  return ageText(seconds).replace(/ ago$/, "");
}

export function ageText(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(0, Math.round(seconds))}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * A section's project root, drawn once above the rows that belong to it.
 *
 * The root is set in the theme's accent so a reader tells one project from the
 * next without counting indents, and its count is the items under that root
 * rather than the section's total, which its heading already states.
 */
function renderProject(project: { root: string; count: number }, width: number,
                       rail: Rail): Node {
  const label = fit(project.root, Math.max(8, width - rail.first.length - 12));
  const count = project.count + (project.count === 1 ? " item" : " items");
  return box({ flexDirection: "row", gap: 1 }, [
    text({ color: rail.color, ...(rail.dim ? { dimColor: true } : {}) }, rail.first),
    text({ color: "claude", bold: true }, label),
    text({ dimColor: true }, count),
  ]);
}

/**
 * The mark a section's items hang off, beside each line an item draws: a branch
 * on its first line and the rail running on beside the rest, or the closing
 * branch and nothing for the last item.
 */
export type Rail = {
  first: string;
  rest: string;
  color: Color;
  dim?: boolean;
  /**
   * What stands before this row's branch on the section's rail: the parent's
   * rail at full width while the row is one of several under it, and blank when
   * it is the last, so the branch closes into the section's line.
   */
  prefix?: string;
};

/** The rail's own glyphs. */
export const RAIL_BRANCH = "├─";
export const RAIL_LAST = "└─";
export const RAIL_ON = "│ ";
export const RAIL_END = "  ";

/** The states whose item is a question for a person rather than a measurement. */
const ASKING = new Set(["waiting", "blocked"]);

/**
 * One item, in two lines at rest.
 *
 * The first says what it is and how it stands: the state dot, the title, who or
 * what runs it, and its headline figures at the right. The second says how far
 * along it is, as a bar with its label, or, for an item that waits on a person,
 * what it asks. Whatever else the item has to say for itself waits for the
 * pointer: two lines an item is what lets a pane a few dozen rows high show a
 * whole section instead of two items of it.
 *
 * Every line is cut to the width it was given, because a text too long for its
 * line wraps into columns of its own and takes the lines below with it.
 */
export function renderRow(row: Row, width: number, narrowAt: number,
                          key?: string, rail?: Rail): Node {
  const offset = Math.max(0, Math.round(row.motion?.offset ?? 0));
  const railWidth = rail ? (rail.prefix?.length ?? 0) + RAIL_BRANCH.length + 1 : 0;
  // The row is laid out at the width it has at rest, and the slide's offset is
  // taken from the dim middle text alone: cut to the room left after the
  // offset, the title's ellipsis moved a cell on every frame of a slide.
  const resting = Math.max(8, width - railWidth);
  const inner = Math.max(8, resting - offset);
  const stacked = resting < narrowAt;
  // The figures stand at the right when the row has them; a row without any
  // states its slot there instead.
  const rightSlots = row.figures && row.figures.length ? row.figures
    : row.slot.map((part, index) => index === 0 ? { ...part, bold: true } : part);
  const fill = titleChip(row.state ?? "");
  // The figures take their room before the title does: a state or a verdict is
  // what the row is read for, and a title cut to keep it is still a title. What
  // the title is given is what is left, rather than a flat share of the line: a
  // share cut a pull request's title to a third of the row while the repository
  // name beside it was cut to eight cells and said less.
  //
  // Every budget below is the cells the line actually holds: the status dot and
  // its gap, the one cell between the two halves of the row, the dots and the
  // cell before the figures, and the least a title keeps.
  const MIN_TITLE = 8;
  const right = fitSlots(rightSlots, Math.max(0, stacked ? resting - 2
    : resting - 2 - 1 - MIN_TITLE));
  const rightWidth = slotsWidth(right);
  // The checks sit beside the right slot, a cell from it, and take their room
  // before the dim middle text does: a dot is a verdict and the meta is context.
  const dotsRoom = stacked ? resting - 2 - rightWidth - 1
    : resting - 2 - 1 - rightWidth - 1 - MIN_TITLE;
  const dots = row.checks
    ? checkDots(row.checks.states, row.checks.more, Math.max(0, dotsRoom)) : null;
  const dotsWidth = dots ? dots.width + 1 : 0;
  // The dim middle text is context, and a long title is the row's name: where
  // both cannot be drawn, the name is kept and the context moves to the row's
  // hover card with the rest of what it says.
  const metaWanted = row.meta.length > 0 && !stacked
    && row.title.length <= Math.floor(resting * 0.55) ? 12 : 0;
  const titleRoom = stacked ? resting - 2
    : Math.max(MIN_TITLE, Math.min(row.title.length + (fill ? 2 : 0),
        resting - 2 - 1 - rightWidth - dotsWidth - (metaWanted ? metaWanted + 1 : 0)));
  const name = fit(row.title, titleRoom - (fill ? 2 : 0));
  const title = titleNode(row, name, fill);
  const titleWidth = name.length + (fill ? 2 : 0);
  const metaRoom = inner - 2 - 1 - rightWidth - dotsWidth - titleWidth;
  const meta = stacked || metaRoom < 6 ? [] : fitSlots(row.meta, metaRoom);
  const rightLine = dots
    ? box({ flexDirection: "row", gap: 1 }, right.length ? [dots.node, line(right)] : [dots.node])
    : line(right.length ? right : [{ text: "" }]);
  // A row holding more than its two lines says so on its figures: the words a
  // person already reads for the row's state are the press that opens them.
  const rightDrawn = row.detailsPress
    ? control(row.detailsPress, { plain: true, hover: { color: "claude" } }, [rightLine])
    : rightLine;
  const first = stacked
    ? box({ flexDirection: "row", gap: 1, flexGrow: 1 }, [statusDot(row.state ?? ""), title])
    : box({ flexDirection: "row", justifyContent: "space-between", gap: 1, flexGrow: 1 }, [
      box({ flexDirection: "row", gap: 1 }, [
        statusDot(row.state ?? ""),
        title,
        ...(meta.length ? [line(meta, { dimColor: true })] : []),
      ]),
      rightDrawn,
    ]);
  // The second line: the question an item waits on, or its bar and label.
  const room = Math.max(1, inner - 2);
  const asking = Boolean(row.detail) && (ASKING.has(row.state ?? "") || !row.bar);
  let second: Node | null = null;
  if (asking && row.detail) {
    // The row's own words are set in italic, so a reader tells what the work
    // said from what the pane measured.
    second = line([{ text: fit(row.detail, room) }],
                  { italic: true, ...(row.dim ? { dimColor: true } : {}) });
  } else if (row.bar) {
    second = barLine(row, room);
  }
  // What the row has to say beyond its two lines, shown while the pointer is on
  // it: a note on how its figures were read, and its own words when the bar
  // took the second line.
  const extra: Node[] = [];
  if (row.note && row.note.text) {
    extra.push(line([{ ...row.note, text: fit(row.note.text, room) }], { italic: true }));
  }
  if (row.detail && !asking) {
    extra.push(line([{ text: fit(row.detail, room) }], { italic: true }));
  }
  if (meta.length === 0 && row.meta.length && stacked) {
    extra.push(line(fitSlots(row.meta, room), { dimColor: true }));
  }
  const moved = offset > 0 ? { marginLeft: offset } : {};
  const railed = (glyph: string | null, content: Node, props: BoxProps = {}): Node => {
    const body = box({ flexDirection: "column", gap: 0, flexGrow: 1, ...moved }, [content]);
    const glyphs = glyph === null ? "" : (rail?.prefix ?? "") + glyph;
    return glyphs === ""
      ? box({ flexDirection: "row", gap: 0, ...props }, [body])
      : box({ flexDirection: "row", gap: 1, ...props }, [
        text({ color: rail?.color, ...(rail?.dim ? { dimColor: true } : {}) }, glyphs),
        body,
      ]);
  };
  const lines: Node[] = [railed(rail ? rail.first : null, first)];
  if (stacked && (right.length || dots)) {
    lines.push(railed(rail ? rail.rest : null, box({ marginLeft: 2, flexDirection: "row" },
                                                    [rightDrawn])));
  }
  if (second) {
    lines.push(railed(rail ? rail.rest : null, box({ marginLeft: 2, flexDirection: "row" },
                                                    [second])));
  }
  // The row's recent time, across the card under its bar: what it was doing
  // when, so a session that has sat idle for an hour reads as one at a glance.
  const strip = row.timeline ? timelineLine(row.timeline, room, row.dim === true) : null;
  if (strip) {
    lines.push(railed(rail ? rail.rest : null, box({ marginLeft: 2, flexDirection: "row" },
                                                    [strip])));
  }
  // The lines it draws at rest, under the first two: the subagent tasks a job
  // runs, the reply it suggests, what happens to a worktree next.
  for (const extraLine of row.lines ?? []) {
    const slots = fitSlots(extraLine.slots, room);
    const content = extraLine.press
      ? control(extraLine.press, { plain: true, hover: { color: "claude" } },
                inlineTexts(slots, extraLine.italic ? { italic: true } : {}))
      : line(slots, extraLine.italic ? { italic: true } : {});
    lines.push(railed(rail ? rail.rest : null,
                      box({ marginLeft: 2, flexDirection: "row" }, [content])));
  }
  // The row opened: what it holds in full, one dim line each, under the lines
  // it always draws. Nothing here is hidden behind the pointer, because a press
  // was the question and these are the answer.
  if (row.expanded && row.details?.length) {
    for (const detail of row.details) {
      lines.push(railed(rail ? rail.rest : null,
                        box({ marginLeft: 2, flexDirection: "row" },
                            [line([{ ...detail, text: fit(detail.text, room), dim: true }])])));
    }
  }
  if (row.field) {
    // The field is the row's last line, under what it answers.
    const field: Node = { type: "Input", props: { ...row.field }, children: [] };
    lines.push(railed(rail ? rail.rest : null,
                      box({ marginLeft: 2, flexDirection: "row" }, [field])));
  }
  if (extra.length) {
    lines.push(railed(rail ? rail.rest : null,
                      box({ marginLeft: 2, flexDirection: "column", gap: 0 }, extra),
                      { display: "none", hover: { display: "flex" } }));
  }
  // The row is a hover scope of its own: the pointer on it lights the title the
  // way the host lights the session under its cursor, and shows its extra lines.
  const address = key ?? row.key;
  // A row that failed is shaded in the theme's own soft red, so it stands out of
  // a section of healthy rows without being read first.
  const shaded = row.motion?.arriving ? { backgroundColor: "diffAddedDimmed" as const }
    : stateColor(row.state ?? "") === "error"
      ? { backgroundColor: "diffRemovedDimmed" as const } : {};
  // The row's whole words, drawn over it while the pointer is on it.
  //
  // The host draws no tooltip: a hover can restyle an element or reveal one
  // already in the tree, and nothing else. The title and the figures are each
  // cut to the line they share, and what a cut takes is exactly what tells two
  // similar rows apart. So the full line is written here, hidden and out of the
  // flow, and the row's own hover scope shows it over the row: nothing moves
  // when it appears, and it costs no room while it is away.
  const whole = hoverWords(row, rightSlots);
  if (whole !== "") {
    lines.push(box({ display: "none", position: "absolute", top: 0, left: 0,
                     hover: { display: "flex" }, backgroundColor: "diffAddedDimmed",
                     paddingX: 1, flexShrink: 0,
                     width: Math.min(resting, whole.length + 2) },
                   [text({ wrap: "truncate-end" }, whole)]));
  }
  return box({ ...(address ? { key: address } : {}), flexDirection: "column", gap: 0, ...shaded },
             lines);
}

/**
 * Everything a row says, uncut, for the card its hover draws.
 *
 * The title first and then its figures, which is the order they read in. A row
 * with nothing to say draws no card rather than an empty one.
 */
function hoverWords(row: Row, right: Slot[]): string {
  const figures = right.map((slot) => slot.text).join("").trim();
  return (row.title + row.meta.map((slot) => slot.text).join("")
          + (figures ? "  " + figures : "")).trim();
}

/**
 * A row's timeline as a strip of cells: its stretches, and the stretch from the
 * last of them to `to` in the state the row is in now, when it knows it.
 */
function timelineLine(timeline: Timeline, room: number, dim: boolean): Node | null {
  if (!timelineDrawn(timeline)) {
    return null;
  }
  const last = Math.max(...timeline.segments.map((segment) => segment.end));
  const stretches = timeline.tail && timeline.to > last
    ? [...timeline.segments, { start: last, end: timeline.to, state: timeline.tail }]
    : timeline.segments;
  return timelineStrip(stretches, timeline.from, timeline.to, room, dim);
}

/** Whether a timeline has anything to draw: a stretch, over a span of time. */
function timelineDrawn(timeline: Timeline | undefined): boolean {
  return timeline !== undefined && timeline.segments.length > 0 && timeline.to > timeline.from;
}

/**
 * A row's title: marked in its color when its state earns it, pressable when it
 * copies something, a link when it is a page, and quiet when the row is of the
 * past.
 *
 * A control holds texts and nothing else, so a mark inside one is its texts
 * rather than the box `tag` draws them in: the engine refuses a box in a
 * button, and the whole pane with it.
 */
function titleNode(row: Row, name: string, fill: Color | null): Node {
  const look: TextProps = row.dim ? { dimColor: true } : { bold: true };
  if (row.press) {
    const children = fill
      ? tagTexts(name, fill)
      : [text({ wrap: "truncate-end", ...look }, name)];
    return control(row.press, { plain: true, hover: { color: "claude" },
                                ...(row.dim ? { dimColor: true } : {}) }, children);
  }
  if (row.link) {
    // A link is inline, so a marked title is the mark's texts inside the link,
    // kept from shrinking as the mark's own box keeps them: a failing pull
    // request is still a page a person opens.
    const inline = fill
      ? tagTexts(name, fill)
      : [text({ wrap: "truncate-end", ...look, hover: { color: "claude" } }, name)];
    const link: Node = { type: "Link", props: { href: row.link }, children: inline };
    return fill ? box({ flexDirection: "row", gap: 0, flexShrink: 0 }, [link]) : link;
  }
  return fill
    ? tag(name, fill)
    : text({ wrap: "truncate-end", ...look, hover: { color: "claude" } }, name);
}

/** Slots as the texts a control may hold, spaced as `line` spaces them. */
function inlineTexts(slots: Slot[], props: TextProps = {}): Node[] {
  return slots.map((slot, index) => text(
    { ...props, ...slotProps(slot) },
    index === 0 || slot.text.startsWith(" ") ? slot.text : " " + slot.text));
}

/** How many cells a run of slots draws, with the spaces `line` puts between them. */
function slotsWidth(slots: Slot[]): number {
  return slots.reduce((sum, slot, index) =>
    sum + slot.text.length + (index === 0 || slot.text.startsWith(" ") ? 0 : 1), 0);
}

/**
 * A row's bar and the words for it, on one line.
 *
 * A label the caller wrote is drawn instead of the counts, and no label at all
 * is drawn as nothing: the failure and stop tails belong to the computed label,
 * because a caller that writes its own has already said both. The bar takes the
 * line the label leaves, or the length the configuration fixes when that is
 * shorter. Counts that cannot be drawn as a bar are stated instead.
 */
function barLine(row: Row, room: number): Node {
  const bar = row.bar as Bar;
  const counts: Slot[] = bar.label === null ? []
    : bar.label !== undefined ? [bar.label]
      : [countLabel(bar),
         ...((bar.failed ?? 0) > 0
           ? [{ text: ` ${SEPARATOR} ${bar.failed} failed`, color: "error" as const }] : []),
         ...(bar.stopped ? [{ text: ` ${SEPARATOR} Stopped early`, color: "warning" as const }]
           : [])];
  const label = fitSlots(counts, Math.max(0, Math.floor(room / 2)));
  const labelWidth = slotsWidth(label);
  const free = Math.max(1, room - (label.length ? labelWidth + 2 : 0));
  const length = bar.cells === undefined ? free : Math.min(free, bar.cells);
  const cells = rateBar(bar.done, bar.total,
                        (bar.failed ?? 0) > 0 ? "error" : stateTone(row.state), length);
  if (!cells) {
    return line([countLabel(bar)]);
  }
  // The drawing's alt says what the label beside it says, so a waiting bar is
  // read as its time left rather than as two counts of seconds.
  const spoken = label.map((slot) => slot.text.trim()).filter(Boolean).join(" ");
  const drawn = cells.vector && spoken ? { ...cells, vector: { ...cells.vector, alt: spoken } }
    : cells;
  return label.length ? box({ flexDirection: "row", gap: 2 }, [drawn, line(label)]) : drawn;
}

/**
 * What names a section among its siblings: its fold control's address, which
 * carries the section's id, or its title when it has no control.
 *
 * Two sections may be given the same title by configuration, and siblings that
 * share a key are not hover scopes at all, so the title alone is not enough.
 */
export function groupKey(group: Group): string {
  return group.toggle?.key ?? group.title;
}

/** The bar's color for a row in a state: its own, or the healthy one. */
function stateTone(state: string | undefined): Color {
  const tone = stateColor(state ?? "");
  return tone === "subtle" ? "success" : tone;
}

/**
 * The color a card's rule is drawn in: the loudest thing inside it.
 *
 * A broken source is the error color, a stale or unread one and a card holding
 * something that waits on a person are the warning color, and a card with live
 * work is the success color. Everything else is the quiet rule. The rule repeats
 * what the card's heading and rows already say in words; it is how a person
 * finds the card that needs them before reading any of it.
 */
export function groupTone(group: Group): Color {
  if (group.state === "failed") {
    return "error";
  }
  if (group.state === "unavailable" || group.state === "stale") {
    return "warning";
  }
  const tones = group.rows.map((row) => stateColor(row.state ?? ""));
  if (tones.includes("error")) {
    return "error";
  }
  if (tones.includes("warning")) {
    return "warning";
  }
  if (tones.includes("success")) {
    return "success";
  }
  return "subtle";
}

/**
 * One group: a card, with its heading, its rows and the state it is in.
 *
 * The card is a bordered box the surface draws, so a run of sections reads as
 * tiles rather than as headings stacked over rows. The heading carries a mark
 * for the fold, the section's name, and what it holds at the right; the mark is
 * on the control itself, so it is a thing a person presses rather than a word
 * beside one.
 *
 * A collapsed group keeps its heading and its count, and a group that failed
 * keeps its warning line: an error hidden behind a folded card is a claim that
 * nothing is wrong, which is the one thing this design will not do.
 */
export function renderGroup(given: Group, width: number, narrowAt: number): Node {
  // A row arriving while another leaves takes its place: drawn together for the
  // length of the slide, the section grew by the leaving row and shrank back,
  // and every section below it went down and up. With nothing arriving, a
  // leaving row slides out where it stood.
  const group = given.rows.some((entry) => entry.motion?.arriving)
    ? { ...given, rows: given.rows.filter((entry) => !entry.motion?.leaving) } : given;
  // The rule and the padding take four columns from the width the pane was
  // given, so what the card holds is four less. Budgeting two less left the
  // contents two columns wider than the card draws, and the padding each row
  // added took it to four.
  const inner = Math.max(8, width - 2);
  // The section's name is drawn in the tone its card is drawn in, behind the
  // accent, so a person finds the section that needs them by its color before
  // reading a word of it. It is on no fill: a column of names on blocks of
  // yellow and green outshouted the counts they head. The accent and its space
  // take the two cells the chip's fill took, so the name is cut as it was.
  const tone = groupTone(group);
  // New warnings blink: the heading and the rail swap between the warning and
  // the error color for a few seconds, then hold the section's own tone.
  const shown: Color = group.blink === undefined ? tone : group.blink ? "warning" : "error";
  // The mark is texts and no box: a button holds strings and text only, and the
  // engine refuses a heading that puts a box inside its fold control.
  const named = (room: number): Node[] => tagTexts(fit(group.title, room), shown);
  const titleRoom = Math.max(8, inner - 10);
  const shownTitle = fit(group.title, titleRoom);
  const heading = group.toggle
    ? control(group.toggle, { plain: true }, named(titleRoom))
    : box({ flexDirection: "row", gap: 0, flexShrink: 0 }, named(Math.max(8, inner - 6)));
  // What the heading takes before the figures get their room: the fold mark and
  // its gap, the three cells a control gives its hotkey, the accent and its
  // space, and the title as it is actually drawn. The title is fitted first
  // because a cut title leaves the figures the room its unshown length was
  // costing them; and the one cell between the two halves of the line is
  // counted because a summary budgeted without it was a cell too wide, which is
  // how "9 merged" ended up wrapped under its own count.
  const leftCells = 2 + (group.toggle?.hotkey ? group.toggle.hotkey.length + 2 : 0)
    + 2 + shownTitle.length;
  const summaryRoom = Math.max(0, inner - leftCells - 1);
  const parts: Node[] = [
    box({ flexDirection: "row", justifyContent: "space-between", gap: 1 }, [
      box({ flexDirection: "row", gap: 1, flexShrink: 0 }, [
        text({ color: group.state === "failed" ? "error" : "subtle" },
             group.collapsed ? FOLDED : OPENED),
        heading,
      ]),
      summaryLine(fittedSummary(group, summaryRoom)),
    ]),
  ];
  // The legend is what the section's counts mean, so it is drawn with the rows
  // rather than with the heading: a folded section states its counts and does
  // not explain them, which is what folding it asked for. A section drawn as one
  // line draws none either, because there is nothing under it to explain: a
  // legend over an empty section is the second line that drawing it as a line
  // was meant to save.
  //
  // It is the card's hint rather than its content, so it shows while the pointer
  // is on the card and hides at rest: the surface does the showing, and a reader
  // who never points keeps that line for rows.
  if (group.legend && !group.collapsed && boxed(group)) {
    parts.push(box({ display: "none", hover: { display: "flex" } },
                   [line([{ text: fit(group.legend, inner), dim: true }], { italic: true })]));
  }
  // The tiles head the section's rows, as the Agents panel heads a run with its
  // figures. Folding gives their room back, like everything under the heading.
  if (group.tiles && group.tiles.length && !group.collapsed) {
    parts.push(renderTiles(group.tiles, inner));
  }
  // The strip says how the recent past went, which is what a reader looks for
  // before reading a single row, so it sits above them. It is not drawn for a
  // folded section: folding gave that room back.
  if (group.history && !group.collapsed) {
    const strip = historyStrip(group.history, inner);
    if (strip) {
      parts.push(strip);
    }
  }
  // What the section's work cost over the window, under the heading for the
  // same reason the strip is: no single row is the day.
  if (group.spark && !group.collapsed) {
    const spark = sparkLine(group.spark, inner);
    if (spark) {
      parts.push(spark);
    }
  }
  // The columns are named once, above the rows they align with, in the same
  // dim tone as any other label. A folded section draws none: it draws no rows.
  if (group.columns?.length && group.rows.length && !group.collapsed) {
    parts.push(box({ flexDirection: "row", justifyContent: "flex-end" },
                   [line(group.columns.map((slot): Slot => ({ ...slot, dim: true })))]));
  }
  if (group.rows.length && !group.collapsed) {
    // The section is the parent and its items hang off one rail in its tone. A
    // calm rail rests dim; one that warns is drawn at full strength.
    const calm = group.blink === undefined && (tone === "subtle" || tone === "success");
    const count = group.rows.length;
    // A section drawn as a tree prints each project root once, in the theme's
    // accent, and hangs that project's rows one rail deeper: the section's own
    // rail holds each root, and the root's rail runs on when another project
    // follows it.
    const drawn: Node[] = [];
    group.rows.forEach((row, index) => {
      const project = row.project;
      const newProject = project !== undefined
        && (index === 0 || group.rows[index - 1]?.project?.root !== project.root);
      if (newProject && project) {
        const rail: Rail = {
          first: project.last ? RAIL_LAST : RAIL_BRANCH,
          rest: project.last ? RAIL_END : RAIL_ON,
          color: shown, ...(calm ? { dim: true } : {}),
        };
        drawn.push(renderProject(project, inner, rail));
      }
      const next = group.rows[index + 1];
      // A row without a project closes its own rail at the section's end; a
      // row inside a project closes when its project has no next row.
      const closesRail = project === undefined
        ? index === count - 1
        : next?.project?.root !== project.root;
      const lastChild = closesRail;
      const first = lastChild ? RAIL_LAST : RAIL_BRANCH;
      const rest = lastChild ? RAIL_END : RAIL_ON;
      const prefix = project === undefined ? "" : project.last ? RAIL_END : RAIL_ON;
      drawn.push(renderRow(
        row, inner, narrowAt,
        "row:" + groupKey(group) + ":" + (row.key ?? String(index)),
        { first, rest, prefix, color: shown, ...(calm ? { dim: true } : {}) }));
    });
    parts.push(box({ flexDirection: "column", gap: 0 }, drawn));
    // What the ceiling held back is drawn under the section while the pointer is
    // on it: the heading already states how many there are, and a number a
    // person cannot open is one they have to take on trust. The rows are read
    // and masked exactly as the drawn ones are, so this shows nothing new.
    if (group.held && group.held.length) {
      const heldCount = group.held.length;
      parts.push(box({ display: "none", hover: { display: "flex" },
                       flexDirection: "column", gap: 0 },
                     group.held.map((row, index) => renderRow(
                       row, inner, narrowAt,
                       "held:" + groupKey(group) + ":" + (row.key ?? String(index)),
                       { first: index === heldCount - 1 ? RAIL_LAST : RAIL_BRANCH,
                         rest: index === heldCount - 1 ? RAIL_END : RAIL_ON,
                         color: shown, ...(calm ? { dim: true } : {}) }))));
    }
  }
  // A row still sliding out is still on the pane, so a section is not yet
  // empty: said under the leaving row, the line jumped up a row when it went.
  // A failure is said at once, whatever is moving.
  const leaving = group.rows.some((entry) => entry.motion?.leaving);
  if ((!group.rows.length || group.state !== "ready")
      && (!leaving || group.state === "failed" || group.state === "stale")) {
    const message = groupMessage(group);
    if (message.length) {
      parts.push(line(message));
    }
  }
  // What the section knows beyond its rows, while it is open: a folded section
  // gave its room back, notes included.
  if (group.notes && group.notes.length && !group.collapsed) {
    for (const note of group.notes) {
      parts.push(line(fitSlots(note, inner)));
    }
  }
  if (group.reserve && !group.collapsed) {
    // A part that shows only under the pointer, as a legend does, takes no
    // room at rest, so it makes up none of the reserve.
    const showing = parts.slice(1).filter((part) =>
      (part as { props?: { display?: string } }).props?.display !== "none").length;
    const held = bodyLines(group, showing);
    for (let blank = held; blank < group.reserve; blank += 1) {
      parts.push(line([{ text: "" }]));
    }
  }
  // No card border: the heading's chip and the rail its items hang off are what
  // group a section, and the border's two lines and four columns go to the rows.
  return box({ key: "group:" + groupKey(group), flexDirection: "column", gap: 0, width,
               marginBottom: 1, paddingX: 1 }, parts);
}

/**
 * The lines a section's body takes at rest: each of its parts but the rows is
 * one line, and each row is its first line and, when it has one, its second
 * (the bar, or the question it waits on). The lines a row shows only under the
 * pointer are not counted, since at rest they take no room.
 */
function bodyLines(group: Group, parts: number): number {
  if (!group.rows.length) {
    return parts;
  }
  const rows = group.rows.reduce((sum, entry) => {
    const asking = Boolean(entry.detail) && (ASKING.has(entry.state ?? "") || !entry.bar);
    return sum + 1 + (entry.bar || asking ? 1 : 0) + (timelineDrawn(entry.timeline) ? 1 : 0);
  }, 0);
  // The rows are one part of the body, drawn as many lines.
  return parts - 1 + rows;
}

/**
 * A series and its label on one line: the glyphs take what the label leaves, and
 * the label is cut to half the line first, so a long one never squeezes the
 * series to nothing; the segments it keeps whole are the exception, and a line
 * with no room left for the series is the label alone.
 */
function sparkLine(spark: Spark, width: number): Node | null {
  const label = sparkLabel(spark, width);
  const room = width - (label.length ? slotsWidth(label) + 2 : 0);
  const glyphs = sparkline(spark.values, room);
  if (!glyphs) {
    return label.length ? line(label) : null;
  }
  return label.length ? box({ flexDirection: "row", gap: 2 }, [glyphs, line(label)]) : glyphs;
}

/**
 * A spark's label cut to its share of the line, the segments it keeps whole set
 * apart from the rest: cut as one line, the mark that says the rest was dropped
 * would be cut into the last kept segment, which is the one that had to stay.
 */
function sparkLabel(spark: Spark, width: number): Slot[] {
  const kept = spark.label.slice(0, spark.keep ?? 0);
  const keptWidth = slotsWidth(kept);
  const share = Math.max(0, Math.floor(width / 2));
  if (!kept.length || keptWidth > width) {
    return fitSlots(spark.label, share);
  }
  const rest = spark.label.slice(kept.length);
  return [...kept, ...fitSlots(rest, Math.max(share, keptWidth) - keptWidth)];
}

/**
 * The digest: a heading in its tone and a line per event, each cut to the
 * pane's width, indented under the heading as a section's rows are.
 */
function digestBlock(digest: Digest, width: number): Node {
  const title = fit(digest.title, Math.max(8, width - 4));
  const heading = fitSlots(digest.heading, Math.max(0, width - title.length - 3));
  return box({ key: "digest", flexDirection: "column", gap: 0, marginTop: 1, paddingX: 1 }, [
    box({ flexDirection: "row", gap: 1 }, [
      box({ flexDirection: "row", gap: 0, flexShrink: 0 }, tagTexts(title, digest.tone)),
      ...(heading.length ? [line(heading)] : []),
    ]),
    ...digest.lines.map((slots) => box({ marginLeft: 2, flexDirection: "row" },
                                       [line(fitSlots(slots, Math.max(0, width - 4)))])),
  ]);
}

/** Below this a tile cannot hold a figure and its label, so tiles stack. */
const TILE_MINIMUM = 12;

/**
 * A section's tiles side by side, each its share of the width, or one under
 * another when the card is too narrow for that: a figure cut to fit is a figure
 * nobody can read.
 *
 * Each tile carries a vector drawing of the same words, cut the same way, which
 * a surface that draws vectors shows as a card in place of the bordered box.
 */
function renderTiles(tiles: Tile[], width: number): Node {
  const across = Math.floor((width - (tiles.length - 1)) / tiles.length);
  const stacked = across < TILE_MINIMUM;
  const each = stacked ? width : across;
  return box({ flexDirection: stacked ? "column" : "row", gap: stacked ? 0 : 1 },
             tiles.map((tile) => {
               const label = fit(tile.label, Math.max(4, each - 4));
               const value = fit(tile.value, Math.max(4, each - 4));
               const color = tile.color ?? "text";
               // The drawing is handed the whole words and cuts them by its own
               // measure, since a proportional face is not a cell wide a letter.
               return {
                 ...box({
                   flexDirection: "column", gap: 0, borderStyle: "round", borderColor: "subtle",
                   borderDimColor: true, paddingX: 1, width: each,
                 }, [text({ dimColor: true }, label), text({ bold: true, color }, value)]),
                 vector: tileVector(tile.label, tile.value, color, each),
               };
             }));
}

/**
 * A section's counts, cut to the room the heading leaves them.
 *
 * A heading's figures are the tail of a line that already holds the section's
 * name, so a section with five of them runs past the edge of the pane, and what
 * a reader loses is the last figure and the rule around it. Cutting here marks
 * the loss where it happened rather than letting the surface decide, and the
 * figures are cut from the least important end because the callers write them
 * most-important-first.
 */
function fittedSummary(group: Group, room: number): Slot[] {
  // A heading already too long to leave its figures any room is the case this
  // exists for, not the case it skips: returning the figures whole drew them
  // uncut across a card they did not fit in.
  return fitSlots(group.summary, Math.max(0, room), true);
}

/**
 * A line of segments cut to a width from its end, each segment keeping its own
 * style.
 *
 * Callers write their segments most important first, so the cut falls on the
 * least important. A segment the cut lands in is ended with the truncation mark
 * where a few cells of it still read; on a line drawn with chips (`chips`), a
 * segment drawn as a chip is dropped whole instead, because half a count on a
 * fill reads as a different count. Cutting
 * here rather than leaving it to the surface matters: a row of texts too wide
 * for its line is squeezed segment by segment, and every segment wraps into a
 * column of its own.
 */
export function fitSlots(slots: Slot[], room: number, chips = false): Slot[] {
  const out: Slot[] = [];
  let used = 0;
  // Only a line drawn as a summary draws its colored counts as chips; every
  // other line draws them as colored text, which is cut like any text. Measured
  // as a chip there, a warning was dropped whole for want of a cell it never
  // needed, and the line lost the one word it was there to say.
  const isChip = (slot: Slot): boolean =>
    chips && slot.color !== undefined && !slot.dim && CHIP_TONES.has(slot.color);
  const mark = " " + TRUNCATION;
  // A slot that holds a column is padded to that column before anything is
  // measured, so what follows starts where the column ends rather than where
  // this row's figure happened to stop.
  const placed = (slot: Slot): Slot => slot.width === undefined ? slot
    : { ...slot, text: slot.align === "left"
        ? slot.text.padEnd(slot.width) : slot.text.padStart(slot.width) };
  for (const [index, slot] of slots.entries()) {
    const column = placed(slot).text;
    const shown = index === 0 || column.startsWith(" ") ? column : " " + column;
    const chipped = isChip(slot);
    // A chip is drawn as its trimmed word with a cell of fill at each side.
    const drawn = chipped ? slot.text.trim().length + 2 + (index === 0 ? 0 : 1) : shown.length;
    if (used + drawn <= room) {
      out.push(placed(slot));
      used += drawn;
      continue;
    }
    const left = room - used;
    if (!chipped && left > TRUNCATION.length + 2) {
      out.push({ ...slot, text: cutToWord(shown, left) });
      break;
    }
    // No room for any of this segment, so the line says it was cut rather than
    // ending there: the mark is its own dim segment when it fits, and otherwise
    // goes on the plain text before it. A chip is never marked, because its fill
    // would carry the mark as though it were part of the figure; a line that
    // ends on a chip with no room left keeps the figure and goes unmarked, since
    // a count is worth more than the news that something followed it.
    const last = out.at(-1);
    if (last !== undefined && room - used >= mark.length) {
      out.push({ text: mark, dim: true });
    } else if (last !== undefined && !isChip(last)) {
      const keep = Math.max(0, last.text.length - TRUNCATION.length);
      out[out.length - 1] = { ...last, text: last.text.slice(0, keep) + TRUNCATION };
    }
    break;
  }
  return out;
}

/**
 * Whether a section earns a card, or is stated as one line.
 *
 * Something inside it, or something wrong with it: those are the two reasons a
 * section is drawn as a box. Everything else is a heading and its count, which
 * is what a reader needs and no more.
 */
export function boxed(group: Group): boolean {
  if (group.rows.length || (group.notes?.length ?? 0) > 0) {
    return true;
  }
  return group.state === "failed" || group.state === "unavailable"
    || group.state === "stale";
}

/** A pressable control, drawn with the label the pane gave it. */
function control(item: Control,
                 props: Omit<ButtonProps, "key" | "label" | "onPress"> = {},
                 children: Node[] = []): Node {
  return {
    type: "Button",
    props: { key: item.key, label: item.label, onPress: item.onPress,
             hotkey: item.hotkey, dimColor: item.dim, ...props },
    children,
  };
}

/** The colors a count is drawn on a chip in: the states, not the accents. */
const CHIP_TONES = new Set<Color>(["success", "warning", "error", "merged"]);

/**
 * A section's counts: a count of a state marked in its color, and every other
 * figure as plain text.
 *
 * A count the pane colored is a state (waiting, failed), and the accent is how
 * a state is drawn everywhere else on the pane; a dim figure such as a cost is
 * a measurement, and a measurement drawn as a state would read as an alarm.
 */
function summaryLine(slots: Slot[]): Node {
  return box({ flexDirection: "row", gap: 0 }, slots.map((slot, index) => {
    if (slot.color && !slot.dim && CHIP_TONES.has(slot.color)) {
      const parts = index === 0 ? [] : [text({}, " ")];
      return box({ flexDirection: "row", gap: 0 }, [...parts, tag(slot.text.trim(), slot.color)]);
    }
    return text(slotProps(slot),
                index === 0 || slot.text.startsWith(" ") ? slot.text : " " + slot.text);
  }));
}

/** The whole pane, in reading order. */
export function renderPane(pane: Pane): Tree {
  // The title is a chip in the host's own accent, the mark the pane is known by
  // at a glance; the age beside it is set in italic, as a note on the reading
  // rather than a figure of it.
  //
  // The head is as short as it can be made, because an inline pane is given a
  // fixed number of rows and every row the head takes is a row of a card cut
  // off below. The figures share the title's line when they fit beside it, and
  // take a line of their own when they do not; the controls take one more.
  const title = chip(fit(pane.title, Math.max(8, pane.width - 24)), "claude");
  const age = line([pane.updated, ...(pane.warning ? [pane.warning] : [])], { italic: true });
  const ageWidth = pane.updated.text.length + (pane.warning ? pane.warning.text.length + 1 : 0);
  // One statement of the figures, never two. The cards are the form a person
  // reads at a glance and the line is the form that survives when there is
  // nothing to put in a card: a pane whose roster could not be read draws no
  // cards, and it still says what it does know rather than saying it twice.
  const cards = pane.cards ?? [];
  const cardsWidth = cards.reduce((sum, card) => sum + card.value.length + card.label.length + 3, 0)
    + 3 * Math.max(0, cards.length - 1);
  const beside = cards.length > 0
    && pane.title.length + 2 + 3 + cardsWidth + 2 + ageWidth <= pane.width;
  const parts: Node[] = [
    box({ flexDirection: "row", justifyContent: "space-between", gap: 1 }, [
      beside ? box({ flexDirection: "row", gap: 3 }, [title, statStrip(cards, cardsWidth, true)])
             : title,
      age,
    ]),
  ];
  if (!beside) {
    parts.push(cards.length ? statStrip(cards, pane.width) : line(pane.counts));
  }
  // The controls are drawn the way the host draws its own shortcuts: the key in
  // the accent color, then the word, with no bracket chrome round each one.
  if (pane.controls?.length) {
    // The hint shares the controls' line, so it is said only where the line has
    // room for it: the host draws each keyed control as its key, a colon and a
    // space before its label, and three cells part them. A narrower pane drops
    // the hint rather than wrapping the controls under it.
    const used = pane.controls.reduce((sum, item) =>
      sum + item.label.length + (item.hotkey ? 3 : 0), 0) + 3 * (pane.controls.length - 1);
    const hint = pane.hint && used + 3 + pane.hint.length <= pane.width ? pane.hint : null;
    parts.push(box({ flexDirection: "row", gap: 3 }, [
      ...pane.controls.map((item) => control(item,
        { dimColor: true, ...(item.hotkey ? { plain: true as const } : {}) })),
      ...(hint ? [text({ dimColor: true, italic: true }, hint)] : []),
    ]));
  }
  // A narrowed pane says so, with the press that widens it again: the figures
  // above still count the whole machine, and a person who forgot the press
  // would read a filtered list as a quiet fleet.
  if (pane.focus) {
    parts.push(box({ flexDirection: "row", gap: 2 }, [
      text({ dimColor: true }, pane.focus.text),
      control(pane.focus.clear,
              { plain: true, dimColor: true, hover: { color: "claude" } },
              [text({ dimColor: true, italic: true }, pane.focus.clear.label)]),
    ]));
  }
  // What happened while the person was away heads the sections, since it is
  // the first thing a person coming back wants, and it is gone when nothing is.
  if (pane.digest) {
    parts.push(digestBlock(pane.digest, pane.width));
  }
  // One empty row between the head and the first card, and no more.
  parts.push(box({ flexDirection: "column", gap: 0, marginBottom: 1 }, []));
  for (const group of pane.groups) {
    parts.push(renderGroup(group, pane.width, pane.narrowAt));
  }
  // The footer is the pane's one line of identity, under everything it reports:
  // a person reading a screenshot or quoting a version in a report takes it
  // from here, not from a header that competes with the counts.
  if (pane.footer) {
    parts.push(box({ flexDirection: "row", marginTop: 1 }, [
      text({ dimColor: true }, fit(pane.footer.text, pane.width)),
    ]));
  }
  return box({ flexDirection: "column", gap: 0 }, parts);
}

/** Every element type a tree uses, so a test can prove only Box and Text appear. */
export function elementTypes(tree: Tree): string[] {
  const found = new Set<string>();
  const walk = (node: Node | string): void => {
    if (typeof node === "string") {
      return;
    }
    found.add(node.type);
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(tree);
  return [...found].sort();
}

/** The plain strings a tree holds, in order, for asserting what a person reads. */
/**
 * Whether a node is a row's hover card.
 *
 * A card is out of the flow and hidden at rest, so it takes no cells and draws
 * nothing until the pointer is on the row it belongs to. Anything measuring
 * what a row draws leaves it out.
 */
export function isHoverCard(node: Node): boolean {
  const props = node.props as { display?: unknown; position?: unknown };
  return props.display === "none" && props.position === "absolute";
}

export function renderedText(tree: Tree): string[] {
  const values: string[] = [];
  const walk = (node: Node | string): void => {
    if (typeof node === "string") {
      values.push(node);
      return;
    }
    // A card held out of the flow and hidden is not part of what the pane
    // draws: it is drawn only while the pointer is on the row it belongs to,
    // and it repeats words that row already shows. A hidden line still in the
    // flow is drawn here, because hovering reveals it in the row's own place.
    if (isHoverCard(node)) {
      return;
    }
    // A button draws its label, and a label is text on the screen like any
    // other. A check that reads what a tree shows has to see it, or every
    // section heading would read as missing the moment it became pressable.
    const label = (node.props as { label?: unknown }).label;
    if (node.type === "Button" && typeof label === "string") {
      values.push(label);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(tree);
  return values;
}
