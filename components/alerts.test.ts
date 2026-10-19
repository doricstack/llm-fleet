/**
 * What in a reading is news, and the keys that make each event news once.
 *
 * Run with: node --test components/alerts.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { eventsOf, newEvents } from "../plugins/llm-fleet/components/alerts.ts";
import { snapshotFrom, type ReaderDocuments } from "../plugins/llm-fleet/components/snapshot.ts";

const AT = 1_790_000_000;
const KEY = ["sk-", "ant-", "api03-", "A".repeat(24)].join("");

function job(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { provider: "one", id, name: "Job " + id, state, label: state, started_at: AT - 600,
           last_seen_at: AT - 5, folder: "/tmp/p", ...extra };
}

function reading(jobs: unknown[], overrides: Record<string, unknown> = {}): ReaderDocuments {
  return {
    roster: { state: "ready", providers: { one: { state: "ready", jobs: jobs.length } }, jobs,
              sources: { jobs: "ready", interactive: "empty" }, interactive: {} },
    trials: { state: "ready", running: [], history: null, recent: [
      { key: "t1", repo: "repo", branch: "feat/a", change_state: "TRYING", at: AT - 30,
        is_green: false, passed: 4, failed: 2, errors: 1, skipped: 0 },
    ] },
    progress: { state: "empty" },
    prs: { state: "ready", prs: [
      { repo: "owner/project", number: 7, title: "Fix it", branch: "fix", head: "abc",
        is_draft: false, checks: "fail" },
      { repo: "owner/project", number: 8, title: "Fine", branch: "fine", head: "def",
        is_draft: false, checks: "pass" },
    ] },
    skills: { state: "ready", generated_at: AT, counts: {}, running: null, items: [], new: [
      { name: "helper", target: "/s/helper", verdict: "flagged", hash: "h1", issue: "reads keys" },
    ] },
    worktrees: { state: "empty" },
    ...overrides,
  } as unknown as ReaderDocuments;
}

const snap = (jobs: unknown[], overrides: Record<string, unknown> = {}) =>
  snapshotFrom(reading(jobs, overrides), AT);

test("a waiting job is said aloud; a finished one is shown, not said", () => {
  const events = eventsOf(snap([job("aaaa1111", "blocked", { since: AT - 60.7 }),
                                job("bbbb2222", "blocked", { since: AT - 5, needs: "Which branch?" }),
                                job("cccc3333", "done"), job("dddd4444", "working")]), "");
  const byKey = Object.fromEntries(events.map((event) => [event.key, event]));
  assert.equal(byKey["job:aaaa1111:blocked:" + Math.trunc(AT - 60.7)]?.spoken,
               "Hey, Job aaaa1111 is waiting on you.");
  assert.equal(byKey["job:bbbb2222:blocked:" + (AT - 5)]?.spoken,
               "Hey, Job bbbb2222 has a question for you.");
  assert.equal(byKey["job:cccc3333:done"]?.text, "Job finished: Job cccc3333");
  assert.equal(byKey["job:cccc3333:done"]?.spoken, undefined);
  assert.equal(events.some((event) => event.key.startsWith("job:dddd4444")), false);
  assert.equal(byKey["trial:t1"]?.text, "Trial failed on repo feat/a: 3 failed, 4 passed");
  assert.equal(byKey["pr:owner/project#7:abc"]?.text, "PR 7 checks failing: Fix it");
  assert.equal(byKey["skill:/s/helper:flagged:h1"]?.text, "Skill flagged: helper, reads keys");
  assert.equal(events.some((event) => event.text.includes("Fine")), false);
});

test("this session's own job is never news to it", () => {
  const events = eventsOf(snap([job("aaaa1111", "blocked")]), "aaaa1111-the-rest");
  assert.equal(events.some((event) => event.key.startsWith("job:")), false);
});

test("a secret in a name is masked before it is shown or said", () => {
  const events = eventsOf(snap([job("aaaa1111", "blocked", { name: "deploy " + KEY })]), "");
  const waiting = events.find((event) => event.key.startsWith("job:aaaa1111"));
  assert.ok(waiting);
  assert.equal(waiting.text.includes(KEY), false);
  assert.equal(waiting.spoken?.includes(KEY), false);
});

test("the first reading is not news, and after it an event is news once", () => {
  const first = newEvents(null, snap([job("aaaa1111", "blocked", { since: 1 })]), "");
  assert.deepEqual(first.fresh, []);
  const same = newEvents(first.seen, snap([job("aaaa1111", "blocked", { since: 1 })]), "");
  assert.deepEqual(same.fresh, []);
  const blocked = newEvents(same.seen, snap([job("aaaa1111", "blocked", { since: 1 }),
                                            job("bbbb2222", "blocked", { since: 2 })]), "");
  assert.deepEqual(blocked.fresh.map((event) => event.key), ["job:bbbb2222:blocked:2"]);
  // Blocking again later is a new event, because the key carries when.
  const working = newEvents(blocked.seen, snap([job("bbbb2222", "working")]), "");
  const again = newEvents(working.seen, snap([job("bbbb2222", "blocked", { since: 9 })]), "");
  assert.deepEqual(again.fresh.map((event) => event.key), ["job:bbbb2222:blocked:9"]);
});

test("a source that failed and recovers does not replay what it holds", () => {
  const first = newEvents(null, snap([]), "");
  const failed = newEvents(first.seen, snap([], { prs: { state: "failed", prs: [],
    errors: [{ source: "prs", reason: "timed out" }] } }), "");
  assert.deepEqual(failed.fresh, []);
  // The PR's key was kept through the failure, so its return is not news.
  const back = newEvents(failed.seen, snap([]), "");
  assert.deepEqual(back.fresh, []);
});
