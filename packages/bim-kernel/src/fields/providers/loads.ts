import { QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { QUANTITIES, QUANTITY_KEYS, formatQuantity, type QuantityKey } from "../../quantities";
import type { ClassId, FieldProvider } from "../../registry/types";
import { allocatedActualLine } from "../../requirements/allocation";
import { loadSectionRows, sectionOfQuantity } from "../../requirements/facets";
import { requirementsEngineOf, sourceFiguresOf } from "../../requirements/model-engine";
import type { AllocatedActual, LoadStage, LoadStatus } from "../../requirements/types";
import { PIPE_DESIGN_DEFAULTS, gasProperties, mergePipeDesign } from "../../routing/pipe/design";
import { elementsOfKind } from "../../store";
import type { BimElement } from "../../types";
import { locked, textOrNull, type ProviderField } from "./support";

/**
 * Allocated vs actual as schedule columns (Product decision, Oct 27, decision 4: "shown
 * everywhere a total is shown"), for every quantity in the shared bag, in
 * per-trade groups (Loads · Electrical, Gas, Water, Drainage, Air):
 *
 * - a space or zone: the estimates spread over it, the real loads standing in
 *   it, and what it counts (requirements engine, carried from edit to edit);
 * - a panel, heater, meter or interceptor: the loads that name it as their
 *   source (`servedBy`, indexed), estimates and the devices inside them once;
 * - a load point: its stage, its status, and one line for the estimate group
 *   it is part of.
 *
 * An empty cell means there is nothing on that side (no estimate typed, no
 * device placed), never zero standing in for "unknown".
 */

type Elements = Readonly<Record<string, BimElement>>;

const SCOPES: readonly ClassId[] = ["gen.space", "gen.zone"];
/** What can be a source loads name: panels, heaters and other equipment, a grease interceptor, a meter or regulator. */
const SOURCES: readonly ClassId[] = ["mep.equipment", "mep.plumbing_fixture", "mep.pipe_accessory"];
const LOAD: readonly ClassId[] = ["mep.load_point"];

/** The quantities that add (pressure is a requirement, not a load to total). */
const SUMMED: readonly QuantityKey[] = QUANTITY_KEYS.filter((q) => QUANTITIES[q].add === "sum");

const FROM_LOADS = "Added up from the loads: type an estimate on the space, or place and connect the devices.";
/** `organization`: a typical's copies change how many times its loads count (F6). */
const DEPS = { elementKinds: ["load_point", "space", "zone", "room", "part", "service_catalog", "organization"] as const };

interface Figures {
  readonly figures: AllocatedActual;
  readonly hasEstimates: boolean;
}

/** The figures a space, zone or source row reads; null for anything else. */
function figuresOf(el: BimElement, elements: Elements): Figures | null {
  if (el.kind === "space" || el.kind === "zone") {
    const f = requirementsEngineOf(elements).scopeFigures({ elements }, { kind: el.kind, id: el.id });
    return { figures: f, hasEstimates: f.estimateIds.length > 0 };
  }
  if (el.kind === "part") {
    const f = sourceFiguresOf(elements, el.id);
    return { figures: f, hasEstimates: f.estimateIds.length > 0 };
  }
  return null;
}

type Side = "allocated" | "actual" | "counted";

function sideValue(f: Figures | null, side: Side, q: QuantityKey): number | null {
  if (!f) return null;
  const hasActual = f.figures.actualIds.length > 0;
  if (side === "allocated" && !f.hasEstimates) return null;
  if (side === "actual" && !hasActual) return null;
  if (side === "counted" && !f.hasEstimates && !hasActual) return null;
  return f.figures[side][q];
}

/**
 * One load row of a Loads list: its value on the estimate side while it is an
 * estimate (spread over a space, or a typed row nothing stands for yet), on
 * the devices side once it is concentrated or a device, and what it adds to
 * the project total (`countedOf`), so the list's totals row is the project's
 * counted figure: no estimate and the devices inside it counted twice.
 */
function loadRowValue(el: BimElement, elements: Elements, side: Side, q: QuantityKey): number | null {
  const engine = requirementsEngineOf(elements);
  const model = { elements };
  if (side === "counted") return engine.countedOf(model, el.id)?.[q] ?? null;
  const status = engine.statusOf(model, el.id);
  const value = engine.valueOf(model, el.id);
  if (!status || !value) return null;
  return (side === "allocated") === (status.stage === "estimate") ? value[q] : null;
}

function readSide(el: BimElement, elements: Elements, side: Side, q: QuantityKey): number | null {
  return el.kind === "load_point" ? loadRowValue(el, elements, side, q) : sideValue(figuresOf(el, elements), side, q);
}

const SIDE_LABEL: Readonly<Record<Side, string>> = { allocated: "Estimate", actual: "Devices so far", counted: "Counted" };
const SIDE_HELP: Readonly<Record<Side, string>> = {
  allocated: "What the estimates spread over this space or zone (or naming this source) add up to; on a load row, its value while it is still an estimate or a typed row. Empty: no estimate typed.",
  actual: "What the real devices, fixtures and equipment add up to; on a load row, its value once it sits on a pipe end, a point or a device. Empty: none placed yet.",
  counted: "What totals above this count: each estimate until the devices inside it exceed it (the space's estimate-counting setting, else the model's), plus the devices no estimate stands for; a typical unit's loads once per instance. A Loads list's total of this column is the project total.",
};

/** "Loads · <section>" for a quantity, read from the load-section rows in force when asked (not at module load, before add-ons are installed). */
function loadsGroup(q: QuantityKey): string {
  const rows = loadSectionRows();
  // No add-on here groups it (a bare kernel): the plain Loads group.
  if (!rows.some((r) => r.quantities.includes(q))) return "Loads";
  const section = sectionOfQuantity(q);
  return `Loads · ${rows.find((r) => r.id === section)?.label ?? section}`;
}

const quantityFields: ProviderField[] = SUMMED.flatMap((q): ProviderField[] => {
  const b = QUANTITY_BINDINGS[q];
  return (["allocated", "actual", "counted"] as const).map((side) => ({
    path: `loads.${side}.${q}`,
    label: `${SIDE_LABEL[side]}: ${QUANTITIES[q].label.toLowerCase()}`,
    classes: [...SCOPES, ...SOURCES, ...LOAD],
    valueType: "quantity" as const,
    kind: b.kind,
    unit: b.unit,
    aggregation: b.aggregation,
    writer: locked(FROM_LOADS),
    deps: DEPS,
    get group() {
      return loadsGroup(q);
    },
    description: SIDE_HELP[side],
    read: (el, ctx) => readSide(el, ctx.elements, side, q),
  }));
});

/** The heating value gas input converts at: the model's natural gas system's, else the kernel default (1,000 Btu/cf). */
function gasHeatingValue(elements: Elements): number {
  for (const s of elementsOfKind(elements, "mep_system")) {
    if (s.systemKind === "natural_gas") return gasProperties(mergePipeDesign(undefined, s.design?.pipe)).heatingValueBtuPerCf;
  }
  return PIPE_DESIGN_DEFAULTS.heatingValueBtuPerCf;
}

/** The quantity the field below converts to a flow: the counted heat input. */
const COUNTED_HEAT_INPUT: QuantityKey = "mbh";

const gasFlowField: ProviderField = {
  path: "loads.counted_gas_flow",
  label: "Counted: gas flow",
  classes: [...SCOPES, ...SOURCES, ...LOAD],
  valueType: "quantity",
  kind: "flow_gas_volume",
  unit: "cfh",
  aggregation: "sum",
  writer: locked(FROM_LOADS),
  deps: { elementKinds: [...DEPS.elementKinds, "mep_system"] },
  get group() {
    return loadsGroup(COUNTED_HEAT_INPUT);
  },
  description: "The counted gas input as gas flow, at the gas system's heating value (1,000 Btu per cubic foot unless the gas system sets another): what the meter is sized for.",
  read: (el, ctx) => {
    const mbh = readSide(el, ctx.elements, "counted", COUNTED_HEAT_INPUT);
    return mbh === null ? null : (mbh * 1000) / gasHeatingValue(ctx.elements);
  },
};

/** The quantities in print order: by load section, in the rows' order (read when asked, from the rows in force). */
function printOrder(): QuantityKey[] {
  const out: QuantityKey[] = [];
  for (const row of loadSectionRows()) for (const q of row.quantities) if (SUMMED.includes(q) && !out.includes(q)) out.push(q);
  return out;
}

/** "estimate 2,000 VA, devices so far 800 VA; estimate 12 WSFU, devices so far 4 WSFU". Null when there is no estimate to compare. */
export function estimateVsDevicesText(figures: AllocatedActual): string | null {
  const lines: string[] = [];
  for (const q of printOrder()) {
    if (figures.allocated[q] === 0 && figures.actual[q] === 0) continue;
    lines.push(allocatedActualLine(figures, q, formatQuantity));
  }
  return lines.length > 0 ? lines.join("; ") : null;
}

const STAGE_TEXT: Readonly<Record<LoadStage, string>> = { estimate: "Estimate", concentrated: "Load point", device: "Device" };
const STATUS_TEXT: Readonly<Record<LoadStatus, string>> = {
  open: "No source yet",
  assigned: "Source named, not drawn",
  placed: "Placed",
  connected: "Connected",
  attached: "Attached to a device",
  mismatch: "Needs attention",
};

const summaryFields: ProviderField[] = [
  {
    path: "loads.estimate_vs_devices",
    label: "Estimate vs devices",
    classes: [...SCOPES, ...SOURCES, ...LOAD],
    valueType: "text",
    writer: locked(FROM_LOADS),
    deps: DEPS,
    group: "Loads",
    description: "The estimate beside what the devices placed so far add up to, per quantity, and which one counts.",
    read: (el, ctx) => {
      if (el.kind === "load_point") {
        const f = requirementsEngineOf(ctx.elements).allocatedActual({ elements: ctx.elements }, el.id);
        return f ? textOrNull(estimateVsDevicesText(f)) : null;
      }
      const f = figuresOf(el, ctx.elements);
      return f?.hasEstimates ? textOrNull(estimateVsDevicesText(f.figures)) : null;
    },
  },
  {
    path: "load.stage",
    label: "Stage",
    classes: LOAD,
    valueType: "choice",
    choices: Object.values(STAGE_TEXT),
    writer: locked("Move the load: onto a space for an estimate, a pipe end or point for a load point, a fixture or device once one stands for it."),
    deps: DEPS,
    group: "Loads",
    description: "Estimate: spread over a space or zone. Load point: concentrated at a pipe end, a point or a connector. Device: a modelled fixture, device or piece of equipment stands for it.",
    read: (el, ctx) => {
      if (el.kind !== "load_point") return null;
      const s = requirementsEngineOf(ctx.elements).statusOf({ elements: ctx.elements }, el.id);
      return s ? STAGE_TEXT[s.stage] : null;
    },
  },
  {
    path: "load.status",
    label: "Status",
    classes: LOAD,
    valueType: "choice",
    choices: Object.values(STATUS_TEXT),
    writer: locked("Name its source, place it, or connect it; the status follows the model."),
    deps: { ...DEPS, connections: true },
    group: "Loads",
    description: "Where the load is in its life: no source yet, source named, placed, connected, attached to a device, or needs attention (its source or space is gone).",
    read: (el, ctx) => {
      if (el.kind !== "load_point") return null;
      const s = requirementsEngineOf(ctx.elements).statusOf({ elements: ctx.elements }, el.id);
      return s ? STATUS_TEXT[s.status] : null;
    },
  },
];

export const LOADS_FIELD_PROVIDER: FieldProvider = {
  id: "loads",
  fields: [...quantityFields, gasFlowField, ...summaryFields],
};
