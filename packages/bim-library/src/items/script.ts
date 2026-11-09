import { z } from "zod";
import { isRegistryIdShape, readAuthorRef, type AuthorRef } from "@permitzip/bim-kernel";
import { KIND_IDS, UNIT_CODES } from "@permitzip/bim-units";
import { itemBase, semver, spdxExpression, text } from "../item-base";

/**
 * The `script` library item (round 11 X11; SCRIPTING-PROPOSAL §5.4): a
 * script's source and its manifest (kind, typed parameters, presets, what it
 * reads), its licence and authors, semver version and the version it came
 * from. Approval for agent use is the host's (per firm, per version and
 * hash), never stored in the item, so approving changes no content hash.
 *
 * Stored value lists stay open where a newer kit may add values (script
 * kinds, languages): a reader keeps one it doesn't know; the kit refuses to
 * run it.
 */

export const SCRIPT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
export const SCRIPT_PARAMETER_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,47}$/;
/** Largest script source a library item holds (a script is a recipe, not a bundle of data). */
export const MAX_SCRIPT_SOURCE_CHARS = 200_000;

/** `part` makes part types; `layout` and `route` make edits. Open: a newer kit's kind is kept. */
export const SCRIPT_KINDS = ["part", "layout", "route"] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number] | (string & {});

const registryId = z.string().refine(isRegistryIdShape, "a registry id such as wall or mep.air_terminal");
const label = text(120);

/** One parameter value as stored: quantities in coherent SI (bim-units), so a value means the same in every unit system. */
export const scriptValueSchema = z.union([z.string().max(400), z.number().finite(), z.boolean()]);
export type ScriptValue = z.infer<typeof scriptValueSchema>;

const quantityParameter = z.object({
  type: z.literal("quantity"),
  kind: z.enum(KIND_IDS),
  /** The unit a form shows it in; values are stored in SI. */
  unit: z.enum(UNIT_CODES),
  label,
  description: z.string().max(400).optional(),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});

export const scriptParameterSchema = z.discriminatedUnion("type", [
  quantityParameter,
  z.object({ type: z.literal("number"), label, description: z.string().max(400).optional(), integer: z.boolean().optional(), default: z.number().finite().optional(), min: z.number().finite().optional(), max: z.number().finite().optional() }),
  z.object({ type: z.literal("choice"), label, description: z.string().max(400).optional(), choices: z.array(z.object({ value: text(80), label: text(120) })).min(1).max(100), default: text(80).optional() }),
  z.object({ type: z.literal("boolean"), label, description: z.string().max(400).optional(), default: z.boolean().optional() }),
  z.object({ type: z.literal("text"), label, description: z.string().max(400).optional(), maxLength: z.number().int().min(1).max(400).optional(), default: z.string().max(400).optional() }),
  /** A part type the model (or the slice) has, by type id; `category` narrows the choice. */
  z.object({ type: z.literal("part_type"), label, description: z.string().max(400).optional(), category: registryId.optional() }),
]);
export type ScriptParameter = z.infer<typeof scriptParameterSchema>;

/**
 * What a script reads of the model. Hosts serialise only this slice; a read
 * beyond it is a plain error naming what to add (bim-script `ScriptReadError`).
 */
export const scriptReadsSchema = z
  .object({
    /** Levels and the model's settings. */
    levels: z.boolean().optional(),
    /** Every element of these kinds. */
    kinds: z.array(registryId).max(50).optional(),
    /** These element ids, or the person's selection when the run starts. */
    ids: z.union([z.literal("selection"), z.array(text(200)).max(5000)]).optional(),
    /** Part types whose type id matches one of these (`*` matches any run of characters). */
    partTypes: z.array(z.string().regex(/^[A-Za-z0-9._:*-]{1,200}$/)).max(50).optional(),
    /** Field paths `ctx.model.field(id, path)` reads, worked out by the kernel on the working copy (round 15). */
    fields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/, "a field path such as fire_rating or values.flow")).max(200).optional(),
    /** Schedule views whose rows `ctx.model.rows(viewId)` reads (round 15). */
    rows: z.array(text(200)).max(100).optional(),
    /** Calculations `ctx.calc(id, inputs)` runs, by calc id (round 15). */
    calc: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,119}$/, "a calc id such as pressure_loss")).max(50).optional(),
    /** `ctx.model.footprint(levelId)`: each level's outline from its walls and slabs (round 15). */
    footprint: z.boolean().optional(),
  })
  .strict();
export type ScriptReads = z.infer<typeof scriptReadsSchema>;

export const scriptPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  title: text(120),
  /** Other names a search finds it by ("M3x10", "DIN 933 M3"). */
  aliases: z.array(text(80)).max(20).optional(),
  values: z.record(z.string().regex(SCRIPT_PARAMETER_NAME_PATTERN), scriptValueSchema),
});
export type ScriptPreset = z.infer<typeof scriptPresetSchema>;

export const scriptManifestSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) as z.ZodType<ScriptKind>,
  parameters: z.record(z.string().regex(SCRIPT_PARAMETER_NAME_PATTERN), scriptParameterSchema),
  presets: z.array(scriptPresetSchema).max(200).default([]),
  reads: scriptReadsSchema,
});
export type ScriptManifest = z.infer<typeof scriptManifestSchema>;
export type ScriptManifestInput = z.input<typeof scriptManifestSchema>;

/** An author as stored, read with 8b's tolerant reader (unknown providers kept). */
export const authorRefSchema = z.custom<AuthorRef>((v) => readAuthorRef(v).ok, { message: "an author: provider, subject and kind" });

export const scriptItemSchema = z.object({
  ...itemBase,
  key: z.string().regex(SCRIPT_KEY_PATTERN, "a script id such as acme.fcu_from_cut_sheet"),
  name: text(120),
  /** The script's own semver (what an approval and a part's provenance name). */
  version: semver,
  /** The version it was made from, when it is an edit of one. */
  parentVersion: semver.optional(),
  /** `typescript` (the kit's language). Open: a later builder may add one. */
  language: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  /** The kit version range it was written against (`>=0.1.0`). */
  kit: text(40),
  manifest: scriptManifestSchema,
  source: z.string().min(1).max(MAX_SCRIPT_SOURCE_CHARS),
  license: spdxExpression,
  authors: z.array(authorRefSchema).min(1).max(20),
});
export type ScriptItem = z.infer<typeof scriptItemSchema>;

/** What the kit allows a script module to import: the kit, nothing else. */
export const SCRIPT_KIT_MODULE = "@permitzip/bim-script";

const FORBIDDEN_SOURCE: readonly { readonly pattern: RegExp; readonly words: string }[] = [
  { pattern: /\bimport\s*\(/, words: "loads code at run time (import(...))" },
  { pattern: /\brequire\s*\(/, words: "loads code with require(...)" },
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/, words: "names the network" },
  { pattern: /\b(?:process|Deno|Bun)\s*\./, words: "reads the host process" },
  { pattern: /\bglobalThis\b/, words: "reaches the global object" },
  { pattern: /\b(?:eval|Function)\s*\(/, words: "builds code at run time" },
  { pattern: /\bnew\s+Function\b/, words: "builds code at run time" },
  { pattern: /\bDate\b/, words: "reads the clock (Date), so its output would change run to run" },
  { pattern: /\bMath\s*\.\s*random\b/, words: "uses Math.random; use the kit's seeded random" },
  { pattern: /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/, words: "uses timers" },
  { pattern: /\bperformance\s*\./, words: "reads the clock (performance)" },
];

/**
 * Static checks on a script's source, in words (install-time conformance
 * and the kit's `check`): imports only the kit, no run-time code loading,
 * no network, process, clock, randomness or timers. Not a sandbox: the
 * runner contract is the boundary; this catches the honest mistakes and the
 * obvious hostile ones before anything runs.
 */
export function scriptSourceIssues(source: string): string[] {
  const out: string[] = [];
  if (source.length > MAX_SCRIPT_SOURCE_CHARS) out.push(`is ${source.length} characters; a script holds at most ${MAX_SCRIPT_SOURCE_CHARS}.`);
  const code = stripCommentsAndStrings(source);
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)) {
    if (m[1] !== SCRIPT_KIT_MODULE) out.push(`imports "${m[1]}"; a script imports only ${SCRIPT_KIT_MODULE}.`);
  }
  for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(`imports "${m[1]}" for its side effects; a script imports only ${SCRIPT_KIT_MODULE}.`);
  for (const rule of FORBIDDEN_SOURCE) if (rule.pattern.test(code)) out.push(rule.words + ".");
  return out;
}

/** One static finding with its 1-based line (0: the whole script). */
export interface ScriptSourceFinding {
  readonly line: number;
  readonly message: string;
}

/** `scriptSourceIssues` with the line each one is on, for an author fixing them. */
export function scriptSourceFindings(source: string): ScriptSourceFinding[] {
  const out: ScriptSourceFinding[] = [];
  if (source.length > MAX_SCRIPT_SOURCE_CHARS) out.push({ line: 0, message: `The script is ${source.length} characters; a script holds at most ${MAX_SCRIPT_SOURCE_CHARS}.` });
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)) {
    if (m[1] !== SCRIPT_KIT_MODULE) out.push({ line: lineAt(m.index + m[0].search(/\S/)), message: `It imports "${m[1]}"; a script imports only ${SCRIPT_KIT_MODULE}.` });
  }
  for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push({ line: lineAt(m.index + m[0].search(/\S/)), message: `It imports "${m[1]}" for its side effects; a script imports only ${SCRIPT_KIT_MODULE}.` });
  const code = stripCommentsAndStrings(source).split("\n");
  for (const rule of FORBIDDEN_SOURCE) {
    const at = code.findIndex((l) => rule.pattern.test(l));
    if (at >= 0) out.push({ line: at + 1, message: `It ${rule.words}.` });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Source with comments and string bodies blanked, so a word inside a label never trips a rule (an import's module name is read from the raw text). Newlines stay, so lines keep their numbers. */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const skip = (to: number) => {
    for (; i < to && i < source.length; i++) if (source[i] === "\n") out += "\n";
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      skip(end < 0 ? source.length : end + 2);
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\n") out += "\n";
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
