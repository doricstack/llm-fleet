/**
 * What in a reading is news: a job that finished or needs its person, a trial
 * that passed or failed, a skill flagged, a pull request whose checks fail.
 *
 * Each event carries a key that names it once across readings and across
 * sessions. A session alerts on what is new to it, and the machine-wide claim
 * on the key is what makes one session, not every open one, say it aloud.
 *
 * The first reading a session sees is not news: what was already true when it
 * opened is the band's to show, not an alert's to announce.
 */

import { isOwnJob } from "./band.ts";
import { mask } from "./mask.ts";
import type { Snapshot } from "./state.ts";

export type FleetEvent = {
  key: string;
  /** The line a toast and a notification show. */
  text: string;
  /** What is said aloud, for the events worth interrupting a person for. */
  spoken?: string;
};

/** What a value says once anything secret in it is masked. */
function said(value: string | null | undefined): string {
  return mask(value ?? "").text;
}

/** Everything in a reading worth one alert, each under a key that names it once. */
export function eventsOf(snapshot: Snapshot, sessionId: string): FleetEvent[] {
  const events: FleetEvent[] = [];
  for (const job of snapshot.roster.jobs) {
    if (isOwnJob(job, sessionId)) {
      continue;
    }
    // The key carries when the job entered its state, so a job that blocks a
    // second time is a second event, here and in the machine-wide claim.
    const since = job.since === null || job.since === undefined ? "" : ":" + Math.trunc(job.since);
    const name = said(job.name);
    if (job.state === "done") {
      events.push({ key: "job:" + job.id + ":done" + since, text: "Job finished: " + name });
    } else if (job.state === "blocked") {
      events.push({
        key: "job:" + job.id + ":blocked" + since,
        text: "Job needs you: " + name,
        spoken: job.needs ? "Hey, " + name + " has a question for you."
          : "Hey, " + name + " is waiting on you.",
      });
    }
  }
  for (const trial of snapshot.trials.recent) {
    const where = said(trial.repo) + " " + said(trial.branch);
    events.push({
      key: "trial:" + trial.key,
      text: trial.is_green
        ? "Trial passed on " + where + ": " + trial.passed + " passed"
        : "Trial failed on " + where + ": " + (trial.failed + trial.errors) + " failed, "
          + trial.passed + " passed",
    });
  }
  for (const skill of snapshot.skills.new ?? []) {
    const key = "skill:" + skill.target + ":" + skill.verdict + ":" + skill.hash;
    const name = said(skill.name);
    if (skill.verdict === "flagged") {
      events.push({ key, text: "Skill flagged: " + name + ", " + said(skill.issue) });
    } else if (skill.verdict === "failed") {
      events.push({ key, text: "Skill scan could not finish: " + name });
    } else {
      events.push({ key, text: "Skill to read: " + name + ", " + said(skill.issue) });
    }
  }
  for (const pull of snapshot.prs.prs) {
    if (pull.checks === "fail") {
      events.push({
        key: "pr:" + pull.repo + "#" + (pull.number ?? "") + ":" + pull.head,
        text: "PR " + (pull.number === null ? "" : pull.number + " ") + "checks failing: "
          + said(pull.title),
      });
    }
  }
  return events;
}

/** Whether any source this reading draws from could not be read. */
function degraded(snapshot: Snapshot): boolean {
  return [snapshot.roster, snapshot.trials, snapshot.prs, snapshot.skills]
    .some((source) => source.state === "failed" || source.state === "unavailable");
}

/**
 * The events to alert on now, and the keys to remember.
 *
 * Nothing is news on the first reading (`seen` is null). After that an event is
 * news once. The keys remembered are this reading's own, so a job that leaves
 * blocked and comes back to it alerts again; while a source could not be read
 * the earlier keys are kept as well, so a source that recovers does not replay
 * everything it holds as though it had just happened.
 */
export function newEvents(seen: readonly string[] | null, snapshot: Snapshot,
                          sessionId: string): { fresh: FleetEvent[]; seen: string[] } {
  const events = eventsOf(snapshot, sessionId);
  const keys = events.map((event) => event.key);
  if (seen === null) {
    return { fresh: [], seen: keys };
  }
  const known = new Set(seen);
  const fresh = events.filter((event) => !known.has(event.key));
  const remembered = degraded(snapshot) ? [...new Set([...seen, ...keys])] : keys;
  return { fresh, seen: remembered };
}
