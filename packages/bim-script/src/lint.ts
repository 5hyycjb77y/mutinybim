import { BOUNDING_ELEMENT_POINT } from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { scriptSourceFindings, type ScriptReads, type ScriptSourceFinding } from "@permitzip/bim-library";

/**
 * The kit's lint, before anything runs: the library's source rules
 * (imports only the kit; no network, process, clock, randomness, timers or
 * run-time code), and the shape every script has (one default export of
 * `defineScript`, a kind). Each finding names its line. Runs no script code.
 */

export type ScriptLintFinding = ScriptSourceFinding & { readonly rule: "source" | "shape" };

const KINDS = ["part", "layout", "route"] as const;

export function lintScript(source: string): ScriptLintFinding[] {
  const out: ScriptLintFinding[] = scriptSourceFindings(source).map((f) => ({ ...f, rule: "source" }));
  const lines = source.split("\n");
  const exportAt = lines.findIndex((l) => /^\s*export\s+default\b/.test(l));
  if (exportAt < 0) out.push({ line: 0, rule: "shape", message: "The script has no `export default defineScript({ ... })`." });
  else if (!/^\s*export\s+default\s+defineScript\s*\(/.test(lines[exportAt] ?? "")) out.push({ line: exportAt + 1, rule: "shape", message: "The default export isn't defineScript({ ... })." });
  if (!/\bimport\s*\{[^}]*\bdefineScript\b[^}]*\}\s*from\s*["']@permitzip\/bim-script["']/.test(source)) out.push({ line: 1, rule: "shape", message: 'The script doesn\'t import defineScript: import { defineScript } from "@permitzip/bim-script".' });
  const kind = /\bkind\s*:\s*["']([a-z_]+)["']/.exec(source);
  if (!kind) out.push({ line: exportAt + 1, rule: "shape", message: `The script doesn't say its kind: kind: "${KINDS.join('" | "')}".` });
  return out.sort((a, b) => a.line - b.line);
}

/** Something a script calls that needs data its reads don't send. A warning: the script may make that data itself before the call. */
export interface ScriptReadsWarning {
  readonly line: number;
  readonly rule: "reads";
  readonly message: string;
}

/**
 * What the script calls against what it declares it reads, before anything
 * runs: a kit function that works from model data the script neither reads
 * nor draws fails in the run with words about the model ("nothing on this
 * level bounds rooms yet"), not about the reads. This says it up front.
 */
export function readsWarnings(source: string, reads: ScriptReads): ScriptReadsWarning[] {
  const out: ScriptReadsWarning[] = [];
  const lines = source.split("\n");
  const lineOf = (re: RegExp) => lines.findIndex((l) => re.test(l)) + 1;

  const traces = lineOf(/\bbuilding\.spaceInWalls\s*\(/);
  if (traces > 0) {
    const rows = activePackSet().items(BOUNDING_ELEMENT_POINT);
    const read = rows.some((r) => reads.kinds?.includes(r.kind)) || reads.ids !== undefined;
    const draws = /\bbuilding\.(walls|wall|elements)\s*\(|["']create_elements["']/.test(source);
    if (!read && !draws) {
      const [first] = rows;
      out.push({ line: traces, rule: "reads", message: `Line ${traces} calls building.spaceInWalls, which traces the walls around a point, but you didn't read walls: add "${first?.kind ?? "wall"}" to reads.kinds, or draw the walls in the script first.` });
    }
  }

  if (!reads.levels && !/\bbuilding\.level\s*\(|["']create_level["']/.test(source)) {
    lines.forEach((l, i) => {
      const named = /\blevel\s*:\s*["']([^"']*\s[^"']*)["']/.exec(l);
      if (named) out.push({ line: i + 1, rule: "reads", message: `Line ${i + 1} gives the level as "${named[1]}". A level argument is the level's id; to use its name instead, read the levels (reads.levels: true).` });
    });
  }
  return out;
}
