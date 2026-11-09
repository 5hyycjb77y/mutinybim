import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ElementId, Vec2 } from "../types";
import { KERNEL_HOST_VOID_ROWS } from "./rows";

/**
 * Host voids (contract 1.11.0, `kernel.host_void` v1).
 *
 * A hosted kind cuts a void in its host and may fill it: a door or window in
 * a wall, a skylight or hatch in a roof, a shaft in a slab, a sleeve through
 * a wall. The profile is in host coordinates (`along` from the host's start,
 * `up` from its base); depth defaults to the host's thickness. A void with
 * no filler is a plain opening. Hosts' solids, plan gaps and net areas read
 * voids through `voidsOf`.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface HostVoid {
  readonly elementId: ElementId;
  readonly hostId: ElementId;
  /** Closed profile in host coordinates (x = along, y = up), mm. */
  readonly profile: readonly Vec2[];
  /** mm; absent: through the host. */
  readonly depthMm?: number;
  /** `fill`: the hosted element fills it (door, window); `open`: an opening with nothing in it. */
  readonly role: "fill" | "open";
}

export interface HostVoidRow {
  /** The hosted kind (`opening`, `zz.skylight`). One row per kind. */
  readonly kind: string;
  readonly label: string;
  /** Host kinds it may sit in (`wall`, `slab`, `zz.roof`). */
  readonly hostKinds: readonly string[];
  /** The void one record cuts, or null when it cuts none (not hosted yet, or a surface-mounted part). */
  voidOf(el: BimElement, host: BimElement, elements: Elements): HostVoid | null;
}

export const HOST_VOID_POINT = defineExtensionPoint<HostVoidRow>({
  id: "kernel.host_void",
  version: 1,
  label: "Host voids",
  idOf: (row) => row.kind,
  builtins: () => KERNEL_HOST_VOID_ROWS,
});

/** Problems with host void rows (pack conformance), in words. */
export function hostVoidRowProblems(rows: readonly HostVoidRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.kind)) out.push(`host void ${row.kind} is declared twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`host void ${row.kind} has no label`);
    if (row.hostKinds.length === 0) out.push(`host void ${row.kind} names no host kind`);
    if (typeof row.voidOf !== "function") out.push(`host void ${row.kind}: voidOf must be a function`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, HostVoidRow> => new Map(set.items(HOST_VOID_POINT).map((r) => [r.kind, r] as const));

export function hostVoidRow(kind: string): HostVoidRow | null {
  return activePackSet().memo("kernel.host_void#table", tableOf).get(kind) ?? null;
}
