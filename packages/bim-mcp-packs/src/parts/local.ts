import type { PartTypeDefinition } from "@permitzip/bim-kernel";
import type { FirmPartEntry, FirmPartsSource } from "./capabilities";

/**
 * A firm part library held in memory, keyed by each definition's model id:
 * what a local server reads when it has no firm library of its own (start it
 * empty, or with the definitions a person loads).
 */
export function memoryFirmParts(definitions: readonly PartTypeDefinition[] = []): FirmPartsSource & { add(definition: PartTypeDefinition): void } {
  const rows = new Map<string, FirmPartEntry>();
  const add = (definition: PartTypeDefinition) => {
    const modelId = definition.model?.id;
    if (!modelId) throw new Error(`${definition.typeName}: only a modeled part (it has a model id) goes in the firm library.`);
    rows.set(modelId, { definition });
  };
  for (const definition of definitions) add(definition);
  return {
    add,
    async get(modelId) {
      return rows.get(modelId) ?? null;
    },
  };
}
