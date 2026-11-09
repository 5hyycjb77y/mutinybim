import { fieldProviderRegistry } from "../fields/providers";
import { fieldPaths, type FieldPathInfo } from "../fields/resolver";
import { recognizes } from "../registry/recognition";
import type { Registry } from "../registry/types";
import type { ElementId, ModelState } from "../types";
import { SERVICE_HOP, serviceOf } from "./render";

/**
 * What the block editor's field picker offers: every field the shared
 * resolver answers on the element the token reads, plus every field the
 * registry has on that element's classes (so a provider's new totals appear
 * without a change here). Service tokens read the service entrance.
 */

export interface BlockFieldChoice {
  /** The token to insert, without braces: "service.connected_kva". */
  readonly path: string;
  readonly label: string;
  readonly group: string;
  /** What it prints right now on this model, "" when nothing. */
  readonly example: string;
}

const PANEL_ON: ReadonlySet<FieldPathInfo["on"]> = new Set(["panel", "any"]);

function registryChoices(registry: Registry, model: Pick<ModelState, "elements">, id: ElementId, prefix: string, seen: Set<string>): BlockFieldChoice[] {
  const el = model.elements[id];
  if (!el) return [];
  const out: BlockFieldChoice[] = [];
  for (const cls of registry.listClasses({ includeAbstract: true })) {
    if (!recognizes(cls, el, model.elements)) continue;
    for (const f of registry.fieldsFor(cls.id)) {
      const path = `${prefix}${f.path}`;
      if (seen.has(path) || !f.read) continue;
      seen.add(path);
      out.push({ path, label: f.unit ? `${f.label} (${f.unit})` : f.label, group: f.group ?? cls.label, example: "" });
    }
  }
  return out;
}

/** Field choices for a block with this subject (absent: the project's service). */
export function blockFieldChoices(model: Pick<ModelState, "elements">, subjectId: ElementId | undefined, registry: Registry = fieldProviderRegistry()): BlockFieldChoice[] {
  const seen = new Set<string>();
  const out: BlockFieldChoice[] = [];
  const service = serviceOf(model, subjectId);
  const fromResolver = (prefix: string, on: (f: FieldPathInfo) => boolean, group: string) => {
    for (const f of fieldPaths()) {
      const path = `${prefix}${f.path}`;
      if (!on(f) || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, label: f.label, group, example: f.example });
    }
  };
  if (service) {
    fromResolver(`${SERVICE_HOP}.`, (f) => PANEL_ON.has(f.on), "Service");
    out.push(...registryChoices(registry, model, service, `${SERVICE_HOP}.`, seen));
  }
  if (subjectId !== undefined && subjectId !== service) {
    fromResolver("", () => true, "This element");
    out.push(...registryChoices(registry, model, subjectId, "", seen));
  }
  return out;
}
