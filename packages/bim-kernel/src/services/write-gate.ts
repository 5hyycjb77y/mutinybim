import { refuse, registerEditHook } from "../command-core";
import { stepAllowed, type SchemaStep } from "../schema-version/registry";
import { legacyLinkShape, type ServiceLink } from "../connections/types";
import type { PartConnector } from "../parts";
import type { BimElement, ElementId } from "../types";
import { activeServiceRegistry, connectorDomainIds, isKnownLoadService, isKnownSystemKind, loadServiceIds, serviceLabel, serviceWriteFeature, systemKindIds, type ServiceRegistry } from "./registry";
import { peerReads } from "../elements/feature";
import { CONNECTOR_END_TYPES_FEATURE, LINKS_DESIGN_FEATURE, PARTS_CONNECTOR_VALUES_FEATURE } from "./types";
import { BUILTIN_CONNECTOR_IDS } from "./builtin";
import { GEOMETRY_SOLID_PROGRAM_2_FEATURE, isPartModel2 } from "../part-model/schema-2";

/**
 * Writers validate services at command time (MIGRATION-PLAN §3, §6
 * "Services"): every command's `finish` runs this hook over the records it
 * touched. A service id a record did not carry before must be a row of the
 * registry, and a row new to that view (grease waste as a system) is written
 * only when the peer advertises the row's feature, through the same upgrade
 * policy gated record steps use (`schema-version/registry.ts`). Ids a record
 * already carried pass untouched, so a newer peer's kind round-trips.
 *
 * Undo restores stored records exactly and is decided with no upgrades; the
 * gate stands aside for it too.
 */

/** Probe the upgrade policy for one feature through its public step check. A null feature answers "not inside undo". */
function probe(feature: string | null): SchemaStep {
  return { kind: "mep_system", from: 1, to: 2, name: `services:${feature ?? "ungated"}`, feature };
}

/** Whether the command being decided may write a shape gated on `feature`: the server advertised it (client) or every peer did (server). */
export function peerReadsServiceFeature(feature: string): boolean {
  return stepAllowed(probe(feature));
}

function decidingUndo(): boolean {
  return !stepAllowed(probe(null));
}

let gateRegistry: ServiceRegistry | null = null;

/** The registry writes are checked against: a firm's when a host wrapped the command, else the model's pack set in force (built-ins outside any). */
const registryInForce = (): ServiceRegistry => gateRegistry ?? activeServiceRegistry();

/** Decide `fn` against a firm's registry (`withFirmServices`), so its `firm:` rows are writable. */
export function withServiceRegistry<T>(registry: ServiceRegistry, fn: () => T): T {
  const previous = gateRegistry;
  gateRegistry = registry;
  try {
    return fn();
  } finally {
    gateRegistry = previous;
  }
}

type View = "system" | "load";

function servicesOf(el: BimElement | undefined, out: Map<string, View>): void {
  if (!el) return;
  switch (el.kind) {
    case "mep_system":
      out.set(el.systemKind, "system");
      return;
    case "part_type":
      for (const c of el.definition.connectors) out.set(c.systemKind, "system");
      return;
    case "load_point":
      if (el.service !== undefined) out.set(el.service, "load");
      return;
    case "service_catalog": {
      // Add-on catalog record types (round 12): read their system lists by name, tolerant of shape.
      const e: object = el.entry;
      const type = "type" in e ? e.type : undefined;
      if (type === "pipe_type" && "systemKinds" in e) for (const k of stringsOf(e.systemKinds)) out.set(k, "system");
      if (type === "plumbing_settings" && "pipeInsulation" in e && Array.isArray(e.pipeInsulation)) {
        for (const row of e.pipeInsulation) if (typeof row === "object" && row !== null && "systemKinds" in row) for (const k of stringsOf(row.systemKinds)) out.set(k, "system");
      }
      return;
    }
    default:
      return;
  }
}

function recordName(el: BimElement): string {
  if (el.kind === "mep_system") return el.name;
  if (el.kind === "part_type") return `${el.definition.familyName} ${el.definition.typeName}`;
  if (el.kind === "load_point") return el.mark?.trim() || el.id;
  if (el.kind === "service_catalog") {
    const e: object = el.entry;
    const type = "type" in e ? e.type : undefined;
    if (type === "pipe_type" || type === "plumbing_settings") return type === "pipe_type" ? `Pipe type ${"name" in e && typeof e.name === "string" ? e.name : el.id}` : "The project's plumbing settings";
  }
  return el.id;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** What an older server already stores that is closest to a new row, for the refusal's advice; absent: no honest stand-in. */
const OLDER_STAND_IN: Readonly<Record<string, string>> = {
  grease_waste: "sanitary",
  indirect_waste: "sanitary",
  chilled_water_supply: "hydronic supply",
  chilled_water_return: "hydronic return",
  heating_water_supply: "hydronic supply",
  heating_water_return: "hydronic return",
};

/** `"a", "b" or "c"` from the services this registry holds in a view: the choices a refusal offers are the ones a write would accept. Quoted, since a label may hold a comma ("fire protection, wet"). */
function choicesIn(ids: readonly string[], registry: ServiceRegistry): string | null {
  const labels = [...new Set(ids.map((id) => `"${serviceLabel(id, registry).toLowerCase()}"`))];
  if (labels.length === 0) return null;
  return labels.length === 1 ? (labels[0] ?? null) : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** Why a record may not newly carry `id` in this view, in plain words; null when it may. */
export function serviceWriteRefusal(id: string, view: View, recordWords: string, registry: ServiceRegistry = registryInForce()): string | null {
  const known = view === "system" ? isKnownSystemKind(id, registry) : isKnownLoadService(id, registry);
  const label = serviceLabel(id, registry);
  if (!known) {
    const choices = choicesIn(view === "system" ? systemKindIds(registry) : loadServiceIds(registry), registry);
    const next = choices ? `Choose ${choices}` : "None are on for this model; turn on the add-on that adds them";
    return view === "system"
      ? `${recordWords} can't carry "${label}": it isn't a system this version of the model knows. ${next}`
      : `${recordWords} can't need "${label}": it isn't a load service this version of the model knows. ${next}`;
  }
  const feature = serviceWriteFeature(id, view, registry);
  if (feature !== null && !peerReadsServiceFeature(feature)) {
    const standIn = OLDER_STAND_IN[id];
    return `${label} can't be saved yet: the model server this model is open on is an older version that doesn't store ${label.toLowerCase()} systems. ${standIn ? `Draw it as ${standIn} for now, or try again` : "Try again"} once the server is updated`;
  }
  return null;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A part type's connectors this command added or changed: their domain must be drawable, and new `values` need the peer to read them. */
function checkConnectors(next: Extract<BimElement, { kind: "part_type" }>, prior: BimElement | undefined): void {
  const before = new Map<string, PartConnector>(prior?.kind === "part_type" ? prior.definition.connectors.map((c) => [c.id, c]) : []);
  // The kernel's own connector domains draw whichever add-ons are on; a row may add a domain of its own.
  const domains: readonly string[] = [...BUILTIN_CONNECTOR_IDS, ...connectorDomainIds(registryInForce())];
  const name = recordName(next);
  for (const c of next.definition.connectors) {
    const was = before.get(c.id);
    if (was?.domain !== c.domain && !domains.includes(c.domain)) {
      refuse("invalid_value", `${name}'s ${c.label} connects to "${c.domain}", which this version of the model can't draw. Use a duct, pipe or electrical connection`, [next.id]);
    }
    if (c.values !== undefined && !sameJson(c.values, was?.values) && !peerReadsServiceFeature(PARTS_CONNECTOR_VALUES_FEATURE)) {
      refuse("invalid_value", `${name}'s ${c.label} values can't be saved yet: the model server this model is open on is an older version that doesn't store connector values. Try again once the server is updated`, [next.id]);
    }
    const endTypeRefused = endTypeWriteRefusal(name, c.label, c.endType, was?.endType);
    if (endTypeRefused) refuse("invalid_value", endTypeRefused, [next.id]);
  }
}

/** A part type newly written with a solid program (part model schema 2) or a `script` source needs a peer that reads them; an older one can't store it. */
function checkSolidProgram(next: Extract<BimElement, { kind: "part_type" }>, prior: BimElement | undefined): void {
  const def = next.definition;
  const solid = def.model !== undefined && isPartModel2(def.model);
  if (!solid && def.source.kind !== "script") return;
  if (prior?.kind === "part_type" && sameJson(prior.definition.model, def.model) && sameJson(prior.definition.source, def.source)) return;
  if (peerReadsServiceFeature(GEOMETRY_SOLID_PROGRAM_2_FEATURE)) return;
  refuse("invalid_value", `${recordName(next)} can't be saved yet: the model server this model is open on is an older version that doesn't store parts made with sweeps, lofts and patterns or by scripts. Try again once the server is updated`, [next.id]);
}

/** A link written with `adapter` / `design` to a peer that doesn't read them goes out in the old shape, or is refused when the old shape can't say it. */
function linkForPeer(working: Record<string, BimElement>, next: ServiceLink, prior: BimElement | undefined): void {
  if (next.adapter === undefined && next.design === undefined) return;
  if (prior?.kind === "service_link" && prior.adapter === next.adapter && sameJson(prior.design, next.design)) return;
  if (peerReadsServiceFeature(LINKS_DESIGN_FEATURE)) return;
  const legacy = legacyLinkShape(next);
  if (typeof legacy === "string") refuse("invalid_value", legacy, [next.id]);
  working[next.id] = legacy;
}

function checkTouched(base: Readonly<Record<string, BimElement>>, working: Record<string, BimElement>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  const before = new Map<string, View>();
  const after = new Map<string, View>();
  for (const id of touchedIds) {
    const next = working[id];
    if (!next) continue;
    if (next.kind === "part_type") {
      checkConnectors(next, base[id]);
      checkSolidProgram(next, base[id]);
    }
    if (next.kind === "service_link") linkForPeer(working, next, base[id]);
    after.clear();
    servicesOf(next, after);
    if (after.size === 0) continue;
    before.clear();
    servicesOf(base[id], before);
    for (const [service, view] of after) {
      if (before.get(service) === view) continue;
      const why = serviceWriteRefusal(service, view, recordName(next));
      if (why) refuse("invalid_value", why, [next.id]);
    }
  }
}

registerEditHook("services", (base, working, touchedIds) => {
  checkTouched(base.elements, working, touchedIds);
});

/**
 * Why a part type's connector may not newly carry `endType` here, in plain
 * words; null when it may (unchanged, removed, or every peer reads end types).
 */
export function endTypeWriteRefusal(recordName: string, connectorLabel: string, endType: string | undefined, was: string | undefined): string | null {
  if (endType === undefined || endType === was || peerReads(CONNECTOR_END_TYPES_FEATURE)) return null;
  return `${recordName}'s ${connectorLabel} end type can't be saved yet: the model server this model is open on is an older version that doesn't store connector end types. Try again once the server is updated`;
}
