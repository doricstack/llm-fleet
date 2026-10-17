/**
 * The host elements this layout may use, declared as a narrow local subset.
 *
 * The engine ships a generated declaration describing its whole surface. This
 * file declares only the elements and the props this layout writes, so the
 * published tree carries a contract a person can read rather than a copy of
 * someone else's generated file. Packaging maps these declarations onto the
 * engine's own elements; the check in `make components-drift` fails when the
 * engine stops declaring a prop named here.
 *
 * Box owns flow, spacing and the right slot. Text owns titles, metadata, state
 * labels and the cells of the slim bar. Button owns the things a person can
 * press: a section that folds, the two that fold every section at once, and a
 * row title that copies what the row offers. Link owns a page a title names,
 * and Input owns the reply a waiting job is sent, where the surface draws one.
 *
 * Svg is the one element not every surface has: the desktop, the editor and the
 * phone draw it, and the terminal does not. The layout never asks for it. A bar,
 * a strip or a tile carries a drawing of itself beside its cells, and the mount
 * draws that instead of the cells where the surface's table holds an Svg, so the
 * same view model is a run of half-height glyphs in a terminal and a vector
 * shape on the desktop. Nothing here draws a raster: that is the terminal's alone.
 */

/** A color token, named by the theme rather than by a literal value. */
export type Color =
  | "text" | "subtle" | "inactive" | "success" | "error" | "warning"
  | "merged" | "claude" | "suggestion" | "planMode" | "promptBorder" | "bashBorder"
  /** The theme's soft red, the fill a removed line is drawn on: a failing row's shade. */
  | "diffRemovedDimmed"
  /** The theme's soft green, the fill an added line is drawn on: an arriving row's tint. */
  | "diffAddedDimmed"
  /** The text color drawn on a filled chip, which the theme keeps legible on any fill. */
  | "inverseText";

/**
 * What a box changes while the pointer is over it.
 *
 * The surface applies these itself, with no hook run and nothing crossing to
 * the plugin, so a card that brightens or a hint that shows on hover costs the
 * pane no paint. None of them moves a sibling except `display`, which is how a
 * line hidden at rest is shown.
 */
export type BoxHoverProps = {
  borderColor?: Color;
  borderDimColor?: boolean;
  backgroundColor?: Color;
  display?: "flex";
};

/** What a text changes while the pointer is over the keyed box around it. */
export type TextHoverProps = {
  color?: Color;
  backgroundColor?: Color;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

export type BoxProps = {
  /**
   * The box's address, which makes it a hover scope: while the pointer is over
   * it, its own `hover` and that of everything beneath it apply.
   */
  key?: string;
  /** What the surface draws differently while the pointer is over this box. */
  hover?: BoxHoverProps;
  /** `none` draws nothing at rest, which a hover may turn back to `flex`. */
  display?: "flex" | "none";
  /**
   * How the box is placed among its siblings.
   *
   * `absolute` takes it out of the flow and places it against its parent, which
   * is what lets a hidden box be revealed over the content rather than beside
   * it: nothing moves when it appears, and it costs no room while it is hidden.
   */
  position?: "relative" | "absolute";
  /** Where an absolute box sits against its parent: cells right and down. */
  top?: number;
  left?: number;
  /** The direction children flow in. A column is the default reading order. */
  flexDirection?: "row" | "column";
  /** Space between children, or between them along one axis only. */
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  /** A fixed width, or the minimum width this box will take. */
  width?: number;
  minWidth?: number;
  /** How this box shares spare width with its siblings. */
  flexGrow?: number;
  flexShrink?: number;
  /** How children are placed along the flow axis and across it. */
  justifyContent?: "flex-start" | "flex-end" | "center" | "space-between";
  alignItems?: "flex-start" | "flex-end" | "center";
  /** Space inside the box, in cells. */
  paddingX?: number;
  paddingY?: number;
  /** Space outside it, which is what separates one card from the next. */
  marginTop?: number;
  marginBottom?: number;
  marginX?: number;
  marginLeft?: number;
  marginRight?: number;
  /**
   * The box's rule, drawn by the surface.
   *
   * A card is a bordered box, which is what makes a run of sections read as
   * tiles rather than as a list of headings: the drawing is the surface's, so
   * the same tree is a boxed card on the desktop and a boxed card in a
   * terminal.
   */
  borderStyle?: "round" | "single" | "bold" | "double";
  borderColor?: Color;
  borderDimColor?: boolean;
  /** Fills the box, which is how a bar or a pressed control reads as a block. */
  backgroundColor?: Color;
};

export type TextProps = {
  /** A declared token, never a raw value. */
  color?: Color;
  /** Fills the cells this text occupies, which is how a bar is drawn solid. */
  backgroundColor?: Color;
  /** For idle and historical metadata: quieter than any token. */
  dimColor?: boolean;
  bold?: boolean;
  /** For what a row says in its own words, such as the question it waits on. */
  italic?: boolean;
  /** What the surface draws differently while the pointer is over the box around it. */
  hover?: TextHoverProps;
  /** How a value too long for its line is continued. */
  wrap?: "wrap" | "truncate-end" | "truncate-start" | "truncate-middle";
};

/**
 * The one element a person can act on.
 *
 * `key` is the element's address: it is what `ui.press` carries as `e.element`,
 * and what the entry matches on to know which section was folded. `hotkey` is
 * one digit or one lowercase letter, pressed while the pane holds the focus,
 * which is why the layout gives each button a different one.
 */
export type ButtonProps = {
  /** The element's address, and what a press handler matches on. */
  key: string;
  /** What the button draws; a section's heading, or "Collapse all". */
  label: string;
  /**
   * What a press does. The host runs this in the plugin's own environment, so
   * it is how the pane hears about a press at all: a button drawn without one
   * is refused rather than drawn inert, which is why this is required here as
   * it is required by the engine.
   */
  onPress: () => void;
  /** One digit or one lowercase letter that presses it. */
  hotkey?: string;
  /**
   * Drawn quieter than the text around it.
   *
   * The engine's button carries no `bold` and no `color`: its weight and its
   * color are the surface's, and a layout that named one would drift.
   */
  dimColor?: boolean;
  /**
   * Drawn without the bracket chrome: the hotkey in the accent color, a colon,
   * then the label, which is how the host's own shortcut rows read.
   */
  plain?: true;
  /**
   * Which of several buttons is the main action: a primary one is drawn in the
   * accent color, as the surface marks the one to press.
   */
  variant?: "primary" | "secondary";
  /**
   * The label's look while the pointer is over the keyed box around it: a row
   * title that copies something lights as the host lights a row under its cursor.
   */
  hover?: TextHoverProps;
};

/**
 * A hyperlink: an OSC 8 span on the terminal, an anchor on the desktop.
 *
 * Inline, like a text: its children are what it reads as. What a click opens is
 * the surface's, so a pull request's title is a link to its page and the pane
 * runs nothing for it.
 */
export type LinkProps = {
  /** Where it goes, as written. */
  href: string;
  /** What it reads as when it holds no children. */
  label?: string;
};

/**
 * A text field, on the surfaces that draw one: the terminal, the desktop and
 * the editor. The phone draws none, so the layout asks for a field only where
 * the mount bound one, and offers a press instead everywhere else.
 */
export type InputProps = {
  /** The field's address, which a test types into and a matcher names. */
  key: string;
  /** Drawn before the field. */
  label?: string;
  /** Drawn dim while the field is empty. */
  placeholder?: string;
  /** What Enter does, drawn beside the field while it has the focus. */
  submitLabel?: string;
  /** What Enter does, run by the host in the plugin's own environment. */
  onSubmit: (value: string) => void;
};

/**
 * The props of the remote surfaces' vector leaf.
 *
 * The markup is the element's data and is drawn isolated, as an image: no theme
 * key reaches it, so the drawing carries its own colors. `alt` is required by
 * the engine, and it is what a surface without the element, or a reader that
 * cannot see it, gets instead.
 */
export type SvgProps = {
  /** The SVG document, at most 131072 characters. */
  source: string;
  /** What the drawing says, in words. */
  alt: string;
  /** CSS pixels; absent, the markup's own width up to the slot. */
  width?: number;
  /** CSS pixels; absent, the markup's own height at the drawn width. */
  height?: number;
};

/**
 * A drawing of a node, for a surface that draws vectors.
 *
 * `cells` is how many cells the node takes on a terminal, which is the slot the
 * drawing is given on the desktop: the same view model lays out the same way on
 * both, and only what fills the slot differs.
 */
export type Vector = {
  source: string;
  alt: string;
  cells: number;
};

/** A node of the rendered tree, as a host would build it. */
export type Node = {
  type: "Box" | "Text" | "Button" | "Svg" | "Link" | "Input";
  props: BoxProps | TextProps | SvgProps | LinkProps | InputProps
    | (ButtonProps & { children?: (Node | string)[] });
  children: (Node | string)[];
  /**
   * The node drawn as a vector, for a surface that has one. Never a prop: the
   * mount reads it and hands the surface either this or the node, not both.
   */
  vector?: Vector;
};

/**
 * The host's element constructors, narrowed to the subset above.
 *
 * A local declaration is a subset of the host's props, so the host's own
 * constructor is assignable to this type without a cast; only the boundary that
 * receives the resolved elements needs one, and that boundary is where the
 * drift check applies.
 */
export type ElementConstructor<P> = (props: P) => Node;

export type Primitives = {
  Box: ElementConstructor<BoxProps & { children?: (Node | string)[] }>;
  Text: ElementConstructor<TextProps & { children?: (Node | string)[] }>;
  Button: ElementConstructor<ButtonProps & { children?: (Node | string)[] }>;
  /** Present only where the surface draws vectors: never on the terminal. */
  Svg?: ElementConstructor<SvgProps>;
  /** Every surface draws a link; absent from a recording that asked for none. */
  Link?: ElementConstructor<LinkProps & { children?: (Node | string)[] }>;
  /** Present only where the surface draws a text field: never on the phone. */
  Input?: ElementConstructor<InputProps>;
};

/** A layout tree, built without a host, so a test can read its structure. */
export type Tree = Node;
