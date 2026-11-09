import type { BimElement, ClassId, ClassIndex, ObjectClass, ObjectClassIfc, Registry } from "@permitzip/bim-kernel";
import { ifcEntityName, isInstantiableEntity, predefinedTypes } from "./schema-ifc4x3";

/**
 * Which IFC entity an element is written as, read from the class registry
 * (`ObjectClass.ifc`): the element's most specific class, then the nearest
 * ancestor with a hint. A pack or firm class with a hint exports with no
 * change here. No class, no hint, or a name the schema doesn't have:
 * `IfcBuildingElementProxy`, with the reason in the report.
 *
 * Two refinements read the kernel's own element fields, not a trade: a
 * generic flow fitting or segment becomes the duct, pipe or cable carrier
 * subtype its run domain names (one class covers every run fitting), and a
 * component's category picks the covering, plate or member it is.
 */

export interface ResolvedIfcClass {
  readonly classId: ClassId | null;
  readonly classLabel: string | null;
  /** The schema's spelling, instantiable. */
  readonly entity: string;
  /** A member of the entity's enumeration, or null to leave it unset. */
  readonly predefinedType: string | null;
  readonly objectType: string | null;
  /** The type object entity, or null when the entity has none in the schema. */
  readonly typeEntity: string | null;
  /** Why the element is a proxy or its hint was adjusted; null when the hint was used as written. */
  readonly note: string | null;
}

export const PROXY = "IfcBuildingElementProxy";

/** The class an element is written as: a pack or library class before a built-in one, then the deepest, then by id. */
export function primaryClass(registry: Registry, index: ClassIndex, el: BimElement): ObjectClass | null {
  let best: ObjectClass | null = null;
  let bestRank: readonly [number, number, string] | null = null;
  for (const id of index.classesOf(el.id)) {
    const cls = registry.getClass(id);
    if (!cls) continue;
    const rank = [cls.source === "builtin" ? 0 : 1, registry.ancestors(id).length, id] as const;
    if (!bestRank || rank[0] > bestRank[0] || (rank[0] === bestRank[0] && (rank[1] > bestRank[1] || (rank[1] === bestRank[1] && rank[2] < bestRank[2])))) {
      best = cls;
      bestRank = rank;
    }
  }
  return best;
}

function hintOf(registry: Registry, cls: ObjectClass): ObjectClassIfc | null {
  for (const id of registry.ancestors(cls.id)) {
    const hint = registry.getClass(id)?.ifc;
    if (hint) return hint;
  }
  return null;
}

const RUN_DOMAIN_FITTING: Readonly<Record<string, string>> = { duct: "IfcDuctFitting", pipe: "IfcPipeFitting", conduit: "IfcCableCarrierFitting" };
const RUN_DOMAIN_SEGMENT: Readonly<Record<string, string>> = { duct: "IfcDuctSegment", pipe: "IfcPipeSegment", conduit: "IfcCableCarrierSegment" };
/** A riser's `service` (NetworkService) as a run domain. */
const NETWORK_SERVICE_DOMAIN: Readonly<Record<string, string>> = { air: "duct", water: "pipe", sprinkler: "pipe", power: "conduit" };
/** Fitting shapes as IfcDuctFittingTypeEnum / IfcPipeFittingTypeEnum members (both enumerations share these). */
const FITTING_TYPE_PREDEFINED: Readonly<Record<string, string>> = { elbow: "BEND", offset: "BEND", transition: "TRANSITION", tap: "JUNCTION", tee: "JUNCTION", wye: "JUNCTION", cap: "OBSTRUCTION" };
const COMPONENT_CATEGORY: Readonly<Record<string, { readonly entity: string; readonly predefinedType?: string }>> = {
  furniture: { entity: "IfcFurniture" },
  casework: { entity: "IfcFurniture", predefinedType: "USERDEFINED" },
  ceiling: { entity: "IfcCovering", predefinedType: "CEILING" },
  floor_finish: { entity: "IfcCovering", predefinedType: "FLOORING" },
  curtain_panel: { entity: "IfcPlate", predefinedType: "CURTAIN_PANEL" },
  mullion: { entity: "IfcMember", predefinedType: "MULLION" },
  footing: { entity: "IfcFooting" },
};

function field(el: BimElement, key: string): string | null {
  const v: unknown = Reflect.get(el, key);
  return typeof v === "string" ? v : null;
}

function refine(entity: string, el: BimElement, hint: ObjectClassIfc): { entity: string; predefinedType?: string; objectType?: string } {
  const upper = entity.toUpperCase();
  if (upper === "IFCFLOWFITTING") {
    const sub = RUN_DOMAIN_FITTING[field(el, "domain") ?? ""];
    if (sub) {
      const shape = field(el, "fittingType") ?? "";
      const pt = FITTING_TYPE_PREDEFINED[shape];
      return { entity: sub, ...(pt ? { predefinedType: pt } : { predefinedType: "USERDEFINED", objectType: field(el, "label") ?? shape }) };
    }
  }
  if (upper === "IFCFLOWSEGMENT") {
    const domain = field(el, "domain") ?? NETWORK_SERVICE_DOMAIN[field(el, "service") ?? ""] ?? "";
    const sub = RUN_DOMAIN_SEGMENT[domain];
    if (sub) return { entity: sub };
  }
  if (upper === "IFCFURNISHINGELEMENT" && el.kind === "component") {
    const sub = COMPONENT_CATEGORY[field(el, "category") ?? ""];
    if (sub) return { entity: sub.entity, ...(sub.predefinedType ? { predefinedType: sub.predefinedType } : {}), ...(sub.predefinedType === "USERDEFINED" ? { objectType: field(el, "category") ?? "" } : {}) };
  }
  return { entity, ...(hint.predefinedType ? { predefinedType: hint.predefinedType } : {}), ...(hint.objectType ? { objectType: hint.objectType } : {}) };
}

function typeEntityFor(entity: string, hinted: string | undefined): string | null {
  if (hinted && isInstantiableEntity(hinted)) return ifcEntityName(hinted);
  const guess = `${entity}Type`;
  return isInstantiableEntity(guess) ? ifcEntityName(guess) : null;
}

/** Resolve the entity, predefined type, object type and type entity one element is written as. */
export function resolveIfcClass(registry: Registry, index: ClassIndex, el: BimElement): ResolvedIfcClass {
  const cls = primaryClass(registry, index, el);
  const hint = cls ? hintOf(registry, cls) : null;
  const base = { classId: cls?.id ?? null, classLabel: cls?.label ?? null };
  if (!cls || !hint) {
    return { ...base, entity: PROXY, predefinedType: "USERDEFINED", objectType: cls?.label ?? el.kind, typeEntity: "IfcBuildingElementProxyType", note: cls ? `class ${cls.id} has no IFC entity` : `no class recognises a ${el.kind}` };
  }
  const refined = refine(hint.entity, el, hint);
  const entity = ifcEntityName(refined.entity);
  if (!entity || !isInstantiableEntity(entity)) {
    return { ...base, entity: PROXY, predefinedType: "USERDEFINED", objectType: cls.label, typeEntity: "IfcBuildingElementProxyType", note: `class ${cls.id} names ${hint.entity}, which IFC4X3_ADD2 has no element entity called` };
  }
  const members = predefinedTypes(entity);
  let predefinedType: string | null = refined.predefinedType ?? null;
  let objectType: string | null = refined.objectType ?? null;
  let note: string | null = null;
  if (predefinedType !== null && !members.has(predefinedType)) {
    note = `${predefinedType} is not a ${entity} type; written as USERDEFINED`;
    objectType = objectType ?? predefinedType;
    predefinedType = members.has("USERDEFINED") ? "USERDEFINED" : null;
  }
  if (predefinedType === "USERDEFINED" && !objectType) objectType = cls.label;
  return { ...base, entity, predefinedType, objectType, typeEntity: typeEntityFor(entity, hint.typeEntity), note };
}
