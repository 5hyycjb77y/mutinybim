import type { AuthorRef } from "@permitzip/bim-kernel";
import { PACK_CONTRACT_VERSION } from "@permitzip/bim-kernel/packs";
import { compareRegenerated, partDefinitionHash, partTypeItemSchema, type PartTypeItem, type RegenerateVerdict, type ScriptItem, type ScriptProvenance, type ScriptValue } from "@permitzip/bim-library";
import type { ScriptOutput } from "./output";

/** The kit's own version: recorded in every part's provenance. */
export const KIT_VERSION = "0.1.0";

export interface ProvenanceInput {
  /** The script item that ran, with its content hash set. */
  readonly script: ScriptItem;
  readonly values: Readonly<Record<string, ScriptValue>>;
  readonly preset?: string;
  /** Who asked for the run (an agent carries the person it acted for). */
  readonly generatedBy: AuthorRef;
  /** The host's clock: a script never reads one. */
  readonly generatedAt: string;
  readonly packs?: readonly string[];
  readonly sources?: ScriptProvenance["sources"];
}

/**
 * A part script's output as library `part_type` items (product decision 2):
 * the kernel's own part-type definitions, each with provenance naming the
 * script version, values, kit and contract, so it can be regenerated and an
 * installer can reproduce it. Placing one never runs the script.
 */
export function partTypeItemsFromRun(output: ScriptOutput, input: ProvenanceInput, revision = 1): PartTypeItem[] {
  if (output.kind !== "part_types") throw new Error("Only a part script's output becomes library part types.");
  const hash = input.script.contentHash;
  if (!hash) throw new Error(`Script ${input.script.key} ${input.script.version} has no content hash; load it through the library first.`);
  return output.types.map((t) => {
    // A part the kit made says which saved script version made it (its source is `script`); a hand-written definition keeps its own source.
    const definition = t.definition.source.kind === "script" ? { ...t.definition, source: { kind: "script" as const, key: input.script.key, version: input.script.version } } : t.definition;
    const provenance: ScriptProvenance = {
      script: { id: input.script.id, key: input.script.key, version: input.script.version, hash },
      values: { ...input.values },
      ...(input.preset ? { preset: input.preset } : {}),
      kitVersion: KIT_VERSION,
      kernelContract: PACK_CONTRACT_VERSION,
      packs: [...(input.packs ?? [])],
      generatedAt: input.generatedAt,
      generatedBy: input.generatedBy,
      outputHash: partDefinitionHash(definition),
      ...(input.sources ? { sources: input.sources } : {}),
    };
    return partTypeItemSchema.parse({ id: `${input.script.key}:${t.typeId}`, revision, key: t.typeId, name: `${t.definition.familyName} ${t.definition.typeName}`.slice(0, 200), definition, provenance });
  });
}

/** Regenerate: compare a fresh run with each saved part (same hash → up to date; else a new revision for review). */
export function regenerate(saved: readonly PartTypeItem[], output: ScriptOutput, input: ProvenanceInput): { readonly typeId: string; readonly verdict: RegenerateVerdict | { readonly status: "gone" } }[] {
  const fresh = new Map(partTypeItemsFromRun(output, input).map((i) => [i.key, i]));
  const out: { typeId: string; verdict: RegenerateVerdict | { readonly status: "gone" } }[] = [];
  for (const item of saved) {
    const run = fresh.get(item.key);
    if (!run?.provenance) out.push({ typeId: item.key, verdict: { status: "gone" } });
    else out.push({ typeId: item.key, verdict: compareRegenerated(item, { definition: run.definition, provenance: run.provenance }) });
  }
  return out;
}
