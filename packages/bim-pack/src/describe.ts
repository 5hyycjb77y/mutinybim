import { installedFirstPartyPacks, type Pack, type PackPin, missingPinWords, type BlockedPin, type InstalledOutsidePack, type ReviewState } from "@permitzip/bim-kernel/packs";
import { KNOWN_POINTS } from "./points";

/** What one pack adds at one point, for a list a person reads. */
export interface PackPointCount {
  readonly pointId: string;
  readonly label: string;
  readonly count: number;
}

/** One row of Settings › MutinyBIM library › Add-ons. */
export interface PackSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  /** Shipped with MutinyBIM (its rows are built in). */
  readonly firstParty: boolean;
  /** A pinned pack this host doesn't have: listed so a person sees it, never silently dropped. */
  readonly missing: boolean;
  readonly contributes: readonly PackPointCount[];
  /** Install gate (round 11 A11): an outside add-on's review state in this firm. Absent for the host's own add-ons. */
  readonly review?: ReviewState;
  /** Install gate: why a pinned add-on isn't loaded, in words ("This model needs add-on X 1.2.0: …"). Set when `missing`. */
  readonly needs?: string;
}

function countsOf(pack: Pack): PackPointCount[] {
  const out: PackPointCount[] = [];
  for (const point of KNOWN_POINTS) {
    const fromBuiltins = pack.manifest.firstParty ? (point.builtinCounts().get(pack.manifest.id) ?? 0) : 0;
    const fromPack = pack.contributions.filter((c) => c.pointId === point.id).reduce((n, c) => n + c.items.length, 0);
    if (fromBuiltins + fromPack > 0) out.push({ pointId: point.id, label: point.label, count: fromBuiltins + fromPack });
  }
  return out;
}

function summaryOf(pack: Pack): PackSummary {
  const m = pack.manifest;
  return { id: m.id, name: m.name, version: m.version, description: m.description ?? null, firstParty: m.firstParty === true, missing: false, contributes: countsOf(pack) };
}

/**
 * The add-ons a host lists: the first-party packs first, then `installed`
 * (packs this host has), then any pin naming a pack or version it doesn't
 * have ("This model uses Structural 1.2.0, which isn't installed").
 */
export function describePacks(installed: readonly Pack[] = [], pins: readonly PackPin[] = [], outside: OutsideListing = {}): readonly PackSummary[] {
  const firstParty = installedFirstPartyPacks();
  const blocked = outside.blocked ?? [];
  const rows = [...firstParty, ...installed].map(summaryOf);
  // Install gate: the firm's outside add-ons with their review state, then pins that didn't load with why.
  for (const entry of outside.installed ?? []) {
    if (rows.some((r) => r.id === entry.pack.manifest.id && r.version === entry.pack.manifest.version)) continue;
    rows.push({ ...summaryOf(entry.pack), ...(entry.name ? { name: entry.name } : {}), review: entry.review.state });
  }
  for (const pin of pins) {
    const why = blocked.find((b) => b.pin.id === pin.id && b.pin.version === pin.version);
    if (!why && rows.some((r) => r.id === pin.id && r.version === pin.version)) continue;
    const row = rows.findIndex((r) => r.id === pin.id && r.version === pin.version);
    const needs = why?.words ?? missingPinWords(pin);
    if (row >= 0) rows[row] = { ...(rows[row] as PackSummary), missing: true, needs };
    else rows.push({ id: pin.id, name: pin.id, version: pin.version, description: null, firstParty: false, missing: true, contributes: [], needs });
  }
  return rows;
}

/** Install gate: the firm's outside add-ons and the pins `outsidePacksForPins` blocked, for `describePacks`. */
export interface OutsideListing {
  readonly installed?: readonly InstalledOutsidePack[];
  readonly blocked?: readonly BlockedPin[];
}
