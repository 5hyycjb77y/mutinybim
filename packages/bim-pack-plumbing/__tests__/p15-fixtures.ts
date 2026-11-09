import { BUILTIN_LIBRARY_VERSION, type LibraryEntry } from "@permitzip/bim-kernel";
import { plumbingStarterTypes } from "../src";
import { CW, FT, K15Model, PVC, SAN, COPPER } from "../../bim-kernel/__tests__/k15-fixtures";

export { FT, K15Model };

/** A starter plumbing part type by slug (`wc-flush-tank` → `builtin:plumbing-wc-flush-tank@1`). */
export function starter(slug: string): LibraryEntry {
  const id = `builtin:plumbing-${slug}@1`;
  const entry = plumbingStarterTypes(BUILTIN_LIBRARY_VERSION).find((e) => e.id === id);
  if (!entry) throw new Error(`no starter ${id}`);
  return entry;
}

export const VENT = { id: "sys-v", kind: "vent" as const, name: "Vent" };
export const HW = { id: "sys-hw", kind: "domestic_hot_water" as const, name: "Domestic Hot Water" };

/**
 * A toilet room for round 15's Connect tests: a 4" sanitary branch 2 ft
 * below Level 1 along x at y = 0, a 2" vent main 8 ft up over it, 1"
 * cold and hot water 3 ft up along y = 6 ft, and four closets 3 ft north of
 * the drain (starter flush-tank closets, with vents).
 */
export function toiletRoom(opts: { readonly withVent?: boolean; readonly withWater?: boolean } = {}): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "san", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: -2 * FT, system: SAN, points: [{ x: -10 * FT, y: 0 }, { x: 40 * FT, y: 0 }] });
  if (opts.withVent) m.ok({ type: "route_run", idPrefix: "vent", levelId: "lvl-1", domain: "pipe", size: PVC(2), elevationMm: 8 * FT, system: VENT, points: [{ x: -10 * FT, y: 3 * FT }, { x: 40 * FT, y: 3 * FT }] });
  if (opts.withWater) {
    m.ok({ type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: COPPER(1), elevationMm: 3 * FT, system: CW, points: [{ x: -10 * FT, y: 6 * FT }, { x: 40 * FT, y: 6 * FT }] });
  }
  const wc = starter("wc-flush-tank");
  for (const [i, x] of [0, 8, 16, 24].entries()) m.place(`wc-${i + 1}`, wc, x * FT, 3 * FT, 0, `WC-${i + 1}`);
  return m;
}

export const CLOSETS = ["wc-1", "wc-2", "wc-3", "wc-4"];
