import { definitionTypes, partGroupName, partTypeDefinitionSchema, partTypeIssues, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { FirmPartRefusal } from "@permitzip/bim-editor/contracts/bim/firm-part-versions";
import type { FirmPartLibrary, FirmPartListing } from "./capabilities";

/** A definition the firm library accepts: valid, modeled (it has a model id), every size expands. */
export function firmPartChecks(definition: PartTypeDefinition): { modelId: string; sizes: FirmPartListing["sizes"] } {
  const parsed = partTypeDefinitionSchema.safeParse(definition);
  if (!parsed.success) throw new FirmPartRefusal(`The definition doesn't fit: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 3).join("; ")}`);
  const modelId = definition.model?.id;
  if (!modelId) throw new FirmPartRefusal("Only modeled parts (made in the part editor or drafted from a cut sheet) go in the firm library");
  const issue = partTypeIssues(definition)[0];
  if (issue) throw new FirmPartRefusal(`${partGroupName(definition)}: ${issue.message}`);
  const sizes = definitionTypes(definition).map((t) => ({ typeId: t.typeId, name: t.definition.typeName }));
  return { modelId, sizes };
}

/** A firm part library held in memory (start it empty, or with the definitions a person loads). */
export function memoryFirmPartLibrary(definitions: readonly PartTypeDefinition[] = []): FirmPartLibrary {
  const rows = new Map<string, FirmPartListing & { readonly definition: PartTypeDefinition }>();
  const put = (definition: PartTypeDefinition): { status: "added" | "updated"; revision: number; modelId: string } => {
    const { modelId, sizes } = firmPartChecks(definition);
    const before = rows.get(modelId);
    const revision = (before?.revision ?? 0) + 1;
    rows.set(modelId, { modelId, partName: partGroupName(definition), category: definition.category, sizes, revision, updatedAt: new Date().toISOString(), source: definition.source ?? null, definition });
    return { status: before ? "updated" : "added", revision, modelId };
  };
  for (const definition of definitions) put(definition);
  return {
    async list(filter) {
      return [...rows.values()]
        .filter((p) => (!filter?.category || p.category === filter.category) && (!filter?.search || p.partName.toLowerCase().includes(filter.search.toLowerCase())))
        .map(({ definition: _definition, ...listing }) => listing);
    },
    async get(modelId) {
      return rows.get(modelId) ?? null;
    },
    async save(definition) {
      return put(definition);
    },
  };
}
