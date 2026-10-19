/**
 * Render a pane as text, for review outside a terminal.
 *
 * The repository has no terminal to draw in, so this walks the same tree the
 * layout builds and prints it, which is how a change to the pane can be read and
 * argued with before anything mounts it. It reads a snapshot on standard input
 * and writes the pane to standard output.
 *
 *   python3 plugins/fleet/readers/snapshot.py | node plugins/fleet/components/review.ts
 *
 * It is a review tool, not a renderer: it makes no decision the layout has not
 * already made, and where it has to choose it chooses the plainest thing that
 * keeps a reading legible.
 */

import type { Node, Vector } from "../plugins/fleet/components/host.ts";
import { fit, renderPane } from "../plugins/fleet/components/layout.ts";
import { paneConfigFrom, paneOptions } from "../plugins/fleet/components/options.ts";
import { recolor, THEME } from "../plugins/fleet/components/palette.ts";
import { paneFrom } from "../plugins/fleet/components/pane.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/fleet/components/snapshot.ts";

export const DEFAULT_WIDTH = 100;
export { paneOptions };

/**
 * The corner and edge marks this renderer draws a card with.
 *
 * The surface owns the rule a card is actually drawn with, and this is a text
 * stand-in for it: the marks are the rounded corners a `borderStyle: "round"`
 * card is drawn with, written once here so the page has one definition of them.
 * A case that asserts these marks proves the page draws a rule from that one
 * definition; it cannot prove the surface draws the same one, and it does not
 * claim to.
 */
const BORDER = { topLeft: "╭", topRight: "╮", bottomLeft: "╰",
                 bottomRight: "╯", horizontal: "─", vertical: "│" };

/**
 * A bordered box, drawn as one.
 *
 * The surface draws a card's rule around its contents, so a review that printed
 * the contents alone would be reviewing a pane nobody has: the cards are most of
 * what makes a section read as a section. The box spans the width it is given
 * unless it was given one of its own, which is what a row of stat cards relies
 * on.
 */
function bordered(inner: string[], width: number, boxWidth: number | undefined): string[] {
  const content = inner.map((line) => line.replace(/\s+$/, ""));
  const widest = content.reduce((most, line) => Math.max(most, line.length), 0);
  const outer = Math.max(4, boxWidth ?? width);
  const room = Math.max(1, outer - 4);
  const mid = content.map((line) => {
    const value = line.length > room ? fit(line, room) : line;
    return `${BORDER.vertical} ${value}${" ".repeat(room - value.length)} ${BORDER.vertical}`;
  });
  const bar = BORDER.horizontal.repeat(outer - 2);
  return [`${BORDER.topLeft}${bar}${BORDER.topRight}`, ...mid,
          `${BORDER.bottomLeft}${bar}${BORDER.bottomRight}`];
}

/**
 * One node as lines at a width.
 *
 * A row box holds segments that belong on one line; everything else stacks, and
 * a widening line is indented so the tree reads as a tree. A bordered box is
 * drawn with its rule, because a card that printed without one would be a review
 * of something nobody sees.
 */
export function nodeLines(node: Node | string, width: number,
                          indentChildren = true): string[] {
  if (typeof node === "string") {
    return [node];
  }
  if (node.type === "Text") {
    return [String(node.children[0] ?? "")];
  }
  if (node.type === "Button") {
    // A button draws its label. Its children are the words the surface draws
    // inside the press, and reading them as well prints a row that carries both
    // twice; a figure's number is in its label for exactly this reason.
    const label = (node.props as { label?: unknown }).label;
    return [typeof label === "string" ? label : ""];
  }
  const props = node.props as { flexDirection?: string; justifyContent?: string;
                                borderStyle?: string; width?: number };
  const children = node.children;
  if (props.flexDirection === "row" && props.justifyContent === "space-between") {
    const left = children[0];
    const right = children[1];
    const leftText = left === undefined ? "" : nodeLines(left, width).join(" ");
    const rightText = right === undefined ? "" : nodeLines(right, width).join(" ");
    const gap = Math.max(1, width - leftText.length - rightText.length);
    return [leftText + " ".repeat(gap) + rightText];
  }
  if (props.flexDirection === "row") {
    // Side by side, line by line, with the gap the box asked for between them:
    // cards are laid beside each other rather than run together into one line,
    // and a row whose children name their own spacing keeps it.
    const gap = typeof (props as { gap?: number }).gap === "number"
      ? (props as { gap?: number }).gap as number : 0;
    const separator = " ".repeat(gap);
    const rendered: string[][] = [];
    const after: string[] = [];
    let remaining = width;
    for (const child of children) {
      const lines = child === undefined ? [""] : nodeLines(child, Math.max(8, remaining));
      rendered.push(lines);
      const widest = lines.reduce((most, line) => Math.max(most, line.length), 0);
      // A card's own margin is the room it keeps beside itself, which is what
      // stops a row of them from touching.
      const margin = typeof child === "object" && child !== null
        ? ((child.props as { marginRight?: number }).marginRight ?? 0) : 0;
      after.push(" ".repeat(margin));
      remaining -= widest + gap + margin;
    }
    const rows = rendered.reduce((most, lines) => Math.max(most, lines.length), 0);
    const out: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      out.push(rendered.map((lines, index) =>
        (lines[row] ?? "") + (row === 0 || after[index] ? after[index] : "")).join(separator));
    }
    return out;
  }
  // A card's rule takes two columns at each edge, so what it holds is laid out
  // in the room left inside it. Squeezing already-drawn lines into that room
  // instead is how a heading's own count gets cut off.
  const outer = Math.max(4, props.width ?? width);
  // A box indents what it holds, so it lays those out two columns narrower and
  // spends the two on the indent. The exception is the box that is the page
  // itself: nothing is nested inside it, so its children are the page's lines
  // and are laid out at the page's width.
  const room = props.borderStyle ? outer - 4
    : indentChildren ? Math.max(8, width - 2) : Math.max(8, width);
  const lines: string[] = [];
  for (const child of children) {
    if (child === undefined) {
      continue;
    }
    if (typeof child === "string") {
      lines.push(child);
      continue;
    }
    // A nested box is indented under what it belongs to, unless the box it sits
    // in draws a rule of its own: a card's contents are already held between its
    // edges, and indenting those again would spend columns saying it twice.
    const inner = nodeLines(child, room);
    lines.push(...(props.borderStyle || !indentChildren
      ? inner : inner.map((line) => "  " + line)));
  }
  if (props.borderStyle) {
    return bordered(lines, outer, outer);
  }
  return lines;
}

type Sections = Record<string, { visible: boolean; collapsed: boolean }>;

/** The tree the pane builds from a reading, at a width. */
function paneTree(documents: ReaderDocuments, width: number, now: number, generatedAt: number,
                  sections?: Sections): Node {
  // The pane draws on the configuration its reading carried, which is what the
  // read command printed. A caller may override a section to print the pane as
  // it would look after a press; without one, what is printed here is what the
  // pane would actually draw, rather than the packaged default standing in for
  // a choice somebody made.
  // A page keeps no last look, so its digest is the one a first look draws:
  // the newest events the reading holds.
  const base = { ...paneOptions(width, now, paneConfigFrom(documents)), lastSeen: null };
  const options = sections === undefined
    ? base
    : { ...base, sections: { ...base.sections, ...sections } };
  // Drawn in the reading's theme as the live pane is, so a review page shows the
  // colors a person configured and not the packaged ones.
  return recolor(renderPane(paneFrom(snapshotFrom(documents, generatedAt), options)), options.theme ?? THEME);
}

export function renderText(documents: ReaderDocuments, width: number, now: number,
                           generatedAt: number, sections?: Sections): string {
  // The pane's own box is the page, so it is the one box whose children are not
  // indented. Indenting them pushed every line two columns past the width the
  // page was asked for, which is how a bar came to be drawn cut.
  return nodeLines(paneTree(documents, width, now, generatedAt, sections), width, false)
    .join("\n");
}

/** Every drawing in a tree, in the order the tree holds them. */
export function vectorsOf(node: Node | string): Vector[] {
  if (typeof node === "string") {
    return [];
  }
  if (node.vector) {
    return [node.vector];
  }
  return node.children.flatMap(vectorsOf);
}

/**
 * The drawings a surface that draws vectors would put where the text pane has
 * glyphs: the same tree, so the same rows, from the same reading.
 */
export function renderVectors(documents: ReaderDocuments, width: number, now: number,
                              generatedAt: number, sections?: Sections): Vector[] {
  return vectorsOf(paneTree(documents, width, now, generatedAt, sections));
}

/** What standard input holds: the snapshot the read command printed. */
type SnapshotInput = ReaderDocuments & { generated_at?: number };

export function documentsOf(input: unknown): { documents: ReaderDocuments; generatedAt: number } {
  // A snapshot is an object of documents. A list or a scalar is not one, and
  // treating it as one would render a pane of empty sections as if it were a read.
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("the read command printed something that is not an object");
  }
  const record = input as SnapshotInput;
  const generatedAt = typeof record.generated_at === "number" ? record.generated_at : Date.now() / 1000;
  return { documents: record, generatedAt };
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  // The width comes from the caller as an argument: no setting is read from the
  // environment here, so a review run depends on nothing but its own inputs.
  const width = Number(process.argv[2] ?? DEFAULT_WIDTH) || DEFAULT_WIDTH;
  const text = await readStandardInput();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stderr.write("the read command's output was not JSON\n");
    return 1;
  }
  if (typeof parsed === "object" && parsed !== null && "configErrors" in parsed) {
    const errors = (parsed as { configErrors: { code: string; path: string }[] }).configErrors;
    process.stdout.write("The configuration was refused:\n");
    for (const entry of errors) {
      process.stdout.write("  " + entry.code + " " + entry.path + "\n");
    }
    return 2;
  }
  const { documents, generatedAt } = documentsOf(parsed);
  // Asked for the drawings, it prints them as one JSON list instead of the text.
  if (process.argv[3] === "--vectors") {
    process.stdout.write(JSON.stringify(renderVectors(documents, width, generatedAt, generatedAt))
                         + "\n");
    return 0;
  }
  process.stdout.write(renderText(documents, width, generatedAt, generatedAt) + "\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
