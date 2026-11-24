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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
         symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, normalize, relative, sep, win32 } from "node:path";
import { test } from "node:test";

import * as contract from "./loader.ts";
import { ConfigError, loadConfig, loadSchema } from "./loader.ts";

/** A synthetic home in the shape the running platform returns. */
const HOME = process.platform === "win32" ? "C:/fixture/runner" : "/fixture/runner";
const pathOf = (relative: string): string => normalize(`${HOME}/${relative}`);

/**
 * A drive other than the one the checkout runs from.
 *
 * A case about a name on another drive has to pick a drive the process is not
 * on, or a Windows checkout from C: resolves the name from its own directory
 * and the case proves nothing. Off Windows there is no process drive, and D:
 * is already the other one the fixed list names.
 */
function otherDrive(): string {
  const root = process.platform === "win32" ? win32.parse(process.cwd()).root : "";
  return root.toUpperCase().startsWith("D:") ? "C:" : "D:";
}

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
    refusals({ sources: { prs: { enabled: true }, pacer: { enabled: true } } }),
    [
      ["E_CONFIG_REQUIRED", "sources.pacer.command"],
      ["E_CONFIG_REQUIRED", "sources.prs.repositories"],
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
  assert.equal((sections.pacer as contract.JsonObject).collapsed, false);
  assert.equal(typeof (sections.pacer as contract.JsonObject).legend, "string");
});

test("the reply bounds and task lines have defaults and floors", () => {
  const pane = resolve({}).pane as contract.JsonObject;
  assert.deepEqual([pane.replyMaxChars, pane.replyPendingSeconds, pane.fanLines], [4000, 120, 2]);
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
                     "haiku-5-5": 0.5, "haiku-4-5": 5, "deepseek-flash": 1.2,
                     "deepseek-v4-pro": 3.96, "kimi-k2.7-code": 4, "mimo-v2.6-flash": 0.28 });
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

test("HOME is read from USERPROFILE when the environment has none", () => {
  const resolved = loadConfig({ configPath: scratch({ stateDir: "$HOME/fleet" }),
                                environ: { USERPROFILE: HOME } });
  assert.equal(resolved.stateDir, pathOf("fleet"));
});

test("HOME in the environment outranks USERPROFILE", () => {
  const resolved = loadConfig({ configPath: scratch({ stateDir: "$HOME/fleet" }),
                                environ: { HOME: "/fixture/shell",
                                           USERPROFILE: "/fixture/pc" } });
  assert.equal(resolved.stateDir, normalize("/fixture/shell/fleet"));
});

test("a document may not name USERPROFILE", () => {
  const configPath = scratch({ stateDir: "$USERPROFILE/fleet" });
  try {
    loadConfig({ configPath, environ: { USERPROFILE: HOME } });
    assert.fail("the loader accepted a name it does not declare");
  } catch (caught) {
    assert.ok(caught instanceof ConfigError);
    assert.deepEqual(caught.errors.map((entry) => [entry.code, entry.path]),
                     [["E_CONFIG_UNRESOLVED_VAR", "stateDir"]]);
  }
});

test("a default place that is not a regular file is skipped, as the Python loader skips it", () => {
  if (process.platform === "win32") {
    // A device stands at no path a config file would take on Windows, and a
    // link to one needs a privilege this suite cannot assume.
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const place = join(home, ".config", "llm-fleet");
  mkdirSync(place, { recursive: true });
  symlinkSync("/dev/null", join(place, "config.json"));
  // A device where the default document would sit is not a document, so the
  // load falls through to the packaged defaults rather than reading it, which
  // is what the Python loader does with the same tree.
  const resolved = loadConfig({ environ: { HOME: home } });
  assert.equal(resolved.stateDir, normalize(`${home}/.local/state/llm-fleet`));
});

test("a byte order mark is read as the same document", () => {
  const marked = String.fromCharCode(0xfeff) + JSON.stringify({ stateDir: "/marked" });
  const resolved = loadConfig({ configPath: scratch(marked), environ: { HOME } });
  assert.equal(resolved.stateDir, normalize("/marked"));
});

test("a second byte order mark is malformed, as the Python loader reads it", () => {
  const twice = String.fromCharCode(0xfeff, 0xfeff) + JSON.stringify({ stateDir: "/marked" });
  try {
    loadConfig({ configPath: scratch(twice), environ: { HOME } });
    assert.fail("the loader dropped a second mark the Python one keeps");
  } catch (caught) {
    assert.ok(caught instanceof ConfigError);
    assert.deepEqual(caught.errors.map((entry) => [entry.code, entry.path]),
                     [["E_CONFIG_MALFORMED", ""]]);
  }
});

test("an empty HOME is treated as absent, so the alias answers", () => {
  const resolved = loadConfig({ configPath: scratch({ stateDir: "$HOME/fleet" }),
                                environ: { HOME: "", USERPROFILE: HOME } });
  assert.equal(resolved.stateDir, pathOf("fleet"));
});

test("bytes that are not UTF-8 are malformed rather than unreadable", () => {
  // Valid JSON around one byte from a Windows ANSI code page: a decoder that
  // replaces the byte would hand back a path with U+FFFD in it and no error.
  const body = Buffer.from('{"stateDir": "/tmp/café"}', "latin1");
  const file = scratch("");
  writeFileSync(file, body);
  try {
    loadConfig({ configPath: file, environ: { HOME } });
    assert.fail("the loader accepted bytes it cannot read");
  } catch (caught) {
    assert.ok(caught instanceof ConfigError);
    assert.deepEqual(caught.errors.map((entry) => [entry.code, entry.path]),
                     [["E_CONFIG_MALFORMED", ""]]);
  }
});

test("a number beyond the safe range is refused rather than rounded", () => {
  // The literal the parser cannot carry exactly is refused at the field, as
  // the Python loader refuses it, rather than resolved as a different number.
  const unsafe = '{"sources": {"rates": {"maxAgeSeconds": 9007199254740993}}}';
  assert.deepEqual(refusals(unsafe),
                   [["E_CONFIG_VALUE", "sources.rates.maxAgeSeconds"]]);
  assert.deepEqual(refusals('{"pane": {"minimumColumns": 9007199254740993}}'),
                   [["E_CONFIG_VALUE", "pane.minimumColumns"]]);
  assert.deepEqual(refusals('{"sources": {"agents": {"cacheWrite5mMultiplier": 1e300}}}'),
                   [["E_CONFIG_VALUE", "sources.agents.cacheWrite5mMultiplier"]]);
});

test("a number beyond the double range is refused at its field", () => {
  assert.deepEqual(
    refusals('{"sources": {"agents": {"inputPricePerMTok": {"mythos-1": 1e400}}}}'),
    [["E_CONFIG_VALUE", "sources.agents.inputPricePerMTok.mythos-1"]],
  );
});

test("a number literal past the conversion limit is refused at its field", () => {
  const document = `{"schemaVersion": ${"1" + "0".repeat(4300)}}`;
  assert.deepEqual(refusals(document), [["E_CONFIG_VALUE", "schemaVersion"]]);
});

test("a prototype-named map key is kept, not dropped", () => {
  const resolved = resolve('{"sources": {"agents": {"inputPricePerMTok": {"__proto__": 7}}}}');
  const agents = (resolved.sources as contract.JsonObject).agents as contract.JsonObject;
  const prices = agents.inputPricePerMTok as contract.JsonObject;
  assert.equal(Object.prototype.hasOwnProperty.call(prices, "__proto__"), true);
  assert.equal(prices["__proto__"], 7);
  assert.equal(prices["fable-5-1"], 10);
  assert.equal(JSON.stringify(prices).includes("__proto__"), true);
});

test("a key binding refuses every character the schema forbids", () => {
  for (const code of [0x85, 0xfeff, 0x1c]) {
    const binding = `a${String.fromCharCode(code)}b`;
    assert.deepEqual(refusals({ keys: { close: binding } }),
                     [["E_CONFIG_VALUE", "keys.close"]]);
  }
});

test("section order reports the position the document wrote", () => {
  assert.deepEqual(refusals({ pane: { sectionOrder: [null, "custom:missing"] } }),
                   [["E_CONFIG_TYPE", "pane.sectionOrder[0]"],
                    ["E_CONFIG_RULE", "pane.sectionOrder[1]"]]);
});

test("a carried default is never expanded a second time", () => {
  const resolved = loadConfig({ environ: { USERPROFILE: "/fixture/cash$" },
                                probe: () => "missing" });
  const stateDir = contract.normalizePath("/fixture/cash$/.local/state/llm-fleet");
  assert.equal(resolved.stateDir, stateDir);
  assert.equal(((resolved.mods as contract.JsonObject).typing as contract.JsonObject).stateDir,
               contract.normalizePath(`${stateDir}/typing`));
});

test("a missing TMPDIR falls through to a writable TEMP", () => {
  const real = mkdtempSync(join(tmpdir(), "fleet-temp-"));
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
  };
  try {
    for (const name of Object.keys(saved)) {
      delete process.env[name];
    }
    process.env["TMPDIR"] = join(real, "absent");
    process.env["TEMP"] = real;
    const resolved = loadConfig({ environ: { HOME }, probe: () => "missing" });
    assert.equal((resolved.speech as contract.JsonObject).tempDirectory,
                 contract.normalizePath(real));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(real, { recursive: true, force: true });
  }
});

test("a relative TMPDIR is absolutized the way Python absolutizes it", () => {
  // `tempfile.gettempdir` absolutizes each candidate before testing it, so a
  // relative name resolves against the process directory in both loaders.
  const real = mkdtempSync(join(tmpdir(), "fleet-temp-rel-"));
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
  };
  try {
    for (const name of Object.keys(saved)) {
      delete process.env[name];
    }
    process.env["TMPDIR"] = relative(process.cwd(), real);
    const resolved = loadConfig({ environ: { HOME }, probe: () => "missing" });
    assert.equal((resolved.speech as contract.JsonObject).tempDirectory,
                 contract.normalizePath(real));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(real, { recursive: true, force: true });
  }
});

test("a drive-relative temp name on a drive with no directory answers from its root", () => {
  // A drive the environment does not name has never been entered, and Windows
  // resolves that drive's own current directory to its root; Python probes the
  // folder the name resolves to, and so does this search. The candidate is
  // never skipped, and the folder it names is the drive root's. The drive is
  // chosen against the checkout's own, so the case is one on every machine,
  // including a Windows checkout that runs from the drive the name would
  // otherwise mean. Found by review, 2026-11-24.
  const real = mkdtempSync(join(tmpdir(), "fleet-drive-"));
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
    SYSTEMROOT: process.env["SYSTEMROOT"], SystemRoot: process.env["SystemRoot"],
  };
  const attempted: string[] = [];
  const other = otherDrive();
  const name = `${other}temp`;
  // Where the search runs on Windows the probe receives the resolved folder;
  // anywhere else it receives the name as written, which is the one path that
  // platform owns.
  const probed = process.platform === "win32"
    ? contract.normalizePath(`${other}\\temp`, "win32")
    : name;
  try {
    for (const key of ["TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "SystemRoot"]) {
      delete process.env[key];
    }
    process.env["TMPDIR"] = name;
    process.env["TEMP"] = real;
    // No drive directory is supplied: the root is what the name must resolve
    // from, whatever this machine remembers for that drive in its own map.
    const found = contract.systemTempDirectory("win32", (candidate: string) => {
      attempted.push(candidate);
      return candidate === real;
    }, {});
    assert.equal(found, contract.normalizePath(real, "win32"));
    // The name reaches the probe, resolved from the drive root, before the
    // folder after it is tried.
    assert.equal(attempted[0], probed);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(real, { recursive: true, force: true });
  }
});

test("a drive-relative temp name is answered from the drive directory the environment holds", () => {
  // Windows keeps each drive's own current directory in the environment block
  // as `=C:`, and Node lists it there; answering `C:temp` from it is the
  // directory Python resolves the name to, where skipping the candidate would
  // send the pane to a different temp folder than the interpreter uses. The
  // drive is chosen against the checkout's own, so the map is what answers the
  // name on every machine. Found by review, 2026-11-24.
  const real = mkdtempSync(join(tmpdir(), "fleet-drive-"));
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
  };
  const attempted: string[] = [];
  const other = otherDrive();
  const name = `${other}temp`;
  const directory = `${other}\\work`;
  try {
    for (const name of Object.keys(saved)) {
      delete process.env[name];
    }
    process.env["TMPDIR"] = name;
    process.env["TEMP"] = real;
    const found = contract.systemTempDirectory("win32", (candidate: string) => {
      attempted.push(candidate);
      return candidate === name || candidate === contract.normalizePath(`${directory}\\temp`, "win32");
    }, { [other]: directory });
    assert.equal(found, contract.normalizePath(`${directory}\\temp`, "win32"));
    // On Windows the search probes the resolved folder; on any other system the
    // probe sees the name as written, because that is the only path it owns.
    assert.equal(attempted[0], process.platform === "win32"
      ? contract.normalizePath(`${directory}\\temp`, "win32")
      : name);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(real, { recursive: true, force: true });
  }
});

test("the drive directories are read from the environment entries Windows keeps", () => {
  // Only a key of the shape `=X:` names a drive, and an empty value names no
  // directory; every other key, including one that merely looks close, is not
  // a drive. Node marks those entries non-enumerable, so a scan of the keys
  // never sees them: each one is asked for by name and this case pins that,
  // with the keys hidden from enumeration the way the real store hides them.
  // A system that keeps no such keys answers none. Found by review, 2026-11-24.
  const hidden: Record<string, string | undefined> = {
    "C:": "C:\\not-a-drive", "=F": "F:\\no-colon", HOME: "C:\\Users\\owner",
  };
  Object.defineProperty(hidden, "=C:", { value: "C:\\work", enumerable: false });
  Object.defineProperty(hidden, "=D:", { value: "D:\\data", enumerable: false });
  Object.defineProperty(hidden, "=E:", { value: "", enumerable: false });
  assert.deepEqual(contract.driveCurrentDirectories("win32", hidden),
                   { "C:": "C:\\work", "D:": "D:\\data" });
  // A record handed to this helper is case-sensitive, and Windows answers a
  // drive name in either spelling, so both are asked for by name.
  assert.deepEqual(contract.driveCurrentDirectories("win32", { "=d:": "D:\\data" }),
                   { "D:": "D:\\data" });
  assert.deepEqual(contract.driveCurrentDirectories("darwin", { "=C:": "C:\\work" }), {});
});

test("a value of dot is returned as written, the way gettempdir returns it", () => {
  // `gettempdir` skips absolutizing exactly one value: the current directory,
  // spelled ".". Both loaders must answer "." for it, not an absolute path.
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
  };
  try {
    for (const name of Object.keys(saved)) {
      delete process.env[name];
    }
    process.env["TMPDIR"] = ".";
    const resolved = loadConfig({ environ: { HOME }, probe: () => "missing" });
    assert.equal((resolved.speech as contract.JsonObject).tempDirectory, ".");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("with no usable temp variable the Windows rule walks the platform list to the process directory", () => {
  // Python's Windows list runs ~\AppData\Local\Temp, %SYSTEMROOT%\Temp,
  // c:\temp, c:\tmp, \temp, \tmp and the process directory, so a machine with
  // none of its variables set still gets a directory. The probe names every
  // candidate the rule tries, so a removed fallback fails here on any
  // platform, not only on the one whose filesystem happens to hold the list.
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
    SYSTEMROOT: process.env["SYSTEMROOT"], SystemRoot: process.env["SystemRoot"],
  };
  const absent = join(tmpdir(), `fleet-absent-${process.pid}`);
  const attempted: string[] = [];
  // The case runs from a folder of its own: a runner whose working directory
  // is one of the fixed names would have the probe accept that name early, and
  // the list this case reads would end before its last entry.
  const running = process.cwd();
  const workdir = mkdtempSync(join(tmpdir(), "fleet-cwd-"));
  let processDirectory = "";
  try {
    process.chdir(workdir);
    processDirectory = contract.normalizePath(process.cwd(), "win32");
    for (const name of ["TMPDIR", "TEMP", "TMP"]) {
      process.env[name] = join(absent, name);
    }
    delete process.env["SYSTEMROOT"];
    delete process.env["SystemRoot"];
    const found = contract.systemTempDirectory("win32", (candidate: string) => {
      attempted.push(candidate);
      return candidate === process.cwd() || candidate === processDirectory;
    });
    assert.equal(found, processDirectory);
    assert.equal(contract.isAbsolutePath(found, "win32"), true);
    // Nine candidates: the three absent variable names, the home entry, the
    // four fixed names, the process directory. A probe sees the written name
    // off Windows and the absolutized one on it, so the drive is taken from
    // the process directory the way the platform takes it.
    assert.equal(attempted.length, 9);
    // The home folder is tried before the fixed names, and a run that clears
    // SYSTEMROOT still reaches it: a lost entry would leave the list a name
    // short and a machine with none of its variables set with no temp folder.
    assert.equal(win32.normalize(String(attempted[3])),
                 win32.normalize(join(homedir(), "AppData", "Local", "Temp")));
    const root = process.platform === "win32" ? win32.parse(process.cwd()).root : "";
    const expectedFixed = process.platform === "win32"
      ? ["C:\\temp", "C:\\tmp", `${root}temp`, `${root}tmp`]
      : ["C:\\temp", "C:\\tmp", "\\temp", "\\tmp"];
    assert.deepEqual(attempted.slice(4, 8), expectedFixed);
    assert.equal(attempted[8], process.cwd());
  } finally {
    process.chdir(running);
    rmSync(workdir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("a machine with a system root tries its temp folder between the home and the fixed names", () => {
  // Python's list carries %SYSTEMROOT%\Temp after the user's folder. A run that
  // cleared SYSTEMROOT never exercises that entry, and one that sets it proves
  // both folders are tried in their order. Found by review, 2026-11-23.
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
    SYSTEMROOT: process.env["SYSTEMROOT"], SystemRoot: process.env["SystemRoot"],
  };
  const attempted: string[] = [];
  try {
    for (const name of ["TMPDIR", "TEMP", "TMP"]) {
      process.env[name] = join(tmpdir(), `fleet-absent-root-${process.pid}`, name);
    }
    process.env["SYSTEMROOT"] = "C:\\fleet-root";
    // The other spelling is set rather than deleted: on Windows the two names
    // are one key, so deleting either removes the fixture's root and the case
    // then proves a short list instead of the order it names. Found by review,
    // 2026-11-24.
    process.env["SystemRoot"] = "C:\\fleet-root";
    contract.systemTempDirectory("win32", (candidate: string) => {
      attempted.push(candidate);
      // The search stops at the first name the probe accepts, and the fixed
      // names start with this one on every platform. A probe on the caller's
      // own directory would accept early on a runner whose directory is one of
      // the fixed names, so the entries this case is about would be read after
      // the search had already ended.
      return win32.normalize(candidate) === "C:\\temp";
    });
    // The list is the variables this process actually holds, then the user's
    // folder, the system root's folder when one is set, then the fixed names.
    // A runner may drop one of the variable names or one spelling of the root,
    // so the count is read from the same environment the search reads rather
    // than pinned to this machine's ten.
    const held = ["TMPDIR", "TEMP", "TMP"].filter((name) => process.env[name]);
    const root = process.env["SYSTEMROOT"] || process.env["SystemRoot"];
    assert.equal(attempted.length, held.length + 1 + (root ? 1 : 0) + 1,
                 attempted.join(", "));
    assert.equal(win32.normalize(String(attempted[held.length])),
                 win32.normalize(join(homedir(), "AppData", "Local", "Temp")));
    if (root) {
      assert.equal(win32.normalize(String(attempted[held.length + 1])),
                   "C:\\fleet-root\\Temp");
    }
    assert.equal(win32.normalize(String(attempted[held.length + (root ? 2 : 1)])),
                 "C:\\temp");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("a rooted name with no drive takes the current drive under the Windows rule", () => {
  // ntpath.abspath resolves \temp against the current drive, so a machine
  // whose temp folder lives on D: answers D:\temp, not a bare \temp. The
  // process directory is named so the drive is exercised on a host that has
  // none; production passes the one it runs in.
  assert.equal(contract.tempCandidatePath("\\temp", "win32", "D:\\work"), "D:\\temp");
  assert.equal(contract.tempCandidatePath("temp", "win32", "D:\\work"), "D:\\work\\temp");
  // The installed Windows-only tests in test_ntpath.py pin these answers:
  // a bare share root keeps no separator it was not written with, a `..`
  // under it falls back to the root and writes one, a server with no share
  // stays a rooted UNC name, and trailing dots and spaces are dropped the
  // way GetFullPathNameW drops them.
  assert.equal(contract.tempCandidatePath("\\\\server\\share", "win32", "D:\\work"),
               "\\\\server\\share");
  assert.equal(contract.tempCandidatePath("\\\\server\\share\\", "win32", "D:\\work"),
               "\\\\server\\share\\");
  assert.equal(contract.tempCandidatePath("\\\\server\\share\\..", "win32", "D:\\work"),
               "\\\\server\\share\\");
  // A name that ends with `..` and no separator drops that one component; a
  // name that ends a separator after its `..` keeps it, which reads oddly but
  // is what the native call answers, and the table pins both halves.
  assert.equal(contract.tempCandidatePath("//server/..", "win32", "D:\\work"),
               "\\\\server\\");
  assert.equal(contract.tempCandidatePath("//server/../", "win32", "D:\\work"),
               "\\\\server\\..\\");
  assert.equal(contract.tempCandidatePath("//server/../..", "win32", "D:\\work"),
               "\\\\server\\..\\");
  assert.equal(contract.tempCandidatePath("//server/../../..", "win32", "D:\\work"),
               "\\\\server\\..\\");
  assert.equal(contract.tempCandidatePath("//../", "win32", "D:\\work"),
               "\\\\..\\");
  assert.equal(contract.tempCandidatePath("//../..", "win32", "D:\\work"),
               "\\\\..\\");
  assert.equal(contract.tempCandidatePath("//../../", "win32", "D:\\work"),
               "\\\\..\\..\\");
  // A doubled separator inside a UNC name is folded by the native call, while
  // normpath alone leaves it in place.
  assert.equal(contract.tempCandidatePath("//spam//eggs. . .", "win32", "D:\\work"),
               "\\\\spam\\eggs");
  assert.equal(contract.tempCandidatePath("//server", "win32", "D:\\work"),
               "\\\\server");
  assert.equal(contract.tempCandidatePath("C:/spam. . .", "win32", "D:\\work"),
               "C:\\spam");
  assert.equal(contract.tempCandidatePath("C:\\temp", "win32", "D:\\work"), "C:\\temp");
  // With no drive to take, the name stays rooted and bare, as ntpath answers.
  assert.equal(contract.tempCandidatePath("\\temp", "win32", "\\work"), "\\temp");
});

test("a drive-relative temp name is answered from its drive, never the caller's directory", () => {
  // GetFullPathName answers a name like `C:temp` from drive C's own current
  // directory, which is not the process's when the process runs on D. Left as
  // written, the name would point at a different folder for every caller, and
  // the two loaders would disagree about the same machine. The drive's
  // directory is used where the caller knows it, and the drive root, that
  // drive's default, otherwise. Found by review, 2026-11-23.
  assert.equal(contract.tempCandidatePath("C:temp", "win32", "D:\\work"), "C:\\temp");
  assert.equal(contract.tempCandidatePath("C:temp", "win32", "D:\\work",
                                          { "C:": "C:\\Users\\runner\\AppData\\Local" }),
               "C:\\Users\\runner\\AppData\\Local\\temp");
  // A drive-relative name on the process's own drive takes the process directory.
  assert.equal(contract.tempCandidatePath("D:temp", "win32", "D:\\work"), "D:\\work\\temp");
  // The answer is absolute, which is what makes it mean one folder.
  assert.equal(contract.isAbsolutePath(contract.tempCandidatePath("C:temp", "win32", "D:\\work"),
                                       "win32"), true);
  // A bare drive names that drive's directory.
  assert.equal(contract.tempCandidatePath("C:", "win32", "D:\\work"), "C:\\");
  assert.equal(contract.tempCandidatePath("D:", "win32", "D:\\work"), "D:\\work");
  // A drive-relative parent is a parent, not a dot trimmed off the drive:
  // `D:..` from D:\one\two is D:\one, where trimming the dots would have made
  // it the bare drive and the caller's directory. Found by review, 2026-11-24.
  assert.equal(contract.tempCandidatePath("D:..", "win32", "D:\\one\\two"), "D:\\one");
  assert.equal(contract.tempCandidatePath("D:..\\scratch", "win32", "D:\\one\\two"),
               "D:\\one\\scratch");
  assert.equal(contract.tempCandidatePath("C:..", "win32", "D:\\work",
                                          { "C:": "C:\\one" }), "C:\\");
  // Consecutive parents all climb: the base they climb from is joined below,
  // and dropping one at the fold loses a level. `D:..\..` from `D:\one\two` is
  // D:\ and stops there, as the system clamps it. Found by review, 2026-11-24.
  assert.equal(contract.tempCandidatePath("D:..\\..", "win32", "D:\\one\\two"), "D:\\");
  assert.equal(contract.tempCandidatePath("D:..\\..\\scratch", "win32", "D:\\one\\two"),
               "D:\\scratch");
  // A single dot between two parents is folded away before the name is judged:
  // `D:..\.\..` climbs two levels like `D:..\..` does, and a comparison against
  // the spelling as written would drop the last parent and leave D:\one.
  // Found by review, 2026-11-24.
  assert.equal(contract.tempCandidatePath("D:..\\.\\..", "win32", "D:\\one\\two"), "D:\\");
  assert.equal(contract.tempCandidatePath("D:..\\.\\..\\scratch", "win32", "D:\\one\\two"),
               "D:\\scratch");
  // A run of separators behind a drive names that drive's root, not a share:
  // reading its doubled backslashes as a UNC prefix would keep the parent
  // beneath them. Found by review, 2026-11-24.
  assert.equal(contract.tempCandidatePath("D:\\\\one\\\\two\\\\..\\\\temp", "win32", "C:\\"),
               "D:\\one\\temp");
});

test("the temp probe proves a file can be made, and leaves nothing behind", () => {
  // Python's gettempdir opens a file with a unique name and removes it. A
  // folder that accepts a directory but refuses a file, because the volume is
  // full or a quota is spent, is not a temporary directory; a probe that makes
  // only a folder passes it. The probe also leaves the folder as it found it.
  const directory = mkdtempSync(join(tmpdir(), "fleet-probe-"));
  try {
    const before = readdirSync(directory);
    assert.equal(contract.canCreateInDirectory(directory), true);
    assert.deepEqual(readdirSync(directory), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(contract.canCreateInDirectory(join(directory, "absent")), false);
});

test("the temp probe refuses a file the folder will not give back", () => {
  // Python's gettempdir removes the file it made, and a folder that takes a
  // file and refuses to remove it is not a temporary directory there. A coded
  // permission refusal on a host CPython does not retry is final on the first
  // name, coded or not. Found by review, 2026-11-23 and 2026-11-24.
  for (const coded of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "fleet-keep-"));
    try {
      const attempted: string[] = [];
      const answer = contract.canCreateInDirectory(
        directory, () => "kept",
        (name: string) => {
          attempted.push(name);
          const refused = new Error("refused") as Error & { code?: string };
          if (coded) {
            refused.code = "EACCES";
          }
          throw refused;
        },
        "linux");
      assert.equal(answer, false);
      assert.deepEqual(attempted.map((one) => basename(one)), ["kept"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a Windows refusal with the folder still there is tried under another name", () => {
  // CPython retries a PermissionError on Windows while the folder exists: a
  // scanner holding the file just made is not the folder refusing to be a
  // temporary directory. A share-mode refusal reaches Node as EBUSY, where
  // CPython sees EACCES, so it is the same retry. The next name proves it, and
  // the answer is yes. Found by review, 2026-11-24.
  for (const code of ["EACCES", "EBUSY"]) {
    const directory = mkdtempSync(join(tmpdir(), "fleet-win-"));
    try {
      const names = ["first", "second"];
      let made = 0;
      const answer = contract.canCreateInDirectory(
        directory, () => names[made++] ?? "later",
        (name: string) => {
          if (basename(name) === "first") {
            const held = new Error("held open") as Error & { code: string };
            held.code = code;
            throw held;
          }
          unlinkSync(name);
        },
        "win32");
      assert.equal(answer, true);
      assert.equal(made, 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a Windows refusal that never ends still refuses the folder", () => {
  // The retry is bounded like any name: a folder whose every probe is refused
  // is not made good by trying again forever, and a folder that takes a file
  // and will not give it back collects no more names than CPython's own count.
  const directory = mkdtempSync(join(tmpdir(), "fleet-win-shut-"));
  try {
    let made = 0;
    const answer = contract.canCreateInDirectory(
      directory, () => "name" + String(made++),
      () => {
        const held = new Error("held open") as Error & { code: string };
        held.code = "EPERM";
        throw held;
      },
      "win32");
    assert.equal(answer, false);
    assert.equal(made, 20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the probe writes the four bytes CPython writes", () => {
  // CPython's gettempdir writes b'blat' into the file it makes, so a volume
  // that takes an empty file and no content is still refused. Found by review,
  // 2026-11-24.
  const directory = mkdtempSync(join(tmpdir(), "fleet-bytes-"));
  try {
    const seen: string[] = [];
    const answer = contract.canCreateInDirectory(
      directory, () => "probe",
      (name: string) => {
        seen.push(readFileSync(name, "utf8"));
        unlinkSync(name);
      });
    assert.equal(answer, true);
    assert.deepEqual(seen, ["blat"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the temp probe refuses a folder where every name it tries is taken", () => {
  // CPython tries a bounded number of names and reports no usable temporary
  // directory when all of them are there, rather than calling the folder good.
  // Found by review, 2026-11-23.
  const directory = mkdtempSync(join(tmpdir(), "fleet-taken-"));
  try {
    writeFileSync(join(directory, "taken"), "");
    let made = 0;
    assert.equal(contract.canCreateInDirectory(directory, () => { made += 1; return "taken"; }),
                 false);
    assert.equal(made, 20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the temp probe refuses a directory that exists and takes no new file", () => {
  // The old probe asked whether the folder was a directory and writable, and a
  // folder whose write bit is cleared for everyone answers yes to a stat and
  // no to a file. Found by review, 2026-11-23.
  const root = typeof process.getuid === "function" ? process.getuid() : -1;
  if (process.platform === "win32" || root === 0) {
    // Windows permissions do not map to chmod, and root writes regardless.
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "fleet-shut-"));
  try {
    chmodSync(directory, 0o500);
    assert.equal(contract.canCreateInDirectory(directory), false);
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a temp variable naming a folder that is not there walks to the platform list", () => {
  // The same walk over the POSIX list, named so it runs on every host: the
  // probe decides which folders exist, so the answer does not depend on the
  // filesystem the test happens to run on.
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"],
  };
  const absent = join(tmpdir(), `fleet-absent-list-${process.pid}`);
  const attempted: string[] = [];
  try {
    for (const name of Object.keys(saved)) {
      process.env[name] = join(absent, name);
    }
    const found = contract.systemTempDirectory("posix", (candidate: string) => {
      attempted.push(candidate);
      return candidate === "/var/tmp";
    });
    assert.equal(found, "/var/tmp");
    // The three absent variable names came first, then /tmp was refused by the
    // probe, so the walk went on to the entry after it.
    assert.deepEqual(attempted.slice(0, 3), ["TMPDIR", "TEMP", "TMP"].map((name) => join(absent, name)));
    assert.deepEqual(attempted.slice(3), ["/tmp", "/var/tmp"]);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("the temp directory it answers is one a new folder can be made in", () => {
  // gettempdir proves a folder by making a file in it; the answer must be a
  // folder a file can actually be made in, not one that only looks writable.
  const found = contract.systemTempDirectory();
  assert.equal(contract.isAbsolutePath(found), true);
  const made = mkdtempSync(join(found, ".fleet-probe-"));
  try {
    assert.equal(statSync(made).isDirectory(), true);
  } finally {
    rmSync(made, { recursive: true, force: true });
  }
});

test("a selector ending in a separator still names the file", () => {
  const configPath = scratch({ stateDir: "/fleet/state" });
  const resolved = loadConfig({ configPath: configPath + sep, environ: { HOME } });
  assert.equal(resolved.stateDir, contract.normalizePath("/fleet/state"));
});

test("a selector ending in a backslash names a different file off Windows", () => {
  // pathlib folds only the platform's own separator: on POSIX a backslash is
  // a character in the name, so the document beside it is not found. Node's
  // path module folds both and read a file the Python loader never looked at.
  const configPath = scratch({ stateDir: "/fleet/state" });
  if (process.platform === "win32") {
    const resolved = loadConfig({ configPath: configPath + "\\", environ: { HOME } });
    assert.equal(resolved.stateDir, contract.normalizePath("/fleet/state"));
    return;
  }
  assert.throws(
    () => loadConfig({ configPath: configPath + "\\", environ: { HOME } }),
    (caught: unknown) => caught instanceof ConfigError
      && caught.errors.some((entry) => entry.code === contract.CODE_FILE_NOT_FOUND),
  );
});

test("the one path rule holds off this platform as well", () => {
  // Windows drive-relative behavior, proved with the platform named.
  assert.equal(contract.isAbsolutePath("/fleet/config.json", "win32"), true);
  assert.equal(contract.isAbsolutePath("C:\\fleet\\config.json", "win32"), true);
  assert.equal(contract.isAbsolutePath("\\\\server\\share\\x", "win32"), true);
  assert.equal(contract.isAbsolutePath("D:state", "win32"), false);
  assert.equal(contract.isAbsolutePath("C:fleet", "win32"), false);
  // A leading separator wins even when the rest looks like a malformed share.
  assert.equal(contract.isAbsolutePath("/\\", "win32"), true);
  assert.equal(contract.joinPath("C:\\cfg", "D:state", "win32"), "D:state");
  assert.equal(contract.joinPath("C:\\cfg", "D:\\state", "win32"), "D:\\state");
  assert.equal(contract.joinPath("C:\\cfg", "\\fleet\\x", "win32"), "C:\\fleet\\x");
  assert.equal(contract.joinPath("C:\\cfg", "C:fleet", "win32"), "C:\\cfg\\fleet");
  // A bare UNC share keeps no separator it was not written with.
  assert.equal(contract.joinPath("C:\\cfg", "\\\\srv\\sh", "win32"), "\\\\srv\\sh");
  assert.equal(contract.normalizePath("//server/share", "win32"), "\\\\server\\share");
  assert.equal(contract.normalizePath("//server/share/", "win32"), "\\\\server\\share\\");
  assert.equal(contract.normalizePath("\\\\", "win32"), "\\\\");
  assert.equal(contract.normalizePath("/fleet/", "posix"), "/fleet");
  assert.equal(contract.normalizePath("//fleet", "posix"), "//fleet");
  assert.equal(contract.normalizePath("C:\\cfg\\", "win32"), "C:\\cfg");
  assert.equal(contract.normalizePath("//fleet", "win32"), "\\\\fleet");
  // A rooted second path replaces the base, and two leading separators stay.
  assert.equal(contract.joinPath("/cfg", "/x", "posix"), "/x");
  assert.equal(contract.joinPath("//cfg", "", "posix"), "//cfg");
});
