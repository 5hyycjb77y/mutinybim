import { z } from "zod";
import { MAX_EDIT_BATCH_STEPS, SHEET_SETS_NOT_BUILT, commandIssueMessage, commandSchema, isEditBatchCommand, isServerOnlyCommand, isSheetSetCommand, partTypeDefinitionSchema, type EditBatchCommand, type PartTypeDefinition } from "@permitzip/bim-kernel";

/**
 * What a script produces (SCRIPTING-PROPOSAL §5.1): ordinary `batch_edits`
 * (at most 500 steps each, one approval for the series) or ordinary part
 * types. Never a server-only command, never a nested batch. The server
 * re-parses every batch with the kernel's own schema and re-runs it
 * (`planCommit`), so nothing a script writes is trusted as written.
 */

/** `run` records through the context and returns nothing. */
export type ScriptResult = void;

/** One `batch_edits` as the kernel types it, always labelled. */
export type EditBatch = EditBatchCommand & { readonly label: string };
/** One step of a batch. */
export type EditStep = EditBatchCommand["commands"][number];

/** One value a script reported with `ctx.report`: what the agent sees beside the preview. */
export interface ScriptReport {
  readonly label: string;
  readonly value: unknown;
}

/** At most this many reports per run. */
export const MAX_SCRIPT_REPORTS = 50;
/** At most this much report JSON per run (labels and values together). */
export const MAX_SCRIPT_REPORT_BYTES = 16 * 1024;

export type ScriptOutput =
  | { readonly kind: "edits"; readonly label: string; readonly steps: number; readonly batches: readonly EditBatch[]; readonly report?: readonly ScriptReport[] }
  | { readonly kind: "part_types"; readonly types: readonly { readonly typeId: string; readonly definition: PartTypeDefinition }[]; readonly report?: readonly ScriptReport[] };

const reportSchema = z.array(z.object({ label: z.string().min(1).max(120), value: z.unknown() })).max(MAX_SCRIPT_REPORTS).optional();

/** The envelope as JSON (what a runner returns); batches and definitions are re-parsed by `parseScriptOutput`. */
export const scriptOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("edits"),
    label: z.string().trim().min(1).max(160),
    steps: z.number().int().min(0),
    batches: z.array(z.object({ type: z.literal("batch_edits"), label: z.string().trim().min(1).max(160), commands: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_EDIT_BATCH_STEPS) })).max(200),
    report: reportSchema,
  }),
  z.object({
    kind: z.literal("part_types"),
    types: z.array(z.object({ typeId: z.string().min(1).max(200), definition: z.unknown() })).min(1).max(200),
    report: reportSchema,
  }),
]);

export class ScriptOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptOutputError";
  }
}

const NESTED = new Set(["batch_edits", "batch_documents", "batch_service_links"]);

/** Why a step can't be in a script's output, or null. */
export function stepRefusal(step: { readonly type: string }): string | null {
  if (isServerOnlyCommand(step)) return `"${step.type}" is a command only the model server makes (a merge or an import); a script can't produce it.`;
  if (NESTED.has(step.type)) return `"${step.type}" is a batch; a script's steps are single edits, and the kit makes the batches.`;
  // The kernel refuses every sheet set command until sets are model data, so the kit doesn't offer them.
  if (isSheetSetCommand(step)) return `${SHEET_SETS_NOT_BUILT}, so a script can't make one. Number the sheets in print order; a person picks the sheets when printing or issuing.`;
  return null;
}

/** Steps as `batch_edits` of at most 500 (the kernel's limit), labelled "label (part i of n)" when there are several. */
export function chunkEdits(label: string, steps: readonly EditStep[]): EditBatch[] {
  const n = Math.ceil(steps.length / MAX_EDIT_BATCH_STEPS);
  const out: EditBatch[] = [];
  for (let i = 0; i < n; i++) {
    const commands = steps.slice(i * MAX_EDIT_BATCH_STEPS, (i + 1) * MAX_EDIT_BATCH_STEPS);
    const part = n > 1 ? ` (part ${i + 1} of ${n})` : "";
    out.push({ type: "batch_edits", label: `${label.slice(0, 160 - part.length)}${part}`, commands });
  }
  return out;
}

/**
 * A runner's output, checked as the server checks it: the envelope, then
 * every batch through the kernel's `commandSchema` (with the add-ons in
 * force) and every part type through the part-type schema. Refuses a
 * server-only or nested command by name, before the schema says less.
 */
export function parseScriptOutput(raw: unknown): ScriptOutput {
  const env = scriptOutputSchema.safeParse(raw);
  if (!env.success) throw new ScriptOutputError(`The script's output isn't in the kit's shape: ${env.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
  const out = env.data;
  const report = out.report ? { report: checkedReport(out.report) } : {};
  if (out.kind === "part_types") {
    return {
      kind: "part_types",
      types: out.types.map((t) => {
        const def = partTypeDefinitionSchema.safeParse(t.definition);
        if (!def.success) throw new ScriptOutputError(`Part type ${t.typeId} isn't a part-type definition: ${def.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
        return { typeId: t.typeId, definition: def.data };
      }),
      ...report,
    };
  }
  let steps = 0;
  const batches = out.batches.map((b, bi): EditBatch => {
    b.commands.forEach((step, si) => {
      const why = typeof step.type === "string" ? stepRefusal({ type: step.type }) : null;
      if (why) throw new ScriptOutputError(`Batch ${bi + 1}, step ${si + 1}: ${why}`);
    });
    const parsed = commandSchema.safeParse(b);
    if (!parsed.success) throw new ScriptOutputError(`Batch ${bi + 1} isn't a valid batch_edits: ${commandIssueMessage(parsed.error, b)}`);
    steps += b.commands.length;
    if (!isEditBatchCommand(parsed.data)) throw new ScriptOutputError(`Batch ${bi + 1} parsed as "${parsed.data.type}", not batch_edits.`);
    return { type: "batch_edits", label: b.label, commands: parsed.data.commands };
  });
  if (steps !== out.steps) throw new ScriptOutputError(`The output says ${out.steps} steps but its batches hold ${steps}.`);
  return { kind: "edits", label: out.label, steps, batches, ...report };
}

/** A runner's reports, held to the same size the kit keeps them to. */
function checkedReport(report: readonly { readonly label: string; readonly value?: unknown }[]): ScriptReport[] {
  const out = report.map((r) => ({ label: r.label, value: r.value ?? null }));
  if (jsonBytes(out) > MAX_SCRIPT_REPORT_BYTES) throw new ScriptOutputError(`The script's reports are over ${MAX_SCRIPT_REPORT_BYTES / 1024} KB.`);
  return out;
}

/** The UTF-8 size of a value's JSON. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}
