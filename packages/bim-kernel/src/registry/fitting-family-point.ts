import type { SystemKind } from "../parts";
import { defineExtensionPoint } from "../packs/contract";
import { firstPartyStoredOwner } from "../packs/first-party/manifests";
import { activePackSet } from "../packs/scope";
import { firstPartyBaseRevision, packNotLoadedMessage, packSetReadsRecorded, type PackSet } from "../packs/set";
import type { FittingFamily } from "../routing/fittings/library";
import type { FittingChoice, FittingSlot, FittingType, RunDomain, RunSize } from "../routing/types";

/**
 * Fitting families (contract 1.10.0, `kernel.fitting_family` v1; round 11's
 * P11 shape, built in round 12).
 *
 * A fitting family is how a run's elbows, tees, transitions and caps are
 * made (a radius elbow, a long-sweep bend, a threaded tee). The kernel
 * routes, picks a slot and asks for the family; which families exist, what
 * they're made of and which one fills each slot by default is the add-on's.
 * Family ids are stored on fittings, so they are frozen byte for byte and
 * kept bare for first-party rows.
 */

/** A default for one slot under one scope (a run domain, a system kind, a material): what a new fitting there is made as. */
export interface FittingSlotDefault {
  /** What it applies to, in the add-on's own words (a run domain, a system kind id). */
  readonly scope: string;
  readonly slot: FittingSlot;
  readonly choice: FittingChoice;
}

/** The fitting a family is checked against: what it is, where, in which sizes. */
export interface FittingFitContext {
  readonly fittingType: FittingType;
  readonly domain: RunDomain;
  readonly sizes: readonly RunSize[];
  readonly angleDeg?: number;
  /** Branch takeoffs: the run it is cut into. */
  readonly main?: RunSize;
  readonly systemKind?: SystemKind;
}

export interface FittingFamilyRow {
  readonly family: FittingFamily;
  /** Slots this family fills by default. */
  readonly defaults?: readonly FittingSlotDefault[];
  /**
   * The add-on's own fit rules (material, size range, what it carries, branch
   * angle), after the kernel's type and domain checks: why this family can't
   * be this fitting, in words, or null. Absent: the kernel's checks only.
   */
  readonly mismatch?: (family: FittingFamily, fitting: FittingFitContext) => string | null;
  /** What a placed fitting of this family is called, given its sizes (a reducing tee). Absent: the family's name. */
  readonly label?: (family: FittingFamily, sizes: readonly RunSize[], main: RunSize | undefined) => string;
  /** Contract 1.12.0 (additive): words printed after a hosted branch's name when it leaves its run through `face` ("rise from the top"); null for none. Absent: the name alone. */
  readonly faceWords?: (face: string) => string | null;
}

export const FITTING_FAMILY_POINT = defineExtensionPoint<FittingFamilyRow>({
  id: "kernel.fitting_family",
  version: 1,
  label: "Fitting families",
  idOf: (row) => row.family.id,
  // Stored family ids are dotted words (`<domain>.<form>.<variant>`); uniqueness is the check.
  namespaced: false,
});

/** Problems with fitting family rows (pack conformance), in words. */
export function fittingFamilyRowProblems(rows: readonly FittingFamilyRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const slots = new Set<string>();
  for (const { family, defaults } of rows) {
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(family.id)) out.push(`fitting family "${family.id}" must be dotted lower case words`);
    if (seen.has(family.id)) out.push(`fitting family ${family.id} is registered twice`);
    seen.add(family.id);
    if (family.name.trim().length === 0) out.push(`fitting family ${family.id} has no name`);
    if (family.fittingTypes.length === 0) out.push(`fitting family ${family.id} makes no fitting type`);
    for (const d of defaults ?? []) {
      const key = `${d.scope}\u0000${d.slot}`;
      if (slots.has(key)) out.push(`fitting family ${family.id}: slot ${d.slot} under ${d.scope} already has a default`);
      slots.add(key);
      if (d.choice.family !== family.id) out.push(`fitting family ${family.id}: its default for ${d.slot} names another family (${d.choice.family})`);
    }
  }
  return out;
}

interface FamilyTable {
  readonly byId: ReadonlyMap<string, FittingFamily>;
  readonly rows: ReadonlyMap<string, FittingFamilyRow>;
  readonly defaults: ReadonlyMap<string, FittingChoice>;
}

const tableOf = (set: PackSet): FamilyTable => {
  const byId = new Map<string, FittingFamily>();
  const rows = new Map<string, FittingFamilyRow>();
  const defaults = new Map<string, FittingChoice>();
  for (const row of set.items(FITTING_FAMILY_POINT)) {
    byId.set(row.family.id, row.family);
    rows.set(row.family.id, row);
    for (const d of row.defaults ?? []) defaults.set(`${d.scope}\u0000${d.slot}`, d.choice);
  }
  return { byId, rows, defaults };
};

const TABLE_KEY = "kernel.fitting_family#table";

/** The last set's table (a family is resolved per fitting on hot paths); a recorded pass goes through `memo` so its reads are noted. */
let last: { readonly set: PackSet; readonly revision: number; readonly table: FamilyTable } | null = null;

function familyTable(): FamilyTable {
  const set = activePackSet();
  const revision = firstPartyBaseRevision();
  if (last !== null && last.set === set && last.revision === revision && !packSetReadsRecorded()) return last.table;
  const table = set.memo(TABLE_KEY, tableOf);
  last = { set, revision, table };
  return table;
}

/** A family the set in force registers, or null. */
export function packFittingFamily(id: string): FittingFamily | null {
  return familyTable().byId.get(id) ?? null;
}

/** A hosted branch's name with its family row's words for the face it leaves through ("Conical tap, rise from the top"); the name alone on a side or for a row with none. */
export function branchLabelOnFace(familyId: string | undefined, label: string, face: string | undefined): string {
  if (face === undefined || familyId === undefined) return label;
  const words = packFittingFamilyRow(familyId)?.faceWords?.(face) ?? null;
  return words ? `${label}, ${words}` : label;
}

/** The row a family came in on (its fit rules and label), or null. */
export function packFittingFamilyRow(id: string): FittingFamilyRow | null {
  return familyTable().rows.get(id) ?? null;
}

/**
 * Words for a stored fitting family no add-on here registers: the first-party
 * add-on that makes the fitting's material when it is known (a bare kernel
 * names it with `packNotLoadedMessage`), else no add-on by name. The fitting
 * is kept as stored either way.
 */
export function missingFittingFamilyMessage(id: string, size?: RunSize): string {
  const owner = size?.shape === "pipe" ? firstPartyStoredOwner("pipe_material", size.material) : null;
  if (owner) return `${packNotLoadedMessage(owner)}, so its ${id} fitting isn't checked. It is kept as stored`;
  return `No add-on here makes the ${id} fitting, so it isn't checked. It is kept as stored`;
}

/** Every family the set in force registers, in row order. */
export function packFittingFamilies(): readonly FittingFamily[] {
  return activePackSet().items(FITTING_FAMILY_POINT).map((r) => r.family);
}

/** The default choice for a slot under a scope in the set in force, or null. */
export function packFittingDefault(scope: string, slot: FittingSlot): FittingChoice | null {
  return familyTable().defaults.get(`${scope}\u0000${slot}`) ?? null;
}
