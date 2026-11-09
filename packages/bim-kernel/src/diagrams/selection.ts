import type { PackRefusal } from "../packs/points";
import type { ElementId, ModelState, ViewElement } from "../types";
import { evaluateDiagram, type DiagramEvaluation } from "./evaluate";

/**
 * Diagram ↔ model selection (contract 1.11.0, built round 14). A live
 * diagram's drawn entries read both ways: click a symbol or a drawn run on
 * any add-on's diagram and its model elements are selected; select
 * an element in a plan and every entry drawn from it lights up. Each entry is
 * one click target: a piece of equipment (`node:<element>`) or a drawn run
 * (`piece:<element>`, standing for every element the run was drawn from; a
 * second run drawn from the same element but standing for others is
 * `piece:<element>~2`).
 *
 * The map is indexed once per drawing (an evaluation is itself cached per
 * model and view), from the drawing's own boxes: never a model scan, and the
 * same for every add-on's diagram kind.
 */

export interface DiagramSelectionEntry {
  /** Stable for the same model and hints: `node:<element>`, `piece:<element>` (`~2`, `~3`… for another run from it). */
  readonly id: string;
  /** What a click selects. */
  readonly elementId: ElementId;
  readonly name: string;
  /** Every model element the entry stands for, the clicked one first. */
  readonly modelIds: readonly ElementId[];
  /** Indexes into the evaluation's `boxes` that draw this entry. */
  readonly boxes: readonly number[];
}

export interface DiagramSelectionIndex {
  readonly entries: readonly DiagramSelectionEntry[];
  entry(entryId: string): DiagramSelectionEntry | undefined;
  /** The entry the evaluation's box at `index` draws. */
  entryOfBox(index: number): DiagramSelectionEntry | undefined;
  /** The entries drawn from any of `modelIds` (what a model selection lights). */
  entriesFor(modelIds: Iterable<string>): readonly DiagramSelectionEntry[];
}

const indexes = new WeakMap<DiagramEvaluation, DiagramSelectionIndex>();

function build(evaluation: DiagramEvaluation): DiagramSelectionIndex {
  const byId = new Map<string, { elementId: ElementId; name: string; ids: Set<ElementId>; boxes: number[] }>();
  const bySignature = new Map<string, string>();
  const runsFrom = new Map<ElementId, number>();
  const boxEntry: string[] = [];
  evaluation.boxes.forEach((box, i) => {
    const signature = box.pipe ? `piece\u0000${box.elementId}\u0000${box.pipe.elementIds.join("\u0000")}` : `node\u0000${box.elementId}`;
    let id = bySignature.get(signature);
    if (id === undefined) {
      if (box.pipe) {
        const n = (runsFrom.get(box.elementId) ?? 0) + 1;
        runsFrom.set(box.elementId, n);
        id = n === 1 ? `piece:${box.elementId}` : `piece:${box.elementId}~${n}`;
      } else id = `node:${box.elementId}`;
      bySignature.set(signature, id);
      byId.set(id, { elementId: box.elementId, name: box.name, ids: new Set([box.elementId, ...(box.pipe?.elementIds ?? [])]), boxes: [] });
    }
    byId.get(id)?.boxes.push(i);
    boxEntry.push(id);
  });
  const entries: DiagramSelectionEntry[] = [];
  const byModel = new Map<string, DiagramSelectionEntry[]>();
  for (const [id, e] of byId) {
    const entry: DiagramSelectionEntry = { id, elementId: e.elementId, name: e.name, modelIds: [...e.ids], boxes: e.boxes };
    entries.push(entry);
    for (const m of entry.modelIds) {
      const list = byModel.get(m);
      if (list) list.push(entry);
      else byModel.set(m, [entry]);
    }
  }
  const lookup = new Map(entries.map((e) => [e.id, e] as const));
  return {
    entries,
    entry: (entryId) => lookup.get(entryId),
    entryOfBox: (index) => {
      const entryId = boxEntry[index];
      return entryId === undefined ? undefined : lookup.get(entryId);
    },
    entriesFor: (modelIds) => {
      const out = new Set<DiagramSelectionEntry>();
      for (const m of modelIds) for (const e of byModel.get(m) ?? []) out.add(e);
      return [...out];
    },
  };
}

/** The selection map of one drawing, built on first use and kept with it. */
export function diagramSelectionIndex(evaluation: DiagramEvaluation): DiagramSelectionIndex {
  const known = indexes.get(evaluation);
  if (known) return known;
  const made = build(evaluation);
  indexes.set(evaluation, made);
  return made;
}

function liveDiagram(model: ModelState, diagramId: ElementId): { readonly view: ViewElement; readonly index: DiagramSelectionIndex } | PackRefusal {
  const view = model.elements[diagramId];
  if (view?.kind !== "view" || view.deleted) return { refused: `There is no view ${diagramId} in the model` };
  const evaluation = evaluateDiagram(model.elements, view);
  if (!evaluation) return { refused: `${view.name} isn't a live diagram, so nothing on it stands for model elements` };
  return { view, index: diagramSelectionIndex(evaluation) };
}

/** The model elements a diagram entry stands for (the clicked one first), or why there are none. */
export function modelIdsOf(model: ModelState, diagramId: ElementId, entryId: string): readonly ElementId[] | PackRefusal {
  const live = liveDiagram(model, diagramId);
  if ("refused" in live) return live;
  const entry = live.index.entry(entryId);
  return entry ? entry.modelIds : { refused: `That symbol isn't on ${live.view.name} any more: what it stood for was removed or is no longer drawn there` };
}

/** The entries of a diagram drawn from a model element (none when it isn't drawn there), or why the diagram can't say. */
export function diagramEntriesOf(model: ModelState, diagramId: ElementId, modelId: ElementId): readonly string[] | PackRefusal {
  const live = liveDiagram(model, diagramId);
  if ("refused" in live) return live;
  return live.index.entriesFor([modelId]).map((e) => e.id);
}
