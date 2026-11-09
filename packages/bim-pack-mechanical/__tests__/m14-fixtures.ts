/**
 * Round 14 lane M14 fixtures: a level with a 1-hour wall at x = 3 m, a smoke
 * barrier at x = 5 m and a plain wall at x = 7 m, the Architecture and
 * Mechanical add-ons in force, and a log that commits through `planCommit`.
 */
import { ARCHITECTURE_PACK, FIRE_RESISTANCE_KEY, SMOKE_BARRIER_KEY } from "@permitzip/bim-pack-architecture";
import type { BimElement, ModelState, PartTypeDefinition } from "@permitzip/bim-kernel";
import { PackSet } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_PACK } from "../src/pack";
import { DAMPER_KIND_PARAM } from "../src/constraints/rated-crossings";
import { Log, twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";

export const M14_SET = PackSet.create([ARCHITECTURE_PACK, MECHANICAL_PACK]);

function withValues(model: ModelState, id: string, values: Record<string, unknown>): ModelState {
  const el = model.elements[id];
  if (!el) throw new Error(`no ${id}`);
  return { ...model, elements: { ...model.elements, [id]: { ...el, values: { ...("values" in el ? el.values : {}), ...values } } as BimElement } };
}

/** Three walls across y; the corridor wall is 1-hour, the next a smoke barrier, the last unrated. Run inside `withPackSet(M14_SET, …)`. */
export function ratedWalls(modelId = "m14"): Log {
  const m = twoLevels(modelId);
  m.ok({ type: "create_element", elementId: "corridor", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 3000, y: -2000 }, end: { x: 3000, y: 2000 } } });
  m.ok({ type: "create_element", elementId: "smoke", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 5000, y: -2000 }, end: { x: 5000, y: 2000 } } });
  m.ok({ type: "create_element", elementId: "plain", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 7000, y: -2000 }, end: { x: 7000, y: 2000 } } });
  return new Log(withValues(withValues(m.head, "corridor", { [FIRE_RESISTANCE_KEY]: 1 }), "smoke", { [SMOKE_BARRIER_KEY]: true }));
}

/** A 14x10 supply duct at 10 ft along y = 0 from x = 0 to 8 m, as the Route tool sends it. */
export function routeSupply(idPrefix: string) {
  return {
    type: "route_run",
    idPrefix,
    levelId: "L1",
    domain: "duct",
    size: { shape: "rect", width: 355.6, height: 254 },
    elevationMm: 3048,
    system: { id: "sa-1", kind: "supply_air", name: "Supply Air 1" },
    points: [
      { x: 0, y: 0 },
      { x: 8000, y: 0 },
    ],
  } as const;
}

/** A damper part type of `kind` (`fire`, `smoke`, `fire_smoke`), as the firm library pins one into a model. */
export function damperType(kind: string, typeName = `${kind} damper`): PartTypeDefinition {
  return {
    familyName: "Damper",
    typeName,
    category: "duct_accessory",
    typeParams: [{ name: DAMPER_KIND_PARAM, label: "Damper", kind: "choice", choices: ["fire", "smoke", "fire_smoke"] }],
    typeValues: { [DAMPER_KIND_PARAM]: kind },
    instanceParams: [],
    tagFields: [],
    geometry: [{ kind: "box", center: [0, 0, 0], size: [400, 100, 300] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [400, 100] }],
    connectors: [],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

/** The model with a damper type pinned in (no instance placed). */
export function withDamperType(model: ModelState, typeId: string, kind: string, definition: PartTypeDefinition = damperType(kind)): ModelState {
  return { ...model, elements: { ...model.elements, [typeId]: { version: 1, authoredRev: {}, id: typeId, kind: "part_type", definition } as unknown as BimElement } };
}

const rectConnector = (id: string, x: number, dx: number, width: number, height: number) => ({
  id,
  label: id,
  domain: "duct" as const,
  systemKind: "supply_air" as const,
  position: [x, 0, 0] as [number, number, number],
  direction: [dx, 0, 0] as [number, number, number],
  shape: "rect" as const,
  width,
  height,
});

/** A 300 mm long damper of `kind` with a 14x10 in-line connector at each end (a duct passes straight through it). */
export function inlineDamperType(kind: string, width = 355.6, height = 254): PartTypeDefinition {
  return { ...damperType(kind, `${kind} damper 14x10`), geometry: [{ kind: "box", center: [0, 0, 0], size: [300, width + 50, height + 50] }], connectors: [rectConnector("a", -150, -1, width, height), rectConnector("b", 150, 1, width, height)] };
}

/** Run segment ids a changeset wrote. */
export function segmentIds(model: ModelState, ids: readonly string[]): string[] {
  return ids.filter((id) => model.elements[id]?.kind === "run_segment");
}
