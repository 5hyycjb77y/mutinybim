import { boundsRooms, OPENING_VOID_ROW, type BimElement, type FieldProvider, type FieldWriter, type Vec2 } from "@permitzip/bim-kernel";
import { ARCHITECTURE_CLASSES } from "./classes";
import { DOOR_OPERATION_KEY } from "./graphics";
import { FIRE_RESISTANCE_RATING } from "./ratings";
import { valueOf } from "./values";

/**
 * The building classes' own fields (lengths, sizes, areas, room names), read
 * from the kernel's stored records. They live with the classes: a pack set
 * without this add-on has neither.
 */

type Field = NonNullable<FieldProvider["fields"]>[number];

const MM2_PER_M2 = 1e6;
const locked = (reason: string): FieldWriter => ({ kind: "none", reason });
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const textOrNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === "" ? null : v);
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

function outlineAreaMm2(outline: readonly Vec2[]): number {
  let twice = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j];
    const b = outline[i];
    if (a && b) twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

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

type Elements = Readonly<Record<string, BimElement>>;

/** The opening's cut in its host (the kernel's void row): sill and head heights above the host's base, mm. */
function cutOf(el: BimElement, elements: Elements): { readonly sill: number; readonly head: number } | null {
  if (el.kind !== "opening") return null;
  const host = elements[el.hostId];
  const profile = host ? OPENING_VOID_ROW.voidOf(el, host, elements)?.profile : undefined;
  const ys = (profile ?? []).map((p) => p.y);
  return ys.length === 0 ? null : { sill: Math.min(...ys), head: Math.max(...ys) };
}

/** An IFC enumeration as words: `SINGLE_SWING_LEFT` → "Single swing left". */
function enumWords(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const words = v.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const READS_TYPE = { elementKinds: ["element_type"] } as const;
const WALL_FUNCTION_KEY = "architecture.wall_function";
const TOTAL_THICKNESS_KEY = "architecture.total_thickness";
const ARCHITECTURE_CLASS_IDS: readonly string[] = ARCHITECTURE_CLASSES.map((c) => c.id);

/** The element type's name, else the name an older record carries itself (a wall's `wallType`). */
function typeNameOf(el: BimElement, elements: Elements): string | null {
  const typeId = "typeId" in el && typeof el.typeId === "string" ? el.typeId : undefined;
  const type = typeId === undefined ? undefined : elements[typeId];
  if (type?.kind === "element_type") return textOrNull(type.name);
  if (el.kind === "wall") return textOrNull(el.wallType);
  return "typeName" in el && typeof el.typeName === "string" ? textOrNull(el.typeName) : null;
}

export const ARCHITECTURE_FIELD_PROVIDER: FieldProvider = {
  id: "architecture.building",
  fields: [
    {
      path: "fire_rating",
      label: "Fire rating",
      classes: ["arch.wall", "arch.door", "arch.window", "arch.slab", "arch.ceiling"],
      valueType: "text",
      writer: locked("Set the fire rating on the type or in Properties."),
      group: "Ratings",
      deps: READS_TYPE,
      read: (el, ctx) => {
        const hours = FIRE_RESISTANCE_RATING.read?.(el, ctx.elements) ?? null;
        return hours === null ? null : (FIRE_RESISTANCE_RATING.format?.(hours) ?? `${hours} h`);
      },
    },
    { path: "type", label: "Type", classes: ARCHITECTURE_CLASS_IDS, valueType: "text", writer: locked("Pick another type in Properties."), group: "Identity", deps: READS_TYPE, read: (el, ctx) => typeNameOf(el, ctx.elements) },
    { path: "function", label: "Wall function", classes: ["arch.wall"], valueType: "text", writer: locked("Set the wall function on the type."), group: "Identity", deps: READS_TYPE, read: (el, ctx) => enumWords(valueOf(el, ctx.elements, WALL_FUNCTION_KEY)) },
    { ...mmLength("total_thickness", "Total thickness", ["arch.wall"], () => null, locked("Set the total thickness on the type.")), deps: READS_TYPE, read: (el, ctx) => finite(valueOf(el, ctx.elements, TOTAL_THICKNESS_KEY)) ?? (el.kind === "wall" ? finite(el.thickness) : null) },
    { path: "bounds_rooms", label: "Room bounding", classes: ["arch.wall"], valueType: "boolean", writer: locked("Turn room bounding on or off in Properties."), group: "Identity", deps: READS_TYPE, read: (el, ctx) => (el.kind === "wall" ? boundsRooms(el, ctx.elements) : null) },
    { path: "swing", label: "Swing", classes: ["arch.door"], valueType: "text", writer: locked("Set the door's operation on its type or in Properties."), group: "Identity", deps: READS_TYPE, read: (el, ctx) => enumWords(valueOf(el, ctx.elements, DOOR_OPERATION_KEY)) },
    { ...mmLength("sill", "Sill height", ["arch.door", "arch.window"], () => null, locked("Set the sill height on the type or in Properties.")), deps: READS_TYPE, read: (el, ctx) => finite(cutOf(el, ctx.elements)?.sill) },
    { ...mmLength("head", "Head height", ["arch.door", "arch.window"], () => null, locked("Change the sill height or the opening's height.")), deps: READS_TYPE, read: (el, ctx) => finite(cutOf(el, ctx.elements)?.head) },
    mmLength("length", "Length", ["arch.wall"], (el) => (el.kind === "wall" ? dist(el.start, el.end) : null), locked("Drag the wall's ends.")),
    mmLength("height", "Height", ["arch.wall"], (el) => (el.kind === "wall" ? el.height : null)),
    mmLength("thickness", "Thickness", ["arch.wall"], (el) => (el.kind === "wall" ? el.thickness : null)),
    mmLength("width", "Width", ["arch.door", "arch.window"], (el) => (el.kind === "opening" ? el.width : null)),
    mmLength("height", "Height", ["arch.door", "arch.window"], (el) => (el.kind === "opening" ? el.height : null)),
    mmLength("thickness", "Thickness", ["arch.slab"], (el) => (el.kind === "slab" ? el.thickness : null)),
    { path: "area", label: "Area", classes: ["arch.slab"], valueType: "quantity", kind: "area", unit: "m2", writer: locked("Edit the slab's outline."), group: "Dimensions", read: (el) => (el.kind === "slab" ? outlineAreaMm2(el.outline) / MM2_PER_M2 : null) },
    { path: "number", label: "Room number", classes: ["arch.room"], valueType: "text", writer: locked("Rename the room in the model."), group: "Identity", read: (el) => (el.kind === "room" ? textOrNull(el.number) : null) },
    { path: "name", label: "Room name", classes: ["arch.room"], valueType: "text", writer: locked("Rename the room in the model."), group: "Identity", read: (el) => (el.kind === "room" ? textOrNull(el.name) : null) },
    { path: "area", label: "Area", classes: ["arch.room"], valueType: "quantity", kind: "area", unit: "m2", writer: locked("Edit the room's outline."), group: "Dimensions", read: (el) => (el.kind === "room" ? finite(el.areaSqM) : null) },
  ],
};
