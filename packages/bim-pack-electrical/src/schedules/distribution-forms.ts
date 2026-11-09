import { elementValues, type BimElement, type ModelState, type PartInstance, linksFedFrom, type ServiceLink, fieldText, resolveField, type FieldOptions, type FormScheduleDef, formScheduleKindLabel, type FormColumn, type ScheduleSource, type FormNote, type FormScheduleDefinition, type EvaluatedForm, type FormAlign, type FormGrid, formScheduleSupport } from "@permitzip/bim-kernel";
import type { LinkLoad, NodeLoads } from "../connections/engine";
import { parseLoadClass } from "../connections/loads";
import { isCircuitableLoad, memberName, panelSchedule } from "../connections/panel";
import { distributionOf, hotConductors, PHASE_NAMES, type DistributionInfo } from "../connections/systems";
import { feederTypeField } from "../fields/electrical-resolver";
import { feederTypeRows } from "../fields/feeder-types";
import { electricalEngineFor } from "../fields/rules-registry";
import { CONNECTION_TYPES_TEMPLATE, EQUIPMENT_CONNECTIONS_TEMPLATE, FEEDER_TEMPLATE, PANEL_TEMPLATE, SWITCHBOARD_TEMPLATE } from "./distribution-templates";

const { COLLATOR, cell, empty, headerOf, listForm, options, partOf, titleOf, typeOf } = formScheduleSupport;

/**
 * The distribution form schedules (panel, switchboard, feeder, connection
 * types, equipment connections): title, header values, the body grid, the
 * load summary, totals, the notes legend and the line naming the code rules
 * the demand figures come from. Loads are the aggregation engine's
 * (`electricalEngineFor(def.rules)`): connected and demand by load class from
 * the raw inventory below the panel, per phase, spares and spaces. Nothing
 * here adds up a load itself. Rows of `FORM_SCHEDULE_POINT` the Electrical
 * pack contributes.
 */

type Elements = Readonly<Record<string, BimElement>>;

const kva = (va: number) => (Math.round(va / 10) / 100).toFixed(2);
const amps = (a: number) => `${Math.round(a).toLocaleString("en-US")} A`;
const OFF = new Set(["", "no", "false", "0", "off", "n"]);
function sameText(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const ca = parseLoadClass(a);
  return ca !== null && ca === parseLoadClass(b);
}

/** A member's own parameter as written (instance, else type), for "is it on" note conditions. */
function ownParam(elements: Elements, id: string, name: string): string {
  const part = partOf(elements, id);
  if (!part) return "";
  const v = part.values[name] ?? typeOf(elements, part)?.definition.typeValues[name];
  return v === undefined ? "" : String(v);
}

/**
 * The legend marks a circuit gets: a note applies when its condition holds on
 * the circuit or any part on it. "gfci" reads the parameter as written (on,
 * yes, true, 1); "load_class=Motor" compares a field.
 */
function noteMarks(model: Pick<ModelState, "elements">, link: ServiceLink, notes: readonly FormNote[], opts: FieldOptions): string {
  const marks: string[] = [];
  for (const n of notes) {
    if (!n.when) continue;
    const eq = n.when.indexOf("=");
    const field = (eq >= 0 ? n.when.slice(0, eq) : n.when).trim();
    const want = eq >= 0 ? n.when.slice(eq + 1).trim() : null;
    const holds = (id: string) => {
      if (want === null) {
        const own = id === link.id ? "" : ownParam(model.elements, id, field);
        return !OFF.has(own.trim().toLowerCase());
      }
      return sameText(fieldText(model.elements, id, field, opts), want);
    };
    if ([link.id, ...link.members.map((m) => m.elementId)].some(holds)) marks.push(`[${n.mark}]`);
  }
  return marks.join(" ");
}

/** What a slot prints as its description: the engineer's, else SPARE, else (panels) what is on it. */
function circuitDescription(elements: Elements, link: ServiceLink, fallbackToMembers: boolean): string {
  if (link.description.trim()) return link.description;
  if (link.members.length === 0) return "SPARE";
  if (!fallbackToMembers) return "";
  const names = link.members.map((m) => {
    const p = partOf(elements, m.elementId);
    return p ? memberName(elements, p) : m.elementId;
  });
  const unique = [...new Set(names)];
  return unique.length > 3 ? `${unique.slice(0, 3).join(", ")}…` : unique.join(", ");
}

// ------------------------------------------------------------------ distribution (panel, switchboard)

function summaryOf(model: Pick<ModelState, "elements">, def: FormScheduleDefinition, nodeId: string, spareCount: number, spaceCount: number) {
  const engine = electricalEngineFor(def.rules);
  const report = engine.report(model, nodeId);
  const s = def.template.summary;
  if (!report) return { summary: null, totals: [], footer: "" };
  const summary = s?.loadClasses
    ? {
        headings: ["LOAD CLASS", "CONNECTED (kVA)", "DEMAND FACTOR", "DEMAND (kVA)"],
        // An adder (largest motor +25%) has demand but no connected load of its own.
        rows: report.demand.lines.map((l) => [l.label.toUpperCase(), l.connectedVa > 0 ? kva(l.connectedVa) : "", l.connectedVa > 0 ? `${Math.round(l.factor * 1000) / 10}%` : "", kva(l.demandVa)]),
      }
    : null;
  const totals: Array<{ label: string; value: string }> = [];
  if (s?.phaseTotals) for (const p of report.perPhase) totals.push({ label: `PHASE ${p.phase}`, value: `${kva(p.va)} kVA   ${amps(p.amps)}` });
  if (s?.totals) {
    totals.push({ label: "TOTAL CONNECTED LOAD", value: `${kva(report.connectedVa)} kVA   ${amps(report.connectedA)}` });
    totals.push({ label: "TOTAL DEMAND LOAD", value: `${kva(report.demand.demandVa)} kVA   ${amps(report.demandA)}` });
    if (report.capacity.limitedBy) totals.push({ label: "AVAILABLE CAPACITY", value: `${amps(report.capacity.limitedBy.amps)} (${report.capacity.limitedBy.description})` });
    totals.push({ label: "SPARES / SPACES", value: `${spareCount} / ${spaceCount}` });
  }
  const footer = report.rules.placeholder ? "Connected loads only: no code edition chosen for demand factors" : `Demand: ${report.rules.label}`;
  return { summary, totals, footer };
}

function evaluateDistribution(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm {
  const elements = model.elements;
  const id = def.elementId ?? "";
  const opts = options(def);
  const part = partOf(elements, id);
  const kindWord = def.kind === "panel" ? "panel" : "switchboard";
  if (!part || ("deleted" in part && part.deleted)) return empty(def, formScheduleKindLabel(def.kind).toUpperCase(), `The ${kindWord} this schedule belongs to is no longer in the model. Delete the schedule, or point it at another ${kindWord}.`);
  const info = distributionOf(elements, part);
  if (!info) return empty(def, formScheduleKindLabel(def.kind).toUpperCase(), `${part.mark || "This part"} is not a panel, switchboard or transformer any more, so it has no schedule.`);
  const title = titleOf(model, def, id, opts);
  const header = headerOf(model, def, id, opts);
  const loads = electricalEngineFor(def.rules).loads(model, id);
  // The engine hands back the same node loads while nothing on the panel's circuits changed, so neither did its body.
  const known = bodies.get(def);
  const body = known && loads && known.loads === loads ? known.body : distributionBody(model, def, id, info, loads);
  if (loads) bodies.set(def, { loads, body });
  const notes = def.template.notes.map((n) => `[${n.mark}] ${n.text}`);
  return { title, header, headerColumns: def.template.header.columns, grid: body.grid, ...summaryOf(model, def, id, body.spareCount, body.spaceCount), notes, problem: null };
}

interface DistributionBody {
  readonly grid: FormGrid;
  readonly spareCount: number;
  readonly spaceCount: number;
}

const bodies = new WeakMap<FormScheduleDefinition, { readonly loads: NodeLoads; readonly body: DistributionBody }>();

function distributionBody(model: Pick<ModelState, "elements">, def: FormScheduleDefinition, id: string, info: DistributionInfo, loads: NodeLoads | null): DistributionBody {
  const elements = model.elements;
  const opts = options(def);
  const byLink = new Map<string, LinkLoad>((loads?.links ?? []).map((l) => [l.linkId, l]));
  const links = linksFedFrom(elements, id);
  const spareCount = links.filter((l) => l.role === "branch" && l.members.length === 0).length;
  const linkValue = (link: ServiceLink, path: string): string => {
    if (path === "notes") return noteMarks(model, link, def.template.notes, opts);
    if (path === "description") return circuitDescription(elements, link, def.template.body.layout === "slots");
    return resolveField(model.elements, link.id, path, opts).text;
  };

  if (def.template.body.layout === "rows") {
    const cols = def.template.body.columns;
    const sorted = [...links].sort((a, b) => (a.source.positions[0] ?? Number.MAX_SAFE_INTEGER) - (b.source.positions[0] ?? Number.MAX_SAFE_INTEGER) || COLLATOR.compare(a.description, b.description));
    const grid: FormGrid = {
      headings: cols.map((c) => c.heading),
      aligns: cols.map((c) => c.align ?? "center"),
      widths: cols.map((c) => c.widthMm),
      rows: sorted.map((l) => cols.map((c) => cell(c.value, (p) => linkValue(l, p)))),
      rowIds: sorted.map((l) => [l.id]),
      splitAt: null,
    };
    const used = new Set(links.flatMap((l) => l.source.positions));
    return { grid, spareCount, spaceCount: info.spaces !== null ? Math.max(0, info.spaces - used.size) : 0 };
  }
  const slotBody = def.template.body;
  const schedule = panelSchedule(elements, id);
  const phases = slotBody.phaseLoads ? PHASE_NAMES.slice(0, hotConductors(info.system)) : [];
  const cols: readonly FormColumn[] = slotBody.columns;
  const slotCells = (slot: number): string[] => {
    const s = schedule?.slots[slot - 1];
    const circuit = s?.circuit ?? null;
    const link = circuit ? elements[circuit.linkId] : undefined;
    const own = (path: string): string | null => {
      if (path === "number" || path === "positions") return String(slot);
      return null;
    };
    const texts = cols.map((c) => {
      if (!s) return "";
      if (!circuit || link?.kind !== "service_link") return cell(c.value, (p) => own(p) ?? (p === "description" ? "SPACE" : ""));
      if (!s.first) return cell(c.value, (p) => own(p) ?? "");
      return cell(c.value, (p) => own(p) ?? linkValue(link, p));
    });
    const phaseTexts = phases.map((name) => {
      if (!s || !circuit || s.phase !== name) return "";
      const l = byLink.get(circuit.linkId);
      if (!l) return "";
      const idx = PHASE_NAMES.indexOf(name);
      const onPhase = circuit.positions.filter((x) => schedule?.slots[x - 1]?.phase === name).length || 1;
      return kva((l.inventory.perPhase[idx] ?? 0) / onPhase);
    });
    return [...texts, ...phaseTexts];
  };
  const spaces = info.spaces ?? 0;
  const rows: string[][] = [];
  const rowIds: string[][] = [];
  for (let r = 0; r * 2 < spaces; r++) {
    const left = slotCells(r * 2 + 1);
    const right = r * 2 + 2 <= spaces ? slotCells(r * 2 + 2) : cols.map(() => "").concat(phases.map(() => ""));
    rows.push([...left, ...[...right].reverse()]);
    const ids = [schedule?.slots[r * 2]?.circuit?.linkId, schedule?.slots[r * 2 + 1]?.circuit?.linkId].filter((x): x is string => typeof x === "string");
    rowIds.push([...new Set(ids)]);
  }
  const half = cols.map((c) => c.heading).concat(phases.map((p) => p));
  const halfAligns: FormAlign[] = cols.map((c) => c.align ?? "center").concat(phases.map(() => "right" as const));
  const halfWidths = cols.map((c) => c.widthMm).concat(phases.map(() => undefined));
  const grid: FormGrid = {
    headings: [...half, ...[...half].reverse()],
    aligns: [...halfAligns, ...[...halfAligns].reverse()],
    widths: [...halfWidths, ...[...halfWidths].reverse()],
    rows,
    rowIds,
    splitAt: half.length,
  };
  const spaceCount = schedule ? schedule.slots.filter((s) => !s.circuit).length : 0;
  return { grid, spareCount, spaceCount };
}

function evaluateFeeders(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm {
  const rows = feederTypeRows(model.elements).map((r) => ({ ids: r.feederIds, value: (path: string) => feederTypeField(model.elements, r.mark, path).text }));
  return listForm(model, def, rows);
}

function partPseudo(elements: Elements, part: PartInstance, path: string): string | null {
  const type = typeOf(elements, part);
  if (!type) return null;
  const d = type.definition;
  const values = { ...d.typeValues, ...part.values };
  const text = (name: string) => {
    const v = values[name];
    return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  };
  switch (path) {
    case "designator":
      return text("type_mark") || text("designator") || d.typeName;
    case "type_description":
      return d.typeName && !d.familyName.includes(d.typeName) ? `${d.familyName}, ${d.typeName}` : d.familyName;
    case "connection": {
      const c = text("connection_type") || text("connection");
      if (c) return c;
      const nema = text("nema") || text("nema_config");
      if (nema) return /nema/i.test(nema) ? nema : `NEMA ${nema}`;
      return /receptacle|outlet/i.test(d.familyName) ? "" : "Hardwired";
    }
    default:
      return null;
  }
}

const EQUIPMENT_CATEGORIES = new Set(["mechanical_equipment", "plumbing_fixture", "generic"]);

function isEquipmentConnection(elements: Elements, part: PartInstance, categories: readonly string[] | undefined): boolean {
  const type = typeOf(elements, part);
  if (!type || !isCircuitableLoad(elements, part)) return false;
  const d = type.definition;
  if (categories) return categories.includes(d.category);
  if (EQUIPMENT_CATEGORIES.has(d.category)) return true;
  return d.category === "electrical_device" && /equipment connection|disconnect|hardwired/i.test(`${d.familyName} ${d.typeName}`);
}

function evaluateParts(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm {
  const elements = model.elements;
  const opts = options(def);
  const parts: PartInstance[] = [];
  for (const el of elementValues(elements)) {
    if (el.kind !== "part" || ("deleted" in el && el.deleted)) continue;
    if (def.kind === "equipment_connections" ? isEquipmentConnection(elements, el, def.template.categories) : isCircuitableLoad(elements, el) && (!def.template.categories || def.template.categories.includes(typeOf(elements, el)?.definition.category ?? ""))) parts.push(el);
  }
  const value = (part: PartInstance, count: number) => (path: string) => {
    if (path === "count") return String(count);
    return partPseudo(elements, part, path) ?? fieldText(model.elements, part.id, path, opts);
  };
  if (def.kind === "equipment_connections") {
    parts.sort((a, b) => COLLATOR.compare(a.mark, b.mark) || COLLATOR.compare(a.id, b.id));
    return listForm(model, def, parts.map((p) => ({ ids: [p.id], value: value(p, 1) })));
  }
  // Connection types: one row per type and the loads it is set to.
  const groups = new Map<string, PartInstance[]>();
  for (const p of parts) {
    const key = [p.typeId, fieldText(model.elements, p.id, "load", opts), fieldText(model.elements, p.id, "voltage_phase", opts), fieldText(model.elements, p.id, "load_class", opts)].join("|");
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const rows = [...groups.values()].map((g) => ({ first: g[0] as PartInstance, ids: g.map((p) => p.id) }));
  rows.sort((a, b) => COLLATOR.compare(partPseudo(elements, a.first, "designator") ?? "", partPseudo(elements, b.first, "designator") ?? ""));
  return listForm(model, def, rows.map((r) => ({ ids: r.ids, value: value(r.first, r.ids.length) })));
}

const CIRCUITS: ScheduleSource = { kind: "classes", classes: ["mep.service_link"], includeSubclasses: true };
const EQUIPMENT: ScheduleSource = { kind: "classes", classes: ["mep.equipment"], includeSubclasses: true };
const DISTRIBUTION = "panel or switchboard";

export const DISTRIBUTION_FORM_ROWS: readonly FormScheduleDef[] = [
  { kind: "panel", evaluate: evaluateDistribution, label: "Panel schedule", template: PANEL_TEMPLATE, boundTo: DISTRIBUTION, source: CIRCUITS, order: 10 },
  { kind: "switchboard", evaluate: evaluateDistribution, label: "Switchboard schedule", template: SWITCHBOARD_TEMPLATE, boundTo: DISTRIBUTION, source: CIRCUITS, order: 20 },
  { kind: "feeder", evaluate: evaluateFeeders, label: "Feeder schedule", template: FEEDER_TEMPLATE, source: CIRCUITS, order: 30 },
  { kind: "connection_types", evaluate: evaluateParts, label: "Electrical connection type schedule", template: CONNECTION_TYPES_TEMPLATE, source: { kind: "catalog", catalog: "part_types" }, order: 40 },
  { kind: "equipment_connections", evaluate: evaluateParts, label: "Equipment connection schedule", template: EQUIPMENT_CONNECTIONS_TEMPLATE, source: EQUIPMENT, order: 50 },
];
