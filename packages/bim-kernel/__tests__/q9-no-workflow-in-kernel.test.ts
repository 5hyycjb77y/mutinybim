/**
 * @jest-environment node
 *
 * Round 9 lane Q9 (`q9-no-workflow-in-kernel`): the kernel's question and
 * submittal code carries no workflow. No due date, no "late", no "overdue",
 * no price and no RFI numbering: those are a host's (the host app, a firm's
 * workflow) behind `externalRefs` and the outcome point. Comments explaining
 * that rule are allowed; code identifiers and strings are not.
 *
 * Fails on round 8b's code only if one of those words is written into code;
 * this guards the rule from here on (it passes on 8b and must keep passing).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["questions", "submittals"].map((d) => join(__dirname, "..", "src", d));
const FORBIDDEN = /\b(overdue|due[_ ]?date|dueAt|due_at|deadline|is_?late|lateness|sla|price|pricing|invoice|change_?order|rfi_?number)\b/i;

function codeLines(source: string): string[] {
  // Drop block and line comments; keep code and string literals.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"));
}

describe("q9 no workflow in the kernel's questions and submittals", () => {
  it("no due dates, lateness, prices or RFI numbering in code", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of readdirSync(root).filter((f) => f.endsWith(".ts"))) {
        codeLines(readFileSync(join(root, file), "utf8")).forEach((line, i) => {
          // The commercial-word guard names the words it refuses, in its pattern and its refusals.
          if (line.includes("const COMMERCIAL") || line.includes("isCommercialWord(")) return;
          if (FORBIDDEN.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
