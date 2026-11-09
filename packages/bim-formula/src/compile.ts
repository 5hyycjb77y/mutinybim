/**
 * Type inference and compilation in one pass. Every AST node becomes a
 * closure that evaluates a whole column at once (typed arrays in, typed
 * arrays out), so one compiled formula over 10k rows is a handful of tight
 * loops rather than 10k tree walks.
 */

import { formatQuantity, quoteText } from "./format";
import { parseFormula, type BinaryOp, type Node } from "./parse";
import type {
  CellValue,
  ColumnarInputs,
  CompileOptions,
  FormulaError,
  FormulaErrorCode,
  FormulaSchema,
  FormulaType,
  LookupTableSignature,
  SourceSpan,
  ValueColumn,
} from "./types";
import {
  AFFINE_DELTA,
  COUNT_KIND,
  NUMBER_KIND,
  NUMBER_UNIT,
  ZERO_DIMENSION,
  defaultUnitOf,
  dimensionOf,
  divideDimensions,
  isKind,
  isScalarKind,
  kindLabel,
  kindsWithDimension,
  multiplyDimensions,
  powDimension,
  readUnitSpelling,
  sameDimension,
  sumAllowed,
  toSI,
  unitAllowed,
  unitDimension,
  unitForKind,
  unitSymbol,
  type Dimension,
  type Kind,
  type UnitCode,
} from "./units";

// ---------------------------------------------------------------- static types

/**
 * A number's static type.
 * - `kind` set: the value is that kind.
 * - `kind: null, candidates` set: a literal whose unit serves several kinds
 *   ("1000 Btu/h" is heating capacity or gas input); the formula around it decides.
 * - `kind: null, candidates: null`: an intermediate product (A × V) of `dim`, not yet tied to a kind.
 */
export interface QType {
  readonly t: "q";
  readonly kind: Kind | null;
  readonly candidates: readonly Kind[] | null;
  readonly dim: Dimension;
  /** Display hint carried from the field or literal the value came from. */
  readonly unit: UnitCode | null;
  /** A number typed without a unit; it may only meet plain numbers, ratios and counts additively. */
  readonly plain: boolean;
}
export type SType = QType | { readonly t: "text" } | { readonly t: "bool" };

const TEXT: SType = { t: "text" };
const BOOL: SType = { t: "bool" };
const PLAIN: QType = { t: "q", kind: NUMBER_KIND, candidates: null, dim: ZERO_DIMENSION, unit: null, plain: true };
const NUMBER: QType = { ...PLAIN, plain: false };
const TEMPERATURE: Kind = "temperature";
const TEMPERATURE_DELTA: Kind = "temperature_delta";

function fixed(kind: Kind, unit: UnitCode | null): QType {
  return { t: "q", kind, candidates: null, dim: dimensionOf(kind), unit, plain: false };
}

/** Could this number be of `kind`? */
function canBe(q: QType, kind: Kind): boolean {
  if (q.plain) return isScalarKind(kind);
  if (q.kind !== null) return q.kind === kind || (q.kind === NUMBER_KIND && isScalarKind(kind));
  if (q.candidates) return q.candidates.includes(kind);
  return sameDimension(q.dim, dimensionOf(kind));
}

const isScalar = (q: QType): boolean => q.plain || (q.kind !== null ? isScalarKind(q.kind) : q.candidates !== null && q.candidates.every(isScalarKind));
const isAffine = (q: QType): boolean => q.kind !== null && AFFINE_DELTA.has(q.kind);

export function describeType(t: SType): string {
  if (t.t === "text") return "text";
  if (t.t === "bool") return "a yes/no value";
  if (t.plain) return "a plain number";
  if (t.kind === null) {
    if (t.candidates) return t.candidates.map((k) => withArticle(kindLabel(k))).join(" or ");
    return "a combined unit";
  }
  const unit = displayUnit(t);
  const symbol = unit ? unitSymbol(unit) : "";
  return symbol ? `${withArticle(kindLabel(t.kind))} (${symbol})` : withArticle(kindLabel(t.kind));
}

function withArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

export function fromFormulaType(ft: FormulaType): SType | string {
  if (ft.type === "text") return TEXT;
  if (ft.type === "boolean") return BOOL;
  if (!isKind(ft.kind)) return `the unit library has no quantity kind "${ft.kind}"`;
  if (!unitAllowed(ft.kind, ft.unit)) return `"${ft.unit}" is not a unit of ${kindLabel(ft.kind)}`;
  return fixed(ft.kind, ft.unit);
}

export function toFormulaType(t: SType, kind: Kind): FormulaType {
  if (t.t === "text") return { type: "text" };
  if (t.t === "bool") return { type: "boolean" };
  const unit = t.unit !== null && unitAllowed(kind, t.unit) ? t.unit : defaultUnitOf(kind);
  return { type: "quantity", kind, unit };
}

// ---------------------------------------------------------------- runtime columns

export type Col = Float64Array | Int8Array | (string | null)[];

export interface Ctx {
  readonly n: number;
  readonly inputs: ColumnarInputs;
  readonly params: readonly Col[];
  readonly trace: Map<CNode, Col> | null;
}

export type Agg = "sum" | "avg" | "min" | "max" | "count" | "list";

/** A compiled node: its static type, its column closure, and what explain needs to print it. */
export interface CNode {
  readonly node: Node;
  readonly type: SType;
  readonly run: (ctx: Ctx) => Col;
  readonly children: readonly CNode[];
  /** Source text of a literal, printed as written. */
  readonly literal?: string;
  /** Present on literals whose unit serves several kinds: the same literal tied to one kind (°F as degF or delta_degF). */
  readonly rebind?: (kind: Kind) => CNode | null;
  readonly display:
    | { readonly as: "leaf" }
    | { readonly as: "binary"; readonly op: BinaryOp }
    | { readonly as: "unary"; readonly op: "-" | "not" }
    | { readonly as: "call"; readonly name: string }
    | { readonly as: "aggregate"; readonly fn: Agg; readonly relationship: string; readonly offsets: (ctx: Ctx) => Int32Array }
    | { readonly as: "lookup"; readonly table: string };
}

/** The shape of rows a formula reads: field types at this level and per relationship. */
export interface Plan {
  readonly fields: Map<string, FormulaType>;
  readonly relations: Map<string, Plan>;
}

const newPlan = (): Plan => ({ fields: new Map(), relations: new Map() });

const MAX_CALCULATION_CALLS = 256;

class Session {
  readonly errors: FormulaError[] = [];
  calculationCalls = 0;
  readonly tables = new Set<string>();
  readonly calculations = new Set<string>();
  error(code: FormulaErrorCode, message: string, span: SourceSpan): null {
    this.errors.push({ code, message, span });
    return null;
  }
}

interface Scope {
  readonly schema: FormulaSchema;
  readonly params: ReadonlyMap<string, { readonly index: number; readonly type: SType }>;
  readonly calcStack: readonly string[];
  readonly plan: Plan;
  readonly session: Session;
  /** Set while compiling a named calculation's body: errors are reported at the call. */
  readonly callSite: { readonly id: string; readonly span: SourceSpan } | null;
}

function report(scope: Scope, code: FormulaErrorCode, message: string, span: SourceSpan): null {
  if (scope.callSite) return scope.session.error(code, `In ${scope.callSite.id}: ${message}`, scope.callSite.span);
  return scope.session.error(code, message, span);
}

function traced(cnode: Omit<CNode, "run">, impl: (ctx: Ctx) => Col): CNode {
  const out: CNode = {
    ...cnode,
    run: (ctx) => {
      const col = impl(ctx);
      if (ctx.trace) ctx.trace.set(out, col);
      return col;
    },
  };
  return out;
}

// ---------------------------------------------------------------- entry point

export interface Compiled {
  readonly root: CNode;
  readonly type: FormulaType;
  readonly kind: Kind | null;
  readonly plan: Plan;
  readonly tables: readonly string[];
  readonly calculations: readonly string[];
}

export function compileSource(source: string, schema: FormulaSchema, options: CompileOptions = {}): { ok: true; compiled: Compiled } | { ok: false; errors: FormulaError[] } {
  const parsed = parseFormula(source);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const session = new Session();
  const scope: Scope = { schema, params: new Map(), calcStack: [], plan: newPlan(), session, callSite: null };
  const root = compileNode(parsed.node, scope, source);
  if (!root || session.errors.length > 0) return { ok: false, errors: session.errors.length ? session.errors : [{ code: "syntax", message: "This formula could not be read", span: parsed.node.span }] };

  let expect: SType | null = null;
  if (options.expect) {
    const e = fromFormulaType(options.expect);
    if (typeof e === "string") return { ok: false, errors: [{ code: "unknown_unit", message: `The expected result is not valid: ${e}`, span: parsed.node.span }] };
    expect = e;
  }
  const resolved = resolveResult(root.type, expect, parsed.node.span, session);
  if (!resolved) return { ok: false, errors: session.errors };
  const kind = resolved.t === "q" ? resolved.kind : null;
  const type = toFormulaType(resolved, kind ?? NUMBER_KIND);
  return {
    ok: true,
    compiled: { root: bind(root, kind), type, kind, plan: scope.plan, tables: [...session.tables].sort(), calculations: [...session.calculations].sort() },
  };
}

/** Tie the result to one kind and check it against the declared result type. */
function resolveResult(t: SType, expect: SType | null, span: SourceSpan, session: Session): SType | null {
  if (expect) {
    if (expect.t !== "q" || t.t !== "q") {
      if (expect.t === t.t) return expect;
      return session.error("type_mismatch", `This works out to ${describeType(t)}, but the result should be ${describeType(expect)}`, span);
    }
    if (fits(t, expect)) return expect;
    return session.error("unit_mismatch", `This works out to ${describeType(t)}, but the result should be ${describeType(expect)}`, span);
  }
  if (t.t !== "q") return t;
  if (t.plain) return NUMBER;
  if (t.kind !== null) return t;
  const candidates = t.candidates ?? kindsWithDimension(t.dim);
  if (candidates.length === 1) {
    const kind = candidates[0] as Kind;
    return fixed(kind, t.unit !== null && unitAllowed(kind, t.unit) ? t.unit : defaultUnitOf(kind));
  }
  if (candidates.length === 0) return session.error("no_kind", "This combination of units doesn't measure anything the unit library knows; check the multiplications and divisions", span);
  return session.error("no_kind", `This could be ${candidates.map((k) => withArticle(kindLabel(k))).join(" or ")}: set the result unit`, span);
}

/** Can a value of type `got` be used where `want` (always a fixed kind) is expected: argument, key, result? */
function fits(got: QType, want: QType): boolean {
  return want.kind !== null && canBe(got, want.kind);
}

/** Tie an ambiguous literal to the kind its surroundings chose, so "70 °F" converts as a temperature, "5 °F" as a difference. */
function bind(c: CNode, kind: Kind | null): CNode {
  if (kind === null || !c.rebind || c.type.t !== "q" || c.type.kind === kind) return c;
  return c.rebind(kind) ?? c;
}

// ---------------------------------------------------------------- nodes

function compileNode(node: Node, scope: Scope, src: string): CNode | null {
  switch (node.k) {
    case "num":
      return compileNumber(node, scope, src);
    case "str": {
      const value = node.value;
      return traced({ node, type: TEXT, children: [], literal: src.slice(node.span.start, node.span.end), display: { as: "leaf" } }, (ctx) => new Array<string | null>(ctx.n).fill(value));
    }
    case "bool": {
      const v = node.value ? 1 : 0;
      return traced({ node, type: BOOL, children: [], literal: src.slice(node.span.start, node.span.end), display: { as: "leaf" } }, (ctx) => new Int8Array(ctx.n).fill(v));
    }
    case "field":
      return compileField(node, scope);
    case "ident": {
      const param = scope.params.get(node.name);
      if (param) {
        const index = param.index;
        return traced({ node, type: param.type, children: [], display: { as: "leaf" } }, (ctx) => ctx.params[index] as Col);
      }
      return report(scope, "unknown_name", `"${node.name}" is not a value here. Fields go in braces, like {${node.name}}`, node.span);
    }
    case "unary":
      return compileUnary(node, scope, src);
    case "binary":
      return compileBinary(node, scope, src);
    case "call":
      return compileCall(node, scope, src);
  }
}

function compileNumber(node: Extract<Node, { k: "num" }>, scope: Scope, src: string): CNode | null {
  const literal = src.slice(node.span.start, node.span.end);
  if (node.unit === null) {
    const v = node.value;
    return traced({ node, type: PLAIN, children: [], literal, display: { as: "leaf" } }, (ctx) => new Float64Array(ctx.n).fill(v));
  }
  const spelling = node.unit;
  const meaning = readUnitSpelling(spelling);
  const firstUnit = meaning?.units[0];
  if (!meaning || firstUnit === undefined || meaning.kinds.length === 0) return report(scope, "unknown_unit", `"${spelling}" is not a unit this library knows`, node.span);
  const value = node.value;
  const make = (type: QType, unit: UnitCode, rebind?: (kind: Kind) => CNode | null): CNode => {
    const si = toSI(value, unit);
    return traced({ node, type, children: [], literal, display: { as: "leaf" }, ...(rebind ? { rebind } : {}) }, (ctx) => new Float64Array(ctx.n).fill(si));
  };
  const forKind = (kind: Kind): CNode | null => {
    const unit = unitForKind(spelling, kind);
    return unit ? make(fixed(kind, unit), unit) : null;
  };
  if (meaning.kinds.length === 1) return forKind(meaning.kinds[0] as Kind);
  return make({ t: "q", kind: null, candidates: meaning.kinds, dim: unitDimension(firstUnit), unit: firstUnit, plain: false }, firstUnit, forKind);
}

function compileField(node: Extract<Node, { k: "field" }>, scope: Scope): CNode | null {
  const param = scope.params.get(node.path);
  if (param) {
    const index = param.index;
    return traced({ node, type: param.type, children: [], display: { as: "leaf" } }, (ctx) => ctx.params[index] as Col);
  }
  const sig = scope.schema.field(node.path);
  if (!sig) return report(scope, "unknown_field", `There is no field called "${node.path}" here`, node.span);
  const type = fromFormulaType(sig.type);
  if (typeof type === "string") return report(scope, "unknown_unit", `The field "${node.path}" is set up wrong: ${type}`, node.span);
  scope.plan.fields.set(node.path, sig.type);
  const path = node.path;
  const want = sig.type;
  return traced({ node, type, children: [], display: { as: "leaf" } }, (ctx) => readColumn(ctx.inputs, path, want, ctx.n));
}

function readColumn(inputs: ColumnarInputs, path: string, want: FormulaType, n: number): Col {
  const col = inputs.fields.get(path);
  if (!col) throw new Error(`Formula inputs have no column for {${path}}`);
  if (col.values.length !== n) throw new Error(`Formula input {${path}} has ${col.values.length} values for ${n} rows`);
  if (want.type === "quantity") {
    if (col.type !== "quantity" || col.kind !== want.kind) throw new Error(`Formula input {${path}} should hold ${want.kind} quantities, got ${col.type === "quantity" ? col.kind : col.type}`);
  } else if (col.type !== want.type) {
    throw new Error(`Formula input {${path}} should hold ${want.type}, got ${col.type}`);
  }
  return col.values as Col;
}

function compileUnary(node: Extract<Node, { k: "unary" }>, scope: Scope, src: string): CNode | null {
  const arg = compileNode(node.arg, scope, src);
  if (!arg) return null;
  if (node.op === "not") {
    if (arg.type.t !== "bool") return report(scope, "type_mismatch", `"not" needs a yes/no value, not ${describeType(arg.type)}`, node.span);
    return traced({ node, type: BOOL, children: [arg], display: { as: "unary", op: "not" } }, (ctx) => {
      const a = arg.run(ctx) as Int8Array;
      const out = new Int8Array(ctx.n);
      for (let i = 0; i < ctx.n; i++) {
        const v = a[i] as number;
        out[i] = v < 0 ? -1 : 1 - v;
      }
      return out;
    });
  }
  if (arg.type.t !== "q") return report(scope, "type_mismatch", `Only numbers can be negated, not ${describeType(arg.type)}`, node.span);
  if (isAffine(arg.type)) return report(scope, "unit_mismatch", `Negate a temperature difference, not ${describeType(arg.type)}`, node.span);
  return negate(node, arg);
}

function negate(node: Node, arg: CNode): CNode {
  const rebind = arg.rebind;
  const out = traced({ node, type: arg.type, children: [arg], display: { as: "unary", op: "-" }, ...(rebind ? { rebind: (kind: Kind) => {
    const a = rebind(kind);
    return a ? negate(node, a) : null;
  } } : {}) }, (ctx) => {
    const a = arg.run(ctx) as Float64Array;
    const o = new Float64Array(ctx.n);
    for (let i = 0; i < ctx.n; i++) o[i] = -(a[i] as number);
    return o;
  });
  return out;
}

// ---------------------------------------------------------------- operators

type UnifyFail = "unitless_left" | "unitless_right" | "mismatch" | "affine";
type Unify = { readonly ok: true; readonly type: QType; readonly left: Kind | null; readonly right: Kind | null } | { readonly ok: false; readonly reason: UnifyFail };

/** The kinds a number may still be; `null` means any kind of its dimension (an intermediate product). */
function possibleKinds(q: QType): readonly Kind[] | null {
  if (q.kind !== null) return [q.kind];
  return q.candidates;
}

function typeFromKinds(kinds: readonly Kind[], dim: Dimension, unit: UnitCode | null): QType {
  if (kinds.length === 1) {
    const kind = kinds[0] as Kind;
    return fixed(kind, unit !== null && unitAllowed(kind, unit) ? unit : defaultUnitOf(kind));
  }
  return { t: "q", kind: null, candidates: kinds, dim, unit, plain: false };
}

/** Temperature arithmetic, in order of preference: (left kind, right kind, result kind). */
const AFFINE_RULES: Readonly<Record<"+" | "-", readonly (readonly [Kind, Kind, Kind])[]>> = {
  "+": [
    [TEMPERATURE, TEMPERATURE_DELTA, TEMPERATURE],
    [TEMPERATURE_DELTA, TEMPERATURE_DELTA, TEMPERATURE_DELTA],
    [TEMPERATURE_DELTA, TEMPERATURE, TEMPERATURE],
  ],
  "-": [
    [TEMPERATURE, TEMPERATURE_DELTA, TEMPERATURE],
    [TEMPERATURE, TEMPERATURE, TEMPERATURE_DELTA],
    [TEMPERATURE_DELTA, TEMPERATURE_DELTA, TEMPERATURE_DELTA],
  ],
};

/**
 * Additive compatibility: `+ -` (with temperature rules), and "same" for
 * comparisons and the branches of if/coalesce/min/max. Returns the result
 * type and the kind each side was read as, so ambiguous literals can be bound.
 */
function unify(a: QType, b: QType, op: "+" | "-" | "same"): Unify {
  if (a.plain && b.plain) return { ok: true, type: PLAIN, left: null, right: null };
  if (a.plain || b.plain) {
    const other = a.plain ? b : a;
    const scalars = (possibleKinds(other) ?? kindsWithDimension(other.dim)).filter(isScalarKind);
    if (scalars.length === 0) return { ok: false, reason: a.plain ? "unitless_left" : "unitless_right" };
    const type = typeFromKinds(scalars, other.dim, other.unit);
    return { ok: true, type, left: a.plain ? null : type.kind, right: b.plain ? null : type.kind };
  }
  if (op !== "same") {
    const touchesTemperature = [TEMPERATURE, TEMPERATURE_DELTA].some((k) => canBe(a, k) || canBe(b, k));
    if (touchesTemperature) {
      const rule = AFFINE_RULES[op].find(([ka, kb]) => canBe(a, ka) && canBe(b, kb));
      if (rule) {
        const [ka, kb, result] = rule;
        const source = a.unit ?? b.unit;
        const unit = result === ka ? a.unit : result === kb ? b.unit : source !== null ? unitForKind(unitSymbol(source), result) : null;
        return { ok: true, type: fixed(result, unit !== null && unitAllowed(result, unit) ? unit : defaultUnitOf(result)), left: ka, right: kb };
      }
      return { ok: false, reason: op === "+" && canBe(a, TEMPERATURE) && canBe(b, TEMPERATURE) ? "affine" : "mismatch" };
    }
  }
  const ka = possibleKinds(a);
  const kb = possibleKinds(b);
  let kinds: readonly Kind[] | null;
  if (ka === null && kb === null) {
    if (!sameDimension(a.dim, b.dim)) return { ok: false, reason: "mismatch" };
    kinds = null;
  } else if (ka === null) kinds = (kb as readonly Kind[]).filter((k) => canBe(a, k));
  else if (kb === null) kinds = ka.filter((k) => canBe(b, k));
  else kinds = [...new Set([...ka, ...kb])].filter((k) => canBe(a, k) && canBe(b, k));
  if (kinds === null) return { ok: true, type: a, left: null, right: null };
  if (kinds.length === 0) return { ok: false, reason: "mismatch" };
  const type = typeFromKinds(kinds, a.dim, a.unit ?? b.unit);
  return { ok: true, type, left: type.kind, right: type.kind };
}

function unifyAny(a: SType, b: SType): SType | null {
  if (a.t === "q" && b.t === "q") {
    const u = unify(a, b, "same");
    return u.ok ? u.type : null;
  }
  return a.t === b.t ? a : null;
}

/** The single kind a unified type settled on, for binding literals inside it. */
function kindOf(t: SType): Kind | null {
  return t.t === "q" ? t.kind : null;
}

const VERB: Readonly<Record<"+" | "-", string>> = { "+": "add", "-": "subtract" };

function compileBinary(node: Extract<Node, { k: "binary" }>, scope: Scope, src: string): CNode | null {
  let left = compileNode(node.left, scope, src);
  let right = compileNode(node.right, scope, src);
  if (!left || !right) return null;
  const op = node.op;
  const lt = left.type;
  const rt = right.type;
  const base = () => ({ node, children: [left as CNode, right as CNode], display: { as: "binary" as const, op } });

  if (op === "and" || op === "or") {
    if (lt.t !== "bool" || rt.t !== "bool") return report(scope, "type_mismatch", `"${op}" joins yes/no values; got ${describeType(lt.t !== "bool" ? lt : rt)}`, node.opSpan);
    const l = left;
    const r = right;
    return traced({ ...base(), type: BOOL }, (ctx) => logic(op, l.run(ctx) as Int8Array, r.run(ctx) as Int8Array, ctx.n));
  }

  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    if (lt.t === "q" && rt.t === "q") {
      const u = unify(lt, rt, "same");
      if (!u.ok) return report(scope, u.reason === "mismatch" ? "unit_mismatch" : "unitless_number", compareMessage(lt, rt, u.reason), u.reason === "unitless_left" ? node.left.span : u.reason === "unitless_right" ? node.right.span : node.opSpan);
      const l = bind(left, u.left);
      const r = bind(right, u.right);
      left = l;
      right = r;
      return traced({ ...base(), type: BOOL }, (ctx) => compareNum(op, l.run(ctx) as Float64Array, r.run(ctx) as Float64Array, ctx.n));
    }
    if (lt.t !== rt.t) return report(scope, "type_mismatch", `Can't compare ${describeType(lt)} with ${describeType(rt)}`, node.opSpan);
    if (op !== "=" && op !== "<>") return report(scope, "type_mismatch", `${lt.t === "text" ? "Text" : "Yes/no values"} can only be compared with = or <>`, node.opSpan);
    const l = left;
    const r = right;
    if (lt.t === "text") return traced({ ...base(), type: BOOL }, (ctx) => compareText(op, l.run(ctx) as (string | null)[], r.run(ctx) as (string | null)[], ctx.n));
    return traced({ ...base(), type: BOOL }, (ctx) => compareNum(op, toNum(l.run(ctx) as Int8Array), toNum(r.run(ctx) as Int8Array), ctx.n));
  }

  if (lt.t !== "q" || rt.t !== "q") return report(scope, "type_mismatch", `"${op}" works on numbers, not ${describeType(lt.t !== "q" ? lt : rt)}`, node.opSpan);

  let type: QType;
  if (op === "+" || op === "-") {
    const u = unify(lt, rt, op);
    if (!u.ok) {
      if (u.reason === "unitless_left" || u.reason === "unitless_right") {
        const other = u.reason === "unitless_left" ? rt : lt;
        const numberSpan = u.reason === "unitless_left" ? node.left.span : node.right.span;
        const example = other.unit ? ` like ${src.slice(numberSpan.start, numberSpan.end)} ${unitSymbol(other.unit)}` : "";
        return report(scope, "unitless_number", `Give ${src.slice(numberSpan.start, numberSpan.end)} a unit: it is ${op === "+" ? "added to" : "subtracted from"} ${describeType(other)}${example ? `,${example}` : ""}`, numberSpan);
      }
      if (u.reason === "affine") return report(scope, "unit_mismatch", `Can't add two temperatures; subtract them to get a difference`, node.opSpan);
      return report(scope, "unit_mismatch", `Can't ${VERB[op]} ${describeType(rt)} ${op === "+" ? "to" : "from"} ${describeType(lt)}: they measure different things`, node.opSpan);
    }
    type = u.type;
    left = bind(left, u.left);
    right = bind(right, u.right);
  } else if (op === "*" || op === "/") {
    if (isAffine(lt) || isAffine(rt)) return report(scope, "unit_mismatch", `Multiply or divide a temperature difference, not ${describeType(isAffine(lt) ? lt : rt)}`, node.opSpan);
    left = preferDelta(left);
    right = preferDelta(right);
    type = op === "*" ? multiplyType(left.type as QType, right.type as QType) : divideType(left.type as QType, right.type as QType);
  } else {
    const exp = constantNumber(node.right);
    if (isScalar(lt)) {
      if (!isScalar(rt)) return report(scope, "unit_mismatch", `A power must be a plain number, not ${describeType(rt)}`, node.right.span);
      type = { ...NUMBER, plain: lt.plain && rt.plain };
    } else {
      if (exp === null || !Number.isInteger(exp)) return report(scope, "unit_mismatch", `Raise ${describeType(lt)} only to a whole-number power written in the formula, like ^2; use sqrt() for square roots`, node.right.span);
      if (isAffine(lt)) return report(scope, "unit_mismatch", `Can't raise ${describeType(lt)} to a power`, node.opSpan);
      type = derived(powDimension(lt.dim, exp));
    }
  }
  const l = left;
  const r = right;
  return traced({ ...base(), type }, (ctx) => arithmetic(op, l.run(ctx) as Float64Array, r.run(ctx) as Float64Array, ctx.n));
}

function compareMessage(a: QType, b: QType, reason: "unitless_left" | "unitless_right" | "mismatch" | "affine"): string {
  if (reason === "unitless_left" || reason === "unitless_right") {
    const other = reason === "unitless_left" ? b : a;
    return `Give the number a unit: it is compared with ${describeType(other)}`;
  }
  return `Can't compare ${describeType(a)} with ${describeType(b)}: they measure different things`;
}

/** "5 °F" multiplied or divided reads as a temperature difference, never an absolute temperature. */
function preferDelta(c: CNode): CNode {
  if (c.type.t === "q" && c.type.kind === null && c.type.candidates?.includes(TEMPERATURE)) {
    const rest = c.type.candidates.filter((k) => k !== TEMPERATURE);
    if (rest.length === 1) return bind(c, rest[0] as Kind);
  }
  return c;
}

function derived(dim: Dimension): QType {
  if (sameDimension(dim, ZERO_DIMENSION)) return NUMBER;
  return { t: "q", kind: null, candidates: null, dim, unit: null, plain: false };
}

function multiplyType(a: QType, b: QType): QType {
  if (isScalar(a) && isScalar(b)) return { ...NUMBER, plain: a.plain && b.plain };
  if (isScalar(a)) return { ...b, plain: false };
  if (isScalar(b)) return { ...a, plain: false };
  return derived(multiplyDimensions(a.dim, b.dim));
}

function divideType(a: QType, b: QType): QType {
  if (isScalar(b)) return isScalar(a) ? { ...NUMBER, plain: a.plain && b.plain } : { ...a, plain: false };
  if (a.kind !== null && a.kind === b.kind) return NUMBER;
  return derived(divideDimensions(a.dim, b.dim));
}

function constantNumber(node: Node): number | null {
  if (node.k === "num" && node.unit === null) return node.value;
  if (node.k === "unary" && node.op === "-") {
    const v = constantNumber(node.arg);
    return v === null ? null : -v;
  }
  return null;
}

function arithmetic(op: "+" | "-" | "*" | "/" | "^", a: Float64Array, b: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  switch (op) {
    case "+":
      for (let i = 0; i < n; i++) out[i] = (a[i] as number) + (b[i] as number);
      return out;
    case "-":
      for (let i = 0; i < n; i++) out[i] = (a[i] as number) - (b[i] as number);
      return out;
    case "*":
      for (let i = 0; i < n; i++) out[i] = (a[i] as number) * (b[i] as number);
      return out;
    case "/":
      for (let i = 0; i < n; i++) {
        const v = (a[i] as number) / (b[i] as number);
        out[i] = Number.isFinite(v) ? v : NaN;
      }
      return out;
    case "^":
      for (let i = 0; i < n; i++) {
        const v = Math.pow(a[i] as number, b[i] as number);
        out[i] = Number.isFinite(v) ? v : NaN;
      }
      return out;
  }
}

/** Result per operator for x below, equal to, and above y (equal within 1e-12 relative). */
const COMPARE_TABLE: Readonly<Record<"=" | "<>" | "<" | "<=" | ">" | ">=", Int8Array>> = {
  "=": Int8Array.of(0, 1, 0),
  "<>": Int8Array.of(1, 0, 1),
  "<": Int8Array.of(1, 0, 0),
  "<=": Int8Array.of(1, 1, 0),
  ">": Int8Array.of(0, 0, 1),
  ">=": Int8Array.of(0, 1, 1),
};

function compareNum(op: "=" | "<>" | "<" | "<=" | ">" | ">=", a: Float64Array, b: Float64Array, n: number): Int8Array {
  const out = new Int8Array(n);
  const table = COMPARE_TABLE[op];
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== x || y !== y) {
      out[i] = -1;
      continue;
    }
    const d = x - y;
    const tolerance = 1e-12 * (x < 0 ? -x : x) + 1e-12 * (y < 0 ? -y : y);
    out[i] = table[d > tolerance ? 2 : d < -tolerance ? 0 : 1] as number;
  }
  return out;
}

function compareText(op: "=" | "<>", a: (string | null)[], b: (string | null)[], n: number): Int8Array {
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    out[i] = x === null || y === null ? -1 : (x === y) === (op === "=") ? 1 : 0;
  }
  return out;
}

function toNum(a: Int8Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i] as number;
    out[i] = v < 0 ? NaN : v;
  }
  return out;
}

/** Three-valued: `false and empty` is false, `true or empty` is true, anything else with empty is empty. */
function logic(op: "and" | "or", a: Int8Array, b: Int8Array, n: number): Int8Array {
  const out = new Int8Array(n);
  if (op === "and") {
    for (let i = 0; i < n; i++) {
      const x = a[i] as number;
      const y = b[i] as number;
      out[i] = x === 0 || y === 0 ? 0 : x < 0 || y < 0 ? -1 : 1;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = a[i] as number;
      const y = b[i] as number;
      out[i] = x === 1 || y === 1 ? 1 : x < 0 || y < 0 ? -1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- functions

const AGGREGATES: ReadonlySet<string> = new Set(["sum", "avg", "count", "list"]);
const BUILTINS: ReadonlySet<string> = new Set(["if", "round", "ceil", "floor", "min", "max", "abs", "sqrt", "coalesce", "lookup", "sum", "avg", "count", "list"]);

function arity(scope: Scope, node: Extract<Node, { k: "call" }>, min: number, max: number, usage: string): boolean {
  if (node.args.length >= min && node.args.length <= max) return true;
  report(scope, "arity", `${node.name}() is written ${usage}`, node.span);
  return false;
}

function compileCall(node: Extract<Node, { k: "call" }>, scope: Scope, src: string): CNode | null {
  const name = node.name;
  const first = node.args[0];
  const relationshipFirst = first !== undefined && first.k === "ident" && !scope.params.has(first.name) && scope.schema.relationship(first.name) !== undefined;
  if (AGGREGATES.has(name) || ((name === "min" || name === "max") && node.args.length === 2 && relationshipFirst)) {
    return compileAggregate(node, scope, src);
  }
  if (name === "lookup") return compileLookup(node, scope, src);
  if (!BUILTINS.has(name)) return compileCalculation(node, scope, src);

  const args: CNode[] = [];
  for (const a of node.args) {
    const c = compileNode(a, scope, src);
    if (c) args.push(c);
  }
  if (args.length !== node.args.length) return null;
  const base = { node, children: args, display: { as: "call" as const, name } };

  switch (name) {
    case "if": {
      if (!arity(scope, node, 3, 3, "if(condition, value if yes, value if no)")) return null;
      const [cond, yes, no] = args as [CNode, CNode, CNode];
      if (cond.type.t !== "bool") return report(scope, "type_mismatch", `The first part of if() must be yes or no, like {load_class} = "Motor"; got ${describeType(cond.type)}`, (node.args[0] as Node).span);
      const type = unifyAny(yes.type, no.type);
      if (!type) return report(scope, "type_mismatch", `Both answers of if() must be the same kind of value: ${describeType(yes.type)} vs ${describeType(no.type)}`, (node.args[2] as Node).span);
      const y = (args[1] = bind(yes, kindOf(type)));
      const f = (args[2] = bind(no, kindOf(type)));
      return traced({ ...base, type }, (ctx) => select(cond.run(ctx) as Int8Array, y.run(ctx), f.run(ctx), type, ctx.n));
    }
    case "coalesce": {
      if (!arity(scope, node, 1, 32, "coalesce(value, fallback, ...)")) return null;
      let type: SType | null = (args[0] as CNode).type;
      for (let i = 1; i < args.length && type; i++) type = unifyAny(type, (args[i] as CNode).type);
      if (!type) return report(scope, "type_mismatch", "Every value in coalesce() must be the same kind of value", node.span);
      const t = type;
      for (let i = 0; i < args.length; i++) args[i] = bind(args[i] as CNode, kindOf(t));
      return traced({ ...base, type: t }, (ctx) => coalesce(args.map((a) => a.run(ctx)), t, ctx.n));
    }
    case "min":
    case "max": {
      if (!arity(scope, node, 2, 32, `${name}(a, b, ...) or ${name}(relationship, {field})`)) return null;
      let type: SType | null = (args[0] as CNode).type;
      for (let i = 1; i < args.length && type; i++) type = unifyAny(type, (args[i] as CNode).type);
      if (!type || type.t !== "q") return report(scope, "type_mismatch", `Every value in ${name}() must be the same kind of number`, node.span);
      const sign = name === "min" ? -1 : 1;
      for (let i = 0; i < args.length; i++) args[i] = bind(args[i] as CNode, kindOf(type));
      return traced({ ...base, type }, (ctx) => extreme(args.map((a) => a.run(ctx) as Float64Array), sign, ctx.n));
    }
    case "abs": {
      if (!arity(scope, node, 1, 1, "abs(value)")) return null;
      const a = args[0] as CNode;
      if (a.type.t !== "q") return report(scope, "type_mismatch", `abs() needs a number, not ${describeType(a.type)}`, node.span);
      return traced({ ...base, type: a.type }, (ctx) => mapNum(a.run(ctx) as Float64Array, Math.abs));
    }
    case "sqrt": {
      if (!arity(scope, node, 1, 1, "sqrt(value)")) return null;
      const a = args[0] as CNode;
      if (a.type.t !== "q") return report(scope, "type_mismatch", `sqrt() needs a number, not ${describeType(a.type)}`, node.span);
      let type: QType;
      if (isScalar(a.type)) type = { ...NUMBER, plain: a.type.plain };
      else {
        if (isAffine(a.type)) return report(scope, "unit_mismatch", `Can't take the square root of ${describeType(a.type)}`, node.span);
        type = derived(powDimension(a.type.dim, 0.5));
      }
      return traced({ ...base, type }, (ctx) => mapNum(a.run(ctx) as Float64Array, (v) => (v >= 0 ? Math.sqrt(v) : NaN)));
    }
    default:
      return compileRounding(node, scope, args, base);
  }
}

function compileRounding(node: Extract<Node, { k: "call" }>, scope: Scope, args: CNode[], base: Omit<CNode, "run" | "type">): CNode | null {
  const name = node.name as "round" | "ceil" | "floor";
  if (!arity(scope, node, 1, 2, `${name}(value), ${name}(value, decimals) or ${name}(value, step) like ${name}({length}, 1 in)`)) return null;
  const x = args[0] as CNode;
  if (x.type.t !== "q") return report(scope, "type_mismatch", `${name}() needs a number, not ${describeType(x.type)}`, node.span);
  const xt = x.type;
  const mode = name === "round" ? roundHalfAway : name === "ceil" ? Math.ceil : Math.floor;
  if (args.length === 1) {
    if (!isScalar(xt)) return report(scope, "unit_mismatch", `Rounding ${describeType(xt)} needs a step, like ${name}({length}, 1 in)`, node.span);
    return traced({ ...base, type: xt }, (ctx) => roundToStep(x.run(ctx) as Float64Array, null, mode, ctx.n));
  }
  const step = args[1] as CNode;
  if (step.type.t !== "q") return report(scope, "type_mismatch", `The step of ${name}() must be a number`, (node.args[1] as Node).span);
  const st = step.type;
  if (isScalar(xt) && isScalar(st)) {
    return traced({ ...base, type: xt }, (ctx) => roundToDecimals(x.run(ctx) as Float64Array, step.run(ctx) as Float64Array, mode, ctx.n));
  }
  const u = unify(xt, st, "same");
  if (!u.ok || st.plain) {
    return report(scope, "unit_mismatch", `Round ${describeType(xt)} to a step of the same kind, like ${name}({length}, 1 in)`, (node.args[1] as Node).span);
  }
  const stepNode = (args[1] = bind(step, u.right));
  return traced({ ...base, type: xt }, (ctx) => roundToStep(x.run(ctx) as Float64Array, stepNode.run(ctx) as Float64Array, mode, ctx.n));
}

/** Snap values within 1e-9 of a whole number so 10 ft / 1 in (120.00000000000001) rounds as 120. */
function snap(q: number): number {
  const r = Math.round(q);
  return Math.abs(q - r) <= 1e-9 * Math.max(1, Math.abs(q)) ? r : q;
}

function roundHalfAway(v: number): number {
  return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
}

function roundToStep(x: Float64Array, step: Float64Array | null, mode: (v: number) => number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = step ? (step[i] as number) : 1;
    const v = x[i] as number;
    out[i] = s > 0 && Number.isFinite(s) ? mode(snap(v / s)) * s : NaN;
  }
  return out;
}

function roundToDecimals(x: Float64Array, digits: Float64Array, mode: (v: number) => number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = digits[i] as number;
    if (!Number.isFinite(d)) {
      out[i] = NaN;
      continue;
    }
    const f = Math.pow(10, Math.round(d));
    out[i] = mode(snap((x[i] as number) * f)) / f;
  }
  return out;
}

function mapNum(a: Float64Array, f: (v: number) => number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i] as number);
  return out;
}

function extreme(cols: Float64Array[], sign: 1 | -1, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c] as Float64Array;
    for (let i = 0; i < n; i++) {
      const v = col[i] as number;
      if (v !== v) continue;
      const cur = out[i] as number;
      if (cur !== cur || (sign > 0 ? v > cur : v < cur)) out[i] = v;
    }
  }
  return out;
}

function select(cond: Int8Array, yes: Col, no: Col, type: SType, n: number): Col {
  if (type.t === "q") {
    const out = new Float64Array(n);
    const y = yes as Float64Array;
    const f = no as Float64Array;
    for (let i = 0; i < n; i++) {
      const c = cond[i] as number;
      out[i] = c < 0 ? NaN : c === 1 ? (y[i] as number) : (f[i] as number);
    }
    return out;
  }
  if (type.t === "bool") {
    const out = new Int8Array(n);
    const y = yes as Int8Array;
    const f = no as Int8Array;
    for (let i = 0; i < n; i++) {
      const c = cond[i] as number;
      out[i] = c < 0 ? -1 : c === 1 ? (y[i] as number) : (f[i] as number);
    }
    return out;
  }
  const out = new Array<string | null>(n);
  const y = yes as (string | null)[];
  const f = no as (string | null)[];
  for (let i = 0; i < n; i++) {
    const c = cond[i] as number;
    out[i] = c < 0 ? null : c === 1 ? (y[i] ?? null) : (f[i] ?? null);
  }
  return out;
}

/** First non-empty value per row; columns are scanned one at a time, filling only rows still empty. */
function coalesce(cols: Col[], type: SType, n: number): Col {
  if (type.t === "q") {
    const out = new Float64Array(n).fill(NaN);
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c] as Float64Array;
      for (let i = 0; i < n; i++) if ((out[i] as number) !== (out[i] as number)) out[i] = col[i] as number;
    }
    return out;
  }
  if (type.t === "bool") {
    const out = new Int8Array(n).fill(-1);
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c] as Int8Array;
      for (let i = 0; i < n; i++) if ((out[i] as number) < 0) out[i] = col[i] as number;
    }
    return out;
  }
  const out = new Array<string | null>(n).fill(null);
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c] as (string | null)[];
    for (let i = 0; i < n; i++) {
      if (out[i] !== null) continue;
      const v = col[i] ?? null;
      if (v !== null && v !== "") out[i] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- relationship aggregates

function compileAggregate(node: Extract<Node, { k: "call" }>, scope: Scope, src: string): CNode | null {
  const fn = node.name as Agg;
  const usage = fn === "count" ? "count(relationship) or count(relationship, condition)" : `${fn}(relationship, {field})`;
  if (!arity(scope, node, fn === "count" ? 1 : 2, 2, usage)) return null;
  const relNode = node.args[0] as Node;
  if (relNode.k !== "ident" || scope.params.has(relNode.name)) return report(scope, "unknown_relationship", `The first part of ${fn}() names a relationship, like ${fn === "count" ? "count(serves)" : `${fn}(serves, {load.wsfu_total})`}`, relNode.span);
  const rel = scope.schema.relationship(relNode.name);
  if (!rel) return report(scope, "unknown_relationship", `There is no relationship called "${relNode.name}" here`, relNode.span);
  const relName = relNode.name;
  let childPlan = scope.plan.relations.get(relName);
  if (!childPlan) {
    childPlan = newPlan();
    scope.plan.relations.set(relName, childPlan);
  }
  const childParams = new Map(scope.params);
  const childScope: Scope = { ...scope, schema: rel.target, plan: childPlan, params: childParams };
  const childNode = node.args[1];
  const child = childNode ? compileNode(childNode, childScope, src) : null;
  if (childNode && !child) return null;

  const offsetsOf = (ctx: Ctx): Int32Array => relationOf(ctx, relName).offsets;
  const display = { as: "aggregate" as const, fn, relationship: relName, offsets: offsetsOf };
  const childCtx = (ctx: Ctx): Ctx => {
    const r = relationOf(ctx, relName);
    return { n: r.target.rowCount, inputs: r.target, params: ctx.params.map((p) => expand(p, r.offsets, ctx.n)), trace: ctx.trace };
  };

  if (fn === "count") {
    if (child && child.type.t !== "bool") return report(scope, "type_mismatch", `The condition in count() must be yes or no, like count(serves, {wsfu} > 2 WSFU)`, (childNode as Node).span);
    const type = fixed(COUNT_KIND, defaultUnitOf(COUNT_KIND));
    return traced({ node, type, children: child ? [child] : [], display }, (ctx) => {
      const offsets = offsetsOf(ctx);
      const flags = child ? (child.run(childCtx(ctx)) as Int8Array) : null;
      const out = new Float64Array(ctx.n);
      for (let i = 0; i < ctx.n; i++) {
        const lo = offsets[i] as number;
        const hi = offsets[i + 1] as number;
        if (!flags) out[i] = hi - lo;
        else {
          let c = 0;
          for (let j = lo; j < hi; j++) if (flags[j] === 1) c++;
          out[i] = c;
        }
      }
      return out;
    });
  }

  const c = child as CNode;
  if (fn === "list") {
    const ct = c.type;
    return traced({ node, type: TEXT, children: [c], display }, (ctx) => {
      const offsets = offsetsOf(ctx);
      const values = c.run(childCtx(ctx));
      const out = new Array<string | null>(ctx.n);
      for (let i = 0; i < ctx.n; i++) {
        const parts: string[] = [];
        for (let j = offsets[i] as number; j < (offsets[i + 1] as number); j++) {
          const text = cellText(values, j, ct);
          if (text !== null) parts.push(text);
        }
        out[i] = parts.join(", ");
      }
      return out;
    });
  }

  if (c.type.t !== "q") return report(scope, "type_mismatch", `${fn}() works on numbers; use list() for ${describeType(c.type)}`, (childNode as Node).span);
  const ct = c.type;
  if (fn === "sum" && ct.kind !== null && !sumAllowed(ct.kind)) {
    return report(scope, "unit_mismatch", `${capitalize(kindLabel(ct.kind))} values don't add up; use max(), avg() or list() instead`, node.nameSpan);
  }
  const type: QType = ct.plain ? NUMBER : ct;
  return traced({ node, type, children: [c], display }, (ctx) => reduce(fn, offsetsOf(ctx), c.run(childCtx(ctx)) as Float64Array, ctx.n));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function relationOf(ctx: Ctx, name: string): { offsets: Int32Array; target: ColumnarInputs } {
  const r = ctx.inputs.relations.get(name);
  if (!r) throw new Error(`Formula inputs have no relationship "${name}"`);
  if (r.offsets.length !== ctx.n + 1 || r.offsets[0] !== 0 || r.offsets[ctx.n] !== r.target.rowCount) {
    throw new Error(`Relationship "${name}" offsets must have ${ctx.n + 1} entries from 0 to ${r.target.rowCount}`);
  }
  return r;
}

/** Repeat each parent value for each of its related rows, so parameters are visible inside aggregates. */
function expand(col: Col, offsets: Int32Array, n: number): Col {
  const total = offsets[n] as number;
  if (col instanceof Float64Array || col instanceof Int8Array) {
    const out = col instanceof Float64Array ? new Float64Array(total) : new Int8Array(total);
    for (let i = 0; i < n; i++) out.fill(col[i] as number, offsets[i] as number, offsets[i + 1] as number);
    return out;
  }
  const out = new Array<string | null>(total);
  for (let i = 0; i < n; i++) for (let j = offsets[i] as number; j < (offsets[i + 1] as number); j++) out[j] = col[i] ?? null;
  return out;
}

function reduce(fn: "sum" | "avg" | "min" | "max", offsets: Int32Array, values: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  if (fn === "sum" || fn === "avg") {
    for (let i = 0; i < n; i++) {
      let acc = 0;
      let count = 0;
      for (let j = offsets[i] as number, hi = offsets[i + 1] as number; j < hi; j++) {
        const v = values[j] as number;
        if (v !== v) continue;
        acc += v;
        count++;
      }
      out[i] = fn === "sum" ? acc : count > 0 ? acc / count : NaN;
    }
    return out;
  }
  const max = fn === "max";
  for (let i = 0; i < n; i++) {
    let acc = NaN;
    for (let j = offsets[i] as number, hi = offsets[i + 1] as number; j < hi; j++) {
      const v = values[j] as number;
      if (v !== v) continue;
      if (acc !== acc || (max ? v > acc : v < acc)) acc = v;
    }
    out[i] = acc;
  }
  return out;
}

export function displayUnit(t: QType): UnitCode | null {
  if (t.kind === null) return t.unit;
  return t.unit !== null && unitAllowed(t.kind, t.unit) ? t.unit : defaultUnitOf(t.kind);
}

/** One cell as text for list() and explain; `null` when empty. */
export function cellText(col: Col, i: number, t: SType): string | null {
  if (t.t === "q") {
    const v = (col as Float64Array)[i] as number;
    if (v !== v) return null;
    const unit = displayUnit(t);
    return unit ? formatQuantity(v, unit) : formatQuantity(v, NUMBER_UNIT);
  }
  if (t.t === "bool") {
    const v = (col as Int8Array)[i] as number;
    return v < 0 ? null : v === 1 ? "yes" : "no";
  }
  const v = (col as (string | null)[])[i] ?? null;
  return v === null || v === "" ? null : v;
}

export function cellTextQuoted(col: Col, i: number, t: SType): string | null {
  const text = cellText(col, i, t);
  return text !== null && t.t === "text" ? quoteText(text) : text;
}

// ---------------------------------------------------------------- lookup tables

function compileLookup(node: Extract<Node, { k: "call" }>, scope: Scope, src: string): CNode | null {
  if (!arity(scope, node, 2, 2, "lookup(table, key)")) return null;
  const tableNode = node.args[0] as Node;
  if (tableNode.k !== "ident") return report(scope, "unknown_table", "The first part of lookup() names a library table, like lookup(PZ.DemandFactors, {count})", tableNode.span);
  const sig = scope.schema.table?.(tableNode.name);
  if (!sig) return report(scope, "unknown_table", `There is no library table called "${tableNode.name}"`, tableNode.span);
  scope.session.tables.add(tableNode.name);
  const key = compileNode(node.args[1] as Node, scope, src);
  if (!key) return null;
  const keyType = fromFormulaType(sig.key);
  const valueType = fromFormulaType(sig.value);
  if (typeof keyType === "string" || typeof valueType === "string") return report(scope, "unknown_unit", `The table "${tableNode.name}" is set up wrong: ${typeof keyType === "string" ? keyType : valueType}`, tableNode.span);
  const keyFits = keyType.t === "q" && key.type.t === "q" ? fits(key.type, keyType) : key.type.t === keyType.t;
  const keyNode = bind(key, kindOf(keyType));
  if (!keyFits) return report(scope, "type_mismatch", `The table "${tableNode.name}" is looked up by ${describeType(keyType)}, not ${describeType(key.type)}`, (node.args[1] as Node).span);
  if (sig.match === "floor" && keyType.t !== "q") return report(scope, "type_mismatch", `The table "${tableNode.name}" matches the nearest lower key, so its keys must be numbers`, tableNode.span);
  const index = buildIndex(sig);
  if (typeof index === "string") return report(scope, "unknown_table", `The table "${tableNode.name}" ${index}`, tableNode.span);
  return traced({ node, type: valueType, children: [keyNode], display: { as: "lookup", table: tableNode.name } }, (ctx) => lookupColumn(keyNode.run(ctx), keyNode.type, valueType, index, ctx.n));
}

type TableIndex = { readonly match: "exact"; readonly map: ReadonlyMap<string | number, CellValue> } | { readonly match: "floor"; readonly keys: Float64Array; readonly values: readonly CellValue[] };

function buildIndex(sig: LookupTableSignature): TableIndex | string {
  if (sig.match === "exact") {
    const map = new Map<string | number, CellValue>();
    for (const row of sig.rows) {
      if (typeof row.key !== "string" && typeof row.key !== "number") return "has a key that is not text or a number";
      if (map.has(row.key)) return `has the key ${String(row.key)} twice`;
      map.set(row.key, row.value);
    }
    return { match: "exact", map };
  }
  const rows = [...sig.rows].sort((a, b) => Number(a.key) - Number(b.key));
  const keys = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const k = (rows[i] as { key: CellValue }).key;
    if (typeof k !== "number" || !Number.isFinite(k)) return "has a key that is not a number";
    if (i > 0 && k === keys[i - 1]) return `has the key ${k} twice`;
    keys[i] = k;
  }
  return { match: "floor", keys, values: rows.map((r) => r.value) };
}

function lookupColumn(keys: Col, keyType: SType, valueType: SType, index: TableIndex, n: number): Col {
  const valueAt = (i: number): CellValue => {
    let key: string | number | null;
    if (keyType.t === "q") {
      const v = (keys as Float64Array)[i] as number;
      key = v === v ? v : null;
    } else if (keyType.t === "bool") return null;
    else key = (keys as (string | null)[])[i] ?? null;
    if (key === null) return null;
    if (index.match === "exact") return index.map.get(key) ?? null;
    if (typeof key !== "number") return null;
    let lo = 0;
    let hi = index.keys.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((index.keys[mid] as number) <= key + 1e-12 * Math.abs(key)) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : (index.values[found] ?? null);
  };
  return fillColumn(valueType, n, valueAt);
}

export function fillColumn(type: SType | FormulaType, n: number, valueAt: (i: number) => CellValue): Col {
  const kind = "t" in type ? type.t : type.type === "quantity" ? "q" : type.type === "boolean" ? "bool" : "text";
  if (kind === "q") {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = valueAt(i);
      out[i] = typeof v === "number" && Number.isFinite(v) ? v : NaN;
    }
    return out;
  }
  if (kind === "bool") {
    const out = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const v = valueAt(i);
      out[i] = typeof v === "boolean" ? (v ? 1 : 0) : -1;
    }
    return out;
  }
  const out = new Array<string | null>(n);
  for (let i = 0; i < n; i++) {
    const v = valueAt(i);
    out[i] = typeof v === "string" ? v : null;
  }
  return out;
}

// ---------------------------------------------------------------- named calculations

function compileCalculation(node: Extract<Node, { k: "call" }>, scope: Scope, src: string): CNode | null {
  const id = node.name;
  const sig = scope.schema.calculation?.(id);
  if (!sig) {
    const what = id.includes(".") ? "library calculation" : "function";
    return report(scope, id.includes(".") ? "unknown_calculation" : "unknown_function", `There is no ${what} called ${id}`, node.nameSpan);
  }
  scope.session.calculations.add(id);
  if (++scope.session.calculationCalls > MAX_CALCULATION_CALLS) {
    return report(scope, "too_complex", `This formula expands to more than ${MAX_CALCULATION_CALLS} library calculation calls; simplify the calculations it uses`, node.nameSpan);
  }
  if (scope.calcStack.includes(id)) {
    const chain = [...scope.calcStack.slice(scope.calcStack.indexOf(id)), id];
    return report(scope, "cycle", `${chain.join(" uses ")}: a calculation can't use itself`, node.nameSpan);
  }
  if (node.args.length !== sig.params.length) {
    return report(scope, "arity", `${id}() takes ${sig.params.length} value${sig.params.length === 1 ? "" : "s"}: ${sig.params.map((p) => p.name).join(", ") || "none"}`, node.span);
  }
  const args: CNode[] = [];
  const params = new Map<string, { index: number; type: SType }>();
  for (let i = 0; i < sig.params.length; i++) {
    const p = sig.params[i] as { name: string; type: FormulaType };
    const arg = compileNode(node.args[i] as Node, scope, src);
    if (!arg) return null;
    const want = fromFormulaType(p.type);
    if (typeof want === "string") return report(scope, "unknown_unit", `${id} is set up wrong: ${want}`, node.nameSpan);
    const ok = want.t === "q" && arg.type.t === "q" ? fits(arg.type, want) : want.t === arg.type.t;
    if (!ok) return report(scope, "type_mismatch", `${id} expects ${describeType(want)} for ${p.name}, not ${describeType(arg.type)}`, (node.args[i] as Node).span);
    args.push(bind(arg, kindOf(want)));
    params.set(p.name, { index: i, type: want });
  }
  const result = fromFormulaType(sig.result);
  if (typeof result === "string") return report(scope, "unknown_unit", `${id} is set up wrong: ${result}`, node.nameSpan);
  const parsed = parseFormula(sig.expression);
  if (!parsed.ok) return report(scope, parsed.error.code, parsed.error.message, parsed.error.span);
  const bodyScope: Scope = {
    ...scope,
    params,
    calcStack: [...scope.calcStack, id],
    callSite: scope.callSite ?? { id, span: node.nameSpan },
  };
  const body = compileNode(parsed.node, bodyScope, sig.expression);
  if (!body) return null;
  const bodyOk = result.t === "q" && body.type.t === "q" ? fits(body.type, result) : result.t === body.type.t;
  if (!bodyOk) return report(scope, "type_mismatch", `${id} works out to ${describeType(body.type)} but says it returns ${describeType(result)}`, node.nameSpan);
  return traced({ node, type: result, children: args, display: { as: "call", name: id } }, (ctx) => body.run({ n: ctx.n, inputs: ctx.inputs, params: args.map((a) => a.run(ctx)), trace: ctx.trace }));
}

export function isBuiltinFunction(name: string): boolean {
  return BUILTINS.has(name);
}

export function toValueColumn(col: Col, type: FormulaType): ValueColumn {
  if (type.type === "quantity") return { type: "quantity", kind: type.kind, values: col as Float64Array };
  if (type.type === "boolean") return { type: "boolean", values: col as Int8Array };
  return { type: "text", values: col as (string | null)[] };
}
