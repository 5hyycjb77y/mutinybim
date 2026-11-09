import { elementsOfKind, serviceOf, type Command, type ModelState } from "@permitzip/bim-kernel";
import type { CalcRegistry, RunRequest } from "@permitzip/bim-calc";
import type { GasSystemSizing } from "./gas-system";
import { pipeSizingService, systemSizingMode, type PipeSystemSizing } from "./system-sizing";

/**
 * Auto-sizing: for every pipe system whose sizing mode resolves to "auto"
 * (its own setting, else the project's; never on by default), the sizes its
 * calc proposes, as `set_pipe_sizes` edits: ordinary commands, one per
 * system, each its own undo. Systems in "check" are never touched; their
 * findings stay findings.
 *
 * The caller runs this after an edit lands (a route, a fixture or load
 * change) and sends what it returns; an edit that was itself a sizing or an
 * undo doesn't call it, so auto-sizing never fights the person. Sizing the
 * same model twice proposes nothing the second time.
 */

export interface AutoSizeEdit {
  readonly command: Extract<Command, { type: "set_pipe_sizes" }> & { readonly label: string };
  readonly systemId: string;
  readonly systemName: string;
  readonly count: number;
}

export interface AutoSizePlan {
  readonly edits: readonly AutoSizeEdit[];
  /** Systems set to auto that couldn't be sized, and why (no code edition, no curve, nothing fits). */
  readonly skipped: readonly AutoSizeSkip[];
}

export interface AutoSizeSkip {
  readonly systemId: string;
  readonly systemName: string;
  readonly reason: string;
  /** `no_code_edition`: neither the project's Code Study nor the request names the plumbing / fuel gas code. */
  readonly cause: "no_code_edition" | "not_sized";
}

export type AutoSizeRequest = Omit<RunRequest, "calc" | "inputs" | "model">;

/** Commands that are themselves sizing or history: auto-sizing doesn't follow them. */
export function isAutoSizeExempt(commandType: string): boolean {
  return commandType === "set_pipe_sizes" || commandType === "undo" || commandType === "redo";
}

function isPipeSizing(v: unknown): v is PipeSystemSizing {
  return typeof v === "object" && v !== null && "service" in v && "proposals" in v;
}

function isGasSizing(v: unknown): v is GasSystemSizing {
  return typeof v === "object" && v !== null && "zones" in v && "proposals" in v;
}

/** The auto-sizing edits for `model` now. `systemIds` limits it to the systems an edit touched. */
export function planAutoSize(registry: CalcRegistry, model: ModelState, request: AutoSizeRequest, options: { readonly idPrefix: string; readonly systemIds?: readonly string[] }): AutoSizePlan {
  const only = options.systemIds ? new Set(options.systemIds) : null;
  const edits: AutoSizeEdit[] = [];
  const skipped: AutoSizeSkip[] = [];
  let k = 0;
  for (const system of elementsOfKind(model.elements, "mep_system")) {
    if (system.domain !== "pipe" || (only && !only.has(system.id))) continue;
    if (systemSizingMode(model, system).mode !== "auto") continue;
    const gas = serviceOf(system.systemKind) === "gas";
    // A system nothing sizes yet (vent, storm, hydronic) or with no pipe drawn is not an auto-sizing failure.
    if (!gas && typeof pipeSizingService(system.systemKind) !== "string") continue;
    if (!elementsOfKind(model.elements, "run_segment").some((s) => s.systemId === system.id)) continue;
    const calc = gas ? "plumbing.gas_system" : "plumbing.size_system";
    const r = registry.run({ ...request, calc, inputs: { system_id: system.id }, model });
    if (!r.ok) {
      skipped.push({ systemId: system.id, systemName: system.name, reason: r.reason, cause: registry.resolvesCode(calc, request) ? "not_sized" : "no_code_edition" });
      continue;
    }
    const detail = r.run.detail;
    const changes = isPipeSizing(detail)
      ? detail.proposals.filter((p) => p.change !== "same").map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn }))
      : isGasSizing(detail)
        ? detail.proposals.filter((p) => p.change !== "same").map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn }))
        : null;
    if (changes === null) {
      const why = r.run.issues.find((i) => i.severity === "error")?.message;
      if (why) skipped.push({ systemId: system.id, systemName: system.name, reason: why, cause: "not_sized" });
      continue;
    }
    if (changes.length === 0) continue;
    k += 1;
    edits.push({
      command: { type: "set_pipe_sizes", idPrefix: `${options.idPrefix}-${k}`, systemId: system.id, label: `Auto-sized ${changes.length} pipe${changes.length === 1 ? "" : "s"} on ${system.name}`.slice(0, 160), sizes: changes },
      systemId: system.id,
      systemName: system.name,
      count: changes.length,
    });
  }
  return { edits, skipped };
}

/** The pipe systems an edit touched: the systems of the pipes it changed, or every pipe system when it changed a fixture, a load point or a setting (loads and modes reach across systems). */
export function systemsTouched(before: ModelState, after: ModelState, changedIds: readonly string[]): readonly string[] | undefined {
  const out = new Set<string>();
  for (const id of changedIds) {
    const el = after.elements[id] ?? before.elements[id];
    if (!el) continue;
    if ((el.kind === "run_segment" || el.kind === "run_fitting") && el.domain === "pipe") out.add(el.systemId);
    else if (el.kind === "mep_system") out.add(el.id);
    else if (el.kind === "part" || el.kind === "part_type" || el.kind === "load_point" || el.kind === "service_catalog") return undefined;
  }
  return [...out];
}
