import { elementTypeValue } from "../elements/types";
import { lineJoinRow } from "../joins/contract";
import type { BimElement, Vec2 } from "../types";
import type { HostVoidRow } from "./contract";

/**
 * The kernel's own host void rows (`kernel.host_void` built-ins): a door,
 * window or plain opening cuts the element it sits in, with every add-on
 * off. Add-ons add theirs (a skylight in a roof).
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Sill height above the host's base, mm (instance, else its type). Absent: 0 for a door, 900 for a window or anything else. */
export const OPENING_SILL_KEY = "opening.sill_mm";
const DEFAULT_SILL_MM = 900;

/** The line a host is drawn on, from its join row: any line-placed kind with joins can host an opening. */
export function hostLineOf(host: BimElement, elements: Elements): { readonly start: Vec2; readonly end: Vec2; readonly widthMm: number } | null {
  return lineJoinRow(host.kind)?.line(host, elements) ?? null;
}

function sillOf(el: BimElement & { readonly openingType: string }, elements: Elements): number {
  const v = elementTypeValue(elements, el, OPENING_SILL_KEY);
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return el.openingType === "door" ? 0 : DEFAULT_SILL_MM;
}

/**
 * Why an opening can't take this sill, or null: below the host's base, or
 * high enough that its head would stand above the top of the host. `what`
 * names it ("window W1"); `hostHeightMm` is null when the host has no height.
 */
export function openingSillProblem(what: string, sillMm: number, heightMm: number, hostName: string, hostHeightMm: number | null): string | null {
  if (!Number.isFinite(sillMm) || sillMm < 0) return `The ${what}'s sill height can't be below the bottom of ${hostName}; give 0 or more`;
  if (hostHeightMm !== null && sillMm + heightMm > hostHeightMm + 0.5) {
    return `The ${what} is ${Math.round(heightMm)} mm tall, so a ${Math.round(sillMm)} mm sill puts its head at ${Math.round(sillMm + heightMm)} mm, above the top of ${hostName} (${Math.round(hostHeightMm)} mm). Lower the sill or make the ${what} shorter`;
  }
  return null;
}

/** Walls, and any kind with a line join row (a curtain wall), host openings. */
export const OPENING_VOID_ROW: HostVoidRow = {
  kind: "opening",
  label: "Opening",
  hostKinds: ["wall"],
  voidOf(el, host, elements) {
    if (el.kind !== "opening" || el.hostId !== host.id || !hostLineOf(host, elements)) return null;
    const w = Math.max(0, el.width);
    const h = Math.max(0, el.height);
    if (w === 0 || h === 0) return null;
    const a = el.offset - w / 2;
    const b = el.offset + w / 2;
    const sill = sillOf(el, elements);
    const profile = [
      { x: a, y: sill },
      { x: b, y: sill },
      { x: b, y: sill + h },
      { x: a, y: sill + h },
    ];
    const filled = el.openingType === "door" || el.openingType === "window";
    return { elementId: el.id, hostId: host.id, profile, role: filled ? "fill" : "open" };
  },
};

export const KERNEL_HOST_VOID_ROWS: readonly HostVoidRow[] = [OPENING_VOID_ROW];
