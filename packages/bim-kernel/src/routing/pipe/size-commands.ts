import { z } from "zod";
import { refuse, type ExecuteResult } from "../../command-core";
import type { Command } from "../../commands";
import { asElementId, type ModelState } from "../../types";
import { Chain } from "../connect-commands";
import { runLabel } from "../validate";

/**
 * `set_pipe_sizes` applies a set of pipe sizes to one system as a single
 * edit (one undo, one approval): the sizes a sizing proposal suggests
 * (plumbing.gas_system). Pipes asking for the same size go through one
 * `resize_stretch`, so the elbows between them follow and a reducer is
 * placed wherever a neighbour keeps another size, exactly as when a person
 * resizes a stretch by hand. A reducer that doesn't fit the pipe beside it
 * refuses the whole edit with the reason.
 */

const idSchema = z.string().min(1).max(200);

export const pipeSizeCommandSchemas = [
  z.object({
    type: z.literal("set_pipe_sizes"),
    /** New reducers are this prefix plus -1-f1, -2-f1… (a retried request makes the same ids). */
    idPrefix: z.string().min(1).max(80),
    systemId: idSchema,
    /** What the edit does, in words, for the approval card and history. */
    label: z.string().trim().min(1).max(160).optional(),
    sizes: z
      .array(z.object({ segmentId: idSchema, nominalIn: z.number().finite().positive().max(48) }))
      .min(1)
      .max(500),
  }),
] as const;

export type PipeSizeCommand = z.infer<(typeof pipeSizeCommandSchemas)[number]>;

export function isPipeSizeCommand(command: { type: string }): command is PipeSizeCommand {
  return command.type === "set_pipe_sizes";
}

const IN = 25.4;

export function inchLabel(v: number): string {
  const whole = Math.floor(v + 1e-9);
  const frac = Math.round((v - whole) * 8);
  const names: Readonly<Record<number, string>> = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" };
  if (frac === 0) return `${whole}"`;
  return whole === 0 ? `${names[frac]}"` : `${whole}-${names[frac]}"`;
}

export function executePipeSizeCommand(model: ModelState, command: PipeSizeCommand, exec: (model: ModelState, command: Command) => ExecuteResult): ExecuteResult {
  const system = model.elements[command.systemId];
  if (system?.kind !== "mep_system" || system.domain !== "pipe") refuse("element_not_found", `There is no pipe system ${command.systemId}`, []);
  const seen = new Set<string>();
  for (const s of command.sizes) {
    if (seen.has(s.segmentId)) refuse("invalid_value", `${s.segmentId} is listed twice`, [asElementId(s.segmentId)]);
    seen.add(s.segmentId);
    const seg = model.elements[s.segmentId];
    if (seg?.kind !== "run_segment" || seg.size.shape !== "pipe") refuse("element_not_found", `${s.segmentId} isn't a pipe`, [asElementId(s.segmentId)]);
    if (seg.systemId !== system.id) refuse("invalid_value", `${runLabel(model.elements, seg)} is on another system`, [seg.id]);
  }
  const groups = new Map<number, string[]>();
  for (const s of command.sizes) {
    const seg = model.elements[s.segmentId];
    if (seg?.kind !== "run_segment" || seg.size.shape !== "pipe") continue;
    const nominalMm = Math.round(s.nominalIn * IN * 1000) / 1000;
    if (Math.abs(seg.size.nominalMm - nominalMm) < 0.01) continue;
    groups.set(nominalMm, [...(groups.get(nominalMm) ?? []), s.segmentId]);
  }
  if (groups.size === 0) refuse("invalid_value", `Every pipe listed on ${system.name} is already that size`, []);
  const chain = new Chain(model, exec);
  let changed = 0;
  let k = 0;
  for (const [nominalMm, ids] of [...groups.entries()].sort((a, b) => b[0] - a[0])) {
    k += 1;
    const first = chain.current.elements[ids[0] ?? ""];
    if (first?.kind !== "run_segment" || first.size.shape !== "pipe") continue;
    chain.run({ type: "resize_stretch", idPrefix: `${command.idPrefix}-${k}`, segmentIds: ids, size: { ...first.size, nominalMm } }, `Making ${ids.length === 1 ? `the ${runLabel(chain.current.elements, first)}` : `${ids.length} pipes`} ${inchLabel(nominalMm / IN)}`);
    changed += ids.length;
  }
  return chain.result(command.label ?? `Resized ${changed} pipe${changed === 1 ? "" : "s"} on ${system.name}`);
}
