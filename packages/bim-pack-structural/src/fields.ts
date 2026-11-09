import type { BimElement, FieldProvider, FieldWriter, Vec2 } from "@permitzip/bim-kernel";

/**
 * The structural classes' own fields (beam length, column size and
 * material), read from the kernel's stored records. Moved from the kernel's
 * spatial provider (round 14) with paths, labels and groups unchanged.
 */

type Field = NonNullable<FieldProvider["fields"]>[number];

const locked = (reason: string): FieldWriter => ({ kind: "none", reason });
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

const mmLength = (path: string, label: string, classes: readonly string[], read: (el: BimElement) => number | null, writer: FieldWriter = locked("Edit it in the model.")): Field => ({
  path,
  label,
  classes,
  valueType: "quantity",
  kind: "length",
  unit: "mm",
  writer,
  group: "Dimensions",
  read: (el) => finite(read(el)),
});

export const STRUCTURAL_FIELD_PROVIDER: FieldProvider = {
  id: "struct.members",
  fields: [
    mmLength("length", "Length", ["struct.beam"], (el) => (el.kind === "beam" ? dist(el.start, el.end) : null), locked("Drag the beam's ends.")),
    mmLength("width", "Width", ["struct.column"], (el) => (el.kind === "column" ? el.size.x : null)),
    mmLength("depth", "Depth", ["struct.column"], (el) => (el.kind === "column" ? el.size.y : null)),
    { path: "material", label: "Material", classes: ["struct.column"], valueType: "choice", choices: ["concrete", "steel"], writer: locked("Edit it in the model."), group: "Identity", read: (el) => (el.kind === "column" ? el.material : null) },
  ],
};
