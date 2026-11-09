/**
 * Formula syntax:
 *
 *   {own.mbh} * 1000 Btu/h          field, number with a unit
 *   if({load_class} = "Motor", {load} * 1.25, {load})
 *   sum(serves, {load.wsfu_total})   aggregate over a relationship
 *   round({length}, 1 in)            rounding to a step keeps the unit honest
 *   PZ.GasDemandBtuh({own.mbh}, 0.8) named library calculation
 *
 * Precedence, loosest first: `or`, `and`, `not`, comparisons
 * (`= <> != < <= > >=`, non-associative), `+ -`, `* /`, unary `-`, `^`
 * (right-associative, so `-2^2` is -4). `{path}` uses the kernel template
 * convention: letters, digits and `_` joined by dots.
 */

import type { FormulaError, SourceSpan } from "./types";
import { readUnitSpelling } from "./units";

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "=" | "<>" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type Node =
  | { readonly k: "num"; readonly id: number; readonly span: SourceSpan; readonly value: number; readonly unit: string | null }
  | { readonly k: "str"; readonly id: number; readonly span: SourceSpan; readonly value: string }
  | { readonly k: "bool"; readonly id: number; readonly span: SourceSpan; readonly value: boolean }
  | { readonly k: "field"; readonly id: number; readonly span: SourceSpan; readonly path: string }
  | { readonly k: "ident"; readonly id: number; readonly span: SourceSpan; readonly name: string }
  | { readonly k: "unary"; readonly id: number; readonly span: SourceSpan; readonly op: "-" | "not"; readonly arg: Node }
  | { readonly k: "binary"; readonly id: number; readonly span: SourceSpan; readonly opSpan: SourceSpan; readonly op: BinaryOp; readonly left: Node; readonly right: Node }
  | { readonly k: "call"; readonly id: number; readonly span: SourceSpan; readonly nameSpan: SourceSpan; readonly name: string; readonly args: readonly Node[] };

export type ParseResult = { readonly ok: true; readonly node: Node; readonly nodeCount: number } | { readonly ok: false; readonly error: FormulaError };

/** Matches the library's limit on a calculation's expression (bim-library calculationItemSchema). */
export const MAX_SOURCE = 4000;
const MAX_DEPTH = 64;
const MAX_UNIT_LENGTH = 24;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

type Token =
  | { readonly t: "num"; readonly span: SourceSpan; readonly value: number; readonly unit: string | null }
  | { readonly t: "str"; readonly span: SourceSpan; readonly value: string }
  | { readonly t: "field"; readonly span: SourceSpan; readonly path: string }
  | { readonly t: "ident"; readonly span: SourceSpan; readonly name: string }
  | { readonly t: "op"; readonly span: SourceSpan; readonly op: string }
  | { readonly t: "end"; readonly span: SourceSpan };

class ParseError extends Error {
  constructor(
    message: string,
    readonly span: SourceSpan,
    readonly code: FormulaError["code"] = "syntax",
  ) {
    super(message);
  }
}

const span = (start: number, end: number): SourceSpan => ({ start, end });

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      i += text.length;
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ParseError(`"${text}" is not a number`, span(start, i));
      const unit = readUnit(src, i);
      if (unit) {
        tokens.push({ t: "num", span: span(start, unit.end), value, unit: unit.code });
        i = unit.end;
      } else {
        tokens.push({ t: "num", span: span(start, i), value, unit: null });
      }
      continue;
    }
    if (c === '"') {
      let value = "";
      i++;
      for (;;) {
        const d = src[i];
        if (d === undefined) throw new ParseError('A " has no closing "', span(start, start + 1));
        if (d === "\\") {
          const next = src[i + 1];
          if (next !== '"' && next !== "\\") throw new ParseError('A backslash inside text escapes " or another backslash', span(i, i + 2));
          value += next;
          i += 2;
          continue;
        }
        i++;
        if (d === '"') break;
        value += d;
      }
      tokens.push({ t: "str", span: span(start, i), value });
      continue;
    }
    if (c === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) throw new ParseError("A { has no closing }", span(i, i + 1));
      const path = src.slice(i + 1, end).trim();
      if (!path) throw new ParseError("Empty {}: put a field name inside, like {own.mbh}", span(i, end + 1));
      if (!PATH.test(path)) throw new ParseError(`"${path}" is not a field name: use letters, digits and _ joined by dots, like {own.mbh}`, span(i, end + 1));
      i = end + 1;
      tokens.push({ t: "field", span: span(start, i), path });
      continue;
    }
    if (c === "}") throw new ParseError("A } has no opening {", span(i, i + 1));
    if (IDENT_START.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
      const name = m?.[0] ?? c;
      i += name.length;
      tokens.push({ t: "ident", span: span(start, i), name });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "!=" || two === "<=" || two === ">=") {
      tokens.push({ t: "op", span: span(i, i + 2), op: two === "!=" ? "<>" : two });
      i += 2;
      continue;
    }
    if (c === "×" || c === "÷") {
      tokens.push({ t: "op", span: span(i, i + 1), op: c === "×" ? "*" : "/" });
      i++;
      continue;
    }
    if ("+-*/^=<>(),".includes(c)) {
      tokens.push({ t: "op", span: span(i, i + 1), op: c });
      i++;
      continue;
    }
    throw new ParseError(`"${c}" can't be used here`, span(i, i + 1));
  }
  tokens.push({ t: "end", span: span(src.length, src.length) });
  return tokens;
}

/**
 * The unit written after a number, longest registered match first, so
 * "1000 Btu/h / 2" reads the unit "Btu/h" and then divides by 2.
 */
function readUnit(src: string, from: number): { code: string; end: number } | null {
  let i = from;
  while (src[i] === " " || src[i] === "\t") i++;
  const first = src[i];
  if (first === undefined || /[0-9+\-*/^=<>(),{}"!.×÷]/.test(first)) return null;
  const limit = Math.min(src.length, i + MAX_UNIT_LENGTH);
  for (let end = limit; end > i; end--) {
    const text = src.slice(i, end);
    if (text.endsWith(" ")) continue;
    const last = text[text.length - 1] as string;
    if (IDENT_CHAR.test(last) && IDENT_CHAR.test(src[end] ?? "")) continue;
    if (readUnitSpelling(text)) return { code: text, end };
  }
  const word = /^[A-Za-z_°Δ$%][^\s+\-*/^=<>(),{}"]*/.exec(src.slice(i))?.[0];
  if (word && !KEYWORDS.has(word)) {
    throw new ParseError(`"${word}" is not a unit this library knows`, span(i, i + word.length), "unknown_unit");
  }
  return null;
}

export function parseFormula(src: string): ParseResult {
  if (src.length > MAX_SOURCE) {
    return { ok: false, error: { code: "too_complex", message: `A formula is at most ${MAX_SOURCE} characters`, span: span(MAX_SOURCE, src.length) } };
  }
  try {
    const p = new Parser(lex(src));
    const node = p.parseExpression(0);
    const next = p.peek();
    if (next.t !== "end") {
      throw new ParseError(next.t === "op" && next.op === ")" ? "A ) has no opening (" : "Expected an operator or the end of the formula here", next.span);
    }
    return { ok: true, node, nodeCount: p.nextId };
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: { code: err.code, message: err.message, span: err.span } };
    throw err;
  }
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  or: 1,
  and: 2,
  "=": 4,
  "<>": 4,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "^": 8,
};
const NOT_PRECEDENCE = 3;
const NEG_PRECEDENCE = 7;

const isBinaryOp = (op: string): op is BinaryOp => Object.prototype.hasOwnProperty.call(BINARY_PRECEDENCE, op);

export function precedenceOf(op: BinaryOp): number {
  return BINARY_PRECEDENCE[op] ?? 0;
}

class Parser {
  private pos = 0;
  private depth = 0;
  nextId = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private take(): Token {
    const t = this.tokens[this.pos] as Token;
    if (t.t !== "end") this.pos++;
    return t;
  }

  private binaryOpOf(t: Token): BinaryOp | null {
    if (t.t === "op" && isBinaryOp(t.op)) return t.op;
    if (t.t === "ident" && (t.name === "and" || t.name === "or")) return t.name;
    return null;
  }

  parseExpression(minPrec: number): Node {
    if (++this.depth > MAX_DEPTH) throw new ParseError("This formula nests too deeply; split it into named calculations", this.peek().span, "too_complex");
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op = this.binaryOpOf(t);
      if (!op) break;
      const prec = BINARY_PRECEDENCE[op] as number;
      if (prec < minPrec) break;
      this.take();
      const right = this.parseExpression(op === "^" ? prec : prec + 1);
      left = { k: "binary", id: this.nextId++, span: span(left.span.start, right.span.end), opSpan: t.span, op, left, right };
      if (prec === 4) {
        const after = this.binaryOpOf(this.peek());
        if (after && BINARY_PRECEDENCE[after] === 4) throw new ParseError("Comparisons can't be chained; join them with and", this.peek().span);
      }
    }
    this.depth--;
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.t === "op" && t.op === "-") {
      this.take();
      const arg = this.parseExpression(NEG_PRECEDENCE);
      return { k: "unary", id: this.nextId++, span: span(t.span.start, arg.span.end), op: "-", arg };
    }
    if (t.t === "op" && t.op === "+") {
      this.take();
      return this.parseExpression(NEG_PRECEDENCE);
    }
    if (t.t === "ident" && t.name === "not") {
      this.take();
      const arg = this.parseExpression(NOT_PRECEDENCE);
      return { k: "unary", id: this.nextId++, span: span(t.span.start, arg.span.end), op: "not", arg };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.take();
    switch (t.t) {
      case "num":
        return { k: "num", id: this.nextId++, span: t.span, value: t.value, unit: t.unit };
      case "str":
        return { k: "str", id: this.nextId++, span: t.span, value: t.value };
      case "field":
        return { k: "field", id: this.nextId++, span: t.span, path: t.path };
      case "ident": {
        if (t.name === "true" || t.name === "false") return { k: "bool", id: this.nextId++, span: t.span, value: t.name === "true" };
        if (KEYWORDS.has(t.name)) throw new ParseError(`Expected a value before "${t.name}"`, t.span);
        const next = this.peek();
        if (next.t === "op" && next.op === "(") {
          this.take();
          const args: Node[] = [];
          const first = this.peek();
          if (!(first.t === "op" && first.op === ")")) {
            for (;;) {
              args.push(this.parseExpression(0));
              const sep = this.peek();
              if (sep.t === "op" && sep.op === ",") {
                this.take();
                continue;
              }
              break;
            }
          }
          const close = this.take();
          if (!(close.t === "op" && close.op === ")")) throw new ParseError(`${t.name}( has no closing )`, close.t === "end" ? next.span : close.span);
          return { k: "call", id: this.nextId++, span: span(t.span.start, close.span.end), nameSpan: t.span, name: t.name, args };
        }
        return { k: "ident", id: this.nextId++, span: t.span, name: t.name };
      }
      case "op": {
        if (t.op === "(") {
          const inner = this.parseExpression(0);
          const close = this.take();
          if (!(close.t === "op" && close.op === ")")) throw new ParseError("A ( has no closing )", t.span);
          return inner;
        }
        throw new ParseError(`Expected a value before "${t.op}"`, t.span);
      }
      case "end":
        throw new ParseError("The formula ends before a value", t.span);
    }
  }
}
