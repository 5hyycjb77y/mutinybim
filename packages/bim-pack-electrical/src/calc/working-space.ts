import type { ClearanceFace, ClearanceZone } from "@permitzip/bim-kernel";
import { NEC_DEDICATED_SPACE, necCite, type NecEdition, type Citation } from "@permitzip/bim-calc";

/**
 * NEC 110.26(A) working space in front of electrical equipment: depth from
 * Table 110.26(A)(1) by voltage to ground and condition, width and height
 * from (A)(2) and (A)(3). The engineer chooses the condition and any extra
 * depth; this only looks the numbers up and says where they came from. The
 * result becomes a clearance zone on the part (kernel part-model/clearance.ts),
 * measured from the floor, so moving the equipment moves its working space.
 */

export interface WorkingSpaceInput {
  /** Nominal voltage to ground, volts (120/208 V wye: 120; 277/480 V wye: 277). */
  readonly voltageToGround: number;
  /** 110.26(A)(1) condition: 1 nothing grounded opposite, 2 grounded parts opposite, 3 exposed live parts opposite. */
  readonly condition: 1 | 2 | 3;
  /** The equipment's width along the working face, mm. */
  readonly equipmentWidthMm: number;
  /** The equipment's height, mm. */
  readonly equipmentHeightMm: number;
  /** Draw more than the table depth (2 for "double clearance" noted on a drawing). Default 1. */
  readonly depthMultiplier?: number;
}

export interface WorkingSpace {
  readonly depthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly citations: readonly Citation[];
  /** One line: "4'-0" deep (condition 3, 277 V), 30" wide, 6'-6" high, NEC 2023 Table 110.26(A)(1)". */
  readonly summary: string;
}

export type WorkingSpaceResult = { readonly ok: true; readonly space: WorkingSpace } | { readonly ok: false; readonly reason: string };

function feetInches(mm: number): string {
  const totalIn = Math.round((mm / 25.4) * 4) / 4;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round((totalIn - ft * 12) * 4) / 4;
  return ft === 0 ? `${inch}"` : `${ft}'-${inch}"`;
}

export function necWorkingSpace(nec: NecEdition, input: WorkingSpaceInput): WorkingSpaceResult {
  if (!(input.voltageToGround > 0)) return { ok: false, reason: "Voltage to ground must be more than 0 V" };
  const row = nec.tables.WORKING_SPACE_110_26.find((r) => input.voltageToGround <= r.maxVoltsToGround);
  if (!row) return { ok: false, reason: `${input.voltageToGround} V to ground is above the 1000 V the table covers (110.26 Part III applies over 1000 V)` };
  const multiplier = input.depthMultiplier ?? 1;
  if (multiplier < 1 || multiplier > 3) return { ok: false, reason: "Extra depth multiplier must be from 1 to 3" };
  const tableDepth = row.depthMm[input.condition - 1] ?? row.depthMm[0];
  const depthMm = Math.round(tableDepth * multiplier * 10) / 10;
  const widthMm = Math.max(nec.tables.WORKING_SPACE_MIN_WIDTH_MM, input.equipmentWidthMm);
  const heightMm = Math.max(nec.tables.WORKING_SPACE_MIN_HEIGHT_MM, input.equipmentHeightMm);
  const citations = [
    necCite(nec, "working_space_depth", `condition ${input.condition}, ${input.voltageToGround} V to ground`),
    necCite(nec, "working_space_width"),
    necCite(nec, "working_space_height"),
  ];
  const extra = multiplier !== 1 ? ` × ${multiplier} (engineer's extra depth)` : "";
  const summary = `${feetInches(depthMm)} deep (condition ${input.condition}, ${input.voltageToGround} V${extra}), ${feetInches(widthMm)} wide, ${feetInches(heightMm)} high, ${citations[0]?.text ?? ""}`;
  return { ok: true, space: { depthMm, widthMm, heightMm, citations, summary } };
}

export interface WorkingSpaceZoneOptions {
  readonly id?: string;
  readonly name?: string;
  /** The working face; default front (the side the equipment faces). */
  readonly face?: ClearanceFace;
  /** Slide along the face from centred, mm (the space need not be centred on the equipment). */
  readonly offsetMm?: number;
}

/**
 * NEC 110.26(E)(1)(a) dedicated electrical space: the width and depth of the
 * equipment, from its top to 6 ft above it or the structural ceiling if lower,
 * kept free of systems foreign to the electrical installation (ducts, pipes).
 * A suspended ceiling with removable panels may be inside it, and what is above
 * that ceiling is taken as outside it. The zone is the shared clearance model's
 * dedicated variant; this only fills in the code's numbers.
 *
 * The clause is the same in NEC 2020 and 2023, so a project with no edition
 * recorded yet still gets the zone (cited without a year).
 */
export type DedicatedSpaceZone = ClearanceZone & {
  /** Always a number of millimetres (never a parameter or formula), so a placed part's override can carry it. */
  readonly depth: number;
  readonly excludes: "foreign_systems";
  readonly toStructure: true;
  readonly endsAtSuspendedCeiling: true;
  readonly cite: string;
};

export function dedicatedSpaceZone(nec: NecEdition | null, opts: { readonly id?: string; readonly name?: string } = {}): DedicatedSpaceZone {
  return {
    id: opts.id ?? "dedicated_space",
    name: opts.name ?? "Dedicated space above",
    purpose: "dedicated_space",
    face: "top",
    depth: NEC_DEDICATED_SPACE.heightMm,
    excludes: "foreign_systems",
    toStructure: true,
    endsAtSuspendedCeiling: true,
    cite: nec ? `NEC ${nec.edition} ${nec.clauses.dedicated_space}` : NEC_DEDICATED_SPACE.clause,
  };
}

/** A clearance zone for a part definition or a placed part, from a working-space lookup. */
export function workingSpaceZone(nec: NecEdition, input: WorkingSpaceInput, opts: WorkingSpaceZoneOptions = {}): { zone: ClearanceZone; space: WorkingSpace } | { zone: null; reason: string } {
  const r = necWorkingSpace(nec, input);
  if (!r.ok) return { zone: null, reason: r.reason };
  const { space } = r;
  const zone: ClearanceZone = {
    id: opts.id ?? "working_space",
    name: opts.name ?? "Working space",
    purpose: "working_space",
    face: opts.face ?? "front",
    depth: space.depthMm,
    width: space.widthMm,
    height: space.heightMm,
    ...(opts.offsetMm ? { offset: opts.offsetMm } : {}),
    fromFloor: true,
    basis: { code: "nec_110_26", edition: nec.edition, voltageToGround: input.voltageToGround, condition: input.condition, ...(input.depthMultiplier && input.depthMultiplier !== 1 ? { depthMultiplier: input.depthMultiplier } : {}) },
  };
  return { zone, space };
}
