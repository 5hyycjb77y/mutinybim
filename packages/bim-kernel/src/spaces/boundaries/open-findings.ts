import { findingRefId, findingSubjects, findingWords, type FindingRef } from "../../findings/ref";
import { registerBuiltinFindingSource, type FindingReadContext, type FindingSourceRow } from "../../findings/sources/point";
import type { BimElement, Vec2 } from "../../types";
import { boxOf } from "../space-geometry";
import { openBoundedSpaces } from "../space-index";
import type { Space } from "../types";
import { boundingElementRow } from "./rows";

/**
 * "Rooms no longer closed": a bounded space whose walls opened after an
 * edit (`bounds.open`, written by `follow.ts`). It keeps its last outline;
 * the finding names the side that opened, lists the space and the element
 * that changed so Select finds both, and points at Undo.
 */

export const SPACE_NOT_CLOSED_SOURCE = "space_not_closed";

type Elements = Readonly<Record<string, BimElement>>;

/** Which side of the outline a point is nearest, in compass words (+y is north). */
export function sideWords(outline: readonly Vec2[], at: Vec2): string {
  if (outline.length === 0) return "";
  const b = boxOf(outline);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const dx = (at.x - cx) / Math.max((b.maxX - b.minX) / 2, 1);
  const dy = (at.y - cy) / Math.max((b.maxY - b.minY) / 2, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "east" : "west";
  return dy >= 0 ? "north" : "south";
}

function nounOf(elements: Elements, id: string | undefined): string {
  const el = id ? elements[id] : undefined;
  const label = (el ? boundingElementRow(el.kind)?.label : undefined) ?? "wall";
  const noun = label.toLowerCase();
  return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
}

/** A room the way people say it: "Office 101". */
function roomWords(space: Space): string {
  return [space.name, space.number].filter((s) => s.trim() !== "").join(" ") || "A room";
}

/** The words of one open space's finding. */
export function notClosedWords(elements: Elements, space: Space): string | null {
  if (space.bounds.kind !== "bounded" || !space.bounds.open) return null;
  const open = space.bounds.open;
  return `${roomWords(space)} is no longer closed: ${nounOf(elements, open.elementId)} was moved or removed near the ${sideWords(space.bounds.outline, open.near)} side`;
}

function refOf(elements: Elements, space: Space, ctx: FindingReadContext): FindingRef | null {
  const words = notClosedWords(elements, space);
  if (words === null || space.bounds.kind !== "bounded") return null;
  const culprit = space.bounds.open?.elementId;
  return {
    id: findingRefId(SPACE_NOT_CLOSED_SOURCE, space.id),
    source: { kind: SPACE_NOT_CLOSED_SOURCE, id: space.id, version: "1" },
    severity: "warning",
    subjects: findingSubjects([space.id, ...(culprit ? [culprit] : [])]),
    lineageId: ctx.lineageId,
    revision: ctx.model.revision,
    words: findingWords(words),
    fix: { commandHint: "undo" },
  };
}

export const SPACE_NOT_CLOSED_FINDING_SOURCE: FindingSourceRow = {
  id: SPACE_NOT_CLOSED_SOURCE,
  label: "Rooms no longer closed by their walls",
  all: (ctx) => openBoundedSpaces(ctx.model.elements).flatMap((s) => {
    const ref = refOf(ctx.model.elements, s, ctx);
    return ref ? [ref] : [];
  }),
  changed: (ctx) => (ctx.changedIds.some((id) => ctx.model.elements[id]?.kind === "space" || ctx.previous.elements[id]?.kind === "space") ? "reread" : null),
};

registerBuiltinFindingSource(SPACE_NOT_CLOSED_FINDING_SOURCE);
