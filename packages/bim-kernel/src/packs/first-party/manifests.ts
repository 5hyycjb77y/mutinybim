/**
 * The first-party packs' manifests: the trades PermitZIP ships. Data
 * only, so the contract can read their reserved ids. The packs themselves
 * (manifest plus contributions) are built in `./electrical.ts`,
 * `./plumbing.ts` and `./mechanical.ts` and installed into every set's base
 * (`installFirstPartyPacks`); their ids stay bare because models have stored
 * them since round 1.
 */
import type { PackManifest } from "../contract";
import { PACK_CONTRACT_VERSION } from "../version";

export type FirstPartyPackId = "electrical" | "plumbing_gas" | "mechanical" | "fire_protection" | "architecture" | "struct";

const KERNEL_RANGE = `^${PACK_CONTRACT_VERSION}`;

export const ELECTRICAL_MANIFEST: PackManifest = { id: "electrical", name: "Electrical", version: "1.0.0", kernel: KERNEL_RANGE, firstParty: true, description: "Panels, circuits, feeders and their loads; dedicated equipment space; electrical calcs and checks." };

export const PLUMBING_GAS_MANIFEST: PackManifest = { id: "plumbing_gas", name: "Plumbing and gas", version: "1.0.0", kernel: KERNEL_RANGE, firstParty: true, description: "Water, drainage, vent and fuel gas networks; fixture units; plumbing and gas sizing." };

export const MECHANICAL_MANIFEST: PackManifest = { id: "mechanical", name: "Mechanical", version: "1.0.0", kernel: KERNEL_RANGE, firstParty: true, description: "Air and hydronic networks served by equipment; ventilation and pressurization." };

/** Round 8: the fire protection disciplines (fire alarm and fire suppression as children of fire protection); its design rows join in later rounds. */
export const FIRE_PROTECTION_MANIFEST: PackManifest = { id: "fire_protection", name: "Fire protection", version: "1.0.0", kernel: KERNEL_RANGE, firstParty: true, description: "Fire protection and its two disciplines, fire alarm and fire suppression, each with its own engineer of record." };

/** Round 13: the building itself (walls, openings, roofs, floors, ceilings, columns, stairs) with its types, joins, voids and IFC mapping. */
export const ARCHITECTURE_MANIFEST: PackManifest = { id: "architecture", name: "Architecture", version: "1.0.0", kernel: KERNEL_RANGE, firstParty: true, description: "Grids, walls, doors, windows, openings, floors, ceilings, roofs, columns and stairs with their types; clean corners, openings cut in their hosts, rooms bounded by walls, and the building in IFC." };

/** Round 14: Structural, always installed (it was a Preview add-on a model switched on). Id and version unchanged, so its classes, rows and stored switches keep theirs. */
export const STRUCTURAL_MANIFEST: PackManifest = { id: "struct", name: "Structural", version: "0.1.0", kernel: KERNEL_RANGE, firstParty: true, description: "Steel beams, columns and pad footings, a wide-flange catalogue, live load by use, tributary areas and the gravity load path to the footings. One service-level load case." };

/** In the order Settings lists them, which is also the order their rows join every point. */
export const FIRST_PARTY_MANIFESTS: readonly PackManifest[] = [ELECTRICAL_MANIFEST, PLUMBING_GAS_MANIFEST, MECHANICAL_MANIFEST, FIRE_PROTECTION_MANIFEST, ARCHITECTURE_MANIFEST, STRUCTURAL_MANIFEST];

/** The reserved first-party ids: only a `firstParty` pack with one of these may contribute bare ids. */
export const FIRST_PARTY_PACK_IDS: readonly string[] = FIRST_PARTY_MANIFESTS.map((m) => m.id);

const BY_DISCIPLINE: Readonly<Record<string, FirstPartyPackId>> = { electrical: "electrical", plumbing: "plumbing_gas", mechanical: "mechanical" };

/** The first-party pack a built-in row of this discipline belongs to; null for shared rows (architecture, general). */
export function firstPartyPackOfDiscipline(discipline: string): FirstPartyPackId | null {
  return BY_DISCIPLINE[discipline] ?? null;
}

/** Whether `id` is a first-party pack's namespace (a third-party pack may not take it). */
export function isFirstPartyPackId(id: string): id is FirstPartyPackId {
  return FIRST_PARTY_PACK_IDS.includes(id);
}

/**
 * Stored command types a first-party pack owns, so a model whose pack isn't
 * loaded is refused by name instead of with "unknown command". Data only.
 */
type StoredNameKind = "command" | "claim" | "diagram" | "form" | "table" | "pipe_material" | "catalog" | "fitting_family";

const E: FirstPartyPackId = "electrical";
const P: FirstPartyPackId = "plumbing_gas";
const M: FirstPartyPackId = "mechanical";

const STORED_OWNERS: Readonly<Record<StoredNameKind, ReadonlyMap<string, FirstPartyPackId>>> = {
  command: new Map([["place_service_layout", E], ["name_stacks", P], ["edit_stack", P], ["delete_stacks", P], ["set_stack_checks", P], ["set_run_insulation", M], ["set_pipe_insulation", M], ["set_terminal_cfm", M]]),
  /** Kernel commands whose case for a kind a first-party add-on owns (`PackCommandDef.claims`): refused naming it when it isn't loaded. */
  claim: new Map([["slide_branch", M], ["resize_run", M], ["move_equipment", M]]),
  diagram: new Map([["one_line", E], ["electrical_riser", E], ["plumbing_riser", P], ["plumbing_isometric", P], ["air_schematic", M]]),
  form: new Map([["panel", E], ["switchboard", E], ["feeder", E], ["connection_types", E], ["equipment_connections", E], ["gas_equipment", P], ["gas_connections", P]]),
  table: new Map([["ventilation", M], ["pressurization", M], ["gas", P]]),
  /** Built-in pipe materials whose products (sizes, joints) a first-party add-on supplies. */
  pipe_material: new Map(["copper", "pex", "cpvc", "cast_iron", "pvc", "abs", "steel", "black_steel", "galvanized", "pp_r", "csst", "pe"].map((m) => [m, P])),
  /** Stored catalog record types (`CATALOG_ENTRY_POINT`) a first-party add-on registers (round 12, E12). */
  catalog: new Map([["feeder_type", E], ["circuit_template", E], ["pipe_type", P], ["plumbing_settings", P]]),
  /** Stored fitting family ids by their first word (`pipe.…`): the kernel draws no pipe family of its own (round 12). */
  fitting_family: new Map([["pipe", P]]),
};

/** The first-party pack that owns a stored name (a command type, a diagram kind, a form kind, a block table kind), or null. */
export function firstPartyStoredOwner(kind: StoredNameKind, name: string): FirstPartyPackId | null {
  return STORED_OWNERS[kind].get(name) ?? null;
}

/** The first-party pack whose fitting families a stored family id comes from (by the id's first word), or null. */
export function firstPartyFittingFamilyOwner(familyId: string): FirstPartyPackId | null {
  return firstPartyStoredOwner("fitting_family", familyId.split(".")[0] ?? "");
}

/** The first-party pack that owns a stored command type, or null. */
export function firstPartyCommandOwner(type: string): FirstPartyPackId | null {
  return firstPartyStoredOwner("command", type);
}

/** A pack's display name when only its id is known (a refusal for a pack that isn't loaded). */
export function firstPartyPackName(id: string): string | null {
  return FIRST_PARTY_MANIFESTS.find((m) => m.id === id)?.name ?? null;
}
