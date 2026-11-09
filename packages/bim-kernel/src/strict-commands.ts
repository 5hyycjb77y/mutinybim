import { z } from "zod";

type Strict<T> = T extends z.ZodObject<infer Shape, z.core.$ZodObjectConfig> ? z.ZodObject<Shape, z.core.$strict> : never;

/**
 * Command schemas refuse a key they don't take instead of dropping it. A
 * field sent is either used or refused by name: `crop_min_ft` on a crop that
 * takes millimetres, or a top-level `level` on a command that takes
 * `props.level`, used to vanish and the edit went ahead without it.
 */
export function strictCommands<const T extends readonly z.ZodObject[]>(schemas: T): { readonly [K in keyof T]: Strict<T[K]> } {
  const strict: readonly z.ZodObject[] = schemas.map((s) => s.strict());
  // `map` can't keep a tuple's element types; each entry is exactly its input made strict.
  return strict as { readonly [K in keyof T]: Strict<T[K]> };
}

/** For a refused key on `command`: the keys that command does take, from the schema it would have matched. */
export function acceptedKeys(options: readonly z.ZodObject[], type: unknown): readonly string[] | null {
  const match = options.find((s) => {
    const literal = s.shape.type;
    return literal instanceof z.ZodLiteral && literal.value === type;
  });
  return match ? Object.keys(match.shape).filter((k) => k !== "type") : null;
}

/** Units of the fields people most often send in the wrong unit. Every length a command takes is millimetres. */
const UNIT_HINTS: Readonly<Record<string, string>> = {
  crop: "crop { min: {x, y}, max: {x, y} } in millimetres",
  center: "center {x, y} in paper millimetres from the sheet's top-left",
  size: "size {x, y} in paper millimetres",
  delta: "delta in millimetres",
  position: "position in millimetres",
  points: "points in millimetres",
  props: "props { level, scale, cutHeightMm, … }",
};

function unitOf(key: string): string {
  const hint = UNIT_HINTS[key];
  if (hint) return hint;
  if (key.endsWith("Mm")) return `${key} (mm)`;
  if (key.endsWith("Deg")) return `${key} (degrees)`;
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at `path` inside `input`, or undefined. */
function at(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === "number") cur = cur[key];
    else if (isRecord(cur) && typeof key === "string") cur = cur[key];
    else return undefined;
  }
  return cur;
}

/**
 * A command that didn't parse, in words an agent or person can act on: an
 * unknown key is named with the keys that command does take and their units
 * ("set_view_crop doesn't take crop_min_ft; it takes viewId, crop { min, max }
 * in millimetres, …"). Other problems name the field and zod's reason.
 */
export function describeCommandIssue(options: readonly z.ZodObject[], error: z.ZodError, input: unknown): string {
  const unknown = error.issues.find((i) => i.code === "unrecognized_keys");
  if (unknown && unknown.code === "unrecognized_keys") {
    const owner = at(input, unknown.path);
    const type = isRecord(owner) ? owner.type : undefined;
    const where = unknown.path.length > 0 ? ` (at ${unknown.path.join(".")})` : "";
    const keys = unknown.keys.join(", ");
    const accepted = acceptedKeys(options, type);
    const what = typeof type === "string" ? type : "This command";
    const them = unknown.keys.length === 1 ? "it" : "them";
    return `${what} doesn't take ${keys}${where}, so nothing was sent rather than dropping ${them}.${accepted ? ` It takes: ${accepted.map(unitOf).join(", ")}.` : ""}`;
  }
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "command"}: ${issue.message}` : "the command isn't well formed";
}
