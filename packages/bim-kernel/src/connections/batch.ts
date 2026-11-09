import { z } from "zod";
import type { ExecuteResult } from "../command-core";
import { executeSteps } from "../commands/batch";
import { strictCommands } from "../strict-commands";
import type { ModelState } from "../types";
import { catalogCommandSchemas, executeCatalogCommand, isCatalogCommand, type CatalogCommand } from "./catalog/commands";
import { executeServiceLinkCommand, serviceLinkCommandSchemas, type ServiceLinkCommand } from "./commands";

/**
 * Several circuit, feeder and catalog edits as one: one approval, one
 * revision, one undo, all or nothing. Rebalancing a panel and applying a room
 * template to a set of units are batches; each step is the same command a
 * person or agent could send alone.
 */

export const MAX_SERVICE_BATCH_STEPS = 500;

export const serviceBatchCommandSchemas = [
  z.object({
    type: z.literal("batch_service_links"),
    /** What the batch does, in words, for the approval card and history ("Rebalance L1: move 3 circuits"). */
    label: z.string().trim().min(1).max(160),
    commands: z.array(z.discriminatedUnion("type", strictCommands([...serviceLinkCommandSchemas, ...catalogCommandSchemas]))).min(1).max(MAX_SERVICE_BATCH_STEPS),
  }),
] as const;

export type ServiceBatchCommand = z.infer<(typeof serviceBatchCommandSchemas)[number]>;

export function isServiceBatchCommand(command: { readonly type: string }): command is ServiceBatchCommand {
  return command.type === "batch_service_links";
}

export function executeServiceBatchCommand(model: ModelState, command: ServiceBatchCommand): ExecuteResult {
  return executeSteps<ServiceLinkCommand | CatalogCommand>(model, command.commands, (m, step) => (isCatalogCommand(step) ? executeCatalogCommand(m, step) : executeServiceLinkCommand(m, step)), command.label);
}
