import { elementsOfKind, pushTo, type ModelState, type PartInstance, type PartTypeElement } from "@permitzip/bim-kernel";
import type { ElectricalOneLineNode, ElectricalOneLineSpec, OneLineEquipmentKind } from "./one-line-layout";

/**
 * A one-line description from the model's own electrical equipment (moved
 * from the kernel in round 12): every placed part in the electrical equipment
 * category becomes a piece of equipment, named by its panel name (or mark),
 * rated from its type and instance values, and hung under the equipment its
 * "fed from" value names. What can't be placed in the tree is reported, not
 * guessed.
 */

export interface OneLineFromModel {
  readonly spec: ElectricalOneLineSpec | null;
  readonly equipment: number;
  readonly linked: number;
  /** Equipment whose "fed from" names nothing in the model. */
  readonly unmatchedFedFrom: ReadonlyArray<{ readonly name: string; readonly fedFrom: string }>;
  /** Equipment with no "fed from" (drawn at the top). */
  readonly roots: readonly string[];
  /** Kinds read from the part type's names. */
  readonly kindsFromNames: ReadonlyArray<{ readonly name: string; readonly kind: OneLineEquipmentKind }>;
}

const KIND_WORDS: ReadonlyArray<readonly [RegExp, OneLineEquipmentKind]> = [
  [/switchboard|swbd/i, "switchboard"],
  [/motor control|\bmcc\b/i, "mcc"],
  [/transfer switch|\bats\b/i, "ats"],
  [/transformer|xfmr/i, "transformer"],
  [/generator|genset/i, "generator"],
  [/panel/i, "panelboard"],
  [/fused/i, "fused_disconnect"],
  [/disconnect|safety switch/i, "disconnect"],
  [/variable frequency|\bvfd\b/i, "vfd"],
  [/\bups\b|uninterruptible/i, "ups"],
  [/meter/i, "meter"],
  [/motor/i, "motor"],
];

function value(part: PartInstance, type: PartTypeElement, key: string): string | number | null {
  const v = part.values[key] ?? type.definition.typeValues?.[key];
  return typeof v === "string" || typeof v === "number" ? v : null;
}

function ratings(part: PartInstance, type: PartTypeElement): string[] {
  const out: string[] = [];
  const amps = value(part, type, "bus_rating") ?? value(part, type, "amps") ?? value(part, type, "rating");
  const volts = value(part, type, "voltage");
  const phases = value(part, type, "phases");
  const kva = value(part, type, "kva");
  const first = [amps !== null ? `${amps}A` : null, volts !== null ? `${volts}V` : null, phases !== null ? `${phases}Ø` : null, kva !== null ? `${kva} kVA` : null].filter(Boolean).join(", ");
  if (first) out.push(first);
  const mains = value(part, type, "mains");
  const aic = value(part, type, "aic");
  const second = [typeof mains === "string" && mains ? mains : null, typeof aic === "number" ? `${Math.round(aic / 1000)} kAIC` : null].filter(Boolean).join(", ");
  if (second) out.push(second);
  return out;
}

export function oneLineSpecFromModel(model: ModelState): OneLineFromModel {
  type Entry = { part: PartInstance; type: PartTypeElement; name: string; kind: OneLineEquipmentKind; fedFrom: string };
  const entries: Entry[] = [];
  const kindsFromNames: Array<{ name: string; kind: OneLineEquipmentKind }> = [];
  for (const el of elementsOfKind(model.elements, "part")) {
    if ("deleted" in el && el.deleted) continue;
    const type = model.elements[el.typeId];
    if (!type || type.kind !== "part_type" || type.definition.category !== "electrical_equipment") continue;
    const panelName = value(el, type, "panel_name");
    const name = (typeof panelName === "string" && panelName.trim()) || el.mark || type.definition.typeName;
    const words = `${type.definition.familyName} ${type.definition.typeName}`;
    const kind = KIND_WORDS.find(([re]) => re.test(words))?.[1] ?? "equipment";
    kindsFromNames.push({ name, kind });
    const fed = value(el, type, "fed_from");
    entries.push({ part: el, type, name, kind, fedFrom: typeof fed === "string" ? fed.trim() : "" });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.part.id.localeCompare(b.part.id));
  if (entries.length === 0) return { spec: null, equipment: 0, linked: 0, unmatchedFedFrom: [], roots: [], kindsFromNames };

  const byName = new Map<string, Entry>();
  for (const e of entries) {
    byName.set(e.name.toLowerCase(), e);
    if (e.part.mark) byName.set(e.part.mark.toLowerCase(), e);
  }
  const children = new Map<string, Entry[]>();
  const roots: Entry[] = [];
  const unmatched: Array<{ name: string; fedFrom: string }> = [];
  for (const e of entries) {
    const parent = e.fedFrom ? byName.get(e.fedFrom.toLowerCase()) : undefined;
    if (parent && parent !== e) pushTo(children, parent.part.id, e);
    else {
      if (e.fedFrom) unmatched.push({ name: e.name, fedFrom: e.fedFrom });
      roots.push(e);
    }
  }
  const ids = new Map(entries.map((e, i) => [e.part.id, `eq${i + 1}`]));
  const seen = new Set<string>();
  const node = (e: Entry): ElectricalOneLineNode => {
    seen.add(e.part.id);
    const kids = (children.get(e.part.id) ?? []).filter((k) => !seen.has(k.part.id));
    const kind: OneLineEquipmentKind = (e.kind === "motor" || e.kind === "equipment") && kids.length > 0 ? "panelboard" : e.kind;
    return {
      id: ids.get(e.part.id) ?? e.part.id,
      kind,
      name: e.name,
      ...(ratings(e.part, e.type).length ? { ratings: ratings(e.part, e.type) } : {}),
      ...(kids.length ? { children: kids.map(node) } : {}),
    };
  };
  const rootNodes = roots.map(node);
  // A "fed from" loop leaves equipment unreached: draw it at the top so it is seen.
  for (const e of entries) if (!seen.has(e.part.id)) rootNodes.push(node(e));
  return {
    // More than 8 separate trees means "fed from" is mostly missing: a drawing of loose boxes helps nobody.
    spec: rootNodes.length <= 8 ? { title: "Electrical one-line diagram", roots: rootNodes } : null,
    equipment: entries.length,
    linked: entries.length - roots.length,
    unmatchedFedFrom: unmatched,
    roots: roots.map((r) => r.name),
    kindsFromNames,
  };
}
