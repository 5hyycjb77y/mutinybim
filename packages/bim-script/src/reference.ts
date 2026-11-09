import { z } from "zod";
import { COMMAND_POINT, commandSchema } from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { KIT_EXAMPLES, KIT_EXAMPLES_PATH } from "./examples";
import { stepRefusal } from "./output";
import { KIT_ENTRIES, KIT_RECIPES, type KitEntry, type KitRecipe } from "./reference-entries";

/**
 * The kit's reference, generated: the kit's functions (`reference-entries`),
 * worked recipes, and every command `ctx.edit` takes, read from the kernel's
 * own zod schemas (and those of the add-ons in force), so a renamed field
 * changes the reference the moment it changes the kernel. Served by the
 * script tools (topic search, one command's fields), emitted as plain
 * markdown (`referenceMarkdown`) and TypeScript declarations
 * (`kitDeclarations`) for agents that run the kit themselves.
 */

export { KIT_ENTRIES, KIT_RECIPES, type KitEntry, type KitRecipe };

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A command `ctx.edit` takes: its type, where it comes from, and its schema. */
export interface CommandEntry {
  readonly type: string;
  /** "kernel", or "add-on" for a command an add-on in force contributes. */
  readonly from: string;
  readonly schema: z.ZodType;
}

function typeOf(schema: z.ZodObject): string | null {
  const t = schema.shape.type;
  return t instanceof z.ZodLiteral && typeof t.value === "string" ? t.value : null;
}

/** Every single-edit command a script may send: the kernel's, then the add-ons' in force (sorted by type). */
export function scriptCommands(): readonly CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const option of commandSchema.options) {
    const type = typeOf(option);
    if (type && stepRefusal({ type }) === null) out.push({ type, from: "kernel", schema: option });
  }
  const kernel = new Set(out.map((c) => c.type));
  for (const def of activePackSet().items(COMMAND_POINT)) {
    if (def.claims || kernel.has(def.type)) continue;
    out.push({ type: def.type, from: "add-on", schema: def.schema });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

function jsonSchemaOf(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  const { $schema: _drop, ...rest } = out as Json;
  return rest;
}

/** A JSON Schema as a TypeScript type. `$ref` (recursive shapes) read as unknown. */
export function jsonSchemaToTs(j: unknown, indent = ""): string {
  if (!isJson(j)) return "unknown";
  if ("const" in j) return JSON.stringify(j.const);
  if (Array.isArray(j.enum)) return j.enum.map((e) => JSON.stringify(e)).join(" | ");
  const union = Array.isArray(j.anyOf) ? j.anyOf : Array.isArray(j.oneOf) ? j.oneOf : null;
  if (union) return union.map((b) => wrap(jsonSchemaToTs(b, indent))).join(" | ");
  if (typeof j.$ref === "string") return "unknown";
  const type = j.type;
  if (Array.isArray(type)) return type.map((t) => jsonSchemaToTs({ ...j, type: t }, indent)).join(" | ");
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return Array.isArray(j.prefixItems) ? `[${j.prefixItems.map((p) => jsonSchemaToTs(p, indent)).join(", ")}]` : `${wrap(jsonSchemaToTs(j.items, indent))}[]`;
    case "object": {
      const props = isJson(j.properties) ? j.properties : {};
      const required = new Set(Array.isArray(j.required) ? j.required.filter((r): r is string => typeof r === "string") : []);
      const inner = `${indent}  `;
      const lines = Object.entries(props).map(([k, v]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${required.has(k) ? "" : "?"}: ${jsonSchemaToTs(v, inner)};`);
      const extra = isJson(j.additionalProperties) ? `${inner}[key: string]: ${jsonSchemaToTs(j.additionalProperties, inner)};` : null;
      if (extra) lines.push(extra);
      if (lines.length === 0) return j.additionalProperties === false ? "Record<string, never>" : "Record<string, unknown>";
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default:
      return "unknown";
  }
}

function wrap(t: string): string {
  return t.includes(" | ") && !t.startsWith("{") ? `(${t})` : t;
}

/** A command's fields in one line each, short enough for a tool answer. */
export function commandFields(type: string): { readonly type: string; readonly from: string; readonly fields: readonly string[]; readonly schema: Json } | null {
  const entry = scriptCommands().find((c) => c.type === type);
  if (!entry) return null;
  const schema = jsonSchemaOf(entry.schema);
  const props = isJson(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(props)
    .filter(([k]) => k !== "type")
    .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${brief(v)}${isJson(v) && typeof v.description === "string" ? ` (${v.description})` : ""}`);
  return { type, from: entry.from, fields, schema };
}

function brief(j: unknown, depth = 0): string {
  if (!isJson(j)) return "unknown";
  if ("const" in j) return JSON.stringify(j.const);
  if (Array.isArray(j.enum)) return j.enum.map((e) => JSON.stringify(e)).join("|");
  const union = Array.isArray(j.anyOf) ? j.anyOf : Array.isArray(j.oneOf) ? j.oneOf : null;
  if (union) return union.map((b) => brief(b, depth)).join(" | ");
  if (j.type === "array") return `${brief(j.items, depth)}[]`;
  if (j.type === "object" && isJson(j.properties)) {
    if (depth > 1) return "{…}";
    const req = new Set(Array.isArray(j.required) ? j.required : []);
    return `{ ${Object.entries(j.properties)
      .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${brief(v, depth + 1)}`)
      .join("; ")} }`;
  }
  return Array.isArray(j.type) ? j.type.join("|") : typeof j.type === "string" ? (j.type === "integer" ? "number" : j.type) : "unknown";
}

export type ReferenceHit =
  | { readonly kind: "function"; readonly name: string; readonly summary: string; readonly signature: string; readonly example: string }
  | { readonly kind: "recipe"; readonly name: string; readonly task: string; readonly summary: string; readonly steps: readonly string[]; readonly uses: readonly string[]; readonly example: string }
  | { readonly kind: "command"; readonly name: string; readonly from: string; readonly summary: string }
  | { readonly kind: "example"; readonly name: string; readonly title: string; readonly builds: string; readonly read: string };

const STOP = new Set(["a", "an", "the", "i", "do", "how", "to", "make", "with", "of", "for", "in", "on", "and", "or", "is", "can", "what", "my", "me", "it", "be", "use", "using", "script", "scripts"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_. -]+/g, " ")
    .split(/[\s._-]+/)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function score(query: readonly string[], phrase: string, fields: readonly { readonly text: string; readonly weight: number }[]): number {
  let total = 0;
  for (const f of fields) {
    const have = new Set(words(f.text));
    for (const q of query) if (have.has(q)) total += f.weight;
    if (phrase.length > 3 && f.text.toLowerCase().includes(phrase)) total += f.weight * 2;
  }
  return total;
}

/** What the reference has on a topic ("how do I make a rooftop unit"), best first: recipes, kit functions and commands. */
export function searchReference(query: string, limit = 8): readonly ReferenceHit[] {
  const q = words(query);
  const phrase = query.toLowerCase().trim();
  if (q.length === 0) return [];
  const hits: { hit: ReferenceHit; score: number }[] = [];
  for (const r of KIT_RECIPES) {
    const s = score(q, phrase, [{ text: r.topics.join(" "), weight: 4 }, { text: r.task, weight: 4 }, { text: r.name, weight: 3 }, { text: r.summary, weight: 1 }]);
    if (s > 0) hits.push({ hit: { kind: "recipe", name: r.name, task: r.task, summary: r.summary, steps: r.steps, uses: r.uses, example: r.example }, score: s + 1 });
  }
  for (const x of KIT_EXAMPLES) {
    const s = score(q, phrase, [{ text: x.topics.join(" "), weight: 2 }, { text: x.title, weight: 2 }]);
    if (s > 0) hits.push({ hit: { kind: "example", name: x.name, title: x.title, builds: x.builds, read: `bim_script_reference({ example: "${x.name}" })` }, score: s });
  }
  for (const e of KIT_ENTRIES) {
    const s = score(q, phrase, [{ text: e.topics.join(" "), weight: 3 }, { text: e.name, weight: 3 }, { text: e.summary, weight: 1 }]);
    if (s > 0) hits.push({ hit: { kind: "function", name: e.name, summary: e.summary, signature: e.signature, example: e.example }, score: s });
  }
  for (const c of scriptCommands()) {
    const s = score(q, phrase, [{ text: c.type.replace(/_/g, " "), weight: 2 }]);
    if (s > 0) hits.push({ hit: { kind: "command", name: c.type, from: c.from, summary: `ctx.edit({ type: "${c.type}", … }); its fields: bim_script_reference({ command: "${c.type}" })` }, score: s });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    .slice(0, limit)
    .map((h) => h.hit);
}

/** Shared types the kit's signatures use. Generated from the commands where a command defines them. */
const KIT_PRELUDE = `/** A quantity with its kind; build one with units.* (stored in SI). */
export interface Measure { readonly kind: string; readonly value: number }
export interface PlanPoint { readonly x: Measure; readonly y: Measure }
export type Dim = number | { param: string; scale?: number; add?: number } | { formula: string };
export type Length = Measure | Dim;
export type Face = "top" | "bottom" | "front" | "back" | "left" | "right";
export type DetailLevel = "coarse" | "medium" | "fine";
export type View = "plan" | "front" | "side";
/** A closed outline with any holes (parts.rect / circle / polygon). */
export interface Profile { hole(inner: Profile): Profile; at(du: Length, dv: Length): Profile }
export interface BodyOptions { cut?: boolean; show?: DetailLevel[]; material?: string; id?: string }
export type PathSegment = { straight: Length } | { bend: { radius: Length; angle: number; turn: "left" | "right" } };
export interface SweepPath { on: View; at?: Length; start: [Length, Length]; heading: "right" | "left" | "up" | "down"; segments: PathSegment[] }
export interface ImportedBodyRef { fileId: string; format: string; contentHash: string; mmPerUnit: number; upAxis?: "y" | "z" }
export interface ConnectorSpec { id: string; label: string; domain: string; systemKind: string; shape: "rect" | "round" | "none"; width?: Length; height?: Length; diameter?: Length; flow?: number; flowDirection?: "in" | "out" | "bidirectional"; endType?: string; voltage?: number; poles?: 1 | 2 | 3 }
export type RunSize = Extract<EditCommand, { type: "route_run" }>["size"];
export type PipeMaterial = Extract<RunSize, { shape: "pipe" }>["material"];
export type RouteEnd = NonNullable<Extract<EditCommand, { type: "route_run" }>["from"]>;
export type PartTypeDefinition = Extract<EditCommand, { type: "save_part_types" }> extends { types: (infer T)[] } ? (T extends { definition: infer D } ? D : never) : never;
export type PartCategory = PartTypeDefinition["category"];
/** One value a calculation returns (by key: "size_in", "velocity_fpm"). */
export interface CalcValue { readonly key: string; readonly label: string; readonly value: number | string | boolean | null; readonly unit: string | null }
/** A calculation's answer: its values, and what it flagged. */
export interface CalcRun { readonly calc: { readonly id: string; readonly title: string }; readonly values: readonly CalcValue[]; readonly issues: readonly unknown[] }
export type ScheduleCategory = "mechanical_equipment" | "air_terminal" | "duct_accessory" | "pipe_accessory" | "plumbing_fixture" | "electrical_equipment" | "electrical_device" | "lighting_fixture" | "generic" | "sheet_list" | "duct" | "pipe";
export type TagTemplate = NonNullable<Extract<EditCommand, { type: "add_drawing_item" }>["tag"]>["template"];
export type TitleBlock = NonNullable<Extract<EditCommand, { type: "create_sheet" }>["titleBlock"]>;
export type ScheduleEditStep = Extract<EditCommand, { type: "edit_schedule" }>["steps"][number];
/** A device an add-on's proposer would place (not in the model yet), with the requirement it meets. Positions are plan mm. */
export interface GhostPlacement { readonly key: string; readonly roomId: string; readonly hostId?: string; readonly typeId: string; readonly position: { readonly x: number; readonly y: number }; readonly levelId?: string; readonly heightMm: number; readonly rotationDeg: number; readonly requirementId?: string; readonly reason: string; readonly cite?: string }
export interface ProposerRequest { readonly typeId: string; readonly roomIds: readonly string[]; readonly options?: Readonly<Record<string, unknown>> }
export interface ProposerAnswer { readonly ghosts: readonly GhostPlacement[]; readonly summary: string; readonly passes: boolean; readonly notes: readonly string[] }
/** A schedule column beyond a plain field path: a formula, an aggregate over a relationship, a part parameter. */
export interface ScheduleColumn { readonly id: string; readonly kind: "field" | "parameter" | "formula" | "aggregate"; readonly path?: string; readonly expression?: string; readonly fn?: string; readonly relationship?: string; readonly heading?: string; readonly total?: boolean }
export interface ScheduleFilter { readonly path: string; readonly op: "equals" | "not_equals" | "contains" | "greater_than" | "less_than" | "present" | "absent"; readonly value?: string }
/** One schedule row: cells by column id, quantities in SI (m², L/s, W…). */
export interface ScheduleRow { readonly key: string; readonly element: string; readonly cells: Readonly<Record<string, number | string | boolean | null>> }
export interface ScheduleRows { readonly name: string; readonly columns: readonly { readonly id: string; readonly heading: string; readonly valueType: string; readonly quantityKind?: string }[]; readonly rows: readonly ScheduleRow[]; readonly totals: Readonly<Record<string, number | null>>; readonly totalRows: number }
export interface ScheduleClassFields { readonly id: string; readonly label: string; readonly fields: readonly { readonly path: string; readonly label: string; readonly valueType: string; readonly kind?: string; readonly unit?: string; readonly totals?: string }[]; readonly relationships: readonly { readonly id: string; readonly label: string; readonly to: string }[] }
export type AutoTagCategory = "duct" | "pipe" | "air_terminal" | "equipment" | "fixture" | "part";
/** A piece of equipment in a one-line you describe: kind ("utility", "switchboard", "panelboard", "transformer"…), name, ratings, what it feeds. */
export interface OneLineNode { readonly id: string; readonly kind: string; readonly name: string; readonly ratings?: readonly string[]; readonly main?: { readonly device: string; readonly label?: string }; readonly feeder?: Readonly<Record<string, string | number | undefined>>; readonly children?: readonly OneLineNode[]; readonly placeholder?: boolean }
/** A surface found over or under a point: its elevation (mm) and height above the floor. */
export interface SurfaceAt { readonly role: string; readonly elevationMm: number; readonly aboveFloorMm: number | null; readonly source: unknown }
export interface SurfacesAt { readonly point: { readonly x: number; readonly y: number }; readonly probeMm: number; readonly level: { readonly id: string; readonly name: string; readonly elevationMm: number } | null; readonly floor: SurfaceAt | null; readonly ceiling: SurfaceAt | null; readonly roof: SurfaceAt | null; readonly structureAbove: SurfaceAt | null; readonly notes: readonly string[] }
export interface LevelSyncPlan { readonly rows: readonly { readonly storeyId: string; readonly storeyName: string; readonly elevationMm: number; readonly action: "add" | "update" | "match" | "unchanged"; readonly levelId: string; readonly name: string }[]; readonly orphaned: readonly { readonly levelId: string; readonly name: string; readonly elevationMm: number }[]; readonly changes: boolean }
export interface FittingFamily { readonly id: string; readonly name: string; readonly domain: string; readonly fittingTypes: readonly string[]; readonly shapes: readonly string[]; readonly description: string }
export interface StarterType { readonly id: string; readonly definition: PartTypeDefinition }
/** A coordination finding: the rule, the elements, where, and what to do. */
export interface Finding { readonly id: string; readonly rule: string; readonly severity: string; readonly elementIds: readonly string[]; readonly at: { readonly level: string; readonly x_ft: number; readonly y_ft: number; readonly z_ft: number }; readonly message: string }
export interface BimElement { readonly id: string; readonly kind: string; readonly [field: string]: unknown }
export interface ScriptReads { levels?: boolean; kinds?: string[]; ids?: string[] | "selection"; partTypes?: string[] }
export type ParameterDecl =
  | { type: "quantity"; kind: string; unit: string; label: string; default?: Measure | number; min?: Measure | number; max?: Measure | number }
  | { type: "number"; label: string; default?: number; min?: number; max?: number; integer?: boolean }
  | { type: "choice"; label: string; choices: readonly string[]; default?: string }
  | { type: "boolean"; label: string; default?: boolean }
  | { type: "text"; label: string; default?: string }
  | { type: "part_type"; label: string; default?: string };
export type ValuesOf<P> = { readonly [K in keyof P]: P[K] extends { type: "quantity" } ? Measure : P[K] extends { type: "number" } ? number : P[K] extends { type: "boolean" } ? boolean : string };
export interface ScriptDefinition { readonly manifest: unknown }
export interface SliceReader {
  get(id: string): BimElement;
  find(id: string): BimElement | undefined;
  ofKind(kind: string): BimElement[];
  levels(): BimElement[];
  selection(): BimElement[];
  partTypes(pattern?: string): BimElement[];
  /** A part definition the host's library supplied for this run (name its id in reads.partTypes); equipment.place sends it for you. */
  libraryPart(typeId: string): object | undefined;
  readonly revision: number;
}
export interface Slope { readonly rise: Measure; readonly per: Measure }
export interface RouteSpec {
  level: string; domain: Extract<EditCommand, { type: "route_run" }>["domain"]; size: RunSize; system: Extract<EditCommand, { type: "route_run" }>["system"];
  height?: Measure; points: { x: Measure; y: Measure; height?: Measure }[]; from?: RouteEnd; to?: RouteEnd;
  riseStyle?: "vertical" | "45" | "60" | "22.5"; capEnd?: boolean; zone?: string; slope?: Slope; flow?: "with_points" | "against_points"; id?: string;
}
export interface RouteHandle { readonly prefix: string; segment(n: number): string }
export type TopSurface = "structure above" | "ceiling" | "roof";
export type WallTop = { level: string; offset?: Measure } | TopSurface | { to: TopSurface; offset?: Measure };
export type WallBase = { offset: Measure } | "slab below" | { to: "slab below"; offset?: Measure };
export interface ChainSpec { level: string; points: readonly PlanPoint[]; closed?: boolean; typeId?: string; thickness?: Measure; height?: Measure; top?: WallTop; base?: WallBase; topLevel?: string; topOffset?: Measure; values?: Record<string, string | number | boolean>; label?: string; id?: string }
export interface WallSpec { level: string; from: PlanPoint; to: PlanPoint; typeId?: string; thickness?: Measure; height?: Measure; top?: WallTop; base?: WallBase; topLevel?: string; topOffset?: Measure; values?: Record<string, string | number | boolean>; label?: string; id?: string }
export interface ChainHandle { readonly prefix: string; element(n: number): string }
export interface OpeningSpec { wall: string; along: Measure; width?: Measure; height?: Measure; sill?: Measure; side?: 1 | -1; typeId?: string; mark?: string; values?: Record<string, string | number | boolean>; id?: string }
export interface PlacedPart { readonly id: string; connector(connectorId: string): RouteEnd }
export interface PlanViewSpec { level: string; name: string; discipline?: string; scale?: number; cutHeight?: Measure; hide?: string[]; id?: string }
`;

function member(e: KitEntry): string {
  return `  /** ${e.summary} */\n  ${e.signature};`;
}

/** The kit as TypeScript declarations (`declare module "@permitzip/bim-script"`), the commands generated from the kernel's schemas. */
export function kitDeclarations(): string {
  const commands = scriptCommands().map((c) => `  | ${jsonSchemaToTs(jsonSchemaOf(c.schema), "  ")}`);
  const groups = new Map<string, KitEntry[]>();
  const top: KitEntry[] = [];
  for (const e of KIT_ENTRIES) {
    const dot = e.name.indexOf(".");
    if (dot < 0) top.push(e);
    else {
      const ns = e.name.slice(0, dot);
      groups.set(ns, [...(groups.get(ns) ?? []), e]);
    }
  }
  const ctx = groups.get("ctx") ?? [];
  const builder = groups.get("PartBuilder") ?? [];
  const namespaces = [...groups.entries()].filter(([ns]) => ns !== "ctx" && ns !== "PartBuilder");
  return [
    "// Generated by @permitzip/bim-script kitDeclarations(): the kit a MutinyBIM script imports.",
    'declare module "@permitzip/bim-script" {',
    "/** Every single edit `ctx.edit` takes: the kernel's commands and the add-ons' in force. */",
    `export type EditCommand =\n${commands.join("\n")};`,
    KIT_PRELUDE,
    `export interface ScriptContext {\n  readonly kind: "part" | "layout" | "route";\n${ctx.map(member).join("\n")}\n}`,
    `export interface PartBuilder {\n${builder.map(member).join("\n")}\n}`,
    ...top.map((e) => `/** ${e.summary} */\nexport declare ${e.signature};`),
    ...namespaces.map(([ns, entries]) => `export declare const ${ns}: {\n${entries.map(member).join("\n")}\n};`),
    "}",
    "",
  ].join("\n");
}

/** The reference as plain markdown, for agents and people outside a host app. */
export function referenceMarkdown(): string {
  const out: string[] = [
    "# MutinyBIM script kit reference",
    "",
    "Generated from the kit and the kernel's command schemas. A script imports only `@permitzip/bim-script`, reads only what it declares, and returns edits or part types; nothing lands until a person approves it.",
    "",
    "Workflow: reference → write → check → run (preview) → Approve.",
    "",
    "## Start here: whole example scripts",
    "",
    `Copy one and change it. Each runs as one bim_run_script → check → apply; the files are in \`${KIT_EXAMPLES_PATH}\`.`,
    "",
    ...KIT_EXAMPLES.map((x) => `- **${x.title}** (\`${x.name}\`): ${x.builds}`),
    "",
    "## Recipes",
    "",
  ];
  for (const r of KIT_RECIPES) out.push(`### ${r.name}`, "", r.summary, "", ...r.steps.map((s, i) => `${i + 1}. ${s}`), "", `Uses: ${r.uses.map((u) => `\`${u}\``).join(", ")}`, "");
  out.push("## Kit functions", "");
  for (const e of KIT_ENTRIES) out.push(`### \`${e.name}\``, "", e.summary, "", "```ts", e.signature, "```", "", "```ts", e.example.trimEnd(), "```", "");
  out.push("## Commands (`ctx.edit`)", "");
  for (const c of scriptCommands()) {
    const f = commandFields(c.type);
    out.push(`### \`${c.type}\`${c.from === "kernel" ? "" : ` (${c.from})`}`, "", ...(f?.fields ?? []).map((l) => `- ${l}`), "");
  }
  return out.join("\n");
}
