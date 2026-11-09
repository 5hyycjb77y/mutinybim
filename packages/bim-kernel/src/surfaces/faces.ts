import { asCeiling, ceilingHeightAtPoint } from "../ceilings/read";
import { levelOf } from "../fields/providers/level-room";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, Level, Vec2 } from "../types";

/**
 * Surface faces (`kernel.surface_face` v1): the horizontal faces a kind
 * offers to what is under or over it. A slab's top is a floor and its
 * underside the structure over the storey below; a ceiling's underside is a
 * ceiling; an add-on's roof (or deck, canopy, mezzanine) says its own. A
 * wall's top or base bound to a surface (`placement/surface-bind.ts`), the
 * point query of what is under and over a spot (`surfaces-at.ts`) and the
 * edit hook that re-sizes bound elements when a face moves
 * (`placement/surface-follow.ts`) all read these rows, so a pack's kind is
 * reached with no kernel edit.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** What a kind's underside is to what is below it: the structure over a storey, a ceiling, or a roof. Its top is a floor in every case. */
export const SURFACE_FACE_ROLES = ["structure", "ceiling", "roof"] as const;
export type SurfaceFaceRole = (typeof SURFACE_FACE_ROLES)[number];

/** Model elevations of a face pair at a plan point, mm. */
export interface FacePair {
  readonly top: number;
  readonly underside: number;
}

export interface SurfaceFaceRow {
  /** The stored kind (`slab`, an add-on's `zz.roof`). One row per kind. */
  readonly kind: string;
  readonly label: string;
  readonly role: SurfaceFaceRole;
  /** Its plan outline (for indexes and for which bound elements a change reaches); null when it has none. */
  footprint(el: BimElement, elements: Elements): readonly Vec2[] | null;
  /**
   * Its top and underside at a plan point, mm above project zero. Faces are
   * planes, so a point outside the footprint reads the plane carried on (a
   * wall's end just past a roof's edge); null when the record can't be read.
   */
  faceAt(el: BimElement, elements: Elements, p: Vec2): FacePair | null;
}

/** The level an element stands on: its own level id, its placement's, else the one its partition names. */
export function elementLevel(elements: Elements, el: BimElement): Level | null {
  const p = "placement" in el ? el.placement : undefined;
  const placed = p && typeof p === "object" && "levelId" in p && typeof p.levelId === "string" ? elements[p.levelId] : undefined;
  if (placed?.kind === "level") return placed;
  return levelOf(elements, el);
}

const SLAB_FACE_ROW: SurfaceFaceRow = {
  kind: "slab",
  label: "Floor",
  role: "structure",
  footprint: (el) => (el.kind === "slab" && el.outline.length >= 3 ? el.outline : null),
  faceAt(el, elements) {
    if (el.kind !== "slab") return null;
    const level = elementLevel(elements, el);
    if (!level) return null;
    // A slab's top is its level's floor; its thickness hangs below.
    return { top: level.elevationMm, underside: level.elevationMm - el.thickness };
  },
};

const CEILING_FACE_ROW: SurfaceFaceRow = {
  kind: "ceiling",
  label: "Ceiling",
  role: "ceiling",
  footprint: (el) => {
    const c = asCeiling(el);
    return c && c.outline.length >= 3 ? c.outline : null;
  },
  faceAt(el, elements, p) {
    const c = asCeiling(el);
    const level = c ? elements[c.levelId] : undefined;
    if (!c || level?.kind !== "level") return null;
    const z = level.elevationMm + ceilingHeightAtPoint(c, p);
    return { top: z, underside: z };
  },
};

export const KERNEL_SURFACE_FACE_ROWS: readonly SurfaceFaceRow[] = [SLAB_FACE_ROW, CEILING_FACE_ROW];

export const SURFACE_FACE_POINT = defineExtensionPoint<SurfaceFaceRow>({
  id: "kernel.surface_face",
  version: 1,
  label: "Surface faces",
  idOf: (row) => row.kind,
  builtins: () => KERNEL_SURFACE_FACE_ROWS,
});

/** Problems with surface face rows (pack conformance), in words. */
export function surfaceFaceRowProblems(rows: readonly SurfaceFaceRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.kind)) out.push(`surface face ${row.kind} is declared twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`surface face ${row.kind} has no label`);
    if (!(SURFACE_FACE_ROLES as readonly string[]).includes(row.role)) out.push(`surface face ${row.kind}: unknown role ${String(row.role)}`);
    for (const face of ["footprint", "faceAt"] as const) if (typeof row[face] !== "function") out.push(`surface face ${row.kind}: ${face} must be a function`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, SurfaceFaceRow> => new Map(set.items(SURFACE_FACE_POINT).map((r) => [r.kind, r] as const));

export function surfaceFaceRow(kind: string, set: PackSet = activePackSet()): SurfaceFaceRow | null {
  return set.memo("kernel.surface_face#table", tableOf).get(kind) ?? null;
}

/** Every kind that offers faces in the pack set in force. */
export function surfaceFaceKinds(set: PackSet = activePackSet()): readonly string[] {
  return [...set.memo("kernel.surface_face#table", tableOf).keys()];
}
