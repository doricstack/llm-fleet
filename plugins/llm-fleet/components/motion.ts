/**
 * What moves on the pane, decided by comparing this paint with the last one.
 *
 * A row that was not drawn last time slides in from the right on a tint; a row
 * that was drawn and is gone slides out where it stood; a section that goes
 * slides out whole; and warnings that arrive or change blink for a while. Each
 * movement is a short span of time measured on the engine's clock, so the
 * caller asks for frames only while `moving` says something is still in
 * flight, and the pane holds still the rest of the time.
 *
 * The first paint moves nothing: rows that were already there when the pane
 * opened did not arrive, and a pane that slid every row in on opening would be
 * telling a person about news that is not news.
 */

import type { Group, Pane, Row } from "./layout.ts";

/** How long a row takes to slide in or out, in milliseconds. */
export const SLIDE_MS = 360;
/** How far a row starts from, or travels to, in cells. */
export const SLIDE_CELLS = 6;
/** How long warnings blink after they arrive or change. */
export const BLINK_MS = 3000;
/** How long each half of a blink lasts. */
export const BLINK_PERIOD_MS = 400;

const WARNINGS = "warnings";

type Placed = { group: string; row: Row; index: number };
type Leaving = Placed & { at: number };
type GroupLeaving = { group: Group; index: number; at: number };

/** What the last paint drew, and what is in flight since. */
export type Motion = {
  primed: boolean;
  rows: Map<string, Placed>;
  groups: Map<string, { group: Group; index: number }>;
  arrived: Map<string, number>;
  leaving: Map<string, Leaving>;
  groupsLeaving: Map<string, GroupLeaving>;
  warned: string;
  blinkFrom: number | null;
};

export function motionMemory(): Motion {
  return { primed: false, rows: new Map(), groups: new Map(), arrived: new Map(),
           leaving: new Map(), groupsLeaving: new Map(), warned: "", blinkFrom: null };
}

/** A section's id: its fold control's address, or its title when it has none. */
function groupId(group: Group): string {
  return group.toggle?.key ?? group.title;
}

function rowId(group: string, row: Row): string {
  return group + "|" + (row.key ?? row.title);
}

function isWarnings(group: Group): boolean {
  return (group.toggle?.key ?? "").endsWith("." + WARNINGS);
}

/** Eased so a row decelerates into place rather than stopping dead. */
function eased(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return 1 - (1 - clamped) * (1 - clamped);
}

/**
 * The pane to draw now, with what is moving marked on it, and whether anything
 * still is. `memory` is the caller's, kept across paints.
 */
export function animate(pane: Pane, memory: Motion, now: number): { pane: Pane; moving: boolean } {
  const rows = new Map<string, Placed>();
  const groups = new Map<string, { group: Group; index: number }>();
  pane.groups.forEach((group, index) => {
    const id = groupId(group);
    groups.set(id, { group, index });
    if (group.collapsed) {
      return;
    }
    group.rows.forEach((row, at) => rows.set(rowId(id, row), { group: id, row, index: at }));
  });
  const warnings = pane.groups.find(isWarnings);
  const warned = warnings && !warnings.collapsed
    ? warnings.rows.map((row) => row.title).join("\n") : "";

  if (!memory.primed) {
    memory.primed = true;
    memory.rows = rows;
    memory.groups = groups;
    memory.warned = warned;
    return { pane, moving: false };
  }

  for (const id of rows.keys()) {
    if (!memory.rows.has(id) && !memory.arrived.has(id)) {
      memory.arrived.set(id, now);
    }
    memory.leaving.delete(id);
  }
  for (const [id, placed] of memory.rows) {
    if (rows.has(id)) {
      continue;
    }
    // A row whose section is still drawn open slides out of it; one whose
    // section went slides out with the section, below.
    const holder = groups.get(placed.group);
    if (holder && !holder.group.collapsed && !memory.leaving.has(id)) {
      memory.leaving.set(id, { ...placed, at: now });
    }
  }
  for (const [id, held] of memory.groups) {
    if (!groups.has(id) && !memory.groupsLeaving.has(id) && !held.group.collapsed
        && held.group.rows.length) {
      memory.groupsLeaving.set(id, { ...held, at: now });
    }
  }
  for (const id of groups.keys()) {
    memory.groupsLeaving.delete(id);
  }
  if (warned && warned !== memory.warned) {
    memory.blinkFrom = now;
  }
  if (!warned) {
    memory.blinkFrom = null;
  }
  memory.warned = warned;
  memory.rows = rows;
  memory.groups = groups;

  for (const [id, at] of memory.arrived) {
    if (now - at >= SLIDE_MS) {
      memory.arrived.delete(id);
    }
  }
  for (const [id, leaving] of memory.leaving) {
    if (now - leaving.at >= SLIDE_MS) {
      memory.leaving.delete(id);
    }
  }
  for (const [id, leaving] of memory.groupsLeaving) {
    if (now - leaving.at >= SLIDE_MS) {
      memory.groupsLeaving.delete(id);
    }
  }
  const blinking = memory.blinkFrom !== null && now - memory.blinkFrom < BLINK_MS;

  const drawn = pane.groups.map((group) => {
    const id = groupId(group);
    if (group.collapsed || group.state === "paused") {
      return group;
    }
    const marked: Row[] = group.rows.map((row) => {
      const at = memory.arrived.get(rowId(id, row));
      if (at === undefined) {
        return row;
      }
      const offset = Math.round((1 - eased((now - at) / SLIDE_MS)) * SLIDE_CELLS);
      return { ...row, motion: { offset, arriving: true } };
    });
    // Leaving rows go back where they stood, in the order they stood in.
    const going = [...memory.leaving.values()].filter((leaving) => leaving.group === id)
      .sort((a, b) => a.index - b.index);
    for (const leaving of going) {
      const offset = Math.round(eased((now - leaving.at) / SLIDE_MS) * SLIDE_CELLS);
      marked.splice(Math.min(leaving.index, marked.length), 0,
                    { ...leaving.row, motion: { offset, leaving: true } });
    }
    const blink = isWarnings(group) && blinking
      ? Math.floor((now - (memory.blinkFrom as number)) / BLINK_PERIOD_MS) % 2 === 0
      : undefined;
    return { ...group, rows: marked, ...(blink !== undefined ? { blink } : {}) };
  });
  const goneGroups = [...memory.groupsLeaving.values()].sort((a, b) => a.index - b.index);
  for (const gone of goneGroups) {
    const offset = Math.round(eased((now - gone.at) / SLIDE_MS) * SLIDE_CELLS);
    drawn.splice(Math.min(gone.index, drawn.length), 0, {
      ...gone.group,
      rows: gone.group.rows.map((row) => ({ ...row, motion: { offset, leaving: true } })),
    });
  }
  const moving = memory.arrived.size > 0 || memory.leaving.size > 0
    || memory.groupsLeaving.size > 0 || blinking;
  return { pane: { ...pane, groups: drawn }, moving };
}
