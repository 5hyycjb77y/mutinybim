import type { ElementKind } from "../types";
import type { PackSet } from "../packs/set";
import { activePackSet } from "../packs/scope";
import { elementKindTable } from "./element-kind-point";

/** The kernel's own element kinds: generic to every trade. No add-on may register one of these. */
export const KERNEL_ELEMENT_KINDS = [
  "wall",
  "slab",
  "opening",
  "room",
  "grid",
  "column",
  "beam",
  "riser_segment",
  "component",
  "view",
  "sheet",
  "tag",
  "dimension",
  "viewport",
  "drawing_item",
  "level",
  "part_type",
  "element_type",
  "part",
  "mounting_plane",
  "mep_system",
  "run_segment",
  "run_fitting",
  "organization",
  "site",
  "service_link",
  "service_catalog",
  "load_point",
  "space",
  "zone",
  "drawing_underlay",
  "question",
  "ceiling",
  "determination",
  "rule",
  "requirement_state",
  "observation",
  "construction_stage",
  "space_separator",
  "reference_plane",
] as const satisfies readonly ElementKind[];

/**
 * Stored kind names an add-on owns (`ELEMENT_KIND_POINT` rows: their values,
 * checks, words, stored shape, connector ends and placement) that every
 * stored model since round 1 holds. Names only, kept so a library file's
 * recognition rule and the agent's kind filter still parse them; no kernel
 * code reads or narrows on these kinds (it reads their rows), so the kernel
 * compiles with no add-on in the build.
 */
export const ADDON_HOSTED_ELEMENT_KINDS = ["equipment", "duct_segment", "tap", "elbow", "terminal"] as const;

/** Every element kind a stored record of this release may have, at runtime, so a library file's recognition rule can be checked. */
export const ELEMENT_KINDS = [...KERNEL_ELEMENT_KINDS, ...ADDON_HOSTED_ELEMENT_KINDS] as const;

type MissingKind = Exclude<ElementKind, (typeof ELEMENT_KINDS)[number]>;
/** Fails to compile when the kernel gains an element kind this list lacks. */
const exhaustive: MissingKind extends never ? true : MissingKind = true;
void exhaustive;

const KERNEL_KIND_SET: ReadonlySet<string> = new Set(KERNEL_ELEMENT_KINDS);

/** True for the kernel's own kinds (an add-on can't register one). */
export function isKernelElementKind(kind: string): boolean {
  return KERNEL_KIND_SET.has(kind);
}

/** The kinds in force: the kernel's own, then every kind an add-on in `set` registers, in row order. A stored record of any other kind is kept as stored. */
export function elementKindsInForce(set: PackSet = activePackSet()): readonly string[] {
  return set.memo("kernel.element_kind#in_force", () => [...KERNEL_ELEMENT_KINDS, ...elementKindTable(set).kinds.filter((k) => !KERNEL_KIND_SET.has(k))]);
}
