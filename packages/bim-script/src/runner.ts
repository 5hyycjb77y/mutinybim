import type { ScriptManifest, ScriptValue } from "@permitzip/bim-library";
import type { ModelSlice } from "./slice";

/**
 * Where scripts run (SCRIPTING-PROPOSAL §5.2). The kit defines the contract;
 * each harness supplies a runner (a laptop's own process, a hosted code
 * sandbox, a host's cloud sandbox adapter). Scripts never run in a
 * MutinyBIM model server or MCP server process, and never in the host app's
 * server process: servers only receive output JSON and re-parse it.
 *
 * Every runner meets the contract, checked by `runRunnerConformance`: a
 * fresh process per run; no network; no file access beyond the kit and the
 * run's input; no child processes; memory, wall-clock and output caps no
 * larger than these. A run that hits a cap says which, and is not retried
 * unchanged.
 */
export const RUNNER_CONTRACT = {
  memoryMb: 1024,
  wallMs: 30_000,
  outputBytes: 2 * 1024 * 1024,
} as const;

export interface RunnerLimits {
  readonly memoryMb: number;
  readonly wallMs: number;
  readonly outputBytes: number;
}

export interface ScriptRunRequest {
  /** The module's source (imports only the kit; default export is `defineScript(...)`). */
  readonly source: string;
  /** The script item's content hash: seeds ids and randomness. */
  readonly scriptHash: string;
  /** Stored values (quantities in SI), checked against the manifest by the kit. */
  readonly values: Readonly<Record<string, ScriptValue>>;
  readonly slice: ModelSlice;
}

export type RunnerFailureCode =
  /** Over the memory cap. */
  | "cap_memory"
  /** Over the wall-clock cap. */
  | "cap_time"
  /** Output larger than the cap. */
  | "cap_output"
  /** The script threw (a refused step, a read beyond its slice, its own error): `message` says what. */
  | "script_error"
  /** The runner couldn't start or finish the run (its own fault, not the script's). */
  | "runner_error";

export type ScriptRunResult =
  /** `manifest`: the script's own (what `defineScript` declared), when the runner reports it; a host checks it before saving the script. */
  | { readonly ok: true; readonly output: unknown; readonly bytes: number; readonly ms: number; readonly manifest?: ScriptManifest }
  | { readonly ok: false; readonly code: RunnerFailureCode; readonly message: string; readonly ms: number };

export interface ScriptRunner {
  /** Stable id (`laptop`, `vercel-sandbox`, `acme-container`). */
  readonly id: string;
  readonly limits: RunnerLimits;
  run(request: ScriptRunRequest): Promise<ScriptRunResult>;
}

/** Words for a failed run, for the agent and the person. */
export function runFailureWords(result: Extract<ScriptRunResult, { ok: false }>, limits: RunnerLimits): string {
  switch (result.code) {
    case "cap_memory":
      return `The script used more than ${limits.memoryMb} MB, so it was stopped. Make it read less or build less at once; running it again unchanged will stop the same way.`;
    case "cap_time":
      return `The script ran longer than ${Math.round(limits.wallMs / 1000)} s, so it was stopped. Running it again unchanged will stop the same way.`;
    case "cap_output":
      return `The script's output was over ${Math.round(limits.outputBytes / 1024)} KB, so it was not kept. Split the work into smaller runs.`;
    case "script_error":
      return `The script stopped: ${result.message}`;
    case "runner_error":
      return `The script couldn't be run here: ${result.message.replace(/[.\s]+$/, "")}. That is the script machine, not a mistake in the script, so don't rewrite the script: run it once more as it is, and if it fails the same way tell the person.`;
  }
}
