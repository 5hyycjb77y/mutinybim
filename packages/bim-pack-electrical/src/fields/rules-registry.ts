import { ElectricalLoadEngine } from "../connections/engine";
import { CONNECTED_LOAD_ONLY, type ElectricalRules } from "../connections/rules";
import { defineExtensionPoint, activePackSet, type PackSet } from "@permitzip/bim-kernel/packs";

/**
 * The code rules a printed schedule or tag computes demand under, by id
 * ("nec-2023"). The rules are rows of `DEMAND_RULE_SET_POINT`, contributed by
 * the pack that owns them, so a schedule stores only the id and every process
 * that draws it (the browser, the PDF printer, the agent) resolves the same
 * rules for the same model. An id the model's set lacks falls back to
 * connected loads only, and the schedule prints that label, so a missing pack
 * is visible on paper, never silently different.
 */

/**
 * Demand rule sets (v1). No `idOf`: stored ids ("nec-2023") predate registry
 * ids. The first row with an id wins, in set order (built-ins, first-party
 * packs, then the model's packs).
 */
export const DEMAND_RULE_SET_POINT = defineExtensionPoint<ElectricalRules>({ id: "kernel.demand_rule_set", version: 1, label: "Demand rule sets" });

interface RuleTable {
  readonly byId: ReadonlyMap<string, ElectricalRules>;
  readonly engines: Map<string, ElectricalLoadEngine>;
}

function ruleTable(set: PackSet = activePackSet()): RuleTable {
  return set.memo("kernel.demand_rule_set#table", () => {
    const byId = new Map<string, ElectricalRules>();
    for (const rules of set.items(DEMAND_RULE_SET_POINT)) if (!byId.has(rules.id)) byId.set(rules.id, rules);
    return { byId, engines: new Map() };
  });
}

/** The rule sets of the set in force, for pickers and the agent. */
export function registeredElectricalRules(): Array<{ readonly id: string; readonly label: string }> {
  return [...ruleTable().byId.values()].map((r) => ({ id: r.id, label: r.label }));
}

/** The rules for an id; connected loads only when the id is absent or not in the set in force. */
export function electricalRulesById(id: string | null | undefined): ElectricalRules {
  return (id ? ruleTable().byId.get(id) : undefined) ?? CONNECTED_LOAD_ONLY;
}

/**
 * One aggregation engine per rules id per pack set. The engine keys its
 * cache on element identity, so schedules, tags and the panel view reading
 * the same model state share the work, and an edit recomputes only the
 * panels on its path to the service.
 */
export function electricalEngineFor(id: string | null | undefined): ElectricalLoadEngine {
  const table = ruleTable();
  const rules = (id ? table.byId.get(id) : undefined) ?? CONNECTED_LOAD_ONLY;
  const known = table.engines.get(rules.id);
  if (known && known.rules === rules) return known;
  const engine = new ElectricalLoadEngine(rules);
  table.engines.set(rules.id, engine);
  return engine;
}
