import { z } from "zod";
import { canonicalJson } from "../canonical";
import { finish, refuse, type ExecuteResult, type IntentPredicate } from "../command-core";
import { TrackedReader, requireKind } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { partTypeDefinitionSchema, partTypeIssues, resolveConnectors, type PartTypeDefinition } from "../parts";
import { draftElements, elementValues } from "../store";
import { asElementId, type ElementId, type ModelState, type PartInstance, type PartTypeElement } from "../types";

/**
 * The project library: part types in the model. `save_part_types` writes one
 * or more types (usually every size of one part definition) in one change.
 * Placed parts follow their type at once. It refuses when a placed part has a
 * run connected to a connector the new definition would remove or move, so a
 * library edit never leaves a duct pointing at nothing.
 */

export const MAX_TYPES_PER_SAVE = 200;

export const partModelCommandSchemas = [
  z.object({
    type: z.literal("save_part_types"),
    /** What the save does, in words, for the approval card and history. */
    label: z.string().trim().min(1).max(160).optional(),
    types: z
      .array(z.object({ typeId: z.string().min(1).max(200), definition: partTypeDefinitionSchema }))
      .min(1)
      .max(MAX_TYPES_PER_SAVE),
  }),
] as const;

export type PartModelCommand = z.infer<(typeof partModelCommandSchemas)[number]>;

export function isPartModelCommand(command: { readonly type: string }): command is PartModelCommand {
  return command.type === "save_part_types";
}

const NO_INTENTS = (): IntentPredicate[] => [];
const MOVE_TOLERANCE_MM = 0.5;

function placedParts(model: ModelState, typeIds: ReadonlySet<string>): PartInstance[] {
  const out: PartInstance[] = [];
  for (const el of elementValues(model.elements)) if (el.kind === "part" && typeIds.has(el.typeId)) out.push(el);
  return out;
}

/** The first connected run a definition change would strand, as a plain reason. */
function strandedRun(part: PartInstance, before: PartTypeDefinition, after: PartTypeDefinition): string | null {
  const links = part.links ?? {};
  if (Object.keys(links).length === 0) return null;
  const was = new Map(resolveConnectors(before, part.values).map((c) => [c.id, c]));
  const now = new Map(resolveConnectors(after, part.values).map((c) => [c.id, c]));
  const name = part.mark || part.id;
  for (const connectorId of Object.keys(links)) {
    const a = was.get(connectorId);
    const b = now.get(connectorId);
    if (!b) return `${name} has a run connected to ${a?.label ?? connectorId}, which the new definition removes`;
    if (a && Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) > MOVE_TOLERANCE_MM) {
      return `${name} has a run connected to ${b.label}, which the new definition moves`;
    }
    if (a && (a.domain !== b.domain || a.shape !== b.shape)) return `${name} has a run connected to ${b.label}, which the new definition changes from ${a.domain} ${a.shape} to ${b.domain} ${b.shape}`;
  }
  return null;
}

function savePartTypes(model: ModelState, command: PartModelCommand): ExecuteResult {
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [];
  const seen = new Set<string>();
  const replaced = new Map<string, { before: PartTypeDefinition; after: PartTypeDefinition }>();
  let created = 0;
  for (const { typeId, definition } of command.types) {
    const id = asElementId(typeId);
    if (seen.has(typeId)) refuse("invalid_value", `${typeId} is listed twice in this save`, [id]);
    seen.add(typeId);
    const first = partTypeIssues(definition)[0];
    if (first) refuse("invalid_value", `${definition.typeName}: ${first.message}`, [id]);
    const existing = reader.find(id);
    if (existing) {
      const type = requireKind(existing, "part_type");
      if (canonicalJson(type.definition) === canonicalJson(definition)) continue;
      replaced.set(typeId, { before: type.definition, after: definition });
      working[id] = { ...type, definition };
    } else {
      const type: PartTypeElement = { id, kind: "part_type", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, definition };
      working[id] = type;
      created++;
    }
    touched.push(id);
  }
  if (touched.length === 0) refuse("invalid_value", "Nothing to change: the project library already has these types exactly");
  let affected = 0;
  if (replaced.size > 0) {
    for (const part of placedParts(model, new Set(replaced.keys()))) {
      reader.get(part.id);
      affected++;
      const change = replaced.get(part.typeId);
      const why = change ? strandedRun(part, change.before, change.after) : null;
      if (why) refuse("has_dependents", `Nothing saved: ${why}. Disconnect the run or keep that connector where it is.`, [part.id, asElementId(part.typeId)]);
    }
  }
  const summary = [
    created > 0 ? `Added ${created} type${created === 1 ? "" : "s"} to the project library` : "",
    replaced.size > 0 ? `Updated ${replaced.size} type${replaced.size === 1 ? "" : "s"}${affected > 0 ? `; ${affected} placed part${affected === 1 ? "" : "s"} redraw` : ""}` : "",
  ].filter(Boolean);
  return finish(reader, working, touched, [], NO_INTENTS, { summary });
}

export function executePartModelCommand(model: ModelState, command: PartModelCommand): ExecuteResult {
  return savePartTypes(model, command);
}
