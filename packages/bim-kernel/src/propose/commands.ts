import { z } from "zod";
import { guard, type ExecuteResult } from "../command-core";
import { executeSteps } from "../commands/batch";
import { executePartCommand, type PartCommand } from "../part-commands";
import { paramValueSchema, partTypeDefinitionSchema } from "../parts";
import type { ModelState } from "../types";

/**
 * Accepting a proposal: the devices the engineer kept, placed as one edit
 * (one approval, one revision, one undo, all or nothing). Each device is an
 * ordinary `place_part` of the type the engineer chose; nothing is connected.
 * An add-on builds the command from its own proposal (the Electrical
 * add-on's `acceptProposalCommand`).
 */

export const MAX_PLACE_DEVICES = 500;

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const PARAM_NAME = /^[a-z][a-z0-9_]{0,47}$/;

export const proposeCommandSchemas = [
  z
    .object({
      type: z.literal("place_devices"),
      /** What the edit does, in words, for the approval card and history ("Devices in Unit 001: 14 of 16 proposed"). */
      label: z.string().trim().min(1).max(160),
      levelId: idSchema,
      /** Definitions of types the model doesn't have yet, pinned on first use. */
      partTypes: z.array(z.object({ typeId: idSchema, definition: partTypeDefinitionSchema }).strict()).max(20).optional(),
      devices: z
        .array(
          z
            .object({
              /** Chosen by the sender so a retried request places the same parts. */
              partId: idSchema,
              typeId: idSchema,
              position: vec2Schema,
              rotationDeg: z.number().finite().min(-3600).max(3600).optional(),
              offsetMm: z.number().finite().min(-100_000).max(100_000).optional(),
              zone: z.string().min(1).max(40).optional(),
              mark: z.string().max(40).optional(),
              values: z.record(z.string().regex(PARAM_NAME), paramValueSchema).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_PLACE_DEVICES),
    })
    .strict(),
] as const;

export type ProposeCommand = z.infer<(typeof proposeCommandSchemas)[number]>;

export function isProposeCommand(command: { readonly type: string }): command is ProposeCommand {
  return command.type === "place_devices";
}

type PlacePart = Extract<PartCommand, { type: "place_part" }>;

export function executeProposeCommand(model: ModelState, command: ProposeCommand): ExecuteResult {
  const defs = new Map((command.partTypes ?? []).map((t) => [t.typeId, t.definition]));
  const pinned = new Set<string>();
  const steps: PlacePart[] = command.devices.map((d) => {
    const needsType = model.elements[d.typeId] === undefined && !pinned.has(d.typeId);
    const definition = needsType ? defs.get(d.typeId) : undefined;
    if (definition) pinned.add(d.typeId);
    return {
      type: "place_part",
      partId: d.partId,
      typeId: d.typeId,
      ...(definition ? { partType: definition } : {}),
      levelId: command.levelId,
      position: d.position,
      ...(d.rotationDeg !== undefined ? { rotationDeg: d.rotationDeg } : {}),
      ...(d.offsetMm !== undefined ? { offsetMm: d.offsetMm } : {}),
      ...(d.zone !== undefined ? { zone: d.zone } : {}),
      ...(d.mark !== undefined ? { mark: d.mark } : {}),
      ...(d.values !== undefined ? { values: d.values } : {}),
    };
  });
  return executeSteps<PlacePart>(model, steps, (m, step) => guard(() => executePartCommand(m, step, {})), command.label);
}
