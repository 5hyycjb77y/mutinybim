import { createHash } from "node:crypto";
import type { BlockFreshness, BlockSnapshot, ElementId, ModelState, RenderedBlock } from "@permitzip/bim-kernel";
import { blockFreshness, blockHashInput, renderFieldBlock, sheetFieldBlocks, type BlockRenderOptions } from "../../bim-kernel/src/blocks/render";
import type { FrozenBlocks } from "../../bim-kernel/src/blocks/sheet-block";

export { blockFreshnessLabel, fieldBlockTemplateProblem, LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE } from "../../bim-kernel/src/blocks/render";
export { blockFieldChoices, type BlockFieldChoice } from "../../bim-kernel/src/blocks/fields";
export type { FrozenBlocks } from "../../bim-kernel/src/blocks/sheet-block";

/**
 * Live blocks frozen at issue (ROADMAP F5). The kernel renders a block and
 * says what its hash covers; this file hashes it and builds the snapshot an
 * issue stores. The host keeps snapshots; "changed since SD issue" is the
 * live hash against the stored one, and an issued copy draws its snapshot.
 */

export interface BlockHashOptions extends BlockRenderOptions {
  /** Library versions the model's types came from, by library id. Absent: none. */
  readonly libraryPins?: Readonly<Record<string, string>>;
}

export interface SheetBlockValue {
  readonly sheetId: ElementId;
  readonly blockId: ElementId;
  readonly title: string | null;
  readonly valueHash: string;
  readonly rendered: RenderedBlock;
}

export function blockValueHash(rendered: Pick<RenderedBlock, "text" | "unresolved">, libraryPins: Readonly<Record<string, string>> = {}): string {
  return createHash("sha256").update(blockHashInput(rendered, libraryPins)).digest("hex");
}

/** Every field block on the sheets, rendered and hashed now, sheet by sheet in the order given. */
export function sheetBlockValues(model: ModelState, sheetIds: readonly string[], opts: BlockHashOptions = {}): SheetBlockValue[] {
  const out: SheetBlockValue[] = [];
  for (const sheetId of sheetIds) {
    for (const item of sheetFieldBlocks(model, sheetId as ElementId)) {
      if (!item.block) continue;
      const rendered = renderFieldBlock(model, item.block, opts);
      out.push({ sheetId: sheetId as ElementId, blockId: item.id, title: item.block.title ?? null, valueHash: blockValueHash(rendered, opts.libraryPins), rendered });
    }
  }
  return out;
}

/** The snapshots an issue stores, one per block on the issued sheets, from the captured model. */
export function blockSnapshotsAt(model: ModelState, sheetIds: readonly string[], opts: BlockHashOptions = {}): Array<BlockSnapshot & { readonly sheetId: ElementId }> {
  return sheetBlockValues(model, sheetIds, opts).map((v) => ({ sheetId: v.sheetId, blockId: v.blockId, modelRevision: model.revision, valueHash: v.valueHash, rendered: v.rendered, libraryPins: opts.libraryPins ?? {} }));
}

/** What an issued copy draws instead of the live value. */
export function frozenBlocksFrom(snapshots: readonly Pick<BlockSnapshot, "blockId" | "rendered">[]): FrozenBlocks {
  return Object.fromEntries(snapshots.map((s) => [s.blockId, s.rendered]));
}

export interface BlockStatus extends SheetBlockValue {
  readonly freshness: BlockFreshness;
  /** The issued text when it differs from the live one. */
  readonly issuedText: string | null;
}

/** Each live block against its latest issue snapshot (absent: never issued, live). */
export function blockStatuses(live: readonly SheetBlockValue[], latest: ReadonlyMap<string, { readonly valueHash: string; readonly issueLabel: string; readonly rendered: RenderedBlock }>): BlockStatus[] {
  return live.map((v) => {
    const snap = latest.get(v.blockId) ?? null;
    const freshness = blockFreshness(v.valueHash, snap, snap?.issueLabel ?? "");
    return { ...v, freshness, issuedText: snap && freshness.state === "changed_since" ? snap.rendered.text : null };
  });
}
