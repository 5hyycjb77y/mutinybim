import { modelSpaceLocator, serviceLabel, withModelSpaceParts, type BimElement, type ElementId, type SpaceLocator } from "@permitzip/bim-kernel";
import { qty, to, type Quantity } from "@permitzip/bim-units";
import { lookupTable } from "@permitzip/bim-kernel/policy";
import { KITCHEN_HEAT_TABLE_SLOT, kitchenHeatOfPart, kitchenHeatOfSpace, kitchenHeatRows, kitchenHeatTableScope, type KitchenHeatSources } from "../heat-gain/kitchen";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The heat a space gains from its kitchen equipment, read as the space's
 * `heat_gain` need (the service row Mechanical contributes, labelled from the
 * service registry): one line for Space › Properties › Loads, one cell per
 * appliance for the equipment list. The numbers come only from the firm's or
 * the project's kitchen heat table; with none the line says where to add one.
 */

export const HEAT_GAIN_SERVICE = "heat_gain";
export const KITCHEN_HEAT_ADD_TABLE = "Add a kitchen heat table in the firm library › Lookup tables";

export interface SpaceHeatGainNeed {
  readonly spaceId: ElementId;
  readonly service: typeof HEAT_GAIN_SERVICE;
  /** The service row's label ("Heat gain"). */
  readonly serviceLabel: string;
  readonly state: "needs_table" | "heat";
  /** Sensible plus latent; absent until a table gives a number. */
  readonly total?: Quantity<"thermal_power">;
  readonly sensible?: Quantity<"thermal_power">;
  readonly latent?: Quantity<"thermal_power">;
  /** "Kitchen heat 18,400 Btu/h (firm table)", or what to add. */
  readonly line: string;
  /** The table, its rows and its citation in words; absent with no table. */
  readonly detail?: string;
  /** Appliances the table has no row for, each saying which row to add. */
  readonly missing: readonly string[];
  /** The appliances it counted (or would count), for Select. */
  readonly partIds: readonly ElementId[];
}

const btuh = (q: Quantity<"thermal_power">) => Math.round(to(q, "Btu/h")).toLocaleString("en-US");

/** The model's locator with its parts-by-space read: what every screen passes. */
export function heatGainLocator(elements: Elements): SpaceLocator {
  return withModelSpaceParts(elements, modelSpaceLocator(elements));
}

/** A space's kitchen heat as its heat-gain need; null when no kitchen appliance stands in it. */
export function spaceHeatGainNeed(elements: Elements, spaceId: ElementId, sources: KitchenHeatSources, locator: SpaceLocator = heatGainLocator(elements)): SpaceHeatGainNeed | null {
  const heat = kitchenHeatOfSpace(elements, spaceId, locator, sources);
  if (heat.kind === "none") return null;
  const label = serviceLabel(HEAT_GAIN_SERVICE);
  if (heat.kind === "needs_table") {
    return { spaceId, service: HEAT_GAIN_SERVICE, serviceLabel: label, state: "needs_table", line: KITCHEN_HEAT_ADD_TABLE, missing: [], partIds: heat.appliances.map((a) => a.partId) };
  }
  const total = qty("thermal_power", to(heat.sensible, "Btu/h") + to(heat.latent, "Btu/h"), "Btu/h");
  const cited = heat.table.citation.length > 0 ? `; ${heat.table.citation}` : "";
  return {
    spaceId,
    service: HEAT_GAIN_SERVICE,
    serviceLabel: label,
    state: "heat",
    total,
    sensible: heat.sensible,
    latent: heat.latent,
    line: `Kitchen heat ${btuh(total)} Btu/h (${heat.table.scope} table)`,
    detail: `${heat.message}${cited}`,
    missing: heat.missing.map((m) => m.message),
    partIds: [...heat.lines.map((l) => l.partId), ...heat.missing.map((m) => m.partId)],
  };
}

const HOODED_WORDS: ReadonlySet<string> = new Set(["hooded", "under hood", "under a hood"]);
const UNHOODED_WORDS: ReadonlySet<string> = new Set(["unhooded", "not hooded", "no hood"]);

/**
 * A pasted equipment row's Heat gain cell, before it is a part: the row's first
 * phrase ("Fryer, gas, hooded" → Fryer) must be an appliance the table names, and
 * a hood phrase picks the row when the table splits by hood. No match: null.
 */
export function draftHeatGainCell(description: string, sources: KitchenHeatSources): { readonly text: string; readonly title: string } | null {
  const phrases = description.split(",").map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
  const name = phrases[0];
  if (name === undefined) return null;
  const table = lookupTable(KITCHEN_HEAT_TABLE_SLOT, sources.stage, sources);
  if (!table) return null;
  const rows = kitchenHeatRows(table).filter((r) => r.appliance.toLowerCase() === name);
  if (rows.length === 0) return null;
  const hooded = phrases.some((p) => HOODED_WORDS.has(p)) ? true : phrases.some((p) => UNHOODED_WORDS.has(p)) ? false : null;
  const row = rows.find((r) => r.hooded === hooded) ?? rows.find((r) => r.hooded === null);
  if (!row) return { text: "Say hooded or not hooded", title: `'${table.name}' has a ${rows[0]?.appliance ?? name} row for each: add "hooded" or "not hooded" to the description` };
  const total = qty("thermal_power", row.sensibleBtuh + row.latentBtuh, "Btu/h");
  return { text: `${btuh(total)} Btu/h`, title: `${kitchenHeatTableScope(table, sources) === "project" ? "Project" : "Firm"} table '${table.name}': ${row.sensibleBtuh.toLocaleString("en-US")} sensible, ${row.latentBtuh.toLocaleString("en-US")} latent` };
}

/** The equipment list's Heat gain cell: "16,600 Btu/h (14,500 sensible, 2,100 latent)", what to add, or null for a part that isn't a kitchen appliance. */
export function partHeatGainCell(elements: Elements, partId: ElementId, sources: KitchenHeatSources): { readonly text: string; readonly title: string } | null {
  const heat = kitchenHeatOfPart(elements, partId, sources);
  if (heat.kind === "none") return null;
  if (heat.kind === "needs_table") return { text: "Needs a kitchen heat table", title: KITCHEN_HEAT_ADD_TABLE };
  if (heat.kind === "needs_row") return { text: "No row in the table", title: heat.message };
  const total = qty("thermal_power", to(heat.line.sensible, "Btu/h") + to(heat.line.latent, "Btu/h"), "Btu/h");
  return {
    text: `${btuh(total)} Btu/h (${btuh(heat.line.sensible)} sensible, ${btuh(heat.line.latent)} latent)`,
    title: `${heat.scope === "project" ? "Project" : "Firm"} table '${heat.tableName}', row ${heat.line.row}`,
  };
}
