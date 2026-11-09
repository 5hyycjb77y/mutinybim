import type { BimElement, ElementId, ParamValue, Vec2 } from "../types";

/**
 * A linked model's products as the importer reads them, before anything
 * decides what they become (round 9 I9). Neutral: an IFC reader fills it
 * (`@permitzip/bim-ifc`), and so could any other open format. Lengths are
 * millimetres in the host model's plan frame (x east, y north, z up), the
 * linked model's placement already applied.
 */
export interface ImportPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A plane profile pushed along a vector: the one solid the importer reads exactly. */
export interface ImportExtrusion {
  /** The profile's outline in world space, in order (a circle is sampled; `radius` says it was one). */
  readonly base: readonly ImportPoint[];
  /** Where the profile moves to: `base[i] + along` is the far face. */
  readonly along: ImportPoint;
  /** Set when the profile is a circle: its centre and radius. */
  readonly circle?: { readonly centre: ImportPoint; readonly radius: number };
  /** Set when the profile is a rectangle: its two side lengths (first along the profile's own x). */
  readonly rectangle?: { readonly x: number; readonly y: number };
}

/** What the reader understood of a product's shape. */
export interface ImportGeometry {
  readonly extrusions: readonly ImportExtrusion[];
  /** World box of everything it read (extrusions, boxes, mapped shapes). Null: no shape it could read. */
  readonly bounds: { readonly min: ImportPoint; readonly max: ImportPoint } | null;
  /** Why the shape couldn't be read exactly ("a curved surface", "a boolean cut"), when it couldn't. */
  readonly unread: string | null;
}

/** A connection point on a product (an IFC port), for the report and for joins. */
export interface ImportPort {
  readonly id: string;
  readonly name: string | null;
  readonly position: ImportPoint | null;
  /** SOURCE, SINK, SOURCEANDSINK as the file says; null when it doesn't. */
  readonly flow: string | null;
  /** Ports it is joined to in the file (their ids). */
  readonly connectedTo: readonly string[];
}

export interface ImportProduct {
  /** The file's stable id for it (an IFC GlobalId). */
  readonly sourceId: string;
  /** The schema's entity name (`IfcWall`). */
  readonly entity: string;
  readonly predefinedType: string | null;
  readonly objectType: string | null;
  readonly name: string | null;
  readonly longName: string | null;
  readonly tag: string | null;
  /** The storey it sits in (its `sourceId`). */
  readonly storeyId: string | null;
  /** Its type object (`sourceId`) and that type's name. */
  readonly typeId: string | null;
  readonly typeName: string | null;
  /** The element whose opening it fills (doors, windows). */
  readonly hostId: string | null;
  /** Groups it is assigned to (distribution systems), by `sourceId`. */
  readonly groupIds: readonly string[];
  readonly geometry: ImportGeometry;
  /** Property and quantity sets, by set name then property name. */
  readonly properties: Readonly<Record<string, Readonly<Record<string, ParamValue>>>>;
  /** Overall width and height the file states (doors and windows carry them). */
  readonly overall: { readonly width: number | null; readonly height: number | null };
  readonly material: string | null;
  readonly ports: readonly ImportPort[];
}

export interface ImportStorey {
  readonly sourceId: string;
  readonly name: string;
  /** Floor elevation in the host frame, mm. */
  readonly elevationMm: number;
}

/** A group in the file (an IFC distribution system): what it carries, in the file's own words. */
export interface ImportGroup {
  readonly sourceId: string;
  readonly entity: string;
  readonly name: string | null;
  readonly predefinedType: string | null;
  readonly objectType: string | null;
}

export interface ImportSource {
  /** What the elements remember they came from (`provenance.source`): the linked model version. */
  readonly id: string;
  /** The model's name and disciplines, for the report's words ("Main St – Acme"). */
  readonly label: string;
  readonly disciplines: readonly string[];
  readonly storeys: readonly ImportStorey[];
  readonly groups: readonly ImportGroup[];
  readonly products: readonly ImportProduct[];
  /** Products the reader saw but could not read at all, and why (counts by entity). */
  readonly unreadable: readonly { readonly entity: string; readonly count: number; readonly reason: string }[];
}

/** One class's line in the report. */
export interface ImportClassLine {
  readonly classId: string | null;
  /** What a person calls them ("Walls"; the file's entity name when no class knows it). */
  readonly label: string;
  readonly converted: number;
  /** Stayed on the linked model, by reason in plain words. */
  readonly linked: readonly { readonly reason: string; readonly count: number }[];
}

export interface IfcImportReport {
  readonly source: { readonly id: string; readonly label: string; readonly disciplines: readonly string[] };
  readonly converted: number;
  readonly stayLinked: number;
  /** New levels made for storeys no level matched. */
  readonly levelsAdded: readonly string[];
  readonly classes: readonly ImportClassLine[];
  /** Joins between converted parts the file had and the model couldn't make, and other things to look at. */
  readonly notes: readonly string[];
  /** One sentence: "Converted 412 walls, 96 doors, 38 rooms. Left 4 roofs, 6 stairs as the linked model." */
  readonly summary: string;
}

/** What an import writes: every record new, each carrying `provenance`. */
export interface IfcImportPlan {
  readonly records: readonly BimElement[];
  /** Source ids that converted, by the element id they became. */
  readonly converted: ReadonlyMap<string, ElementId>;
  readonly report: IfcImportReport;
}

/** What a rule writes for one product. */
export type ImportRuleResult =
  | { readonly ok: true; readonly records: readonly BimElement[] }
  | { readonly ok: false; readonly reason: string };

/** A 2D outline helper's answer. */
export type PlanOutline = readonly Vec2[];
