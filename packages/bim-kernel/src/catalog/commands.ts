import { z } from "zod";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult, type IntentPredicate } from "../command-core";
import { TrackedReader } from "../model";
import { firstPartyStoredOwner } from "../packs/first-party/manifests";
import { packNotLoadedMessage } from "../packs/set";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";
import { catalogEntryRow, type CatalogEntryTypeRow, type CatalogEntryUse } from "./entry-point";
import { connectionFieldProblems, withConnectionFieldDefaults } from "./connection-field-point";
import { catalogElementId, catalogEntryName, catalogKey } from "./model";
import { connectionTypeSaveSchema, connectionTypeSchema, type CatalogEntry, type ServiceCatalogElement } from "./types";

/**
 * Catalog edits. Saving a record under a new name (`replaces`) renames it:
 * whatever named the old one names the new one in the same edit, as renaming
 * a type does. Deleting a record something still uses is refused with what
 * uses it. Each record type's schema, label and uses come from its row
 * (`CATALOG_ENTRY_POINT`), so the commands are the same for every type.
 */

/** Why records of `type` can't be saved here: the add-on that owns them by name when it is first-party. */
const unread = (type: string) => {
  const owner = firstPartyStoredOwner("catalog", type);
  return owner ? packNotLoadedMessage(owner) : `No add-on loaded here reads catalog records of type "${type}"`;
};

/** Any record type in force, read strictly by its row's schema (defaults filled, unknown fields dropped, as each type's own schema does). */
export const catalogEntryInputSchema = z
  .object({ type: z.string().trim().min(1).max(60) })
  .loose()
  .transform((value, ctx): CatalogEntry => {
    const row = catalogEntryRow(value.type);
    if (!row) {
      ctx.addIssue({ code: "custom", message: unread(value.type), path: ["type"] });
      return z.NEVER;
    }
    const parsed = row.schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)) });
      return z.NEVER;
    }
    return parsed.data as CatalogEntry;
  });

export const catalogCommandSchemas = [
  z.object({
    type: z.literal("save_catalog_entry"),
    entry: catalogEntryInputSchema,
    /** The name it had, when renaming ("F200" → "F225"). */
    replaces: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({
    type: z.literal("delete_catalog_entry"),
    /** A record type in force (`connection_type`, `load_policy`, or an add-on's). */
    entryType: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(80),
  }),
  /** A connection type for any trade (plumbing P01, gas K07, air, power E.05): `save_catalog_entry` with the trade said up front. */
  z.object({
    type: z.literal("save_connection_type"),
    entry: connectionTypeSaveSchema,
    replaces: z.string().trim().min(1).max(80).optional(),
  }),
] as const;

export const catalogCommandSchema = z.discriminatedUnion("type", [...catalogCommandSchemas]);
export type CatalogCommand = z.infer<typeof catalogCommandSchema>;

const CATALOG_COMMANDS: ReadonlySet<string> = new Set(catalogCommandSchemas.map((s) => s.shape.type.value));

export function isCatalogCommand(command: { readonly type: string }): command is CatalogCommand {
  return CATALOG_COMMANDS.has(command.type);
}

function rowFor(type: string): CatalogEntryTypeRow {
  const row = catalogEntryRow(type);
  if (!row) refuse("invalid_value", unread(type), []);
  return row;
}

/** What names a record, from its row. */
function usesOf(elements: Readonly<Record<string, BimElement>>, row: CatalogEntryTypeRow, name: string): readonly CatalogEntryUse[] {
  return row.references?.find(elements, catalogKey(name)) ?? [];
}

function listed(names: readonly string[]): string {
  return names.length <= 4 ? names.join(", ") : `${names.slice(0, 4).join(", ")} and ${names.length - 4} more`;
}

function record(id: ElementId, entry: CatalogEntry, row: CatalogEntryTypeRow, prior: BimElement | undefined): ServiceCatalogElement {
  const base = prior?.kind === "service_catalog" ? prior : { id, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION };
  return { ...base, id, kind: "service_catalog", trade: row.trade?.(entry) ?? "general", entry };
}

function saveEntry(model: ModelState, command: { readonly entry: CatalogEntry; readonly replaces?: string }): ExecuteResult {
  const reader = new TrackedReader(model);
  const entry = command.entry;
  const row = rowFor(entry.type);
  const what = row.label;
  const name = catalogEntryName(entry);
  const id = catalogElementId(entry.type, name);
  const current = reader.find(id);
  if (current && current.kind !== "service_catalog") refuse("already_exists", `${id} is already used by another element`, [id]);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [id];
  const authored: AuthoredWrite[] = [{ elementId: id, field: "catalog", value: canonicalJson(entry) }];
  const removedIds: ElementId[] = [];
  const renaming = command.replaces !== undefined && catalogKey(command.replaces) !== catalogKey(name);
  if (renaming && command.replaces !== undefined) {
    const oldId = catalogElementId(entry.type, command.replaces);
    const old = reader.find(oldId);
    if (old?.kind !== "service_catalog") refuse("element_not_found", `There is no ${what.toLowerCase()} ${command.replaces} to rename`, [oldId]);
    if (current) refuse("already_exists", `${what} ${name} already exists; pick another name or edit that one`, [id]);
    delete working[oldId];
    removedIds.push(oldId);
    for (const use of usesOf(model.elements, row, command.replaces)) {
      const renamed = row.references?.rename(reader.get(use.id), name);
      if (!renamed) continue;
      working[use.id] = renamed.element;
      if (renamed.authored) authored.push({ elementId: use.id, field: renamed.authored.field, value: renamed.authored.value });
      touched.push(use.id);
    }
  } else if (current?.kind === "service_catalog" && catalogKey(catalogEntryName(current.entry)) !== catalogKey(name)) {
    refuse("already_exists", `${id} holds ${catalogEntryName(current.entry)}`, [id]);
  }
  working[id] = record(id, entry, row, current);
  const fingerprint = canonicalJson(entry);
  const intents = (): IntentPredicate[] => [{ kind: "field_equals", elementId: id, field: "catalog", value: fingerprint }];
  const summary = [`${renaming ? `Renamed ${command.replaces} to ${name}` : current ? `Changed ${what.toLowerCase()} ${name}` : `Added ${what.toLowerCase()} ${name}`}${touched.length > 1 ? ` (${touched.length - 1} using it follow)` : ""}`];
  return finish(reader, working, touched, authored, intents, { removedIds, summary });
}

function deleteEntry(model: ModelState, command: Extract<CatalogCommand, { type: "delete_catalog_entry" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const row = rowFor(command.entryType);
  const id = catalogElementId(command.entryType, command.name);
  const el = reader.find(id);
  if (el?.kind !== "service_catalog") refuse("element_not_found", `There is no ${row.label.toLowerCase()} ${command.name}`, [id]);
  const uses = usesOf(model.elements, row, command.name);
  if (uses.length > 0) {
    for (const u of uses) reader.get(u.id);
    const names = uses.map((u) => u.name);
    refuse("in_use", `${row.label} ${command.name} is used by ${uses.length === 1 ? names[0] : `${uses.length} ${row.references?.plural ?? "elements"}: ${listed(names)}`}; change ${uses.length === 1 ? "it" : "them"} first`, uses.slice(0, 20).map((u) => u.id));
  }
  const working = draftElements(model.elements);
  delete working[id];
  return finish(reader, working, [], [], () => [], { removedIds: [id], summary: [`Deleted ${row.label.toLowerCase()} ${command.name}`] });
}

export function executeCatalogCommand(model: ModelState, command: CatalogCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "save_catalog_entry":
        return saveEntry(model, command);
      case "save_connection_type": {
        // Defaults fill the fields a trade doesn't use (an add-on's, from its rows in force), however the command arrived.
        const parsed = connectionTypeSchema.safeParse({ ...command.entry, type: "connection_type" });
        if (!parsed.success) refuse("invalid_value", `Connection type ${command.entry.designator}: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? "is not valid"}`.replace(/\s+/g, " "), []);
        const problem = connectionFieldProblems(parsed.data)[0];
        if (problem !== undefined) refuse("invalid_value", `Connection type ${command.entry.designator}: ${problem}`, []);
        return saveEntry(model, { entry: withConnectionFieldDefaults(parsed.data), ...(command.replaces ? { replaces: command.replaces } : {}) });
      }
      case "delete_catalog_entry":
        return deleteEntry(model, command);
    }
  });
}
