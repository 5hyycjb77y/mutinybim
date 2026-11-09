import { pushTo } from "../../collections";
import { normalizeLevelName } from "../../levels";
import { loadPointPosition } from "../../load-points/model";
import { pointInOutline } from "../../propose/perimeter";
import { elementsOfKind } from "../../store";
import { DEFAULT_PARTITION, type BimElement, type Level, type Room, type Vec2 } from "../../types";

/**
 * Which level and room an element is in. A leaf: it imports no field
 * resolver, provider or plumbing module at runtime, so domain code
 * (`plumbing/stacks.ts`) can ask without a cycle through the field system.
 */

type Elements = Readonly<Record<string, BimElement>>;

const levelsByName = new WeakMap<Elements, ReadonlyMap<string, Level>>();

function levelNamed(elements: Elements, name: string): Level | null {
  let index = levelsByName.get(elements);
  if (!index) {
    const map = new Map<string, Level>();
    for (const l of elementsOfKind(elements, "level")) {
      map.set(normalizeLevelName(l.name), l);
      map.set(l.id, l);
    }
    index = map;
    levelsByName.set(elements, index);
  }
  return index.get(normalizeLevelName(name)) ?? index.get(name) ?? null;
}

/** Its own level id, else its geometric placement's (a wall, slab or column placed on a level). */
function ownLevelId(el: BimElement): string | null {
  if ("levelId" in el && typeof el.levelId === "string") return el.levelId;
  const placement = "placement" in el ? el.placement : undefined;
  return placement && typeof placement === "object" && "levelId" in placement && typeof placement.levelId === "string" && placement.levelId !== "" ? placement.levelId : null;
}

/** The level an element is on: its level id or placement's, a load point's host's, an opening's wall's, else the level its partition names (or ids). */
export function levelOf(elements: Elements, el: BimElement): Level | null {
  if (el.kind === "level") return null;
  // A planned part's levelId is a placeholder; only its level hint says where it will go.
  if (el.kind === "part" && el.planned) {
    const hint = el.planned.levelHint ? elements[el.planned.levelHint] : undefined;
    return hint?.kind === "level" ? hint : null;
  }
  let id = ownLevelId(el);
  if (!id && el.kind === "load_point") id = loadPointPosition(elements, el)?.levelId ?? null;
  if (!id && el.kind === "opening") {
    const host = elements[el.hostId];
    if (host) return levelOf(elements, host);
  }
  if (id) {
    const lvl = elements[id];
    if (lvl?.kind === "level") return lvl;
  }
  const named = el.partition?.level;
  return named ? levelNamed(elements, named) : null;
}

const mid = (a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The plan point that says which room an element is in. */
function anchorOf(elements: Elements, el: BimElement): Vec2 | null {
  switch (el.kind) {
    case "part":
      // Not placed yet: no plan point (its room comes from its space hint, through in_space).
      return el.planned ? null : el.position;
    case "opening":
    case "column":
      return el.position;
    case "load_point": {
      const p = loadPointPosition(elements, el)?.point;
      return p ? { x: p.x, y: p.y } : null;
    }
    case "run_segment":
    case "wall":
    case "beam":
      return mid(el.start, el.end);
    default:
      return null;
  }
}

/** The key rooms are grouped by: their level's normalized name. */
const floorKey = (elements: Elements, el: BimElement): string | null => {
  const lvl = levelOf(elements, el);
  return lvl ? normalizeLevelName(lvl.name) : el.partition ? normalizeLevelName(el.partition.level) : null;
};

const roomsByFloor = new WeakMap<Elements, ReadonlyMap<string, readonly Room[]>>();

function roomsOn(elements: Elements, key: string): readonly Room[] {
  let index = roomsByFloor.get(elements);
  if (!index) {
    const map = new Map<string, Room[]>();
    for (const r of elementsOfKind(elements, "room")) {
      const k = floorKey(elements, r) ?? normalizeLevelName(DEFAULT_PARTITION.level);
      pushTo(map, k, r);
    }
    index = map;
    roomsByFloor.set(elements, index);
  }
  return index.get(key) ?? [];
}

/** The room an element stands in: a room on its level whose outline holds its plan point. */
export function roomOf(elements: Elements, el: BimElement): Room | null {
  if (el.kind === "room") return null;
  const at = anchorOf(elements, el);
  const key = floorKey(elements, el);
  if (!at || key === null) return null;
  return roomsOn(elements, key).find((r) => pointInOutline(at, r.outline)) ?? null;
}
