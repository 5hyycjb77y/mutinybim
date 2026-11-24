/**
 * A small STEP Part 21 reader: enough to check a written file without wasm
 * (entity counts, GlobalIds, names, references). Not a general IFC reader;
 * linked models are read with web-ifc.
 */

export type StepToken =
  | { readonly kind: "ref"; readonly id: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "enum"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "null" }
  | { readonly kind: "derived" }
  | { readonly kind: "typed"; readonly type: string; readonly value: StepToken }
  | { readonly kind: "list"; readonly items: readonly StepToken[] };

export interface ReadEntity {
  readonly id: number;
  readonly type: string;
  readonly args: readonly StepToken[];
}

export interface StepFile {
  readonly schemas: readonly string[];
  readonly entities: ReadonlyMap<number, ReadEntity>;
}

/** Decode a STEP string body (between the apostrophes): `''`, `\\`, `\X2\…\X0\` and `\X4\…\X0\`. */
export function decodeStepString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === "'" && body.charAt(i + 1) === "'") {
      out += "'";
      i++;
    } else if (ch === "\\" && body.startsWith("\\X2\\", i)) {
      const end = body.indexOf("\\X0\\", i + 4);
      if (end < 0) throw new Error("STEP string: \\X2\\ without \\X0\\");
      const hex = body.slice(i + 4, end);
      for (let k = 0; k < hex.length; k += 4) out += String.fromCharCode(Number.parseInt(hex.slice(k, k + 4), 16));
      i = end + 3;
    } else if (ch === "\\" && body.startsWith("\\X4\\", i)) {
      const end = body.indexOf("\\X0\\", i + 4);
      if (end < 0) throw new Error("STEP string: \\X4\\ without \\X0\\");
      const hex = body.slice(i + 4, end);
      for (let k = 0; k < hex.length; k += 8) out += String.fromCodePoint(Number.parseInt(hex.slice(k, k + 8), 16));
      i = end + 3;
    } else if (ch === "\\" && body.charAt(i + 1) === "\\") {
      out += "\\";
      i++;
    } else out += ch;
  }
  return out;
}

/** Return the offset after a quoted string, including any doubled apostrophes. */
function afterString(text: string, opening: number): number {
  let i = opening + 1;
  for (;;) {
    const quote = text.indexOf("'", i);
    if (quote < 0) throw new Error("STEP: unterminated string");
    if (text.charAt(quote + 1) !== "'") return quote + 1;
    i = quote + 2;
  }
}

/** Split records at semicolons outside strings and replace comments with a token separator. */
function* statements(text: string): Generator<string> {
  const delimiter = /[;']|\/(?=\*)/g;
  let start = 0;
  let prefix = "";
  while (delimiter.test(text)) {
    const at = delimiter.lastIndex - 1;
    const ch = text.charAt(at);
    if (ch === "'") {
      delimiter.lastIndex = afterString(text, at);
    } else if (ch === "/") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) throw new Error("STEP: unterminated comment");
      prefix += text.slice(start, at) + " ";
      start = end + 2;
      delimiter.lastIndex = start;
    } else {
      yield prefix + text.slice(start, at);
      start = delimiter.lastIndex;
      prefix = "";
    }
  }
}

class Cursor {
  i = 0;
  constructor(readonly s: string) {}

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s.charAt(this.i))) this.i++;
  }

  value(): StepToken {
    this.ws();
    const c = this.s.charAt(this.i);
    if (c === "$") {
      this.i++;
      return { kind: "null" };
    }
    if (c === "*") {
      this.i++;
      return { kind: "derived" };
    }
    if (c === "#") {
      const m = /^#(\d+)/.exec(this.s.slice(this.i));
      if (!m?.[1]) throw new Error(`STEP: bad reference at ${this.i}`);
      this.i += m[0].length;
      return { kind: "ref", id: Number(m[1]) };
    }
    if (c === "'") {
      const start = this.i + 1;
      this.i = afterString(this.s, this.i);
      return { kind: "string", value: decodeStepString(this.s.slice(start, this.i - 1)) };
    }
    if (c === ".") {
      const k = this.s.indexOf(".", this.i + 1);
      const value = this.s.slice(this.i + 1, k);
      this.i = k + 1;
      return { kind: "enum", value };
    }
    if (c === "(") return { kind: "list", items: this.items() };
    const num = /^[+-]?(\d+\.?\d*(?:E[+-]?\d+)?)/i.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return { kind: "number", value: Number(num[0]) };
    }
    const type = /^[A-Z][A-Z0-9_]*/i.exec(this.s.slice(this.i));
    if (type) {
      this.i += type[0].length;
      this.ws();
      if (this.s.charAt(this.i) !== "(") throw new Error(`STEP: ${type[0]} without a value`);
      this.i++;
      const inner = this.value();
      this.ws();
      this.i++;
      return { kind: "typed", type: type[0].toUpperCase(), value: inner };
    }
    throw new Error(`STEP: unexpected "${c}" at ${this.i}`);
  }

  items(): StepToken[] {
    this.i++;
    const out: StepToken[] = [];
    this.ws();
    if (this.s.charAt(this.i) === ")") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s.charAt(this.i++);
      if (c === ")") return out;
      if (c !== ",") throw new Error(`STEP: expected , or ) at ${this.i - 1}`);
    }
  }
}

/** Parse a Part 21 file's schema line and DATA section. Throws on text it cannot read. */
export function readStep(text: string): StepFile {
  let schemas: string[] = [];
  const entities = new Map<number, ReadEntity>();
  const head = /^\s*#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\s*/i;
  let inData = false;
  for (const statement of statements(text)) {
    if (!inData) {
      if (statement.trim() === "DATA") inData = true;
      const schema = /^\s*FILE_SCHEMA\s*\(\s*\(([^)]*)\)\s*\)/.exec(statement);
      if (schema?.[1]) schemas = [...schema[1].matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
      continue;
    }
    const match = head.exec(statement);
    if (!match) {
      if (statement.trim() === "ENDSEC") return { schemas, entities };
      continue;
    }
    const cursor = new Cursor(statement);
    cursor.i = match[0].length;
    const id = Number(match[1]);
    const args = cursor.items();
    cursor.ws();
    if (statement.charAt(cursor.i) === "#") throw new Error(`STEP: expected ; after #${id}`);
    entities.set(id, { id, type: (match[2] ?? "").toUpperCase(), args });
  }
  throw new Error(inData ? "STEP: DATA section is missing its closing ENDSEC;" : "STEP: no DATA section");
}

/** Rooted entities (they carry a GlobalId first): their GlobalId and Name. */
export function rootedEntities(file: StepFile): ReadonlyArray<{ readonly id: number; readonly type: string; readonly globalId: string; readonly name: string | null }> {
  const out: Array<{ id: number; type: string; globalId: string; name: string | null }> = [];
  for (const e of file.entities.values()) {
    const first = e.args[0];
    const name = e.args[2];
    if (first?.kind === "string" && /^[0-3][0-9A-Za-z_$]{21}$/.test(first.value)) out.push({ id: e.id, type: e.type, globalId: first.value, name: name?.kind === "string" ? name.value : null });
  }
  return out;
}

/** How many entities of each type. */
export function entityCounts(file: StepFile): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of file.entities.values()) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

/** Every `#n` that points at no entity: a broken file. */
export function danglingReferences(file: StepFile): number[] {
  const missing = new Set<number>();
  const walk = (t: StepToken) => {
    if (t.kind === "ref" && !file.entities.has(t.id)) missing.add(t.id);
    else if (t.kind === "list") t.items.forEach(walk);
    else if (t.kind === "typed") walk(t.value);
  };
  for (const e of file.entities.values()) e.args.forEach(walk);
  return [...missing].sort((a, b) => a - b);
}
