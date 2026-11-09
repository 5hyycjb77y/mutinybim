import { z } from "zod";
import { createCommandSchemas } from "@permitzip/bim-kernel";
import { commandFamily } from "./describe-commands";

/**
 * The `architecture` command family on `bim_set_element` (no new tool): draw
 * walls corner to corner (`create_elements`, closed for a room), one wall,
 * floor, roof, stair, grid line or reference plane (`create_element`), or put
 * a door, window or opening in a wall (`create_hosted`). Lengths in
 * millimetres. The short form is advertised; the full schema is read with
 * `bim_describe_commands`. The kernel's own schemas decide what is accepted.
 */

export const ARCHITECTURE_COMMAND_SCHEMA = z.discriminatedUnion("type", [...createCommandSchemas]);

export const ARCHITECTURE_FAMILY = commandFamily({
  tool: "bim_set_element",
  field: "architecture",
  label: "Draw walls (a closed chain makes a room), one floor, roof, stair, grid line or reference plane, or put a door, window or opening in a wall. Millimetres.",
  schema: ARCHITECTURE_COMMAND_SCHEMA,
  discriminator: "type",
});

/** The short form the tool advertises: any object, checked against the full schema when built. */
export const ARCHITECTURE_SHORT_FORM = z.record(z.string(), z.unknown()).optional().describe("Draw walls, doors: bim_describe_commands");

/** The command as the kernel reads it, or the first thing wrong with it in words. */
export function architectureCommand(raw: Readonly<Record<string, unknown>>): { readonly ok: true; readonly command: z.infer<typeof ARCHITECTURE_COMMAND_SCHEMA> } | { readonly ok: false; readonly message: string } {
  const parsed = ARCHITECTURE_COMMAND_SCHEMA.safeParse(raw);
  if (parsed.success) return { ok: true, command: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: issue ? `architecture.${issue.path.join(".")}: ${issue.message}` : "The architecture command doesn't read" };
}
