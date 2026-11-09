import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildClassIndex, parameterOfParamDef, type BimElement, type FieldDef, type ModelState, type ParamDef, type ParamValue, type PartTypeDefinition, type Registry } from "@permitzip/bim-kernel";
import { KINDS, UNITS, convert, isUnitCode, unitAllowed, unitsFor } from "@permitzip/bim-units";
import { bimElementIdAlias } from "../support/tool-names";

/**
 * The one agent vocabulary across the bim_ tools (MIGRATION-PLAN §8,
 * KERNEL-AUDIT §6.3): an element is `element_id` wherever a tool names one
 * (older keys still accepted), and a quantity may come as `{ value, unit }`
 * with a bim-units code beside the bare numbers the tools already take.
 */

const element = z.string().min(1).max(200);

function isOptional(schema: z.core.$ZodType): boolean {
  return z.safeParse(schema, undefined).success;
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
type ToolConfig = { inputSchema?: z.ZodRawShape } & Record<string, unknown>;

function refusal(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Every tool in BIM_ELEMENT_ID_ALIASES advertises `element_id` beside its
 * older key (both optional, one required by the handler), and `element_id`
 * reaches the handler under the older key, so no handler changes. A tool not
 * in the map, or whose schema has no such required key, registers untouched.
 */
export function withElementIdAlias(server: McpServer): McpServer {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const registerTool = (name: string, config: ToolConfig, handler: Handler) => {
    const key = bimElementIdAlias(name);
    const shape = config.inputSchema;
    const legacy = key && shape ? shape[key] : undefined;
    if (!key || !shape || !legacy || "element_id" in shape || isOptional(legacy)) return register(name, config, handler);
    const { [key]: _legacy, ...rest } = shape;
    const inputSchema: z.ZodRawShape = { ...rest, element_id: element.optional(), [key]: z.optional(legacy) };
    return register(name, { ...config, inputSchema }, async (args: Record<string, unknown>, extra: unknown) => {
      const given = args.element_id;
      const old = args[key];
      if (given === undefined && old === undefined) return refusal(`Not sent: give element_id (or ${key}). Nothing changed.`);
      if (given !== undefined && old !== undefined && given !== old) return refusal(`Not sent: element_id ${String(given)} and ${key} ${String(old)} name different elements; give one. Nothing changed.`);
      const { element_id: _id, ...own } = args;
      return handler({ ...own, [key]: old ?? given }, extra);
    });
  };
  return new Proxy(server, {
    get: (target, prop) => {
      if (prop === "registerTool") return registerTool;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A number with its bim-units unit code, e.g. `{ value: 5.6, unit: "gpm/psi^0.5" }` or `{ value: 150, unit: "mm" }`. */
export const quantityInput = z.object({ value: z.number().finite(), unit: z.string() }).strict();

export type QuantityInput = z.infer<typeof quantityInput>;

export type PartValueInput = number | string | boolean | null | QuantityInput;

function isQuantity(v: PartValueInput): v is QuantityInput {
  return typeof v === "object" && v !== null;
}

/** `param.k_factor` (the registry's key for a part parameter) and `k_factor` name the same parameter. */
export function partParamName(key: string): string {
  return key.startsWith("param.") ? key.slice("param.".length) : key;
}

function paramsOf(def: PartTypeDefinition | undefined): readonly ParamDef[] {
  return def ? [...def.typeParams, ...def.instanceParams] : [];
}

const MM_PER_FT = 304.8;

/**
 * One value as the model stores it: a bare number on a length parameter is
 * feet (as before), any other bare value goes as given; `{ value, unit }` is
 * converted to the parameter's stored unit after checking the unit can say
 * that kind of quantity, else refused in words.
 */
export function partValueIn(def: PartTypeDefinition | undefined, typeLabel: string, name: string, v: PartValueInput): { readonly ok: true; readonly value: ParamValue | null } | { readonly ok: false; readonly message: string } {
  const p = paramsOf(def).find((x) => x.name === name);
  if (!isQuantity(v)) return { ok: true, value: typeof v === "number" && p?.kind === "length" ? v * MM_PER_FT : v };
  if (!p) {
    const names = paramsOf(def).map((x) => x.name);
    return { ok: false, message: `${typeLabel} has no parameter ${name}${names.length > 0 ? `; it takes ${names.slice(0, 20).join(", ")}` : ""}` };
  }
  const field = parameterOfParamDef(p, "instance");
  if (field.valueType !== "quantity" || !field.kind || !field.storedUnit) return { ok: false, message: `${name} (${p.label}) isn't a number with a unit; give it as a plain value` };
  const kind = field.kind;
  if (!isUnitCode(v.unit) || !unitAllowed(kind, v.unit)) {
    return { ok: false, message: `${name} (${p.label}) is ${KINDS[kind].label.toLowerCase()}; "${v.unit}" isn't a unit for it. Use ${unitsFor(kind).map((u) => UNITS[u].symbol || u).join(", ")}` };
  }
  return { ok: true, value: Math.round(convert(v.value, v.unit, field.storedUnit) * 1e6) / 1e6 };
}

/** Every value of a call as the model stores it, or the first refusal in words. */
export function partValuesIn(def: PartTypeDefinition | undefined, typeLabel: string, values: Readonly<Record<string, PartValueInput>>): { readonly ok: true; readonly values: Record<string, ParamValue | null> } | { readonly ok: false; readonly message: string } {
  const out: Record<string, ParamValue | null> = {};
  for (const [key, v] of Object.entries(values)) {
    const name = partParamName(key);
    const stored = partValueIn(def, typeLabel, name, v);
    if (!stored.ok) return stored;
    out[name] = stored.value;
  }
  return { ok: true, values: out };
}

/**
 * The parameter `key` names on an element, from the registries that define
 * parameters (the model's add-ons in scope, then the library): looked up on
 * the element's explicit class, then the classes the registry recognises it
 * as, so a value given with a unit converts to the unit the parameter stores.
 */
export function elementParameter(registries: readonly Registry[], model: Pick<ModelState, "elements">, el: BimElement, key: string): FieldDef | undefined {
  const explicit = "classId" in el && typeof el.classId === "string" ? [el.classId] : [];
  for (const registry of registries) {
    const classes = el.kind === "element_type" ? explicit : [...explicit, ...buildClassIndex(registry, model).classesOf(el.id)];
    for (const c of classes) {
      const field = registry.field(c, key);
      if (field) return field;
    }
  }
  return undefined;
}

/** One `{ value, unit }` as the parameter stores it, or the refusal in words. */
export function quantityForField(field: FieldDef | undefined, key: string, where: string, q: QuantityInput): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  if (!field) return { ok: false, message: `${key} isn't a parameter defined for ${where}, so a value with a unit can't be converted; give a key bim_schedule_fields lists for its class, or a plain value` };
  const stored = field.storedUnit ?? field.unit;
  if (field.valueType !== "quantity" || !field.kind || !stored) return { ok: false, message: `${key} (${field.label}) isn't a number with a unit; give it as a plain value` };
  if (!isUnitCode(q.unit) || !unitAllowed(field.kind, q.unit)) {
    return { ok: false, message: `${key} (${field.label}) is ${KINDS[field.kind].label.toLowerCase()}; "${q.unit}" isn't a unit for it. Use ${unitsFor(field.kind).map((u) => UNITS[u].symbol || u).join(", ")}` };
  }
  return { ok: true, value: Math.round(convert(q.value, q.unit, stored) * 1e6) / 1e6 };
}

/**
 * The values of a bim_set_element call as stored, the same for every element
 * named: plain values go as given; `{ value, unit }` converts per the
 * parameter's definition on each element (refused when two store it in
 * different units).
 */
export function elementValuesIn(
  registries: readonly Registry[],
  model: Pick<ModelState, "elements">,
  targets: readonly BimElement[],
  values: Readonly<Record<string, PartValueInput>>,
  whereFor: (el: BimElement) => string,
): { readonly ok: true; readonly values: Record<string, ParamValue | null> } | { readonly ok: false; readonly message: string } {
  const out: Record<string, ParamValue | null> = {};
  for (const [key, v] of Object.entries(values)) {
    if (!isQuantity(v)) {
      out[key] = v;
      continue;
    }
    let value: number | null = null;
    for (const el of targets) {
      const converted = quantityForField(elementParameter(registries, model, el, key), key, whereFor(el), v);
      if (!converted.ok) return converted;
      if (value !== null && value !== converted.value) return { ok: false, message: `${key} is stored in different units on these elements; set them in separate calls` };
      value = converted.value;
    }
    if (value !== null) out[key] = value;
  }
  return { ok: true, values: out };
}
