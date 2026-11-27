import { columnVerticalSpan, DEFAULT_SETTINGS, type BimElement, type FieldProvider, type FieldWriter, type ModelState, type Vec2 } from "@permitzip/bim-kernel";
import { elementTypeValue } from "@permitzip/bim-pack/runtime";
import { to, type Quantity } from "@permitzip/bim-units";
import { STRUCT_KEYS } from "./frame";
import { structuralLoadPath, type BeamLoadResult, type ColumnLoadResult, type FootingLoadResult } from "./load-path";
import { sectionById } from "./sections";

/**
 * The structural classes' own fields (beam length/section/loads, column
 * size/height/top-level/section/loads, footing dimensions/thickness/loads),
 * read from the kernel's stored records and cached gravity load path.
 */

type Field = NonNullable<FieldProvider["fields"]>[number];
type Elements = Readonly<Record<string, BimElement>>;

const DEFAULT_FOOTING_THICKNESS_MM = 18 * 25.4;
const locked = (reason: string): FieldWriter => ({ kind: "none", reason });
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const deflectionRatio = (span: Quantity<"length">, deflection: Quantity<"length">): string => {
  const magnitude = Math.abs(deflection);
  if (!(magnitude > 1e-9)) return "—";
  const ratio = Math.round(span / magnitude);
  if (!Number.isFinite(ratio) || ratio <= 0) return "—";
  return ratio > 9999 ? ">L/9999" : `L/${ratio}`;
};

const READS_TYPE = { elementKinds: ["element_type"] } as const;
const READS_FRAME = { elementKinds: ["level", "column", "beam", "slab", "component", "part", "part_type", "element_type"] } as const;

interface LoadPathIndex {
  readonly beams: ReadonlyMap<string, BeamLoadResult>;
  readonly columns: ReadonlyMap<string, ColumnLoadResult>;
  readonly footings: ReadonlyMap<string, FootingLoadResult>;
}

const loadPathCache = new WeakMap<Elements, LoadPathIndex>();

function loadPathFor(elements: Elements): LoadPathIndex {
  const hit = loadPathCache.get(elements);
  if (hit) return hit;
  const model: ModelState = { modelId: "", revision: 0 as ModelState["revision"], settings: DEFAULT_SETTINGS, elements: elements as ModelState["elements"], connections: [] };
  const result = structuralLoadPath(model);
  const idx: LoadPathIndex = {
    beams: new Map(result.beams.map((b) => [b.id, b] as const)),
    columns: new Map(result.columns.map((c) => [c.id, c] as const)),
    footings: new Map(result.footings.map((f) => [f.id, f] as const)),
  };
  loadPathCache.set(elements, idx);
  return idx;
}

const mmLength = (path: string, label: string, classes: readonly string[], read: (el: BimElement, els: Elements) => number | null, writer: FieldWriter = locked("Edit it in the model."), deps?: Field["deps"]): Field => ({
  path,
  label,
  classes,
  valueType: "quantity",
  kind: "length",
  unit: "mm",
  writer,
  group: "Dimensions",
  ...(deps ? { deps } : {}),
  read: (el, ctx) => finite(read(el, ctx.elements)),
});

const forceField = (path: string, label: string, classes: readonly string[], read: (el: BimElement, idx: LoadPathIndex) => number | null): Field => ({
  path,
  label,
  classes,
  valueType: "quantity",
  kind: "force",
  unit: "N",
  writer: locked("Computed by the gravity load path."),
  group: "Loads",
  deps: READS_FRAME,
  read: (el, ctx) => finite(read(el, loadPathFor(ctx.elements))),
});

function sectionNameOf(elements: Elements, el: BimElement): string | null {
  const fromVal = textOrNull(elementTypeValue(elements, el, STRUCT_KEYS.section));
  if (fromVal) return fromVal;
  if (el.kind === "beam") return textOrNull(el.sectionName);
  return null;
}

function sectionDisplayOf(elements: Elements, el: BimElement): string | null {
  const name = sectionNameOf(elements, el);
  if (!name) return null;
  return sectionById(name)?.label ?? name;
}

function columnTopLevelName(elements: Elements, el: BimElement): string | null {
  if (el.kind !== "column") return null;
  const p = el.placement;
  if (p && (p.kind === "point" || p.kind === "line") && p.topLevelId !== undefined) {
    const top = elements[p.topLevelId];
    return top?.kind === "level" ? top.name : p.topLevelId;
  }
  if (typeof el.height === "number" && el.height > 0) return "Unconnected";
  const span = columnVerticalSpan(elements, el, 0);
  if (span.topLevelId) {
    const top = elements[span.topLevelId];
    return top?.kind === "level" ? top.name : span.topLevelId;
  }
  return "Unconnected";
}

export const STRUCTURAL_FIELD_PROVIDER: FieldProvider = {
  id: "struct.members",
  fields: [
    // Original four fields (paths, labels, and groups preserved)
    mmLength("length", "Length", ["struct.beam"], (el) => (el.kind === "beam" ? dist(el.start, el.end) : null), locked("Drag the beam's ends.")),
    mmLength("width", "Width", ["struct.column", "struct.footing"], (el) => (el.kind === "column" || el.kind === "component" ? el.size.x : null)),
    mmLength("depth", "Depth", ["struct.column", "struct.footing"], (el) => (el.kind === "column" || el.kind === "component" ? el.size.y : null)),
    { path: "material", label: "Material", classes: ["struct.column"], valueType: "choice", choices: ["concrete", "steel"], writer: locked("Edit it in the model."), group: "Identity", read: (el) => (el.kind === "column" ? el.material : null) },

    // Column height, level constraints & section metadata
    mmLength("height", "Height", ["struct.column"], (el, els) => (el.kind === "column" ? columnVerticalSpan(els, el, 0).heightMm : null), locked("Edit the column's top level or height in the model."), { elementKinds: ["level"] }),
    { path: "top_level", label: "Top level", classes: ["struct.column"], valueType: "text", writer: locked("Edit the column's top level in the model."), group: "Location", deps: { elementKinds: ["level"] }, read: (el, ctx) => columnTopLevelName(ctx.elements, el) },
    mmLength("base_offset", "Base offset", ["struct.column"], (el) => (el.kind === "column" && el.placement?.kind === "point" ? el.placement.offsetMm : null)),
    mmLength("top_offset", "Top offset", ["struct.column"], (el) => (el.kind === "column" && (el.placement?.kind === "point" || el.placement?.kind === "line") ? (el.placement.topOffsetMm ?? 0) : null)),
    { path: "section", label: "Section", classes: ["struct.column", "struct.beam"], valueType: "text", writer: locked("Set struct.section on the member or its type."), group: "Structural", deps: READS_TYPE, read: (el, ctx) => sectionDisplayOf(ctx.elements, el) },
    { path: "grade", label: "Steel grade", classes: ["struct.column", "struct.beam"], valueType: "text", writer: locked("Set struct.grade on the member or its type."), group: "Structural", deps: READS_TYPE, read: (el, ctx) => textOrNull(elementTypeValue(ctx.elements, el, "struct.grade")) },

    // Beam nominal depth & live structural forces
    mmLength(
      "depth",
      "Depth",
      ["struct.beam"],
      (el, els) => {
        if (el.kind !== "beam") return null;
        const name = sectionNameOf(els, el);
        const sec = name ? sectionById(name) : null;
        return sec ? to(sec.depth, "mm") : null;
      },
      locked("Set struct.section on the beam or its type."),
      READS_TYPE,
    ),
    {
      path: "max_moment",
      label: "Max moment",
      classes: ["struct.beam"],
      valueType: "quantity",
      kind: "moment",
      unit: "N.m",
      writer: locked("Computed by the gravity load path."),
      group: "Loads",
      deps: READS_FRAME,
      read: (el, ctx) => {
        const b = loadPathFor(ctx.elements).beams.get(el.id);
        return b ? finite(b.maxMoment) : null;
      },
    },
    forceField("end_reaction", "End reaction", ["struct.beam"], (el, idx) => {
      const b = idx.beams.get(el.id);
      return b ? Math.max(b.startReaction.total, b.endReaction.total) : null;
    }),
    {
      path: "max_deflection",
      label: "Total-load max deflection",
      classes: ["struct.beam"],
      valueType: "quantity",
      kind: "length",
      unit: "in",
      writer: locked("Computed by the gravity load path when E and section Ix are set."),
      group: "Loads",
      deps: READS_FRAME,
      read: (el, ctx) => {
        const b = loadPathFor(ctx.elements).beams.get(el.id);
        return b?.maxDeflection !== undefined ? finite(to(b.maxDeflection, "in")) : null;
      },
    },
    {
      path: "deflection_ratio",
      label: "Total-load deflection ratio (L/Δ)",
      classes: ["struct.beam"],
      valueType: "text",
      writer: locked("Computed by the gravity load path when E and section Ix are set."),
      group: "Loads",
      deps: READS_FRAME,
      read: (el, ctx) => {
        const b = loadPathFor(ctx.elements).beams.get(el.id);
        if (b?.maxDeflection === undefined) return null;
        return deflectionRatio(b.span, b.maxDeflection);
      },
    },
    {
      path: "max_live_deflection",
      label: "Live-load max deflection",
      classes: ["struct.beam"],
      valueType: "quantity",
      kind: "length",
      unit: "in",
      writer: locked("Computed by the gravity load path when E and section Ix are set."),
      group: "Loads",
      deps: READS_FRAME,
      read: (el, ctx) => {
        const b = loadPathFor(ctx.elements).beams.get(el.id);
        return b?.maxLiveDeflection !== undefined ? finite(to(b.maxLiveDeflection, "in")) : null;
      },
    },
    {
      path: "live_deflection_ratio",
      label: "Live-load deflection ratio (L/Δ)",
      classes: ["struct.beam"],
      valueType: "text",
      writer: locked("Computed by the gravity load path when E and section Ix are set."),
      group: "Loads",
      deps: READS_FRAME,
      read: (el, ctx) => {
        const b = loadPathFor(ctx.elements).beams.get(el.id);
        return b?.maxLiveDeflection === undefined ? null : deflectionRatio(b.span, b.maxLiveDeflection);
      },
    },

    // Pad footing thickness
    mmLength(
      "thickness",
      "Thickness",
      ["struct.footing"],
      (el, els) => {
        if (el.kind !== "component") return null;
        const v = elementTypeValue(els, el, "struct.footing_thickness_mm");
        return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_FOOTING_THICKNESS_MM;
      },
      locked("Set struct.footing_thickness_mm on the footing or its type."),
      READS_TYPE,
    ),

    // Live gravity load path reactions on columns & footings (dead, live, equipment, total)
    forceField("gravity_dead", "Dead load", ["struct.column", "struct.footing"], (el, idx) => idx.columns.get(el.id)?.load.dead ?? idx.footings.get(el.id)?.load.dead ?? null),
    forceField("gravity_live", "Live load", ["struct.column", "struct.footing"], (el, idx) => idx.columns.get(el.id)?.load.live ?? idx.footings.get(el.id)?.load.live ?? null),
    forceField("gravity_equipment", "Equipment load", ["struct.column", "struct.footing"], (el, idx) => idx.columns.get(el.id)?.load.equipment ?? idx.footings.get(el.id)?.load.equipment ?? null),
    forceField("gravity_total", "Gravity load", ["struct.column", "struct.footing"], (el, idx) => idx.columns.get(el.id)?.load.total ?? idx.footings.get(el.id)?.load.total ?? null),
  ],
};
