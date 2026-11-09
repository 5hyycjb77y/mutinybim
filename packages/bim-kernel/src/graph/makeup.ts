import { boundingElementRow } from "../spaces/boundaries/rows";
import { spaceAreaM2 } from "../spaces/space-geometry";
import { spaceAt } from "../spaces/space-index";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Vec2 } from "../types";
import { listWords, nameOf } from "./names";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Room makeup (REQUIREMENTS-GRAPH §1, the fire-protection review): a requirement
 * anchored to a space re-opens when the walls that bound the space, the
 * openings in them, its ceiling or the obstructions in it change. Which
 * spaces an element touches is read from the space index (a plan-grid
 * lookup on either side of a wall, at an element's point), never a scan.
 *
 * A ceiling change re-opens only what reads the ceiling (`ceiling.*`); a
 * wall, opening or obstruction change re-opens everything anchored to the
 * space, because the room itself is no longer what was studied.
 */

export type MakeupRole = "wall" | "opening" | "ceiling" | "obstruction";

const OBSTRUCTION_KINDS: ReadonlySet<string> = new Set(["beam", "column", "component", "run_segment"]);

/** How an element takes part in a room's makeup, or null. */
export function makeupRole(el: BimElement | undefined): MakeupRole | null {
  if (!el) return null;
  if (el.kind === "wall") return "wall";
  if (el.kind === "opening") return "opening";
  if (el.kind === "ceiling") return "ceiling";
  return OBSTRUCTION_KINDS.has(el.kind) ? "obstruction" : null;
}

const levelsByName = new WeakMap<Elements, ReadonlyMap<string, ElementId>>();

/** A wall's or beam's level, from its partition's level name (or a level id written there). */
function levelOf(elements: Elements, el: BimElement): ElementId | null {
  if ("levelId" in el && typeof el.levelId === "string") return el.levelId;
  const name = el.partition?.level;
  if (!name) return null;
  if (elements[name]?.kind === "level") return name as ElementId;
  let map = levelsByName.get(elements);
  if (!map) {
    const m = new Map<string, ElementId>();
    for (const l of elementsOfKind(elements, "level")) m.set(l.name, l.id);
    map = m;
    levelsByName.set(elements, map);
  }
  return map.get(name) ?? null;
}

function segmentSpaces(elements: Elements, levelId: ElementId, a: Vec2, b: Vec2, offset: number): ElementId[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  const nx = -dy / len;
  const ny = dx / len;
  const out = new Set<ElementId>();
  for (const t of [0.25, 0.5, 0.75]) {
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    for (const s of [1, -1]) {
      const hit = spaceAt(elements, levelId, { x: px + nx * offset * s, y: py + ny * offset * s });
      if (hit) out.add(hit.id);
    }
  }
  return [...out];
}

function pointOf(el: BimElement): Vec2 | null {
  if ("position" in el && el.position && typeof el.position === "object" && "x" in el.position) return { x: el.position.x, y: el.position.y };
  if ("start" in el && "end" in el && el.start && el.end) return { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 };
  return null;
}

/** The spaces an element is part of the makeup of, in `elements` (the before or the after model). */
export function spacesTouchedBy(elements: Elements, el: BimElement): ElementId[] {
  switch (el.kind) {
    case "space":
      return [el.id];
    case "wall": {
      const level = levelOf(elements, el);
      return level ? segmentSpaces(elements, level, el.start, el.end, el.thickness / 2 + 150) : [];
    }
    case "opening": {
      const host = elements[el.hostId];
      return host?.kind === "wall" ? spacesTouchedBy(elements, host) : [];
    }
    case "ceiling": {
      if (el.spaceId) return [el.spaceId];
      const first = el.outline[0];
      if (!first) return [];
      const c = el.outline.reduce((acc, p) => ({ x: acc.x + p.x / el.outline.length, y: acc.y + p.y / el.outline.length }), { x: 0, y: 0 });
      const hit = spaceAt(elements, el.levelId, c);
      return hit ? [hit.id] : [];
    }
    default: {
      if (!OBSTRUCTION_KINDS.has(el.kind)) return [];
      const level = levelOf(elements, el);
      const at = pointOf(el);
      if (!level || !at) return [];
      const hit = spaceAt(elements, level, at);
      return hit ? [hit.id] : [];
    }
  }
}

/** The lowest height of a ceiling's surface over its outline, mm above its level. */
export function ceilingLowMm(el: Extract<BimElement, { kind: "ceiling" }>): number {
  if (!el.slope || el.slope.pitch === 0) return el.heightMm;
  const ref = el.reference ?? el.outline[0] ?? { x: 0, y: 0 };
  const rad = (el.slope.directionDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  let low = el.heightMm;
  for (const p of el.outline) low = Math.min(low, el.heightMm + el.slope.pitch * ((p.x - ref.x) * ux + (p.y - ref.y) * uy));
  return low;
}

/**
 * What happened to one element, in words, from where a person stands in the
 * space: "ceiling in Room 104 lowered", "walls W-12 and W-13 removed".
 */
export function makeupChangeWords(before: BimElement | undefined, after: BimElement | undefined, spaceLabel: string): string {
  const el = after ?? before;
  if (!el) return `something in ${spaceLabel} changed`;
  const role = makeupRole(el);
  if (role === "ceiling") {
    const b = before?.kind === "ceiling" ? before : undefined;
    const a = after?.kind === "ceiling" ? after : undefined;
    if (!b) return `ceiling added in ${spaceLabel}`;
    if (!a) return `ceiling in ${spaceLabel} removed`;
    const lb = ceilingLowMm(b);
    const la = ceilingLowMm(a);
    if (la < lb - 0.5) return `ceiling in ${spaceLabel} lowered`;
    if (la > lb + 0.5) return `ceiling in ${spaceLabel} raised`;
    if (a.form !== b.form) return `ceiling in ${spaceLabel} became ${a.form.replace(/_/g, " ")}`;
    return `ceiling in ${spaceLabel} changed`;
  }
  const name = nameOf(el);
  const noun = role === "wall" ? "wall" : role === "opening" ? "" : el.kind.replace(/_/g, " ");
  const what = noun ? `${noun} ${name}` : name;
  if (!after) return `${what} ${role === "wall" ? "bounding" : "in"} ${spaceLabel} removed`;
  if (!before) return `${what} added ${role === "wall" ? "around" : "in"} ${spaceLabel}`;
  return `${what} ${role === "wall" ? "bounding" : "in"} ${spaceLabel} changed`;
}

/** Several removed (or added, or changed) walls around one space, in one sentence: "walls W-12, W-13 and W-14 bounding Office 101 removed". */
export function groupedMakeupWords(changes: readonly { readonly before: BimElement | undefined; readonly after: BimElement | undefined }[], spaceLabel: string): string {
  const walls = changes.filter((c) => (c.after ?? c.before)?.kind === "wall");
  const others = changes.filter((c) => (c.after ?? c.before)?.kind !== "wall");
  const parts: string[] = [];
  const byVerb = new Map<string, string[]>();
  for (const c of walls) {
    const verb = !c.after ? "removed" : !c.before ? "added" : "changed";
    const list = byVerb.get(verb) ?? [];
    list.push(nameOf(c.after ?? c.before));
    byVerb.set(verb, list);
  }
  for (const [verb, names] of byVerb) parts.push(`${names.length === 1 ? "wall" : "walls"} ${listWords(names)} ${verb === "added" ? "added around" : "bounding"} ${spaceLabel}${verb === "added" ? "" : ` ${verb}`}`);
  for (const c of others) parts.push(makeupChangeWords(c.before, c.after, spaceLabel));
  return parts.join("; ");
}

const m2 = (v: number): string => `${Math.round(v * 10) / 10} m²`;

/**
 * A space bounded by walls whose area an edit changed, named from the
 * element that moved it: "Wall W-12 moved: Office 101's area changed from
 * 24 m² to 26 m²". Null when the space isn't bounded or its area held.
 */
export function boundedAreaWords(before: Elements, after: Elements, spaceId: string, changes: readonly { readonly before: BimElement | undefined; readonly after: BimElement | undefined }[]): string | null {
  const b = before[spaceId];
  const a = after[spaceId];
  if (b?.kind !== "space" || a?.kind !== "space" || a.bounds.kind !== "bounded") return null;
  const was = spaceAreaM2(before, b);
  const now = spaceAreaM2(after, a);
  if (was === null || now === null || m2(was) === m2(now)) return null;
  const change = changes.find((c) => a.bounds.kind === "bounded" && a.bounds.boundary.some((r) => r.elementId === (c.after ?? c.before)?.id)) ?? changes[0];
  const el = change?.after ?? change?.before;
  if (!change || !el) return null;
  const noun = boundingElementRow(el.kind)?.label ?? el.kind.replace(/_/g, " ");
  const verb = !change.after ? "removed" : !change.before ? "added" : "moved";
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${nameOf(el)} ${verb}: ${nameOf(a)}'s area changed from ${m2(was)} to ${m2(now)}`;
}
