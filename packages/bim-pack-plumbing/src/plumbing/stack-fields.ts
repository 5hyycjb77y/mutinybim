import type { FieldPathInfo, FieldScalar, BimElement, ElementId } from "@permitzip/bim-kernel";
import { inchText, stackAt, type StackView } from "./stacks";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Stack fields on any piece of a stack (a pipe, an offset, a joint), so a tag
 * on the stack prints `{stack.tag}` or its own arrangement of the parts
 * (`{stack.size}//{stack.system_code}/{stack.serves}//{stack.number}`), and a
 * schedule lists stacks by number. Read from the stack each time.
 */

export const STACK_FIELD_PATHS: readonly FieldPathInfo[] = [
  { path: "stack.tag", label: "Stack tag (size // system / rooms // number)", on: "pipe", example: '4"//S/K/L//19' },
  { path: "stack.number", label: "Stack number", on: "pipe", example: "19" },
  { path: "stack.name", label: "Stack name", on: "pipe", example: "Kitchen stack" },
  { path: "stack.size", label: "Stack size at its base", on: "pipe", example: '4"' },
  { path: "stack.system_code", label: "Stack system letter", on: "pipe", example: "S" },
  { path: "stack.serves", label: "Rooms the stack serves (code)", on: "pipe", example: "K/L" },
  { path: "stack.rooms", label: "Rooms the stack serves", on: "pipe", example: "Kitchen, Laundry" },
  { path: "stack.dfu", label: "Drainage fixture units at the stack's base", on: "pipe", example: "30" },
  { path: "stack.floors", label: "Floors the stack runs through", on: "pipe", example: "3" },
];

const PATHS: ReadonlySet<string> = new Set(STACK_FIELD_PATHS.map((p) => p.path));

function read(s: StackView, path: string): FieldScalar {
  switch (path) {
    case "stack.tag":
      return s.tag;
    case "stack.number":
      return s.number;
    case "stack.name":
      return s.name;
    case "stack.size":
      return s.sizeIn;
    case "stack.system_code":
      return s.systemCode || null;
    case "stack.serves":
      return s.servesCode || null;
    case "stack.rooms":
      return s.rooms.length > 0 ? s.rooms.join(", ") : null;
    case "stack.dfu":
      return s.dfuAtBase;
    case "stack.floors":
      return s.floors.length;
    default:
      return null;
  }
}

/** A `stack.*` path on an element, or null when the path isn't a stack path (other resolvers answer it). */
export function resolveStackField(elements: Elements, elementId: string, path: string): { readonly value: FieldScalar; readonly text: string } | null {
  if (!PATHS.has(path)) return null;
  const s = stackAt(elements, elementId as ElementId);
  const value = s ? read(s, path) : null;
  if (value === null) return { value: null, text: "" };
  const text = path === "stack.size" && typeof value === "number" ? inchText(value) : typeof value === "number" ? String(Math.round(value * 100) / 100) : String(value);
  return { value, text };
}
