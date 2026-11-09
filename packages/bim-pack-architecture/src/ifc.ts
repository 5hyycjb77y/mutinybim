import { hostVoidsOf, IFC_RELATION_POINT, type IfcRelationRow } from "@permitzip/bim-kernel";
import { asStair, stairGeometry, ROOF_KIND, STAIR_KIND } from "./kinds";

/**
 * The building in IFC beyond containment (`kernel.ifc_relation`): a filled
 * void writes an `IfcOpeningElement` that voids the host and is filled by
 * the door or window; a plain opening voids only. A roof aggregates its
 * `ROOF` slab part; a stair its straight flight with risers and treads.
 */

export const OPENING_IFC_RELATIONS: IfcRelationRow = {
  id: "architecture.opening_voids",
  label: "Openings in their hosts",
  kinds: ["opening"],
  relations(el, elements) {
    if (el.kind !== "opening") return { objects: [], relations: [] };
    const v = hostVoidsOf(elements, el.hostId).find((x) => x.elementId === el.id);
    if (!v) return { objects: [], relations: [] };
    const key = `opening:${el.id}`;
    return {
      objects: [{ key, entity: "IfcOpeningElement", predefinedType: "OPENING", ...(el.mark ? { name: el.mark } : {}) }],
      relations: [{ entity: "IfcRelVoidsElement", relating: el.hostId, related: [key] }, ...(v.role === "fill" ? [{ entity: "IfcRelFillsElement" as const, relating: key, related: [el.id] }] : [])],
    };
  },
};

export const ROOF_IFC_RELATIONS: IfcRelationRow = {
  id: "architecture.roof_parts",
  label: "Roof slab parts",
  kinds: [ROOF_KIND],
  relations(el) {
    const key = `roof-slab:${el.id}`;
    return { objects: [{ key, entity: "IfcSlab", predefinedType: "ROOF" }], relations: [{ entity: "IfcRelAggregates", relating: el.id, related: [key] }] };
  },
};

export const STAIR_IFC_RELATIONS: IfcRelationRow = {
  id: "architecture.stair_flights",
  label: "Stair flights",
  kinds: [STAIR_KIND],
  relations(el, elements) {
    const s = asStair(el);
    const g = s ? stairGeometry(s, elements) : null;
    if (!g) return { objects: [], relations: [] };
    const key = `flight:${el.id}`;
    return {
      objects: [{ key, entity: "IfcStairFlight", predefinedType: "STRAIGHT", attributes: { NumberOfRisers: g.risers, NumberOfTreads: g.treads, RiserHeight: g.riserMm, TreadLength: g.treadMm } }],
      relations: [{ entity: "IfcRelAggregates", relating: el.id, related: [key] }],
    };
  },
};

export const ARCHITECTURE_IFC_RELATIONS: readonly IfcRelationRow[] = [OPENING_IFC_RELATIONS, ROOF_IFC_RELATIONS, STAIR_IFC_RELATIONS];
export { IFC_RELATION_POINT };
