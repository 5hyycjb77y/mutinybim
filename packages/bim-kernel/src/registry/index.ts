import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { BUILTIN_CLASSES, builtinRegistry, firstPartyClasses } from "./builtin";
import { withPackClasses, type PackClass } from "./registry";
import type { Registry } from "./types";

export * from "./types";
export * from "./units";
export * from "./element-kinds";
export * from "./element-kind-point";
export * from "./registry";
export * from "./recognition";
export * from "./builtin";
export * from "./class-plan-graphics-point";
export * from "./linked-plan-display-point";

/** Element classes (v1). A pack's are `<pack>.<name>`; the kernel's namespaces (`mep.`, `arch.`, …) are built-in rows and may not be redefined. */
export const CLASS_POINT = defineExtensionPoint<PackClass>({
  id: "kernel.class",
  version: 1,
  label: "Element classes",
  idOf: (cls) => cls.id,
  builtins: () => BUILTIN_CLASSES,
});

/** `base` with the pack set's classes merged in (`withPackClasses`); `base` itself when the set adds none. */
export function packClassRegistry(base: Registry, set: PackSet = activePackSet()): Registry {
  // The installed first-party classes are in `base` already (`builtinRegistry`).
  const installed = new Set(firstPartyClasses());
  const classes = set.packItems(CLASS_POINT).filter((c) => !installed.has(c));
  if (classes.length === 0) return base;
  // Refuses a pack class equal to a built-in one before the merge reports it in registry words.
  set.items(CLASS_POINT);
  return withPackClasses(base, classes);
}

/** The kernel's classes plus the pack set in force's, built once per set. */
export function activeClassRegistry(): Registry {
  const set = activePackSet();
  return set.memo("kernel.class.registry", () => packClassRegistry(builtinRegistry(), set));
}
