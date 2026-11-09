import { z } from "zod";
import { scriptManifestSchema } from "@permitzip/bim-library";
import { scriptOutputSchema } from "./output";

/**
 * JSON Schemas of the kit's two contracts, for a later builder in another
 * language (Python: JSON only, checked by the kit's `checkScriptOutput`).
 * The output's batches and part types are the kernel's own schemas, checked
 * on parse; here they are open objects.
 */
export function scriptJsonSchemas(): { readonly manifest: unknown; readonly output: unknown } {
  return { manifest: z.toJSONSchema(scriptManifestSchema, { io: "input", unrepresentable: "any" }), output: z.toJSONSchema(scriptOutputSchema, { io: "input", unrepresentable: "any" }) };
}
