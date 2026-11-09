import { paramValue, type BimElement, type PartInstance } from "@permitzip/bim-kernel";
import { distributionOf, electricalConnectorIds } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/** Categories whose parts are circuited like hardwired equipment once their nameplate is filled in (systems.ts, equipmentConnection). */
const NAMEPLATE_CATEGORIES: ReadonlySet<string> = new Set(["mechanical_equipment", "air_terminal", "plumbing_fixture", "generic"]);
const RATING_PARAMS = ["mca", "mocp", "mop", "fla", "load_va", "load_w", "watts", "motor_hp", "hp", "heater_kw"] as const;

function has(def: Parameters<typeof paramValue>[0], values: PartInstance["values"], name: string): boolean {
  const v = paramValue(def, values, name);
  return (typeof v === "number" && Number.isFinite(v) && v > 0) || (typeof v === "string" && v.trim() !== "" && Number(v) > 0);
}

/**
 * Why a selected part can't be put on a circuit or fed, in the words the
 * person acts on, or null when it can (or when it isn't electrical at all:
 * walls, ducts and fittings are simply not part of circuiting). Equipment
 * that only needs its nameplate filled in says which field.
 */
export function circuitReadiness(elements: Elements, part: PartInstance): string | null {
  const typeEl = elements[part.typeId];
  if (typeEl?.kind !== "part_type") return null;
  const def = typeEl.definition;
  const name = part.mark || (typeof paramValue(def, part.values, "panel_name") === "string" ? String(paramValue(def, part.values, "panel_name")) : "") || def.typeName;
  if (def.category === "electrical_equipment") {
    if (distributionOf(elements, part)) return null;
    return `${name} has no voltage system: set its voltage and phases (or its voltage system) in Properties, then feed it with Feed panel.`;
  }
  if (electricalConnectorIds(elements, part).length > 0) return null;
  if (!NAMEPLATE_CATEGORIES.has(def.category)) return null;
  const declares = (n: string) => def.typeParams.some((p) => p.name === n) || def.instanceParams.some((p) => p.name === n);
  // A fixture or diffuser with no electrical fields at all is not electrical; mechanical equipment always needs power.
  if (def.category !== "mechanical_equipment" && !declares("voltage")) return null;
  if (!declares("voltage") || !RATING_PARAMS.some(declares)) return `${name}'s part type has no electrical fields: add voltage and MCA (or load) to its type with Edit type, then circuit it.`;
  const voltage = has(def, part.values, "voltage");
  const rated = RATING_PARAMS.some((n) => has(def, part.values, n));
  if (!voltage && !rated) return `${name} has no electrical nameplate: set its voltage and MCA (or load) in Properties to circuit it.`;
  if (!voltage) return `${name} has no voltage: set it in Properties to circuit it.`;
  if (!rated) return `${name} has a voltage but no MCA, MOCP or load: set one in Properties to circuit it.`;
  return null;
}
