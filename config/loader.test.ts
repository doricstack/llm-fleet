/**
 * TypeScript loader behavior.
 *
 * This suite covers the loader's own surface: the contract it reads, the states
 * it derives, and the refusal classes it reports. The shared fixture corpus in
 * `config/fixtures` is driven from `tests/test_config_loader.py`, which runs
 * both loaders over the same inputs and compares them, so the corpus has one
 * comparison implementation rather than two.
 *
 * Run with: node --test config/loader.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { test } from "node:test";

import * as contract from "./loader.ts";
import { ConfigError, loadConfig, loadSchema } from "./loader.ts";

/** A synthetic home in the shape the running platform returns. */
const HOME = process.platform === "win32" ? "C:/fixture/runner" : "/fixture/runner";
const pathOf = (relative: string): string => normalize(`${HOME}/${relative}`);

test("pause markers resolve paths and stop target probing for both sources", () => {
  for (const [name, target] of [["progress", "directory"], ["trials", "database"]]) {
    const probed: string[] = [];
    const result = resolve({ sources: { [name]: {
      enabled: true, [target]: pathOf("missing"), paused_when_exists: "~/paused",
    } } }, { probe: (path) => { probed.push(path); return "file"; } });
    const source = (result.sources as contract.JsonObject)[name] as contract.JsonObject;
    assert.equal(source.paused_when_exists, pathOf("paused"));
    assert.equal(source.state, "paused");
    assert.deepEqual(probed, [pathOf("paused")]);
  }
});

test("pause markers are optional nullable paths and reject invalid values", () => {
  for (const name of ["progress", "trials"]) {
    for (const marker of [null, undefined]) {
      const result = resolve({ sources: { [name]: { paused_when_exists: marker } } });
      const source = (result.sources as contract.JsonObject)[name] as contract.JsonObject;
      assert.equal(source.paused_when_exists, null);
      assert.equal(source.state, "disabled");
    }
    assert.deepEqual(refusals({ sources: { [name]: { paused_when_exists: 7 } } }),
      [["E_CONFIG_TYPE", `sources.${name}.paused_when_exists`]]);
    assert.deepEqual(refusals({ sources: { [name]: { paused_when_exists: "" } } }),
      [["E_CONFIG_VALUE", `sources.${name}.paused_when_exists`]]);
  }
});

function scratch(document: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "fleet-config-"));
  const file = join(directory, "config.json");
  writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
  return file;
}

function refusals(document: unknown, options: contract.LoadOptions = {}): [string, string][] {
  const configPath = scratch(document);
  try {
    loadConfig({ configPath, environ: { HOME }, ...options });
  } catch (caught) {
    assert.ok(caught instanceof ConfigError, `expected ConfigError, saw ${String(caught)}`);
    return caught.errors.map((entry) => [entry.code, entry.path]);
  }
  throw new Error("the loader accepted a document it should have refused");
}

function resolve(document: unknown, options: contract.LoadOptions = {}): contract.JsonObject {
  return loadConfig({ configPath: scratch(document), environ: { HOME }, ...options });
}

test("defaults describe every declared resolution key", () => {
  const resolved = loadConfig({ environ: { HOME }, probe: () => "missing" });
  const schema = loadSchema();
  assert.deepEqual(Object.keys(resolved).sort(), [...schema.resolvedKeys].sort());
  assert.equal(resolved.stateDir, pathOf(".local/state/llm-fleet"));
  assert.deepEqual(resolved.providers, []);
  assert.equal((resolved.sources as contract.JsonObject).jobs instanceof Object, true);
});

test("a missing provider home is unavailable, and its sources stay unconfigured", () => {
  const resolved = resolve({ providers: [{ id: "one", home: `${HOME}/homes/one` }] },
                           { probe: () => "missing" });
  const providers = resolved.providers as contract.JsonObject[];
  assert.equal(providers[0].state, "unavailable");
  const sources = resolved.sources as contract.JsonObject;
  assert.equal((sources.jobs as contract.JsonObject).state, "unconfigured");
  assert.deepEqual((sources.jobs as contract.JsonObject).providers, []);
});

test("a present home is ready and fills both roster sources", () => {
  const resolved = resolve({ providers: [{ id: "one", home: `${HOME}/homes/one` }] },
                           { probe: () => "directory" });
  const providers = resolved.providers as contract.JsonObject[];
  assert.equal(providers[0].state, "ready");
  assert.equal(providers[0].label, "one");
  const sources = resolved.sources as contract.JsonObject;
  assert.equal((sources.jobs as contract.JsonObject).state, "ready");
  assert.deepEqual((sources.interactive as contract.JsonObject).providers, ["one"]);
});

test("a disabled provider is never probed, and a disabled source keeps its value", () => {
  const probed: string[] = [];
  const resolved = resolve(
    {
      providers: [{ id: "one", home: `${HOME}/homes/one`, enabled: false }],
      sources: { skills: { enabled: false, directory: `${HOME}/absent` } },
    },
    { probe: (path: string) => { probed.push(path); return "directory"; } },
  );
  const providers = resolved.providers as contract.JsonObject[];
  assert.equal(providers[0].state, "disabled");
  const skills = (resolved.sources as contract.JsonObject).skills as contract.JsonObject;
  assert.equal(skills.state, "disabled");
  assert.equal(skills.directory, pathOf("absent"));
  assert.deepEqual(probed, []);
});

test("unknown keys are refused at every depth, in one canonical order", () => {
  assert.deepEqual(
    refusals({
      stateDirr: "/quiet",
      commands: { githubh: "gh" },
      providers: [{ id: "one", home: `${HOME}/homes/one`, hom: "typo" }],
    }),
    [
      ["E_CONFIG_UNKNOWN_KEY", "commands.githubh"],
      ["E_CONFIG_UNKNOWN_KEY", "providers[0].hom"],
      ["E_CONFIG_UNKNOWN_KEY", "stateDirr"],
    ],
  );
});

test("an enabled source is refused without the field it needs", () => {
  assert.deepEqual(
    refusals({ sources: { prs: { enabled: true }, trials: { enabled: true } } }),
    [
      ["E_CONFIG_REQUIRED", "sources.prs.repositories"],
      ["E_CONFIG_REQUIRED", "sources.trials.database"],
    ],
  );
});

test("relative values resolve against the directory holding the config file", () => {
  const configPath = scratch({ stateDir: "./nested/../state" });
  const resolved = loadConfig({ configPath, environ: { HOME } });
  assert.equal(resolved.stateDir, join(configPath, "..", "state"));
});

test("a tilde, a shell expression, and an undeclared variable are refused", () => {
  assert.deepEqual(refusals({ stateDir: "~/state" }), [["E_CONFIG_VALUE", "stateDir"]]);
  assert.deepEqual(refusals({ stateDir: "$(pwd)/state" }), [["E_CONFIG_VALUE", "stateDir"]]);
  assert.deepEqual(refusals({ stateDir: "%LOCALAPPDATA%/llm-fleet" }),
                   [["E_CONFIG_VALUE", "stateDir"]]);
  assert.deepEqual(refusals({ stateDir: "$FLEET_OTHER/state" }),
                   [["E_CONFIG_UNRESOLVED_VAR", "stateDir"]]);
});

test("legacy environment overrides are recorded in the contract and never read", () => {
  const resolved = loadConfig({
    environ: { HOME, FLEET_STATE_DIR: "/elsewhere/state", FLEET_HOMES: "/elsewhere/homes" },
  });
  assert.equal(resolved.stateDir, pathOf(".local/state/llm-fleet"));
  assert.deepEqual(resolved.providers, []);
});

test("the platform user directory is used when the platform defines one", () => {
  const appData = `${HOME}/AppData/Local`;
  assert.equal(loadConfig({ environ: { LOCALAPPDATA: appData } }).stateDir,
               normalize(`${appData}/llm-fleet`));
  assert.equal(loadConfig({ environ: { HOME, LOCALAPPDATA: appData } }).stateDir,
               normalize(`${appData}/llm-fleet`));
});

test("an unsupported version is refused, and a value below the floor is a value error", () => {
  assert.deepEqual(refusals({ schemaVersion: 2 }), [["E_CONFIG_VERSION", "schemaVersion"]]);
  assert.deepEqual(refusals({ schemaVersion: 0 }), [["E_CONFIG_VALUE", "schemaVersion"]]);
});

test("a malformed document and a non-object root are refused", () => {
  assert.deepEqual(refusals("{ not json"), [["E_CONFIG_MALFORMED", ""]]);
  assert.deepEqual(refusals([1, 2]), [["E_CONFIG_ROOT_TYPE", ""]]);
});

test("the loader follows the schema it is given", () => {
  const schema = JSON.parse(readFileSync(contract.schemaPath(), "utf8"));
  schema.fields.push({ path: "greeting", type: "string", default: "hello" });
  const file = join(mkdtempSync(join(tmpdir(), "fleet-schema-")), "schema.json");
  writeFileSync(file, JSON.stringify(schema));
  const accepted = loadConfig({
    configPath: scratch({ greeting: "hi" }), environ: { HOME }, schemaFile: file,
  });
  assert.equal(accepted.schemaVersion, 1);
  const configPath = scratch({ greeting: 7 });
  assert.throws(
    () => loadConfig({ configPath, environ: { HOME }, schemaFile: file }),
    (caught: unknown) => caught instanceof ConfigError
      && caught.errors.some((entry) => entry.code === "E_CONFIG_TYPE"
        && entry.path === "greeting"),
  );
});

test("every code the loader can report is declared by the schema", () => {
  const declared = new Set(loadSchema().errorCodes.map((entry) => entry.code));
  for (const [name, value] of Object.entries(contract)) {
    if (name.startsWith("CODE_")) {
      assert.ok(declared.has(value as string), `${name} is not declared in the schema`);
    }
  }
});

test("every state the loader reports is declared by the contract", () => {
  const schema = loadSchema();
  const documents: unknown[] = [
    {},
    { providers: [{ id: "one", home: `${HOME}/homes/one` }] },
    { providers: [{ id: "one", home: `${HOME}/homes/one`, enabled: false }] },
    { sources: { prs: { enabled: true, repositories: ["owner/project"] },
                 // The statusline's target is the payload it last read, so a
                 // source switched on without one is refused rather than
                 // resolved: there is no document behind it to read.
                 statusline: { enabled: true, payload: `${HOME}/state/host-payload.json` } } },
  ];
  for (const document of documents) {
    for (const probe of [() => "missing", () => "directory"]) {
      const resolved = resolve(document, { probe });
      for (const entry of resolved.providers as contract.JsonObject[]) {
        assert.ok(schema.providerStates.includes(entry.state as string), String(entry.state));
      }
      for (const group of Object.values(resolved.sources as contract.JsonObject)) {
        const state = (group as contract.JsonObject).state as string;
        assert.ok(schema.sourceStates.includes(state), state);
      }
      for (const group of Object.values(resolved.mods as contract.JsonObject)) {
        const state = (group as contract.JsonObject).state as string;
        assert.ok(schema.modStates.includes(state), state);
      }
    }
  }
});

test("the declared cross-field rules are enforced", () => {
  assert.deepEqual(refusals({ keys: { collapse: "x" } }), [["E_CONFIG_RULE", "keys.collapse"]]);
  assert.deepEqual(refusals({ pane: { sectionOrder: ["sessions", "sessions"] } }),
                   [["E_CONFIG_RULE", "pane.sectionOrder"]]);
  assert.deepEqual(refusals({ speech: { group: "female", voice: "am_onyx" } }),
                   [["E_CONFIG_RULE", "speech.voice"]]);
  assert.deepEqual(refusals({ keys: { close: "1" } }), [["E_CONFIG_RULE", "keys.close"]]);
  assert.deepEqual(refusals({ keys: { collapse: "9", expand: "8" } }),
                   [["E_CONFIG_RULE", "keys.collapse"], ["E_CONFIG_RULE", "keys.expand"]]);
  const keys = resolve({ keys: { close: "q", collapse: "z", expand: "a" } }).keys as contract.JsonObject;
  assert.deepEqual([keys.close, keys.collapse, keys.expand], ["q", "z", "a"]);
});

test("a mod that cannot run on this platform reads unavailable, and is off by default", () => {
  const off = loadConfig({ environ: { HOME }, platform: "darwin" });
  assert.equal((off.mods as contract.JsonObject).typing instanceof Object, true);
  assert.equal(((off.mods as contract.JsonObject).typing as contract.JsonObject).state, "disabled");
  const refused = resolve({ mods: { typing: { enabled: true } } }, { platform: "win32" });
  assert.equal(((refused.mods as contract.JsonObject).typing as contract.JsonObject).state,
               "unavailable");
  const ready = resolve({ mods: { typing: { enabled: true } } }, { platform: "darwin" });
  assert.equal(((ready.mods as contract.JsonObject).typing as contract.JsonObject).state, "ready");
});

test("an enabled mod without the thresholds this contract cannot state is refused", () => {
  assert.deepEqual(refusals({ mods: { secretShield: { enabled: true } } }),
                   [["E_CONFIG_REQUIRED", "mods.secretShield.minimumLengths"]]);
  assert.deepEqual(
    refusals({ mods: { secretShield: { enabled: true,
                                       minimumLengths: { collector: 8, urlPassword: 6 } } } }),
    [["E_CONFIG_REQUIRED", "mods.secretShield.minimumLengths.masker"]],
  );
});

test("a record section keeps the defaults of the sections it does not mention", () => {
  const resolved = resolve({ pane: { sections: { sessions: { collapsed: true } } } });
  const sections = (resolved.pane as contract.JsonObject).sections as contract.JsonObject;
  assert.equal((sections.sessions as contract.JsonObject).collapsed, true);
  assert.equal((sections.worktrees as contract.JsonObject).collapsed, true);
  assert.equal((sections.trials as contract.JsonObject).collapsed, false);
  assert.equal(typeof (sections.trials as contract.JsonObject).legend, "string");
});

test("the reply bounds and task lines have defaults and floors", () => {
  const pane = resolve({}).pane as contract.JsonObject;
  assert.deepEqual([pane.replyMaxChars, pane.replyPendingSeconds, pane.fanLines], [4000, 120, 4]);
  // A reply is held by a marker no time takes back, so there is no claim time.
  assert.equal("replyClaimSeconds" in pane, false);
  assert.equal((resolve({ pane: { fanLines: 0 } }).pane as contract.JsonObject).fanLines, 0);
  assert.deepEqual(refusals({ pane: { fanLines: -1 } }), [["E_CONFIG_VALUE", "pane.fanLines"]]);
  assert.deepEqual(refusals({ pane: { replyMaxChars: 0 } }),
                   [["E_CONFIG_VALUE", "pane.replyMaxChars"]]);
  assert.deepEqual(refusals({ pane: { replyPendingSeconds: 0 } }),
                   [["E_CONFIG_VALUE", "pane.replyPendingSeconds"]]);
  assert.deepEqual(refusals({ pane: { replyClaimSeconds: 30 } }),
                   [["E_CONFIG_UNKNOWN_KEY", "pane.replyClaimSeconds"]]);
});

test("a key outside a map or a record is refused", () => {
  assert.deepEqual(refusals({ theme: { worktrees: { abandoned: "error" } } }),
                   [["E_CONFIG_UNKNOWN_KEY", "theme.worktrees.abandoned"]]);
  assert.deepEqual(refusals({ pane: { sections: { middle: { visible: true } } } }),
                   [["E_CONFIG_UNKNOWN_KEY", "pane.sections.middle"]]);
});

test("an open map takes a key its list does not carry and seeds the packaged ones", () => {
  const agents = (resolve({ sources: { agents: {
    outputPricePerMTok: { "mythos-1": 7 },
    contextWindowTokens: { "mythos-1": 200000 } } } }).sources as contract.JsonObject)
    .agents as contract.JsonObject;
  assert.deepEqual(agents.outputPricePerMTok,
                   { "mythos-1": 7, "fable-5-1": 50, "opus-5-5": 20, "opus-5": 25,
                     "opus-4-8": 25, "opus-4-7": 25, "sonnet-5-5": 10, "sonnet-5": 10,
                     "haiku-5-5": 0.5, "haiku-4-5": 5 });
  assert.deepEqual(agents.contextWindowTokens,
                   { "mythos-1": 200000, "fable-5-1": 1000000, "opus-5-5": 1000000,
                     "opus-5": 1000000, "opus-4-8": 1000000, "opus-4-7": 1000000,
                     "sonnet-5-5": 1000000, "sonnet-5": 1000000, "haiku-5-5": 1000000,
                     "haiku-4-5": 1000000 });
});

test("a color triple and a declared token are enforced", () => {
  assert.deepEqual(refusals({ alerts: { tabTint: { failureRgb: [1, 2] } } }),
                   [["E_CONFIG_VALUE", "alerts.tabTint.failureRgb"]]);
  assert.deepEqual(refusals({ alerts: { tabTint: { waitingRgb: [1, 999, 3] } } }),
                   [["E_CONFIG_VALUE", "alerts.tabTint.waitingRgb[1]"]]);
  assert.deepEqual(refusals({ alerts: { tabTint: { staleSeconds: 0 } } }),
                   [["E_CONFIG_VALUE", "alerts.tabTint.staleSeconds"]]);
  assert.deepEqual(refusals({ alerts: { tabTint: { staleSeconds: 29 } } }),
                   [["E_CONFIG_VALUE", "alerts.tabTint.staleSeconds"]]);
  const floor = resolve({ alerts: { tabTint: { staleSeconds: 30 } } }) as {
    alerts: { tabTint: { staleSeconds: number } } };
  assert.equal(floor.alerts.tabTint.staleSeconds, 30);
  assert.deepEqual(refusals({ alerts: { tabTint: { staleSeconds: "soon" } } }),
                   [["E_CONFIG_TYPE", "alerts.tabTint.staleSeconds"]]);
  assert.deepEqual(refusals({ theme: { failure: "purple" } }),
                   [["E_CONFIG_VALUE", "theme.failure"]]);
});

test("the platform temporary directory is resolved rather than left as a variable", () => {
  const resolved = loadConfig({ environ: { HOME } });
  const speech = resolved.speech as contract.JsonObject;
  assert.equal(typeof speech.tempDirectory, "string");
  assert.equal((speech.tempDirectory as string).includes("$"), false);
});

test("the mod state directory sits under the state directory", () => {
  const resolved = resolve({ stateDir: `${HOME}/fleet` });
  const typing = (resolved.mods as contract.JsonObject).typing as contract.JsonObject;
  assert.equal(typing.stateDir, normalize(`${HOME}/fleet/typing`));
});
