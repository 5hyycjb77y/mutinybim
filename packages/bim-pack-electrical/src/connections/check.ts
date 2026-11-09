import { pushTo, elementValues, type ElementId, type ModelState, connectionTypeOf, linkServing } from "@permitzip/bim-kernel";
import type { ElectricalLoadEngine, FindingKind } from "./engine";
import { distributionOf, electricalConnectorIds, electricalName } from "./systems";

/**
 * The Electrical tab's Check list: what needs the engineer's attention across
 * the whole model, in one place. Panel findings come straight from the
 * aggregation engine (overloads, unbalance, a bus above its feeding breaker,
 * voltage that no longer matches, equipment breakers against their
 * nameplate); the model-wide ones are loads on no circuit and devices naming
 * a connection type the catalog doesn't have.
 */

export type CheckKind = FindingKind | "uncircuited" | "missing_connection_type";

export interface CheckItem {
  readonly kind: CheckKind;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  /** Click selects these. */
  readonly elementIds: readonly ElementId[];
  /** The panel it is about, for opening its panel view. */
  readonly panelId: ElementId | null;
}

const RANK = { error: 0, warning: 1, info: 2 } as const;
/** One collator for every sort: localeCompare with options builds one per call, which dominates on thousands of names. */
const NATURAL = new Intl.Collator(undefined, { numeric: true });

interface Scan {
  readonly open: { id: ElementId; name: string }[];
  readonly missing: Map<string, ElementId[]>;
}

/**
 * One pass over the parts: loads on no circuit and devices naming a missing
 * connection type. Which connectors a part type has doesn't depend on the
 * part's values, so it is read once per type; only connector-less equipment
 * (circuited by its nameplate) and electrical equipment (which may be a
 * panel) look at each part.
 */
function scan(model: Pick<ModelState, "elements">): Scan {
  const els = model.elements;
  const open: { id: ElementId; name: string }[] = [];
  const missing = new Map<string, ElementId[]>();
  const typeIds = new Map<string, readonly string[] | "per-part" | null>();
  const idsOfType = (typeId: string): readonly string[] | "per-part" | null => {
    const known = typeIds.get(typeId);
    if (known !== undefined) return known;
    const t = els[typeId];
    let out: readonly string[] | "per-part" | null = null;
    if (t?.kind === "part_type") {
      const ids = t.definition.connectors.filter((c) => c.domain === "electrical").map((c) => c.id);
      const d = t.definition;
      const hasVoltage = d.typeParams.some((x) => x.name === "voltage") || d.instanceParams.some((x) => x.name === "voltage");
      out = d.category === "electrical_equipment" || (ids.length === 0 && hasVoltage) ? "per-part" : ids.length > 0 ? ids : null;
    }
    typeIds.set(typeId, out);
    return out;
  };
  for (const el of elementValues(els)) {
    if (el.kind !== "part") continue;
    const v = el.values.connection_type;
    if (typeof v === "string" && v.trim() !== "" && !connectionTypeOf(els, v)) pushTo(missing, v.trim(), el.id);
    let connectors = idsOfType(el.typeId);
    if (connectors === null) continue;
    if (connectors === "per-part") {
      if (distributionOf(els, el)) continue;
      connectors = electricalConnectorIds(els, el);
    }
    if (connectors.length === 0) continue;
    if (connectors.every((c) => linkServing(els, el.id, c) === null)) open.push({ id: el.id, name: electricalName(els, el) });
  }
  open.sort((a, b) => NATURAL.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { open, missing };
}

/** Loads with a power connector on no circuit (devices and equipment, not distribution equipment). */
export function uncircuitedLoads(model: Pick<ModelState, "elements">): { readonly id: ElementId; readonly name: string }[] {
  return scan(model).open;
}

export function electricalCheck(engine: ElectricalLoadEngine, model: Pick<ModelState, "elements">): CheckItem[] {
  const items: CheckItem[] = [];
  for (const nodeId of engine.distribution(model)) {
    const report = engine.report(model, nodeId);
    if (!report) continue;
    for (const f of report.findings) items.push({ kind: f.kind, severity: f.severity, message: f.message, elementIds: f.elementIds, panelId: nodeId });
  }
  const { open, missing } = scan(model);
  if (open.length > 0) {
    const names = open.slice(0, 5).map((o) => o.name);
    items.push({
      kind: "uncircuited",
      severity: "warning",
      message: `${open.length} load${open.length === 1 ? " is" : "s are"} on no circuit: ${names.join(", ")}${open.length > names.length ? ` and ${open.length - names.length} more` : ""}. Select ${open.length === 1 ? "it" : "them"} and press Add to circuit`,
      elementIds: open.map((o) => o.id),
      panelId: null,
    });
  }
  for (const [designator, ids] of [...missing.entries()].sort((a, b) => NATURAL.compare(a[0], b[0]))) {
    items.push({ kind: "missing_connection_type", severity: "warning", message: `${ids.length} device${ids.length === 1 ? " names" : "s name"} connection type ${designator}, which isn't in the project's connection types, so ${ids.length === 1 ? "its" : "their"} load comes from the part instead; add ${designator} in Electrical types`, elementIds: ids, panelId: null });
  }
  return items.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
