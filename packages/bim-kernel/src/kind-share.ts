import type { BimElement } from "./types";

/**
 * One shared string per element kind.
 *
 * Rows parsed from storage (the model server's boot pages, a browser's sync
 * payloads) each carry their own copy of every kind longer than the engine
 * shares on parse (in V8, roughly over 10 characters). Every kind
 * test on the head then reads a separate, scattered string per element: on a
 * million-element model that alone doubled the group and phase display
 * resolve (`view.visibility.resolve`, internal design note).
 * Indexing a plain record swaps each element's kind for one shared copy: the
 * same value and the same JSON, so nothing a reader can observe changes.
 */

/** Kinds are a registry's worth (tens to low hundreds); a record naming more than this is left as it is. */
const MAX_SHARED_KINDS = 4096;

const shared = new Map<string, string>();

/** The shared copy of `kind` (a property key, so the engine keeps one string for it). */
export function sharedKind(kind: string): string {
  const known = shared.get(kind);
  if (known !== undefined) return known;
  if (shared.size >= MAX_SHARED_KINDS) return kind;
  const key = Object.keys({ [kind]: 0 })[0] ?? kind;
  shared.set(key, key);
  return key;
}

/**
 * Point `el.kind` at the shared copy. A frozen element keeps its own (same
 * value); any other refusal is a real fault and is thrown. The frozen test runs
 * only on refusal: asking every element costs a third of the whole pass.
 */
export function shareElementKind(el: BimElement): void {
  if (typeof el.kind !== "string") return;
  const kind = sharedKind(el.kind);
  try {
    (el as { kind: string }).kind = kind;
  } catch (err) {
    if (!Object.isFrozen(el)) throw err;
  }
}
