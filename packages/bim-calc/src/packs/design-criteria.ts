import type { Citation, DesignCriteria } from "../types";

/**
 * PermitZIP's default design criteria: targets the firm designs to that the
 * code does not require. The 3% branch / 3% feeder / 5% combined voltage-drop
 * targets follow the NEC's informational notes, which are recommendations and
 * not enforceable. A project can pass its own criteria.
 */
export const PERMITZIP_DESIGN_CRITERIA: DesignCriteria = {
  id: "permitzip.default",
  version: "2026.10.21",
  title: "PermitZIP default design criteria",
  electrical: {
    branchVoltageDropPct: 3,
    feederVoltageDropPct: 3,
    combinedVoltageDropPct: 5,
    powerFactor: 0.9,
    ambientC: 30,
  },
};

export function criteriaCite(criteria: DesignCriteria, detail: string): Citation {
  return { source: "design_criteria", code: criteria.title, edition: criteria.version, clause: "design criteria", detail, text: `${criteria.title} (${criteria.version}): ${detail} (a design target, not a code requirement)` };
}

export function methodCite(code: string, clause: string, detail?: string): Citation {
  return { source: "method", code, edition: null, clause, ...(detail ? { detail } : {}), text: `${code}: ${clause}${detail ? `, ${detail}` : ""}` };
}
