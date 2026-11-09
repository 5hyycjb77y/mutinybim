import { z } from "zod";

/**
 * The agent edit tools' argument schemas, built once per process: the same
 * schema object comes back for the same shape objects, so a handler parses
 * without building a schema per call. Pass module-level shapes (a spread
 * literal is a new object each call and would miss). The tools' `inputSchema`
 * (what the model sees) is separate and unchanged.
 */

type AnyObject = z.ZodObject<z.ZodRawShape>;

const single = new WeakMap<z.ZodRawShape, AnyObject>();
const paired = new WeakMap<z.ZodRawShape, WeakMap<z.ZodRawShape, AnyObject>>();
const tripled = new WeakMap<z.ZodRawShape, WeakMap<z.ZodRawShape, WeakMap<z.ZodRawShape, AnyObject>>>();
let builds = 0;

/** How many schemas this module has built since the process started (tests: a second call builds none). */
export function editSchemaBuilds(): number {
  return builds;
}

function built<T extends AnyObject>(schema: T): T {
  builds += 1;
  return schema;
}

/** `z.object(shape)`, built once for this shape object. */
export function schemaOnce<A extends z.ZodRawShape>(a: A): z.ZodObject<A> {
  const hit = single.get(a);
  if (hit) return hit as z.ZodObject<A>;
  const schema = built(z.object(a));
  single.set(a, schema);
  return schema;
}

/** `z.object({ ...a, ...b })`, built once for this pair of shape objects. */
export function schemaOnce2<A extends z.ZodRawShape, B extends z.ZodRawShape>(a: A, b: B): z.ZodObject<A & B> {
  let inner = paired.get(a);
  if (!inner) {
    inner = new WeakMap();
    paired.set(a, inner);
  }
  const hit = inner.get(b);
  if (hit) return hit as z.ZodObject<A & B>;
  const schema = built(z.object({ ...a, ...b }));
  inner.set(b, schema);
  return schema;
}

/** `z.object({ ...a, ...b, ...c })`, built once for these three shape objects. */
export function schemaOnce3<A extends z.ZodRawShape, B extends z.ZodRawShape, C extends z.ZodRawShape>(a: A, b: B, c: C): z.ZodObject<A & B & C> {
  let byA = tripled.get(a);
  if (!byA) {
    byA = new WeakMap();
    tripled.set(a, byA);
  }
  let byB = byA.get(b);
  if (!byB) {
    byB = new WeakMap();
    byA.set(b, byB);
  }
  const hit = byB.get(c);
  if (hit) return hit as z.ZodObject<A & B & C>;
  const schema = built(z.object({ ...a, ...b, ...c }));
  byB.set(c, schema);
  return schema;
}
