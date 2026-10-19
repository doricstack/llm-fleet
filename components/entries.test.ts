/**
 * The entry table: the one place the plugin names a Python script it starts,
 * and the one way it builds the command that starts it.
 *
 * Run with: node --test components/entries.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ENTRIES, entryArgv, entryEnv, LAUNCH, launchFrom, PYTHON } from "../plugins/llm-fleet/components/entries.ts";
import { ALERTS, READER, TAB_HELPER } from "../plugins/llm-fleet/hooks/llm-fleet.ts";

test("a command starts the interpreter on the declared script under the plugin root", () => {
  assert.deepEqual(entryArgv("/plugin/llm-fleet", "snapshot", ["--pretty"]),
                   [PYTHON, "/plugin/llm-fleet/readers/snapshot.py", "--pretty"]);
  assert.deepEqual(entryArgv("/plugin/llm-fleet", "tab"), [PYTHON, "/plugin/llm-fleet/readers/tab.py"]);
});

test("the arguments follow the script in order and are not changed", () => {
  const args = ["focus", "--", "a b", "$HOME"];
  assert.deepEqual(entryArgv("/root", "alerts", args).slice(2), args);
});

test("the person's interpreter starts every entry, and their configuration file reaches it", () => {
  const launch = launchFrom({ python: "  /opt/py/bin/python3.12 ", configPath: "/etc/llm-fleet/config.json" });
  assert.deepEqual(entryArgv("/plugin/llm-fleet", "snapshot", ["--pretty"], launch),
                   ["/opt/py/bin/python3.12", "/plugin/llm-fleet/readers/snapshot.py", "--pretty"]);
  assert.deepEqual(entryEnv(launch), { FLEET_CONFIG: "/etc/llm-fleet/config.json" });
});

test("options left out, empty or of the wrong kind leave the packaged launch", () => {
  for (const options of [undefined, {}, { python: "", configPath: "" }, { python: "   " },
                         { python: 3, configPath: true }, { python: ["python3"] }]) {
    const launch = launchFrom(options as never);
    assert.deepEqual(launch, LAUNCH, JSON.stringify(options));
    assert.equal(entryEnv(launch), undefined, JSON.stringify(options));
  }
  assert.equal(LAUNCH.python, PYTHON);
  // A launch the caller did not name is the packaged one.
  assert.deepEqual(entryArgv("/r", "tab"), entryArgv("/r", "tab", [], LAUNCH));
});

test("every declared script is a Python file under the readers", () => {
  for (const [key, script] of Object.entries(ENTRIES)) {
    assert.match(script, /^readers\/[a-z_]+\.py$/, key);
  }
});

test("the names the plugin entry exports are the table's own", () => {
  assert.equal(READER, ENTRIES.snapshot);
  assert.equal(ALERTS, ENTRIES.alerts);
  assert.equal(TAB_HELPER, ENTRIES.tab);
});
