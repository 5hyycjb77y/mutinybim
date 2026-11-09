/**
 * Example B for risers and isometrics: the three-storey restroom stack, the
 * same routing as the load-points stream's `three-storey-stack.ts`, with each
 * fixture a part on the end of its pipe. Per floor (Levels 1–3 at 0, 12 and
 * 24 ft): two water closets (5 cold WSFU, 4 DFU) and two lavatories (1.5 cold,
 * 1.5 hot WSFU, 1 DFU). A 4" sanitary stack with a 3" floor branch per floor
 * and a 4" building drain with a cleanout at the base; a 3" vent stack through
 * the roof; 2" cold and 1" hot risers (capped at the top) with a branch per
 * floor. 10 DFU per floor, 30 at the base; 13 cold WSFU per floor, 39 at the
 * service; 3 hot per floor, 9 at the base.
 */
import type { PartTypeDefinition } from "../../src";
import { Building } from "./electrical-building";
import { attach, partType } from "./sample-market-risers";

const FT = 304.8;
const IN = 25.4;
const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });

export const STACK_SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
export const STACK_VENT = { id: "sys-vent", kind: "vent" as const, name: "Vent" };
export const STACK_CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
export const STACK_HW = { id: "sys-hw", kind: "domestic_hot_water" as const, name: "Domestic Hot Water" };
export const FLOORS = [0, 12 * FT, 24 * FT] as const;
export const STACK_RISER_TOTALS = { dfuPerFloor: 10, dfuBase: 30, cwService: 39, hwBase: 9 } as const;

const FIXTURES = ["WC", "WC", "LAV", "LAV"] as const;

const types: Record<string, PartTypeDefinition> = {
  "WC-san": partType("Water closet, flush tank", "plumbing_fixture", [{ id: "c", kind: "sanitary", flow: 4 }]),
  "LAV-san": partType("Lavatory", "plumbing_fixture", [{ id: "c", kind: "sanitary", flow: 1 }]),
  "WC-cw": partType("Water closet, flush tank", "plumbing_fixture", [{ id: "c", kind: "domestic_cold_water", flow: 5 }]),
  "LAV-cw": partType("Lavatory", "plumbing_fixture", [{ id: "c", kind: "domestic_cold_water", flow: 1.5 }]),
  "LAV-hw": partType("Lavatory", "plumbing_fixture", [{ id: "c", kind: "domestic_hot_water", flow: 1.5 }]),
};

/**
 * A vertical run is split where it crosses a floor. The stack is drawn top down:
 * `stackPiece(f)` is the piece just below floor f (stackPiece(0), below Level 1, is its base).
 * The risers are drawn bottom up: `riserPiece(r, f)` is the piece just above floor f.
 */
const stackPiece = (floorIndex: number) => `stack-s${FLOORS.length + 1 - floorIndex}`;
const riserPiece = (riser: "cw" | "hw", floorIndex: number) => `${riser}-s${floorIndex + 1}`;

function fixtureAt(b: Building, segmentId: string, mark: string, key: string): void {
  const type = types[key];
  if (!type) throw new Error(key);
  attach(b, segmentId, "start", `${key.split("-")[1]}-${mark.toLowerCase()}`, `t-${key.toLowerCase()}`, type, mark);
}

export function stackRisers(): Building {
  const b = new Building();
  b.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: FLOORS[1] });
  b.ok({ type: "create_level", levelId: "lvl-3", name: "Level 3", elevationMm: FLOORS[2] });
  const top = FLOORS[2] + 8 * FT;
  b.ok({ type: "route_run", idPrefix: "stack", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: top, system: STACK_SAN, points: [{ x: 0, y: 0 }, { x: 0, y: 0, elevationMm: -2 * FT }] });
  b.ok({ type: "route_run", idPrefix: "bd", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -5 * FT, system: STACK_SAN, points: [{ x: 0, y: -40 * FT }], from: { kind: "run_end", elementId: stackPiece(0), port: "end" }, slopeInPerFt: 0.125 });
  b.ok({ type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper(2), elevationMm: 0, system: STACK_CW, points: [{ x: 2 * FT, y: 6 * FT }, { x: 2 * FT, y: 6 * FT, elevationMm: FLOORS[2] + 6 * FT }], capEnd: true });
  b.ok({ type: "route_run", idPrefix: "hw", levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: 0, system: STACK_HW, points: [{ x: 3 * FT, y: 8 * FT }, { x: 3 * FT, y: 8 * FT, elevationMm: FLOORS[2] + 6 * FT }], capEnd: true });
  b.ok({ type: "route_run", idPrefix: "vent", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: FLOORS[2] + 14 * FT, system: STACK_VENT, points: [{ x: -1 * FT, y: 0 }, { x: -1 * FT, y: 0, elevationMm: 0 }] });

  FLOORS.forEach((z, f) => {
    const floor = f + 1;
    const san = `san-L${floor}`;
    b.ok({ type: "route_run", idPrefix: san, levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: z - 1 * FT, system: STACK_SAN, points: [{ x: 16 * FT, y: 0 }, { x: 0, y: 0 }], to: { kind: "run_branch", segmentId: stackPiece(f) } });
    FIXTURES.forEach((kind, k) => {
      const mark = `${kind}-${floor}-${(k % 2) + 1}`;
      if (k === 0) return fixtureAt(b, `${san}-s1`, mark, `${kind}-san`);
      const x = (16 - 4 * k) * FT;
      b.ok({ type: "route_run", idPrefix: `${san}-${k}`, levelId: "lvl-1", domain: "pipe", size: pvc(2), system: STACK_SAN, points: [{ x, y: 4 * FT }, { x, y: 0 }], to: { kind: "run_branch", segmentId: `${san}-s1` } });
      fixtureAt(b, `${san}-${k}-s1`, mark, `${kind}-san`);
    });
    const cw = `cw-L${floor}`;
    b.ok({ type: "route_run", idPrefix: cw, levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: z + 3 * FT, system: STACK_CW, points: [{ x: 16 * FT, y: 6 * FT }, { x: 2 * FT, y: 6 * FT }], to: { kind: "run_branch", segmentId: riserPiece("cw", f) } });
    FIXTURES.forEach((kind, k) => {
      const mark = `${kind}-${floor}-${(k % 2) + 1}`;
      if (k === 0) return fixtureAt(b, `${cw}-s1`, mark, `${kind}-cw`);
      const x = (16 - 3 * k) * FT;
      b.ok({ type: "route_run", idPrefix: `${cw}-${k}`, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: STACK_CW, points: [{ x, y: 10 * FT }, { x, y: 6 * FT }], to: { kind: "run_branch", segmentId: `${cw}-s1` } });
      fixtureAt(b, `${cw}-${k}-s1`, mark, `${kind}-cw`);
    });
    const hw = `hw-L${floor}`;
    b.ok({ type: "route_run", idPrefix: hw, levelId: "lvl-1", domain: "pipe", size: copper(0.75), elevationMm: z + 3 * FT, system: STACK_HW, points: [{ x: 12 * FT, y: 8 * FT }, { x: 3 * FT, y: 8 * FT }], to: { kind: "run_branch", segmentId: riserPiece("hw", f) } });
    fixtureAt(b, `${hw}-s1`, `LAV-${floor}-1`, "LAV-hw");
    b.ok({ type: "route_run", idPrefix: `${hw}-2`, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: STACK_HW, points: [{ x: 7 * FT, y: 12 * FT }, { x: 7 * FT, y: 8 * FT }], to: { kind: "run_branch", segmentId: `${hw}-s1` } });
    fixtureAt(b, `${hw}-2-s1`, `LAV-${floor}-2`, "LAV-hw");
  });
  b.ok({ type: "place_run_accessory", accessoryId: "co-base", segmentId: "bd-s2", atMm: 2 * FT, family: "dwv.cleanout_wye" });
  return b;
}
