import { elementsOfKind, paramValue, type BimElement, type ElementId, type PartInstance, type SpaceLocator } from "@permitzip/bim-kernel";
import { lookupTable, type LookupTable } from "@permitzip/bim-kernel/policy";
import { qty, type Quantity } from "@permitzip/bim-units";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Kitchen equipment heat onto the space it stands in (lane M13 step 2). An
 * appliance part names its heat class (`mechanical.kitchen_appliance`,
 * "Fryer") and whether a hood captures it (`mechanical.hooded`). Sensible and
 * latent heat come only from a heat table the firm keeps in its library
 * (`lookup_table`, slot `KITCHEN_HEAT_TABLE_SLOT`), with its citation shown.
 * The add-on ships no table: with none set the space gets a finding that
 * says what to add, never a guessed number.
 */

export const KITCHEN_HEAT_TABLE_SLOT = "mechanical.kitchen_heat";
/** Part parameter names are lower_snake_case (`place_part` refuses others). */
export const KITCHEN_APPLIANCE_PARAM = "kitchen_appliance";
export const KITCHEN_HOODED_PARAM = "kitchen_hooded";
/** Round 13's names, which no command could store; still read from a record written another way. */
const LEGACY_APPLIANCE_PARAM = "mechanical.kitchen_appliance";
const LEGACY_HOODED_PARAM = "mechanical.hooded";
export const KITCHEN_HEAT_NEEDS_TABLE = "Can't add kitchen heat yet: add a kitchen heat table in Library › Lookup tables";

export interface KitchenHeatSources {
  readonly project?: readonly LookupTable[];
  readonly firm?: readonly LookupTable[];
  /** The lifecycle stage the table must apply at. Absent: any. */
  readonly stage?: string;
}

export interface KitchenAppliance {
  readonly partId: ElementId;
  readonly mark: string;
  readonly appliance: string;
  readonly hooded: boolean;
}

export interface KitchenHeatLine extends KitchenAppliance {
  readonly sensible: Quantity<"thermal_power">;
  readonly latent: Quantity<"thermal_power">;
  /** The table row it read, as the table writes it ("Fryer, hooded"). */
  readonly row: string;
}

export type KitchenHeat =
  | { readonly kind: "none"; readonly spaceId: ElementId }
  | { readonly kind: "needs_table"; readonly spaceId: ElementId; readonly appliances: readonly KitchenAppliance[]; readonly message: string }
  | {
      readonly kind: "heat";
      readonly spaceId: ElementId;
      readonly sensible: Quantity<"thermal_power">;
      readonly latent: Quantity<"thermal_power">;
      readonly lines: readonly KitchenHeatLine[];
      /** Appliances the table has no row for: each says which row to add. */
      readonly missing: readonly { readonly partId: ElementId; readonly message: string }[];
      readonly table: { readonly id: string; readonly name: string; readonly citation: string; readonly scope: "project" | "firm" };
      readonly message: string;
    };

function applianceOf(elements: Elements, part: PartInstance): KitchenAppliance | null {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const appliance = paramValue(type.definition, part.values, KITCHEN_APPLIANCE_PARAM) ?? paramValue(type.definition, part.values, LEGACY_APPLIANCE_PARAM);
  if (typeof appliance !== "string" || appliance.trim().length === 0) return null;
  const hooded = paramValue(type.definition, part.values, KITCHEN_HOODED_PARAM) ?? paramValue(type.definition, part.values, LEGACY_HOODED_PARAM);
  return { partId: part.id, mark: part.mark, appliance: appliance.trim(), hooded: hooded === true };
}

function partsIn(elements: Elements, spaceId: ElementId, locator: SpaceLocator): PartInstance[] {
  if (!locator.partsIn) return elementsOfKind(elements, "part").filter((part) => locator.spaceOf(part.id) === spaceId);
  return locator.partsIn(spaceId).flatMap((id) => {
    const el = elements[id];
    return el?.kind === "part" ? [el] : [];
  });
}

/** The kitchen appliances standing in a space (by location): the locator's parts in that space, or every part when it can't list them. */
export function kitchenAppliancesIn(elements: Elements, spaceId: ElementId, locator: SpaceLocator): KitchenAppliance[] {
  const out: KitchenAppliance[] = [];
  for (const part of partsIn(elements, spaceId, locator)) {
    const a = applianceOf(elements, part);
    if (a) out.push(a);
  }
  return out.sort((x, y) => (x.mark < y.mark ? -1 : x.mark > y.mark ? 1 : 0));
}

const yes = (cell: number | string | null): boolean | null => {
  if (cell === 1) return true;
  if (cell === 0) return false;
  if (typeof cell !== "string") return null;
  const t = cell.trim().toLowerCase();
  if (["yes", "y", "hooded", "true"].includes(t)) return true;
  if (["no", "n", "unhooded", "false"].includes(t)) return false;
  return null;
};

export interface KitchenHeatRow {
  readonly appliance: string;
  readonly hooded: boolean | null;
  readonly sensibleBtuh: number;
  readonly latentBtuh: number;
}

/** A kitchen heat table's rows as read: appliance, hood (null: the row doesn't say) and heat, rows without a number left out. */
export function kitchenHeatRows(table: LookupTable): KitchenHeatRow[] {
  const at = (key: string, fallback: number) => {
    const i = table.columns.findIndex((c) => c.key === key);
    return i >= 0 ? i : fallback;
  };
  const a = at("appliance", 0);
  const h = at("hooded", 1);
  const s = at("sensible_btuh", 2);
  const l = at("latent_btuh", 3);
  const out: KitchenHeatRow[] = [];
  for (const row of table.rows) {
    const name = row[a];
    const sensible = row[s];
    const latent = row[l];
    if (typeof name !== "string" || typeof sensible !== "number" || !Number.isFinite(sensible)) continue;
    out.push({ appliance: name.trim(), hooded: yes(row[h] ?? null), sensibleBtuh: sensible, latentBtuh: typeof latent === "number" && Number.isFinite(latent) ? latent : 0 });
  }
  return out;
}

/** The row for an appliance: same name (any case), the hood matching, or a row that doesn't say. */
function rowFor(rows: readonly KitchenHeatRow[], a: KitchenAppliance): KitchenHeatRow | null {
  const name = a.appliance.toLowerCase();
  const same = rows.filter((r) => r.appliance.toLowerCase() === name);
  return same.find((r) => r.hooded === a.hooded) ?? same.find((r) => r.hooded === null) ?? null;
}

const btuh = (v: number) => Math.round(v).toLocaleString("en-US");
const hoodWord = (hooded: boolean) => (hooded ? "hooded" : "not hooded");

/** Kitchen heat for one space: from the firm's table, or the finding that says to add one. */
export function kitchenHeatOfSpace(elements: Elements, spaceId: ElementId, locator: SpaceLocator, sources: KitchenHeatSources): KitchenHeat {
  const appliances = kitchenAppliancesIn(elements, spaceId, locator);
  if (appliances.length === 0) return { kind: "none", spaceId };
  const table = lookupTable(KITCHEN_HEAT_TABLE_SLOT, sources.stage, sources);
  if (!table) return { kind: "needs_table", spaceId, appliances, message: KITCHEN_HEAT_NEEDS_TABLE };
  const rows = kitchenHeatRows(table);
  const lines: KitchenHeatLine[] = [];
  const missing: { partId: ElementId; message: string }[] = [];
  let sensible = 0;
  let latent = 0;
  for (const a of appliances) {
    const r = rowFor(rows, a);
    if (!r) {
      missing.push({ partId: a.partId, message: `${a.mark} (${a.appliance}, ${hoodWord(a.hooded)}) has no row in '${table.name}': add a ${a.appliance} row to the table` });
      continue;
    }
    sensible += r.sensibleBtuh;
    latent += r.latentBtuh;
    lines.push({ ...a, sensible: qty("thermal_power", r.sensibleBtuh, "Btu/h"), latent: qty("thermal_power", r.latentBtuh, "Btu/h"), row: r.hooded === null ? r.appliance : `${r.appliance}, ${hoodWord(r.hooded)}` });
  }
  const citation = [table.citation.source, table.citation.section, table.citation.edition].filter((p): p is string => typeof p === "string" && p.length > 0).join(", ");
  const rowWords = lines.map((l) => l.row).join("; ");
  const message = lines.length > 0 ? `Kitchen equipment: ${btuh(sensible)} Btu/h sensible, ${btuh(latent)} latent (firm table '${table.name}', row ${rowWords})` : `Kitchen equipment: no heat added; '${table.name}' has no rows for the appliances here`;
  return { kind: "heat", spaceId, sensible: qty("thermal_power", sensible, "Btu/h"), latent: qty("thermal_power", latent, "Btu/h"), lines, missing, table: { id: table.id, name: table.name, citation, scope: kitchenHeatTableScope(table, sources) }, message };
}

export function kitchenHeatTableScope(table: LookupTable, sources: KitchenHeatSources): "project" | "firm" {
  return sources.project?.includes(table) ? "project" : "firm";
}

export type PartKitchenHeat =
  | { readonly kind: "none" }
  | { readonly kind: "needs_table"; readonly message: string }
  | { readonly kind: "needs_row"; readonly message: string }
  | { readonly kind: "heat"; readonly line: KitchenHeatLine; readonly scope: "project" | "firm"; readonly tableName: string };

/** One appliance's heat from the same table (an equipment list cell): nothing for a part that isn't a kitchen appliance. */
export function kitchenHeatOfPart(elements: Elements, partId: ElementId, sources: KitchenHeatSources): PartKitchenHeat {
  const part = elements[partId];
  if (part?.kind !== "part") return { kind: "none" };
  const a = applianceOf(elements, part);
  if (!a) return { kind: "none" };
  const table = lookupTable(KITCHEN_HEAT_TABLE_SLOT, sources.stage, sources);
  if (!table) return { kind: "needs_table", message: KITCHEN_HEAT_NEEDS_TABLE };
  const r = rowFor(kitchenHeatRows(table), a);
  if (!r) return { kind: "needs_row", message: `${a.mark} (${a.appliance}, ${hoodWord(a.hooded)}) has no row in '${table.name}': add a ${a.appliance} row to the table` };
  const line: KitchenHeatLine = { ...a, sensible: qty("thermal_power", r.sensibleBtuh, "Btu/h"), latent: qty("thermal_power", r.latentBtuh, "Btu/h"), row: r.hooded === null ? r.appliance : `${r.appliance}, ${hoodWord(r.hooded)}` };
  return { kind: "heat", line, scope: kitchenHeatTableScope(table, sources), tableName: table.name };
}
