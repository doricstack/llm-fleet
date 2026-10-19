/**
 * The fleet plugin's contract with the engine: the values it keeps in `$.state`,
 * and the keys it keeps in `$.store`.
 *
 * Written by hand and named as "types" in .claude-plugin/plugin.json. The
 * engine's own declaration, which it scaffolds into .claude-plugin/types/ when
 * it loads the plugin, is generated and never committed; this file only adds to
 * it, by declaration merging, and imports nothing.
 *
 * `claude plugin validate` reads the `$.state` calls in the hooks module off its
 * source and refuses a key this interface does not name, so a new key is
 * declared here in the same change that first reads or writes it.
 */

/**
 * Which sections a person folded in this session, by section name: true for
 * folded, false for opened. Only what was pressed; the configuration decides
 * every section nobody touched.
 */
export type FleetFold = Record<string, boolean>;

/**
 * The person's last look, for the "since you left" digest: the newest event a
 * digest drew when its pane closed, in epoch seconds. It only moves forward.
 */
export type FleetDigestSeen = { at: number };

/**
 * Every key the plugin keeps in its `$.store`, and what each holds.
 *
 * The store is keyed by free text the host does not check, so this is where a
 * key is written down: `tests/test_plugin_contract.py` refuses a key the entry
 * names and this does not declare, and one declared here that nothing names.
 */
export interface FleetStore {
  /** Which session reads the whole machine for every session, and since when. */
  "reading.claim": { at: number; by: string };
  /** Which session reads a live governor run's counts for every session. */
  "progress.claim": { at: number; by: string };
  /** The last reading, so a pane opens on the fleet as it last stood. */
  "last-reading": { documents: unknown; at: number; progressAt?: number };
  /** A live governor run's counts, read apart from the whole reading. */
  "live-counts": unknown;
  /** The band items a person dismissed, by key. */
  "band-hidden": string[];
  /** The replies sent from a pane, by reply key, newest last. */
  "replied": string[];
  /** The voice picked before each session kept its own. */
  "voice": unknown;
  /** Whether speech is on in every session; absent is off. */
  "speech.on": boolean;
  /** The folds a person left, for the next session. */
  "folds": FleetFold;
  /** The person's own word on the key tips: false is off. */
  "key-tips": unknown;
  /** The digest's last look every session shares: the latest a closed pane's digest drew, as near as a store without compare-and-set keeps it. */
  "digest-seen": FleetDigestSeen;
  /** The voice one session picked, under that session's identifier. */
  [sessionVoice: `voice:${string}`]: unknown;
}

declare module "claude-code" {
  interface PluginState {
    "llm-fleet": {
      /** Read by `restoreFold` on the first paint; written on every press. */
      folded: FleetFold;
      /** The sections a person pressed to draw in full; read by `restoreShownAll` on the first paint and written on its press. */
      shownAll: FleetFold;
      /** The sections a person put away; read by `restorePutAway` on the first paint and written on each picker press. */
      hidden: FleetFold;
      /** This session's own digest look: read on each opening, written at the version read when the pane closes. */
      digestSeen: FleetDigestSeen;
    };
  }
}
