import { paramValue } from "../parts";
import type { BimElement, ParamValue, PartInstance } from "../types";
import type { FieldScalar } from "./resolver";

/**
 * `param.<name>` on a part: any parameter, as stored (a formula parameter
 * evaluated), for every trade. Hops that end on a parameter (`panel.param.x`)
 * belong to the row that knows the hop.
 */

type Elements = Readonly<Record<string, BimElement>>;

function raw(elements: Elements, part: PartInstance, name: string): ParamValue | undefined {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return part.values[name];
  try {
    return paramValue(type.definition, part.values, name);
  } catch (err) {
    console.error("[fields] a parameter formula failed; the field reads empty", { partId: part.id, name, err });
    return undefined;
  }
}

function scalar(v: ParamValue | undefined): FieldScalar {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v;
  return null;
}

const num = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

function segments(path: string): string[] {
  return path.split(".").map((s) => s.trim()).filter(Boolean);
}

/** Whether a path is `param.<name>`. */
export function isParamFieldPath(path: string): boolean {
  const raw = path.split(".").map((s) => s.trim());
  return raw.length >= 2 && raw[0] === "param" && !raw.some((s) => s === "");
}

/** `param.<name>` of a part, or null when the element isn't a part or the path isn't a parameter path. */
export function resolveParamField(elements: Elements, elementId: string, path: string): { readonly value: FieldScalar; readonly text: string } | null {
  const part = elements[elementId];
  if (part?.kind !== "part") return null;
  // This row asks before every trade's: most paths it sees are not parameter paths, so skip the split for them.
  if (!path.includes("param")) return null;
  const segs = segments(path);
  if (segs[0] !== "param" || segs.length < 2) return null;
  const v = scalar(raw(elements, part, segs.slice(1).join(".")));
  return { value: v, text: v === null ? "" : typeof v === "number" ? num(v) : String(v) };
}
