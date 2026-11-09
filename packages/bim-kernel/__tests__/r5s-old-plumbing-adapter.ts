/**
 * The round-4 plumbing adapter's rules, verbatim (connections/plumbing/adapter.ts
 * at e88144729), and a comparison of every answer against today's adapter.
 */
import { resolveConnectors, type BimElement, type ModelState, type PartInstance } from "../src";
import { plumbingAdapter, plumbingSourceRole, type PlumbingSourceRole } from "@permitzip/bim-pack-plumbing";

type Elements = Readonly<Record<string, BimElement>>;

// ---- the round-4 adapter's rules, verbatim (connections/plumbing/adapter.ts at e88144729)
const OLD_ROLE_WORDS: Readonly<Record<PlumbingSourceRole, string>> = { water_heater: "water heater", water_meter: "water meter", gas_meter: "gas meter", grease_interceptor: "grease interceptor", sewer_connection: "sewer connection", sewage_pump: "sewage pump", backwater_valve: "backwater valve" };
const OLD_ROLE_SERVES: Readonly<Record<PlumbingSourceRole, readonly string[]>> = {
  water_heater: ["domestic_hot_water"],
  water_meter: ["domestic_cold_water"],
  gas_meter: ["natural_gas"],
  grease_interceptor: ["sanitary"],
  sewer_connection: ["sanitary"],
  sewage_pump: ["sanitary"],
  backwater_valve: ["sanitary"],
};
const OLD_PIPED: ReadonlySet<string> = new Set(["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "grease_waste", "natural_gas", "indirect_waste"]);

function oldPipeConnectors(elements: Elements, part: PartInstance): Array<{ id: string; systemKind: string }> {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return [];
  return resolveConnectors(type.definition, part.values).filter((c) => OLD_PIPED.has(c.systemKind)).map((c) => ({ id: c.id, systemKind: c.systemKind }));
}

export const old = {
  source(elements: Elements, part: PartInstance) {
    const role = plumbingSourceRole(elements, part);
    if (!role) return null;
    const connectors = oldPipeConnectors(elements, part);
    const out = connectors.find((c) => OLD_ROLE_SERVES[role].includes(c.systemKind)) ?? connectors[0];
    return { name: part.mark || part.id, port: out?.id ?? "out", spaces: "none", input: null };
  },
  connectors: (elements: Elements, part: PartInstance) => oldPipeConnectors(elements, part).map((c) => c.id),
  refusal(elements: Elements, source: PartInstance, member: { part: PartInstance; connector: string }) {
    const role = plumbingSourceRole(elements, source);
    if (!role) return `${source.mark || source.id} is not a water heater, meter or interceptor, so nothing can be served from it`;
    const kind = oldPipeConnectors(elements, member.part).find((c) => c.id === member.connector)?.systemKind ?? null;
    if (kind !== null && !OLD_ROLE_SERVES[role].includes(kind) && !(role === "water_heater" && kind === "domestic_cold_water")) {
      return `${source.mark || source.id} is a ${OLD_ROLE_WORDS[role]}; ${member.part.mark || member.part.id}'s ${member.connector} connection is not something it serves`;
    }
    return null;
  },
};

export function compare(model: ModelState): { parts: number; pairs: number } {
  const elements = model.elements;
  const parts = Object.values(elements).filter((e): e is PartInstance => e.kind === "part");
  let pairs = 0;
  for (const p of parts) {
    expect([p.id, plumbingAdapter.source(elements, p)]).toEqual([p.id, old.source(elements, p)]);
    expect([p.id, plumbingAdapter.connectors(elements, p)]).toEqual([p.id, old.connectors(elements, p)]);
  }
  for (const src of parts) {
    for (const member of parts) {
      for (const connector of old.connectors(elements, member)) {
        pairs += 1;
        expect([src.id, member.id, connector, plumbingAdapter.refusal(elements, src, [], { part: member, connector }, "branch")]).toEqual([src.id, member.id, connector, old.refusal(elements, src, { part: member, connector })]);
      }
    }
  }
  return { parts: parts.length, pairs };
}

