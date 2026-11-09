import type { FieldDef, FieldReader, FieldValue, FieldWriter } from "../../registry/types";
import { resolveField, type FieldOptions } from "../resolver";

/** A field as a provider declares it; the registry stamps the source. */
export type ProviderField = Omit<FieldDef, "source">;

export const locked = (reason: string, sourceRef?: string): FieldWriter => (sourceRef === undefined ? { kind: "none", reason } : { kind: "none", reason, sourceRef });
export const instanceParam = (name: string): FieldWriter => ({ kind: "parameter", scope: "instance", name });
export const typeParam = (name: string): FieldWriter => ({ kind: "parameter", scope: "type", name });
export const command = (name: string, argument: string): FieldWriter => ({ kind: "command", command: name, argument });

export const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const textOrNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === "" ? null : v);

/** A number the shared resolver reads (fields/resolver.ts): the same value a tag or the one-line prints, in the field's unit. */
export function resolvedNumber(path: string, opts: FieldOptions = {}): FieldReader {
  return (el, ctx): FieldValue => finite(resolveField(ctx.elements, el.id, path, opts).value);
}

/** Text the shared resolver prints for a path; null when it prints nothing. */
export function resolvedText(path: string, opts: FieldOptions = {}): FieldReader {
  return (el, ctx): FieldValue => textOrNull(resolveField(ctx.elements, el.id, path, opts).text);
}
