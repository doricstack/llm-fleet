/**
 * Run one configuration fixture through the TypeScript loader and print the result.
 *
 * `tests/test_config_loader.py` drives this runner over the shared corpus in
 * `config/fixtures` so both loaders face the same inputs and the same
 * expectations. A fixture refusal is data, not a failure: it prints the error
 * list and exits 0. Exit 2 means the runner itself could not complete.
 *
 * Usage: node config/parity-runner.ts --fixture config/fixtures/defaults
 */

import { readFileSync } from "node:fs";
import { join, normalize, resolve as resolvePath } from "node:path";

import { ConfigError, loadConfig } from "./loader.ts";

interface FixtureSpec {
  environment?: Record<string, string>;
  paths?: Record<string, string>;
  configFile?: string | null;
  platform?: string;
}

function expandFixturePaths(fixture: string, spec: FixtureSpec): {
  environ: Record<string, string>;
  kinds: Map<string, string>;
} {
  const environ: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.environment || {})) {
    environ[key] = value.startsWith("./") ? join(fixture, value.slice(2)) : value;
  }
  const kinds = new Map<string, string>();
  for (const [key, value] of Object.entries(spec.paths || {})) {
    const located = key.startsWith("./") ? join(fixture, key.slice(2)) : key;
    // The loader hands the probe a platform-shaped path, so the declared keys
    // are put in the same shape.
    kinds.set(normalize(located), value);
  }
  if (typeof spec.configFile === "string" && spec.configFile) {
    environ.FLEET_CONFIG = join(fixture, spec.configFile);
  }
  return { environ, kinds };
}

function main(argv: string[]): number {
  let fixture = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fixture") {
      index += 1;
      fixture = argv[index] || "";
    } else if (!argument.startsWith("--")) {
      fixture = argument;
    }
  }
  if (!fixture) {
    process.stderr.write("usage: parity-runner.ts --fixture <directory>\n");
    return 2;
  }
  const directory = resolvePath(fixture);
  try {
    const spec = JSON.parse(readFileSync(join(directory, "env.json"), "utf8")) as FixtureSpec;
    const { environ, kinds } = expandFixturePaths(directory, spec);
    const probe = (path: string): string => kinds.get(path) || "missing";
    const resolved = loadConfig({ environ, probe, platform: spec.platform });
    process.stdout.write(`${JSON.stringify({ config: resolved }, null, 2)}\n`);
    return 0;
  } catch (caught) {
    if (caught instanceof ConfigError) {
      process.stdout.write(`${JSON.stringify({ errors: caught.errors }, null, 2)}\n`);
      return 0;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`fixture runner failed: ${message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
