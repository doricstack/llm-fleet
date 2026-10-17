/**
 * A new reading, landed on the pane one source at a time.
 *
 * The machine is read whole every interval, and drawn whole, every section that
 * changed changed in one frame: the pane sat still for twenty seconds and then
 * jumped. Here the drawn reading walks toward the read one, a source per step,
 * in the order the pane draws its sections, so a reading arrives as a ripple
 * down the pane rather than a jump. Nothing here waits or keeps time: the caller
 * takes a step on its own clock and asks for a frame after each.
 *
 * What is not a section (the read times, the pane's own configuration) lands at
 * once, because it decides how everything else is drawn. The first reading
 * lands whole: there is nothing on the pane yet to ripple over.
 */

/** The sources the pane draws as sections, in the order it draws them. */
export const STREAM_ORDER = ["session", "progress", "trials", "prs", "roster", "worktrees",
                             "skills", "custom"] as const;

type Documents = Record<string, unknown>;

const STREAMED: ReadonlySet<string> = new Set(STREAM_ORDER);

/** Whether two readings of one source say the same thing. */
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The sources whose drawn reading differs from the new one, in the pane's order. */
export function pendingSources(shown: Documents | null, target: Documents | null): string[] {
  if (shown === null || target === null) {
    return [];
  }
  return STREAM_ORDER.filter((key) => (key in shown) !== (key in target)
                                      || !same(shown[key], target[key]));
}

/**
 * One step toward the new reading: everything that is not a section, and the
 * first section that changed. `pending` is what is still to land after it.
 */
export function stepStream(shown: Documents | null,
                           target: Documents | null,
                           only?: string): { documents: Documents | null;
                                             pending: string[] } {
  if (target === null) {
    return { documents: null, pending: [] };
  }
  if (shown === null) {
    return { documents: target, pending: [] };
  }
  const next: Documents = {};
  for (const [key, value] of Object.entries(target)) {
    if (!STREAMED.has(key)) {
      next[key] = value;
    }
  }
  for (const key of STREAM_ORDER) {
    if (key in shown) {
      next[key] = shown[key];
    }
  }
  // A stream that names its next section lands that one, so a section read
  // again mid-stream waits behind the ones already in line.
  const pending = pendingSources(shown, target);
  const first = only === undefined ? pending[0]
    : pending.includes(only) ? only : undefined;
  const rest = pending.filter((key) => key !== first);
  if (first !== undefined) {
    if (first in target) {
      next[first] = target[first];
    } else {
      delete next[first];
    }
  }
  return { documents: next, pending: rest };
}
