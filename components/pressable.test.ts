/**
 * What a press may hold.
 *
 * The host draws a Button's content as words and Text, and refuses any other
 * child. The refusal happens while the pane is being drawn, so it does not cost
 * one control: the whole render is lost and the person opens an empty frame.
 * A row's press is built around a box holding its figures, which is exactly a
 * child the host refuses, so the box is unwrapped before the press is made and
 * this suite holds that: a press holds words and Text, and nothing else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { box, pressable, text } from "../plugins/fleet/components/layout.ts";
import type { Node } from "../plugins/fleet/components/host.ts";

function typesOf(children: (Node | string)[]): string[] {
  return children.map((child) =>
    typeof child === "string" ? "Text" : child.type);
}

test("a box inside a press is unwrapped into what it says", () => {
  const flattened = pressable([box({ flexDirection: "row" }, [
    text({}, "3 working"),
    box({}, [text({}, "1 waiting")]),
  ])]);
  assert.deepEqual(typesOf(flattened), ["Text", "Text"]);
});

test("a press keeps its words where they were given as strings", () => {
  const flattened = pressable([box({}, ["3 working", "1 waiting"])]);
  assert.deepEqual(flattened, ["3 working", "1 waiting"]);
});

test("a press keeps the Text it was given directly", () => {
  const flattened = pressable([text({}, "Close")]);
  assert.deepEqual(typesOf(flattened), ["Text"]);
});

test("a press holds nothing it cannot draw", () => {
  // A vector or a link inside a press is the same refusal as a box, and the
  // same cost: the pane does not draw. Neither reaches a press.
  const flattened = pressable([
    { type: "Svg", props: {}, children: [] },
    box({}, [text({}, "kept")]),
  ]);
  assert.deepEqual(typesOf(flattened), ["Text"]);
});
