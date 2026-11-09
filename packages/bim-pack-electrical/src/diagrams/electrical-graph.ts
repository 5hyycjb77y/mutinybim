import { pushTo, linksFedFrom, type ServiceLink, formatFieldTemplate, resolveField, type OneLineTextLine, type BimElement, type ElementId, type PartInstance, type PartTypeElement, DEFAULT_DIAGRAM_LABELS, type DiagramHints, type DiagramLabelKind, type DiagramEdge, type DiagramGraph, type DiagramNode, type DiagramWarning } from "@permitzip/bim-kernel";
import { fedFromTextMismatch } from "../connections/fed-from";
import { faultCurrentAt } from "../calc/fault-current";
import type { OneLineEquipmentKind as OneLineKind, OneLineProtectiveDevice as OneLineDevice } from "./one-line-layout";
import { distributionOf, electricalConnectorOf, electricalName, type DistributionInfo } from "../connections/systems";
import { voltageSystemText } from "../fields/electrical-resolver";
import { feederTypeInfoOf } from "./feeder-types";

/**
 * The electrical distribution graph, read from served-from links: every piece
 * of electrical equipment, hung under the equipment whose feeder serves it.
 * Nothing is copied: names, ratings, systems, enclosures, breakers and feeder
 * types are read through the field resolver each time, so the diagram is the
 * model. Shared by the one-line and the electrical riser.
 */

type Elements = Readonly<Record<string, BimElement>>;

const KIND_WORDS: ReadonlyArray<readonly [RegExp, OneLineKind]> = [
  [/utility/i, "utility"],
  [/\bct\b|current transformer|ct cabinet/i, "ct_cabinet"],
  [/meter/i, "meter"],
  [/transfer switch|\bats\b/i, "ats"],
  [/generator|genset/i, "generator"],
  [/fire pump controller|jockey pump controller|controller/i, "equipment"],
  [/fused/i, "fused_disconnect"],
  [/disconnect|safety switch/i, "disconnect"],
  [/variable frequency|\bvfd\b/i, "vfd"],
  [/\bups\b|uninterruptible/i, "ups"],
  [/motor control|\bmcc\b/i, "mcc"],
  [/tap box|tap can|wireway|gutter|splice/i, "switchboard"],
];

const BUS: ReadonlySet<OneLineKind> = new Set(["switchboard", "panelboard", "mcc"]);
/** Equipment that may start a service (no warning when nothing feeds it). */
const SERVICE_START: ReadonlySet<string> = new Set<OneLineKind>(["utility", "meter", "ct_cabinet", "switchboard", "generator"]);

function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

/** How a piece of electrical equipment draws on a one-line: an explicit `one_line_kind` value, its type's name, else what it distributes. */
export function oneLineKindOf(elements: Elements, part: PartInstance, info: DistributionInfo | null): OneLineKind {
  const explicit = resolveField(elements, part.id, "param.one_line_kind").value;
  if (typeof explicit === "string") {
    const k = explicit.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const known: readonly OneLineKind[] = ["utility", "meter", "ct_cabinet", "switchboard", "panelboard", "mcc", "transformer", "generator", "ats", "disconnect", "fused_disconnect", "vfd", "ups", "motor", "equipment"];
    const hit = known.find((x) => x === k);
    if (hit) return hit;
  }
  const type = typeOf(elements, part);
  const words = type ? `${type.definition.familyName} ${type.definition.typeName}` : "";
  const byWords = KIND_WORDS.find(([re]) => re.test(words))?.[1];
  if (byWords) return byWords;
  if (info?.kind === "transformer") return "transformer";
  if (info?.kind === "switchboard") return "switchboard";
  if (info?.kind === "panelboard") return "panelboard";
  return type?.definition.category === "mechanical_equipment" ? "motor" : "equipment";
}

function labelKindOf(kind: OneLineKind): DiagramLabelKind {
  if (BUS.has(kind)) return "bus";
  return kind === "transformer" ? "transformer" : "equipment";
}

function textLines(elements: Elements, elementId: string, templates: readonly string[]): OneLineTextLine[] {
  const out: OneLineTextLine[] = [];
  templates.forEach((t, i) => {
    const line = formatFieldTemplate(elements, elementId, t).text.toUpperCase();
    if (line) out.push({ text: line, ...(i === 0 ? { bold: true } : {}) });
  });
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const NOT_PLACED_MARK = "NOT PLACED";

/** A planned part is on the one-line like any other (it is the model), drawn dashed and marked so nobody mistakes it for drawn gear. */
function plannedOf(part: PartInstance): { readonly levelId: string | null; readonly extra: readonly OneLineTextLine[]; readonly flag: { readonly planned?: true } } {
  if (part.planned === undefined) return { levelId: part.levelId, extra: [], flag: {} };
  return { levelId: part.planned.levelHint ?? null, extra: [{ text: NOT_PLACED_MARK }], flag: { planned: true } };
}

function feedEdge(elements: Elements, link: ServiceLink, fedId: string, parentKind: OneLineKind, schematic: boolean): DiagramEdge {
  const rating = link.electrical?.ratingA;
  const device: OneLineDevice = rating !== undefined ? "breaker" : BUS.has(parentKind) && parentKind !== "switchboard" ? "breaker" : "none";
  const breaker = resolveField(elements, fedId, "supply.breaker").text;
  const conductors = resolveField(elements, fedId, "supply.conductors").text;
  const mark = link.electrical?.feederType;
  const catalog = mark ? feederTypeInfoOf(elements, mark) : null;
  return {
    linkId: link.id,
    device,
    ...(breaker ? { deviceLabel: breaker } : {}),
    ...(!schematic && (conductors || catalog?.conductors) ? { conductors: conductors || (catalog?.conductors ?? "") } : {}),
    ...(!schematic && link.electrical?.lengthFt !== undefined ? { lengthFt: link.electrical.lengthFt } : {}),
    ...(mark ? { typeMark: mark } : {}),
  };
}

interface Candidate {
  readonly part: PartInstance;
  readonly info: DistributionInfo | null;
  readonly kind: OneLineKind;
  readonly name: string;
  /** The feeder serving it and from what, when the source is also electrical equipment. */
  readonly supply: ServiceLink | null;
  readonly emergency: ServiceLink | null;
}

/** A branch-circuit load big enough to draw (a motor or unit): mechanical equipment, or a device of two or more poles. */
function drawnLoad(elements: Elements, part: PartInstance, connector: string): boolean {
  const type = typeOf(elements, part);
  if (!type) return false;
  if (type.definition.category === "mechanical_equipment") return true;
  if (type.definition.category === "electrical_equipment") return true;
  return (electricalConnectorOf(elements, part, connector)?.poles ?? 1) >= 2;
}

/** The electrical distribution as a diagram graph. */
/** Electrical's own switches on a one-line view (beside the kernel's diagram hints). */
export interface ElectricalDiagramHints extends DiagramHints {
  /** Print the available fault current at each bus ("AFC 22 kA"). Absent: off. */
  readonly faultCurrent?: boolean;
}

/** The fault-current line a bus prints: "AFC 22 kA", "AFC 14.3 kA"; never blank (says what is missing). */
export function afcLine(elements: Elements, partId: string): string | null {
  const node = faultCurrentAt(elements, partId);
  if (!node) return null;
  if (node.availableA !== null) {
    const ka = node.availableA / 1000;
    return `AFC ${ka >= 10 ? Math.round(ka) : Math.round(ka * 10) / 10} kA`;
  }
  // No value anywhere upstream: the service needs the utility's figure; otherwise a step on the way is missing.
  return node.trail.length === 0 ? "AFC: utility value needed" : "AFC: not known (see Fault current)";
}

export function electricalDiagramGraph(elements: Elements, hints: ElectricalDiagramHints = {}): DiagramGraph {
  const detail = hints.detail ?? "full";
  const schematic = detail === "schematic";
  const reads = new Set<ElementId>();
  const candidates = new Map<string, Candidate>();
  for (const el of Object.values(elements)) {
    if (el.kind !== "part") continue;
    const type = typeOf(elements, el);
    if (type?.definition.category !== "electrical_equipment") continue;
    const info = distributionOf(elements, el);
    const kind = oneLineKindOf(elements, el, info);
    const served = Object.entries(el.served ?? {}).sort(([a], [b]) => cmp(a, b));
    let supply: ServiceLink | null = null;
    let emergency: ServiceLink | null = null;
    for (const [connector, linkId] of served) {
      const link = elements[linkId];
      if (link?.kind !== "service_link" || link.trade !== "electrical") continue;
      if (/emerg|alternate|standby/i.test(connector)) emergency = emergency ?? link;
      else if (connector === info?.input || supply === null) supply = connector === info?.input ? link : (supply ?? link);
    }
    candidates.set(el.id, { part: el, info, kind, name: electricalName(elements, el), supply, emergency });
  }

  const hidden = new Set(hints.hidden ?? []);
  const childrenOf = new Map<string, Candidate[]>();
  const parentOf = new Map<string, string>();
  for (const c of candidates.values()) {
    const src = c.supply?.source.elementId;
    if (src && candidates.has(src) && src !== c.part.id) {
      parentOf.set(c.part.id, src);
      pushTo(childrenOf, src, c);
    }
  }
  const positionKey = (c: Candidate) => Math.min(...(c.supply?.source.positions.length ? c.supply.source.positions : [Number.MAX_SAFE_INTEGER]));
  // Feeds from equipment with no numbered positions (a tap box) have no slot to order by: the normal service continues first, separately metered services after.
  const ownService = (c: Candidate) => {
    const v = resolveField(elements, c.part.id, "service").value;
    return typeof v === "string" && v.trim() !== "" ? 1 : 0;
  };
  const ordered = (parentId: string, kids: readonly Candidate[]): Candidate[] => {
    const base = [...kids].sort((a, b) => positionKey(a) - positionKey(b) || ownService(a) - ownService(b) || cmp(a.name, b.name) || cmp(a.part.id, b.part.id));
    const wanted = hints.order?.[parentId];
    if (!wanted) return base;
    const rank = new Map(wanted.map((id, i) => [id, i]));
    return [...base].sort((a, b) => (rank.get(a.part.id) ?? wanted.length) - (rank.get(b.part.id) ?? wanted.length) || base.indexOf(a) - base.indexOf(b));
  };

  const warnings: DiagramWarning[] = [];
  const labels = (kind: DiagramLabelKind) => hints.labels?.[kind] ?? DEFAULT_DIAGRAM_LABELS[detail][kind];
  const visited = new Set<string>();

  const loadsOf = (c: Candidate, service: string): DiagramNode[] => {
    if (!hints.showLoads || !BUS.has(c.kind)) return [];
    const out: DiagramNode[] = [];
    for (const link of linksFedFrom(elements, c.part.id)) {
      if (link.role !== "branch") continue;
      for (const m of link.members) {
        const member = elements[m.elementId];
        if (member?.kind !== "part" || candidates.has(member.id) || hidden.has(member.id) || visited.has(member.id) || !drawnLoad(elements, member, m.connector)) continue;
        visited.add(member.id);
        reads.add(link.id);
        reads.add(member.id);
        const type = typeOf(elements, member);
        const where = plannedOf(member);
        const rating = link.electrical?.ratingA;
        const poles = link.source.positions.length;
        const circuit = poles > 0 ? `${c.name}-${[...link.source.positions].sort((a, b) => a - b).join(",")}` : "";
        out.push({
          id: member.id,
          elementId: member.id,
          kind: type?.definition.category === "mechanical_equipment" ? "motor" : "equipment",
          labelKind: "equipment",
          name: electricalName(elements, member),
          lines: [{ text: (member.mark || electricalName(elements, member)).toUpperCase(), bold: true }, ...(circuit ? [{ text: circuit.toUpperCase() }] : []), ...where.extra],
          levelId: where.levelId,
          ...where.flag,
          service,
          feed: { linkId: link.id, device: "breaker", ...(rating !== undefined ? { deviceLabel: `${rating}A${poles > 0 ? `/${poles}P` : ""}` } : {}) },
          children: [],
        });
      }
    }
    return out.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
  };

  const build = (c: Candidate, parent: Candidate | null, parentService: string): DiagramNode | null => {
    if (hidden.has(c.part.id) || visited.has(c.part.id)) return null;
    visited.add(c.part.id);
    reads.add(c.part.id);
    reads.add(c.part.typeId);
    if (c.supply) reads.add(c.supply.id);
    const own = resolveField(elements, c.part.id, "service").value;
    const service = typeof own === "string" && own ? own : parentService;
    const labelKind = labelKindOf(c.kind);
    const where = plannedOf(c.part);
    const afc = hints.faultCurrent === true && c.info && c.info.kind !== "transformer" ? afcLine(elements, c.part.id) : null;
    const lines = [...textLines(elements, c.part.id, labels(labelKind)), ...(afc ? [{ text: afc }] : []), ...where.extra];
    // Bus against the breaker that feeds it (V3: change one, forget the other).
    if (c.supply && parent && c.info && c.info.kind !== "transformer" && c.info.busA !== null) {
      const rating = c.supply.electrical?.ratingA;
      if (rating !== undefined && rating < c.info.busA) {
        warnings.push({ kind: "bus_above_feeding_breaker", elementId: c.part.id, short: `${c.info.busA}A BUS FED BY ${rating}A BREAKER`, message: `${c.name}'s ${c.info.busA} A bus is fed by a ${rating} A breaker in ${parent.name}; most of the time the breaker matches the bus. Raise the breaker, or keep it and note why.` });
      } else if (rating !== undefined && rating > c.info.busA) {
        warnings.push({ kind: "breaker_above_bus", elementId: c.part.id, short: `${rating}A BREAKER ON ${c.info.busA}A BUS`, message: `${c.name}'s ${c.info.busA} A bus is fed by a ${rating} A breaker in ${parent.name}, larger than the bus it protects. Lower the breaker or raise the bus.` });
      }
    }
    const mismatch = c.supply && parent ? fedFromTextMismatch(elements, c.part.id) : null;
    if (mismatch) {
      warnings.push({ kind: "fed_from_text_mismatch", elementId: c.part.id, short: `FED FROM TEXT SAYS ${mismatch.typed.toUpperCase()}`, message: `${c.name}'s typed Fed from says "${mismatch.typed}", but its feeder comes from ${mismatch.linkedSourceName}. Schedules and this diagram show ${mismatch.linkedSourceName}; clear the typed text or re-feed ${c.name}.` });
    }
    if (!parent && !SERVICE_START.has(c.kind) && c.kind !== "transformer") {
      warnings.push({ kind: "not_fed", elementId: c.part.id, short: "NOT FED", message: `${c.name} is not fed from anything yet; feed it from a panel or switchboard so it shows under what serves it.` });
    }
    const kids = ordered(c.part.id, childrenOf.get(c.part.id) ?? []).flatMap((k) => {
      const n = build(k, c, service);
      return n ? [n] : [];
    });
    const loads = loadsOf(c, service);
    const future = Array.from({ length: BUS.has(c.kind) ? (hints.futureSpaces?.[c.part.id] ?? 0) : 0 }, (_, i): DiagramNode => ({
      id: `future:${c.part.id}:${i + 1}`,
      elementId: null,
      kind: "equipment",
      labelKind: "equipment",
      name: "Space",
      lines: [{ text: "SPACE FOR FUTURE", bold: true }],
      levelId: where.levelId,
      service,
      feed: { linkId: null, device: "breaker" },
      children: [],
      placeholder: true,
    }));
    let emergency: DiagramNode | undefined;
    if (c.kind === "ats" && c.emergency) {
      const src = candidates.get(c.emergency.source.elementId);
      if (src && (src.kind === "generator" || src.kind === "utility") && (childrenOf.get(src.part.id) ?? []).length === 0 && !visited.has(src.part.id) && !hidden.has(src.part.id)) {
        visited.add(src.part.id);
        reads.add(src.part.id);
        reads.add(c.emergency.id);
        emergency = {
          id: src.part.id,
          elementId: src.part.id,
          kind: src.kind,
          labelKind: "equipment",
          name: src.name,
          lines: [...textLines(elements, src.part.id, labels("equipment")), ...plannedOf(src.part).extra],
          levelId: plannedOf(src.part).levelId,
          ...plannedOf(src.part).flag,
          service: "emergency",
          feed: feedEdge(elements, c.emergency, c.part.id, src.kind, schematic),
          children: [],
        };
      }
    }
    return {
      id: c.part.id,
      elementId: c.part.id,
      kind: (c.kind === "motor" || c.kind === "equipment") && kids.length + loads.length > 0 ? "panelboard" : c.kind,
      labelKind,
      name: c.name,
      lines,
      levelId: where.levelId,
      service,
      ...where.flag,
      ...(c.supply && parent ? { feed: feedEdge(elements, c.supply, c.part.id, parent.kind, schematic) } : {}),
      children: [...kids, ...loads, ...future],
      ...(emergency ? { emergency } : {}),
      ...(BUS.has(c.kind) && c.info?.mainA !== null && c.info?.mainA !== undefined ? { mainBreaker: true } : {}),
    };
  };

  const rootCandidates = [...candidates.values()].filter((c) => !parentOf.has(c.part.id)).sort((a, b) => cmp(a.name, b.name) || cmp(a.part.id, b.part.id));
  const rootOrder = hints.order?.["$roots"];
  if (rootOrder) {
    const rank = new Map(rootOrder.map((id, i) => [id, i]));
    rootCandidates.sort((a, b) => (rank.get(a.part.id) ?? rootOrder.length) - (rank.get(b.part.id) ?? rootOrder.length));
  }
  // An emergency source drawn beside its transfer switch is not a root of its own.
  const emergencyOnly = new Set([...candidates.values()].flatMap((c) => (c.kind === "ats" && c.emergency ? [c.emergency.source.elementId] : [])));
  const wantRoots = hints.roots ? new Set(hints.roots) : null;
  const roots: DiagramNode[] = [];
  for (const c of rootCandidates) {
    if (wantRoots && !wantRoots.has(c.part.id)) continue;
    if (emergencyOnly.has(c.part.id) && (childrenOf.get(c.part.id) ?? []).length === 0) continue;
    const n = build(c, null, "normal");
    if (n) roots.push(n);
  }
  // Equipment fed in a loop never reaches a root: draw it so it is seen, and say why.
  for (const c of [...candidates.values()].sort((a, b) => cmp(a.part.id, b.part.id))) {
    if (visited.has(c.part.id) || hidden.has(c.part.id) || wantRoots || emergencyOnly.has(c.part.id)) continue;
    warnings.push({ kind: "loop", elementId: c.part.id, short: "FEEDER LOOP", message: `${c.name} is fed in a loop (it is, through its feeders, fed from itself); cut one feeder.` });
    const n = build(c, null, "normal");
    if (n) roots.push(n);
  }
  for (const w of warnings) reads.add(w.elementId);
  return { roots, warnings, reads: [...reads].sort() };
}

/**
 * The utility source drawn above a service root: named for the system it
 * supplies. Only above equipment that starts a service (meter, CT cabinet,
 * switchboard, a service transformer): a panel nothing feeds is NOT FED, and
 * drawing a utility above it would show a service that does not exist.
 */
export function utilityNodeFor(elements: Elements, root: DiagramNode): DiagramNode | null {
  if (root.kind === "utility" || root.kind === "generator" || !root.elementId) return null;
  if (!SERVICE_START.has(root.kind) && root.kind !== "transformer") return null;
  const el = elements[root.elementId];
  const info = el?.kind === "part" ? distributionOf(elements, el) : null;
  const system = info ? `${voltageSystemText(info.supply)} ${info.supply.phases}PH ${info.supply.wires}W` : "";
  return {
    id: `utility:${root.id}`,
    elementId: null,
    kind: "utility",
    labelKind: "equipment",
    name: "Utility",
    lines: [{ text: root.service !== "normal" ? `UTILITY (${root.service.toUpperCase()})` : "UTILITY", bold: true }, ...(system ? [{ text: system }] : [])],
    levelId: root.levelId,
    service: root.service,
    children: [{ ...root, feed: root.feed ?? { linkId: null, device: "none" } }],
  };
}