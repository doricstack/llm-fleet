/**
 * The one place the layout touches a host.
 *
 * The layout builds plain nodes; this module turns them into the host's own
 * elements. Keeping the boundary to one function means the layout tests need no
 * host at all, and the only cast in the tree lives here, next to the drift check
 * that fails when the host stops declaring a prop the layout writes. It is also
 * the one place a surface's vectors are chosen over its cells.
 */

import type { BoxProps, ButtonProps, InputProps, LinkProps, Node, Primitives, SvgProps,
              TextProps } from "./host.ts";

/** The engine's resolved elements, as the host hands them over at mount. */
export type HostElements = {
  Box: unknown;
  Text: unknown;
  Button: unknown;
  /** Only a surface that draws vectors hands one over. */
  Svg?: unknown;
  Link?: unknown;
  Input?: unknown;
};

/** The props of a node a drawing keeps: its address and its place, never its look. */
const PLACEMENT = ["key", "hover", "display", "marginTop", "marginBottom", "marginX", "marginLeft",
                   "marginRight"] as const;

/** The surfaces whose own table draws an Svg: every one but the terminal. */
const VECTOR_SURFACES = new Set(["desktop", "vscode", "mobile"]);

/**
 * The surfaces whose own table draws a text field: every one but the phone,
 * which the engine documents as drawing no field yet. Bound by name for the
 * reason the Svg is: a completed table hands the phone an Input that draws
 * nothing, and a reply field drawn as nothing is a reply nobody can send.
 */
const FIELD_SURFACES = new Set(["terminal", "desktop", "vscode"]);

/** Whether a surface draws a text field, so the pane offers one only where it does. */
export function drawsFields(surface: string): boolean {
  return FIELD_SURFACES.has(surface);
}

/**
 * The surfaces that draw a `plain` Button as the pane means it: as words among
 * the row, not as a filled control.
 *
 * The VS Code extension ignores `plain` and draws every Button as a filled
 * block at the width its parent gives it. In a row of actions that is a wall of
 * solid buttons, which is what a person sees instead of the pane's own words.
 */
const PLAIN_SURFACES = new Set(["terminal", "desktop", "mobile"]);

function plainButtons(surface: string): boolean {
  return PLAIN_SURFACES.has(surface);
}

/** How many cells the words of a button take: its label, or its children. */
function cellsOf(children: unknown[], label: string): number {
  const text = (child: unknown): number => {
    if (typeof child === "string") {
      return child.length;
    }
    if (child === null || typeof child !== "object") {
      return 0;
    }
    const node = child as { children?: unknown[]; props?: { label?: unknown } };
    const own = typeof node.props?.label === "string" ? node.props.label.length : 0;
    const inner = (node.children ?? []).reduce<number>((sum, one) => sum + text(one), 0);
    return Math.max(own, inner);
  };
  return Math.max(label.length, children.reduce<number>((sum, one) => sum + text(one), 0));
}

/**
 * A Button bound for a surface that fills every button, kept to the width its
 * own words take. The press stays a press; only the box around it is bounded.
 */
function pressedInline(button: unknown, box: unknown): Primitives["Button"] {
  const make = button as (props: unknown) => unknown;
  const wrap = box as (props: unknown) => unknown;
  return ((props: { label?: string; children?: unknown[] }) => {
    const label = typeof props.label === "string" ? props.label : "";
    const children = props.children ?? [];
    const drawn = make({ ...props, children });
    return wrap({ width: cellsOf(children, label) + 2, flexShrink: 0, children: [drawn] });
  }) as Primitives["Button"];
}

/**
 * The host's elements, declared as the narrow subset the layout uses.
 *
 * The host passes the elements it resolved for its own surface. Every surface
 * declares Box, Text and Button with the same props, so one binding serves them
 * all; `make components-drift` reads the engine's declaration and fails if any
 * stops carrying a prop named in host.ts.
 *
 * The Svg is bound by the surface's name, not by whether the table holds one:
 * the engine completes every table it hands out with every element name, and a
 * name the surface does not draw draws an empty fragment. Binding the terminal's
 * Svg would replace each bar and tile with nothing.
 */
export function bindPrimitives(elements: HostElements, surface: string): Primitives {
  return {
    Box: elements.Box as Primitives["Box"],
    Text: elements.Text as Primitives["Text"],
    Button: plainButtons(surface)
      ? elements.Button as Primitives["Button"]
      : pressedInline(elements.Button, elements.Box),
    ...(VECTOR_SURFACES.has(surface) && elements.Svg
      ? { Svg: elements.Svg as Primitives["Svg"] } : {}),
    // Every surface draws a link, so one is bound wherever the table holds it.
    ...(elements.Link ? { Link: elements.Link as Primitives["Link"] } : {}),
    ...(FIELD_SURFACES.has(surface) && elements.Input
      ? { Input: elements.Input as Primitives["Input"] } : {}),
  };
}

/**
 * Build the host's element for one node, and for everything under it.
 *
 * The host's element returns whatever that surface returns, so the mounted
 * result is opaque here on purpose: this function's job is handing the tree
 * over, not describing what the surface does with it.
 */
export function mount(tree: Node, primitives: Primitives): unknown {
  // A node with a drawing of itself is drawn as that drawing where the surface
  // draws vectors, in the slot its cells take: the box keeps the layout's width
  // and the drawing scales down into it. Everywhere else the cells are drawn.
  if (tree.vector && primitives.Svg) {
    const svg: SvgProps = { source: tree.vector.source, alt: tree.vector.alt };
    // What places the node among its siblings, and what addresses it, goes with
    // the drawing: a key or a hover lost here would be lost on the desktop alone.
    const placed: BoxProps = {};
    const props = tree.props as BoxProps;
    for (const name of PLACEMENT) {
      if (props[name] !== undefined) {
        (placed as Record<string, unknown>)[name] = props[name];
      }
    }
    return primitives.Box({ ...placed, width: tree.vector.cells, flexShrink: 0,
                            children: [primitives.Svg(svg) as Node] });
  }
  if (tree.type === "Input") {
    // A field is asked for only where one was bound, so a tree that holds one
    // here anyway is drawn without it rather than as an element the surface
    // completes into nothing.
    return primitives.Input ? primitives.Input(tree.props as InputProps)
      : primitives.Box({ children: [] });
  }
  const children: unknown[] = tree.children.map((child) =>
    typeof child === "string" ? child : mount(child, primitives));
  if (tree.type === "Link") {
    // Without a link the words are drawn as they read: the page is one press
    // fewer away, and nothing on the row is lost.
    return primitives.Link
      ? (primitives.Link as unknown as (props: unknown) => unknown)(
        { ...(tree.props as LinkProps), children })
      : (primitives.Text as unknown as (props: unknown) => unknown)({ children });
  }
  const element = tree.type === "Box" ? primitives.Box
                : tree.type === "Text" ? primitives.Text
                : primitives.Button;
  const build = element as unknown as (props: unknown) => unknown;
  return build({ ...tree.props, children });
}

/**
 * A recording host, for the layout tests.
 *
 * It returns the node it was given, so a test can assert the exact structure the
 * layout produces without a terminal or a desktop in the loop, and without
 * pretending that proves how either surface paints.
 */
export function recordingPrimitives(options: { vectors?: boolean; fields?: boolean;
                                            links?: boolean } = {}): Primitives {
  const record = (type: "Box" | "Text" | "Button" | "Svg" | "Link" | "Input") =>
    (props: BoxProps & TextProps & ButtonProps & { children?: (Node | string)[] }): Node => {
      const { children = [], ...rest } = props;
      return { type, props: rest, children };
    };
  // A recording of a surface that draws vectors, such as the desktop, holds an
  // Svg element; the default records the terminal's table, which has none.
  return {
    Box: record("Box") as Primitives["Box"],
    Text: record("Text") as Primitives["Text"],
    Button: record("Button") as Primitives["Button"],
    ...(options.vectors ? { Svg: record("Svg") as unknown as Primitives["Svg"] } : {}),
    // Links are on every surface, so a recording holds one unless a case asks
    // for a table without; a field only when a case records a surface with one.
    ...(options.links === false ? {} : { Link: record("Link") as unknown as Primitives["Link"] }),
    ...(options.fields ? { Input: record("Input") as unknown as Primitives["Input"] } : {}),
  };
}
