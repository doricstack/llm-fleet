/**
 * The resolver every Node run here starts with: a relative `./name.js` that
 * names no file finds `name.ts` beside it, as the host does, and a `.js` that
 * exists is loaded as written.
 *
 * Each case runs in a child Node started with the resolver, against modules
 * written into a fresh folder, so the hook under test is the one in this tree
 * and nothing this suite's own process loaded can answer for it.
 *
 * Run with: node --import ./components/resolve.ts --test components/resolve.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const RESOLVER = new URL("./resolve.ts", import.meta.url).href;

/** Write `files` into a new folder, import `entry` there under the resolver, and return what it printed. */
function run(files: Record<string, string>, entry: string): { status: number | null; out: string; err: string } {
  const folder = mkdtempSync(join(tmpdir(), "fleet-resolve-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), Buffer.from(text, "utf8"));
    }
    const target = pathToFileURL(join(folder, entry)).href;
    const result = spawnSync(process.execPath, ["--import", RESOLVER, "-e",
      `import(${JSON.stringify(target)}).then((m) => process.stdout.write(String(m.value)));`],
      { encoding: "utf8" });
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("a .js import that names no file loads the .ts beside it", () => {
  const result = run({
    "entry.ts": 'export { value } from "./sibling.js";\n',
    "sibling.ts": 'export const value: string = "from ts";\n',
  }, "entry.ts");
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out, "from ts");
});

test("a .js file that exists is loaded as written", () => {
  const result = run({
    "entry.ts": 'export { value } from "./sibling.js";\n',
    "sibling.js": 'export const value = "from js";\n',
    "sibling.ts": 'export const value: string = "from ts";\n',
  }, "entry.ts");
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out, "from js");
});

test("a parent-folder .js import is mapped too", () => {
  const result = run({
    "inner/entry.ts": 'export { value } from "../sibling.js";\n',
    "sibling.ts": 'export const value: string = "from the parent";\n',
  }, "inner/entry.ts");
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out, "from the parent");
});

test("a .js import with a query or a hash still finds the .ts and keeps the suffix", () => {
  const result = run({
    "entry.ts": 'import { value as a } from "./sibling.js?v=1";\n'
      + 'import { value as b } from "./sibling.js#part";\n'
      + 'export const value: string = a + "|" + b;\n',
    "sibling.ts": 'export const value: string = new URL(import.meta.url).search + new URL(import.meta.url).hash;\n',
  }, "entry.ts");
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out, "?v=1|#part");
});

test("a bare package name is left to Node", () => {
  const result = run({
    "entry.ts": 'import { sep } from "node:path";\nexport const value: string = typeof sep;\n',
  }, "entry.ts");
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out, "string");
});

test("a .js import with neither file is still not found", () => {
  const result = run({
    "entry.ts": 'export { value } from "./missing.js";\n',
  }, "entry.ts");
  assert.notEqual(result.status, 0);
  assert.match(result.err, /ERR_MODULE_NOT_FOUND/);
});
