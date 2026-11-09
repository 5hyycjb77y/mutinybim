/**
 * Example B: a three-storey restroom stack (synthetic). Shared by the plumbing
 * streams for stacks, risers, isometrics and vents (P-F, P-G, P-I). Built
 * only from commands; reuse it and extend it with new exports.
 *
 * Per floor (Levels 1–3 at 0, 12 and 24 ft): two water closets (starter
 * WC-FT: 5 cold WSFU, 4 DFU) and two lavatories (starter LAV: 1.5 cold /
 * 1.5 hot / 2 total WSFU, 1 DFU), as load points on each floor's branches.
 *
 * - Sanitary: a 4" stack from above Level 3 down to 2 ft below Level 1,
 *   split at each floor it crosses (`stack-s1` above Level 3 … `stack-s4`
 *   below Level 1), a 3" floor branch per floor into that floor's piece (`san-L<n>-s1`) with the
 *   fixtures on it, and a 4" building drain from the stack's base at
 *   1/8"/ft (`bd-*`) with a cleanout wye at the base. 10 DFU per floor, 30 at
 *   the base and in the building drain. (The analysis asked for a 2" drain
 *   at 1/8"/ft; the kernel's slope rule refuses that, as the code does: 2"
 *   needs 1/4"/ft.)
 * - Vent: a 3" vent stack (`vent-s1`) with a VTR load point at its top.
 * - Domestic cold: a riser from the service at Level 1, split at each floor
 *   (`cw-s1` from the open bottom end, `cw-s2`, `cw-s3`), with a branch per
 *   floor into that floor's piece: 13 WSFU per floor, 39 at the service.
 * - Domestic hot: a riser split the same way (`hw-s1` at its base) with the lavatories' hot points: 3 WSFU
 *   per floor, 9 at its base (no water heater modelled: the riser's base is
 *   where one would connect).
 *
 * All routes are drawn on Level 1's coordinates (heights above its floor),
 * and the fixtures' floor is told by their marks ("WC-2-1": Level 2, first).
 */
import type { Command } from "../../src";

const FT = 304.8;
const IN = 25.4;
const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });

export const STACK_SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
export const STACK_VENT = { id: "sys-vent", kind: "vent" as const, name: "Vent" };
export const STACK_CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
export const STACK_HW = { id: "sys-hw", kind: "domestic_hot_water" as const, name: "Domestic Hot Water" };
export const FLOORS = [0, 12 * FT, 24 * FT] as const;

/** Expected totals: DFU per floor branch and at the stack base, WSFU per floor and at each riser's base. */
/**
 * A vertical run is split where it crosses a floor. The stack is drawn top down:
 * `stackPiece(f)` is the piece just below floor f (stackPiece(0), below Level 1, is its base).
 * The risers are drawn bottom up: `riserPiece(r, f)` is the piece just above floor f.
 */
const stackPiece = (floorIndex: number) => `stack-s${FLOORS.length + 1 - floorIndex}`;
const riserPiece = (riser: "cw" | "hw", floorIndex: number) => `${riser}-s${floorIndex + 1}`;

export const STACK_TOTALS = { dfuPerFloor: 10, dfuBase: 30, cwPerFloor: 13, cwService: 39, hwPerFloor: 3, hwBase: 9 } as const;

export interface StackPoint {
  readonly mark: string;
  readonly connectionType: "WC-FT" | "LAV" | "VTR";
  readonly hostId: string;
  readonly port: string;
}

/** The fixtures on one floor branch: the branch's open start, then three short branches into it. */
const FIXTURES = ["WC", "WC", "LAV", "LAV"] as const;

export function threeStoreyStack(): { readonly setup: Command[]; readonly points: StackPoint[]; readonly ids: { readonly stack: string; readonly drain: string; readonly cwRiser: string; readonly hwRiser: string; readonly floorBranches: readonly string[] } } {
  const setup: Command[] = FLOORS.map((z, i) => ({ type: "create_level", levelId: `lvl-${i + 1}`, name: `Level ${i + 1}`, elevationMm: z }));
  const points: StackPoint[] = [];
  const top = FLOORS[2] + 8 * FT;

  // Sanitary stack, base 2 ft below Level 1, and the building drain from its base.
  setup.push({ type: "route_run", idPrefix: "stack", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: top, system: STACK_SAN, points: [{ x: 0, y: 0 }, { x: 0, y: 0, elevationMm: -2 * FT }] });
  setup.push({ type: "route_run", idPrefix: "bd", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -5 * FT, system: STACK_SAN, points: [{ x: 0, y: -40 * FT }], from: { kind: "run_end", elementId: stackPiece(0), port: "end" }, slopeInPerFt: 0.125 });

  const floorBranches: string[] = [];
  FLOORS.forEach((z, f) => {
    const floor = f + 1;
    // Sanitary floor branch, 1 ft below the floor, into the stack.
    const san = `san-L${floor}`;
    floorBranches.push(`${san}-s1`);
    setup.push({ type: "route_run", idPrefix: san, levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: z - 1 * FT, system: STACK_SAN, points: [{ x: 16 * FT, y: 0 }, { x: 0, y: 0 }], to: { kind: "run_branch", segmentId: stackPiece(f) } });
    // Cold and hot floor branches, 3 ft above the floor, into their risers.
    const cw = `cw-L${floor}`;
    const hw = `hw-L${floor}`;
    FIXTURES.forEach((kind, k) => {
      const mark = `${kind}-${floor}-${(k % 2) + 1}`;
      const ct = kind === "WC" ? "WC-FT" : "LAV";
      const x = (16 - 4 * k) * FT;
      if (k === 0) {
        points.push({ mark, connectionType: ct, hostId: `${san}-s1`, port: "start" });
        return;
      }
      setup.push({ type: "route_run", idPrefix: `${san}-${k}`, levelId: "lvl-1", domain: "pipe", size: pvc(2), system: STACK_SAN, points: [{ x, y: 4 * FT }, { x, y: 0 }], to: { kind: "run_branch", segmentId: `${san}-s1` } });
      points.push({ mark, connectionType: ct, hostId: `${san}-${k}-s1`, port: "start" });
    });
    // Cold: a floor branch to the riser at (2 ft, 6 ft), fixtures on short branches.
    setup.push({ type: "route_run", idPrefix: cw, levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: z + 3 * FT, system: STACK_CW, points: [{ x: 16 * FT, y: 6 * FT }, { x: 2 * FT, y: 6 * FT }], to: { kind: "run_branch", segmentId: riserPiece("cw", f) } });
    FIXTURES.forEach((kind, k) => {
      const mark = `${kind}-${floor}-${(k % 2) + 1}`;
      const ct = kind === "WC" ? "WC-FT" : "LAV";
      if (k === 0) {
        points.push({ mark, connectionType: ct, hostId: `${cw}-s1`, port: "start" });
        return;
      }
      const x = (16 - 3 * k) * FT;
      setup.push({ type: "route_run", idPrefix: `${cw}-${k}`, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: STACK_CW, points: [{ x, y: 10 * FT }, { x, y: 6 * FT }], to: { kind: "run_branch", segmentId: `${cw}-s1` } });
      points.push({ mark, connectionType: ct, hostId: `${cw}-${k}-s1`, port: "start" });
    });
    // Hot: the two lavatories, on a branch to the hot riser at (3 ft, 8 ft).
    setup.push({ type: "route_run", idPrefix: hw, levelId: "lvl-1", domain: "pipe", size: copper(0.75), elevationMm: z + 3 * FT, system: STACK_HW, points: [{ x: 12 * FT, y: 8 * FT }, { x: 3 * FT, y: 8 * FT }], to: { kind: "run_branch", segmentId: riserPiece("hw", f) } });
    points.push({ mark: `LAV-${floor}-1`, connectionType: "LAV", hostId: `${hw}-s1`, port: "start" });
    setup.push({ type: "route_run", idPrefix: `${hw}-2`, levelId: "lvl-1", domain: "pipe", size: copper(0.5), system: STACK_HW, points: [{ x: 7 * FT, y: 12 * FT }, { x: 7 * FT, y: 8 * FT }], to: { kind: "run_branch", segmentId: `${hw}-s1` } });
    points.push({ mark: `LAV-${floor}-2`, connectionType: "LAV", hostId: `${hw}-2-s1`, port: "start" });
  });

  // Risers first (the floor branches tee into them), so insert them before the branches.
  const risers: Command[] = [
    { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper(2), elevationMm: 0, system: STACK_CW, points: [{ x: 2 * FT, y: 6 * FT }, { x: 2 * FT, y: 6 * FT, elevationMm: FLOORS[2] + 6 * FT }] },
    { type: "route_run", idPrefix: "hw", levelId: "lvl-1", domain: "pipe", size: copper(1), elevationMm: 0, system: STACK_HW, points: [{ x: 3 * FT, y: 8 * FT }, { x: 3 * FT, y: 8 * FT, elevationMm: FLOORS[2] + 6 * FT }] },
    { type: "route_run", idPrefix: "vent", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: FLOORS[2] + 14 * FT, system: STACK_VENT, points: [{ x: -1 * FT, y: 0 }, { x: -1 * FT, y: 0, elevationMm: 0 }] },
  ];
  setup.splice(FLOORS.length + 2, 0, ...risers);
  setup.push({ type: "place_run_accessory", accessoryId: "co-base", segmentId: "bd-s2", atMm: 2 * FT, family: "dwv.cleanout_wye" });
  points.push({ mark: "VTR-1", connectionType: "VTR", hostId: "vent-s1", port: "start" });
  return { setup, points, ids: { stack: stackPiece(0), drain: "bd-s2", cwRiser: "cw-s1", hwRiser: "hw-s1", floorBranches } };
}

/** The one batch that places every load point. */
export function stackLoadPointCommand(points: readonly StackPoint[]): Command {
  return { type: "create_load_point", points: points.map((p) => ({ hostId: p.hostId, port: p.port, connectionType: p.connectionType, mark: p.mark })) };
}
