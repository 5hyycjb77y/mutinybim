/**
 * Reading the discipline registry of the pack set in force: labels, parents,
 * coverage, and whether a writer may store an id. One table per set
 * (`PackSet.memo`), so a lookup is a map read (`kernel.discipline.lookup`).
 *
 * Readers are tolerant: any registry-shaped id reads, and an id this set
 * doesn't know is labelled from its words. Writers are strict: an id must be
 * one of the six every peer stores, or a row this model's add-ons, packs or
 * firm library register (`disciplineWriteProblem`).
 */
import { isRegistryIdShape, rawRegistryWords } from "../ids";
import { activePackSet } from "../packs/scope";
import { installedFirstPartyPacks, type PackSet } from "../packs/set";
import { CLASS_DISCIPLINES } from "../registry/types";
import { DISCIPLINE_POINT, type DisciplineDef } from "./types";

/** The four class disciplines peers store behind `partition:class_disciplines` (round 5c). */
export const CLASS_DISCIPLINE_EXTRAS: readonly string[] = Object.freeze(["civil", "general_contracting", "documentation", "general"]);

/** The six disciplines every peer has stored since round 1: the ten class disciplines but the four extras. Always writable; their rows add labels and display only. */
export const FROZEN_DISCIPLINE_IDS: readonly string[] = Object.freeze(CLASS_DISCIPLINES.filter((d) => !CLASS_DISCIPLINE_EXTRAS.includes(d)));

const FROZEN: ReadonlySet<string> = new Set(FROZEN_DISCIPLINE_IDS);
const EXTRAS: ReadonlySet<string> = new Set(CLASS_DISCIPLINE_EXTRAS);

interface DisciplineTable {
  readonly rows: readonly DisciplineDef[];
  readonly byId: ReadonlyMap<string, DisciplineDef>;
  /** Ancestors nearest first, self excluded; a parent cycle or a missing parent stops the walk. */
  readonly ancestors: ReadonlyMap<string, readonly string[]>;
  readonly children: ReadonlyMap<string, readonly string[]>;
}

function buildTable(set: PackSet): DisciplineTable {
  const rows = set.items(DISCIPLINE_POINT);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const ancestors = new Map<string, readonly string[]>();
  const children = new Map<string, string[]>();
  for (const row of rows) {
    const chain: string[] = [];
    const seen = new Set([row.id]);
    let parent = row.parent;
    while (parent !== undefined && !seen.has(parent)) {
      chain.push(parent);
      seen.add(parent);
      parent = byId.get(parent)?.parent;
    }
    ancestors.set(row.id, Object.freeze(chain));
    if (row.parent !== undefined) {
      const list = children.get(row.parent) ?? [];
      list.push(row.id);
      children.set(row.parent, list);
    }
  }
  return { rows, byId, ancestors, children };
}

function table(set: PackSet = activePackSet()): DisciplineTable {
  return set.memo("kernel.discipline#table", () => buildTable(set));
}

/** Every registered discipline in the set in force: built-in rows, then add-ons and packs, then the firm's. */
export function listDisciplines(set?: PackSet): readonly DisciplineDef[] {
  return table(set).rows;
}

/** Where a registered discipline comes from, for listing (Settings › MutinyBIM library › Disciplines). */
export type DisciplineSource = { readonly kind: "builtin" } | { readonly kind: "addon"; readonly packId: string; readonly packName: string; readonly firstParty: boolean } | { readonly kind: "firm" };

export interface ListedDiscipline {
  readonly row: DisciplineDef;
  readonly source: DisciplineSource;
}

/** Every registered discipline with where it comes from, in registry order. */
export function listDisciplinesWithSource(set: PackSet = activePackSet()): readonly ListedDiscipline[] {
  return set.memo("kernel.discipline#listed", () => {
    const builtin = new Set((DISCIPLINE_POINT.builtins?.() ?? []).map((r) => r.id));
    const firm = new Set(set.firmItems(DISCIPLINE_POINT).map((r) => r.id));
    const owner = new Map<string, DisciplineSource>();
    for (const pack of [...installedFirstPartyPacks(), ...set.packs]) {
      for (const c of pack.contributions) {
        if (c.pointId !== DISCIPLINE_POINT.id || !c.idOf) continue;
        for (const item of c.items) owner.set(c.idOf(item), { kind: "addon", packId: pack.manifest.id, packName: pack.manifest.name, firstParty: pack.manifest.firstParty === true });
      }
    }
    return table(set).rows.map((row): ListedDiscipline => {
      if (builtin.has(row.id)) return { row, source: { kind: "builtin" } };
      if (firm.has(row.id)) return { row, source: { kind: "firm" } };
      return { row, source: owner.get(row.id) ?? { kind: "builtin" } };
    });
  });
}

/** The registered row for a stored id, or null when this set doesn't know it. */
export function disciplineDef(id: string, set?: PackSet): DisciplineDef | null {
  return table(set).byId.get(id) ?? null;
}

export function isRegisteredDiscipline(id: string, set?: PackSet): boolean {
  return table(set).byId.has(id);
}

/** A stored discipline in words: the registry's label, else the id's own words (`firm:site_work` → "Site work"). Never the raw id. */
export function disciplineLabel(id: string, set?: PackSet): string {
  return table(set).byId.get(id)?.label ?? rawRegistryWords(id);
}

/** The disciplines a stored id is part of, nearest first (`fire_alarm` → [`fire_protection`]). Empty for an unknown id. */
export function disciplineAncestors(id: string, set?: PackSet): readonly string[] {
  return table(set).ancestors.get(id) ?? [];
}

/** The registered children of a discipline (direct only). */
export function disciplineChildren(id: string, set?: PackSet): readonly string[] {
  return table(set).children.get(id) ?? [];
}

/** Whether `scope` covers a stored discipline `id`: the same id, or one of its ancestors (a Fire protection filter covers fire alarm). */
export function disciplineCovers(scope: string, id: string, set?: PackSet): boolean {
  return scope === id || disciplineAncestors(id, set).includes(scope);
}

/** The protocol feature a writer needs the peers to advertise before storing `id`; null for the six frozen ids. */
export function disciplineWriteFeature(id: string): "partition:class_disciplines" | "disciplines:registry" | null {
  if (FROZEN.has(id)) return null;
  return EXTRAS.has(id) ? "partition:class_disciplines" : "disciplines:registry";
}

/**
 * Why a writer may not store `id` on this model, in plain words, or null when
 * it may. The six frozen ids always pass; any other id must be registered in
 * the set in force. A refusal names where the discipline would come from.
 */
export function disciplineWriteProblem(id: string, set?: PackSet): string | null {
  if (FROZEN.has(id) || isRegisteredDiscipline(id, set)) return null;
  if (!isRegistryIdShape(id)) return `"${id}" isn't a discipline id (lower case letters, digits, _ . :)`;
  const words = rawRegistryWords(id);
  if (id.startsWith("firm:")) return `${words} isn't a discipline in this model's firm library. Add it in Settings › MutinyBIM library › Disciplines first`;
  const dot = id.indexOf(".");
  if (dot > 0) return `${words} comes from the ${id.slice(0, dot)} add-on, which this model doesn't use. Turn that add-on on for this model first`;
  return `${words} isn't a discipline this model knows`;
}
