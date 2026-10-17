/**
 * The pane's shapes as vectors: a bar, a strip of hours, a tile.
 *
 * A terminal draws these out of half-height glyphs in theme colors, and that is
 * the right drawing there. A desktop draws text in its own fonts, where a run of
 * block characters is a dotted line rather than a bar, so a surface that draws
 * vectors gets the same shape as markup instead. Each function here takes what
 * the cell drawing was built from, never the cells themselves, so the two
 * drawings cannot say different things.
 *
 * The markup is drawn isolated, as an image, and no theme key reaches it. The
 * colors are written in, a pair per token, one for a light page and one for a
 * dark one, picked by the page's color scheme. They are chosen to read on either
 * page, not copied from the host's themes, so a person's own theme colors the
 * text around a bar and not the bar.
 *
 * Every drawing is sized in cells the way the terminal lays it out, at a cell
 * wider than any code font draws one, so the surface scales it down to the slot
 * the layout gave it rather than leaving it short of that slot.
 */

import type { Color, Vector } from "./host.ts";

/** Pixels a cell is drawn at in the markup: wider than a code font's advance. */
export const CELL_PIXELS = 10;

/** A bar's height in the markup, and the stroke of its track inside that. */
const BAR_HEIGHT = 8;
const BAR_STROKE = 5;

/** A strip block's height in the markup: taller than a bar, as a strip is read block by block. */
const STRIP_HEIGHT = 12;

/**
 * A tile's height in the markup: the four rows a bordered tile takes. Its text is
 * set larger than the page's because the surface scales the drawing down by the
 * ratio of a code font's cell to this file's, about four fifths.
 */
const TILE_HEIGHT = 62;

/** The light and dark color for each token a drawing can be asked for. */
const PALETTE: Record<Color, [string, string]> = {
  text: ["#1f1f1f", "#ececec"],
  inverseText: ["#ffffff", "#1f1f1f"],
  subtle: ["#8a8a8a", "#8a8a8a"],
  inactive: ["#8a8a8a", "#9a9a9a"],
  success: ["#2c7a39", "#4eba65"],
  error: ["#ab2b3f", "#ff6b80"],
  warning: ["#966c1e", "#ffc107"],
  merged: ["#8700ff", "#af87ff"],
  claude: ["#c2643f", "#d77757"],
  suggestion: ["#5769f7", "#b1b9f9"],
  planMode: ["#006666", "#48968c"],
  promptBorder: ["#999999", "#888888"],
  bashBorder: ["#d6006f", "#fd5db1"],
  diffRemovedDimmed: ["#fbd5da", "#4a2a2e"],
  diffAddedDimmed: ["#cfe8d3", "#2b4330"],
};

/** The dark page's half of a drawing's style, which starts here. */
const DARK_SCHEME = "@media (prefers-color-scheme: dark){";

/** The class a token's fill is drawn with. */
function fillClass(color: Color): string {
  return "f-" + color;
}

/**
 * The style block for the tokens one drawing uses, and the track and rule every
 * drawing may use: written per drawing so the markup carries only what it draws.
 */
function style(colors: Color[]): string {
  const used = [...new Set(colors)];
  const light = used.map((color) => `.${fillClass(color)}{fill:${PALETTE[color][0]}}`).join("");
  const dark = used.map((color) => `.${fillClass(color)}{fill:${PALETTE[color][1]}}`).join("");
  return "<style>"
    + light
    + ".track{fill:#000000;fill-opacity:.1}"
    + ".rule{fill:#000000;fill-opacity:.03;stroke:#000000;stroke-opacity:.18}"
    + ".muted{fill:#6b6b6b}"
    + DARK_SCHEME
    + dark
    + ".track{fill:#ffffff;fill-opacity:.16}"
    + ".rule{fill:#ffffff;fill-opacity:.04;stroke:#ffffff;stroke-opacity:.2}"
    + ".muted{fill:#a0a0a0}"
    + "}</style>";
}

/**
 * A drawing's markup with each token's fill written as another token's.
 *
 * Only the style block `style` wrote is touched: each `.f-<token>{fill:...}` rule
 * takes the light fill of the token `swap` names before the dark-scheme block,
 * and its dark fill inside it. The classes on the shapes stay as they were, so
 * the drawing keeps saying which state each shape is; only how it looks moves.
 *
 * A tile's outline is the `.rule` stroke, a neutral the terminal draws in the
 * quiet token: when the theme moves that token, the outline is drawn in the
 * token it moved to, so a tile's border on the desktop follows the terminal's.
 */
export function restyle(source: string, swap: (token: Color) => Color): string {
  const fill = (scheme: 0 | 1) => (rule: string, token: string): string => {
    if (!(token in PALETTE)) {
      return rule;
    }
    return `.${fillClass(token as Color)}{fill:${PALETTE[swap(token as Color)][scheme]}}`;
  };
  const quiet = swap("subtle");
  const outline = (scheme: 0 | 1) => (rule: string, before: string): string =>
    quiet === "subtle" ? rule : `.rule{${before}stroke:${PALETTE[quiet][scheme]};stroke-opacity:1}`;
  const fills = /\.f-([A-Za-z]+)\{fill:#[0-9a-fA-F]{3,8}\}/g;
  const outlines = /\.rule\{([^}]*?)stroke:#[0-9a-fA-F]{3,8};stroke-opacity:[.0-9]+\}/g;
  const scheme = (part: string, which: 0 | 1): string =>
    part.replace(fills, fill(which)).replace(outlines, outline(which));
  const split = source.indexOf(DARK_SCHEME);
  if (split === -1) {
    return scheme(source, 0);
  }
  return scheme(source.slice(0, split), 0) + scheme(source.slice(split), 1);
}

/** Text placed in markup, so a title holding `<` or `&` is drawn rather than parsed. */
export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The document around a drawing, at its own size in markup pixels. */
function svg(width: number, height: number, colors: Color[], body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}">${style(colors)}${body}</svg>`;
}

/** A number as markup writes it: no float noise a reader of the source trips on. */
function px(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * A rate bar: the track across the slot and the done share filled over it.
 *
 * The share is the exact proportion, not the cells the terminal rounds it to:
 * a vector has no cell to round to. The callers have already refused a bar with
 * no denominator or with impossible counts, and so does this, by returning
 * nothing, because a drawing of one is the claim those refusals exist to stop.
 */
export function barVector(done: number, total: number, color: Color, cells: number): Vector | null {
  if (!(total > 0) || !Number.isFinite(done) || !Number.isFinite(total)
      || done < 0 || done > total || cells < 1) {
    return null;
  }
  const width = cells * CELL_PIXELS;
  const top = (BAR_HEIGHT - BAR_STROKE) / 2;
  const radius = BAR_STROKE / 2;
  const filled = width * (done / total);
  const track = `<rect class="track" x="0" y="${px(top)}" width="${width}" `
    + `height="${BAR_STROKE}" rx="${px(radius)}"/>`;
  const fill = filled > 0
    ? `<rect class="${fillClass(color)}" x="0" y="${px(top)}" width="${px(filled)}" `
      + `height="${BAR_STROKE}" rx="${px(radius)}"/>`
    : "";
  return {
    source: svg(width, BAR_HEIGHT, [color], track + fill),
    alt: `${done} of ${total}`,
    cells,
  };
}

/** One bucket of a strip: how many things landed in it and how many failed. */
export type StripCell = { outcomes: number; failed: number };

/**
 * A strip of the recent past, one rounded block per bucket, oldest first.
 *
 * A bucket nobody tried anything in is track, one that held a failure is the
 * error color, and the rest are the success color: the same alphabet the
 * terminal strip uses, for the same reason, that an empty hour is not a good one.
 */
export function stripVector(cells: StripCell[], alt: string): Vector | null {
  if (!cells.length) {
    return null;
  }
  const width = cells.length * CELL_PIXELS;
  const gap = 2;
  const used: Color[] = [];
  const blocks = cells.map((cell, index) => {
    const tone: Color | null = cell.outcomes === 0 ? null : cell.failed > 0 ? "error" : "success";
    if (tone) {
      used.push(tone);
    }
    return `<rect class="${tone ? fillClass(tone) : "track"}" x="${index * CELL_PIXELS}" y="0" `
      + `width="${CELL_PIXELS - gap}" height="${STRIP_HEIGHT}" rx="2"/>`;
  }).join("");
  return { source: svg(width, STRIP_HEIGHT, used, blocks), alt, cells: cells.length };
}

/** The inset of a tile's words from its edges, in markup pixels. */
const TILE_INSET = 12;

/**
 * The widest a character of a tile's label and of its value is drawn, in markup
 * pixels: a sans face's widest common glyphs at 14 px and at 19 px semibold. Cut
 * by this, a word never reaches the card's edge, where the drawing would clip
 * its end and the truncation mark with it.
 */
const LABEL_CHAR_PIXELS = 8.5;
const VALUE_CHAR_PIXELS = 12;

/** The mark a cut word ends with, as the layout writes it. */
const CUT = "...";

/** A word cut to a number of characters, the cut marked so a reader knows. */
export function cutTo(value: string, chars: number): string {
  if (value.length <= chars) {
    return value;
  }
  if (chars <= CUT.length) {
    return value.slice(0, Math.max(0, chars));
  }
  return value.slice(0, chars - CUT.length) + CUT;
}

/**
 * A tile: a rounded card holding a figure's label and its value.
 *
 * The words come in whole and are cut here by the room they take in the
 * drawing, which is not the room they take in cells: a figure set large in a
 * proportional face is wider than the same figure in a code font. The alt says
 * both whole, since it has no width to keep to.
 */
export function tileVector(label: string, value: string, color: Color, cells: number): Vector {
  const width = Math.max(1, cells) * CELL_PIXELS;
  const room = Math.max(0, width - 2 * TILE_INSET);
  const font = "font-family=\"ui-sans-serif,system-ui,-apple-system,sans-serif\"";
  const shownLabel = cutTo(label, Math.floor(room / LABEL_CHAR_PIXELS));
  const shownValue = cutTo(value, Math.floor(room / VALUE_CHAR_PIXELS));
  const body = `<rect class="rule" x="0.5" y="0.5" width="${width - 1}" `
    + `height="${TILE_HEIGHT - 1}" rx="7"/>`
    + `<text class="muted" x="${TILE_INSET}" y="25" font-size="14" ${font}>`
    + `${escapeXml(shownLabel)}</text>`
    + `<text class="${fillClass(color)}" x="${TILE_INSET}" y="49" font-size="19" font-weight="600" `
    + `${font}>${escapeXml(shownValue)}</text>`;
  return { source: svg(width, TILE_HEIGHT, [color], body), alt: `${label}: ${value}`, cells };
}
