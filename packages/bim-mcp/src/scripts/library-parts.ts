import { definitionTypes, partTypeDefinitionSchema, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { globMatch } from "@permitzip/bim-script";
import type { StoredPartTypeItem } from "../host";

/**
 * The part types a host's library offers a script run, by the type id a
 * placement uses, for the ids the script's `reads.partTypes` name. Each
 * library item places one type under its key, or one per row of its part
 * model's types table, as the part library places them. Everything comes
 * from the host's own `library().partTypes()`: the open server holds no
 * firm's parts. An item whose definition no longer parses is left out, said.
 */
export function libraryPartTypesFor(items: readonly StoredPartTypeItem[], patterns: readonly string[]): Record<string, PartTypeDefinition> {
  const out: Record<string, PartTypeDefinition> = {};
  if (patterns.length === 0) return out;
  for (const { body } of items) {
    const parsed = partTypeDefinitionSchema.safeParse(body.definition);
    if (!parsed.success) {
      console.error("[bim-mcp] a library part type doesn't parse as a current part; leaving it out of the script's run", { id: body.id, issue: parsed.error.issues[0] });
      continue;
    }
    const definition = parsed.data;
    const sizes = definition.model && definition.source.kind !== "script" ? definitionTypes(definition) : [{ typeId: body.key, definition }];
    for (const size of sizes) if (patterns.some((p) => globMatch(p, size.typeId))) out[size.typeId] ??= size.definition;
  }
  return out;
}
