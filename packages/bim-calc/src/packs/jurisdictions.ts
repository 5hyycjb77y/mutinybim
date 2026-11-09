import { parseJurisdiction, usStateOf, type JurisdictionId } from "@permitzip/bim-kernel";
import { NEC_EDITIONS, type NecEditionYear } from "./nec/pack";

/**
 * Which NEC edition a jurisdiction has adopted, copied from the Code Map
 * skill's adoption reference (dotclaude plugins/permitzip-core/skills/codemap/
 * data/jurisdiction-codes.json, _last_updated 2026-02-18). The electrical
 * rows feed the NEC pack; `CODE_ADOPTIONS` below carries every code book
 * (plumbing and fuel gas feed the IPC / IFGC packs). A state not listed
 * returns null: the caller must say which edition applies rather than get a
 * guessed default.
 */
export interface ElectricalAdoption {
  readonly state: string;
  readonly stateName: string;
  readonly codeName: string;
  readonly nec: NecEditionYear;
  readonly effectiveDate: string;
  readonly localAmendments: boolean;
  readonly note: string | null;
}

export const ELECTRICAL_ADOPTIONS_SOURCE = "PermitZIP Code Map jurisdiction-codes.json (last updated 2026-02-18)";

export const ELECTRICAL_ADOPTIONS: Readonly<Record<string, ElectricalAdoption>> = {
  VA: { state: "VA", stateName: "Virginia", codeName: "Virginia Electrical Code", nec: "2020", effectiveDate: "2024-01-18", localAmendments: false, note: "NEC as amended by Virginia" },
  MD: { state: "MD", stateName: "Maryland", codeName: "Maryland Electrical Code", nec: "2020", effectiveDate: "2024-03-21", localAmendments: true, note: "Maryland permits county-level amendments; check the local code" },
  DC: { state: "DC", stateName: "District of Columbia", codeName: "DC Electrical Code", nec: "2020", effectiveDate: "2024-05-01", localAmendments: true, note: "DC adopts with DC-specific amendments (DCMR Title 12)" },
};

/** A discipline's code book as the Code Map lists it. */
export const KNOWN_CODE_DISCIPLINES = ["building", "mechanical", "plumbing", "electrical", "energy", "fuel_gas"] as const;
/** The Code Map's disciplines, then any a pack's code family adds (`structural`): an open string. */
export type CodeDiscipline = (typeof KNOWN_CODE_DISCIPLINES)[number] | (string & {});

export interface CodeBookAdoption {
  readonly state: string;
  readonly stateName: string;
  readonly discipline: CodeDiscipline;
  /** "Virginia Plumbing Code" */
  readonly codeName: string;
  /** "VPC": the name deliverables use. */
  readonly shortName: string;
  /** "2021 IPC" */
  readonly baseModelCode: string;
  readonly editionYear: string;
  readonly effectiveDate: string;
  readonly localAmendments: boolean;
  readonly note: string | null;
}

/**
 * Every code book the Code Map file lists, per state (same source and date as
 * the electrical rows above). Maryland and DC list no fuel gas code: a fuel
 * gas calc there must be told the edition.
 */
export const CODE_ADOPTIONS: Readonly<Record<string, readonly CodeBookAdoption[]>> = {
  VA: [
    { state: "VA", stateName: "Virginia", discipline: "building", codeName: "Virginia Uniform Statewide Building Code", shortName: "USBC", baseModelCode: "2021 IBC", editionYear: "2021", effectiveDate: "2024-01-18", localAmendments: false, note: "Virginia prohibits local amendments to the USBC (101.3)" },
    { state: "VA", stateName: "Virginia", discipline: "mechanical", codeName: "Virginia Mechanical Code", shortName: "VMC", baseModelCode: "2021 IMC", editionYear: "2021", effectiveDate: "2024-01-18", localAmendments: false, note: null },
    { state: "VA", stateName: "Virginia", discipline: "plumbing", codeName: "Virginia Plumbing Code", shortName: "VPC", baseModelCode: "2021 IPC", editionYear: "2021", effectiveDate: "2024-01-18", localAmendments: false, note: "2021 IPC as amended by Virginia" },
    { state: "VA", stateName: "Virginia", discipline: "electrical", codeName: "Virginia Electrical Code", shortName: "VEC", baseModelCode: "2020 NEC", editionYear: "2020", effectiveDate: "2024-01-18", localAmendments: false, note: "NEC as amended by Virginia" },
    { state: "VA", stateName: "Virginia", discipline: "energy", codeName: "Virginia Energy Conservation Code", shortName: "VECC", baseModelCode: "2021 IECC", editionYear: "2021", effectiveDate: "2024-01-18", localAmendments: false, note: null },
    { state: "VA", stateName: "Virginia", discipline: "fuel_gas", codeName: "Virginia Fuel Gas Code", shortName: "VFGC", baseModelCode: "2021 IFGC", editionYear: "2021", effectiveDate: "2024-01-18", localAmendments: false, note: "Statewide only; use \"VFGC\" in deliverables, never \"IFGC\"" },
  ],
  MD: [
    { state: "MD", stateName: "Maryland", discipline: "building", codeName: "Maryland Building Performance Standards", shortName: "MBPS", baseModelCode: "2021 IBC", editionYear: "2021", effectiveDate: "2024-03-21", localAmendments: true, note: "Maryland permits county-level amendments; check the local code" },
    { state: "MD", stateName: "Maryland", discipline: "mechanical", codeName: "Maryland Mechanical Code", shortName: "MMC", baseModelCode: "2021 IMC", editionYear: "2021", effectiveDate: "2024-03-21", localAmendments: true, note: null },
    { state: "MD", stateName: "Maryland", discipline: "plumbing", codeName: "Maryland Plumbing Code", shortName: "MPC", baseModelCode: "2021 IPC", editionYear: "2021", effectiveDate: "2024-03-21", localAmendments: true, note: "Maryland permits county-level amendments; check the local code" },
    { state: "MD", stateName: "Maryland", discipline: "electrical", codeName: "Maryland Electrical Code", shortName: "MEC", baseModelCode: "2020 NEC", editionYear: "2020", effectiveDate: "2024-03-21", localAmendments: true, note: null },
    { state: "MD", stateName: "Maryland", discipline: "energy", codeName: "Maryland Energy Conservation Code", shortName: "MECC", baseModelCode: "2021 IECC", editionYear: "2021", effectiveDate: "2024-03-21", localAmendments: true, note: null },
  ],
  DC: [
    { state: "DC", stateName: "District of Columbia", discipline: "building", codeName: "DC Construction Code", shortName: "DCCC", baseModelCode: "2021 IBC", editionYear: "2021", effectiveDate: "2024-05-01", localAmendments: true, note: "DC-specific amendments (DCMR Title 12)" },
    { state: "DC", stateName: "District of Columbia", discipline: "mechanical", codeName: "DC Mechanical Code", shortName: "DCMC", baseModelCode: "2021 IMC", editionYear: "2021", effectiveDate: "2024-05-01", localAmendments: true, note: null },
    { state: "DC", stateName: "District of Columbia", discipline: "plumbing", codeName: "DC Plumbing Code", shortName: "DCPC", baseModelCode: "2021 IPC", editionYear: "2021", effectiveDate: "2024-05-01", localAmendments: true, note: "DC-specific amendments (DCMR Title 12)" },
    { state: "DC", stateName: "District of Columbia", discipline: "electrical", codeName: "DC Electrical Code", shortName: "DCEC", baseModelCode: "2020 NEC", editionYear: "2020", effectiveDate: "2024-05-01", localAmendments: true, note: null },
    { state: "DC", stateName: "District of Columbia", discipline: "energy", codeName: "DC Energy Conservation Code", shortName: "DCECC", baseModelCode: "2021 IECC", editionYear: "2021", effectiveDate: "2024-05-01", localAmendments: true, note: "With DC Appendix; stricter than base IECC" },
  ],
};

/**
 * The adoption tables' key for a place (round 10, C10): any jurisdiction id,
 * its key, or a stored two-letter state, read tolerantly. The tables list US
 * states today, so a place outside the US (or a US place with no state)
 * finds no row and the caller says which edition applies.
 */
export function adoptionTableKey(place: string | JurisdictionId): string | null {
  return usStateOf(parseJurisdiction(place));
}

/** The jurisdiction an adoption row speaks for. */
export function adoptionJurisdiction(row: { readonly state: string }): JurisdictionId {
  return { country: "US", subdivision: `US-${row.state}` };
}

/** The code book a place adopted for a discipline, or null when the Code Map lists none. */
export function codeBookFor(place: string | JurisdictionId, discipline: CodeDiscipline): CodeBookAdoption | null {
  const key = adoptionTableKey(place);
  return key ? (CODE_ADOPTIONS[key]?.find((c) => c.discipline === discipline) ?? null) : null;
}

/** A project's adopted code for any discipline, as Code Study records it (content.project_adopted_codes). */
export interface ProjectCodeAdoption {
  readonly codeName: string;
  readonly edition: string;
  readonly status: "confirmed" | "unconfirmed";
}

/** The model-code year an adopted code names ("2021 IPC", "Virginia Plumbing Code 2021"), or null. */
export function modelYearFromAdoption(adoption: ProjectCodeAdoption): string | null {
  return `${adoption.edition} ${adoption.codeName}`.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null;
}

export function adoptionFor(place: string | JurisdictionId): ElectricalAdoption | null {
  const key = adoptionTableKey(place);
  return key ? (ELECTRICAL_ADOPTIONS[key] ?? null) : null;
}

export function isNecYear(value: string): value is NecEditionYear {
  return (NEC_EDITIONS as readonly string[]).includes(value);
}

/** A project's adopted electrical code as Code Study records it (content.project_adopted_codes, discipline electrical). */
export interface ProjectElectricalAdoption {
  readonly codeName: string;
  readonly edition: string;
  readonly status: "confirmed" | "unconfirmed";
}

/**
 * The NEC year a project's adopted electrical code names: "2020", "2020 NEC",
 * or a state code whose name or edition carries the year. A year this pack
 * doesn't cover comes back as `unsupported` so the caller can say so.
 */
export function necYearFromAdoption(adoption: ProjectElectricalAdoption): { readonly year: NecEditionYear } | { readonly unsupported: string } | null {
  const years = `${adoption.edition} ${adoption.codeName}`.match(/\b(19|20)\d{2}\b/g) ?? [];
  const year = years[0];
  if (!year) return null;
  return isNecYear(year) ? { year } : { unsupported: year };
}
