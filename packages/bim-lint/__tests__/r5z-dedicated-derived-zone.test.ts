/**
 * @jest-environment node
 *
 * Round 5b f-spatial: the NEC 110.26(E) dedicated space moved out of the
 * lint rule into the kernel's derived zones (spaces/derived-zones.ts), so
 * every pack and the Spaces panel read the same region. A refactor: the
 * region the rule reads must be exactly what the rule computed before, on
 * today's fixtures (r4e-electrical-checks), and the findings unchanged.
 *
 * `oldRegions` below is the rule's computation as it was before this change
 * (partClearances filtered to foreign-systems zones, the floor from
 * partFloorMm, the centre of corners 0 and 2, dedicatedZoneTop).
 *
 * Also measures `zones.derived.resolve.500` (500 panels, the old path vs the
 * derived zone cold and warm) and prints it.
 */
import { asElementId, builtinPartType, dedicatedZoneTop, DEDICATED_SPACE_RULE, derivedZonesOfHost, derivedZoneTop, partClearances, partFloorMm, type ModelState, type PartInstance } from "@permitzip/bim-kernel";
import { necEdition } from "@permitzip/bim-calc";
import { dedicatedSpaceZone } from "@permitzip/bim-pack-electrical";
import { FT, linkedBuilding, Model, rulesFired, SUPPLY } from "./fixtures";

const PANEL = builtinPartType("builtin:panelboard-225@1");
const NEC = necEdition("2023");
type Found = { structureMm: number | null; suspendedCeilingMm: number | null };
const FOUND: readonly Found[] = [
  { structureMm: null, suspendedCeilingMm: null },
  { structureMm: 13 * FT, suspendedCeilingMm: null },
  { structureMm: 13 * FT, suspendedCeilingMm: 8 * FT },
  { structureMm: 7 * FT, suspendedCeilingMm: 9 * FT },
];

function placePanel(m: Model, id: string, at: { x: number; y: number }, opts: { rotationDeg?: number; levelId?: string; offsetMm?: number } = {}): void {
  if (!PANEL) throw new Error("starter library is missing the panelboard");
  m.ok({ type: "place_part", partId: id, typeId: PANEL.id, partType: PANEL.definition, levelId: opts.levelId ?? "lvl-1", position: at, offsetMm: opts.offsetMm ?? 0, rotationDeg: opts.rotationDeg ?? 0, mark: id.toUpperCase(), values: { panel_name: id.toUpperCase() } });
}

function withDedicatedSpace(m: Model, id: string, extra: { suspendedCeilingMm?: number; structureMm?: number } = {}): void {
  const z = dedicatedSpaceZone(NEC);
  m.ok({ type: "set_part_clearances", id, scope: "instance", overrides: { [z.id]: { name: z.name, purpose: z.purpose, face: z.face, depth: z.depth as number, excludes: "foreign_systems", toStructure: true, endsAtSuspendedCeiling: true, cite: z.cite, ...extra } } });
}

function part(model: ModelState, id: string): PartInstance {
  const el = model.elements[id];
  if (el?.kind !== "part") throw new Error(`${id} is not a part`);
  return el;
}

/** The rule's region computation before this change. */
function oldRegions(model: ModelState, p: PartInstance, found: Found) {
  const floor = partFloorMm(model, p);
  return partClearances(model, p)
    .filter((z) => z.excludes === "foreign_systems")
    .map((zone) => {
      const cx = (zone.corners[0].x + zone.corners[2].x) / 2;
      const cy = (zone.corners[0].y + zone.corners[2].y) / 2;
      const top = dedicatedZoneTop(zone, floor, found);
      return { id: zone.id, corners: zone.corners, bottomMm: zone.bottomMm, cx, cy, top, cite: zone.cite, name: zone.name };
    });
}

function newRegions(model: ModelState, p: PartInstance, found: Found) {
  return derivedZonesOfHost(model, p, DEDICATED_SPACE_RULE).map((r) => ({ id: r.clearanceId, corners: r.clearance?.corners, bottomMm: r.clearance?.bottomMm, cx: r.centre.x, cy: r.centre.y, top: derivedZoneTop(r, found), cite: r.clearance?.cite, name: r.clearance?.name }));
}

function fixtures(): Model {
  const m = new Model();
  placePanel(m, "mdp-1", { x: 10 * FT, y: 10 * FT });
  withDedicatedSpace(m, "mdp-1");
  placePanel(m, "lp-1", { x: 30 * FT, y: 12 * FT }, { rotationDeg: 37 });
  withDedicatedSpace(m, "lp-1", { suspendedCeilingMm: 7 * FT });
  placePanel(m, "lp-2", { x: 40 * FT, y: 20 * FT }, { offsetMm: 600 });
  withDedicatedSpace(m, "lp-2", { structureMm: 7 * FT });
  placePanel(m, "rp-1", { x: 20 * FT, y: 30 * FT }, { levelId: "lvl-roof" });
  withDedicatedSpace(m, "rp-1");
  placePanel(m, "np-1", { x: 5 * FT, y: 35 * FT }); // no dedicated space: no region before or after
  return m;
}

describe("r5z the 110.26(E) space as a derived zone", () => {
  it("equivalence: the region the rule reads is exactly the one it computed before, for every fixture and building above", () => {
    const m = fixtures();
    for (const id of ["mdp-1", "lp-1", "lp-2", "rp-1", "np-1"]) {
      for (const found of FOUND) expect(newRegions(m.head, part(m.head, id), found)).toEqual(oldRegions(m.head, part(m.head, id), found));
    }
    expect(newRegions(m.head, part(m.head, "np-1"), FOUND[0] as Found)).toEqual([]);
  });

  it("equivalence after edits: moved, rotated and with its level raised, the derived zone still matches the old computation", () => {
    const m = fixtures();
    m.ok({ type: "move_elements", ids: ["mdp-1"], delta: { x: 3 * FT, y: -2 * FT } });
    m.ok({ type: "rotate_elements", ids: ["lp-1"], angleDeg: 15 });
    m.ok({ type: "update_level", levelId: "lvl-roof", elevationMm: 26 * FT });
    for (const id of ["mdp-1", "lp-1", "rp-1"]) for (const found of FOUND) expect(newRegions(m.head, part(m.head, id), found)).toEqual(oldRegions(m.head, part(m.head, id), found));
  });

  it("findings unchanged on today's fixtures: the duct in MDP-1's soffit, and the suspended ceiling that clears it", () => {
    const m = new Model();
    placePanel(m, "mdp-1", { x: 10 * FT, y: 10 * FT });
    withDedicatedSpace(m, "mdp-1");
    m.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8);
    expect(rulesFired(m.head, [linkedBuilding()]).get("dedicated-space-intrusion")).toEqual([`Supply Air 1 20"x12" supply air duct is in the dedicated space above MDP-1 (within 6'-0"): NEC 2023 110.26(E)(1)(a)`]);
    expect(rulesFired(m.head, []).get("dedicated-space-intrusion")?.[0]).toMatch(/no structural ceiling known, so taken to 6'-0"/);
    const cleared = new Model();
    placePanel(cleared, "mdp-1", { x: 10 * FT, y: 10 * FT });
    withDedicatedSpace(cleared, "mdp-1", { suspendedCeilingMm: 7 * FT });
    cleared.duct("sa", SUPPLY, [[0, 10], [30, 10]], 8);
    expect(rulesFired(cleared.head, [linkedBuilding()]).get("dedicated-space-intrusion") ?? []).toEqual([]);
  });

  it("zones.derived.resolve.500: 500 panels' dedicated spaces, old path vs derived zone (cold, then warm)", () => {
    const m = new Model();
    for (let i = 0; i < 500; i++) {
      placePanel(m, `p-${i}`, { x: (i % 25) * 4 * FT, y: Math.floor(i / 25) * 4 * FT });
      withDedicatedSpace(m, `p-${i}`);
    }
    const parts = Array.from({ length: 500 }, (_, i) => part(m.head, `p-${i}`));
    const found = FOUND[1] as Found;
    const time = (fn: () => void) => {
      const samples: number[] = [];
      for (let k = 0; k < 9; k++) {
        const t0 = performance.now();
        fn();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return { p50: samples[4] ?? 0, p95: samples[8] ?? 0 };
    };
    const old = time(() => {
      for (const p of parts) oldRegions(m.head, p, found);
    });
    // Cold: a fresh copy of every part, so the per-host cache misses each sample.
    const cold = time(() => {
      for (const p of parts) newRegions(m.head, { ...p }, found);
    });
    const warm = time(() => {
      for (const p of parts) newRegions(m.head, p, found);
    });
    process.stderr.write(`[r5z zones.derived.resolve.500] old p50 ${old.p50.toFixed(2)} / p95 ${old.p95.toFixed(2)} ms; derived cold ${cold.p50.toFixed(2)} / ${cold.p95.toFixed(2)} ms; warm ${warm.p50.toFixed(2)} / ${warm.p95.toFixed(2)} ms\n`);
    expect(warm.p50).toBeLessThanOrEqual(old.p50 * 1.5 + 1);
    expect(asElementId("p-0")).toBe("p-0");
  });
});
