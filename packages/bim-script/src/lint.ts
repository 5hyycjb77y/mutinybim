import { scriptSourceFindings, type ScriptSourceFinding } from "@permitzip/bim-library";

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
