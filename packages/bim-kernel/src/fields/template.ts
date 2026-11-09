/**
 * Text templates for tags, schedule cells and headers:
 *
 *   {feeder.source.name}[ via {feeder.breaker}][ via {feeder.type}]
 *
 * `{path}` is a field path (fields/resolver.ts). `{path|text}` prints `text`
 * when the field has no value. `[ … ]` is an optional group: it prints only
 * when every field inside it has a value, so "MDP via 225A/3P" never reads
 * "MDP via 225A/3P via " before a feeder type is chosen. Groups nest. Outside
 * a group, a field with no value also drops the text glued to its right up to
 * the next space, so "{bus_rating}A BUS" prints "BUS", not "A BUS".
 * `\{ \} \[ \] \\` print the character itself.
 */

export type TemplatePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "field"; readonly path: string; readonly fallback?: string }
  | { readonly kind: "group"; readonly parts: readonly TemplatePart[] };

export type ParsedTemplate =
  | { readonly ok: true; readonly parts: readonly TemplatePart[]; readonly fields: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly at: number };

const MAX_TEMPLATE = 400;
const MAX_PATH = 80;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const parsedCache = new Map<string, ParsedTemplate>();

export function parseFieldTemplate(text: string): ParsedTemplate {
  const known = parsedCache.get(text);
  if (known) return known;
  const result = parse(text);
  if (parsedCache.size > 2000) parsedCache.clear();
  parsedCache.set(text, result);
  return result;
}

function parse(text: string): ParsedTemplate {
  if (text.length > MAX_TEMPLATE) return { ok: false, error: `A template is at most ${MAX_TEMPLATE} characters`, at: MAX_TEMPLATE };
  const fields: string[] = [];
  const stack: TemplatePart[][] = [[]];
  const opens: number[] = [];
  let literal = "";
  const flush = () => {
    if (literal) (stack[stack.length - 1] as TemplatePart[]).push({ kind: "text", text: literal });
    literal = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined || !"{}[]\\".includes(next)) return { ok: false, error: "A backslash escapes { } [ ] or another backslash", at: i };
      literal += next;
      i++;
      continue;
    }
    if (c === "{") {
      const end = text.indexOf("}", i + 1);
      if (end < 0) return { ok: false, error: "A { has no closing }", at: i };
      const inner = text.slice(i + 1, end);
      const bar = inner.indexOf("|");
      const path = (bar < 0 ? inner : inner.slice(0, bar)).trim();
      const fallback = bar < 0 ? undefined : inner.slice(bar + 1);
      if (!path) return { ok: false, error: "Empty {} : put a field name inside, like {circuit.name}", at: i };
      if (path.length > MAX_PATH || !PATH.test(path)) return { ok: false, error: `"${path}" is not a field name: use letters, digits and _ joined by dots, like {feeder.source.name}`, at: i };
      flush();
      (stack[stack.length - 1] as TemplatePart[]).push(fallback === undefined ? { kind: "field", path } : { kind: "field", path, fallback });
      fields.push(path);
      i = end;
      continue;
    }
    if (c === "}") return { ok: false, error: "A } has no opening {", at: i };
    if (c === "[") {
      flush();
      stack.push([]);
      opens.push(i);
      continue;
    }
    if (c === "]") {
      if (stack.length < 2) return { ok: false, error: "A ] has no opening [", at: i };
      flush();
      const parts = stack.pop() as TemplatePart[];
      opens.pop();
      (stack[stack.length - 1] as TemplatePart[]).push({ kind: "group", parts });
      continue;
    }
    literal += c;
  }
  if (stack.length > 1) return { ok: false, error: "A [ has no closing ]", at: opens[opens.length - 1] ?? 0 };
  flush();
  return { ok: true, parts: stack[0] as TemplatePart[], fields };
}

/**
 * Fill a parsed template. `value` answers one field path ("" when it has
 * none). Returns the text, whether any field had a value (a template with no
 * fields counts as having one), and the paths that had no value and no
 * fallback.
 */
export function fillTemplate(parts: readonly TemplatePart[], value: (path: string) => string): { readonly text: string; readonly any: boolean; readonly missing: readonly string[] } {
  let text = "";
  let any = false;
  let dropGlued = false;
  const missing: string[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      text += dropGlued ? p.text.replace(/^\S+/, "") : p.text;
      dropGlued = false;
    } else if (p.kind === "field") {
      const v = value(p.path);
      if (v) {
        any = true;
        text += v;
        dropGlued = false;
      } else if (p.fallback !== undefined) {
        text += p.fallback;
        dropGlued = false;
      } else {
        missing.push(p.path);
        dropGlued = true;
      }
    } else {
      const inner = fillGroup(p.parts, value, missing);
      if (inner !== null) {
        text += inner.text;
        if (inner.fields > 0) any = true;
      }
      dropGlued = false;
    }
  }
  return { text, any: any || !hasFields(parts), missing };
}

function hasFields(parts: readonly TemplatePart[]): boolean {
  return parts.some((p) => p.kind === "field" || (p.kind === "group" && hasFields(p.parts)));
}

/** A group prints only when every field directly inside it has a value (or a fallback); nested groups decide for themselves. */
function fillGroup(parts: readonly TemplatePart[], value: (path: string) => string, missing: string[]): { text: string; fields: number } | null {
  let text = "";
  let fields = 0;
  for (const p of parts) {
    if (p.kind === "text") text += p.text;
    else if (p.kind === "field") {
      const v = value(p.path) || (p.fallback ?? "");
      if (!v) {
        missing.push(p.path);
        return null;
      }
      fields += 1;
      text += v;
    } else {
      const inner = fillGroup(p.parts, value, missing);
      if (inner) {
        text += inner.text;
        fields += inner.fields;
      }
    }
  }
  return { text, fields };
}
