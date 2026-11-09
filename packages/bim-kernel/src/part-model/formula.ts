/**
 * Part formulas: a small, closed arithmetic language for parameter values and
 * dimensions. Numbers are model millimetres unless they carry `mm`, `in` or
 * `ft`; angles are degrees. Yes/no values read as 1 and 0.
 *
 *   width / 2 + 2in        if(height > 36in, 4in, 2in)        max(cfm / 400, 1)
 *
 * Evaluation is pure and deterministic (fixed operator set, no host access).
 *
 * Not yet on `@permitzip/bim-formula`: that language is unit-typed with
 * `{field}` references and has no degree trigonometry, so part formulas
 * (bare millimetre numbers, `sin`/`cos`/`tan` in degrees, `==`) can't move
 * without changing a result. Length literals already read through bim-units.
 */
import { convert } from "@permitzip/bim-units";

export type FormulaNode =
  | { readonly kind: "num"; readonly value: number }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "unary"; readonly op: "-" | "not"; readonly arg: FormulaNode }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: FormulaNode; readonly right: FormulaNode }
  | { readonly kind: "call"; readonly fn: FormulaFn; readonly args: readonly FormulaNode[] };

type BinaryOp = "+" | "-" | "*" | "/" | "^" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "and" | "or";

const FUNCTIONS = {
  if: 3,
  min: -1,
  max: -1,
  abs: 1,
  sqrt: 1,
  round: 1,
  floor: 1,
  ceil: 1,
  sin: 1,
  cos: 1,
  tan: 1,
} as const;
type FormulaFn = keyof typeof FUNCTIONS;

/** Length literals in model millimetres, from the unit library (exactly 1, 25.4 and 304.8). */
const UNIT_MM: Readonly<Record<string, number>> = { mm: convert(1, "mm", "mm"), in: convert(1, "in", "mm"), ft: convert(1, "ft", "mm") };

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

type Token =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "op"; readonly v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`"${src.slice(i, i + 8)}" is not a number`);
      i += m[0].length;
      let v = Number(m[0]);
      const unit = /^\s*(mm|in|ft)\b/.exec(src.slice(i));
      if (unit) {
        v *= UNIT_MM[unit[1] ?? "mm"] ?? 1;
        i += unit[0].length;
      }
      out.push({ t: "num", v });
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
      const word = m?.[0] ?? c;
      i += word.length;
      out.push(word === "and" || word === "or" || word === "not" ? { t: "op", v: word } : { t: "name", v: word });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "==" || two === "!=") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^()<>=,".includes(c)) {
      out.push({ t: "op", v: c === "=" ? "==" : c });
      i++;
      continue;
    }
    throw new FormulaError(`"${c}" can't be used in a formula`);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): FormulaNode {
    if (this.tokens.length === 0) throw new FormulaError("The formula is empty");
    const node = this.or();
    if (this.i < this.tokens.length) throw new FormulaError(`Unexpected "${this.tokens[this.i]?.v}"`);
    return node;
  }

  private peek(v: string): boolean {
    const t = this.tokens[this.i];
    return t?.t === "op" && t.v === v;
  }

  private take(v: string): boolean {
    if (!this.peek(v)) return false;
    this.i++;
    return true;
  }

  private or(): FormulaNode {
    let left = this.and();
    while (this.take("or")) left = { kind: "binary", op: "or", left, right: this.and() };
    return left;
  }

  private and(): FormulaNode {
    let left = this.not();
    while (this.take("and")) left = { kind: "binary", op: "and", left, right: this.not() };
    return left;
  }

  private not(): FormulaNode {
    if (this.take("not")) return { kind: "unary", op: "not", arg: this.not() };
    return this.compare();
  }

  private compare(): FormulaNode {
    const left = this.add();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"] as const) {
      if (this.take(op)) return { kind: "binary", op, left, right: this.add() };
    }
    return left;
  }

  private add(): FormulaNode {
    let left = this.mul();
    for (;;) {
      if (this.take("+")) left = { kind: "binary", op: "+", left, right: this.mul() };
      else if (this.take("-")) left = { kind: "binary", op: "-", left, right: this.mul() };
      else return left;
    }
  }

  private mul(): FormulaNode {
    let left = this.unary();
    for (;;) {
      if (this.take("*")) left = { kind: "binary", op: "*", left, right: this.unary() };
      else if (this.take("/")) left = { kind: "binary", op: "/", left, right: this.unary() };
      else return left;
    }
  }

  private unary(): FormulaNode {
    if (this.take("-")) return { kind: "unary", op: "-", arg: this.unary() };
    if (this.take("+")) return this.unary();
    return this.pow();
  }

  private pow(): FormulaNode {
    const base = this.primary();
    if (this.take("^")) return { kind: "binary", op: "^", left: base, right: this.unary() };
    return base;
  }

  private primary(): FormulaNode {
    const t = this.tokens[this.i];
    if (!t) throw new FormulaError("The formula ends too soon");
    if (t.t === "num") {
      this.i++;
      return { kind: "num", value: t.v };
    }
    if (t.t === "name") {
      this.i++;
      if (t.v === "true") return { kind: "num", value: 1 };
      if (t.v === "false") return { kind: "num", value: 0 };
      if (this.take("(")) {
        if (!(t.v in FUNCTIONS)) throw new FormulaError(`${t.v}() is not a formula function (use ${Object.keys(FUNCTIONS).join(", ")})`);
        const fn = t.v as FormulaFn;
        const args: FormulaNode[] = [];
        if (!this.peek(")")) {
          do args.push(this.or());
          while (this.take(","));
        }
        if (!this.take(")")) throw new FormulaError(`${fn}( is missing its closing bracket`);
        const arity = FUNCTIONS[fn];
        if (arity >= 0 && args.length !== arity) throw new FormulaError(`${fn}() takes ${arity} value${arity === 1 ? "" : "s"}`);
        if (arity < 0 && args.length === 0) throw new FormulaError(`${fn}() needs at least one value`);
        return { kind: "call", fn, args };
      }
      return { kind: "name", name: t.v };
    }
    if (this.take("(")) {
      const inner = this.or();
      if (!this.take(")")) throw new FormulaError("A bracket is not closed");
      return inner;
    }
    throw new FormulaError(`Unexpected "${t.v}"`);
  }
}

const parsed = new Map<string, FormulaNode>();

/** Parse (cached). Throws FormulaError with a plain reason. */
export function parseFormula(src: string): FormulaNode {
  const hit = parsed.get(src);
  if (hit) return hit;
  const node = new Parser(tokenize(src)).parse();
  if (parsed.size > 5000) parsed.clear();
  parsed.set(src, node);
  return node;
}

/** The parameter names a formula reads. */
export function formulaNames(node: FormulaNode, out: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case "name":
      out.add(node.name);
      break;
    case "unary":
      formulaNames(node.arg, out);
      break;
    case "binary":
      formulaNames(node.left, out);
      formulaNames(node.right, out);
      break;
    case "call":
      for (const a of node.args) formulaNames(a, out);
      break;
    case "num":
      break;
  }
  return out;
}

const RAD = Math.PI / 180;

/** Evaluate with `lookup` for names. Throws FormulaError for unknown names or non-finite results. */
export function evaluateFormula(node: FormulaNode, lookup: (name: string) => number): number {
  const ev = (n: FormulaNode): number => {
    switch (n.kind) {
      case "num":
        return n.value;
      case "name":
        return lookup(n.name);
      case "unary":
        return n.op === "-" ? -ev(n.arg) : ev(n.arg) === 0 ? 1 : 0;
      case "binary": {
        if (n.op === "and") return ev(n.left) !== 0 && ev(n.right) !== 0 ? 1 : 0;
        if (n.op === "or") return ev(n.left) !== 0 || ev(n.right) !== 0 ? 1 : 0;
        const a = ev(n.left);
        const b = ev(n.right);
        switch (n.op) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            if (b === 0) throw new FormulaError("Division by zero");
            return a / b;
          case "^":
            return a ** b;
          case "<":
            return a < b ? 1 : 0;
          case "<=":
            return a <= b ? 1 : 0;
          case ">":
            return a > b ? 1 : 0;
          case ">=":
            return a >= b ? 1 : 0;
          case "==":
            return Math.abs(a - b) < 1e-9 ? 1 : 0;
          case "!=":
            return Math.abs(a - b) < 1e-9 ? 0 : 1;
        }
        return 0;
      }
      case "call": {
        if (n.fn === "if") return ev(n.args[0] ?? { kind: "num", value: 0 }) !== 0 ? ev(n.args[1] ?? { kind: "num", value: 0 }) : ev(n.args[2] ?? { kind: "num", value: 0 });
        const xs = n.args.map(ev);
        const x = xs[0] ?? 0;
        switch (n.fn) {
          case "min":
            return Math.min(...xs);
          case "max":
            return Math.max(...xs);
          case "abs":
            return Math.abs(x);
          case "sqrt":
            if (x < 0) throw new FormulaError("Square root of a negative number");
            return Math.sqrt(x);
          case "round":
            return Math.round(x);
          case "floor":
            return Math.floor(x);
          case "ceil":
            return Math.ceil(x);
          case "sin":
            return Math.sin(x * RAD);
          case "cos":
            return Math.cos(x * RAD);
          case "tan":
            return Math.tan(x * RAD);
        }
        return 0;
      }
    }
  };
  const v = ev(node);
  if (!Number.isFinite(v)) throw new FormulaError("The formula has no finite value");
  return v;
}
