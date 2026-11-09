import type { PartTypeDefinition } from "../parts";
import type { ParamValue } from "../types";

/**
 * One part definition, many sizes. Each row of `model.types` becomes its own
 * part type in the project library (id `<model id>.<row slug>`), carrying the
 * whole definition so "Edit definition" from any placed size opens all sizes.
 */

export function typeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    // Run quantifiers are bounded so pathological "-"-repetition input cannot
    // backtrack polynomially (polynomial-redos CodeQL finding).
    .replace(/[^a-z0-9]{1,80}/g, "-")
    .replace(/^-{1,80}|-{1,80}$/g, "");
  return slug || "type";
}

export interface DefinitionType {
  readonly typeId: string;
  readonly definition: PartTypeDefinition;
}

/** The part types a definition saves as: one per types-table row, or itself when the table is empty. */
export function definitionTypes(def: PartTypeDefinition): DefinitionType[] {
  const model = def.model;
  if (!model || model.types.length === 0) return [{ typeId: model ? `${model.id}.${typeSlug(def.typeName)}` : typeSlug(def.typeName), definition: def }];
  const seen = new Map<string, string>();
  return model.types.map((row) => {
    const slug = typeSlug(row.name);
    const clash = seen.get(slug);
    if (clash !== undefined) throw new Error(`Types ${clash} and ${row.name} would get the same id; rename one`);
    seen.set(slug, row.name);
    const typeValues: Record<string, ParamValue> = { ...def.typeValues, ...row.values };
    return { typeId: `${model.id}.${slug}`, definition: { ...def, typeName: row.name, typeValues } };
  });
}

/** Parse a types-table CSV: `name,<param>,...` header, one row per type. Lengths in the file's unit (mm, in or ft). */
export function parseTypesCsv(csv: string, lengthParams: ReadonlySet<string>, unit: "mm" | "in" | "ft"): Array<{ name: string; values: Record<string, ParamValue> }> {
  const scale = unit === "mm" ? 1 : unit === "in" ? 25.4 : 304.8;
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  if (header[0]?.toLowerCase() !== "name") throw new Error('The first column of a types table must be "name"');
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    const name = cells[0] ?? "";
    if (!name) throw new Error(`Row ${i + 2} has no name`);
    const values: Record<string, ParamValue> = {};
    header.slice(1).forEach((param, k) => {
      const cell = cells[k + 1] ?? "";
      if (cell === "") return;
      if (cell === "yes" || cell === "no") values[param] = cell === "yes";
      else if (/^-?\d+(\.\d+)?$/.test(cell)) values[param] = Number(cell) * (lengthParams.has(param) ? scale : 1);
      else values[param] = cell;
    });
    return { name, values };
  });
}

/** A types table as CSV (lengths in `unit`). */
export function typesCsv(def: PartTypeDefinition, unit: "mm" | "in" | "ft"): string {
  const scale = unit === "mm" ? 1 : unit === "in" ? 25.4 : 304.8;
  const params = def.typeParams.filter((p) => !p.formula);
  const lengths = new Set(params.filter((p) => p.kind === "length").map((p) => p.name));
  const rows = def.model && def.model.types.length > 0 ? def.model.types : [{ name: def.typeName, values: def.typeValues }];
  const cell = (name: string, v: ParamValue | undefined) => (v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "number" ? String(Math.round((lengths.has(name) ? v / scale : v) * 1e6) / 1e6) : v.replace(/,/g, " "));
  return [["name", ...params.map((p) => p.name)].join(","), ...rows.map((r) => [r.name.replace(/,/g, " "), ...params.map((p) => cell(p.name, r.values[p.name] ?? def.typeValues[p.name]))].join(","))].join("\n");
}
