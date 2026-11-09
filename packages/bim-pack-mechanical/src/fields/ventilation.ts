import { to, type Quantity } from "@permitzip/bim-units";
import {
  finite,
  locked,
  registeredVentilationReader,
  textOrNull,
  VENTILATION_NOT_LOADED,
  type BimElement,
  type DependencySignature,
  type FieldProvider,
  type FieldReader,
  type FieldValue,
  type ProviderField,
  type SpaceStandardVentilation,
  type SpaceVentilation,
  type ZoneStandardVentilation,
  type ZoneVentilation,
} from "@permitzip/bim-kernel";

/**
 * Outdoor air and exhaust on spaces and zones (ROADMAP M1; KERNEL-REQUIREMENTS
 * -MODEL §3.2: "the calc packs read the rates, not the kernel").
 *
 * The fields that print the outdoor-air reader's results (the contract is the
 * kernel's `kernel.outdoor_air_reader`). The engine (calc/ventilation)
 * computes IMC 403.3.1.1 and ASHRAE 62.1 side by side from the library rows;
 * a pack in the model's set contributes it. Until one does every field reads
 * empty and `ventilation.basis` says why, so a missing pack shows on paper.
 */

type Elements = Readonly<Record<string, BimElement>>;

const SPACE = ["gen.space"];
const ZONE = ["gen.zone"];
const CALCULATED = "Calculated from the space's use, occupants and area (IMC 403.3.1.1 / ASHRAE 62.1). Change those to change this.";
const ZONE_CALCULATED = "The sum of its spaces' zone outdoor air. Change the spaces to change this.";

function spaceResult(el: BimElement, elements: Elements): SpaceVentilation | null {
  const registered = el.kind === "space" ? registeredVentilationReader() : null;
  if (!registered) return null;
  try {
    return registered.space(elements, el.id);
  } catch (err) {
    console.error("[ventilation] the engine failed on a space; its fields read empty", { spaceId: el.id, reader: registered.id, err });
    return null;
  }
}

function zoneResult(el: BimElement, elements: Elements): ZoneVentilation | null {
  const registered = el.kind === "zone" ? registeredVentilationReader() : null;
  if (!registered) return null;
  try {
    return registered.zone(elements, el.id);
  } catch (err) {
    console.error("[ventilation] the engine failed on a zone; its fields read empty", { zoneId: el.id, reader: registered.id, err });
    return null;
  }
}

const cfm = (v: Quantity<"flow_air"> | null | undefined): number | null => (v === null || v === undefined ? null : finite(to(v, "cfm")));

function spaceNumber(pick: (r: SpaceVentilation) => number | null): FieldReader {
  return (el, ctx): FieldValue => {
    const r = spaceResult(el, ctx.elements);
    return r ? pick(r) : null;
  };
}

function zoneNumber(pick: (r: ZoneVentilation) => number | null): FieldReader {
  return (el, ctx): FieldValue => {
    const r = zoneResult(el, ctx.elements);
    return r ? pick(r) : null;
  };
}

const gov = (r: SpaceVentilation): SpaceStandardVentilation => r.standards[r.governing.standard];
const zgov = (r: ZoneVentilation): ZoneStandardVentilation => r.standards[r.governing.standard];

/** The governing standard's arithmetic, or why it can't be done. */
export function spaceVentilationBasis(r: SpaceVentilation): string {
  const g = gov(r);
  if (g.status === "ok") return `${g.arithmetic ?? ""}${g.ez.value === 1 ? "" : `; Voz = Vbz / ${g.ez.value}`} (${g.label})`.trim();
  return `${g.label}: ${g.reasons.join("; ")}`;
}

export function zoneVentilationBasis(r: ZoneVentilation): string {
  const g = zgov(r);
  if (g.missing.length > 0) return `${g.label}: ${g.missing.length} of ${r.spaceIds.length} spaces can't be calculated (${g.missing.map((m) => `${m.label}: ${m.reason}`).join("; ")})`;
  return `${g.label}: sum of ${r.spaceIds.length} spaces' zone outdoor air. ${r.systemNote}`;
}

const DEPS: DependencySignature = { elementKinds: ["space", "room", "zone"] };
const ZONE_DEPS: DependencySignature = { elementKinds: ["space", "room", "zone", "part", "part_type"] };

const flow = (path: string, label: string, classes: readonly string[], read: FieldReader, reason: string, deps: DependencySignature): ProviderField => ({
  path,
  label,
  classes,
  valueType: "quantity",
  kind: "flow_air",
  unit: "cfm",
  aggregation: "sum",
  writer: locked(reason),
  deps,
  group: "Ventilation",
  read,
});

const spaceFields: ProviderField[] = [
  flow("ventilation.oa_required_cfm", "Outdoor air required (Voz)", SPACE, spaceNumber((r) => cfm(gov(r).voz)), CALCULATED, DEPS),
  flow("ventilation.breathing_zone_cfm", "Breathing-zone outdoor air (Vbz)", SPACE, spaceNumber((r) => cfm(gov(r).vbz)), CALCULATED, DEPS),
  flow("ventilation.imc_oa_cfm", "Outdoor air, IMC (Voz)", SPACE, spaceNumber((r) => cfm(r.standards.imc.voz)), CALCULATED, DEPS),
  flow("ventilation.ashrae_oa_cfm", "Outdoor air, ASHRAE 62.1 (Voz)", SPACE, spaceNumber((r) => cfm(r.standards.ashrae_62_1.voz)), CALCULATED, DEPS),
  flow("ventilation.exhaust_cfm", "Exhaust required", SPACE, spaceNumber((r) => cfm(gov(r).exhaust)), CALCULATED, DEPS),
  {
    path: "ventilation.rp",
    label: "Outdoor air per person (Rp)",
    classes: SPACE,
    valueType: "quantity",
    kind: "airflow_per_person",
    unit: "cfm/occ",
    aggregation: "none",
    writer: locked("From the space use's row in the library. Pick another use to change this."),
    deps: { elementKinds: ["space"] },
    group: "Ventilation",
    read: spaceNumber((r) => { const rp = gov(r).rp; return rp ? finite(to(rp.value, "cfm/occ")) : null; }),
  },
  {
    path: "ventilation.ra",
    label: "Outdoor air per area (Ra)",
    classes: SPACE,
    valueType: "quantity",
    kind: "airflow_per_area",
    unit: "cfm/ft2",
    aggregation: "none",
    writer: locked("From the space use's row in the library. Pick another use to change this."),
    deps: { elementKinds: ["space"] },
    group: "Ventilation",
    read: spaceNumber((r) => { const ra = gov(r).ra; return ra ? finite(to(ra.value, "cfm/ft2")) : null; }),
  },
  {
    path: "ventilation.ez",
    label: "Zone air distribution effectiveness (Ez)",
    classes: SPACE,
    valueType: "quantity",
    kind: "ratio",
    unit: "1",
    aggregation: "none",
    writer: locked("1.0 (ceiling supply of cool air) unless an override with a reason is given."),
    deps: { elementKinds: ["space"] },
    group: "Ventilation",
    read: spaceNumber((r) => finite(to(gov(r).ez.value, "1"))),
  },
  {
    path: "ventilation.governing",
    label: "Governing ventilation code",
    classes: SPACE,
    valueType: "text",
    writer: locked("The project's adopted mechanical code governs; the engineer can switch it for the table."),
    group: "Ventilation",
    read: (el, ctx) => { const r = spaceResult(el, ctx.elements); return r ? textOrNull(gov(r).label) : null; },
  },
  {
    path: "ventilation.basis",
    label: "Outdoor air basis",
    classes: SPACE,
    valueType: "text",
    writer: locked(CALCULATED),
    deps: { elementKinds: ["space", "room"] },
    group: "Ventilation",
    read: (el, ctx) => {
      if (el.kind !== "space") return null;
      if (!registeredVentilationReader()) return VENTILATION_NOT_LOADED;
      const r = spaceResult(el, ctx.elements);
      return r ? textOrNull(spaceVentilationBasis(r)) : null;
    },
  },
];

const zoneFields: ProviderField[] = [
  flow("ventilation.oa_required_cfm", "Outdoor air required (Σ Voz)", ZONE, zoneNumber((r) => cfm(zgov(r).voz)), ZONE_CALCULATED, ZONE_DEPS),
  flow("ventilation.imc_oa_cfm", "Outdoor air, IMC (Σ Voz)", ZONE, zoneNumber((r) => cfm(r.standards.imc.voz)), ZONE_CALCULATED, ZONE_DEPS),
  flow("ventilation.ashrae_oa_cfm", "Outdoor air, ASHRAE 62.1 (Σ Voz)", ZONE, zoneNumber((r) => cfm(r.standards.ashrae_62_1.voz)), ZONE_CALCULATED, ZONE_DEPS),
  flow("ventilation.exhaust_cfm", "Exhaust required", ZONE, zoneNumber((r) => cfm(zgov(r).exhaust)), ZONE_CALCULATED, ZONE_DEPS),
  flow("ventilation.unit_oa_cfm", "Serving unit's outdoor air", ZONE, zoneNumber((r) => cfm(r.servedBy?.outdoorAir)), "The serving unit's outdoor air (its outdoor_cfm). Type it on the unit.", ZONE_DEPS),
  {
    path: "ventilation.governing",
    label: "Governing ventilation code",
    classes: ZONE,
    valueType: "text",
    writer: locked("The project's adopted mechanical code governs; the engineer can switch it for the table."),
    group: "Ventilation",
    read: (el, ctx) => { const r = zoneResult(el, ctx.elements); return r ? textOrNull(zgov(r).label) : null; },
  },
  {
    path: "ventilation.basis",
    label: "Outdoor air basis",
    classes: ZONE,
    valueType: "text",
    writer: locked(ZONE_CALCULATED),
    deps: { elementKinds: ["space", "room", "zone", "part"] },
    group: "Ventilation",
    read: (el, ctx) => {
      if (el.kind !== "zone") return null;
      if (!registeredVentilationReader()) return VENTILATION_NOT_LOADED;
      const r = zoneResult(el, ctx.elements);
      return r ? textOrNull(zoneVentilationBasis(r)) : null;
    },
  },
];

export const VENTILATION_FIELD_PROVIDER: FieldProvider = { id: "mep.ventilation", fields: [...spaceFields, ...zoneFields] };
