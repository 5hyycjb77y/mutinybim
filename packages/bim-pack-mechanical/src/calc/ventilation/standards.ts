import { codeBookFor, modelYearFromAdoption, type ProjectCodeAdoption } from "@permitzip/bim-calc";
import type { GoverningStandard, VentilationCite, VentilationStandardId } from "./kernel-seam";

/**
 * The two ventilation standards run side by side (STATUS decision 13): IMC
 * 403.3.1.1 and ASHRAE 62.1 §6.2 (the Ventilation Rate Procedure). The IMC
 * method is 62.1's, so the equations match; the rates come from the
 * space-use library row, which cites each code it prints. Clause numbers are
 * as commonly published and are not yet checked against a code library
 * record, so every citation says "not verified".
 */

export const VENTILATION_PACK_VERSION = "1.0.0";

export interface VentilationStandard {
  readonly id: VentilationStandardId;
  /** As a library row's citation names it. */
  readonly code: string;
  readonly edition: string;
  readonly label: string;
  readonly clauses: {
    readonly vbz: string;
    readonly ez: string;
    readonly voz: string;
    readonly exhaust: string;
    readonly singleZone: string;
    readonly multiZone: string;
  };
}

export const VENTILATION_STANDARDS: Readonly<Record<VentilationStandardId, VentilationStandard>> = {
  imc: {
    id: "imc",
    code: "IMC",
    edition: "2021",
    label: "IMC 2021",
    clauses: {
      vbz: "403.3.1.1.1, Equation 4-1",
      ez: "Table 403.3.1.1.2",
      voz: "403.3.1.1.2.2, Equation 4-2",
      exhaust: "Table 403.3.1.1, exhaust column",
      singleZone: "403.3.1.1.2.3.1",
      multiZone: "403.3.1.1.2.3.3",
    },
  },
  ashrae_62_1: {
    id: "ashrae_62_1",
    code: "ASHRAE 62.1",
    edition: "2019",
    label: "ASHRAE 62.1-2019",
    clauses: {
      vbz: "6.2.1.1, Equation 6-1",
      ez: "Table 6-4",
      voz: "6.2.1.3, Equation 6-2",
      exhaust: "Table 6-5",
      singleZone: "6.2.3",
      multiZone: "6.2.5",
    },
  },
};

export function ventilationCite(code: string, edition: string | null, clause: string, verified = false, detail?: string): VentilationCite {
  return { code, edition, clause, verified, text: `${code}${edition ? ` ${edition}` : ""} ${clause}${detail ? `, ${detail}` : ""}${verified ? "" : " (not verified)"}` };
}

export const standardCite = (s: VentilationStandard, clause: keyof VentilationStandard["clauses"], detail?: string): VentilationCite => ventilationCite(s.code, s.edition, s.clauses[clause], false, detail);

/** Ez with no override: ceiling supply of cool air, 1.0 (the first row of both tables). */
export const DEFAULT_EZ = 1;
export const EZ_RANGE = { min: 0.5, max: 1.2 } as const;

export interface GoverningRequest {
  /** The engineer's switch. Wins over everything. */
  readonly asked?: VentilationStandardId;
  /** The project's adopted mechanical code from its Code Study. */
  readonly projectAdoption?: ProjectCodeAdoption | null;
  /** Two-letter state; its adopted mechanical code is used when the project has none. */
  readonly state?: string;
}

const MODEL_SIDE_NOTE = "Record the mechanical code in the project's Code Study, or switch it for this table.";

/**
 * Which standard is marked governing: the engineer's choice, else the
 * project's adopted mechanical code, else the state's, else IMC by default
 * (said so in the text). The model has no code setting of its own yet.
 */
export function resolveGoverningStandard(req: GoverningRequest = {}): GoverningStandard {
  if (req.asked) return { standard: req.asked, from: "asked", text: `${VENTILATION_STANDARDS[req.asked].label} governs (chosen by the engineer)` };
  const project = req.projectAdoption;
  if (project) {
    const names = `${project.codeName} ${project.edition}`;
    const standard: VentilationStandardId = /62\.1|ashrae/i.test(names) ? "ashrae_62_1" : "imc";
    const s = VENTILATION_STANDARDS[standard];
    const year = modelYearFromAdoption(project);
    const other = standard === "imc" && year && year !== s.edition ? `; the rates are the ${s.edition} table's, not checked against ${year}` : "";
    return { standard, from: "project", text: `${s.label} governs (${project.codeName} ${project.edition}, the project's Code Study${project.status === "unconfirmed" ? ", not yet confirmed" : ""}${other})` };
  }
  if (req.state) {
    const adopted = codeBookFor(req.state, "mechanical");
    if (adopted) {
      const other = adopted.editionYear !== VENTILATION_STANDARDS.imc.edition ? `; the rates are the ${VENTILATION_STANDARDS.imc.edition} table's, not checked against ${adopted.editionYear}` : "";
      return { standard: "imc", from: "state", text: `${VENTILATION_STANDARDS.imc.label} governs (${adopted.stateName} adopted the ${adopted.baseModelCode} as the ${adopted.codeName}${other})` };
    }
    return { standard: "imc", from: "default", text: `${VENTILATION_STANDARDS.imc.label} governs by default: no mechanical code adoption is on file for ${req.state.trim().toUpperCase()}. ${MODEL_SIDE_NOTE}` };
  }
  return { standard: "imc", from: "default", text: `${VENTILATION_STANDARDS.imc.label} governs by default: no adopted mechanical code was given. ${MODEL_SIDE_NOTE}` };
}
