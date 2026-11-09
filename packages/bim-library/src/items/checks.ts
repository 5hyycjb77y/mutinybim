import { partTypeIssues, readPartCategory, type PartTypeDefinition, type StoredPartTypeDefinition } from "@permitzip/bim-kernel";
import type { LibraryItem } from "../schema";
import { SCRIPT_KINDS, scriptSourceIssues, type ScriptItem, type ScriptParameter, type ScriptValue } from "./script";

/** The definition as the kernel's checks read it: an add-on category it doesn't know behaves as generic. */
export function checkableDefinition(def: StoredPartTypeDefinition): PartTypeDefinition {
  return { ...def, category: readPartCategory(def.category)?.behavesAs ?? "generic" };
}

/** Plain-words problems with a part type or script item beyond its schema; empty when it is fine. Other item types: none here. */
export function libraryItemIssues(item: LibraryItem): string[] {
  if (item.type === "part_type") return partTypeIssues(checkableDefinition(item.body.definition)).map((i) => `${i.field}: ${i.message}`);
  if (item.type === "script") return scriptItemIssues(item.body);
  return [];
}

function scriptItemIssues(script: ScriptItem): string[] {
  const out = scriptSourceIssues(script.source).map((m) => `Its source ${m}`);
  if (!(SCRIPT_KINDS as readonly string[]).includes(script.manifest.kind)) out.push(`is a "${script.manifest.kind}" script, which this kit doesn't know (it knows ${SCRIPT_KINDS.join(", ")}).`);
  if (script.language !== "typescript") out.push(`is written in "${script.language}", which this kit doesn't run (it runs typescript).`);
  for (const [name, p] of Object.entries(script.manifest.parameters)) for (const m of parameterIssues(p)) out.push(`Its parameter ${name} ${m}`);
  for (const preset of script.manifest.presets) {
    for (const [name, value] of Object.entries(preset.values)) {
      const p = script.manifest.parameters[name];
      if (!p) out.push(`Its preset ${preset.id} sets ${name}, which isn't one of its parameters.`);
      else for (const m of valueIssues(p, value)) out.push(`Its preset ${preset.id}: ${name} ${m}`);
    }
  }
  return out;
}

function parameterIssues(p: ScriptParameter): string[] {
  const out: string[] = [];
  if ((p.type === "quantity" || p.type === "number") && p.min !== undefined && p.max !== undefined && p.min > p.max) out.push(`has a minimum above its maximum.`);
  if ("default" in p && p.default !== undefined) out.push(...valueIssues(p, p.default).map((m) => `default ${m}`));
  return out;
}

/** What is wrong with one value for one parameter, in words; empty when it fits. */
export function valueIssues(p: ScriptParameter, value: ScriptValue): string[] {
  switch (p.type) {
    case "quantity":
    case "number":
      if (typeof value !== "number") return [`must be a number.`];
      if (p.type === "number" && p.integer && !Number.isInteger(value)) return [`must be a whole number.`];
      if (p.min !== undefined && value < p.min) return [`is ${value}, below the minimum ${p.min}${p.type === "quantity" ? " (SI)" : ""}.`];
      if (p.max !== undefined && value > p.max) return [`is ${value}, above the maximum ${p.max}${p.type === "quantity" ? " (SI)" : ""}.`];
      return [];
    case "choice":
      return typeof value === "string" && p.choices.some((c) => c.value === value) ? [] : [`must be one of ${p.choices.map((c) => c.value).join(", ")}.`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`must be true or false.`];
    case "text":
      if (typeof value !== "string") return [`must be text.`];
      return p.maxLength !== undefined && value.length > p.maxLength ? [`is longer than ${p.maxLength} characters.`] : [];
    case "part_type":
      return typeof value === "string" && value.length > 0 ? [] : [`must name a part type.`];
  }
}
