/**
 * The key tip after the prompt hint, and the words `/keys` takes.
 *
 * While a draft is typed, the hint line under the prompt ends with one of the
 * tips the pane's Keys section lists, and the tip moves on at the interval the
 * configuration sets. The tips are the pane's own, so the line and the section
 * never disagree about what a key does.
 *
 * Whether tips show is two answers: the configuration's (`keys.tipsEnabled`),
 * and the person's own, set with `/keys tips off|on` and kept in the store so
 * it holds in the next session. Either one off is off, in the hint line and in
 * the Keys section alike.
 */

/** What `/keys` says when it is handed words it does not take. */
export const KEYS_USAGE = "Use /keys to open the llm-fleet pane on its keys, or /keys tips off|on.";

/** What `/keys` was asked: open the pane on Keys, switch the tips, or words it does not take. */
export type KeysRequest = "open" | { tips: boolean } | null;

/** Read `/keys`'s words. */
export function keysRequest(args: string): KeysRequest {
  const words = args.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    return "open";
  }
  if (words.length === 2 && words[0] === "tips" && (words[1] === "on" || words[1] === "off")) {
    return { tips: words[1] === "on" };
  }
  return null;
}

/**
 * Whether tips show: the configuration allows them and the person has not
 * turned them off. A preference never read, or not a yes or no, is no
 * preference, and the configuration decides.
 */
export function tipsShown(configured: boolean, preference: unknown): boolean {
  return configured && preference !== false;
}

/**
 * The tip at this turn of the rotation, or null when there is none to show.
 *
 * The turn counts up for the whole session, so a list that changed length
 * under it still lands on a tip rather than past the end.
 */
export function tipAt(tips: readonly string[], turn: number): string | null {
  if (tips.length === 0) {
    return null;
  }
  const index = ((Math.trunc(turn) % tips.length) + tips.length) % tips.length;
  return tips[index] ?? null;
}

/** The hint line's tail with a tip after whatever another hook put there. */
export function withTip(tail: string | undefined, tip: string): string {
  return (tail ?? "") + "  " + tip;
}
