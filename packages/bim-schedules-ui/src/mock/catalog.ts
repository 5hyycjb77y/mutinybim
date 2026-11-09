import { KINDS, type Kind, type UnitCode } from "@permitzip/bim-units";
import type {
  CatalogClass,
  CatalogField,
  CatalogRelationship,
  FormulaCheck,
  FormulaEnginePort,
  FormulaError,
  FormulaLibraryItem,
  FormulaSchema,
  FormulaType,
  LibraryItemSummary,
  LibraryProviderPort,
  LibraryQuery,
  LibraryScope,
  PublishResult,
  ScheduleCatalog,
  ScopeCapabilities,
} from "../ports";

/**
 * Stand-ins for Stream B's registry and library provider and Stream C's
 * formula engine, shaped exactly like their ports. Demo and tests only.
 */

const CLASSES: readonly CatalogClass[] = [
  { id: "arch.door", label: "Door", discipline: "architecture", disciplineLabel: "Architecture" },
  { id: "arch.room", label: "Room", discipline: "architecture", disciplineLabel: "Architecture" },
  { id: "struct.beam", label: "Beam", discipline: "structural", disciplineLabel: "Structural" },
  { id: "civil.structure", label: "Drainage structure", discipline: "civil", disciplineLabel: "Civil" },
  { id: "mep.water_heater", label: "Water heater", discipline: "plumbing", disciplineLabel: "Plumbing" },
  { id: "mep.plumbing_fixture", label: "Plumbing fixture", discipline: "plumbing", disciplineLabel: "Plumbing" },
  { id: "mep.pump", label: "Pump", discipline: "plumbing", disciplineLabel: "Plumbing" },
  { id: "mep.panel", label: "Panel", discipline: "electrical", disciplineLabel: "Electrical" },
  { id: "mep.air_terminal", label: "Air terminal", discipline: "mechanical", disciplineLabel: "Mechanical" },
  { id: "fp.sprinkler_head", label: "Sprinkler head", discipline: "fire_protection", disciplineLabel: "Fire protection" },
  { id: "gc.takeoff_item", label: "Takeoff item", discipline: "general", disciplineLabel: "General contracting" },
];

const BASE_FIELDS: readonly CatalogField[] = [
  { path: "mark", label: "Mark", valueType: "text", editable: true, aggregation: "none" },
  { path: "type", label: "Type", valueType: "text", editable: true, aggregation: "none" },
  { path: "level", label: "Level", valueType: "text", editable: false, aggregation: "none" },
  { path: "room", label: "Room", valueType: "text", editable: false, aggregation: "none" },
];

const FIELDS_BY_CLASS: Readonly<Record<string, readonly CatalogField[]>> = {
  "mep.water_heater": [
    { path: "own.mbh", label: "Gas input", valueType: "quantity", kind: "flow_gas_energy", unit: "MBH", editable: true, aggregation: "sum" },
    { path: "storage", label: "Storage", valueType: "quantity", kind: "volume", unit: "gal", editable: true, aggregation: "sum" },
    { path: "length", label: "Length", valueType: "quantity", kind: "length", unit: "ft", editable: true, aggregation: "sum" },
    { path: "serves.wsfu_total", label: "Serves load", valueType: "quantity", kind: "fixture_units_supply", unit: "WSFU", editable: false, aggregation: "sum", totalRefusedReason: "Served loads are already counted on the fixtures." },
  ],
  "mep.plumbing_fixture": [
    { path: "load.wsfu_total", label: "Supply load", valueType: "quantity", kind: "fixture_units_supply", unit: "WSFU", editable: true, aggregation: "sum" },
    { path: "load.dfu", label: "Drainage load", valueType: "quantity", kind: "fixture_units_drainage", unit: "DFU", editable: true, aggregation: "sum" },
  ],
  "arch.door": [
    { path: "width", label: "Width", valueType: "quantity", kind: "length", unit: "in", editable: true, aggregation: "none" },
    { path: "fire_rating", label: "Fire rating", valueType: "choice", editable: true, aggregation: "none" },
  ],
  "fp.sprinkler_head": [
    { path: "k_factor", label: "K-factor", valueType: "quantity", kind: "k_factor", unit: "gpm/psi^0.5", editable: true, aggregation: "none" },
    { path: "temperature_rating", label: "Temperature rating", valueType: "quantity", kind: "temperature", unit: "degF", editable: true, aggregation: "none" },
  ],
  "struct.beam": [{ path: "moment", label: "Moment", valueType: "quantity", kind: "moment", unit: "kip.ft", editable: true, aggregation: "max" }],
};

export function createMockCatalog(): ScheduleCatalog {
  return {
    classes: () => CLASSES,
    fieldsFor(classIds) {
      const seen = new Map<string, CatalogField>();
      for (const f of BASE_FIELDS) seen.set(f.path, f);
      for (const id of classIds) for (const f of FIELDS_BY_CLASS[id] ?? []) seen.set(f.path, f);
      return [...seen.values()];
    },
    relationshipsFor(classIds): readonly CatalogRelationship[] {
      return classIds.includes("mep.water_heater") ? [{ id: "serves", label: "Serves", targetClasses: ["mep.plumbing_fixture"] }] : [];
    },
  };
}

/** Formula schema over the catalog fields for the chosen classes. */
export function catalogFormulaSchema(catalog: ScheduleCatalog, classIds: readonly string[]): FormulaSchema {
  const fields = new Map(catalog.fieldsFor(classIds).map((f) => [f.path, f] as const));
  const typeOf = (f: CatalogField): FormulaType => (f.valueType === "quantity" && f.kind && f.unit ? { type: "quantity", kind: f.kind, unit: f.unit } : f.valueType === "boolean" ? { type: "boolean" } : { type: "text" });
  return {
    field(path) {
      const f = fields.get(path);
      return f ? { type: typeOf(f), label: f.label.toLowerCase() } : undefined;
    },
    relationship() {
      return undefined;
    },
  };
}

/**
 * A deliberately small checker for `{field}`, numbers, `+ - * /` and
 * parentheses, typed by kind. It exists so the builder's inline errors can be
 * built and tested before Stream C's engine merges; the real engine replaces
 * it through `FormulaEnginePort` with no UI change.
 */
export function createMockFormulaEngine(): FormulaEnginePort {
  type T = { kind: Kind | null; unit: UnitCode | null; label: string; text: boolean };
  return {
    compile(source, schema, options): FormulaCheck {
      let i = 0;
      const errors: FormulaError[] = [];
      const fail = (start: number, end: number, message: string, code = "type_mismatch"): never => {
        errors.push({ code, message, span: { start, end } });
        throw new Error(message);
      };
      const ws = () => {
        while (i < source.length && /\s/.test(source[i] ?? "")) i++;
      };
      const primary = (): T => {
        ws();
        const start = i;
        const ch = source[i];
        if (ch === "(") {
          i++;
          const t = sum();
          ws();
          if (source[i] !== ")") fail(i, i + 1, "Close the bracket.", "syntax");
          i++;
          return t;
        }
        if (ch === "{") {
          const end = source.indexOf("}", i);
          if (end < 0) fail(i, source.length, "Close the field with }.", "syntax");
          const path = source.slice(i + 1, end).trim();
          i = end + 1;
          const f = schema.field(path);
          if (!f) return fail(start, i, `There's no field called ${path} on these items.`, "unknown_field");
          return f.type.type === "quantity" ? { kind: f.type.kind, unit: f.type.unit, label: f.label ?? path, text: false } : { kind: null, unit: null, label: f.label ?? path, text: true };
        }
        const m = /^\d+(?:\.\d+)?/.exec(source.slice(i));
        if (m) {
          i += m[0].length;
          return { kind: null, unit: null, label: "a number", text: false };
        }
        return fail(start, Math.max(start + 1, i), "Expected a field like {own.mbh}, a number or a bracket.", "syntax");
      };
      const product = (): T => {
        let left = primary();
        for (;;) {
          ws();
          const op = source[i];
          if (op !== "*" && op !== "/") return left;
          const opAt = i;
          i++;
          const right = primary();
          if (left.text || right.text) fail(opAt, opAt + 1, `Can't multiply text (${left.text ? left.label : right.label}).`);
          if (left.kind && right.kind) fail(opAt, opAt + 1, `Multiplying ${left.label} by ${right.label} needs the full formula engine.`, "no_kind");
          left = left.kind ? left : right;
        }
      };
      const kindLabel = (t: T) => (t.kind ? `${KINDS[t.kind].label.toLowerCase()}${t.unit ? ` (${t.unit})` : ""}` : t.label);
      const sum = (): T => {
        let left = product();
        for (;;) {
          ws();
          const op = source[i];
          if (op !== "+" && op !== "-") return left;
          const opAt = i;
          i++;
          const right = product();
          if (left.kind !== right.kind) fail(opAt, opAt + 1, `Can't ${op === "+" ? "add" : "subtract"} ${kindLabel(right)} ${op === "+" ? "to" : "from"} ${kindLabel(left)}.`, "unit_mismatch");
        }
      };
      try {
        if (source.trim() === "") fail(0, 0, "Type a formula, like {own.mbh} * 1000.", "syntax");
        const t = sum();
        ws();
        if (i < source.length) fail(i, source.length, "Unexpected text here.", "syntax");
        const type: FormulaType = t.text ? { type: "text" } : t.kind && t.unit ? { type: "quantity", kind: t.kind, unit: t.unit } : { type: "quantity", kind: "dimensionless", unit: "1" };
        const expect = options?.expect;
        if (expect && expect.type === "quantity" && type.type === "quantity" && expect.kind !== type.kind) fail(0, source.length, `The result is ${KINDS[type.kind].label.toLowerCase()}, but this column holds ${KINDS[expect.kind].label.toLowerCase()}.`, "unit_mismatch");
        return { ok: true, formula: { source, type } };
      } catch {
        return { ok: false, errors };
      }
    },
  };
}

export interface MockLibraryOptions {
  /** Firm scope publish allowed? Absent: true. */
  readonly canPublishFirm?: boolean;
}

export function createMockLibraryProvider(options: MockLibraryOptions = {}): LibraryProviderPort & { readonly published: FormulaLibraryItem[] } {
  const scopes: LibraryScope[] = [
    { id: "builtin", kind: "builtin", name: "Built-in" },
    { id: "firm:permitzip", kind: "firm", name: "PermitZIP" },
    { id: "project:7301", kind: "project", name: "7301 Main St" },
  ];
  const items: LibraryItemSummary[] = [
    { id: "calc-gas-demand", type: "formula", key: "PZ.GasDemandBtuh", name: "Gas demand (Btu/h)", revision: 3, contentHash: "sha256:" + "a".repeat(64), scope: "firm:permitzip", deprecated: false },
    { id: "calc-pump-gpm", type: "formula", key: "PZ.PumpServedGpm", name: "Pump served flow", revision: 1, contentHash: "sha256:" + "b".repeat(64), scope: "firm:permitzip", deprecated: false },
    { id: "calc-old", type: "formula", key: "PZ.OldDemand", name: "Old demand factor", revision: 2, contentHash: "sha256:" + "c".repeat(64), scope: "firm:permitzip", deprecated: true },
    { id: "field-seismic", type: "field", key: "seismic_restraint_required", name: "Seismic restraint required", revision: 1, contentHash: "sha256:" + "d".repeat(64), scope: "firm:permitzip", deprecated: false },
    { id: "tmpl-wh", type: "schedule_template", key: "water_heater_schedule", name: "Water heater schedule", revision: 4, contentHash: "sha256:" + "e".repeat(64), scope: "builtin", deprecated: false },
    { id: "tmpl-door", type: "schedule_template", key: "door_schedule", name: "Door schedule", revision: 2, contentHash: "sha256:" + "f".repeat(64), scope: "builtin", deprecated: false },
    { id: "tmpl-spk", type: "schedule_template", key: "sprinkler_head_schedule", name: "Sprinkler head schedule", revision: 1, contentHash: "sha256:" + "0".repeat(64), scope: "builtin", deprecated: false },
  ];
  const published: FormulaLibraryItem[] = [];
  return {
    published,
    async scopes() {
      return scopes;
    },
    async list(scope: string, query?: LibraryQuery) {
      const text = query?.text?.toLowerCase() ?? "";
      return items.filter((it) => it.scope === scope && (!query?.type || it.type === query.type) && (query?.includeDeprecated || !it.deprecated) && (!text || it.key.toLowerCase().includes(text) || it.name.toLowerCase().includes(text)));
    },
    async capabilities(scope: string): Promise<ScopeCapabilities> {
      if (scope === "builtin") return { read: true, publish: false, reason: "The built-in library ships with MutinyBIM and can't be changed." };
      if (scope.startsWith("firm:") && options.canPublishFirm === false) return { read: true, publish: false, reason: "Ask a library editor at your firm for permission to publish." };
      return { read: true, publish: true };
    },
    async publish(scope: string, item: FormulaLibraryItem, baseRevision: number): Promise<PublishResult> {
      const caps = await this.capabilities(scope);
      if (!caps.publish) return { ok: false, code: "forbidden", message: caps.reason ?? "You can't publish here." };
      const existing = items.find((it) => it.scope === scope && it.key === item.body.key);
      if (existing && existing.revision !== baseRevision) return { ok: false, code: "conflict", message: `${item.body.key} was changed by someone else (now revision ${existing.revision}).`, currentRevision: existing.revision };
      const summary: LibraryItemSummary = { id: item.body.id, type: "formula", key: item.body.key, name: item.body.name, revision: baseRevision + 1, contentHash: "sha256:" + "9".repeat(64), scope, deprecated: false };
      items.push(summary);
      published.push(item);
      return { ok: true, summary };
    },
  };
}
