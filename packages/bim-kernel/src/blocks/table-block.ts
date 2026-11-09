import { defineExtensionPoint } from "../packs/contract";
import { firstPartyStoredOwner } from "../packs/first-party/manifests";
import { activePackSet } from "../packs/scope";
import { packNotLoadedMessage } from "../packs/set";
import type { ModelState } from "../types";
import type { BlockTableKind, BlockTableSpec } from "./table-spec";
import type { RenderedBlock } from "./types";
import { renderKeynotesTable } from "../annotation/keynotes";

/**
 * What renders one computed table kind on a field block (v1), from the pack
 * that owns the kind: its default title and its renderer. The kinds are
 * stored (`BlockTableSpec.kind`), so ids are bare.
 */
export interface BlockTableDef {
  readonly kind: string;
  readonly title: string;
  render(model: Pick<ModelState, "elements">, table: BlockTableSpec): RenderedBlock;
}

export const BLOCK_TABLE_POINT = defineExtensionPoint<BlockTableDef>({ id: "kernel.block_table", version: 1, label: "Block tables", idOf: (t) => t.kind, namespaced: false });

function tableDef(kind: string): BlockTableDef | null {
  const set = activePackSet();
  return set.memo("kernel.block_table#table", () => new Map(set.items(BLOCK_TABLE_POINT).map((t) => [t.kind, t] as const))).get(kind) ?? null;
}

/** A computed table's value (table-spec.ts): its kind's renderer in the set in force; with none, it says which add-on is missing. */
export function renderTableBlock(model: Pick<ModelState, "elements">, table: BlockTableSpec): RenderedBlock {
  // Keynotes are the kernel's own (every trade's); the other kinds belong to their add-ons.
  if (table.kind === "keynotes") return renderKeynotesTable(model, table);
  const def = tableDef(table.kind);
  if (def) return def.render(model, table);
  const owner = firstPartyStoredOwner("table", table.kind);
  console.error("[bim-kernel/blocks] no pack in this model's set renders this table kind", { kind: table.kind, owner });
  return { text: owner ? packNotLoadedMessage(owner) : `No add-on in this model draws ${table.kind} tables`, unresolved: [table.kind], dependsOn: [] };
}

/** The title a placed table gets by default. */
export function blockTableTitle(kind: BlockTableKind): string {
  if (kind === "keynotes") return "KEYNOTES";
  return tableDef(kind)?.title ?? kind.toUpperCase();
}
