import { defineExtensionPoint } from "../packs/contract";
import type { ObjectClass } from "../registry/types";
import type { BimElement, ElementId, Level, ParamValue, Partition } from "../types";
import { KERNEL_IMPORT_RULES } from "./rules";
import type { ImportGroup, ImportProduct, ImportRuleResult } from "./types";

/**
 * How a class's instances come in from a linked model (contract 1.7.0,
 * `kernel.ifc_import_rule` v1). The importer never decides what a product
 * becomes: it finds the class whose IFC home the product matches (the
 * reverse class map) and asks that class's rule. A class names its rule in
 * `ifc.import.rule`; without one it takes the rule registered for the kind it
 * recognises (`forKinds`). The kernel's rules read only geometry and the
 * class's own recognition fields, so any trade's class of those kinds comes
 * in with no kernel or importer edit, and an add-on registers rules for its
 * own kinds or classes the same way.
 */
export interface ImportRuleContext {
  /** The class the product resolved to. */
  readonly cls: ObjectClass;
  /** Fields the class's recognition fixes (`openingType`, `domain`, `classId`…), to write on the record. */
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  /** The class's `ifc.import.options`. */
  readonly options: Readonly<Record<string, string | number | boolean>>;
  /** The element id a product (and an optional suffix for a second record) becomes. Stable for a source. */
  idFor(sourceId: string, suffix?: string): ElementId;
  /** The level the product's storey maps to (the nearest level when it has none). */
  level(product: ImportProduct): Level | null;
  /** Where a record of this class on that level lives. */
  partition(level: Level): Partition;
  /** A record another product already became in this import (a door's host wall), or an element of the model. */
  converted(sourceId: string): BimElement | null;
  /** A group the file assigns products to (a distribution system). */
  group(sourceId: string): ImportGroup | null;
  /** A record several products share (their type, their system), made once per key. */
  shared<T extends BimElement>(key: string, make: () => T | string): T | string;
  /** Values the registry maps from the product's property sets (`ifc` homes on the class's fields), by parameter key. */
  values(product: ImportProduct): Readonly<Record<string, ParamValue>>;
  /** What every record remembers: the GlobalId and the linked model version. */
  provenance(product: ImportProduct): { readonly ifcGlobalId: string; readonly source: string };
  /** A note for the report ("Door D-12's swing wasn't brought in"), once per text. */
  note(text: string): void;
}

export interface ImportRuleDef {
  /** `kernel.<name>` for the kernel's; `<pack>.<name>` for an add-on's. */
  readonly id: string;
  readonly label: string;
  /** Classes recognised as these element kinds take this rule unless they name another. */
  readonly forKinds?: readonly string[];
  /** Lower runs first (hosts before what they host). Absent: 10. */
  readonly order?: number;
  convert(product: ImportProduct, ctx: ImportRuleContext): ImportRuleResult;
}

export const IFC_IMPORT_RULE_POINT = defineExtensionPoint<ImportRuleDef>({
  id: "kernel.ifc_import_rule",
  version: 1,
  label: "IFC import rules",
  idOf: (rule) => rule.id,
  builtins: () => KERNEL_IMPORT_RULES,
});

/** Problems with import-rule rows, in words (pack conformance). */
export function importRuleRowProblems(items: readonly ImportRuleDef[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.label.trim().length === 0) out.push(`import rule ${item.id} has no label`);
    if (item.order !== undefined && !Number.isFinite(item.order)) out.push(`import rule ${item.id} has an order that isn't a number`);
  }
  return out;
}
