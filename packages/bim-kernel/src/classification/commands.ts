import { z } from "zod";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { elementName, isCoreElement } from "../elements/feature";
import { TrackedReader } from "../model";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { classificationWritable, OLDER_PEER } from "../qto/feature";
import type { ClassificationAssignment } from "../qto/types";
import type { Ceiling } from "../ceilings/types";
import type { CoreElement } from "../elements/feature";
import type { ElementTypeElement } from "../types";
import { readCode } from "./registry";
import { storedClassification } from "./resolve";

/**
 * Set or clear a classification code on element types and instances. One
 * code per system per record; an instance's code for a system wins over its
 * type's (`resolve.ts`). A code a loaded list doesn't know is kept as typed
 * and named in the summary (Nielsen 9), never dropped. Never touches a
 * design value. Refused while the model server doesn't store codes yet.
 */

const id = z.string().trim().min(1).max(200);
/** `firm:cost_codes`, a pack's `acme.cost_codes`. */
const systemId = z.string().trim().min(1).max(96).regex(/^[a-z][a-z0-9_]*[:.][a-z0-9][a-z0-9_.]*$/, "a code list id (firm:cost_codes, acme.cost_codes)");
const code = z.string().trim().min(1).max(64);
const MAX_IDS = 500;

export const classificationCommandSchemas = [
  z.object({ type: z.literal("set_classification"), elementIds: z.array(id).min(1).max(MAX_IDS), system: systemId, code }).strict(),
  z.object({ type: z.literal("clear_classification"), elementIds: z.array(id).min(1).max(MAX_IDS), system: systemId }).strict(),
] as const;

export const classificationCommandSchema = z.discriminatedUnion("type", [...classificationCommandSchemas]);
export type ClassificationCommand = z.infer<typeof classificationCommandSchema>;

const TYPES: ReadonlySet<string> = new Set(classificationCommandSchemas.map((s) => s.shape.type.value));

export function isClassificationCommand(command: { readonly type: string }): command is ClassificationCommand {
  return TYPES.has(command.type);
}

type Classifiable = CoreElement | Ceiling | ElementTypeElement;

function isClassifiable(el: BimElement): el is Classifiable {
  return isCoreElement(el) || el.kind === "ceiling" || el.kind === "element_type";
}

function nameOf(el: Classifiable): string {
  if (el.kind === "ceiling") return `Ceiling ${el.id}`;
  return elementName(el);
}

/** The same record with only `classification` changed. */
function withCodes(el: Classifiable, codes: readonly ClassificationAssignment[]): Classifiable {
  if (codes.length > 0) return { ...el, classification: codes };
  const next = { ...el };
  delete next.classification;
  return next;
}

/** A stable text of a record's codes, for conflict detection. */
function fingerprint(codes: readonly ClassificationAssignment[]): string {
  return codes.map((c) => `${c.system}=${c.code}`).join(";");
}

export function executeClassificationCommand(model: ModelState, command: ClassificationCommand): ExecuteResult {
  return guard(() => {
    const reader = new TrackedReader(model);
    const working = draftElements(model.elements);
    const touched: ElementId[] = [];
    const authored: AuthoredWrite[] = [];
    const summary: string[] = [];
    if (!classificationWritable()) refuse("invalid_value", `Classification codes ${OLDER_PEER}`);
    for (const raw of new Set(command.elementIds)) {
      const key = asElementId(raw);
      const el = reader.find(key);
      if (!el) refuse("element_not_found", `There is no element ${raw} to classify. Pick it again`, [key]);
      if (!isClassifiable(el)) refuse("wrong_kind", `A ${el.kind.replace(/_/g, " ")} doesn't take a cost code. Classify the building element or its type instead`, [key]);
      const prior = storedClassification(el);
      const others = prior.filter((c) => c.system !== command.system);
      const next = command.type === "set_classification" ? [...others, { system: command.system, code: command.code.trim() }] : others;
      if (fingerprint(next) === fingerprint(prior)) continue;
      working[key] = withCodes(el, next);
      touched.push(key);
      authored.push({ elementId: key, field: "classification", value: fingerprint(next) });
      if (command.type === "set_classification") {
        const read = readCode(command.system, command.code.trim());
        summary.push(`${nameOf(el)}: ${read.systemLabel} ${command.code.trim()}${read.label ? ` ${read.label}` : ""}`);
        if (read.warning) summary.push(read.warning);
      } else summary.push(`${nameOf(el)}: no ${readCode(command.system, "-").systemLabel} code`);
    }
    return finish(reader, working, touched, authored, () => [], { summary });
  });
}
