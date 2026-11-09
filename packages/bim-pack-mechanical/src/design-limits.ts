import type { DesignLimit } from "@permitzip/bim-kernel/policy";

/**
 * Mechanical's design-limit defaults (`kernel.design_limit_default`). A firm's
 * library or a project replaces one by id, or adds a per-system variant
 * (`mechanical.duct_ceiling_clearance.exhaust_air` with `systems`), which binds
 * first because it is more specific.
 */
export const DUCT_CEILING_CLEARANCE_LIMIT_ID = "mechanical.duct_ceiling_clearance";

export const MECHANICAL_DESIGN_LIMIT_DEFAULTS: readonly DesignLimit[] = [
  {
    id: DUCT_CEILING_CLEARANCE_LIMIT_ID,
    label: "Duct clearance under ceilings",
    quantity: "length",
    unit: "in",
    appliesTo: { discipline: "mechanical" },
    band: { min: 2 },
    severity: "warning",
    citation: { source: "PermitZIP practice (product decision, Nov 4 2026)", note: "Keep a duct's top 2 in below any ceiling, soffit or step ceiling that reaches above its bottom, for hangers, insulation and coordination tolerance." },
  },
];
