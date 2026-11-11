import { BOUNDING_ELEMENT_POINT } from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { scriptSourceFindings, type ScriptReads, type ScriptSourceFinding } from "@permitzip/bim-library";
import { units } from "./define";
import { building, equipment } from "./kit-building";
import { checks } from "./kit-checks";
import { documents } from "./kit-documents";
import { parts } from "./kit-parts";
import { routes } from "./kit-routes";
import { scriptCommands } from "./reference";

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

/** Something the script calls that the kit doesn't have: it would fail in the run, so it is said before one is spent. */
export interface ScriptKitWarning {
  readonly line: number;
  readonly rule: "kit";
  readonly message: string;
}

const KIT_NAMESPACES: Readonly<Record<string, object>> = { units, routes, parts, building, equipment, documents, checks };
const KIT_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*["']@permitzip\/bim-script["'];?/;

/** Up to four real names close to a wrong one: those that contain it or are contained in it first, then those that start the same. */
function nearNames(want: string, have: readonly string[]): string[] {
  const w = want.toLowerCase();
  const within = have.filter((h) => h.toLowerCase().includes(w) || w.includes(h.toLowerCase()));
  const sameStart = have.filter((h) => !within.includes(h) && h.toLowerCase().slice(0, 4) === w.slice(0, 4));
  return [...within, ...sameStart].slice(0, 4);
}

/** The script declares its own `name` (a variable, a parameter), so `name.x` isn't the kit's. */
function declaresOwn(body: string, name: string): boolean {
  return new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${name}\b|[({,\[]\s*${name}\s*(?:[,)}\]]|:\s*[A-Za-z{])|\b${name}\s*=>`).test(body);
}

/**
 * Kit calls that can't work, found by reading the source (nothing runs): a
 * function the kit's `units`, `routes`, `parts`, `building`, `equipment`,
 * `documents` or `checks` doesn't have, and a `ctx.edit({ type: "..." })`
 * whose command no schema here has. Each names its line and the closest real
 * names. Warnings, not findings: a script that names its own variable
 * `parts` is left alone, and anything this misses still fails in the run
 * with its line.
 */
export function kitUseWarnings(source: string): ScriptKitWarning[] {
  const out: ScriptKitWarning[] = [];
  const imported = new Set(
    (KIT_IMPORT.exec(source)?.[1] ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && !/\sas\s/.test(n)),
  );
  const body = source.replace(KIT_IMPORT, "");
  const lines = source.split("\n");
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;
  const commented = (line: number) => /^\s*(\/\/|\*|\/\*)/.test(lines[line - 1] ?? "");
  const seen = new Set<string>();

  for (const m of source.matchAll(/(?<![.\w$])(units|routes|parts|building|equipment|documents|checks)\.([A-Za-z_$][\w$]*)/g)) {
    const ns = m[1] ?? "";
    const member = m[2] ?? "";
    const kit = KIT_NAMESPACES[ns];
    const line = lineAt(m.index ?? 0);
    if (!kit || !imported.has(ns) || member in kit || member in Array.prototype || seen.has(`${ns}.${member}`) || commented(line) || declaresOwn(body, ns)) continue;
    seen.add(`${ns}.${member}`);
    const near = nearNames(member, Object.keys(kit));
    out.push({ line, rule: "kit", message: `Line ${line} calls ${ns}.${member}, but the kit's ${ns} has no ${member}.${near.length > 0 ? ` Near: ${near.map((n) => `${ns}.${n}`).join(", ")}.` : ""} bim_script_reference({ search: "${ns}" }) lists what it has.` });
  }

  let commands: readonly string[] | null = null;
  for (const m of source.matchAll(/\bctx\.edit\(\s*\{\s*type\s*:\s*["']([A-Za-z_]+)["']/g)) {
    const type = m[1] ?? "";
    const line = lineAt(m.index ?? 0);
    commands ??= scriptCommands().map((c) => c.type);
    if (commands.includes(type) || seen.has(`edit.${type}`) || commented(line)) continue;
    seen.add(`edit.${type}`);
    const near = nearNames(type, commands);
    out.push({ line, rule: "kit", message: `Line ${line} sends ctx.edit a "${type}" command, and there is no such command.${near.length > 0 ? ` Near: ${near.join(", ")}.` : ""} bim_script_reference({ command: "<name>" }) gives one command's fields; ({ search }) finds one.` });
  }
  return out.sort((a, b) => a.line - b.line);
}
