/**
 * The neutral entity graph and its ISO 10303-21 (STEP Part 21) text.
 *
 * The exporter builds a list of entities whose attributes are `StepValue`s
 * and refers to other entities by handle; nothing here knows IFC. The
 * serializer numbers entities in the order they were added, so the same graph
 * always gives the same bytes.
 */

export type StepRef = { readonly ref: number };

export type StepValue =
  | null
  | StepRef
  | { readonly str: string }
  | { readonly enum: string }
  | { readonly real: number }
  | { readonly int: number }
  | { readonly bool: boolean }
  | { readonly typed: string; readonly value: StepValue }
  | { readonly list: readonly StepValue[] }
  /** `*`: a value derived by the schema in a subtype. */
  | { readonly derived: true };

export interface StepEntity {
  readonly type: string;
  readonly attrs: readonly StepValue[];
}

/**
 * A value that can't be written in a STEP file: a number that isn't finite, a text that isn't a string, an
 * enumeration that isn't upper case. Thrown where the value is made, not when the file is serialized, so the writer
 * of one record can catch it and leave that record out; by then the serializer could only stop the whole file.
 */
export class StepValueError extends Error {
  constructor(
    readonly wanted: "text" | "enum" | "real" | "int",
    message: string,
  ) {
    super(message);
    this.name = "StepValueError";
  }
}

const ENUM = /^[A-Z][A-Z0-9_]*$/;

export const $ = null;
export const str = (s: string): StepValue => {
  if (typeof s !== "string") throw new StepValueError("text", `STEP string must be text, got ${typeof s}`);
  return { str: s };
};
export const en = (e: string): StepValue => {
  if (typeof e !== "string" || !ENUM.test(e)) throw new StepValueError("enum", `STEP enumeration ".${String(e)}." must be upper case`);
  return { enum: e };
};
export const real = (n: number): StepValue => {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new StepValueError("real", `STEP real must be finite, got ${String(n)}`);
  return { real: n };
};
export const int = (n: number): StepValue => {
  if (!Number.isInteger(n)) throw new StepValueError("int", `STEP integer must be whole, got ${String(n)}`);
  return { int: n };
};
export const bool = (b: boolean): StepValue => ({ bool: b });
export const list = (items: readonly StepValue[]): StepValue => ({ list: items });
export const typed = (type: string, value: StepValue): StepValue => ({ typed: type, value });
export const opt = (s: string | null | undefined): StepValue => (s === null || s === undefined || s === "" ? null : str(s));

/** An entity graph under construction. Handles are 1-based and never reused. */
export class StepGraph {
  /** By handle, less one. Null: dropped (`dropFrom`). */
  private readonly entities: (StepEntity | null)[] = [];

  add(type: string, attrs: readonly StepValue[]): StepRef {
    if (!/^[A-Z][A-Z0-9_]*$/.test(type)) throw new Error(`STEP entity type "${type}" must be upper case`);
    this.entities.push({ type, attrs });
    return { ref: this.entities.length };
  }

  /** A handle whose entity is written later (`fill`), for a record that must point at things made after it. */
  reserve(): StepRef {
    this.entities.push({ type: "", attrs: [] });
    return { ref: this.entities.length };
  }

  fill(handle: StepRef, type: string, attrs: readonly StepValue[]): void {
    if (this.entities[handle.ref - 1]?.type !== "") throw new Error(`STEP handle #${handle.ref} is not reserved`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(type)) throw new Error(`STEP entity type "${type}" must be upper case`);
    this.entities[handle.ref - 1] = { type, attrs };
  }

  /** How many handles have been given out. Read before a record is written, it is the mark `dropFrom` takes. */
  get size(): number {
    return this.entities.length;
  }

  /**
   * Take back every entity added since the graph had `size` handles: a record's writer failed part way, and what it
   * had added must not be in the file. Their handles are not given out again, so anything still pointing at one shows
   * up as a missing reference (`missingReferences`) instead of quietly pointing at a later entity.
   */
  dropFrom(size: number): void {
    for (let i = Math.max(0, size); i < this.entities.length; i++) this.entities[i] = null;
  }

  /** The entities in the file, in handle order. */
  all(): readonly StepEntity[] {
    return this.entities.filter((e): e is StepEntity => e !== null);
  }

  /** Each entity in the file with its handle, in handle order. */
  each(visit: (entity: StepEntity, handle: number) => void): void {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e) visit(e, i + 1);
    }
  }

  /** Handles that something in the file points at but that are not in it (dropped), in order. Empty in a sound graph. */
  missingReferences(): number[] {
    const missing = new Set<number>();
    const walk = (v: StepValue): void => {
      if (v === null) return;
      if ("ref" in v) {
        if (!this.entities[v.ref - 1]) missing.add(v.ref);
      } else if ("list" in v) v.list.forEach(walk);
      else if ("typed" in v) walk(v.value);
    };
    for (const e of this.entities) if (e) e.attrs.forEach(walk);
    return [...missing].sort((a, b) => a - b);
  }
}

export interface StepHeader {
  readonly description: readonly string[];
  readonly implementationLevel: string;
  readonly fileName: string;
  /** ISO 8601, as the caller fixed it: the writer never reads a clock. */
  readonly timeStamp: string;
  readonly author: readonly string[];
  readonly organization: readonly string[];
  readonly preprocessor: string;
  readonly originatingSystem: string;
  readonly authorization: string;
  readonly schemas: readonly string[];
}

/**
 * A STEP string literal: apostrophe and backslash doubled, and every character
 * outside printable ASCII as `\X2\…\X0\` (UTF-16 code units in hex), so the
 * file is pure ASCII.
 */
export function stepString(s: string): string {
  let out = "'";
  let wide = "";
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = "";
  };
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      const ch = s.charAt(i);
      out += ch === "'" ? "''" : ch === "\\" ? "\\\\" : ch;
    } else {
      wide += code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  flush();
  return `${out}'`;
}

/** A STEP real: always a decimal point, exponents as `E±dd`, at most 15 significant digits, no negative zero. */
export function stepReal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`STEP real must be finite, got ${n}`);
  if (Object.is(n, -0) || n === 0) return "0.";
  const rounded = Number(n.toPrecision(15));
  const text = String(rounded);
  const exp = /^(-?)(\d+)(?:\.(\d+))?e([+-])(\d+)$/.exec(text);
  if (exp) {
    const [, sign, whole, frac, esign, edigits] = exp;
    return `${sign}${whole}.${frac ?? ""}E${esign === "-" ? "-" : ""}${(edigits ?? "0").padStart(2, "0")}`;
  }
  return text.includes(".") ? text : `${text}.`;
}

export function stepValue(v: StepValue): string {
  if (v === null) return "$";
  if ("ref" in v) return `#${v.ref}`;
  if ("str" in v) return stepString(v.str);
  if ("enum" in v) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v.enum)) throw new Error(`STEP enumeration ".${v.enum}." must be upper case`);
    return `.${v.enum}.`;
  }
  if ("real" in v) return stepReal(v.real);
  if ("int" in v) {
    if (!Number.isInteger(v.int)) throw new Error(`STEP integer must be whole, got ${v.int}`);
    return String(v.int);
  }
  if ("bool" in v) return v.bool ? ".T." : ".F.";
  if ("typed" in v) return `${v.typed}(${stepValue(v.value)})`;
  if ("list" in v) return `(${v.list.map(stepValue).join(",")})`;
  return "*";
}

function headerList(items: readonly string[]): string {
  return `(${items.map(stepString).join(",")})`;
}

/** The whole Part 21 file. One entity per line, `\n` line ends. */
export function serializeStep(header: StepHeader, graph: StepGraph): string {
  const lines: string[] = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(${headerList(header.description)},${stepString(header.implementationLevel)});`,
    `FILE_NAME(${stepString(header.fileName)},${stepString(header.timeStamp)},${headerList(header.author)},${headerList(header.organization)},${stepString(header.preprocessor)},${stepString(header.originatingSystem)},${stepString(header.authorization)});`,
    `FILE_SCHEMA(${headerList(header.schemas)});`,
    "ENDSEC;",
    "DATA;",
  ];
  graph.each((e, handle) => {
    if (!e.type) throw new Error(`STEP handle #${handle} was reserved and never written`);
    lines.push(`#${handle}=${e.type}(${e.attrs.map(stepValue).join(",")});`);
  });
  lines.push("ENDSEC;", "END-ISO-10303-21;", "");
  return lines.join("\n");
}
