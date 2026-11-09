/**
 * `explain` prints the formula with every field replaced by its value and
 * the answer at the end: "199 MBH × 1000 = 199,000 MBH". The grid shows it
 * on a locked cell; agents get it on request.
 */

import { cellText, cellTextQuoted, type CNode, type Col, type Compiled } from "./compile";
import { EMPTY_TEXT, formatQuantity } from "./format";
import { precedenceOf } from "./parse";
import type { FormulaType, FormulaValue } from "./types";

const SYMBOL: Readonly<Record<string, string>> = { "*": "×", "/": "÷" };
const MAX_LISTED = 6;

export function renderExplanation(compiled: Compiled, trace: Map<CNode, Col>, result: FormulaValue): string {
  return `${render(compiled.root, trace, 0, "left")} = ${valueText(result, compiled.type)}`;
}

function precedence(c: CNode): number {
  if (c.display.as === "binary") return precedenceOf(c.display.op);
  if (c.display.as === "unary") return c.display.op === "-" ? 7 : 3;
  return 9;
}

function render(c: CNode, trace: Map<CNode, Col>, parentPrec: number, side: "left" | "right", parentOp?: string): string {
  const text = renderBare(c, trace);
  const own = precedence(c);
  const associative = parentOp === "+" || parentOp === "*" || parentOp === "and" || parentOp === "or";
  const needs = own < parentPrec || (own === parentPrec && ((side === "right" && !associative) || (side === "left" && parentOp === "^")));
  return needs ? `(${text})` : text;
}

function renderBare(c: CNode, trace: Map<CNode, Col>): string {
  const d = c.display;
  switch (d.as) {
    case "leaf": {
      if (c.literal !== undefined) return c.literal;
      const col = trace.get(c);
      return (col && cellTextQuoted(col, 0, c.type)) ?? EMPTY_TEXT;
    }
    case "unary": {
      const arg = c.children[0] as CNode;
      return d.op === "-" ? `-${render(arg, trace, 7, "right", "-")}` : `not ${render(arg, trace, 3, "right", "not")}`;
    }
    case "binary": {
      const prec = precedenceOf(d.op);
      const [l, r] = c.children as [CNode, CNode];
      return `${render(l, trace, prec, "left", d.op)} ${SYMBOL[d.op] ?? d.op} ${render(r, trace, prec, "right", d.op)}`;
    }
    case "call":
      return `${d.name}(${c.children.map((a) => render(a, trace, 0, "left")).join(", ")})`;
    case "lookup":
      return `lookup(${d.table}, ${render(c.children[0] as CNode, trace, 0, "left")})`;
    case "aggregate": {
      const child = c.children[0];
      const col = child ? trace.get(child) : undefined;
      if (d.fn === "count" && !child) {
        const own = trace.get(c);
        return `count(${d.relationship}: ${own ? cellText(own, 0, c.type) ?? "0" : "0"})`;
      }
      if (!child || !col) return `${d.fn}(${d.relationship}: none)`;
      if (d.fn === "count") {
        const own = trace.get(c);
        return `count(${d.relationship}: ${own ? cellText(own, 0, c.type) ?? "0" : "0"} of ${col.length})`;
      }
      const parts: string[] = [];
      for (let j = 0; j < col.length; j++) parts.push(cellTextQuoted(col, j, child.type) ?? EMPTY_TEXT);
      if (parts.length === 0) return `${d.fn}(${d.relationship}: none)`;
      const shown = parts.length > MAX_LISTED ? [...parts.slice(0, MAX_LISTED), `… ${parts.length - MAX_LISTED} more`] : parts;
      return `${d.fn}(${d.relationship}: ${shown.join(", ")})`;
    }
  }
}

export function valueText(v: FormulaValue, type: FormulaType): string {
  switch (v.type) {
    case "empty":
      return EMPTY_TEXT;
    case "text":
      return v.value;
    case "boolean":
      return v.value ? "yes" : "no";
    case "quantity":
      return formatQuantity(v.value, type.type === "quantity" ? type.unit : "1");
  }
}
