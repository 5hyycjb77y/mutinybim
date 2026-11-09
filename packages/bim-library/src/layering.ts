import type { LibraryItem, LibraryItemType } from "./schema";

/**
 * Layering (SCHEDULES-PLAN §3a): model-pinned copies, then the project's
 * library, then the firm's, then the built-in one. The first layer holding an
 * item id wins, and so does the first holding a key (two different items
 * both calling themselves `PZ.GasDemandBtuh`): a project can override a firm
 * calculation, and a model keeps the copy it was drawn with.
 */

export const LAYER_KINDS = ["model", "project", "firm", "builtin"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

export interface LibraryLayer {
  readonly kind: LayerKind;
  /** e.g. `model`, `project:7301`, `firm:permitzip`, `builtin`. */
  readonly scope: string;
  readonly items: readonly LibraryItem[];
}

export interface ResolvedItem {
  readonly item: LibraryItem;
  readonly scope: string;
  readonly layer: LayerKind;
  /** Lower layers' copies this one hides (same id, or same key). */
  readonly shadows: readonly { readonly scope: string; readonly id: string; readonly revision: number }[];
}

export interface ResolvedLibrary {
  readonly items: readonly ResolvedItem[];
  byId(id: string): ResolvedItem | undefined;
  byKey(type: LibraryItemType, key: string): ResolvedItem | undefined;
  ofType<T extends LibraryItemType>(type: T): readonly (ResolvedItem & { readonly item: Extract<LibraryItem, { type: T }> })[];
}

export function itemKey(item: LibraryItem): string {
  return item.body.key;
}

const typeKey = (type: LibraryItemType, key: string) => `${type}\u0000${key}`;

/** Resolves layers in precedence order (by kind, whatever order they are passed in). */
export function resolveLayers(layers: readonly LibraryLayer[]): ResolvedLibrary {
  const ordered = [...layers].sort((a, b) => LAYER_KINDS.indexOf(a.kind) - LAYER_KINDS.indexOf(b.kind));
  const byId = new Map<string, { entry: ResolvedItem; shadows: ResolvedItem["shadows"][number][] }>();
  const byKey = new Map<string, string>();
  const order: string[] = [];
  for (const layer of ordered) {
    for (const item of layer.items) {
      const id = item.body.id;
      const key = typeKey(item.type, itemKey(item));
      const winnerId = byId.has(id) ? id : byKey.get(key);
      const winner = winnerId === undefined ? undefined : byId.get(winnerId);
      if (winner) {
        winner.shadows.push({ scope: layer.scope, id, revision: item.body.revision });
        continue;
      }
      const shadows: ResolvedItem["shadows"][number][] = [];
      byId.set(id, { entry: { item, scope: layer.scope, layer: layer.kind, shadows }, shadows });
      byKey.set(key, id);
      order.push(id);
    }
  }
  const items: ResolvedItem[] = [];
  for (const id of order) {
    const e = byId.get(id);
    if (e) items.push(e.entry);
  }
  return {
    items,
    byId: (id) => byId.get(id)?.entry,
    byKey: (type, key) => {
      const id = byKey.get(typeKey(type, key));
      return id === undefined ? undefined : byId.get(id)?.entry;
    },
    ofType: <T extends LibraryItemType>(type: T) => items.filter((r): r is ResolvedItem & { readonly item: Extract<LibraryItem, { type: T }> } => r.item.type === type),
  };
}
