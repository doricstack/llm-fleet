/**
 * Pane view-model behavior.
 *
 * The cases here are the design's own list: a healthy empty group is not a
 * failure, a failed read never becomes an empty reading, a stale row says how old
 * it is, a count is never invented, the same entity is never counted twice, and
 * the header keeps different denominators apart.
 *
 * Run with: node --test plugins/llm-fleet/components/pane.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_KEYS, HIDE_PREFIX, SHOW_ALL_PREFIX, allErrors, paneFrom, prUrl, replyKey,
         replyText, unreadableSources,
         worktreeNextStep, worktreeOwnerNote, type PaneOptions }
  from "../plugins/llm-fleet/components/pane.ts";
import { GEOMETRY } from "../plugins/llm-fleet/components/options.ts";
import { fitSlots, groupMessage, renderedText, renderPane, renderRow }
  from "../plugins/llm-fleet/components/layout.ts";
import { NARROW_AT } from "../plugins/llm-fleet/components/options.ts";
import { themeFrom, type Theme } from "../plugins/llm-fleet/components/palette.ts";
import { FOOTER_TEXT } from "../plugins/llm-fleet/components/version.ts";
import type {
  Group, Row,
} from "../plugins/llm-fleet/components/layout.ts";
import type { Pacer, Snapshot } from "../plugins/llm-fleet/components/state.ts";

const NOW = 1_700_000_000;

test("paused progress and trials each draw one paused line without rows", () => {
  const built = paneFrom(snapshot({
    progress: { state: "paused", runs: [], errors: [] },
    trials: { state: "paused", running: [], recent: [], history: null, errors: [] },
  }), options());
  for (const title of ["Running", "Trials"]) {
    const section = group(built, title);
    assert.equal(section.state, "paused");
    assert.deepEqual(section.rows, []);
    assert.deepEqual(section.summary, []);
    assert.deepEqual(groupMessage(section).map((slot) => slot.text), [title + " is paused."]);
  }
});

test("a press on a figure narrows the pane to that state, and the counts stay whole", () => {
  const reading = snapshot({
    roster: { state: "ready", jobs: [{ ...JOB, state: "blocked" },
                                     { ...JOB, id: "run", name: "Building the pane",
                                       state: "working" }],
              interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "empty" } },
    trials: { state: "ready", running: [], history: null, errors: [],
              recent: [{ key: "k", repo: "example-repo", branch: "fix", change_state: "",
                         at: NOW - 60, is_green: false, passed: 3, failed: 1,
                         errors: 0, skipped: 0 }] },
  });
  const failed = paneFrom(reading, options({ focus: "failed" }));
  // The line says why only some rows are drawn, and the press that widens it.
  assert.equal(failed.focus?.text, "Showing failed only.");
  assert.equal(failed.focus?.clear.key, "fleet.focus.clear");
  // The figures still count the whole machine, not the narrowed pane.
  assert.deepEqual(failed.cards?.map((card) => card.value), ["1", "1", "1"]);
  assert.deepEqual(failed.groups.map((group) => group.title), ["Trials"]);
  assert.equal(failed.groups[0]?.rows.every((row) => row.state === "failed"), true);
  const waiting = paneFrom(reading, options({ focus: "waiting" }));
  assert.deepEqual(waiting.groups.map((group) => group.title), ["Background sessions"]);
  assert.deepEqual(waiting.groups[0]?.rows.map((row) => row.title), ["Review adapter behavior"]);
  // A pane with no filter carries no line and draws every section it did before.
  assert.equal(paneFrom(reading, options()).focus, undefined);
});

test("a press on a figure is the control that carries its state", () => {
  // The figures are drawn only on a roster that answered: a card over an
  // unread roster is the loudest place to be wrong.
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [{ ...JOB, state: "working" }], interactive: {},
              errors: [], providers: {}, sources: { jobs: "ready", interactive: "empty" } },
  }), options());
  assert.deepEqual(pane.cards?.map((card) => card.press?.key),
                   ["fleet.focus.working", "fleet.focus.waiting", "fleet.focus.failed"]);
});

test("a row pressed open says so, and carries the press that closes it", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [{ ...JOB, state: "working" }], interactive: {},
              errors: [], providers: {}, sources: { jobs: "ready", interactive: "empty" } },
  }), options({ sectionOrder: ["sessions"] }));
  const row = group(pane, "Background sessions").rows[0];
  assert.equal(row?.detailsPress?.key.startsWith("fleet.details."), true);
  assert.equal(row?.expanded, false);
  assert.equal(row?.details?.some((slot) => slot.text.includes("provider primary")), true);
  const id = row?.detailsPress?.key.slice("fleet.details.".length) ?? "";
  const opened = paneFrom(snapshot({
    roster: { state: "ready", jobs: [{ ...JOB, state: "working" }], interactive: {},
              errors: [], providers: {}, sources: { jobs: "ready", interactive: "empty" } },
  }), options({ sectionOrder: ["sessions"], details: { [id]: true } }));
  assert.equal(group(opened, "Background sessions").rows[0]?.expanded, true);
});

test("every section names the figure its rows end in", () => {
  // The words beside a figure ("42 passed", "merged") say what they are; a
  // verdict, a state and a check count do not, so each section says once what
  // its right-hand column holds. Load names two figures in their own widths.
  const built = paneFrom(snapshot(), options());
  const named = new Map(built.groups.map((section) => [section.title, section.columns]));
  assert.deepEqual(named.get("Background sessions"), [{ text: "STATE" }]);
  assert.deepEqual(named.get("Trials"), [{ text: "RESULT" }]);
  assert.deepEqual(named.get("Pull requests"), [{ text: "CHECKS" }]);
  assert.deepEqual(named.get("Worktrees"), [{ text: "STATE" }]);
  assert.deepEqual(named.get("Skills"), [{ text: "VERDICT" }]);
  // A section whose rows end in a bar and no right-hand figure names nothing.
  assert.equal(named.get("Keys"), undefined);
});

test("the pane names the installed plugin, its author and its license in the footer", () => {
  // The host offers no plugin version, so the number is written beside the
  // manifest and a publication test keeps the two equal. What this case holds is
  // that the pane draws it, dim, under everything it reports.
  const built = paneFrom(snapshot(), options());
  assert.equal(built.footer?.text, FOOTER_TEXT);
  assert.equal(built.footer?.dim, true);
  assert.match(FOOTER_TEXT, /^llm-fleet \d+\.\d+\.\d+ · Doric Stack LLC · MIT$/);
});

test("every section the pane builds carries its own fold control and hotkey", () => {
  // Read off the view model the plugin actually builds, not off a fixture: a
  // hotkey handed out twice is one that silently stops working, and a section
  // without a control is one nobody can fold.
  const built = paneFrom(snapshot(), options());
  const controls = built.groups.map((group) => group.toggle);
  assert.equal(controls.every((item) => item !== undefined), true);
  const hotkeys = controls.map((item) => item?.hotkey ?? "");
  assert.deepEqual(hotkeys, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(new Set(hotkeys).size, hotkeys.length);
  // Addressed by the section each one belongs to, so a press names the right one.
  assert.deepEqual(controls.map((item) => item?.key).sort(),
                   Object.keys(options().sections).map((name) => "fleet.section." + name).sort());
  const all = (built.controls ?? []).map((item) => item.hotkey ?? "");
  assert.deepEqual(all, ["x", "c", "e"]);
  // None of the three clashes with a section's.
  assert.equal(all.some((key) => hotkeys.includes(key)), false);
  // Every key the pane's own section lists is carried by a control, which is
  // what makes that list a description of this pane rather than of a set of
  // shortcuts a person has to hope apply here.
  const listed = built.groups
    .filter((group) => group.title === "Keys")
    .flatMap((group) => group.rows.map((row) => row.title));
  const bindings = listed.slice(0, 4);
  assert.deepEqual(bindings,
                   [DEFAULT_KEYS.close, DEFAULT_KEYS.collapse, DEFAULT_KEYS.expand, "1-9"]);
  // The three the pane draws a control for are the three it binds, and the
  // fourth is the digits the sections themselves carry.
  assert.equal(bindings.slice(0, 3).every((key) => all.includes(key)), true);
});

test("the picker lists every section the configuration made visible", () => {
  // The picker is how a section is put away and brought back, so a visible
  // section missing from it is one a person can hide and never recover.
  const built = paneFrom(snapshot(), options());
  assert.deepEqual(built.picker?.map((item) => item.name), options().sectionOrder);
  assert.deepEqual(built.picker?.map((item) => item.title),
                   ["Running", "Background sessions", "This session", "Trials",
                    "Pull requests", "Worktrees", "Skills", "Warnings", "Keys"]);
  // Each one carries the press that puts it away, addressed by its own name.
  for (const item of built.picker ?? []) {
    assert.equal(item.press.key, HIDE_PREFIX + item.name);
    assert.equal(item.hidden, false);
  }
  // A section the configuration hid is not drawn and is not offered: the picker
  // says what a person may put away, not what a file switched off for them.
  const sections = { ...options().sections, prs: { visible: false, collapsed: false } };
  const hiddenByConfig = paneFrom(snapshot(), options({ sections }));
  assert.equal(hiddenByConfig.picker?.some((item) => item.name === "prs"), false);
  assert.equal(hiddenByConfig.groups.some((entry) => entry.title === "Pull requests"), false);
});

test("a section a person put away keeps its name, and draws no card", () => {
  const built = paneFrom(snapshot(), options({ putAway: { sessions: true } }));
  // The card and every row under it are gone...
  assert.equal(built.groups.some((entry) => entry.title === "Background sessions"), false);
  // ...and the picker still names it, so the same press brings it back.
  const putAway = built.picker?.find((item) => item.name === "sessions");
  assert.equal(putAway?.title, "Background sessions");
  assert.equal(putAway?.hidden, true);
  // A section nobody put away is drawn, and its item says so.
  assert.equal(built.picker?.find((item) => item.name === "running")?.hidden, false);
  assert.equal(built.groups.some((entry) => entry.title === "Running"), true);
});

test("the picker draws a section a person put away dim, and the same press brings it back", () => {
  const built = paneFrom(snapshot(), options({ putAway: { sessions: true } }));
  const buttons: { key?: string; dimColor?: unknown; label?: string;
                   children?: { type?: string; children?: unknown[] }[] }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    const record = node as { type?: string; props?: typeof buttons[number];
                             children?: unknown[] };
    if (record.type === "Button" && typeof record.props?.key === "string"
        && record.props.key.startsWith(HIDE_PREFIX)) {
      buttons.push({ ...record.props, children: record.children as typeof buttons[number]["children"] });
    }
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(renderPane(built));
  assert.deepEqual(buttons.map((button) => button.key).sort(),
                   options().sectionOrder.map((name) => HIDE_PREFIX + name).sort());
  const putAway = buttons.find((button) => button.key === HIDE_PREFIX + "sessions");
  assert.equal(putAway?.dimColor, true);
  assert.equal(putAway?.label, "Background sessions");
  // A button holds strings and texts only: a box in one is refused by the host.
  assert.equal(putAway?.children?.every((child) => child.type === "Text"), true);
  const open = buttons.find((button) => button.key === HIDE_PREFIX + "running");
  assert.equal(open?.dimColor, undefined);
});

test("the governance section draws one switch per scope, and names what each press does", () => {
  const pressed: string[] = [];
  const actions = { copy: () => undefined, refuse: () => undefined,
                    reply: () => undefined,
                    governance: (scope: string) => { pressed.push(scope); } };
  const reading = snapshot({ governance: { state: "ready", governor: true, controller: false,
                                           source: "config", path: "/switch.json",
                                           updated_at: null, by: null, errors: [] } });
  const built = paneFrom(reading, options({ sectionOrder: ["governance"],
    sections: { governance: { visible: true, collapsed: false } }, actions }));
  const section = group(built, "Governance");
  assert.deepEqual(section.rows.map((row) => row.title), ["Governor", "Controller"]);
  // The right-hand word is the switch itself, and the quiet line says which way
  // the next press goes.
  assert.deepEqual(section.rows.map((row) => row.slot.map((slot) => slot.text)),
                   [["on"], ["off"]]);
  assert.deepEqual(section.rows.map((row) => row.meta.map((slot) => slot.text)),
                   [["press to switch off"], ["press to switch on"]]);
  assert.deepEqual(section.summary?.map((slot) => slot.text), ["governor on, controller off"]);
  section.rows[0]?.press?.onPress();
  section.rows[1]?.press?.onPress();
  assert.deepEqual(pressed, ["governor", "controller"]);
  // The first press on a scope that is on only arms the one that switches it
  // off: the row says so, and the press is not made until it is pressed again.
  const armed = paneFrom(reading, options({ sectionOrder: ["governance"],
    sections: { governance: { visible: true, collapsed: false } }, actions,
    confirmingGovernance: "governor" }));
  assert.equal(group(armed, "Governance").rows[0]?.meta[0]?.text,
               "press again to switch off");
});

/** A ready pacer reading: four slots, one held for ten minutes. */
function pacerReading(overrides: Partial<Pacer> = {}): Pacer {
  return {
    state: "ready", enabled: true, switchSource: "missing", reason: null, version: null,
    slotCount: 4, workersPerRun: 6,
    slots: [{ slot: 0, busy: true, pid: 42, repo: "llm-fleet-private", startedAt: NOW - 600 },
            { slot: 1, busy: false, pid: null, repo: null, startedAt: null },
            { slot: 2, busy: false, pid: null, repo: null, startedAt: null },
            { slot: 3, busy: false, pid: null, repo: null, startedAt: null }],
    waiting: null, recent: null, errors: [],
    ...overrides,
  };
}

function pacerPane(reading: Pacer, extra: Partial<PaneOptions> = {}) {
  return paneFrom(snapshot({ pacer: reading }), options({ sectionOrder: ["session", "pacer"],
    sections: { session: { visible: true, collapsed: false },
                pacer: { visible: true, collapsed: false } }, ...extra }));
}

test("the pacer section sits where the order puts it and draws its switch and slots", () => {
  const built = pacerPane(pacerReading());
  assert.deepEqual(built.groups.map((entry) => entry.title), ["This session", "Pacer"]);
  const section = group(built, "Pacer");
  assert.deepEqual(section.rows.map((row) => row.title),
                   ["Pacer", "Slot 1", "Slot 2", "Slot 3", "Slot 4"]);
  assert.deepEqual(section.rows[0]?.slot.map((slot) => slot.text), ["on"]);
  // A held slot names the repository and how long it has run; a free one says free.
  assert.deepEqual(section.rows[1]?.slot.map((slot) => slot.text), ["llm-fleet-private"]);
  assert.deepEqual(section.rows[1]?.meta.map((slot) => slot.text), ["running 10m"]);
  assert.equal(section.rows[1]?.state, "working");
  assert.deepEqual(section.rows[2]?.slot.map((slot) => slot.text), ["free"]);
  assert.equal(section.rows[2]?.state, undefined);
  assert.deepEqual(section.summary?.map((slot) => slot.text), ["1 of 4 busy"]);
});

test("a busy slot whose holder pacer could not name is busy, never free", () => {
  const section = group(pacerPane(pacerReading({ slots: [
    { slot: 0, busy: true, pid: null, repo: null, startedAt: null }] })), "Pacer");
  assert.deepEqual(section.rows[1]?.slot.map((slot) => slot.text), ["held"]);
  assert.deepEqual(section.rows[1]?.meta.map((slot) => slot.text), ["holder not named"]);
  assert.equal(section.rows[1]?.state, "working");
});

test("waiters pacer did not report draw nothing, and reported ones are counted", () => {
  const silent = group(pacerPane(pacerReading()), "Pacer");
  assert.equal(silent.rows.some((row) => row.title === "Waiting"), false);
  const none = group(pacerPane(pacerReading({ waiting: [] })), "Pacer");
  assert.equal(none.rows.some((row) => row.title === "Waiting"), false);
  assert.deepEqual(none.summary?.map((slot) => slot.text), ["1 of 4 busy", "  none waiting"]);
  const two = group(pacerPane(pacerReading({ waiting: [
    { pid: 7, repo: "web-app", since: NOW - 30 },
    { pid: 8, repo: "shared-tools", since: NOW - 300 }] })), "Pacer");
  const row = two.rows.find((entry) => entry.title === "Waiting");
  assert.deepEqual(row?.slot.map((slot) => slot.text), ["2 callers"]);
  // The longest wait is what a person needs: who has been held, and for how long.
  assert.deepEqual(row?.meta.map((slot) => slot.text), ["shared-tools waiting 5m"]);
  assert.equal(row?.state, "waiting");
  assert.deepEqual(two.summary?.map((slot) => slot.text), ["1 of 4 busy", "  2 waiting"]);
});

test("recent runs draw newest first, with a refusal and a failure each said plainly", () => {
  const section = group(pacerPane(pacerReading({ recent: [
    { at: NOW - 60, repo: "shared-tools", waitSeconds: 12, runSeconds: 300, exit: 0, slot: 2,
      mode: "on", reason: null },
    { at: NOW - 120, repo: "web-app", waitSeconds: 0, runSeconds: null, exit: 75, slot: null,
      mode: "refused", reason: "memory pressure" },
    { at: NOW - 180, repo: "fleet", waitSeconds: 3, runSeconds: 40, exit: 1, slot: 1,
      mode: "on", reason: null },
    { at: NOW - 240, repo: "old", waitSeconds: 0, runSeconds: 5, exit: 0, slot: 0,
      mode: "on", reason: null }] })), "Pacer");
  const runs = section.rows.filter((row) => row.key?.startsWith("pacer.run:"));
  assert.deepEqual(runs.map((row) => row.title), ["shared-tools", "web-app", "fleet"]);
  assert.deepEqual(runs.map((row) => row.slot.map((slot) => slot.text).join("")),
                   ["passed", "refused", "exit 1"]);
  assert.deepEqual(runs.map((row) => row.state), [undefined, "failed", "failed"]);
  assert.deepEqual(runs[0]?.meta.map((slot) => slot.text), ["waited 12s, ran 5m, 1m ago"]);
  assert.deepEqual(runs[1]?.meta.map((slot) => slot.text), ["memory pressure, 2m ago"]);
  assert.equal(runs[0]?.dim, true);
});

test("a run the person stopped reads as stopped, dim, never as a failure", () => {
  const section = group(pacerPane(pacerReading({ recent: [
    { at: NOW - 60, repo: "fleet", waitSeconds: 0, runSeconds: null, exit: 130, slot: null,
      mode: "interrupted", reason: null }] })), "Pacer");
  const runs = section.rows.filter((row) => row.key?.startsWith("pacer.run:"));
  assert.deepEqual(runs.map((row) => row.slot.map((slot) => slot.text).join("")), ["stopped"]);
  assert.equal(runs[0]?.state, undefined);
  assert.equal(runs[0]?.dim, true);
});

test("pacer switched off says so, and its switch row presses to turn it back on", () => {
  const pressed: boolean[] = [];
  const actions = { copy: () => undefined, refuse: () => undefined, reply: () => undefined,
                    pacer: (on: boolean) => { pressed.push(on); } };
  const off = group(pacerPane(pacerReading({ enabled: false, switchSource: "file" }),
                              { actions }), "Pacer");
  assert.deepEqual(off.rows[0]?.slot.map((slot) => slot.text), ["off"]);
  assert.deepEqual(off.rows[0]?.meta.map((slot) => slot.text), ["press to switch on"]);
  assert.deepEqual(off.summary?.map((slot) => slot.text), ["off"]);
  off.rows[0]?.press?.onPress();
  assert.deepEqual(pressed, [true]);
  // Turning pacer off lets every heavy run start at once, so it asks again first.
  const on = group(pacerPane(pacerReading(), { actions }), "Pacer");
  assert.deepEqual(on.rows[0]?.meta.map((slot) => slot.text), ["press to switch off"]);
  const armed = group(pacerPane(pacerReading(), { actions, confirmingPacer: true }), "Pacer");
  assert.deepEqual(armed.rows[0]?.meta.map((slot) => slot.text), ["press again to switch off"]);
  armed.rows[0]?.press?.onPress();
  assert.deepEqual(pressed, [true, false]);
});

test("a switch read from the environment says so, since a press there moves nothing", () => {
  // The variable's name is pacer's own setting, so the row says what pacer said.
  const section = group(pacerPane(pacerReading({ enabled: false, switchSource: "env",
                                                 reason: "PACE_GATE=0 in the environment" })),
                        "Pacer");
  assert.deepEqual(section.rows[0]?.meta.map((slot) => slot.text),
                   ["off for this shell: PACE_GATE=0 in the environment"]);
  assert.equal(section.rows[0]?.press, undefined);
  const unsaid = group(pacerPane(pacerReading({ enabled: false, switchSource: "env",
                                                reason: null })), "Pacer");
  assert.deepEqual(unsaid.rows[0]?.meta.map((slot) => slot.text),
                   ["off for this shell, set in the environment"]);
});

test("a machine without pacer draws no section, and a failed read draws the failure", () => {
  for (const state of ["disabled", "unconfigured"] as const) {
    const built = pacerPane(pacerReading({ state, enabled: null, slots: [] }));
    assert.equal(built.groups.some((entry) => entry.title === "Pacer"), false, state);
    assert.equal((built.picker ?? []).some((item) => item.name === "pacer"), false, state);
  }
  const older = paneFrom(snapshot(), options({ sectionOrder: ["pacer"],
    sections: { pacer: { visible: true, collapsed: false } } }));
  assert.equal(older.groups.some((entry) => entry.title === "Pacer"), false);
  const failed = group(pacerPane(pacerReading({
    state: "failed", enabled: null, slotCount: null, slots: [],
    errors: [{ source: "pacer", reason: "exit 3" }] })), "Pacer");
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.rows, []);
});

test("a machine with no governance switch draws no switch and no section", () => {
  const reading = snapshot({ governance: { state: "unconfigured", governor: null,
                                           controller: null, source: null, path: null,
                                           updated_at: null, by: null, errors: [] } });
  const built = paneFrom(reading, options({ sectionOrder: ["governance"],
    sections: { governance: { visible: true, collapsed: false } } }));
  assert.equal(built.groups.some((entry) => entry.title === "Governance"), false);
  assert.equal((built.picker ?? []).some((item) => item.name === "governance"), false);
  // A reading taken before the switch was read draws the same way: an absent
  // document is not a machine whose gates are on.
  const older = paneFrom(snapshot(), options({ sectionOrder: ["governance"],
    sections: { governance: { visible: true, collapsed: false } } }));
  assert.equal(older.groups.some((entry) => entry.title === "Governance"), false);
});

test("a governance document that failed draws the failure and no state", () => {
  const reading = snapshot({ governance: { state: "failed", governor: null, controller: null,
                                           source: null, path: null, updated_at: null, by: null,
                                           errors: [{ source: "governance",
                                                      reason: "switch file is not JSON" }] } });
  const built = paneFrom(reading, options({ sectionOrder: ["governance"],
    sections: { governance: { visible: true, collapsed: false } } }));
  const section = group(built, "Governance");
  assert.equal(section.state, "failed");
  assert.deepEqual(section.rows, []);
});

function options(overrides: Partial<PaneOptions> = {}): PaneOptions {
  return {
    width: 120,
    narrowAt: 60,
    now: NOW,
    sectionOrder: ["running", "sessions", "session", "trials", "prs", "worktrees", "skills",
                   "warnings", "keys"],
    sections: {
      running: { visible: true, collapsed: false },
      sessions: { visible: true, collapsed: false },
      session: { visible: true, collapsed: false },
      trials: { visible: true, collapsed: false },
      prs: { visible: true, collapsed: false },
      worktrees: { visible: true, collapsed: false },
      skills: { visible: true, collapsed: false },
      warnings: { visible: true, collapsed: false },
      keys: { visible: true, collapsed: false },
    },
    keys: DEFAULT_KEYS,
    geometry: GEOMETRY,
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    generated_at: NOW - 4,
    roster: { state: "empty", jobs: [], interactive: {}, errors: [], providers: {},
              sources: { jobs: "empty", interactive: "empty" } },
    trials: { state: "empty", running: [], recent: [], history: null, errors: [] },
    session: { state: "empty", absent: [], parameters: {}, errors: [] },
    progress: { state: "empty", runs: [], errors: [] },
    prs: { state: "empty", prs: [], errors: [] },
    skills: { state: "empty", generated_at: null, counts: {}, items: [], new: [], running: null,
              errors: [] },
    worktrees: { state: "empty", worktrees: [], cleaned: null, errors: [] },
    load: { state: "empty", sampled_at: null, total: 0, processes: [], errors: [] },
    custom: { state: "disabled", sections: {}, errors: [] },
    ...overrides,
  };
}

/** Every color the drawn tree paints with, wherever it appears. */
function colorsIn(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const record = node as { props?: { color?: unknown }; children?: unknown };
  if (typeof record.props?.color === "string") {
    found.push(record.props.color);
  }
  const children = Array.isArray(record.children) ? record.children : [record.children];
  for (const child of children) {
    colorsIn(child, found);
  }
  return found;
}

function group(pane: { groups: Group[] }, title: string): Group {
  const found = pane.groups.find((entry) => entry.title === title);
  assert.ok(found, "no group named " + title);
  return found;
}

function texts(pane: { groups: Group[] }): string[] {
  return renderedText(renderPane({ ...pane, title: "Fleet", counts: [], updated: { text: "u" },
                                   groups: pane.groups, width: 120, narrowAt: 60 }));
}

/**
 * The strings that are a rate bar rather than part of a figure.
 *
 * A tile draws a figure out of the same solid mark a bar is made of, so "starts
 * with a hash" no longer separates them. A bar is the one string that is long
 * and made of nothing else: a figure's rows carry spaces between their glyphs,
 * and a figure is three characters wide.
 */
/** Whether each run of bar cells in a tree is drawn dim, in drawing order. */
function barDimness(tree: unknown): boolean[] {
  const found: boolean[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    const record = node as { type?: string; props?: { dimColor?: unknown }; children?: unknown[] };
    const [only] = record.children ?? [];
    if (record.type === "Text" && record.children?.length === 1 && typeof only === "string"
        && /^\u2501{8,}$/.test(only)) {
      found.push(record.props?.dimColor === true);
    }
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(tree);
  return found;
}

/**
 * The lines the pane's items draw, without the project roots a tree section
 * heads them with.
 *
 * `texts` reads every string the pane draws; a section grouped by project also
 * draws each root and how many items hang under it, and a test asserting what an
 * item says is about the item.
 */
function itemTexts(pane: { groups: Group[] }): string[] {
  const roots = new Set(pane.groups.flatMap((group) => group.rows
    .flatMap((row) => row.project ? [row.project.root] : [])));
  return texts(pane).filter((value) => !roots.has(value) && !/^\d+ items?$/.test(value));
}

function bars(values: string[]): string[] {
  // The heavy line the filled part is drawn with and the light one it rests on,
  // which nothing else the pane draws is made of.
  return values.filter((value) => /^\u2501+$/.test(value) && value.length >= 8);
}

const JOB = {
  id: "abc", name: "Review adapter behavior", state: "blocked", cwd: "~/work", started_at: NOW - 600,
  provider: "primary", label: "Provider A", session_id: "1234abcd-ffff", needs: "Which source?",
  suggested_reply: "the first", activity: null, detail: null, fan: [], since: NOW - 120,
  needs_hash: "hash-which-source",
};

test("a healthy empty source reads as empty and never as a failure", () => {
  const pane = paneFrom(snapshot(), options());
  const sessions = group(pane, "Background sessions");
  assert.equal(sessions.state, "empty");
  assert.deepEqual(groupMessage(sessions),
                   [{ text: "No background jobs in the configured sources.", dim: true }]);
  assert.equal(texts(pane).some((value) => value.includes("Could not read")), false);
});

test("a failed read leaves the count unknown and says so", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "failed", jobs: [], interactive: {}, providers: {},
              errors: [{ source: "jobs:primary", reason: "exit 3" }],
              sources: { jobs: "failed", interactive: "failed" } },
  }), options());
  const sessions = group(pane, "Background sessions");
  assert.equal(sessions.state, "failed");
  assert.deepEqual(sessions.summary, [{ text: "unknown", color: "error" }]);
  assert.equal(sessions.rows.length, 0);
});

test("a failed read that still holds rows is stale, with the age of those rows", () => {
  const pane = paneFrom(snapshot({
    worktrees: {
      state: "failed",
      worktrees: [{ name: "lane", path: "/tmp/lane", branch: "x", state: "active", merged: false,
                    archived: false, held: false, cleanup_command: "clean",
                    checked_at: NOW - 180 }],
      cleaned: null,
      errors: [{ source: "worktrees", reason: "inspection in progress" }],
    },
  }), options());
  const trees = group(pane, "Worktrees");
  assert.equal(trees.state, "stale");
  assert.equal(trees.rows.length, 1);
  assert.deepEqual(groupMessage({ ...trees, name: "Worktrees", observed: 1, staleSeconds: 0 }),
                   [{ text: "1 observed, as of 0s ago. Refresh failed.", color: "warning" }]);
});

test("a worktree row that was not rechecked says so and keeps its own age", () => {
  const pane = paneFrom(snapshot({
    worktrees: {
      state: "ready",
      worktrees: [{ name: "lane", path: "/tmp/lane", branch: "x", state: "merged", merged: true,
                    archived: false, held: false, cleanup_command: "clean",
                    checked_at: NOW - 600, recheck_error: "timed out after 2s" }],
      cleaned: null,
      errors: [],
    },
  }), options());
  const row = group(pane, "Worktrees").rows[0];
  assert.equal(row?.note?.text.includes("timed out after 2s"), true);
  assert.equal(row?.note?.text.includes("not rechecked since 10m ago"), true);
});

test("a waiting job shows what it asks and what it suggests", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [JOB], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
  }), options());
  const values = texts(pane);
  assert.equal(values.includes("Review adapter behavior"), true);
  assert.equal(values.includes("Waiting for you"), true);
  assert.equal(values.includes("Which source?"), true);
  // A waiting job has been waiting that long; it did not wait "2m ago".
  assert.equal(values.some((value) => value.includes("waiting 2m")), true);
  assert.equal(values.some((value) => value.includes("waiting 2m ago")), false);
  assert.equal(values.some((value) => value.includes("session 1234abcd")), true);
});

test("a measured run carries a bar and its failures, and one with no denominator does not", () => {
  const pane = paneFrom(snapshot({
    progress: { state: "ready", errors: [], runs: [
      { key: "abcdef12", repo: "example-repo", branch: "feat/one", label: "Test export boundaries",
        display: "feat/one@example-repo", done: 42, total: 80, failed: 1,
        first_failure: "test_one", elapsed: 120, eta_minutes: 3, phase: "verify" },
      { key: "abcdef13", repo: "example-repo", branch: null, label: "", display: "full in example-repo",
        done: 0, total: 0, failed: 0, first_failure: "", elapsed: 5, eta_minutes: null,
        phase: "verify" },
    ] },
  }), options());
  const values = texts(pane);
  assert.equal(values.includes("Test export boundaries"), true);
  assert.equal(values.includes("1 failed"), false);
  assert.equal(values.some((value) => value.includes("1 failed")), true);
  assert.equal(values.some((value) => value.includes("about 3m left")), true);
  assert.equal(values.includes("full in example-repo"), true);
  assert.equal(values.filter((value) => value === "No counts yet").length, 1);
  // One bar, drawn as two runs: the part that is done, in the run's color, and
  // the part that is not, quiet. The run with no denominator draws neither.
  const drawn = bars(values);
  assert.equal(drawn.length, 2);
  const tree = renderPane({ ...pane, title: "Fleet", counts: [], updated: { text: "u" },
                            groups: pane.groups, width: 120, narrowAt: 60 });
  assert.deepEqual(barDimness(tree), [false, true]);
});

test("a command held in line does not ask for the person, and a failed one does", () => {
  // The governor section leads when a command failed. A queue that is merely
  // waiting its turn is not a failure, and moving the section for it would hand
  // its hotkey to a row that says nothing new.
  const held = (failed: number) => {
    const pane = paneFrom(snapshot({
      progress: { state: "ready", errors: [], runs: [
        { key: "abc12345", repo: "example-repo", branch: null, label: "Build export",
          display: "Build export", done: 1, total: 10, failed,
          first_failure: failed ? "test_one" : "", elapsed: 30, eta_minutes: null,
          phase: "verify" },
      ] },
    }), options());
    return group(pane, "Running");
  };
  assert.equal(held(0).attention, false);
  assert.equal(held(1).attention, true);
});

test("a failed try asks for the person on change control, and a green one does not", () => {
  const trial = (is_green: boolean) => {
    const pane = paneFrom(snapshot({
      trials: { state: "ready", running: [], history: null, errors: [],
                recent: [{ key: "k", repo: "example-repo", branch: "fix", change_state: "",
                           at: NOW - 60, is_green, passed: 3, failed: is_green ? 0 : 1,
                           errors: 0, skipped: 0 }] },
    }), options());
    return group(pane, "Trials");
  };
  assert.equal(trial(false).attention, true);
  assert.equal(trial(true).attention, false);
});

test("a run with no published total draws no bar at all", () => {
  const pane = paneFrom(snapshot({
    progress: { state: "ready", errors: [], runs: [
      { key: "abcdef12", repo: "example-repo", branch: null, label: "Unknown", display: "Unknown",
        done: 0, total: 0, failed: 0, first_failure: "", elapsed: 30, eta_minutes: null,
        phase: "verify" },
    ] },
  }), options());
  const values = texts(pane);
  assert.equal(bars(values).length, 0);
  assert.equal(values.includes("No counts yet"), true);
});

test("a lease says how long it has left, not how long ago it ends", () => {
  const pane = paneFrom(snapshot({
    trials: { state: "ready", recent: [], history: null, errors: [], running: [
      { repo: "example-repo", branch: "feat/one", tool: "codex", expires_at: NOW + 600,
        session: "abcdef12-rest" },
      { repo: "example-repo", branch: "feat/two", tool: "codex", expires_at: NOW - 120,
        session: "abcdef13-rest" }] },
  }), options());
  const values = texts(pane);
  assert.equal(values.some((value) => value.includes("lease ends in 10m")), true);
  assert.equal(values.some((value) => value.includes("lease expired 2m ago")), true);
  assert.equal(values.some((value) => value.includes("ends in 10m ago")), false);
});

test("a section that cannot show anything says which section it is", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "disabled", jobs: [], interactive: {}, providers: {}, errors: [],
              sources: { jobs: "disabled", interactive: "disabled" } },
    progress: { state: "disabled", runs: [], errors: [] },
  }), options());
  const values = texts(pane);
  // "Running are disabled" is what a shared sentence produced before each
  // section carried its own wording.
  assert.equal(values.includes("Running work is disabled in configuration."), true);
  assert.equal(values.some((value) => value.includes("Running are disabled")), false);
  assert.equal(values.includes("Background jobs are disabled in configuration."), true);
  assert.equal(values.some((value) => value.includes("No background jobs")), false);
});

test("a trial verdict is colored by whether it passed and carries its counts", () => {
  const pane = paneFrom(snapshot({
    trials: { state: "ready", running: [], errors: [], history: null, recent: [
      { key: "r1", repo: "example-repo", branch: "feat/one", change_state: "TRYING", at: NOW - 300,
        is_green: true, passed: 12, failed: 0, errors: 0, skipped: 1 },
      { key: "r2", repo: "example-repo", branch: "feat/two", change_state: "TRYING", at: NOW - 60,
        is_green: false, passed: 3, failed: 2, errors: 1, skipped: 0 },
    ] },
  }), options());
  const rows = group(pane, "Trials").rows;
  assert.equal(rows[0]?.slot[0]?.text, "12 passed");
  assert.equal(rows[0]?.slot[0]?.color, "success");
  assert.equal(rows[1]?.slot.some((slot) => slot.text === " \u00b7 2 failed"), true);
  assert.equal(rows[1]?.slot.some((slot) => slot.text === " \u00b7 1 errors"), true);
});

test("a pull request shows its check verdict and marks a draft", () => {
  const pane = paneFrom(snapshot({
    prs: { state: "ready", errors: [], prs: [
      { repo: "owner/one", number: 7, title: "Fix it", branch: "fix/one", head: "0123456789ab",
        is_draft: true, checks: "fail" },
      { repo: "owner/one", number: null, title: "No number", branch: "", head: "",
        is_draft: false, checks: "none" },
    ] },
  }), options());
  const rows = group(pane, "Pull requests").rows;
  assert.equal(rows[0]?.title, "#7 Fix it");
  assert.equal(rows[0]?.slot[0]?.text, "draft");
  assert.equal(rows[0]?.slot[1]?.text, "checks failed");
  assert.equal(rows[1]?.title, "No number");
  assert.equal(rows[1]?.slot[0]?.text, "no checks");
  const values = itemTexts(pane);
  assert.equal(values.includes("2 open"), true);
  assert.equal(values.some((value) => value.includes("1 failing")), true);
});

test("a section groups its rows under each project root, in a stable order", () => {
  const tree = (name: string, root: string, state: string) => ({
    name, branch: "main", path: "/w/" + name, project_root: root,
    state, merged: state === "merged", archived: false, held: false,
    last_commit: "abc", last_commit_at: NOW - 60, checked_at: NOW - 60,
    changes: 0, main_ahead: 0, feedback: [], dirty: 0, cleanup_command: null,
  });
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", errors: [], cleaned: 0, worktrees: [
      tree("two", "/repos/b", "active"),
      tree("one", "/repos/a", "active"),
      tree("three", "/repos/a", "merged"),
    ] },
  }), options());
  const rows = group(pane, "Worktrees").rows;
  // One row per worktree, each naming its root: the root is drawn as a heading
  // by the renderer, not carried as a row that counts as an item.
  assert.deepEqual(rows.map((row) => row.project?.root), ["/repos/a", "/repos/a", "/repos/b"]);
  assert.deepEqual(rows.map((row) => row.project?.count), [2, 2, 1]);
  // Only the last project closes the section's rail.
  assert.deepEqual(rows.map((row) => row.project?.last), [false, false, true]);
  // The root is a heading, not an item: three worktrees draw three rows.
  assert.equal(rows.length, 3);
});

test("each project root is drawn once, above its rows, in the accent", () => {
  const tree = (name: string, root: string) => ({
    name, branch: "main", path: "/w/" + name, project_root: root,
    state: "active", merged: false, archived: false, held: false,
    last_commit: "abc", last_commit_at: NOW - 60, checked_at: NOW - 60,
    changes: 0, main_ahead: 0, feedback: [], dirty: 0, cleanup_command: null,
  });
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", errors: [], cleaned: 0, worktrees: [
      tree("one", "/repos/a"), tree("two", "/repos/b"), tree("three", "/repos/b"),
    ] },
  }), options());
  const values = texts(pane);
  // Each root once, in the theme's accent so the roots are read at a glance.
  const accents: string[] = [];
  const walk = (node: unknown): void => {
    const record = node as { type?: string; props?: { color?: unknown }; children?: unknown[] };
    if (record?.type === "Text" && record.props?.color === "claude") {
      accents.push((record.children ?? []).join(""));
    }
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(renderPane({ ...pane, title: "Fleet", counts: [], updated: { text: "u" },
                    groups: pane.groups, width: 120, narrowAt: 60 }));
  assert.deepEqual(accents, ["/repos/a", "/repos/b"]);
  assert.equal(values.filter((value) => value === "/repos/a").length, 1);
  assert.equal(values.filter((value) => value === "/repos/b").length, 1);
  assert.equal(values.includes("1 item"), true);
  assert.equal(values.includes("2 items"), true);
});

test("the last project closes the section's rail, and its items hang under it", () => {
  const tree = (name: string, root: string) => ({
    name, branch: "main", path: "/w/" + name, project_root: root,
    state: "active", merged: false, archived: false, held: false,
    last_commit: "abc", last_commit_at: NOW - 60, checked_at: NOW - 60,
    changes: 0, main_ahead: 0, feedback: [], dirty: 0, cleanup_command: null,
  });
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", errors: [], cleaned: 0, worktrees: [
      tree("one", "/repos/a"), tree("two", "/repos/b"),
    ] },
  }), options());
  const glyphs: string[] = [];
  const walk = (node: unknown): void => {
    const record = node as { type?: string; children?: unknown[] };
    if (record?.type === "Text") {
      const value = (record.children ?? []).join("");
      if (/^[│\s]*[├└]─$/.test(value)) {
        glyphs.push(value);
      }
    }
    for (const child of record.children ?? []) {
      walk(child);
    }
  };
  walk(renderPane({ ...pane, title: "Fleet", counts: [], updated: { text: "u" },
                    groups: [group(pane, "Worktrees")], width: 120, narrowAt: 60 }));
  // The first project's rail runs on past its item; the last closes into the
  // section's line, and its item closes under it.
  assert.deepEqual(glyphs, ["├─", "│ └─", "└─", "  └─"]);
});

test("a pull request's project heads its rows once, and its owner stays on hover", () => {
  const pane = paneFrom(snapshot({
    prs: { state: "ready", errors: [], prs: [
      { repo: "owner/an-enterprise-project-name", number: 1, title: "t", branch: "b", head: "h",
        is_draft: false, checks: "pass", mine: true },
      { repo: "other/team-project", number: 2, title: "t", branch: "b", head: "h",
        is_draft: false, checks: "pass", mine: false },
      // A reading made before the reader carried this reads as not the person's,
      // and the owner is still the part that tells no two rows apart.
      { repo: "owner/older-reading", number: 3, title: "t", branch: "b", head: "h",
        is_draft: false, checks: "pass" },
    ] },
  }), options());
  const rows = group(pane, "Pull requests").rows;
  // The project is the tree's root now: named once above its rows, so the row
  // carries only what tells it from its siblings.
  assert.deepEqual(rows.map((row) => row.project?.root),
                   ["other/team-project", "owner/an-enterprise-project-name",
                    "owner/older-reading"]);
  // The root is not a row of its own: three items draw three rows.
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.project?.last), [false, false, true]);
  assert.deepEqual(rows[1]?.project?.count, 1);
  // The branch still follows on the same line.
  assert.deepEqual(rows[0]?.meta, [{ text: "b" }]);
  // Nothing the row cut is lost: the whole repository is on its hover card.
  assert.deepEqual(rows[0]?.note, { text: "other/team-project", dim: true });
});

test("a skill row carries its worst finding and a newly noticed one is marked", () => {
  const item = { name: "one", target: "~/skills/one", verdict: "flagged", score: 0.4,
                 hash: "abc1234", issue: "high secret: looks like a key (a.py:4)" };
  const pane = paneFrom(snapshot({
    skills: { state: "ready", generated_at: NOW - 60, counts: {}, items: [item], new: [item],
              running: { done: 12, total: 40 }, errors: [] },
  }), options());
  const values = texts(pane);
  assert.equal(values.includes("* one"), true);
  assert.equal(values.includes("high secret: looks like a key (a.py:4)"), true);
  // The scan's progress is said once, on the status row, not again on the heading.
  assert.equal(values.some((value) => value.includes("scanning 12 of 40 changed folders")), true);
  assert.equal(values.some((value) => value.includes("scanning 12 / 40")), false);
  assert.equal(group(pane, "Skills").summary.some((slot) => slot.text.includes("scanning")), false);
  assert.equal(values.includes("1 need attention"), true);
});

const worktreesAtCeiling = {
  state: "ready" as const, cleaned: 0, errors: [],
  worktrees: [
    { name: "one", path: "/tmp/one", branch: "fix/one", state: "active" as const,
      merged: false, archived: false, held: false, cleanup_command: "", checked_at: NOW },
    { name: "two", path: "/tmp/two", branch: "fix/two", state: "active" as const,
      merged: false, archived: false, held: false, cleanup_command: "", checked_at: NOW },
    { name: "three", path: "/tmp/three", branch: "fix/three", state: "active" as const,
      merged: false, archived: false, held: false, cleanup_command: "", checked_at: NOW },
    { name: "four", path: "/tmp/four", branch: "fix/four", state: "active" as const,
      merged: false, archived: false, held: false, cleanup_command: "", checked_at: NOW },
  ],
};

test("a worktree group counts its states and omits the ones at zero", () => {
  const tree = (name: string, state: "active" | "held" | "unknown") => ({
    name, path: "/tmp/" + name, branch: "fix/" + name, state, merged: false, archived: false,
    held: state === "held" ? true : state === "unknown" ? null : false, cleanup_command: "clean",
    checked_at: NOW,
  });
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", cleaned: 3, errors: [],
                 worktrees: [tree("one", "active"), tree("two", "held"), tree("three", "held"),
                             tree("four", "unknown")] },
  }), options());
  const summary = group(pane, "Worktrees").summary.map((slot) => slot.text);
  assert.deepEqual(summary, ["4 checked out", "  1 active", "  2 held", "  1 unknown",
                             "  3 cleaned this week"]);
  assert.equal(summary.some((value) => value.includes("merged")), false);
});

test("a section past its ceiling offers a press that shows every row", () => {
  // Hover is the only way to see a withheld row, and a pointer is not on every
  // surface. The section that holds rows back carries a control, and pressing
  // it is what raises the ceiling for this session.
  const pane = paneFrom(snapshot({ worktrees: worktreesAtCeiling }),
                        options({ sections: { ...options().sections,
                                              worktrees: { visible: true, collapsed: false,
                                                           maxRows: 1 } } }));
  const worktrees = group(pane, "Worktrees");
  assert.equal(worktrees.rows.length, 2);
  assert.equal(worktrees.held?.length, 3);
  assert.equal(worktrees.summary.some((slot) => slot.text.includes("3 more")), true);
  const control = worktrees.rows[worktrees.rows.length - 1];
  assert.equal(control?.title, "show all rows");
  assert.equal(control?.press?.key, SHOW_ALL_PREFIX + "worktrees");
});

test("a section a person showed in full draws every row and states no count", () => {
  const pane = paneFrom(snapshot({ worktrees: worktreesAtCeiling }),
                        options({ sections: { ...options().sections,
                                              worktrees: { visible: true, collapsed: false,
                                                           maxRows: 1 } },
                                  shownAll: { worktrees: true } }));
  const worktrees = group(pane, "Worktrees");
  assert.equal(worktrees.rows.length, 4);
  assert.equal(worktrees.held, undefined);
  assert.equal(worktrees.summary.some((slot) => slot.text.includes("more")), false);
});

test("a worktree row sits under its project, named there rather than repeated", () => {
  // Two projects on one machine draw the same branch name; the root above the
  // row is what tells them apart, and the row keeps only what differs.
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", cleaned: null, errors: [], worktrees: [
      { name: "lane", path: "/tmp/lane", project: "llm-fleet", project_root: "/projects/llm-fleet",
        branch: "fix/one", state: "active", merged: false, archived: false, held: false,
        cleanup_command: "clean", checked_at: NOW },
    ] },
  }), options());
  const [row] = group(pane, "Worktrees").rows;
  assert.deepEqual(row?.meta, [{ text: "llm-fleet" }, { text: " · fix/one" }]);
  assert.deepEqual(row?.project, { root: "/projects/llm-fleet", count: 1, last: true });
});

test("every reader error reaches the warnings group once", () => {
  const error = { source: "jobs:primary", reason: "exit 3" };
  const pane = paneFrom(snapshot({
    roster: { state: "failed", jobs: [], interactive: {}, providers: {}, errors: [error],
              sources: { jobs: "failed", interactive: "failed" } },
    prs: { state: "failed", prs: [], errors: [error, { source: "prs:owner/one", reason: "exit 4" }] },
  }), options());
  const warnings = group(pane, "Warnings");
  assert.equal(warnings.rows.length, 2);
  assert.equal(warnings.summary[0]?.text, "2 sources");
  // The roster answers for job rows and session counts together, so a failure
  // there is one unreadable source, not two.
  assert.equal(pane.warning?.text, "2 sources unavailable");
});

test("the header keeps test outcomes and check failures apart", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [{ ...JOB, state: "working" },
                                     { ...JOB, id: "b", state: "blocked" }],
              interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
    trials: { state: "ready", running: [], errors: [], history: null, recent: [
      { key: "r", repo: "r", branch: "b", change_state: "TRYING", at: NOW, is_green: false,
        passed: 1, failed: 1, errors: 0, skipped: 0 }] },
    prs: { state: "ready", errors: [], prs: [
      { repo: "owner/one", number: 1, title: "t", branch: "b", head: "h", is_draft: false,
        checks: "fail" }] },
  }), options());
  const counts = pane.counts.map((slot) => slot.text);
  assert.deepEqual(counts, ["1 working", "  1 waiting", "  1 failed"]);
  const prSummary = group(pane, "Pull requests").summary.map((slot) => slot.text);
  assert.deepEqual(prSummary, ["1 open", "  1 failing"]);
});

test("a count is never invented for a group that has none", () => {
  const pane = paneFrom(snapshot(), options());
  const stated: Record<string, string> = {
    Running: "0 running", Trials: "0 in flight", "Pull requests": "0 open",
    Worktrees: "0 checked out", Skills: "0 need attention",
  };
  for (const [title, expected] of Object.entries(stated)) {
    assert.equal(group(pane, title).summary[0]?.text, expected, title);
  }
  const values = texts(pane);
  // A zero count is a reading; a sentence claiming there is nothing to show
  // without having read would not be.
  assert.equal(values.includes("No open pull requests"), false);
});

test("the same entity is not counted under two headings", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [JOB], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
  }), options());
  const counts = pane.counts.map((slot) => slot.text);
  assert.deepEqual(counts, ["0 working", "  1 waiting"]);
  assert.equal(counts.some((value) => value.includes("1 failed")), false);
});

test("an empty warning list claims no source was read", () => {
  const pane = paneFrom(snapshot(), options());
  const found = group(pane, "Warnings");
  assert.equal(found.state, "ready");
  assert.deepEqual(found.summary, [{ text: "none", dim: true }]);
  const values = texts(pane);
  assert.equal(values.some((value) => value.includes("No warnings in the configured sources")),
               false);
});

test("the keys section always lists the bindings the pane draws", () => {
  // It draws data no reader provides, so it is never empty and never claims a
  // source was read: the four bindings are this pane's own, and a keys section
  // that says "none" is a section whose rows were never handed to it.
  const pane = paneFrom(snapshot(), options());
  const found = group(pane, "Keys");
  assert.equal(found.state, "ready");
  assert.equal(found.rows.length >= 4, true);
  assert.deepEqual(found.summary, [{ text: "4 keys" }, { text: "  5 tips", dim: true }]);
  const values = texts(pane);
  assert.equal(values.some((value) => value.includes("No keys in the configured sources")), false);
  for (const does of ["close this pane", "fold every section", "open every section"]) {
    assert.equal(values.some((value) => value.includes(does)), true, does);
  }
});

test("this session's figures are drawn, and a figure nobody sent is not a zero", () => {
  const built = snapshot({ session: {
    state: "ready", absent: ["spendUsedPercent"], parameters: { effort: "high" },
    costUsd: 12.5, durationMs: 900_000, apiDurationMs: 300_000, linesAdded: 420,
    linesRemoved: 88, inputTokens: 180_000, outputTokens: 24_000, remainingPercent: 42.5,
    windowSize: 200_000, cacheReadTokens: 900_000, cacheCreationTokens: 20_000,
    fiveHourUsedPercent: 61, fiveHourResetsAt: NOW + 600, sevenDayUsedPercent: 22,
    model: "claude-opus-5-5", modelName: "Opus 5.5", outputStyle: "concise", version: "2.0.1",
    errors: [] } });
  const drawn = group(paneFrom(built, options()), "This session");
  const titles = drawn.rows.map((row) => row.title);
  assert.deepEqual(titles, ["Opus 5.5", "Spent on this session", "Through the cache",
                            "Context window", "Five-hour window", "Weekly window"]);
  // The figures a person looks at their own session for lead it, as tiles, with
  // the machine's day beside the session's own spend.
  assert.deepEqual(drawn.tiles, [{ label: "Cost (API)", value: "$12.50" },
                                 { label: "24h routed", value: "not reported", color: "subtle" },
                                 { label: "Context", value: "42.5% left" },
                                 { label: "Time", value: "15m 0s" }]);
  const values = texts(paneFrom(built, options()));
  for (const figure of ["$12.50", "15m 0s", "5m 0s in calls", " \u00b7 +420 -88 lines",
                        "42.5% left", "61% used", "22% used", "resets in 10m",
                        " \u00b7 effort high", " \u00b7 style concise"]) {
    assert.equal(values.includes(figure), true, figure);
  }
  // Every bar in the section runs the width of its card: none is held to the
  // configured short length, which is for rows that state counts beside a bar.
  for (const row of drawn.rows) {
    assert.equal(row.bar?.cells, undefined, row.title);
  }
  // A spend limit nobody reported draws no row at all, rather than a row at 0%
  // of a limit that may not exist.
  assert.equal(values.some((value) => value.includes("Spend limit")), false);
  // The context bar is the window's own measurement: what is left against the
  // whole of it, not the token totals wearing its name.
  const context = drawn.rows.find((row) => row.title === "Context window");
  assert.deepEqual(context?.bar && { done: context.bar.done, total: context.bar.total },
                   { done: 57.5, total: 100 });
});

test("a subscription session is metered by its windows, not drawn as having spent nothing", () => {
  // The host bills a subscription a flat fee, so its usage cost is nought. A
  // "$0.00" there is a figure the host did not measure, and what that person
  // watches is the five-hour and weekly windows.
  const built = snapshot({ session: {
    state: "ready", absent: [], parameters: {}, costUsd: 0, remainingPercent: 42.5,
    fiveHourUsedPercent: 61, fiveHourResetsAt: NOW + 600, sevenDayUsedPercent: 22,
    model: "claude-opus-5-5", errors: [] } });
  const drawn = group(paneFrom(built, options()), "This session");
  assert.deepEqual(drawn.tiles, [{ label: "5-hour", value: "61% used" },
                                 { label: "Weekly", value: "22% used" },
                                 { label: "Context", value: "42.5% left" }]);
  const values = texts(paneFrom(built, options()));
  assert.equal(values.includes("$0.00"), false);
  assert.ok(drawn.summary.some((slot) => slot.text.includes("61% 5h")), "the heading states the window");
  assert.ok(drawn.summary.some((slot) => slot.text.includes("22% wk")));
});

test("a model the engine names only by identifier is said once, the way a person says it", () => {  const built = snapshot({ session: { state: "ready", absent: [], parameters: {},
                                      model: "claude-opus-5-5", errors: [] } });
  const [first] = group(paneFrom(built, options()), "This session").rows;
  assert.equal(first?.title, "opus 5.5");
  assert.equal(first?.meta.some((slot) => slot.text.includes("claude-opus-5-5")), false);
  assert.equal(texts(paneFrom(built, options())).includes("claude-opus-5-5"), false);
});

test("a session read that failed keeps no rows and names its reason", () => {
  // The rows are built from the payload, and a payload nobody could read has
  // none. Rows kept here made `partial` call a failed read a stale one, drawn
  // with an age beside it and a claim that two things were observed, while the
  // reason it failed reached the pane nowhere at all.
  const failed = snapshot({ session: { state: "failed", absent: [], parameters: {},
                                       errors: [{ source: "session",
                                                  reason: "the payload is larger than the configured limit" }] } });
  const pane = paneFrom(failed, options());
  const drawn = group(pane, "This session");
  assert.equal(drawn.state, "failed");
  assert.deepEqual(drawn.rows, []);
  assert.equal(drawn.observed, 0);
  const values = texts(pane);
  assert.equal(values.some((value) => value.includes("observed")), false);
  assert.equal(values.some((value) => value.includes("Spent on this session")), false);
  // The reason reaches the pane twice over: as the section's own failure line
  // and as a row in the warnings list, which is every reader's errors in one
  // place. A source that could not be read is not a pane with no problem on it.
  assert.equal(values.some((value) =>
    value.includes("the payload is larger than the configured limit")), true);
  assert.equal(allErrors(failed).length, 1);
  assert.deepEqual(unreadableSources(failed), ["session"]);
  assert.equal(group(pane, "Warnings").rows.length, 1);
  assert.equal(pane.warning?.text, "1 source unavailable");
});

test("a figure the payload half carried is drawn as the half it carried", () => {
  // Every one of these was a nought printed for a figure nobody sent, or a
  // reported figure hidden behind a missing companion.
  const lines = snapshot({ session: { state: "ready", absent: ["linesRemoved"],
                                     parameters: {}, linesAdded: 40, errors: [] } });
  const drawn = texts(paneFrom(lines, options()));
  assert.equal(drawn.includes("+40 lines"), true);
  assert.equal(drawn.some((value) => value.includes("-0")), false);

  const output = snapshot({ session: { state: "ready", absent: ["outputTokens"],
                                       parameters: {}, inputTokens: 180_000,
                                       errors: [] } });
  const out = texts(paneFrom(output, options()));
  assert.equal(out.includes("180k in"), true);
  assert.equal(out.some((value) => value.includes("0 out")), false);

  // A percentage with no window size behind it is still a percentage: the bar
  // is a share of a whole by definition, and the row names the piece it has.
  const share = snapshot({ session: { state: "ready", absent: ["windowSize", "fiveHourUsedPercent"],
                                      parameters: {}, remainingPercent: 42.5, errors: [] } });
  const pane = paneFrom(share, options());
  const row = group(pane, "This session").rows.find((entry) => entry.title === "Context window");
  assert.equal(row?.slot[0]?.text, "42.5% left");
  // And the heading states the same figure at the same precision, so the two do
  // not read as two readings that disagree.
  assert.equal(texts(pane).includes("42.5% context left"), true);
});

test("a cost below a cent is not drawn as nothing", () => {
  const tiny = snapshot({ session: { state: "ready", absent: [], parameters: {},
                                     costUsd: 0.00004, errors: [] } });
  const drawn = texts(paneFrom(tiny, options()));
  assert.equal(drawn.includes("~<$0.01"), true);
  assert.equal(drawn.some((value) => value === "$0.00"), false);
  // A figure nobody reported is a tile that says so, never a nought. The
  // machine's 24-hour spend sits second, beside the session's own cost.
  const unread = group(paneFrom(tiny, options()), "This session").tiles ?? [];
  assert.deepEqual(unread.map((tile) => tile.label),
                   ["Cost (API)", "24h routed", "Context", "Time"]);
  assert.deepEqual(unread.map((tile) => tile.value),
                   ["~<$0.01", "not reported", "not reported", "not reported"]);
  assert.equal(unread[1]?.color, "subtle");
  // A session that really has spent nothing still says so.
  const zero = snapshot({ session: { state: "ready", absent: [], parameters: {},
                                     costUsd: 0, errors: [] } });
  assert.equal(texts(paneFrom(zero, options())).includes("$0.00"), true);
});

test("a session section says what its own emptiness means", () => {
  // Every section states its own case or the pane falls back to a sentence
  // built from the section's name, which for this one read "No this session
  // here." A section the pane has a name for has a sentence for it too.
  const values = texts(paneFrom(snapshot(), options()));
  assert.equal(values.includes("Waiting for the engine to report this session's figures."), true);
  assert.equal(values.some((value) => value.startsWith("No this session")), false);
  const off = options();
  off.sections.session = { visible: true, collapsed: false };
  const disabled = snapshot({ session: { state: "disabled", absent: [], parameters: {},
                                         errors: [] } });
  // The engine is this section's source, so the old payload source being off
  // is never drawn as the section being switched off.
  assert.equal(texts(paneFrom(disabled, off))
                 .includes("Waiting for the engine to report this session's figures."),
               true);
  assert.equal(texts(paneFrom(disabled, off)).some((value) => value.includes("switched off")),
               false);
});

test("a session nobody has measured says so rather than reporting nothing spent", () => {
  // The renderer may never have run. That is not a session that spent $0.00.
  const unread = snapshot({ session: { state: "unavailable", absent: [], parameters: {},
                                       errors: [{ source: "session",
                                                  reason: "the renderer has not written a payload" }] } });
  const drawn = group(paneFrom(unread, options()), "This session");
  assert.equal(drawn.state, "unavailable");
  assert.equal(drawn.rows.length, 0);
  const values = texts(paneFrom(unread, options()));
  assert.equal(values.includes("$0.00"), false);
  assert.equal(values.some((value) => value.includes("Could not read")), true);
  // A ready session whose payload carried everything but the cost names the
  // missing figure rather than drawing a zero in its place: the only figure
  // missing here is the spend, so the words can only have come from it.
  const partial = snapshot({ session: { state: "ready", absent: ["costUsd"],
                                        parameters: {}, modelName: "Opus 5.5",
                                        remainingPercent: 42.5, windowSize: 200_000,
                                        errors: [] } });
  const partialDrawn = texts(paneFrom(partial, options()));
  assert.equal(partialDrawn.includes("not reported"), true);
  assert.equal(partialDrawn.some((value) => value.includes("$")), false);
});

test("a section's configured title is what its heading says", () => {
  const renamed = options();
  renamed.sections.sessions = { title: "Live sessions", visible: true, collapsed: false };
  const pane = paneFrom(snapshot(), renamed);
  assert.equal(group(pane, "Live sessions").title, "Live sessions");
  assert.equal(pane.groups.some((entry) => entry.title === "Background sessions"), false);
  // A section nobody renamed keeps the name this build gives it, which is what
  // a reading from before titles travelled draws.
  const plain = options();
  plain.sections.sessions = { title: null, visible: true, collapsed: false };
  assert.equal(group(paneFrom(snapshot(), plain), "Background sessions").title,
               "Background sessions");
});

test("the configured row ceiling caps a section and says what it left out", () => {
  const items = [1, 2, 3, 4].map((index) => ({
    name: "skill-" + index, target: "a-target", verdict: "flagged",
    score: index, issue: "", hash: "h" + index,
  }));
  const built = snapshot({ skills: { state: "ready", items: items as never, new: [],
                                     running: null, counts: {}, generated_at: NOW,
                                     errors: [] } });
  const two = options({ geometry: { ...GEOMETRY, skillRows: 2 } });
  const group1 = group(paneFrom(built, two), "Skills");
  // The scan's own line leads, and the ceiling is on the findings under it.
  // The control that opens the rest follows them, so a count the scan held
  // back is one a press can open where no pointer is drawn.
  assert.equal(group1.rows.length, 4);
  assert.equal(group1.rows[0]?.title, "Last scan 0s ago");
  assert.equal(group1.rows[3]?.press?.key, SHOW_ALL_PREFIX + "skills");
  // The count beside the heading is of the scan, not of the rows drawn under it,
  // and the difference is stated rather than left for a reader to notice.
  assert.deepEqual(group1.summary.map((slot) => slot.text),
                   ["4 need attention", "  2 not shown"]);
  // A ceiling above the scan draws the whole scan and claims nothing was left out.
  const many = options({ geometry: { ...GEOMETRY, skillRows: 9 } });
  const group2 = group(paneFrom(built, many), "Skills");
  assert.equal(group2.rows.length, 5);
  assert.deepEqual(group2.summary.map((slot) => slot.text), ["4 need attention"]);
});

test("a trial verdict carries a meter of what it ran", () => {
  // A trial reporting eleven hundred passes and ten failures reads as a clean
  // run until the ten are a cell of a bar, so the trial rows carry the meter the
  // running rows carried and the two are read the same way.
  const built = snapshot({ trials: {
    state: "ready", running: [], history: null, errors: [],
    recent: [{ key: "r", repo: "example-repo", branch: "feat/one", change_state: "TRYING",
               at: NOW - 60, is_green: false, passed: 669, failed: 10, errors: 0,
               skipped: 2 }] } });
  const row = group(paneFrom(built, options()), "Trials").rows[0];
  assert.deepEqual(row?.bar && { done: row.bar.done, total: row.bar.total,
                                 failed: row.bar.failed, label: row.bar.label },
                   { done: 669, total: 679, failed: 10, label: null });
  // The counts are the slot's, so the bar says them once rather than twice.
  const drawn = renderedText(renderRow(row as never, 100, NARROW_AT));
  assert.equal(drawn.includes("669 passed"), true);
  assert.equal(drawn.includes("669 / 679"), false);

  // A trial that reported no outcome has no denominator, so it draws no meter
  // rather than a full one: a bar is a proportion, and there is none here.
  const empty = snapshot({ trials: {
    state: "ready", running: [], history: null, errors: [],
    recent: [{ key: "r", repo: "example-repo", branch: "feat/one", change_state: "TRYING",
               at: NOW - 60, is_green: true, passed: 0, failed: 0, errors: 0, skipped: 0 }] } });
  const none = group(paneFrom(empty, options()), "Trials").rows[0];
  assert.equal(none?.bar, undefined);
  // The counts beside it say the same thing rather than drawing a nought: a
  // trial that reported no outcome is not a trial that passed none, and "0
  // passed" in the passing color reads as a result.
  assert.deepEqual(none?.slot, [{ text: "No counts yet", color: "warning" }]);
  const noneDrawn = renderedText(renderRow(none as never, 100, NARROW_AT));
  assert.equal(noneDrawn.includes("0 passed"), false);
});

test("the trials strip is the window the reading carried", () => {
  const history = { label: "Last 12 hours", hours: 12,
                    cells: [{ outcomes: 2, failed: 0 }, { outcomes: 1, failed: 1 }],
                    outcomes: 3, failed: 1 };
  const built = snapshot({ trials: { state: "ready", running: [], recent: [],
                                     history, errors: [] } });
  assert.deepEqual(group(paneFrom(built, options()), "Trials").history, history);
  // A reading that carried none draws none, and does not invent a period.
  assert.equal(group(paneFrom(snapshot(), options()), "Trials").history, null);
  // The window's figures are the strip's and nowhere else. On the heading as
  // well they were one section making the same claim twice, beside a count of
  // branches that is not the same subject.
  const heading = group(paneFrom(built, options()), "Trials").summary;
  // A count that comes and goes keeps its place as a quiet zero.
  assert.deepEqual(heading.map((slot) => slot.text.trim()), ["0 in flight", "0 running"]);
  assert.equal(heading[1]?.dim, true);
  const captions = renderedText(renderPane(paneFrom(built, options())));
  assert.equal(captions.includes("Last 12 hours"), true);
  assert.equal(captions.includes(" 3 outcomes"), true);
  assert.equal(captions.includes("  1 failed"), true);
});

test("a bar is drawn at the length the configuration declares", () => {
  const run = { key: "one", repo: "a-repo", branch: "b", label: "a run", display: "a run",
                done: 40, total: 80, failed: 0, first_failure: "", elapsed: 60,
                eta_minutes: null, state: "running", stopped: false };
  const short = options({ geometry: { ...GEOMETRY, progressCells: 10 } });
  const built = paneFrom(snapshot({ progress: { state: "ready", runs: [run] as never,
                                                errors: [] } }), short);
  const row = group(built, "Running").rows[0];
  assert.equal(row?.bar?.cells, 10);
  const bars = renderedText(renderRow(row as never, 100, NARROW_AT))
    .filter((value) => /^\u2501+$/.test(value));
  assert.equal(bars.join("").length, 10);
});

test("a section's configured legend reaches the pane it is drawn by", () => {
  // Every section draws its own legend, from the choice the pane was handed. A
  // legend configured and drawn by one section only is a legend the other seven
  // were promised and never got.
  const stated = options();
  stated.sections.sessions = { visible: true, collapsed: false,
                               legend: "Background sessions by state." };
  stated.sections.worktrees = { visible: true, collapsed: false,
                                legend: "Worktrees by preservation state." };
  const values = texts(paneFrom(withRows(), stated));
  for (const legend of ["Background sessions by state.", "Worktrees by preservation state."]) {
    assert.equal(values.includes(legend), true, legend);
  }
  // A section nobody gave one draws none, and not the legend of the section
  // above it: the pane hands each group its own, in the one place that knows
  // which section it is.
  const plain = options();
  plain.sections.sessions = { visible: true, collapsed: false, legend: "Sessions." };
  const drawn = texts(paneFrom(withRows(), plain));
  assert.equal(drawn.includes("Sessions."), true);
  assert.equal(drawn.includes("Worktrees by preservation state."), false);
  assert.equal(drawn.includes("Background sessions by state."), false);
  // A section with nothing in it and nothing wrong draws no legend either: it
  // is one line, and a legend under it is the second line that drawing it as a
  // line was meant to save.
  const empty = texts(paneFrom(snapshot(), stated));
  assert.equal(empty.includes("Background sessions by state."), false);
  assert.equal(empty.includes("Worktrees by preservation state."), false);
});

/** A reading with a row in the two sections a legend is read off. */
function withRows(): Snapshot {
  return snapshot({
    roster: { state: "ready", interactive: {}, providers: {},
              sources: { jobs: "ready", interactive: "ready" },
              errors: [],
              jobs: [{ id: "j1", name: "One-DSK", tool: "codex", state: "working",
                       needs: null, suggested_reply: null, detail: null, fan: null,
                       session: null, age: 60 } as never] },
    worktrees: { state: "ready", cleaned: null, errors: [],
                 worktrees: [{ name: "one", path: "/tmp/one", branch: "feat/one",
                               state: "active", merged: false, archived: false, held: null,
                               error: null, cleanup_command: "", change_state: null,
                               change_owner: null, change_updated_at: null,
                               checked_at: NOW, recheck_error: null } as never] },
  });
}

test("the keys the pane lists are the keys its own controls carry", () => {
  // The pane's own section is the one place that says what a key does, so a
  // binding listed there has to come off a control this pane draws. A listed key
  // the pane does not honour is worse than no list: it is a wrong instruction.
  const rebound = options({ keys: { tipsEnabled: true, tips: ["one tip"],
                                    close: "q", collapse: "z", expand: "a" } });
  const pane = paneFrom(snapshot(), rebound);
  assert.deepEqual((pane.controls ?? []).map((item) => item.hotkey), ["q", "z", "a"]);
  const listed = group(pane, "Keys").rows.map((row) => row.title);
  assert.deepEqual(listed, ["q", "z", "a", "1-9", "one tip"]);
});

test("tips turned off leaves the bindings standing", () => {
  // The tips are advice about the prompt and the bindings are this pane, so a
  // person who turned the tips off still has the keys.
  const quiet = options({ keys: { ...DEFAULT_KEYS, tipsEnabled: false } });
  const found = group(paneFrom(snapshot(), quiet), "Keys");
  assert.deepEqual(found.rows.map((row) => row.title).slice(0, 4),
                   [DEFAULT_KEYS.close, DEFAULT_KEYS.collapse, DEFAULT_KEYS.expand, "1-9"]);
  assert.deepEqual(found.summary, [{ text: "4 keys" }, { text: "  tips off", dim: true }]);
});

test("a hidden section is left out and the rest keep their configured order", () => {
  const hidden = options();
  hidden.sections.prs = { visible: false, collapsed: false };
  hidden.sectionOrder = ["prs", "sessions", "running"];
  const pane = paneFrom(snapshot(), hidden);
  assert.deepEqual(pane.groups.map((entry) => entry.title),
                   ["Background sessions", "Running"]);
});

test("a collapsed section keeps its rows out of the rendering and its summary in it", () => {
  const collapsed = options();
  collapsed.sections.worktrees = { visible: true, collapsed: true };
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", cleaned: null, errors: [], worktrees: [
      { name: "lane", path: "/tmp/lane", branch: "x", state: "active", merged: false,
        archived: false, held: false, cleanup_command: "" }] },
  }), collapsed);
  const values = texts(pane);
  assert.equal(values.includes("lane"), false);
  assert.equal(values.includes("1 checked out"), true);
});

test("a worktree with no configured cleanup copies nothing and says why", () => {
  const refused: string[] = [];
  const copied: string[] = [];
  const pane = paneFrom(snapshot({
    worktrees: { state: "ready", cleaned: null, errors: [], worktrees: [
      { name: "lane", path: "/tmp/lane", branch: "x", state: "active", merged: false,
        archived: false, held: false, cleanup_command: "" }] },
  }), options({ actions: { copy: (text) => { copied.push(text); },
                           refuse: (why) => { refused.push(why); }, reply: () => undefined } }));
  const row: Row | undefined = group(pane, "Worktrees").rows[0];
  assert.equal(row?.meta.some((slot) => slot.text.includes("cleanup")), false);
  row?.press?.onPress();
  assert.deepEqual(copied, []);
  assert.deepEqual(refused, ["no cleanup for lane: no cleanup command is configured (commands.cleanup)"]);
});

test("every error is listed once even when two readers report the same one", () => {
  const shared = { source: "jobs:primary", reason: "exit 3" };
  const counted = allErrors(snapshot({
    roster: { state: "failed", jobs: [], interactive: {}, providers: {}, errors: [shared],
              sources: { jobs: "failed", interactive: "failed" } },
    prs: { state: "failed", prs: [], errors: [shared], },
  }));
  assert.deepEqual(counted, [shared]);
});

test("a row that is in a state draws a dot in that state's color", () => {
  // The dot is the one thing on a row that carries a verdict without words, so
  // a pane whose rows never carry a state draws a quiet dot on every row and
  // says nothing at all. Reading the color off the drawn tree is what makes
  // this a case about the pane rather than about the dot in isolation.
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [JOB], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
    worktrees: { state: "ready", cleaned: null, errors: [], worktrees: [
      { name: "pane-metrics", path: "/tmp/w", branch: "task/pane-metrics", state: "active",
        merged: false, archived: false, held: false, change_owner: "peer",
        change_updated_at: NOW - 30, cleanup_command: "", checked_at: NOW },
    ] },
  }), options());
  const row = group(pane, "Background sessions").rows[0];
  assert.equal(row?.state, "blocked", "the job's own state is not on the row");
  const colors = new Set(colorsIn(renderPane({ ...pane })));
  // A blocked job is a warning, and an active worktree is a success: the two
  // together prove the dot is colored by the row rather than by one default.
  assert.ok(colors.has("warning"), [...colors].join(","));
  assert.ok(colors.has("success"), [...colors].join(","));
});

test("the pane renders with only Box and Text from any snapshot", () => {
  const pane = paneFrom(snapshot({
    roster: { state: "ready", jobs: [JOB], interactive: {}, errors: [], providers: {},
              sources: { jobs: "ready", interactive: "ready" } },
  }), options());
  assert.deepEqual(
    [...new Set(renderedText(renderPane({ ...pane })).length ? ["Box", "Text"] : [])],
    ["Box", "Text"]);
});

/** What a press asked for, recorded in place of the entry that would act on it. */
function recorder() {
  const done: { copied: [string, string][]; refused: string[]; replied: [string, string][];
                 resent: string[]; cleared: number; unread: string[] } =
    { copied: [], refused: [], replied: [], resent: [], cleared: 0, unread: [] };
  const actions = {
    copy: (text: string, what: string) => { done.copied.push([text, what]); },
    refuse: (why: string) => { done.refused.push(why); },
    reply: (job: { id: string }, typed: string) => { done.replied.push([job.id, typed]); },
    resend: (job: { id: string }) => { done.resent.push(job.id); },
    clearAnswered: () => { done.cleared += 1; },
    clearUnreadable: (job: { id: string }) => { done.unread.push(job.id); },
  };
  return { done, actions };
}

function roster(jobs: unknown[], interactive: Record<string, number> = {}): Snapshot["roster"] {
  return { state: "ready", jobs: jobs as never, interactive, errors: [], providers: {},
           sources: { jobs: "ready", interactive: "ready" } };
}

const LIVE = { ...JOB, id: "live", name: "Working on it", state: "working", activity: "busy",
               needs: null, suggested_reply: null, attach_command: "CLAUDE_CONFIG_DIR=/h claude attach live" };

test("a live job's title copies the line that opens it, and one without a line says why", () => {
  const { done, actions } = recorder();
  const pane = paneFrom(snapshot({ roster: roster([LIVE, { ...LIVE, id: "old", name: "Old reading",
                                                           attach_command: null }]) }),
                        options({ actions }));
  const rows = group(pane, "Background sessions").rows;
  assert.equal(rows[0]?.press?.key, "fleet.job.primary.live");
  rows[0]?.press?.onPress();
  assert.deepEqual(done.copied, [["CLAUDE_CONFIG_DIR=/h claude attach live",
                                  "the command that opens Working on it"]]);
  rows[1]?.press?.onPress();
  assert.equal(done.refused.length, 1);
  assert.ok(done.refused[0]?.startsWith("no attach command for Old reading"), done.refused[0]);
  // The section says what a press on a session does.
  assert.deepEqual(group(pane, "Background sessions").notes,
                   [[{ text: "Press a session to copy the command that opens it.", dim: true }]]);
});

test("a waiting job offers a reply field where the surface draws one, and sends through the entry", () => {
  const { done, actions } = recorder();
  const pane = paneFrom(snapshot({ roster: roster([JOB]) }), options({ actions, fields: true }));
  const row = group(pane, "Background sessions").rows[0];
  assert.equal(row?.field?.key, "fleet.reply.primary.abc");
  assert.equal(row?.field?.placeholder, "Enter alone sends the suggested reply");
  assert.equal(row?.field?.submitLabel, "send");
  assert.deepEqual(row?.lines?.[0]?.slots.map((slot) => slot.text), ["suggests:", "the first"]);
  // With a field to send from, the suggestion is words, not a second control.
  assert.equal(row?.lines?.[0]?.press, undefined);
  row?.field?.onSubmit("go ahead");
  assert.deepEqual(done.replied, [["abc", "go ahead"]]);
});

test("a job with no suggestion asks for a reply to be typed", () => {
  const { actions } = recorder();
  const pane = paneFrom(snapshot({ roster: roster([{ ...JOB, suggested_reply: null }]) }),
                        options({ actions, fields: true }));
  const row = group(pane, "Background sessions").rows[0];
  assert.equal(row?.field?.placeholder, "type a reply");
  assert.equal(row?.lines, undefined);
});

test("where no field is drawn, or no session can be sent to, the suggestion is copied on a press", () => {
  for (const [fields, session] of [[false, "1234abcd-ffff"], [true, null]] as const) {
    const { done, actions } = recorder();
    const pane = paneFrom(snapshot({ roster: roster([{ ...JOB, session_id: session }]) }),
                          options({ actions, fields }));
    const row = group(pane, "Background sessions").rows[0];
    assert.equal(row?.field, undefined);
    const line = row?.lines?.[0];
    assert.equal(line?.press?.key, "fleet.suggest.primary.abc");
    assert.equal(line?.slots.at(-1)?.text, " · press to copy");
    line?.press?.onPress();
    assert.deepEqual(done.copied, [["the first", "the reply Review adapter behavior suggests"]]);
  }
});

test("a job replied to is not offered the field again, and says what to do if it stays waiting", () => {
  const { actions } = recorder();
  const pane = paneFrom(snapshot({ roster: roster([JOB]) }),
                        options({ actions, fields: true, replied: [replyKey(JOB as never)] }));
  const row = group(pane, "Background sessions").rows[0];
  assert.equal(row?.field, undefined);
  assert.deepEqual(row?.lines?.map((line) => line.slots[0]?.text),
                   ["replied; if it stays waiting, press the job to open it"]);
  // The key is the question: the same job asking something new is asked again,
  // even when it was answered and blocked again between two readings, so the
  // time it began waiting never moved.
  const again = paneFrom(snapshot({ roster: roster([{ ...JOB, needs_hash: "hash-next" }]) }),
                         options({ actions, fields: true, replied: [replyKey(JOB as never)] }));
  assert.notEqual(group(again, "Background sessions").rows[0]?.field, undefined);
  // And the same question in a later spell of waiting is still the one answered.
  const later = paneFrom(snapshot({ roster: roster([{ ...JOB, since: NOW - 5 }]) }),
                         options({ actions, fields: true, replied: [replyKey(JOB as never)] }));
  assert.equal(group(later, "Background sessions").rows[0]?.field, undefined);
});

test("what a reply sends: the typed words as typed, else the suggestion, else nothing", () => {
  // A reply is the person's words: spacing and line breaks are part of them.
  assert.equal(replyText("  yes  ", "no"), "  yes  ");
  assert.equal(replyText("line one\n  line two\n", "no"), "line one\n  line two\n");
  assert.equal(replyText("   ", "the first"), "the first");
  assert.equal(replyText(" \n\t", "the first"), "the first");
  assert.equal(replyText("", null), null);
  assert.equal(replyText("", "  "), null);
  assert.equal(replyKey(JOB as never), "primary:abc:1234abcd-ffff:hash-which-source");
  assert.equal(replyKey({ ...JOB, since: null } as never), "primary:abc:1234abcd-ffff:hash-which-source");
  assert.equal(replyKey({ ...JOB, needs_hash: null } as never), "primary:abc:1234abcd-ffff:");
  assert.equal(replyKey({ ...JOB, session_id: null } as never), "primary:abc::hash-which-source");
});

test("a job restarted into another session asking the same words is offered the field again", () => {
  const { actions } = recorder();
  const restarted = { ...JOB, session_id: "5678abcd-eeee" };
  const pane = paneFrom(snapshot({ roster: roster([restarted]) }),
                        options({ actions, fields: true, replied: [replyKey(JOB as never)] }));
  assert.notEqual(group(pane, "Background sessions").rows[0]?.field, undefined);
});

test("replies paused for too many held markers say why, offer to clear the answered ones, and draw no field", () => {
  const { done, actions } = recorder();
  const pane = paneFrom(snapshot({ roster: roster([JOB]) }),
                        options({ actions, fields: true,
                                  paused: { kind: "full", reason: "256 replies are held for jobs still waiting" } }));
  const row = group(pane, "Background sessions").rows[0];
  assert.equal(row?.field, undefined);
  const line = row?.lines?.[0];
  assert.equal(line?.slots[0]?.text, "replies are paused: 256 replies are held for jobs still waiting");
  assert.equal(line?.press?.key, "fleet.prune.primary.abc");
  assert.equal(line?.press?.label, "Clear answered replies");
  line?.press?.onPress();
  assert.equal(done.cleared, 1);
});

test("replies paused by an unsafe lock name the lock and its fix, masked, with no press, and keep the field", () => {
  const { actions } = recorder();
  const pane = paneFrom(snapshot({ roster: roster([JOB]) }),
                        options({ actions, fields: true,
                                  paused: { kind: "lock",
                                            reason: "reply-answers is a link; remove the link token: abc123def456" } }));
  const row = group(pane, "Background sessions").rows[0];
  const line = row?.lines?.[0];
  assert.equal(line?.slots[0]?.text.startsWith("replies are paused: reply-answers is a link; remove the link"),
               true);
  assert.equal(line?.slots.some((slot) => slot.text.includes("abc123def456")), false);
  assert.equal(line?.press, undefined);
  // A retry once the lock is fixed is how the pause ends, so the field stays.
  assert.notEqual(row?.field, undefined);
});

test("a paused pane leaves a job's own reply state as it stands", () => {
  const { actions } = recorder();
  const paused = { kind: "full", reason: "3 replies are held for jobs still waiting" };
  const sent = paneFrom(snapshot({ roster: roster([{ ...JOB, reply: { state: "sent", at: NOW - 9 } }]) }),
                        options({ actions, fields: true, paused }));
  assert.deepEqual(group(sent, "Background sessions").rows[0]?.lines?.map((line) => line.slots[0]?.text),
                   ["replied; if it stays waiting, press the job to open it"]);
});

test("a reply the machine recorded is drawn where it stands: sent, on its way, or maybe not sent", () => {
  const { done, actions } = recorder();
  const drawn = (reply: unknown, extra: Record<string, unknown> = {}) =>
    group(paneFrom(snapshot({ roster: roster([{ ...JOB, reply }]) }),
                   options({ actions, fields: true, replyPendingSeconds: 120, ...extra })),
          "Background sessions").rows[0];
  // Sent from any pane: replied, and no field.
  const sent = drawn({ state: "sent", at: NOW - 600 });
  assert.equal(sent?.field, undefined);
  assert.deepEqual(sent?.lines?.map((line) => line.slots[0]?.text),
                   ["replied; if it stays waiting, press the job to open it"]);
  // Pending inside its time: on its way, with nothing to press or type.
  const young = drawn({ state: "pending", at: NOW - 119 });
  assert.equal(young?.field, undefined);
  assert.deepEqual(young?.lines?.map((line) => [line.slots[0]?.text, line.press]),
                   [["a reply is on its way", undefined]]);
  // Pending past its time: it may not have been sent, and a press sends again.
  const stale = drawn({ state: "pending", at: NOW - 120 });
  assert.equal(stale?.field, undefined);
  const line = stale?.lines?.[0];
  assert.equal(line?.slots[0]?.text, "your reply may not have been sent");
  assert.equal(line?.press?.key, "fleet.resend.primary.abc");
  assert.equal(line?.press?.label, "Send again");
  line?.press?.onPress();
  assert.deepEqual(done.resent, ["abc"]);
  // A pending reply dated ahead of now never comes of age by waiting: it reads as
  // maybe not sent, with the press, as the helper's own stale release takes it.
  for (const ahead of [1, 3600, 1e300]) {
    const future = drawn({ state: "pending", at: NOW + ahead })?.lines?.[0];
    assert.equal(future?.slots[0]?.text, "your reply may not have been sent", String(ahead));
    assert.equal(future?.press?.label, "Send again", String(ahead));
  }
  // The configured time decides when a pending reply reads as maybe not sent.
  assert.equal(drawn({ state: "pending", at: NOW - 30 }, { replyPendingSeconds: 20 })
    ?.lines?.[0]?.slots[0]?.text, "your reply may not have been sent");
  // Cleared here, that pending reply no longer stands, and the field is back.
  const cleared = drawn({ state: "pending", at: NOW - 300 },
                        { cleared: [replyKey(JOB as never) + "@" + (NOW - 300)] });
  assert.notEqual(cleared?.field, undefined);
  // A newer pending reply to the same question is not the one cleared.
  const newer = drawn({ state: "pending", at: NOW - 5 },
                      { cleared: [replyKey(JOB as never) + "@" + (NOW - 300)] });
  assert.equal(newer?.lines?.[0]?.slots[0]?.text, "a reply is on its way");
});

test("a reply whose record does not read says so, takes no reply, and offers a press that clears it", () => {
  const { done, actions } = recorder();
  const drawn = (extra: Record<string, unknown> = {}, id: string | null = "7-1") =>
    group(paneFrom(snapshot({ roster: roster([{ ...JOB, reply: { state: "unreadable", at: null, id } }]) }),
                   options({ actions, fields: true, ...extra })),
          "Background sessions").rows[0];
  const row = drawn();
  // The marker holds the question, so no field: a send would be refused.
  assert.equal(row?.field, undefined);
  const line = row?.lines?.[0];
  assert.equal(line?.slots[0]?.text, "this reply's record could not be read");
  assert.equal(line?.slots[0]?.color, "warning");
  assert.equal(line?.press?.key, "fleet.unreadable.primary.abc");
  assert.equal(line?.press?.label, "Clear the record so a reply can be sent");
  line?.press?.onPress();
  assert.deepEqual(done.unread, ["abc"]);
  assert.deepEqual(done.resent, []);
  // Even a pane that sent to it says what stands on the machine: the record is unreadable.
  assert.equal(drawn({ replied: [replyKey(JOB as never)] })?.lines?.[0]?.slots[0]?.text,
               "this reply's record could not be read");
  // Cleared here, the field is back until a reading says otherwise.
  const clearedKey = replyKey(JOB as never) + "@unreadable:7-1";
  const cleared = drawn({ cleared: [clearedKey] });
  assert.notEqual(cleared?.field, undefined);
  assert.equal(cleared?.lines?.some((each) => each.press?.key === "fleet.unreadable.primary.abc"), false);
  // Another record for the same question that goes bad later is another file:
  // the earlier clearing does not hide it.
  const next = drawn({ cleared: [clearedKey] }, "9-4");
  assert.equal(next?.field, undefined);
  assert.equal(next?.lines?.[0]?.slots[0]?.text, "this reply's record could not be read");
  // A reading that does not name the file hides nothing on a clearing's word.
  const unnamed = drawn({ cleared: [replyKey(JOB as never) + "@unreadable:"] }, null);
  assert.equal(unnamed?.lines?.[0]?.press?.key, "fleet.unreadable.primary.abc");
});

test("a working job lists the subagent tasks it has open, and counts the rest", () => {
  const started = (seconds: number) => (NOW - seconds) * 1000;
  const fan = [
    { kind: "agent", label: "Read the tests", startedAt: started(90) },
    { kind: "shell", label: "finished", startedAt: started(300), doneAt: started(200) },
    { kind: "todo", label: "not started" },
    ...[1, 2, 3, 4].map((index) => ({ kind: "agent", label: "task " + index, startedAt: started(10) })),
  ];
  const pane = paneFrom(snapshot({ roster: roster([{ ...LIVE, fan }]) }), options());
  const lines = group(pane, "Background sessions").rows[0]?.lines ?? [];
  assert.deepEqual(lines.map((line) => line.slots.map((slot) => slot.text)),
                   [["agent", "Read the tests", " · 2m"], ["agent", "task 1", " · 10s"],
                    ["agent", "task 2", " · 10s"], ["agent", "task 3", " · 10s"],
                    ["1 more running"]]);
  assert.equal(lines[0]?.slots[0]?.color, "suggestion");
  // A job between turns runs nothing it started.
  const idle = paneFrom(snapshot({ roster: roster([{ ...LIVE, activity: "idle", fan }]) }), options());
  assert.equal(group(idle, "Background sessions").rows[0]?.lines, undefined);
});

test("how many subagent tasks are listed is the configured number, the rest counted", () => {
  const started = (seconds: number) => (NOW - seconds) * 1000;
  const fan = [1, 2, 3].map((index) => ({ kind: "agent", label: "task " + index,
                                          startedAt: started(10) }));
  const lines = (fanLines: number) => group(paneFrom(snapshot({ roster: roster([{ ...LIVE, fan }]) }),
                                                     options({ geometry: { ...GEOMETRY, fanLines } })),
                                            "Background sessions").rows[0]?.lines ?? [];
  assert.deepEqual(lines(1).map((line) => line.slots[0]?.text), ["agent", "2 more running"]);
  assert.deepEqual(lines(0).map((line) => line.slots[0]?.text), ["3 more running"]);
  assert.deepEqual(lines(3).map((line) => line.slots[1]?.text), ["task 1", "task 2", "task 3"]);
});

test("a subagent task started without a time is drawn running with no age", () => {
  // The state file marks a todo it started but did not date with 0, and one it
  // finished the same way: the first runs, the second is done.
  const fan = [{ kind: "todo", label: "Old plugin parity list", startedAt: 0 },
               { kind: "todo", label: "done already", startedAt: 0, doneAt: 0 }];
  const pane = paneFrom(snapshot({ roster: roster([{ ...LIVE, fan }]) }), options());
  const lines = group(pane, "Background sessions").rows[0]?.lines ?? [];
  assert.deepEqual(lines.map((line) => line.slots.map((slot) => slot.text)),
                   [["todo", "Old plugin parity list"]]);
});

test("finished jobs are drawn quiet under the live ones, newest first, without a bar", () => {
  const finished = (id: string, since: number) => ({ ...LIVE, id, name: "done " + id, state: "done",
                                                     since, detail: "left word " + id });
  const pane = paneFrom(snapshot({ roster: roster([finished("old", NOW - 7200), LIVE,
                                                   finished("new", NOW - 60)]) }), options());
  const sessions = group(pane, "Background sessions");
  assert.deepEqual(sessions.rows.map((row) => row.title), ["Working on it", "done new", "done old"]);
  const quiet = sessions.rows[1];
  assert.equal(quiet?.dim, true);
  assert.equal(quiet?.press, undefined);
  assert.equal(quiet?.bar, undefined);
  assert.deepEqual(quiet?.slot, [{ text: "done", dim: true }]);
  assert.equal(quiet?.meta.some((slot) => slot.text === " · finished 1m ago"), true);
  assert.equal(quiet?.detail, "left word new");
  assert.deepEqual(sessions.summary.map((slot) => slot.text), ["1 working", "  2 done"]);
  assert.equal(sessions.summary[1]?.dim, true);
});

test("the warnings say how many interactive sessions each provider runs, and what the band hides", () => {
  const pane = paneFrom(snapshot({ roster: roster([LIVE], { primary: 2, other: 1, none: 0 }) }),
                        options({ hidden: 3 }));
  const warnings = group(pane, "Warnings");
  assert.equal(warnings.rows.length, 0);
  assert.deepEqual(warnings.notes?.map((note) => note.map((slot) => slot.text)),
                   [["Interactive sessions:", "Provider A 2", " · other 1"],
                    ["3 hidden from the band; /llm-fleet unhide shows them again."]]);
  assert.deepEqual(warnings.summary.map((slot) => slot.text), ["none", "  3 interactive"]);
  // Notes are no warning: the section keeps its place rather than leading the pane.
  assert.notEqual(pane.groups[0]?.title, "Warnings");
  // With nothing to say it is empty, and a section hidden when empty stays hidden.
  const quiet = options();
  quiet.sections.warnings = { visible: true, collapsed: false, hideWhenEmpty: true };
  assert.equal(paneFrom(snapshot(), quiet).groups.some((entry) => entry.title === "Warnings"), false);
});

test("the skill scan's own line counts what it found and copies the report command", () => {
  const { done, actions } = recorder();
  const scanned: Snapshot["skills"] = {
    state: "empty", generated_at: NOW - 600, items: [], new: [], running: null, errors: [],
    counts: { clean: 10, flagged: 2, review: 3, failed: 1, reviewed: 4 },
    report_command: "python3 scan.py report",
  };
  const pane = paneFrom(snapshot({ skills: scanned }), options({ actions }));
  const skills = group(pane, "Skills");
  // A scan that left nothing to read is still a reading with its line.
  assert.equal(skills.state, "ready");
  const line = skills.rows[0];
  assert.equal(line?.title, "Last scan 10m ago");
  assert.deepEqual(line?.lines?.[0]?.slots.map((slot) => slot.text).join(""),
                   "20 checked · 10 clean · 2 flagged · 3 to read"
                   + " · 1 could not finish · 4 reviewed");
  assert.deepEqual(line?.lines?.[0]?.slots.map((slot) => slot.color),
                   [undefined, "success", "error", "warning", "warning", undefined]);
  line?.press?.onPress();
  assert.deepEqual(done.copied, [["python3 scan.py report", "the skill report command"]]);
  // Without a configured command the line says so and offers no press.
  const bare = paneFrom(snapshot({ skills: { ...scanned, report_command: null,
                                             counts: { clean: 5 } } }), options({ actions }));
  const plain = group(bare, "Skills").rows[0];
  assert.equal(plain?.press, undefined);
  assert.equal(plain?.slot[0]?.text, "report command not configured");
  assert.equal(plain?.lines?.[0]?.slots.map((slot) => slot.text).join(""), "5 checked · 5 clean");
  // A scan running before any finished says so, with no counts to state.
  const first = paneFrom(snapshot({ skills: { ...scanned, generated_at: null, counts: {},
                                              running: { done: 2, total: 8 } } }), options());
  const running = group(first, "Skills").rows[0];
  assert.equal(running?.title, "No finished scan yet");
  assert.equal(running?.meta[0]?.text, "scanning 2 of 8 changed folders");
  assert.deepEqual(running?.lines, []);
  // No scan at all is no line.
  assert.equal(group(paneFrom(snapshot(), options()), "Skills").rows.length, 0);
});

const TREE = { name: "lane", path: "/w/lane", branch: "feat/x", state: "active", merged: false,
               archived: false, held: false, cleanup_command: "clean --worktree /w/lane" } as const;

test("a worktree state is drawn in the tone the theme picks for it", () => {
  const drawn = (theme?: Theme): (string | undefined)[] => {
    const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                  worktrees: [{ ...TREE, state: "held" } as never] } }),
                          options(theme ? { theme } : {}));
    const row = group(pane, "Worktrees").rows[0];
    return [row?.lines?.[0]?.slots[0]?.color, row?.slot?.[0]?.color];
  };
  assert.deepEqual(drawn(), ["warning", "warning"]);
  assert.deepEqual(drawn(themeFrom({ worktrees: { held: "failure" } })), ["error", "error"]);
});

test("a worktree says what happens to it next, in the words the last pane used", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{}, "in use"],
    [{ change_owner: "codex", change_updated_at: NOW - 7200 }, "in use last moved 2h ago by codex"],
    [{ change_owner: "codex" }, "in use by codex"],
    [{ state: "held" }, "a running process has it open; cleaned after it exits"],
    [{ state: "merged", change_state: "MERGED", change_owner: "codex" },
     "cleaned automatically at the next daily prune"],
    [{ state: "merged", change_state: "PUSHED", change_owner: "codex", change_updated_at: NOW - 90000 },
     "no changes yet; press to copy cleanup if unused parked 1d by codex"],
    [{ state: "preserved", change_owner: "claude", change_updated_at: NOW - 300 },
     "not merged; archived copy kept; press to copy cleanup if abandoned parked 5m by claude"],
    [{ state: "unknown", error: "git timed out" }, "could not check: git timed out"],
    [{ state: "unknown" }, "could not check: probe unavailable"],
  ];
  for (const [change, words] of cases) {
    const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                  worktrees: [{ ...TREE, ...change } as never] } }),
                          options());
    const row = group(pane, "Worktrees").rows[0];
    assert.equal(row?.lines?.[0]?.slots[0]?.text, words);
    // Merged and preserved trees are said quietly; the rest in their own color.
    const quiet = change.state === "merged" || change.state === "preserved";
    assert.equal(row?.lines?.[0]?.slots[0]?.dim === true, quiet, words);
  }
  assert.equal(worktreeNextStep({ ...TREE, state: "active" } as never), "in use");
  assert.equal(worktreeOwnerNote({ ...TREE, change_owner: "x", change_updated_at: NOW - 59 } as never, NOW),
               " last moved 0m ago by x");
});

test("a worktree's owner, error and branch are masked like anything a session wrote", () => {
  const { done, actions } = recorder();
  const secret = "token: abc123def456";
  const trees = [{ ...TREE, change_owner: "org_ABC123", change_updated_at: NOW - 300 },
                 { ...TREE, name: "broken", path: "/w/b", state: "unknown", cleanup_command: "",
                   error: "git failed, " + secret, branch: "feat/loc_XYZ789" }];
  const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                worktrees: trees as never } }), options({ actions }));
  const values = texts(pane);
  for (const leak of ["org_ABC123", "abc123def456", "loc_XYZ789"]) {
    assert.equal(values.some((value) => value.includes(leak)), false, leak);
  }
  assert.equal(values.some((value) => value.includes("in use last moved 5m ago by [masked]")), true);
  assert.equal(values.some((value) => value.includes("could not check: git failed, [masked]")), true);
  assert.equal(worktreeOwnerNote(trees[0] as never, NOW), " last moved 5m ago by [masked]");
  for (const row of group(pane, "Worktrees").rows) {
    row.press?.onPress();
  }
  assert.deepEqual(done.refused, ["no cleanup for broken: git failed, [masked]"]);
});

test("a worktree with no safe cleanup line says to clean it by hand, with nothing to press", () => {
  // On Windows the reader offers no line for a name cmd would read, and says so.
  const note = "clean this worktree up by hand: its name holds characters the shell would read";
  const { done, actions } = recorder();
  const trees = [{ ...TREE, name: "odd&name", path: "C:/w/odd&name", state: "merged",
                   change_state: "PUSHED", cleanup_command: "", cleanup_note: note },
                 { ...TREE, name: "live&name", path: "C:/w/live&name", cleanup_command: "",
                   cleanup_note: note + " token: abc123def456" }];
  const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                worktrees: trees as never } }), options({ actions }));
  const rows = group(pane, "Worktrees").rows;
  // The note stands where the press would be offered, and the press is gone.
  assert.equal(rows[0]?.lines?.[0]?.slots[0]?.text, "no changes yet; " + note);
  assert.equal(rows[1]?.lines?.[0]?.slots[0]?.text, "in use; " + note + " [masked]");
  assert.deepEqual(rows.map((row) => row.press), [undefined, undefined]);
  // Drawn: the words are there, masked, and nothing on the row is a control.
  for (const row of rows) {
    const drawn = renderRow(row, 120, NARROW_AT);
    const words = renderedText(drawn).join("");
    assert.equal(words.includes(note), true, words);
    assert.equal(words.includes("abc123def456"), false, words);
    assert.equal(words.includes("press to copy"), false, words);
    assert.equal(JSON.stringify(drawn).includes("\"Button\""), false);
  }
  assert.deepEqual([done.copied, done.refused], [[], []]);
});

test("a worktree copies its cleanup line, or says why it has none", () => {
  const { done, actions } = recorder();
  const trees = [TREE,
                 { ...TREE, name: "broken", path: "/w/b", cleanup_command: "", error: "git timed out" },
                 { ...TREE, name: "detached", path: "/w/d", cleanup_command: "", branch: "" },
                 { ...TREE, name: "plain", path: "/w/p", cleanup_command: "" }];
  const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                worktrees: trees as never } }), options({ actions }));
  const rows = group(pane, "Worktrees").rows;
  assert.deepEqual(rows.map((row) => row.press?.key),
                   ["fleet.worktree./w/lane", "fleet.worktree./w/b", "fleet.worktree./w/d",
                    "fleet.worktree./w/p"]);
  for (const row of rows) {
    row.press?.onPress();
  }
  assert.deepEqual(done.copied, [["clean --worktree /w/lane", "cleanup for lane"]]);
  assert.deepEqual(done.refused, ["no cleanup for broken: git timed out",
                                  "no cleanup for detached: its branch is unknown",
                                  "no cleanup for plain: no cleanup command is configured (commands.cleanup)"]);
  assert.deepEqual(group(pane, "Worktrees").notes,
                   [[{ text: "Press a worktree to copy its cleanup command.", dim: true }]]);
});

test("a worktree whose merge is unknown is drawn as neither and offers no cleanup", () => {
  const { done, actions } = recorder();
  // A command on the row is not enough: an unknown merge is never offered for
  // cleanup, whatever the document carried.
  const trees = [{ ...TREE, name: "cut", path: "/w/cut", state: "unknown", merged: null,
                   error: "cannot tell whether feat/x is merged into main: git merge-base exited 128" },
                 { ...TREE, name: "quiet", path: "/w/quiet", state: "unknown", merged: null }];
  const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                worktrees: trees as never } }), options({ actions }));
  const rows = group(pane, "Worktrees").rows;
  assert.deepEqual(rows.map((row) => row.slot?.[0]?.text), ["unknown", "unknown"]);
  assert.equal(rows[0]?.lines?.[0]?.slots[0]?.text,
               "could not check: cannot tell whether feat/x is merged into main: git merge-base exited 128");
  for (const row of rows) {
    const words = renderedText(renderRow(row, 120, NARROW_AT)).join("");
    for (const claim of ["in use", "not merged;", "no changes yet", "cleaned automatically",
                         "press to copy cleanup"]) {
      assert.equal(words.includes(claim), false, claim + " in " + words);
    }
    row.press?.onPress();
  }
  assert.deepEqual(done.copied, []);
  assert.deepEqual(done.refused, [
    "no cleanup for cut: cannot tell whether feat/x is merged into main: git merge-base exited 128",
    "no cleanup for quiet: could not tell whether it is merged"]);
});

test("a worktree whose archive or live holders are unknown offers no cleanup, and says why", () => {
  const { done, actions } = recorder();
  // Each row carries a line; none may be copied.
  const trees = [{ ...TREE, name: "lookup", path: "/w/lookup", state: "unknown", archived: null,
                   error: "cannot tell whether feat/x is archived: git for-each-ref exited 128" },
                 { ...TREE, name: "no-archive", path: "/w/no-archive", state: "unknown", archived: null },
                 { ...TREE, name: "no-lsof", path: "/w/no-lsof", state: "unknown", held: null,
                   error: "live process inspection unavailable: lsof is not on the PATH" },
                 { ...TREE, name: "no-holders", path: "/w/no-holders", state: "unknown", held: null }];
  const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                worktrees: trees as never } }), options({ actions }));
  const rows = group(pane, "Worktrees").rows;
  for (const row of rows) {
    row.press?.onPress();
  }
  assert.deepEqual(done.copied, []);
  assert.deepEqual(done.refused, [
    "no cleanup for lookup: cannot tell whether feat/x is archived: git for-each-ref exited 128",
    "no cleanup for no-archive: could not tell whether a copy of it is archived",
    "no cleanup for no-lsof: live process inspection unavailable: lsof is not on the PATH",
    "no cleanup for no-holders: could not check whether a process has it open"]);
  // Nothing here can be copied, so the section does not invite a press that copies.
  assert.deepEqual(group(pane, "Worktrees").notes,
                   [[{ text: "No worktree here offers a cleanup command; press one to see why.",
                       dim: true }]]);
});

test("a machine that cannot check live holders says so once, over a section offering no cleanup", () => {
  // Windows has no lsof, so every row is in this state there: the section says
  // why nothing can be cleaned rather than looking broken.
  const { actions } = recorder();
  const trees = ["one", "two"].map((name) => ({
    ...TREE, name, path: "C:/w/" + name, state: "unknown", held: null,
    error: "live process inspection unavailable: lsof is not on the PATH" }));
  const pane = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                worktrees: trees as never } }), options({ actions }));
  assert.deepEqual(group(pane, "Worktrees").notes,
                   [[{ text: "No cleanup is offered: this machine could not check which processes "
                       + "have a worktree open.", dim: true }]]);
  // A section with a row that can be copied keeps the invitation.
  const mixed = paneFrom(snapshot({ worktrees: { state: "ready", cleaned: null, errors: [],
                                                 worktrees: [TREE, ...trees] as never } }),
                         options({ actions }));
  assert.deepEqual(group(mixed, "Worktrees").notes,
                   [[{ text: "Press a worktree to copy its cleanup command.", dim: true }]]);
});

test("a pull request's title links to its page when the repository names one", () => {
  const pull = { repo: "acme/app", number: 7, title: "Fix it", branch: "b", head: "h",
                 is_draft: false, checks: "pass" as const };
  assert.equal(prUrl(pull), "https://github.com/acme/app/pull/7");
  assert.equal(prUrl({ ...pull, number: null }), null);
  assert.equal(prUrl({ ...pull, repo: "app" }), null);
  assert.equal(prUrl({ ...pull, repo: "acme/app/../x" }), null);
  const pane = paneFrom(snapshot({ prs: { state: "ready", errors: [],
                                          prs: [pull, { ...pull, number: null, title: "No number" }] } }),
                        options());
  const rows = group(pane, "Pull requests").rows;
  assert.equal(rows[0]?.link, "https://github.com/acme/app/pull/7");
  assert.equal(rows[1]?.link, undefined);
});

test("a branch tried again after a failure is one row, marked as following it", () => {
  const lease = { repo: "acme/app", branch: "fix", tool: "claude", expires_at: NOW + 60, session: "s" };
  const failed = { key: "k", repo: "acme/app", branch: "fix", change_state: "", at: NOW - 60,
                   is_green: false, passed: 3, failed: 1, errors: 0, skipped: 0 };
  const pane = paneFrom(snapshot({ trials: { state: "ready", running: [lease], recent: [failed],
                                             history: null, errors: [] } }), options());
  const rows = group(pane, "Trials").rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.slot, [{ text: "running, last try failed", color: "error" }]);
  // A branch whose last try passed is two plain rows: the try now, and the pass.
  const passed = paneFrom(snapshot({ trials: { state: "ready", running: [lease],
                                               recent: [{ ...failed, is_green: true }],
                                               history: null, errors: [] } }), options());
  const plain = group(passed, "Trials").rows;
  assert.equal(plain.length, 2);
  assert.deepEqual(plain[0]?.slot, [{ text: "running", color: "text" }]);
});

test("the pane says Escape closes it, beside the key the configuration bound", () => {
  assert.equal(paneFrom(snapshot(), options()).hint, "Esc or x closes this pane");
  assert.equal(paneFrom(snapshot(), options({ keys: { ...DEFAULT_KEYS, close: "q" } })).hint,
               "Esc or q closes this pane");
});

test("a run's elapsed time counts on from when its counts were read", () => {
  // Read once and drawn as read, the time froze between reads and then jumped
  // (8s, then 13s a second later). Aged by the paint's clock, it counts.
  const runs = { state: "ready" as const, errors: [], runs: [
    { key: "abcdef12", repo: "example-repo", branch: "feat/one", label: "Suite",
      display: "feat/one@example-repo", done: 1, total: 2, failed: 0, first_failure: "",
      elapsed: 120, eta_minutes: null, phase: "verify" }] };
  const at = (countsAt: number | undefined) => texts(paneFrom(snapshot({ progress: runs }),
                                                             options({ countsAt })));
  assert.equal(at(NOW).some((value) => value.includes("2m elapsed")), true);
  assert.equal(at(NOW - 60).some((value) => value.includes("3m elapsed")), true);
  // Counts dated ahead of this clock add nothing rather than taking time away.
  assert.equal(at(NOW + 90).some((value) => value.includes("2m elapsed")), true);
  // Without a reading time the run's own figure stands.
  assert.equal(at(undefined).some((value) => value.includes("2m elapsed")), true);
});

test("a held command's wait counts down from when it was read, and stops at nothing", () => {
  const held = (left: number) => ({ state: "ready" as const, errors: [], runs: [
    { key: "abcdef14", repo: "example-repo", branch: null, label: "targeted-test",
      display: "targeted-test", done: 0, total: 0, failed: 0, first_failure: "", elapsed: 30,
      eta_minutes: null, phase: "wait", kind: "wait", command_class: "targeted",
      queue_position: 2, queue_total: 3, wait_total: 900, wait_left: left }] });
  const drawn = (left: number, countsAt: number) =>
    texts(paneFrom(snapshot({ progress: held(left) }), options({ countsAt })));
  assert.equal(drawn(600, NOW).some((value) => value.includes("10m left")), true);
  assert.equal(drawn(600, NOW - 120).some((value) => value.includes("8m left")), true);
  assert.equal(drawn(60, NOW - 600).some((value) => value.includes("0s left")), true);
});

test("a count that comes and goes keeps its place as a quiet zero", () => {
  // "1 running" appearing and going pushed every figure after it along the line.
  const trials = (running: number) => ({
    state: "ready" as const, history: null, errors: [], recent: [],
    changes: [{ repo: "example-repo", branch: "feat/one", state: "NEW", held_by: null,
                pr: null, updated_at: NOW - 30 }],
    running: Array.from({ length: running }, (_, index) => ({
      repo: "example-repo", branch: "feat/run" + index, tool: "codex", expires_at: NOW + 600,
      session: "abcdef1" + index + "-rest" })),
  });
  const summary = (running: number) => group(
    paneFrom(snapshot({ trials: trials(running) as never }), options()), "Trials").summary;
  const idle = summary(0);
  const busy = summary(2);
  assert.equal(idle.length, busy.length);
  const zero = idle.find((slot) => slot.text.trim() === "0 running");
  assert.ok(zero, idle.map((slot) => slot.text).join("|"));
  assert.equal(zero.dim, true);
  assert.equal(busy.some((slot) => slot.text.trim() === "2 running" && !slot.dim), true);
});

test("the governor keeps the room a run takes, so a run arriving moves nothing below it", () => {
  const governor = (runs: unknown[]) => group(
    paneFrom(snapshot({ progress: { state: runs.length ? "ready" : "empty", errors: [],
                                    runs } as never }), options()), "Running");
  const none = governor([]);
  const one = governor([{ key: "abcdef12", repo: "example-repo", branch: "feat/one", label: "Suite",
                          display: "Suite", done: 1, total: 2, failed: 0, first_failure: "",
                          elapsed: 5, eta_minutes: null, phase: "verify" }]);
  assert.equal(none.reserve, 2);
  assert.equal(one.reserve, 2);
  // The held count keeps its place as well.
  assert.equal(none.summary.length, one.summary.length);
});

const PULL = { repo: "owner/project", number: 7, title: "Add the thing", branch: "feat/thing",
               head: "abc", is_draft: false, checks: "fail" as const };

test("a pull request row carries a dot per check and names the first that failed", () => {
  const pull = { ...PULL, check_runs: [{ name: "build", state: "pass" }, { name: "lint", state: "fail" },
                                       { name: "test", state: "fail" }, { name: "docs", state: "pending" }],
                 check_runs_more: 2 };
  const row = group(paneFrom(snapshot({ prs: { state: "ready", prs: [pull], errors: [] } as never }),
                             options()), "Pull requests").rows[0];
  assert.deepEqual(row?.checks, { states: ["pass", "fail", "fail", "pending"], more: 2 });
  assert.deepEqual(row?.slot, [{ text: "lint and 1 more failed", color: "error" }]);
  // One failure is named alone.
  const one = { ...pull, check_runs: [{ name: "lint", state: "fail" }], check_runs_more: 0 };
  const alone = group(paneFrom(snapshot({ prs: { state: "ready", prs: [one], errors: [] } as never }),
                               options()), "Pull requests").rows[0];
  assert.deepEqual(alone?.slot, [{ text: "lint failed", color: "error" }]);
});

test("a check's name is masked like anything else a command printed", () => {
  const leaked = "ghp_" + "a".repeat(36);
  const pull = { ...PULL, check_runs: [{ name: "deploy " + leaked, state: "fail" }], check_runs_more: 0 };
  const values = texts(paneFrom(snapshot({ prs: { state: "ready", prs: [pull], errors: [] } as never }),
                                options()));
  assert.equal(values.some((value) => value.includes(leaked)), false);
});

test("a pull request read before checks were listed draws no dots and keeps its verdict", () => {
  const row = group(paneFrom(snapshot({ prs: { state: "ready", prs: [PULL], errors: [] } }), options()),
                    "Pull requests").rows[0];
  assert.equal(row?.checks, undefined);
  assert.deepEqual(row?.slot, [{ text: "checks failed", color: "error" }]);
  // A passing pull request with its checks listed keeps its word too.
  const passing = { ...PULL, checks: "pass" as const, check_runs: [{ name: "build", state: "pass" }],
                    check_runs_more: 0 };
  const green = group(paneFrom(snapshot({ prs: { state: "ready", prs: [passing], errors: [] } as never }),
                               options()), "Pull requests").rows[0];
  assert.deepEqual(green?.checks, { states: ["pass"], more: 0 });
  assert.deepEqual(green?.slot, [{ text: "checks passed", color: "success" }]);
});

/** An event the digest reads, `ago` seconds before NOW. */
function event(kind: string, title: string, ago: number, ref = "owner/project#1") {
  return { at: NOW - ago, kind, title, ref };
}

function events(list: ReturnType<typeof event>[], state = "ready"): Snapshot["events"] {
  return { state, events: list, sources: { trials: "ready", prs: "ready", roster: "ready" },
           errors: [] } as never;
}

test("the digest shows only what happened since the last look, newest first", () => {
  const list = [event("trial-failed", "repo feat/a", 60), event("pr-opened", "Add it", 600),
                event("job-finished", "Old job", 7200)];
  const pane = paneFrom(snapshot({ events: events(list) }), options({ lastSeen: NOW - 3600 }));
  const digest = pane.digest;
  assert.ok(digest, "no digest for two new events");
  assert.equal(digest.lines.length, 2);
  const words = digest.lines.map((line) => line.map((slot) => slot.text).join(""));
  assert.match(words[0] ?? "", /Trial failed.*repo feat\/a/);
  assert.match(words[1] ?? "", /PR opened.*Add it/);
  assert.equal(words.some((value) => value.includes("Old job")), false);
  assert.equal(digest.through, NOW - 60);
  assert.equal(digest.heading.map((slot) => slot.text).join("").includes("2 new"), true);
});

test("the digest draws at most five lines and counts the rest", () => {
  const list = Array.from({ length: 8 }, (_, index) => event("pr-opened", "PR " + index, 60 + index));
  const pane = paneFrom(snapshot({ events: events([...list, event("pr-opened", "seen", 9000)]) }),
                        options({ lastSeen: NOW - 3600 }));
  const lines = pane.digest?.lines ?? [];
  assert.equal(lines.length, 6);
  assert.equal(lines.at(-1)?.map((slot) => slot.text).join("").trim(), "+3 more");
  // Every event the reading holds is newer than the look only when the oldest
  // one is: then the reading's own limit may have left some out.
  const capped = paneFrom(snapshot({ events: events(list) }), options({ lastSeen: NOW - 3600 }));
  assert.equal(capped.digest?.lines.at(-1)?.map((slot) => slot.text).join("").trim(), "+3 or more");
});

test("nothing new draws no digest, and a pane told no last look draws none", () => {
  const list = [event("pr-opened", "Old", 7200)];
  assert.equal(paneFrom(snapshot({ events: events(list) }), options({ lastSeen: NOW - 60 })).digest ?? null,
               null);
  assert.equal(paneFrom(snapshot({ events: events([], "empty") }), options({ lastSeen: NOW - 60 }))
    .digest ?? null, null);
  assert.equal(paneFrom(snapshot({ events: events(list) }), options()).digest ?? null, null);
  // A reading from before events were read carries no document, and draws none.
  assert.equal(paneFrom(snapshot(), options({ lastSeen: NOW - 60 })).digest ?? null, null);
});

test("a first look shows the newest events and says it is the first", () => {
  const pane = paneFrom(snapshot({ events: events([event("job-waiting", "Needs you", 30)]) }),
                        options({ lastSeen: null }));
  assert.equal(pane.digest?.lines.length, 1);
  assert.match(pane.digest?.heading.map((slot) => slot.text).join("") ?? "", /first look/);
});

test("a digest whose events could not be read says so, and never that nothing is new", () => {
  const failed = { state: "failed", events: [], sources: {},
                   errors: [{ source: "events", reason: "TypeError: boom" }] };
  const pane = paneFrom(snapshot({ events: failed as never }), options({ lastSeen: NOW - 60 }));
  assert.ok(pane.digest, "a failed digest drew nothing");
  const said = pane.digest.lines.flat().map((slot) => slot.text).join("");
  assert.match(said, /could not read/i);
  assert.equal(pane.digest.lines.flat().some((slot) => slot.color === "error"), true);
  assert.equal(pane.digest.through, null);
  assert.equal(/nothing new/i.test(said), false);
});

test("a digest names a source it could not see beside what it did", () => {
  const blind = { ...events([event("pr-opened", "Add it", 60)]),
                  sources: { trials: "failed", prs: "ready", roster: "ready" } } as never;
  const said = (paneFrom(snapshot({ events: blind }), options({ lastSeen: NOW - 600 })).digest?.lines ?? [])
    .flat().map((slot) => slot.text).join("|");
  assert.match(said, /trials could not be read/);
});

test("a source the events could not see is named even when nothing they saw is new", () => {
  const blindAndQuiet = (list: ReturnType<typeof event>[], state: string) =>
    ({ ...events(list, state), sources: { trials: "failed", prs: "ready", roster: "ready" } }) as never;
  for (const [label, document] of [
    ["an empty reading", blindAndQuiet([], "empty")],
    ["only events from before the look", blindAndQuiet([event("pr-opened", "Old", 7200)], "ready")],
  ] as const) {
    const digest = paneFrom(snapshot({ events: document }), options({ lastSeen: NOW - 60 })).digest;
    assert.ok(digest, label + " hid a source it could not read");
    const said = digest.lines.flat().map((slot) => slot.text).join("|");
    assert.match(said, /trials could not be read/, label);
    assert.equal(digest.lines.flat().some((slot) => slot.color === "warning"), true, label);
    // Nothing was drawn as new, so closing the pane moves no look.
    assert.equal(digest.through, null, label);
    assert.equal(said.includes("Old"), false, label);
    assert.match(digest.heading.map((slot) => slot.text).join(""), /nothing new from what could be read/i,
                 label);
  }
});

const SERIES = { bucket_minutes: 60, buckets: [0, 1.5, 0, 3.25], total: 4.75, complete: true, sessions: 2 };

test("the sessions section draws the roster's spend over the window, with its total", () => {
  const pane = paneFrom(snapshot({ roster: { ...roster([LIVE]), spend_series: SERIES } as never }),
                        options());
  const spark = group(pane, "Background sessions").spark;
  assert.deepEqual(spark?.values, [0, 1.5, 0, 3.25]);
  const label = spark?.label.map((slot) => slot.text).join("") ?? "";
  assert.match(label, /^\$4\.75/);
  assert.match(label, /over 4h/);
  assert.match(label, /2 sessions/);
  assert.equal(/incomplete|at least/.test(label), false);
});

test("a spend series that is not complete is a floor and is marked so", () => {
  const pane = paneFrom(snapshot({ roster: { ...roster([LIVE]),
                                             spend_series: { ...SERIES, complete: false } } as never }),
                        options());
  const label = group(pane, "Background sessions").spark?.label ?? [];
  assert.match(label.map((slot) => slot.text).join(""), /^at least \$4\.75/);
  assert.equal(label.some((slot) => slot.text.includes("incomplete") && slot.color === "warning"), true);
});

test("a 60-column pane draws the unread-source line of a quiet digest, cut rather than dropped", () => {
  const quiet = { ...events([], "empty"), sources: { trials: "failed", prs: "ready", roster: "ready" } } as never;
  const drawn = renderedText(renderPane(paneFrom(snapshot({ events: quiet }),
                                                 options({ lastSeen: NOW - 60, width: 60 })))).join("");
  assert.match(drawn, /Nothing new from what could be read/);
  assert.match(drawn, /trials could not be/, drawn);
});

test("a 60-column pane keeps the incomplete mark beside a two-digit floor", () => {
  for (const total of [14.75, 1234.56]) {
    const pane = paneFrom(snapshot({ roster: { ...roster([LIVE]),
                                               spend_series: { ...SERIES, total, complete: false } } as never }),
                          options({ width: 60 }));
    const drawn = renderedText(renderPane(pane)).join("");
    assert.match(drawn, /at least \$/, String(total));
    assert.match(drawn, /incomplete/, total + ": " + drawn);
  }
});

test("a narrow card cuts the spend window and session count before the incomplete mark", () => {
  const pane = paneFrom(snapshot({ roster: { ...roster([LIVE]),
                                             spend_series: { ...SERIES, complete: false } } as never }),
                        options());
  const spark = group(pane, "Background sessions").spark;
  const label = spark?.label ?? [];
  // The figure and its mark come first, and both are kept whole at any width.
  assert.equal(spark?.keep, 2);
  assert.match(label[0]?.text ?? "", /^at least \$4\.75/);
  assert.equal(label[1]?.text.includes("incomplete") && label[1]?.color === "warning", true);
  assert.match(label.slice(2).map((slot) => slot.text).join(""), /over 4h.*2 sessions/);
  // A complete figure keeps only itself.
  const complete = paneFrom(snapshot({ roster: { ...roster([LIVE]), spend_series: SERIES } as never }),
                            options());
  assert.equal(group(complete, "Background sessions").spark?.keep, 1);
  // With room for everything, every part is kept.
  const whole = fitSlots(label, 80).map((slot) => slot.text).join("");
  assert.match(whole, /incomplete/);
  assert.match(whole, /over 4h/);
  assert.match(whole, /2 sessions/);
});

test("no spend series draws no spend line, and a roster that failed draws none", () => {
  const absent = paneFrom(snapshot({ roster: { ...roster([LIVE]), spend_series: null } as never }), options());
  assert.equal(group(absent, "Background sessions").spark ?? null, null);
  const failed = paneFrom(snapshot({ roster: { ...roster([]), state: "failed",
                                               spend_series: SERIES } as never }), options());
  assert.equal(group(failed, "Background sessions").spark ?? null, null);
});

/** A ready agent card's figures with a timeline. */
function agent(timeline: unknown) {
  return { state: "ready", costUsd: 1, costSource: "estimate", timeline };
}

test("an agent card carries its timeline, and the stretch since its last record is its state", () => {
  const timeline = [{ start: NOW - 600, end: NOW - 300, state: "working" },
                    { start: NOW - 300, end: NOW - 200, state: "idle" },
                    { start: NOW - 200, end: NOW - 100, state: "working" }];
  const blocked = { ...JOB, agent: agent(timeline) };
  const row = group(paneFrom(snapshot({ roster: roster([blocked]) }), options()), "Background sessions").rows[0];
  assert.deepEqual(row?.timeline, { from: NOW - 600, to: NOW, segments: timeline, tail: "waiting" });
  const busy = { ...LIVE, agent: agent(timeline) };
  const working = group(paneFrom(snapshot({ roster: roster([busy]) }), options()), "Background sessions").rows[0];
  assert.equal(working?.timeline?.tail, "working");
});

test("a finished card's timeline ends at its last record, and an unread one draws none", () => {
  const timeline = [{ start: NOW - 600, end: NOW - 300, state: "working" }];
  const done = { ...LIVE, state: "done", since: NOW - 60, agent: agent(timeline) };
  const row = group(paneFrom(snapshot({ roster: roster([done]) }), options()), "Background sessions").rows[0];
  assert.deepEqual(row?.timeline, { from: NOW - 600, to: NOW - 300, segments: timeline });
  const unread = { ...LIVE, agent: agent(null) };
  const none = group(paneFrom(snapshot({ roster: roster([unread]) }), options()), "Background sessions").rows[0];
  assert.equal(none?.timeline, undefined);
});

test("a section keeps the place configuration gave it, whatever it holds", () => {
  // A section used to jump above the calm ones while it held something that
  // needs the person, which moved every digit below it and gave a learned
  // hotkey to another section. The order is configuration's now, and what needs
  // the person is carried by the heading's tone and count.
  const order = ["sessions", "trials", "running", "prs", "worktrees", "keys"];
  const base = options({ sectionOrder: order });
  const titles = (built: { groups: Group[] }) => built.groups.map((entry) => entry.title);
  const calm = ["Background sessions", "Trials", "Running", "Pull requests", "Worktrees", "Keys"];
  assert.deepEqual(titles(paneFrom(snapshot(), base)), calm);
  const failing = paneFrom(snapshot({ prs: { state: "ready", prs: [PULL], errors: [] } }), base);
  assert.deepEqual(titles(failing), calm);
  assert.equal(group(failing, "Pull requests").attention, true);
  const asking = paneFrom(snapshot({ roster: roster([JOB]) }),
                          options({ sectionOrder: ["prs", "sessions"] }));
  assert.deepEqual(titles(asking), ["Pull requests", "Background sessions"]);
  assert.equal(group(asking, "Background sessions").attention, true);
});

test("a failing source still leads, and a section keeps the fold a person pressed", () => {
  const order = ["sessions", "prs", "warnings"];
  const built = paneFrom(snapshot({
    prs: { state: "ready", prs: [PULL], errors: [{ source: "prs:other", reason: "timed out" }] },
  }), options({ sectionOrder: order, folded: { prs: true } }));
  assert.deepEqual(built.groups.map((entry) => entry.title), ["Warnings", "Background sessions", "Pull requests"]);
  assert.equal(group(built, "Pull requests").collapsed, true);
  // A passing pull request is calm, and a held governor command is not the person's to answer.
  const calm = paneFrom(snapshot({
    prs: { state: "ready", prs: [{ ...PULL, checks: "pass" }], errors: [] },
    progress: { state: "ready", errors: [], runs: [{ key: "w", repo: "r", branch: null, label: "", display: "",
      done: 0, total: 0, failed: 0, first_failure: "", elapsed: 0, eta_minutes: null, phase: "",
      kind: "wait", command_class: "test", queue_position: 1, queue_total: 2, wait_total: 60,
      wait_left: 30 }] },
  }), options({ sectionOrder: ["sessions", "prs", "running"] }));
  assert.deepEqual(calm.groups.map((entry) => entry.title), ["Background sessions", "Pull requests", "Running"]);
});

const PROCESS = {
  pid: 101, command: "/usr/bin/CompilingProgram thing", cpu_percent: 42.5,
  memory_bytes: 1610612736, elapsed_seconds: 3723, project: "example-repo",
  project_root: "/projects/example-repo",
};

test("a process under load is drawn by name, project, age and what it costs", () => {
  const built = paneFrom(snapshot({
    load: { state: "ready", sampled_at: NOW, total: 412, errors: [], processes: [PROCESS] },
  }), options({ sectionOrder: ["load", "sessions", "warnings"] }));
  const load = group(built, "Load");
  assert.equal(load.rows.length, 1);
  const row = load.rows[0];
  // The path places the command; the row is read by its name.
  assert.equal(row?.title, "CompilingProgram thing");
  assert.deepEqual(row?.meta.map((slot) => slot.text),
                   ["example-repo", " · pid 101", " · 1h 2m"]);
  assert.deepEqual(row?.slot.map((slot) => slot.text), ["42.5%", " 1.5 GB"]);
  // Forty-two percent presses the machine without pinning it.
  assert.equal(row?.slot[0]?.color, "warning");
  assert.equal(row?.note?.text, "/projects/example-repo");
  // The heading says how many the drawn rows were chosen from.
  assert.deepEqual(load.summary, [{ text: "412 processes" },
                                  { text: "  1 shown", color: "subtle" }]);
});

test("the load section names the two figures its rows draw in columns", () => {
  const built = paneFrom(snapshot({
    load: { state: "ready", sampled_at: NOW, total: 412, errors: [], processes: [PROCESS] },
  }), options({ sectionOrder: ["load"] }));
  const load = group(built, "Load");
  // The names are the row's own column widths, so they sit over their figures,
  // and the word before the second name is the separator the rows use.
  assert.deepEqual(load.columns?.map((slot) => slot.text), ["CPU", " · MEM"]);
  assert.deepEqual(load.columns?.map((slot) => slot.width), [6, 8]);
});

test("a load row keeps each figure in its own column", () => {
  // A percentage of four characters and one of five put the memory figure one
  // cell apart, so the column walked from row to row. Each figure is drawn in a
  // column of its own width, and the next one starts where the column ends.
  const built = paneFrom(snapshot({
    load: { state: "ready", sampled_at: NOW, total: 2, errors: [],
            processes: [{ ...PROCESS, pid: 1, cpu_percent: 8.6, memory_bytes: 400000 } as never,
                        { ...PROCESS, pid: 2, cpu_percent: 98.8, memory_bytes: 430000000 } as never] },
  }), options({ sectionOrder: ["load"] }));
  const rows = group(built, "Load").rows;
  assert.equal(rows[0]?.slot[0]?.width, 6);
  assert.equal(rows[0]?.slot[0]?.align, "right");
  assert.equal(rows[1]?.slot[0]?.width, 6);
  assert.equal(rows[0]?.slot[1]?.width, 8);
  assert.equal(rows[1]?.slot[1]?.width, 8);
});

test("a process nobody could place draws no project rather than a guess", () => {
  const built = paneFrom(snapshot({
    load: { state: "ready", sampled_at: NOW, total: 2, errors: [],
            processes: [{ ...PROCESS, pid: 202, project: undefined, project_root: undefined,
                          cpu_percent: 90 } as never] },
  }), options({ sectionOrder: ["load"] }));
  const row = group(built, "Load").rows[0];
  assert.deepEqual(row?.meta.map((slot) => slot.text),
                   ["no project", " · pid 202", " · 1h 2m"]);
  assert.equal(row?.slot[0]?.color, "error");
  assert.equal(row?.note, undefined);
});

test("a load source that could not be read is named rather than drawn as a quiet machine", () => {
  const built = snapshot({
    load: { state: "failed", sampled_at: null, total: 0, errors: [{ source: "load", reason: "ps timed out" }],
            processes: [] },
  });
  assert.deepEqual(unreadableSources(built), ["load"]);
  assert.deepEqual(allErrors(built), [{ source: "load", reason: "ps timed out" }]);
  const drawn = paneFrom(built, options({ sectionOrder: ["load", "warnings"] }));
  assert.equal(group(drawn, "Load").state, "failed");
  assert.equal(group(drawn, "Load").rows.length, 0);
});

test("a switch pacer did not state offers no press, and an armed press waits only while on", () => {
  const pressed: boolean[] = [];
  const actions = { copy: () => undefined, refuse: () => undefined, reply: () => undefined,
                    pacer: (wanted: boolean) => { pressed.push(wanted); } };
  const unread = group(pacerPane(pacerReading({ enabled: null }), { actions }), "Pacer");
  assert.deepEqual(unread.rows[0]?.slot.map((slot) => slot.text), ["not read"]);
  assert.equal(unread.rows[0]?.press, undefined);
  // A first press armed while pacer was on means nothing once it reads off.
  const off = group(pacerPane(pacerReading({ enabled: false }),
                              { actions, confirmingPacer: true }), "Pacer");
  assert.deepEqual(off.rows[0]?.meta.map((slot) => slot.text), ["press to switch on"]);
  off.rows[0]?.press?.onPress();
  assert.deepEqual(pressed, [true]);
});

test("a held slot says what pacer could not record about it", () => {
  const section = group(pacerPane(pacerReading({ slots: [
    { slot: 0, busy: true, pid: 7, repo: "fleet", startedAt: null },
    { slot: 1, busy: true, pid: null, repo: null, startedAt: null },
    { slot: 2, busy: false, pid: null, repo: null, startedAt: null },
    { slot: 3, busy: false, pid: null, repo: null, startedAt: null }] })), "Pacer");
  const slots = section.rows.filter((row) => row.key?.startsWith("pacer.slot:"));
  assert.deepEqual(slots.map((row) => row.slot.map((slot) => slot.text).join("")),
                   ["fleet", "held", "free", "free"]);
  assert.deepEqual(slots.slice(0, 2).map((row) => row.meta.map((slot) => slot.text).join("")),
                   ["start not recorded", "holder not named"]);
  assert.deepEqual(slots.map((row) => row.state), ["working", "working", undefined, undefined]);
});
