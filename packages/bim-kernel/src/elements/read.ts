import { z } from "zod";
import { isRegistryIdShape } from "../ids";
import { openingPosition } from "../model";
import { geometricPlacementKind, type GeometricPlacement, type LinePlacement } from "../placement/geometric";
import { pathEnd } from "../placement/geometric-math";
import { faceOf } from "../placement/line-face";
import { elementsOfKind } from "../store";
import { asElementId, KNOWN_COLUMN_MATERIALS, KNOWN_COMPONENT_CATEGORIES, KNOWN_LOCK_STATES, KNOWN_OPENING_TYPES, type BimElement, type ElementCore, type ElementId, type LockState, type ParamValue, type Vec2 } from "../types";
import { CLASSIFIED_KINDS, ELEMENT_CORE_KINDS, isClassifiedElement, isCoreElement, type ClassifiedElement, type ClassifiedKind, type CoreElement, type ElementCoreKind } from "./feature";

/**
 * Tolerant readers for the building and structure kinds: every field this
 * release reads is checked, every field it doesn't is kept, and a record
 * that passes is returned as the same object (byte for byte, so a read never
 * rewrites a stored record). Open lists (`openingType`, `category`,
 * `material`, a lock's `state`, a placement's `kind`) accept any value a
 * newer peer wrote; `known` says whether this release knows it.
 */

const vec2 = z.looseObject({ x: z.number(), y: z.number() });
const scalar = z.union([z.number(), z.string(), z.boolean()]);
const registryId = z.custom<string>(isRegistryIdShape, { message: "a registry id (arch.wall, zz.partition)" });

const base = {
  id: z.string().min(1),
  version: z.number(),
  authoredRev: z.record(z.string(), z.number()),
  partition: z.looseObject({ level: z.string(), zone: z.string(), discipline: z.string() }).optional(),
  groupId: z.string().optional(),
  phaseCreated: z.string().optional(),
  phaseDemolished: z.string().optional(),
  schemaVersion: z.number().int().min(1).optional(),
};

const lockSchema = z.looseObject({ state: z.string().min(1), reason: z.string(), by: z.string().optional(), at: z.string().optional() });

/** Known placement kinds are checked; any other kind is kept as stored (a newer peer's shape). */
const placementSchema = z.looseObject({ kind: z.string().min(1), levelId: z.string() }).superRefine((p, ctx) => {
  const known = geometricPlacementKind(p);
  const shape =
    known === "point"
      ? z.looseObject({ position: vec2, offsetMm: z.number(), rotationDeg: z.number() })
      : known === "line"
        ? z.looseObject({ start: vec2, end: vec2, startOffsetMm: z.number(), endOffsetMm: z.number(), lateral: z.string(), vertical: z.string() })
        : known === "path"
          ? z.looseObject({ start: vec2, segments: z.array(z.looseObject({ kind: z.string(), to: vec2 })), offsetMm: z.number(), lateral: z.string() })
          : known === "area"
            ? z.looseObject({ outline: z.array(vec2), holes: z.array(z.array(vec2)).optional(), offsetMm: z.number(), vertical: z.string() })
            : null;
  if (!shape) return;
  const r = shape.safeParse(p);
  if (!r.success) for (const issue of r.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
});

const core = {
  classId: registryId.optional(),
  typeId: z.string().min(1).optional(),
  values: z.record(z.string(), scalar).optional(),
  provenance: z.looseObject({ ifcGlobalId: z.string().optional(), source: z.string().optional() }).optional(),
  placement: placementSchema.optional(),
  locked: lockSchema.optional(),
};

const SCHEMAS: Readonly<Record<ElementCoreKind, z.ZodType>> = {
  wall: z.looseObject({ ...base, ...core, kind: z.literal("wall"), start: vec2, end: vec2, thickness: z.number(), height: z.number(), wallType: z.string() }),
  slab: z.looseObject({ ...base, ...core, kind: z.literal("slab"), outline: z.array(vec2), thickness: z.number() }),
  opening: z.looseObject({ ...base, ...core, kind: z.literal("opening"), openingType: z.string().min(1), mark: z.string(), hostId: z.string(), offset: z.number(), width: z.number(), height: z.number(), position: vec2 }),
  room: z.looseObject({ ...base, ...core, kind: z.literal("room"), number: z.string(), name: z.string(), outline: z.array(vec2), areaSqM: z.number() }),
  grid: z.looseObject({ ...base, ...core, kind: z.literal("grid"), label: z.string(), start: vec2, end: vec2 }),
  column: z.looseObject({ ...base, ...core, kind: z.literal("column"), material: z.string().min(1), position: vec2, size: vec2 }),
  beam: z.looseObject({ ...base, ...core, kind: z.literal("beam"), sectionName: z.string(), start: vec2, end: vec2 }),
  component: z.looseObject({ ...base, ...core, kind: z.literal("component"), category: z.string().min(1), typeName: z.string(), position: vec2, size: vec2, rotationDeg: z.number() }),
};

const CORE_KIND_SET: ReadonlySet<string> = new Set(ELEMENT_CORE_KINDS);

const classified = {
  classId: registryId.optional(),
  provenance: core.provenance,
};
const valued = { ...classified, values: core.values };
const kindOf = z.looseObject({ kind: z.string().min(1) });
const runPoint = z.looseObject({ x: z.number(), y: z.number(), z: z.number() });

const CLASSIFIED_SCHEMAS: Readonly<Record<ClassifiedKind, z.ZodType>> = {
  zone: z.looseObject({ ...base, ...valued, kind: z.literal("zone"), name: z.string(), purpose: z.string().min(1), spaceIds: z.array(z.string()), bounds: kindOf.optional() }),
  space: z.looseObject({ ...base, ...valued, kind: z.literal("space"), number: z.string(), name: z.string(), bounds: kindOf, origin: kindOf }),
  mep_system: z.looseObject({ ...base, ...valued, kind: z.literal("mep_system"), name: z.string(), systemKind: z.string().min(1), domain: z.string().min(1) }),
  run_segment: z.looseObject({ ...base, ...valued, kind: z.literal("run_segment"), domain: z.string().min(1), systemId: z.string(), levelId: z.string(), start: runPoint, end: runPoint, size: z.looseObject({ shape: z.string().min(1) }), branches: z.array(z.string()), flow: z.number() }),
  element_type: z.looseObject({ ...base, ...valued, kind: z.literal("element_type"), name: z.string(), forKinds: z.array(z.string()).optional() }),
  part: z.looseObject({ ...base, ...classified, kind: z.literal("part"), typeId: z.string(), levelId: z.string(), position: vec2, offsetMm: z.number(), rotationDeg: z.number(), mark: z.string(), values: z.record(z.string(), scalar) }),
};

const CLASSIFIED_KIND_SET: ReadonlySet<string> = new Set(CLASSIFIED_KINDS);

export type ClassifiedReadResult = { readonly ok: true; readonly element: ClassifiedElement } | { readonly ok: false; readonly kind: string | null; readonly reason: string };

/** A stored zone, space, system, run segment or part as this release reads its class fields: checked, everything else kept, and handed back as the same object. */
export function readClassifiedElement(raw: unknown): ClassifiedReadResult {
  const kind = typeof raw === "object" && raw !== null && "kind" in raw && typeof raw.kind === "string" ? raw.kind : null;
  if (kind === null || !CLASSIFIED_KIND_SET.has(kind)) return { ok: false, kind, reason: kind === null ? "the record has no kind" : `${kind} isn't a zone, space, system, run segment or part` };
  const r = CLASSIFIED_SCHEMAS[kind as ClassifiedKind].safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, kind, reason: issue ? `${issue.path.join(".") || "record"}: ${issue.message}` : "the record isn't readable" };
  }
  // The checked record is the stored one: hand it back unchanged.
  return { ok: true, element: raw as ClassifiedElement };
}


export type CoreReadResult = { readonly ok: true; readonly element: CoreElement } | { readonly ok: false; readonly kind: string | null; readonly reason: string };

/**
 * A stored building or structure record as this release reads it. Passing
 * records come back as the same object; a record that is not one of these
 * kinds, or is missing a field this release reads, is refused with the field.
 */
export function readCoreElement(raw: unknown): CoreReadResult {
  const kind = typeof raw === "object" && raw !== null && "kind" in raw && typeof raw.kind === "string" ? raw.kind : null;
  if (kind === null || !CORE_KIND_SET.has(kind)) return { ok: false, kind, reason: kind === null ? "the record has no kind" : `${kind} isn't a building or structure kind` };
  const schema = SCHEMAS[kind as ElementCoreKind];
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, kind, reason: issue ? `${issue.path.join(".") || "record"}: ${issue.message}` : "the record isn't readable" };
  }
  // The checked record is the stored one: hand it back unchanged.
  return { ok: true, element: raw as CoreElement };
}

const has = (list: readonly string[], v: string): boolean => list.includes(v);

/** Whether this release knows the element's open-list value (its opening type, component category, column material). */
export function knownOpenValue(el: CoreElement): boolean {
  switch (el.kind) {
    case "opening":
      return has(KNOWN_OPENING_TYPES, el.openingType);
    case "component":
      return has(KNOWN_COMPONENT_CATEGORIES, el.category);
    case "column":
      return has(KNOWN_COLUMN_MATERIALS, el.material);
    default:
      return true;
  }
}

/** A stored lock as this release reads it; `known` is false for a state a newer peer wrote (still locked). */
export function lockOf(el: BimElement | undefined): { readonly lock: LockState; readonly known: boolean } | null {
  if (!isCoreElement(el) || el.locked === undefined) return null;
  const parsed = lockSchema.safeParse(el.locked);
  if (!parsed.success) {
    // A lock this release can't read still locks: refusing an edit is the safe reading.
    console.error("[elements/read] unreadable lock kept as locked", { elementId: el.id });
    return { lock: { state: "unknown", reason: "" }, known: false };
  }
  return { lock: el.locked, known: has(KNOWN_LOCK_STATES, el.locked.state) };
}

/** The element-core fields of any element (a part's `values` are its type parameters, so not among them), empty for kinds that don't carry them. */
export function elementCoreOf(el: BimElement): ElementCore {
  if (isClassifiedElement(el)) {
    const out: { -readonly [K in keyof ElementCore]: ElementCore[K] } = {};
    if (el.classId !== undefined) out.classId = el.classId;
    if (el.provenance !== undefined) out.provenance = el.provenance;
    if (el.kind !== "part" && el.values !== undefined) out.values = el.values;
    return out;
  }
  if (!isCoreElement(el)) return {};
  const out: { -readonly [K in keyof ElementCore]: ElementCore[K] } = {};
  if (el.classId !== undefined) out.classId = el.classId;
  if (el.typeId !== undefined) out.typeId = el.typeId;
  if (el.values !== undefined) out.values = el.values;
  if (el.provenance !== undefined) out.provenance = el.provenance;
  if (el.placement !== undefined) out.placement = el.placement;
  if (el.locked !== undefined) out.locked = el.locked;
  return out;
}

/** An element's element-core value by parameter key (a part's are read through its type, `paramValue`). */
export function elementValue(el: BimElement, key: string): ParamValue | undefined {
  if (isCoreElement(el)) return el.values?.[key];
  return isClassifiedElement(el) && el.kind !== "part" ? el.values?.[key] : undefined;
}

type Elements = Readonly<Record<string, BimElement>>;

const levelIdsByName = new WeakMap<Elements, ReadonlyMap<string, ElementId>>();

function levelIdNamed(elements: Elements, name: string | undefined): ElementId | null {
  if (name === undefined) return null;
  let map = levelIdsByName.get(elements);
  if (!map) {
    const m = new Map<string, ElementId>();
    for (const el of elementsOfKind(elements, "level")) if (!m.has(el.name)) m.set(el.name, el.id);
    levelIdsByName.set(elements, m);
    map = m;
  }
  return map.get(name) ?? null;
}

export interface PlacementView {
  readonly placement: GeometricPlacement;
  /** `stored`: the record's own placement agrees with its flat fields. `flat`: read from the flat fields (an older record, or a placement an older peer's edit left behind). */
  readonly source: "stored" | "flat";
  /** False when no level matched; `levelId` is then empty. */
  readonly levelKnown: boolean;
}

/** Within this, a stored placement's end agrees with the flat field an older writer moved (the connector tolerance). */
const AGREE_MM = 0.5;
const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= AGREE_MM;
const sameRing = (a: readonly Vec2[], b: readonly Vec2[]): boolean => a.length === b.length && a.every((p, i) => { const q = b[i]; return q !== undefined && near(p, q); });

/** A line or path element (`widthMm` across it: a wall's thickness; 0 for beams and grids, whose flat line is the placement line). */
function lineFrom(levelId: ElementId, start: Vec2, end: Vec2, widthMm: number, vertical: LinePlacement["vertical"], stored: GeometricPlacement | undefined): { placement: GeometricPlacement; agrees: boolean } {
  if (stored?.kind === "line") {
    const face = faceOf(start, end, stored.lateral, widthMm);
    const agrees = near(stored.start, face.start) && near(stored.end, face.end);
    return { placement: agrees ? stored : { ...stored, start: face.start, end: face.end }, agrees };
  }
  if (stored?.kind === "path") {
    const agrees = near(stored.start, start) && near(pathEnd(stored), end);
    if (agrees) return { placement: stored, agrees };
  }
  return { placement: { kind: "line", levelId, start, end, startOffsetMm: 0, endOffsetMm: 0, lateral: "center", vertical }, agrees: stored === undefined };
}

/**
 * Where a building or structure element sits, as one geometric placement.
 * The flat fields are authoritative: a stored placement is used when it
 * agrees with them, and otherwise keeps its extras (justification, offsets)
 * with the flat geometry, because the flat fields are what an older writer
 * moved. Null for kinds without element core, and for a stored kind this
 * release doesn't know (kept, not drawn).
 */
export function elementPlacementOf(elements: Elements, el: BimElement): PlacementView | null {
  if (!isCoreElement(el)) return null;
  const stored = el.placement;
  if (stored !== undefined && geometricPlacementKind(stored) === null) return null;
  const level = stored?.levelId ?? levelIdNamed(elements, el.partition?.level);
  const levelId = level ?? asElementId("");
  const view = (placement: GeometricPlacement, agrees: boolean): PlacementView => ({ placement, source: stored !== undefined && agrees ? "stored" : "flat", levelKnown: level !== null });
  switch (el.kind) {
    case "wall": {
      const r = lineFrom(levelId, el.start, el.end, el.thickness, "bottom", stored);
      return view(r.placement, r.agrees);
    }
    case "beam": {
      const r = lineFrom(levelId, el.start, el.end, 0, "top", stored);
      return view(r.placement, r.agrees);
    }
    case "grid": {
      const r = lineFrom(levelId, el.start, el.end, 0, "center", stored);
      return view(r.placement, r.agrees);
    }
    case "slab":
    case "room": {
      const vertical = el.kind === "slab" ? "top" : "bottom";
      if (stored?.kind === "area") {
        const agrees = sameRing(stored.outline, el.outline);
        return view(agrees ? stored : { ...stored, outline: el.outline }, agrees);
      }
      return view({ kind: "area", levelId, outline: el.outline, offsetMm: 0, vertical }, false);
    }
    case "column":
    case "component": {
      const rotationDeg = el.kind === "component" ? el.rotationDeg : 0;
      if (stored?.kind === "point") {
        const agrees = near(stored.position, el.position);
        return view(agrees ? stored : { ...stored, position: el.position }, agrees);
      }
      // A line, path or area component (a curb, a paving field): its flat position is a derived anchor, not compared.
      if (stored) return view(stored, true);
      return view({ kind: "point", levelId, position: el.position, offsetMm: 0, rotationDeg }, false);
    }
    case "opening": {
      const host = elements[el.hostId];
      const position = host?.kind === "wall" ? openingPosition(host, el.offset) : el.position;
      const rotationDeg = host?.kind === "wall" ? (Math.atan2(host.end.y - host.start.y, host.end.x - host.start.x) * 180) / Math.PI : 0;
      return view({ kind: "point", levelId, position, offsetMm: stored?.kind === "point" ? stored.offsetMm : 0, rotationDeg }, false);
    }
  }
}
