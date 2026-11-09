import { convert, QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { paramValue, resolveConnectors, connectionTypeOfLoadPoint, loadPointLabel, loadPointQuantities, runEndOf, resolveFitting, len3, sub3, isSource, type RunGraphNode, partLabelOf, runLabel, PIPE_DESIGN_DEFAULTS, gasProperties, mergePipeDesign, type GasKind, type PipeDesign, pipeComponent as component, pipeNodeId as idOf, pipePositionOn as positionOn, pipeWalkTree as tree } from "@permitzip/bim-kernel";
import { REGULATOR_PARAMS } from "./families";
import type { LoadPointElement, BimElement, ElementId, ModelState, PartInstance, MepSystem, PipeMaterial, RunFitting, RunSegment } from "@permitzip/bim-kernel";

/**
 * Gas pressure zones. A gas system starts at its source (meter, tank or the
 * secondary regulator's outlet) at the system's inlet pressure; every gas
 * pressure regulator downstream starts a new zone at its outlet setting with
 * its own allowable drop (IFGC 402.4.3: a 2 psi system with line
 * regulators is sized zone by zone). This walks the drawn topology once and
 * returns, per zone, the segment tree the fuel gas code's sizing methods
 * take (length to each outlet, input at each outlet), plus the appliances,
 * the regulators and the total input.
 *
 * No code table is read here (the kernel is table-free): sizing by Table
 * 402.4(n) happens in the calc pack (`plumbing.gas_system`). What this file
 * checks needs no table: an appliance fed at more than it takes (no
 * regulator between zones), a regulator set above its inlet, a regulator
 * over its rated capacity, an appliance whose minimum inlet pressure the
 * zone cannot guarantee.
 */

type Elements = Readonly<Record<string, BimElement>>;

const MM_PER_FT = 304.8;
export const IN_WC_PER_PSI = 27.7;
/** Appliances take at most 1/2 psi (14 in. w.c.) at their inlet unless their data says otherwise; above that a regulator is needed ahead of them. */
export const APPLIANCE_MAX_INLET_IN_WC = 14;
/** At or above 1-1/2 psi the fuel gas code's high-pressure equation and tables apply. */
export const HIGH_PRESSURE_IN_WC = 1.5 * IN_WC_PER_PSI;

export type RegulatorRole = "service" | "line" | "appliance";

export interface GasZoneSegment {
  /** Unique within the network: the segment id, with "@n" when the segment is cut at a branch or a regulator. */
  readonly id: string;
  /** The drawn pipe this length belongs to; null for the zone's virtual root (a zone that splits right at its regulator). */
  readonly elementId: ElementId | null;
  readonly parent: string | null;
  readonly lengthFt: number;
  /** Input at the end of this length: an appliance, or a downstream zone seen through its regulator. */
  readonly loadMbh: number;
  readonly label: string;
  readonly material: PipeMaterial | null;
  readonly nominalIn: number | null;
  /** Developed length from the system's source (meter, tank, service regulator) to the end of this length, along the pipe (ft). */
  readonly fromSourceFt: number;
}

export interface GasAppliance {
  readonly elementId: ElementId;
  readonly label: string;
  readonly mark: string | null;
  readonly description: string;
  readonly mbh: number;
  readonly zoneId: string;
  readonly minInletInWc: number | null;
  readonly maxInletInWc: number;
  /** The regulator whose zone the appliance is in; null on the source zone. */
  readonly regulatorId: ElementId | null;
  /** Length from the zone's start to the appliance (ft). */
  readonly pathFt: number;
  /** Developed length from the system's source to the appliance, through every regulator, along the routed pipe (ft). */
  readonly fromSourceFt: number;
  /** What the input is read from: a part (equipment, fixture) or a load point on a pipe end. */
  readonly source: "part" | "load_point";
  /** The zone piece that feeds it (a `GasZoneSegment` id), its drawn pipe, size and material; null when it hangs right at a regulator or the source. */
  readonly feedPieceId: string | null;
  readonly feedElementId: ElementId | null;
  readonly feedNominalIn: number | null;
  readonly feedMaterial: PipeMaterial | null;
}

export interface GasRegulator {
  readonly elementId: ElementId;
  readonly label: string;
  readonly role: RegulatorRole;
  readonly outletInWc: number;
  readonly zoneDropInWc: number;
  readonly vent: string;
  readonly capacityMbh: number | null;
  /** The zone it is fed from, and the zone it starts. */
  readonly upstreamZoneId: string;
  readonly zoneId: string;
  /** Everything downstream of it (MBH). */
  readonly loadMbh: number;
}

export interface GasZone {
  readonly id: string;
  readonly label: string;
  readonly regulatorId: ElementId | null;
  readonly inletInWc: number;
  readonly allowableDropInWc: number;
  readonly highPressure: boolean;
  readonly segments: readonly GasZoneSegment[];
  readonly applianceIds: readonly ElementId[];
  /** Regulators fed from this zone (each starts a zone below). */
  readonly regulatorIds: readonly ElementId[];
  readonly totalMbh: number;
  /** From the zone's start to its most remote outlet (ft). */
  readonly longestFt: number;
  /** The material most of the zone's pipe is, for the table to read. */
  readonly material: PipeMaterial | null;
}

export type GasIssueCode = "regulator_missing" | "regulator_raises_pressure" | "regulator_over_capacity" | "zone_below_appliance_minimum" | "appliance_no_input" | "no_source" | "mixed_material";

export interface GasIssue {
  readonly code: GasIssueCode;
  readonly severity: "error" | "warning";
  readonly elementId: ElementId | null;
  readonly zoneId: string | null;
  readonly message: string;
}

export interface GasNetwork {
  readonly systemId: ElementId;
  readonly systemName: string;
  readonly gas: GasKind;
  readonly specificGravity: number;
  readonly heatingValueBtuPerCf: number;
  readonly method: "longest_length" | "branch_length";
  readonly sizingMode: "check" | "auto";
  readonly sourceId: ElementId | null;
  readonly sourceLabel: string;
  readonly zones: readonly GasZone[];
  readonly appliances: readonly GasAppliance[];
  readonly regulators: readonly GasRegulator[];
  readonly totalMbh: number;
  readonly issues: readonly GasIssue[];
  readonly memberIds: readonly ElementId[];
}

/** "11 in. w.c." below 1 psi, "2 psi" above. */
export function pressureLabel(inWc: number): string {
  if (inWc >= IN_WC_PER_PSI - 0.05) return `${Math.round((inWc / IN_WC_PER_PSI) * 100) / 100} psi`;
  return `${Math.round(inWc * 100) / 100} in. w.c.`;
}

const ROLE_WORD: Readonly<Record<RegulatorRole, string>> = { service: "Service regulator", line: "Line regulator", appliance: "Appliance regulator" };

function numberParam(params: Readonly<Record<string, number | string>> | undefined, key: string): number | null {
  const v = params?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const REGULATOR_DEFAULT = Object.fromEntries(REGULATOR_PARAMS.map((p) => [p.key, p.default])) as Readonly<Record<string, number | string>>;

/** The settings of a regulator: a placed regulator accessory, or an inline regulator part (its type's values). */
export function regulatorSettings(elements: Elements, el: BimElement | undefined): Omit<GasRegulator, "upstreamZoneId" | "zoneId" | "loadMbh"> | null {
  if (!el) return null;
  let values: Readonly<Record<string, number | string>> | null = null;
  let label = "";
  if (el.kind === "run_fitting" && el.fittingType === "accessory") {
    const system = elements[el.systemId];
    const rf = resolveFitting(system?.kind === "mep_system" ? system : null, el);
    if (rf?.family.pipe?.accessory !== "regulator") return null;
    values = rf.params;
    label = runLabel(elements, el);
  } else if (el.kind === "part" && isRegulatorPart(elements, el)) {
    const type = elements[el.typeId];
    if (type?.kind !== "part_type") return null;
    const read = (k: string): number | string | undefined => {
      const v = paramValue(type.definition, el.values, k);
      return typeof v === "number" || typeof v === "string" ? v : undefined;
    };
    const merged: Record<string, number | string> = {};
    for (const key of ["role", "outlet_in_wc", "zone_drop_in_wc", "vent", "capacity_mbh"]) {
      const v = read(key);
      if (v !== undefined) merged[key] = v;
    }
    values = merged;
    label = partLabelOf(elements, el);
  } else return null;
  const role = String(values.role ?? REGULATOR_DEFAULT.role) as RegulatorRole;
  const outlet = numberParam(values, "outlet_in_wc") ?? (REGULATOR_DEFAULT.outlet_in_wc as number);
  const drop = numberParam(values, "zone_drop_in_wc") ?? (REGULATOR_DEFAULT.zone_drop_in_wc as number);
  const capacity = numberParam(values, "capacity_mbh");
  const knownRole: RegulatorRole = role === "service" || role === "appliance" ? role : "line";
  return {
    elementId: el.id,
    label: el.kind === "part" ? label : `${ROLE_WORD[knownRole]} ${el.id}`,
    role: knownRole,
    outletInWc: outlet,
    zoneDropInWc: drop,
    vent: String(values.vent ?? REGULATOR_DEFAULT.vent),
    capacityMbh: capacity && capacity > 0 ? capacity : null,
  };
}

/** An inline regulator part (a pipe accessory part named as a regulator, or one carrying an outlet setting). */
export function isRegulatorPart(elements: Elements, part: PartInstance): boolean {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return false;
  const d = type.definition;
  if (d.category !== "pipe_accessory") return false;
  return /regulator/i.test(d.familyName) || paramValue(d, part.values, "outlet_in_wc") !== undefined;
}

/** A part's gas input at one connector (MBH): the connector's flow, the firm/project fixture table, else the type's input parameter. */
export function gasInputOf(elements: Elements, part: PartInstance, connectorId: string, design: PipeDesign): { mbh: number; found: boolean } {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return { mbh: 0, found: false };
  const c = resolveConnectors(type.definition, part.values).find((x) => x.id === connectorId);
  if (c?.flow !== undefined) return { mbh: c.flow, found: true };
  const name = type.definition.familyName.trim().toLowerCase();
  const row = design.fixtureTable?.find((r) => r.fixture.trim().toLowerCase() === name);
  if (row?.mbh !== undefined) return { mbh: row.mbh, found: true };
  for (const k of ["input_mbh", "gas_input_mbh", "mbh"]) {
    const v = paramValue(type.definition, part.values, k);
    if (typeof v === "number") return { mbh: v, found: true };
  }
  return { mbh: 0, found: false };
}

function partPressure(elements: Elements, part: PartInstance, keys: readonly string[]): number | null {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  for (const k of keys) {
    const v = paramValue(type.definition, part.values, k);
    if (typeof v === "number" && v > 0) return k.endsWith("_psi") ? v * IN_WC_PER_PSI : v;
  }
  return null;
}

/** The gas source: a connector that supplies gas, else equipment with no gas input (a meter, a tank's regulator). Equipment that burns gas (a rooftop unit, a water heater) is an appliance, not a source. */
export function gasSourceNode(elements: Elements, nodes: readonly RunGraphNode[], design: PipeDesign): RunGraphNode | undefined {
  const partNodes = nodes.filter((n) => n.includes("#"));
  const supplies = partNodes.find((n) => {
    const p = elements[idOf(n)];
    if (p?.kind !== "part") return false;
    const type = elements[p.typeId];
    if (type?.kind !== "part_type") return false;
    const c = type.definition.connectors.find((x) => x.id === n.slice(n.indexOf("#") + 1));
    return c?.flowDirection === "out" && !isRegulatorPart(elements, p);
  });
  if (supplies) return supplies;
  return partNodes.find((n) => {
    const p = elements[idOf(n)];
    return p?.kind === "part" && isSource(elements, p) && !gasInputOf(elements, p, n.slice(n.indexOf("#") + 1), design).found;
  });
}

interface Attach {
  readonly zone: string;
  readonly piece: string | null;
  /** Length from the zone's start to here (ft). */
  readonly pathFt: number;
  /** Length from the system's source to here (ft). */
  readonly sourceFt: number;
}

interface ZoneDraft {
  id: string;
  label: string;
  regulatorId: ElementId | null;
  inletInWc: number;
  allowableDropInWc: number;
  segments: Array<{ id: string; elementId: ElementId | null; parent: string | null; lengthFt: number; loadMbh: number; label: string; material: PipeMaterial | null; nominalIn: number | null; pathFt: number; sourceFt: number }>;
  applianceIds: ElementId[];
  regulatorIds: ElementId[];
}

const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** The pressure zones of one gas system, or null when the id isn't a gas pipe system. */
export function gasNetwork(model: Pick<ModelState, "elements">, systemId: string, options: { readonly firm?: PipeDesign; readonly anchor?: string } = {}): GasNetwork | null {
  const elements = model.elements;
  const system = elements[systemId];
  if (system?.kind !== "mep_system" || system.domain !== "pipe" || system.systemKind !== "natural_gas") return null;
  const design = mergePipeDesign(options.firm, system.design?.pipe);
  const props = gasProperties(design);
  const method = design.gasSizing === "branch_length" ? "branch_length" : "longest_length";
  const sizingMode = design.sizingMode ?? PIPE_DESIGN_DEFAULTS.sizingMode;
  const issues: GasIssue[] = [];
  const anchor = anchorOf(elements, system, options.anchor);
  const empty = (): GasNetwork => ({ systemId: system.id, systemName: system.name, ...props, method, sizingMode, sourceId: null, sourceLabel: "", zones: [], appliances: [], regulators: [], totalMbh: 0, issues, memberIds: [] });
  if (!anchor) return empty();
  const nodes = component(elements, anchor);
  const memberIds = [...new Set(nodes.map(idOf))].filter((id) => elements[id] !== undefined) as ElementId[];
  let root = gasSourceNode(elements, nodes, design);
  if (!root) {
    root = system.entryId && nodes.includes(system.entryId) ? system.entryId : (nodes.find((n) => !n.includes("#")) ?? anchor);
    issues.push({ code: "no_source", severity: "warning", elementId: null, zoneId: null, message: `No gas meter, tank or service regulator is connected to ${system.name}; zones are counted from ${labelOf(elements, root)}` });
  }
  const walk = tree(elements, nodes, root);
  const rootEl = elements[idOf(root)];
  const zones = new Map<string, ZoneDraft>();
  const regulators = new Map<ElementId, { settings: NonNullable<ReturnType<typeof regulatorSettings>>; upstreamZoneId: string; upstreamPiece: string | null; zoneId: string }>();
  const appliances: Array<Omit<GasAppliance, "regulatorId">> = [];
  const sourceInlet = design.inletPressureInWc ?? PIPE_DESIGN_DEFAULTS.inletPressureInWc;
  const sourceZone: ZoneDraft = { id: "zone-source", label: `From ${labelOf(elements, root)}, ${pressureLabel(sourceInlet)}`, regulatorId: null, inletInWc: sourceInlet, allowableDropInWc: design.allowableDropInWc ?? PIPE_DESIGN_DEFAULTS.allowableDropInWc, segments: [], applianceIds: [], regulatorIds: [] };
  zones.set(sourceZone.id, sourceZone);
  const attach = new Map<RunGraphNode, Attach>([[root, { zone: sourceZone.id, piece: null, pathFt: 0, sourceFt: 0 }]]);

  const zoneOf = (id: string): ZoneDraft => {
    const z = zones.get(id);
    if (!z) throw new Error(`gas zone ${id} missing`);
    return z;
  };
  /** A zone's root piece when something hangs right at its start (no pipe drawn yet in the zone). */
  const zoneStartFt = new Map<string, number>([[sourceZone.id, 0]]);
  const virtualRoot = (zoneId: string): string => {
    const z = zoneOf(zoneId);
    const id = `${zoneId}:start`;
    if (!z.segments.some((s) => s.id === id)) z.segments.push({ id, elementId: null, parent: null, lengthFt: 0, loadMbh: 0, label: `start of ${z.label}`, material: null, nominalIn: null, pathFt: 0, sourceFt: zoneStartFt.get(zoneId) ?? 0 });
    return id;
  };
  const startZone = (reg: NonNullable<ReturnType<typeof regulatorSettings>>, from: Attach): Attach => {
    const id = `zone-${reg.elementId}`;
    zones.set(id, { id, label: `${reg.label}, ${pressureLabel(reg.outletInWc)}`, regulatorId: reg.elementId, inletInWc: reg.outletInWc, allowableDropInWc: reg.zoneDropInWc, segments: [], applianceIds: [], regulatorIds: [] });
    zoneOf(from.zone).regulatorIds.push(reg.elementId);
    regulators.set(reg.elementId, { settings: reg, upstreamZoneId: from.zone, upstreamPiece: from.piece ?? virtualRoot(from.zone), zoneId: id });
    zoneStartFt.set(id, from.sourceFt);
    return { zone: id, piece: null, pathFt: 0, sourceFt: from.sourceFt };
  };
  /** An outlet (appliance or load point) at `here`: its input lands on the piece that feeds it. */
  const outlet = (here: Attach, a: { elementId: ElementId; label: string; mark: string | null; description: string; mbh: number; minInletInWc: number | null; maxInletInWc: number; source: GasAppliance["source"] }) => {
    const piece = here.piece ?? virtualRoot(here.zone);
    const z = zoneOf(here.zone);
    const seg = z.segments.find((s) => s.id === piece);
    if (seg) seg.loadMbh += a.mbh;
    z.applianceIds.push(a.elementId);
    const fed = seg && seg.elementId ? seg : null;
    appliances.push({
      ...a,
      mbh: r(a.mbh, 3),
      zoneId: here.zone,
      pathFt: r(here.pathFt, 2),
      fromSourceFt: r(here.sourceFt, 2),
      feedPieceId: fed ? fed.id : null,
      feedElementId: fed ? fed.elementId : null,
      feedNominalIn: fed ? fed.nominalIn : null,
      feedMaterial: fed ? fed.material : null,
    });
  };
  // A part a load point stands for counts once: through the point.
  const attachedParts = new Set<string>();
  for (const n of nodes) {
    const lp = elements[n];
    if (lp?.kind === "load_point" && lp.attachedPartId) attachedParts.add(lp.attachedPartId);
  }

  for (const n of walk.order) {
    const here = attach.get(n);
    if (!here) continue;
    const el = elements[idOf(n)];
    const kids = walk.children.get(n) ?? [];
    if (!el) continue;
    if (el.kind === "load_point") {
      gasLoadPoint(elements, el, here, outlet, issues);
      continue;
    }
    if (el.kind === "part") {
      if (n === root) {
        for (const k of kids) attach.set(k, here);
        continue;
      }
      const through = kids.filter((k) => k.includes("#") && idOf(k) === el.id);
      const reg = through.length > 0 ? regulatorSettings(elements, el) : null;
      if (reg) {
        const next = startZone(reg, here);
        for (const k of kids) attach.set(k, next);
        continue;
      }
      for (const k of kids) attach.set(k, here);
      if (kids.length > 0 || attachedParts.has(el.id)) continue;
      const input = gasInputOf(elements, el, n.slice(n.indexOf("#") + 1), design);
      const type = elements[el.typeId];
      const description = type?.kind === "part_type" ? [type.definition.familyName, type.definition.typeName].filter(Boolean).join(", ") : "";
      outlet(here, {
        elementId: el.id,
        label: partLabelOf(elements, el),
        mark: el.mark ?? null,
        description,
        mbh: input.mbh,
        minInletInWc: partPressure(elements, el, ["min_inlet_in_wc", "min_inlet_pressure_in_wc", "min_inlet_pressure_psi"]),
        maxInletInWc: partPressure(elements, el, ["max_inlet_in_wc", "max_inlet_pressure_in_wc", "max_inlet_pressure_psi"]) ?? APPLIANCE_MAX_INLET_IN_WC,
        source: "part",
      });
      if (!input.found) issues.push({ code: "appliance_no_input", severity: "warning", elementId: el.id, zoneId: here.zone, message: `${partLabelOf(elements, el)} has no gas input; give its input (MBH) so the pipe to it is sized` });
      continue;
    }
    if (el.kind === "run_fitting") {
      // Elbows, reducers and tees off a fitting pass straight through; hosted items were placed when their host was walked.
      for (const k of kids) if (!attach.has(k)) attach.set(k, here);
      continue;
    }
    if (el.kind !== "run_segment") continue;
    const seg = el;
    const total = len3(sub3(seg.end, seg.start));
    const parentNode = walk.parent.get(n) ?? null;
    const entry = positionOn(elements, seg, parentNode, total);
    // A regulator's outlet feeds only what is past it: at the same point, a branch or a load leaves before it (on the inlet zone).
    const exits = kids.map((k) => ({ k, s: exitOn(elements, seg, k, total), regulates: isHostedRegulator(elements, seg, k) }));
    const material = seg.size.shape === "pipe" ? seg.size.material : null;
    const nominalIn = seg.size.shape === "pipe" ? Math.round((seg.size.nominalMm / 25.4) * 1000) / 1000 : null;
    let cut = 0;
    for (const forward of [true, false]) {
      const side = exits.filter((e) => (entry < total && e.s >= entry) === forward).sort((a, b) => (Math.abs(a.s - b.s) <= 0.5 ? Number(a.regulates) - Number(b.regulates) : forward ? a.s - b.s : b.s - a.s));
      let pos = entry;
      let cur: Attach = here;
      for (const e of side) {
        const lenMm = Math.abs(e.s - pos);
        if (lenMm > 0.5) {
          const z = zoneOf(cur.zone);
          const id = cut === 0 && exits.length <= 1 ? seg.id : `${seg.id}@${cut}`;
          cut += 1;
          const pathFt = cur.pathFt + lenMm / MM_PER_FT;
          const sourceFt = cur.sourceFt + lenMm / MM_PER_FT;
          z.segments.push({ id, elementId: seg.id, parent: cur.piece, lengthFt: lenMm / MM_PER_FT, loadMbh: 0, label: runLabel(elements, seg), material, nominalIn, pathFt, sourceFt });
          cur = { zone: cur.zone, piece: id, pathFt, sourceFt };
          pos = e.s;
        }
        const hosted = elements[idOf(e.k)];
        const reg = hosted?.kind === "run_fitting" && hosted.host?.segmentId === seg.id ? regulatorSettings(elements, hosted) : null;
        if (reg) {
          attach.set(e.k, cur);
          cur = startZone(reg, cur);
          continue;
        }
        attach.set(e.k, cur);
      }
    }
  }

  // What a person calls each regulator: its tag when the id is one (LR-1), else the one appliance it serves, else a number.
  let unnamed = 0;
  for (const [id, reg] of regulators) {
    if (elements[id]?.kind === "part" || /^[A-Za-z]{1,5}-?[A-Za-z0-9]{1,6}$/.test(id)) continue;
    const z = zoneOf(reg.zoneId);
    const only = z.regulatorIds.length === 0 && z.applianceIds.length === 1 ? appliances.find((a) => a.elementId === z.applianceIds[0]) : undefined;
    const name = only ? `${ROLE_WORD[reg.settings.role]} for ${only.mark ?? only.label}` : `${ROLE_WORD[reg.settings.role]} ${++unnamed}`;
    regulators.set(id, { ...reg, settings: { ...reg.settings, label: name } });
    z.label = `${name}, ${pressureLabel(reg.settings.outletInWc)}`;
  }

  // Each regulator's downstream input is a load on the zone above, at the pipe it ends.
  const zoneTotal = new Map<string, number>();
  const totalOf = (zoneId: string, seen: Set<string> = new Set()): number => {
    const known = zoneTotal.get(zoneId);
    if (known !== undefined) return known;
    if (seen.has(zoneId)) return 0;
    seen.add(zoneId);
    const z = zoneOf(zoneId);
    const own = appliances.filter((a) => a.zoneId === zoneId).reduce((s, a) => s + a.mbh, 0);
    const below = z.regulatorIds.reduce((s, id) => {
      const reg = regulators.get(id);
      return s + (reg ? totalOf(reg.zoneId, seen) : 0);
    }, 0);
    zoneTotal.set(zoneId, own + below);
    return own + below;
  };
  for (const [, reg] of regulators) {
    const load = totalOf(reg.zoneId);
    const up = zoneOf(reg.upstreamZoneId);
    const piece = up.segments.find((s) => s.id === reg.upstreamPiece);
    if (piece) piece.loadMbh += load;
  }

  const out: GasZone[] = [];
  for (const z of zones.values()) {
    // A zone whose pipe splits right at its start gets a virtual root so its tree has one start.
    const roots = z.segments.filter((s) => s.parent === null);
    if (roots.length > 1) {
      const id = virtualRoot(z.id);
      for (const s of z.segments) if (s.parent === null && s.id !== id) s.parent = id;
    }
    const hasLoadBelow = new Map<string, boolean>();
    const childrenOf = new Map<string, string[]>();
    for (const s of z.segments) if (s.parent) childrenOf.set(s.parent, [...(childrenOf.get(s.parent) ?? []), s.id]);
    const below = (id: string): boolean => {
      const known = hasLoadBelow.get(id);
      if (known !== undefined) return known;
      const s = z.segments.find((x) => x.id === id);
      const v = (s?.loadMbh ?? 0) > 0 || (childrenOf.get(id) ?? []).some(below);
      hasLoadBelow.set(id, v);
      return v;
    };
    // Pipe that serves nothing yet (an open end) doesn't set the zone's longest length.
    const live = z.segments.filter((s) => below(s.id));
    const longest = live.reduce((m, s) => Math.max(m, s.pathFt), 0);
    const byMaterial = new Map<PipeMaterial, number>();
    for (const s of live) if (s.material) byMaterial.set(s.material, (byMaterial.get(s.material) ?? 0) + s.lengthFt);
    const material = [...byMaterial.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (byMaterial.size > 1) issues.push({ code: "mixed_material", severity: "warning", elementId: z.regulatorId, zoneId: z.id, message: `${z.label} mixes ${[...byMaterial.keys()].join(" and ")} pipe; it is sized on the ${material} table. Size the other material's pipe from its own table` });
    out.push({
      id: z.id,
      label: z.label,
      regulatorId: z.regulatorId,
      inletInWc: z.inletInWc,
      allowableDropInWc: z.allowableDropInWc,
      highPressure: z.inletInWc >= HIGH_PRESSURE_IN_WC - 1e-6,
      segments: live.map((s) => ({ id: s.id, elementId: s.elementId, parent: s.parent, lengthFt: r(s.lengthFt, 3), loadMbh: r(s.loadMbh, 3), label: s.label, material: s.material, nominalIn: s.nominalIn, fromSourceFt: r(s.sourceFt, 2) })),
      applianceIds: z.applianceIds,
      regulatorIds: z.regulatorIds,
      totalMbh: r(totalOf(z.id), 3),
      longestFt: r(longest, 2),
      material,
    });
  }

  const regOut: GasRegulator[] = [...regulators.values()].map((g) => ({ ...g.settings, upstreamZoneId: g.upstreamZoneId, zoneId: g.zoneId, loadMbh: r(totalOf(g.zoneId), 3) }));
  const zoneById = new Map(out.map((z) => [z.id, z]));
  for (const g of regOut) {
    const up = zoneById.get(g.upstreamZoneId);
    if (up && g.outletInWc >= up.inletInWc - 1e-6) issues.push({ code: "regulator_raises_pressure", severity: "error", elementId: g.elementId, zoneId: g.upstreamZoneId, message: `${g.label} is set to ${pressureLabel(g.outletInWc)} but is fed at ${pressureLabel(up.inletInWc)}; a regulator only steps pressure down. Lower its outlet setting or raise the zone above it` });
    if (g.capacityMbh !== null && g.loadMbh > g.capacityMbh + 1e-6) issues.push({ code: "regulator_over_capacity", severity: "error", elementId: g.elementId, zoneId: g.zoneId, message: `${g.label} serves ${r(g.loadMbh, 1)} MBH, more than its rated ${g.capacityMbh} MBH; pick a larger regulator` });
  }
  const finalAppliances: GasAppliance[] = appliances.map((a) => ({ ...a, regulatorId: zoneById.get(a.zoneId)?.regulatorId ?? null }));
  for (const a of finalAppliances) {
    const z = zoneById.get(a.zoneId);
    if (!z) continue;
    if (z.inletInWc > a.maxInletInWc + 1e-6) {
      issues.push({ code: "regulator_missing", severity: "error", elementId: a.elementId, zoneId: z.id, message: `${a.label} is on the ${pressureLabel(z.inletInWc)} zone (${z.label}) but takes at most ${pressureLabel(a.maxInletInWc)}; put a line or appliance regulator between them` });
    } else if (a.minInletInWc !== null && z.inletInWc - z.allowableDropInWc < a.minInletInWc - 1e-6) {
      issues.push({ code: "zone_below_appliance_minimum", severity: "error", elementId: a.elementId, zoneId: z.id, message: `${a.label} needs ${pressureLabel(a.minInletInWc)} at its inlet, but ${z.label} may fall to ${pressureLabel(z.inletInWc - z.allowableDropInWc)} (it allows ${pressureLabel(z.allowableDropInWc)} of drop); raise the zone's pressure or allow less drop` });
    }
  }
  const sourceId = (rootEl?.id ?? null) as ElementId | null;
  return {
    systemId: system.id,
    systemName: system.name,
    ...props,
    method,
    sizingMode,
    sourceId,
    sourceLabel: labelOf(elements, root),
    zones: out,
    appliances: finalAppliances,
    regulators: regOut,
    totalMbh: r(totalOf(sourceZone.id), 3),
    issues,
    memberIds,
  };
}

function isHostedRegulator(elements: Elements, seg: RunSegment, n: RunGraphNode): boolean {
  const el = elements[idOf(n)];
  return el?.kind === "run_fitting" && el.host?.segmentId === seg.id && regulatorSettings(elements, el) !== null;
}

/** Where along a segment a walked neighbour leaves it: a load point sits on the end it names. */
function exitOn(elements: Elements, seg: RunSegment, n: RunGraphNode, total: number): number {
  const el = elements[n];
  const at = el?.kind === "load_point" ? runEndOf(el) : null;
  if (at && at.elementId === seg.id) return at.port === "end" ? total : 0;
  return positionOn(elements, seg, n, total);
}

/**
 * A load point on a gas pipe end is an outlet like an appliance: its gas
 * input (MBH) from its values or its connection type, and its minimum inlet
 * pressure. A point with no input is reported, not guessed.
 */
function gasLoadPoint(elements: Elements, lp: LoadPointElement, here: Attach, outlet: (here: Attach, a: { elementId: ElementId; label: string; mark: string | null; description: string; mbh: number; minInletInWc: number | null; maxInletInWc: number; source: GasAppliance["source"] }) => void, issues: GasIssue[]): void {
  const q = loadPointQuantities(elements, lp);
  const label = loadPointLabel(elements, lp);
  const description = connectionTypeOfLoadPoint(elements, lp)?.description ?? "";
  outlet(here, {
    elementId: lp.id,
    label,
    mark: lp.mark || lp.connectionType || null,
    description,
    mbh: q.mbh ?? 0,
    minInletInWc: q.min_inlet_pressure && q.min_inlet_pressure > 0 ? convert(q.min_inlet_pressure, QUANTITY_BINDINGS.min_inlet_pressure.unit, "in_wc") : null,
    maxInletInWc: APPLIANCE_MAX_INLET_IN_WC,
    source: "load_point",
  });
  if (q.mbh === undefined) issues.push({ code: "appliance_no_input", severity: "warning", elementId: lp.id, zoneId: here.zone, message: `${label} has no gas input; give its input (MBH) on the point or its connection type so the pipe to it is sized` });
}

function anchorOf(elements: Elements, system: MepSystem, hint: string | undefined): ElementId | null {
  const isMember = (id: string | undefined) => {
    const el = id ? elements[id] : undefined;
    return (el?.kind === "run_segment" || el?.kind === "run_fitting") && el.systemId === system.id;
  };
  if (hint && isMember(hint)) return hint as ElementId;
  if (system.entryId && isMember(system.entryId)) return system.entryId;
  for (const id in elements) {
    const el = elements[id];
    if ((el?.kind === "run_segment" || el?.kind === "run_fitting") && el.systemId === system.id) return el.id;
  }
  return null;
}

function labelOf(elements: Elements, n: RunGraphNode): string {
  const el = elements[idOf(n)];
  if (el?.kind === "part") return partLabelOf(elements, el);
  if (el?.kind === "run_segment" || el?.kind === "run_fitting") return runLabel(elements, el as RunSegment | RunFitting);
  return n;
}

/** Which zone each drawn pipe is in (a pipe cut by a regulator is in both). */
export function zonesByElement(network: GasNetwork): ReadonlyMap<ElementId, readonly string[]> {
  const out = new Map<ElementId, string[]>();
  for (const z of network.zones) for (const s of z.segments) if (s.elementId) out.set(s.elementId, [...new Set([...(out.get(s.elementId) ?? []), z.id])]);
  return out;
}

