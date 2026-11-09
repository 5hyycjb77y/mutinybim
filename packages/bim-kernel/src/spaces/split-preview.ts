import { loadPointLabel } from "../load-points/model";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Vec2 } from "../types";
import { regionsOf, type FaceFound, type WalkSegment } from "./boundaries/face-walk";
import { childrenOf } from "./nesting";
import { outlineAreaMm2, MM2_PER_M2 } from "./space-geometry";
import type { Space } from "./types";

/**
 * What "Split space" would make before anything is written: the sub-rooms a
 * line cuts a bounded room into (west to east) with their areas, and the
 * room's loads that aren't by area, which the split dialog asks about one by
 * one. `split_space` cuts the same regions.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const SUB_ROOM_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface SplitRegion extends FaceFound {
  readonly inside: Vec2;
}

export interface SplitPreviewChild {
  readonly letter: string;
  /** "101A". */
  readonly number: string;
  readonly areaM2: number;
  readonly outline: readonly Vec2[];
}

export interface SplitPreviewLoad {
  readonly id: ElementId;
  readonly label: string;
}

export type SplitPreview =
  | { readonly ok: true; readonly room: string; readonly children: readonly SplitPreviewChild[]; readonly typedLoads: readonly SplitPreviewLoad[]; readonly byAreaLoads: number }
  | { readonly ok: false; readonly message: string };

/** A room the way people say it: "Office 101". */
export function roomWords(s: Pick<Space, "name" | "number">): string {
  return [s.name, s.number].filter((t) => t.trim() !== "").join(" ") || "This room";
}

/** The regions a line cuts a bounded room's outline into, west to east (then south to north). Fewer than two: it doesn't cross. */
export function splitRegions(parent: Space, line: { readonly start: Vec2; readonly end: Vec2 }, separatorId: string): SplitRegion[] {
  if (parent.bounds.kind !== "bounded") return [];
  const o = parent.bounds.outline;
  const edges: WalkSegment[] = o.map((p, i) => ({ elementId: parent.id, start: p, end: o[(i + 1) % o.length] as Vec2 }));
  return regionsOf([...edges, { elementId: separatorId as ElementId, start: line.start, end: line.end }])
    .filter((r) => r.boundary.some((ref) => ref.elementId === separatorId))
    .sort((x, y) => x.inside.x - y.inside.x || x.inside.y - y.inside.y);
}

export function previewSplit(elements: Elements, spaceId: ElementId, line: { readonly start: Vec2; readonly end: Vec2 }): SplitPreview {
  const parent = elements[spaceId];
  if (parent?.kind !== "space") return { ok: false, message: `There is no space ${spaceId}` };
  const room = roomWords(parent);
  if (parent.bounds.kind !== "bounded") return { ok: false, message: `Split works on a room found from its walls. Make ${room} from its walls first (Room from walls), then split it` };
  const kids = childrenOf(elements, parent.id);
  if (kids.length > 0) return { ok: false, message: `${room} is already split. Split one of its sub-rooms, or merge it back first` };
  const regions = splitRegions(parent, line, `${parent.id}:line`);
  if (regions.length < 2) return { ok: false, message: `That line doesn't cross ${room} from one side to the other. Draw it from wall to wall` };
  const loads = elementsOfKind(elements, "load_point").filter((lp) => lp.anchor?.kind === "space" && lp.anchor.id === parent.id);
  return {
    ok: true,
    room,
    children: regions.map((r, i) => {
      const letter = SUB_ROOM_LETTERS[i] as string;
      return { letter, number: `${parent.number}${letter}`, areaM2: outlineAreaMm2(r.outline) / MM2_PER_M2, outline: r.outline };
    }),
    typedLoads: loads.filter((lp) => lp.basis !== "density").map((lp) => ({ id: lp.id, label: loadPointLabel(elements, lp) })),
    byAreaLoads: loads.filter((lp) => lp.basis === "density").length,
  };
}
