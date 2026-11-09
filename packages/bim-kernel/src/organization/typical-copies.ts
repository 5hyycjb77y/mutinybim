import { elementsOfKind } from "../store";
import type { BimElement, ModelState, PartInstance, Vec2 } from "../types";
import { organizationOf, type TypicalCopy, type TypicalSpec } from "./model";
import { copyPoint, typicalCount } from "./typicals";

/**
 * Typical copies as places, for checks that depend on where a copy lands
 * (F6, per-copy lint): the copy's transform, a stable name for "this element
 * as it stands in copy 002", the parts a typical holds, and the contract's
 * cap on how many typical types a project has (STATUS decision 15).
 *
 * Copies are not elements, so a check about copy 002 names it with a virtual
 * id `<group>#<copy mark>/<element>`; the original reads as the element's own
 * id. Readers that select or zoom use `parseVirtualCopyId` to get back to the
 * element and the copy.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** One instance of a typical: the original (`copy` null) or a copy. */
export interface TypicalInstance {
  readonly mark: string;
  readonly copy: TypicalCopy | null;
}

/** Every instance, the original first. */
export function typicalInstances(spec: TypicalSpec): TypicalInstance[] {
  return [{ mark: spec.mark, copy: null }, ...spec.copies.map((c) => ({ mark: c.mark, copy: c }))];
}

/** Where a plan point of the original lands in an instance (unchanged in the original). */
export function instancePoint(spec: TypicalSpec, instance: TypicalInstance, p: Vec2): Vec2 {
  return instance.copy ? copyPoint(spec, instance.copy, p) : p;
}

/** How far an instance is turned from the original, degrees. */
export function instanceRotationDeg(instance: TypicalInstance): number {
  return instance.copy?.rotationDeg ?? 0;
}

/** Whether an instance is a mirror image of the original (contract 1.10.0). */
export function instanceMirror(instance: TypicalInstance): "x" | "y" | null {
  return instance.copy?.mirror?.axis ?? null;
}

const VIRTUAL = /^(.+)#([^#/]+)\/(.+)$/;

/** "This element as it stands in copy 002": `<group>#<mark>/<element>`. The original is the element's own id. */
export function virtualCopyId(groupId: string, instance: TypicalInstance, elementId: string): string {
  return instance.copy ? `${groupId}#${instance.mark}/${elementId}` : elementId;
}

/** The element and copy a virtual id names, or null for a plain element id. */
export function parseVirtualCopyId(id: string): { readonly groupId: string; readonly mark: string; readonly elementId: string } | null {
  const m = VIRTUAL.exec(id);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { groupId: m[1], mark: m[2], elementId: m[3] };
}

const partsByTypical = new WeakMap<object, ReadonlyMap<string, readonly PartInstance[]>>();

/**
 * The placed parts in each typical with copies, once per model state: one
 * pass over the parts (read by kind), never the whole model, and only when a
 * check asks. Planned parts have no place yet and are left out.
 */
export function partsOfTypical(elements: Elements, groupId: string): readonly PartInstance[] {
  let index = partsByTypical.get(elements);
  if (!index) {
    const typicals = new Set<string>();
    for (const g of organizationOf({ elements, connections: [] }).groups) if (g.entry.typical && g.entry.typical.copies.length > 0) typicals.add(g.id);
    const map = new Map<string, PartInstance[]>();
    if (typicals.size > 0) {
      for (const p of elementsOfKind(elements, "part")) {
        if (!p.groupId || !typicals.has(p.groupId) || p.planned !== undefined) continue;
        let list = map.get(p.groupId);
        if (!list) map.set(p.groupId, (list = []));
        list.push(p);
      }
    }
    index = map;
    partsByTypical.set(elements, index);
  }
  return index.get(groupId) ?? [];
}

export interface TypicalCapStatus {
  /** Typical types in the project (groups that repeat, whatever their copy count). */
  readonly count: number;
  /** How many the contract covers. */
  readonly cap: number;
  readonly over: boolean;
  /** "This project has 11 typicals; the contract covers 10", or null within the cap. */
  readonly message: string | null;
  /** The typical groups, in group order. */
  readonly groupIds: readonly string[];
}

/** How many typical types the project has against the contract's cap (a setting, default 10). */
export function typicalCapStatus(model: Pick<ModelState, "elements" | "connections">): TypicalCapStatus {
  const org = organizationOf(model);
  const groupIds = org.groups.filter((g) => g.entry.typical !== undefined).map((g) => g.id);
  const count = groupIds.length;
  const cap = org.typicalCap;
  const over = count > cap;
  return { count, cap, over, message: over ? `This project has ${count} typicals; the contract covers ${cap}` : null, groupIds };
}

/** "24 instances (001 and 23 copies)". */
export function typicalInstancesText(spec: TypicalSpec): string {
  const n = typicalCount(spec);
  const copies = spec.copies.length;
  return `${n} ${n === 1 ? "instance" : "instances"} (${spec.mark} and ${copies} ${copies === 1 ? "copy" : "copies"})`;
}
