import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Command families behind one read. A tool whose argument is a family of
 * commands (drawn shapes, modify operations, a static diagram) advertises a
 * short form, and its full schema is read on demand with
 * `bim_describe_commands`, the `comcheck_describe_schema` pattern. Every
 * schema is re-sent on every agent step; a family nobody uses this turn
 * shouldn't cost thousands of tokens each time.
 *
 * The handler still parses with the full schema: a call that doesn't fit is
 * answered with the path, what is wrong and the exact fields of the command
 * it named, so one retry fixes it with or without the read.
 */

// No import from the runtime: tool files import this module while their host composer is still loading them.
function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export interface CommandFamily<T> {
  readonly tool: string;
  readonly field: string;
  /** What the family is, in plain words. */
  readonly label: string;
  /** The full schema of one value (for an array field: one item). */
  readonly schema: z.ZodType<T>;
  /** The key that names a variant (`shape`, `op`), for a discriminated union. */
  readonly discriminator?: string;
}

type AnyFamily = CommandFamily<unknown>;

const FAMILIES = new Map<string, AnyFamily>();

function key(tool: string, field: string): string {
  return `${tool}.${field}`;
}

/** Declare a family once, at module load, beside the tool that takes it. */
export function commandFamily<T>(family: CommandFamily<T>): CommandFamily<T> {
  FAMILIES.set(key(family.tool, family.field), family as AnyFamily);
  return family;
}

/** The families a tool takes, or every family. */
export function commandFamilies(tool?: string): readonly AnyFamily[] {
  return [...FAMILIES.values()].filter((f) => !tool || f.tool === tool).sort((a, b) => key(a.tool, a.field).localeCompare(key(b.tool, b.field)));
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSchemaOf(schema: z.ZodType): JsonObject {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  const { $schema: _drop, ...rest } = out as JsonObject;
  return rest;
}

/** The union's branches as JSON Schema, keyed by the discriminator's value. */
function variantsOf(family: AnyFamily): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  if (!family.discriminator) return out;
  const root = jsonSchemaOf(family.schema);
  const branches = [...(Array.isArray(root.oneOf) ? root.oneOf : []), ...(Array.isArray(root.anyOf) ? root.anyOf : [])];
  for (const branch of branches) {
    if (!isRecord(branch) || !isRecord(branch.properties)) continue;
    const tag = branch.properties[family.discriminator];
    const value = isRecord(tag) ? (tag.const ?? (Array.isArray(tag.enum) ? tag.enum[0] : undefined)) : undefined;
    if (typeof value === "string") out.set(value, branch);
  }
  return out;
}

/** The variant names a family offers, in declaration order. */
export function familyVariants(family: AnyFamily): string[] {
  return [...variantsOf(family).keys()];
}

/** What `bim_describe_commands` answers for one family, or one of its variants. */
export function describeFamily(family: AnyFamily, variant?: string): JsonObject | string {
  if (!variant) {
    const variants = familyVariants(family);
    return {
      tool: family.tool,
      field: family.field,
      label: family.label,
      ...(variants.length > 0 ? { [family.discriminator ?? "variant"]: variants, next: `Ask for one: bim_describe_commands({ tool: "${family.tool}", field: "${family.field}", variant: "<${family.discriminator}>" }).` } : { schema: jsonSchemaOf(family.schema) }),
    };
  }
  const found = variantsOf(family).get(variant);
  if (!found) return `${family.tool} ${family.field} has no ${family.discriminator ?? "variant"} "${variant}". It has: ${familyVariants(family).join(", ")}.`;
  return { tool: family.tool, field: family.field, [family.discriminator ?? "variant"]: variant, schema: found };
}

export type FamilyParse<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string };

function variantName(family: AnyFamily, value: unknown): string | null {
  if (!family.discriminator || !isRecord(value)) return null;
  const v = value[family.discriminator];
  return typeof v === "string" ? v : null;
}

/**
 * Parse one value of a family with its full schema. A misfit names the path
 * (`items[2].center`), what is wrong, and the exact fields the named variant
 * takes.
 */
export function parseFamilyValue<T>(family: CommandFamily<T>, value: unknown, path: string): FamilyParse<T> {
  const parsed = family.schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.slice(0, 6).map((i) => `${[path, ...i.path.map(String)].join(".")}: ${i.message}`);
  const name = variantName(family, value);
  const exact = name ? describeFamily(family as AnyFamily, name) : null;
  const fields = isRecord(exact) && isRecord(exact.schema) && isRecord(exact.schema.properties) ? Object.keys(exact.schema.properties).join(", ") : null;
  const hint = fields ? ` ${family.discriminator} "${name}" takes: ${fields}.` : ` bim_describe_commands({ tool: "${family.tool}", field: "${family.field}" }) lists every ${family.discriminator ?? "form"}.`;
  return { ok: false, message: `Those arguments don't fit ${family.tool}: ${issues.join("; ")}.${hint} Nothing was sent.` };
}

/** Parse an array field item by item. */
export function parseFamilyArray<T>(family: CommandFamily<T>, values: readonly unknown[], path: string): FamilyParse<T[]> {
  const out: T[] = [];
  for (const [i, value] of values.entries()) {
    const one = parseFamilyValue(family, value, `${path}[${i}]`);
    if (!one.ok) return one;
    out.push(one.data);
  }
  return { ok: true, data: out };
}

/**
 * The short form a tool advertises for one family value: the variant key
 * with its names, any other fields allowed, and where the exact fields are.
 */
export function advertisedVariant(family: CommandFamily<unknown>, variants: readonly [string, ...string[]], summary: string) {
  const discriminator = family.discriminator ?? "kind";
  return z
    .object({ [discriminator]: z.enum(variants) })
    .catchall(z.unknown())
    .describe(`${summary} Exact fields: bim_describe_commands.`);
}

export function registerBimDescribeCommandsTool(server: McpServer): void {
  server.registerTool(
    "bim_describe_commands",
    {
      title: "Describe a tool's commands",
      description:
        "The exact fields of a command family a MutinyBIM tool advertises in short form (bim_draw_detail items, bim_modify_detail operation, bim_set_system_design pipe_design and fittings, bim_route_run system_kind and from / to, bim_save_electrical_type entry, bim_preview_one_line / bim_layout_one_line diagram and hints). With only tool: its families; with field: its variants or schema; with variant: that one's schema. Reads no model; free.",
      inputSchema: {
        tool: z.string().min(1).max(64),
        field: z.string().min(1).max(64).optional(),
        variant: z.string().min(1).max(64).optional(),
      },
    },
    async (args) => {
      const families = commandFamilies(args.tool);
      if (families.length === 0) {
        const tools = [...new Set(commandFamilies().map((f) => f.tool))];
        return failure(`${args.tool} has no command families; its listed schema is complete. Tools with families: ${tools.join(", ")}.`);
      }
      if (!args.field) {
        return text({ tool: args.tool, families: families.map((f) => ({ field: f.field, label: f.label, ...(f.discriminator ? { [f.discriminator]: familyVariants(f) } : {}) })) });
      }
      const family = families.find((f) => f.field === args.field);
      if (!family) return failure(`${args.tool} has no family "${args.field}". It has: ${families.map((f) => f.field).join(", ")}.`);
      const out = describeFamily(family, args.variant);
      return typeof out === "string" ? failure(out) : text(out);
    },
  );
}
