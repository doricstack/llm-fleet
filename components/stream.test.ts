/**
 * A new reading lands on the pane source by source, in the order the pane
 * draws them, rather than all at once.
 *
 * Run with: node --test components/stream.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pendingSources, STREAM_ORDER, stepStream } from "../plugins/fleet/components/stream.ts";

type Documents = Record<string, unknown>;

function reading(overrides: Documents = {}): Documents {
  return {
    alerts: { snapshotMs: 3000 },
    session: { cost: 1 },
    progress: { runs: [] },
    trials: { recent: 3 },
    prs: { open: 2 },
    roster: { jobs: 4 },
    worktrees: { count: 30 },
    skills: { flagged: 1 },
    ...overrides,
  };
}

test("the sources are streamed in the order the pane draws its sections", () => {
  assert.deepEqual([...STREAM_ORDER],
                   ["session", "progress", "trials", "prs", "roster", "worktrees", "skills",
                    "custom"]);
});

test("the first reading lands whole: there is nothing on the pane to stream over", () => {
  const target = reading();
  const step = stepStream(null, target);
  assert.deepEqual(step.documents, target);
  assert.deepEqual(step.pending, []);
  assert.notEqual(step.documents, null);
});

test("one step lands the first changed source and leaves the rest as they were drawn", () => {
  const shown = reading();
  const target = reading({ prs: { open: 3 }, worktrees: { count: 31 }, trials: { recent: 4 } });
  assert.deepEqual(pendingSources(shown, target), ["trials", "prs", "worktrees"]);
  const step = stepStream(shown, target);
  assert.deepEqual(step.documents.trials, { recent: 4 });
  assert.deepEqual(step.documents.prs, { open: 2 });
  assert.deepEqual(step.documents.worktrees, { count: 30 });
  assert.deepEqual(step.pending, ["prs", "worktrees"]);
});

test("settings and anything that is not a section land at once", () => {
  // The read times and the pane's configuration decide how everything else is
  // drawn; held back, a section would be drawn by the old ones.
  const shown = reading();
  const target = reading({ alerts: { snapshotMs: 5000 }, pane: { theme: "dark" },
                           roster: { jobs: 5 } });
  const step = stepStream(shown, target);
  assert.deepEqual(step.documents.alerts, { snapshotMs: 5000 });
  assert.deepEqual(step.documents.pane, { theme: "dark" });
  assert.deepEqual(step.documents.roster, { jobs: 5 });
  assert.deepEqual(step.pending, []);
});

test("stepping until nothing is pending reaches the reading exactly", () => {
  let shown: Documents = reading();
  const target = reading({ session: { cost: 2 }, prs: { open: 0 }, skills: { flagged: 0 },
                           custom: { rows: [1] } });
  const seen: string[][] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const step = stepStream(shown, target);
    shown = step.documents;
    seen.push(step.pending);
    if (!step.pending.length) {
      break;
    }
  }
  assert.deepEqual(shown, target);
  // Four sources changed, so four steps, each one fewer pending.
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((pending) => pending.length), [3, 2, 1, 0]);
});

test("a source the new reading no longer has is taken away in its turn", () => {
  const shown = reading({ custom: { rows: [1, 2] } });
  const target = reading();
  delete target.custom;
  assert.deepEqual(pendingSources(shown, target), ["custom"]);
  const step = stepStream(shown, target);
  assert.equal("custom" in step.documents, false);
  assert.deepEqual(step.pending, []);
});

test("a source that did not change takes no step of its own", () => {
  const shown = reading();
  const same = stepStream(shown, reading());
  assert.deepEqual(same.pending, []);
  assert.deepEqual(same.documents, shown);
  assert.deepEqual(pendingSources(shown, reading()), []);
});

test("a newer reading mid-stream carries on from what is drawn, never back", () => {
  const shown = reading();
  const first = reading({ trials: { recent: 4 }, prs: { open: 3 } });
  const halfway = stepStream(shown, first).documents;
  // The next reading agrees with what is drawn for trials and moves prs again.
  const second = reading({ trials: { recent: 4 }, prs: { open: 5 } });
  assert.deepEqual(pendingSources(halfway, second), ["prs"]);
  const step = stepStream(halfway, second);
  assert.deepEqual(step.documents.trials, { recent: 4 });
  assert.deepEqual(step.documents.prs, { open: 5 });
});

test("no reading at all is nothing to draw", () => {
  const step = stepStream(reading(), null);
  assert.equal(step.documents, null);
  assert.deepEqual(step.pending, []);
});

test("a stream that names its next section lands that one, and only one that changed", () => {
  const shown = reading();
  const target = reading({ trials: { recent: 4 }, prs: { open: 3 } });
  // Named, prs lands ahead of trials, which stays as drawn and still pending.
  const named = stepStream(shown, target, "prs");
  assert.deepEqual(named.documents.prs, { open: 3 });
  assert.deepEqual(named.documents.trials, shown.trials);
  assert.deepEqual(named.pending, ["trials"]);
  // A section named that did not change lands nothing, and nothing else moves.
  const unchanged = stepStream(shown, target, "roster");
  assert.deepEqual(unchanged.documents.trials, shown.trials);
  assert.deepEqual(unchanged.documents.prs, shown.prs);
  assert.deepEqual(unchanged.pending, ["trials", "prs"]);
});
