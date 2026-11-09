import { z } from "zod";
import { ScriptOutputError, parseScriptOutput, type ScriptRunResult } from "@permitzip/bim-script";
import { scriptManifestSchema } from "@permitzip/bim-library";

/**
 * The runner's one JSON line, as a host reads it back. Nothing the runner
 * prints is trusted as is: the shape is checked here and the output is
 * re-parsed with the kit's `parseScriptOutput`.
 */
export const RUNNER_RESULT_SCHEMA = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), output: z.unknown(), manifest: z.unknown().optional(), bytes: z.number().int().min(0), ms: z.number().min(0) }),
  z.object({ ok: z.literal(false), code: z.enum(["cap_memory", "cap_time", "cap_output", "script_error", "runner_error"]), message: z.string().max(4000), ms: z.number().min(0) }),
]);

export type RunnerResultLine = z.infer<typeof RUNNER_RESULT_SCHEMA>;

/** A checked runner line as the kit's run result: the output re-parsed, the manifest kept only when it is one. */
export function toScriptRunResult(line: RunnerResultLine, ms: () => number): ScriptRunResult {
  if (!line.ok) return line;
  const manifest = scriptManifestSchema.safeParse(line.manifest);
  try {
    return { ok: true, output: parseScriptOutput(line.output), bytes: line.bytes, ms: line.ms, ...(manifest.success ? { manifest: manifest.data } : {}) };
  } catch (err) {
    if (err instanceof ScriptOutputError) return { ok: false, code: "script_error", message: err.message, ms: ms() };
    throw err;
  }
}
