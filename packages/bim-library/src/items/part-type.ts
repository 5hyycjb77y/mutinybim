import { z } from "zod";
import { canonicalJson, sha256HexOf, storedPartTypeDefinitionSchema, type StoredPartTypeDefinition } from "@permitzip/bim-kernel";
import { contentHash, isoTime, itemBase, semver, text } from "../item-base";
import { authorRefSchema, scriptValueSchema } from "./script";

/**
 * The `part_type` library item (round 11 X11; SCRIPTING-PROPOSAL §5.4): the
 * kernel's own part-type definition, content-hashed and pinned like every
 * other item, with provenance when a script made it. Placing it copies the
 * definition into the model (`save_part_types`); nothing runs.
 *
 * Provenance sits on the item, beside the definition: the definition's own
 * `source` (built-in, cut sheet, IFC…) is the kernel's closed stored union
 * and stays as written, so every reader of a placed part reads it as before.
 * A part type with no provenance (drawn in the part editor, imported) is a
 * plain item.
 */

export const PART_TYPE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const scriptProvenanceSchema = z.object({
  /** The script version that made it: its library id and key, semver version and content hash. */
  script: z.object({ id: text(200), key: text(120), version: semver, hash: contentHash }),
  /** Every parameter value it ran with (quantities in SI). */
  values: z.record(z.string().max(48), scriptValueSchema),
  /** The preset those values came from, when one did. */
  preset: text(64).optional(),
  /** The kit and kernel contract versions it ran under: a regeneration compares outputs only meaningfully within them. */
  kitVersion: semver,
  kernelContract: semver,
  /** Add-ons it needed (`mutinybim.plumbing@1.2.0`). */
  packs: z.array(text(120)).max(50).default([]),
  generatedAt: isoTime,
  generatedBy: authorRefSchema,
  /** `partDefinitionHash` of the definition the run produced: what "up to date" compares. */
  outputHash: contentHash,
  /** Documents it was made from (a cut sheet), by name only. */
  sources: z.array(z.object({ kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), title: text(300) })).max(20).optional(),
});
export type ScriptProvenance = z.infer<typeof scriptProvenanceSchema>;
export type ScriptProvenanceInput = z.input<typeof scriptProvenanceSchema>;

export const partTypeItemSchema = z.object({
  ...itemBase,
  /** The type id it saves under (`save_part_types` `typeId`). */
  key: z.string().regex(PART_TYPE_KEY_PATTERN, "a part type id"),
  name: text(200),
  definition: storedPartTypeDefinitionSchema,
  provenance: scriptProvenanceSchema.optional(),
});
export type PartTypeItem = z.infer<typeof partTypeItemSchema>;

/** SHA-256 of a part-type definition's canonical JSON: the same definition hashes the same in every host. */
export function partDefinitionHash(definition: StoredPartTypeDefinition): string {
  return `sha256:${sha256HexOf(canonicalJson(definition))}`;
}

export type RegenerateVerdict =
  /** The script, with these values, still makes exactly this part type. */
  | { readonly status: "up_to_date"; readonly outputHash: string }
  /**
   * It now makes something else: `next` is the new revision, for the update
   * review (parameters, connectors, geometry before and after). `because`
   * says what moved (the values, the script, the kit or the contract), so the
   * review can tell a kit upgrade from a real change.
   */
  | { readonly status: "changed"; readonly next: PartTypeItem; readonly outputHash: string; readonly because: readonly string[] }
  /** Drawn or imported, not made by a script: nothing to regenerate from. */
  | { readonly status: "not_from_script" };

/**
 * Compares a fresh run's output with a saved part type. Same output hash:
 * up to date (the saved item is untouched, whatever the run's time).
 * Different: a new revision carrying the new definition and provenance,
 * never applied by itself.
 */
export function compareRegenerated(saved: PartTypeItem, run: { readonly definition: StoredPartTypeDefinition; readonly provenance: ScriptProvenance }): RegenerateVerdict {
  const was = saved.provenance;
  if (!was) return { status: "not_from_script" };
  const outputHash = partDefinitionHash(run.definition);
  if (run.provenance.outputHash !== outputHash) throw new Error(`The run's provenance names output ${run.provenance.outputHash}, but its definition hashes to ${outputHash}.`);
  if (outputHash === was.outputHash && outputHash === partDefinitionHash(saved.definition)) return { status: "up_to_date", outputHash };
  const now = run.provenance;
  const because: string[] = [];
  if (canonicalJson(now.values) !== canonicalJson(was.values)) because.push("different values");
  if (now.script.hash !== was.script.hash) because.push(`script ${was.script.version} → ${now.script.version}`);
  if (now.kitVersion !== was.kitVersion) because.push(`kit ${was.kitVersion} → ${now.kitVersion}`);
  if (now.kernelContract !== was.kernelContract) because.push(`contract ${was.kernelContract} → ${now.kernelContract}`);
  if (because.length === 0) because.push(partDefinitionHash(saved.definition) === was.outputHash ? "the same script and values now make a different part" : "the saved part was edited after it was made");
  const { contentHash: _old, ...rest } = saved;
  return { status: "changed", outputHash, because, next: { ...rest, revision: saved.revision + 1, definition: run.definition, provenance: run.provenance } };
}
