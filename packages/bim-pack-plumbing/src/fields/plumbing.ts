import { connectionTypeOf, connectionTypeOfLoadPoint, loadPointQuantities, loadPointsOfPart, partConnectionTypeName, primaryQuantity, CONNECTION_SIZE_KEYS, isQuantityKey, mergeBags, type QuantityBag, type QuantityKey } from "@permitzip/bim-kernel";
import { PlumbingNetworkEngine } from "../load-points/engine";
import type { ModelState, BimElement, FieldPathInfo } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Plumbing field paths for schedules, tags, diagrams and agent tools (the
 * shared resolver delegates here, fields/resolver.ts):
 *
 * - On a load point, or a fixture attached to one (or naming a connection
 *   type): `load.<quantity>` (`load.wsfu_total`, `load.dfu`, `load.mbh`…),
 *   `load.size.<cw|hw|w|v|g>`, `load.custom.<name>`, `connection_type.mark`,
 *   `connection_type.description`.
 * - On a pipe (segment or fitting): `pipe.carries.<quantity>`, what it carries
 *   in its system's quantity (DFU on sanitary, WSFU on water, MBH on gas,
 *   CFM on duct); `system.total.<quantity>`, what the whole system carries at
 *   its source or outfall.
 *
 * Returns null for any other path, so the resolver carries on.
 */
export interface PlumbingResolved {
  readonly value: string | number | null;
  readonly text: string;
}

const engines = new WeakMap<object, PlumbingNetworkEngine>();

function engineFor(elements: Elements): PlumbingNetworkEngine {
  let e = engines.get(elements);
  if (!e) {
    e = new PlumbingNetworkEngine();
    engines.set(elements, e);
  }
  return e;
}

const n2 = (v: number) => Math.round(v * 100) / 100;
const numberField = (v: number | undefined): PlumbingResolved => (v === undefined ? { value: null, text: "" } : { value: n2(v), text: n2(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) });
const textField = (v: string | undefined | null): PlumbingResolved => (v ? { value: v, text: v } : { value: null, text: "" });

/** The one record a load point or fixture's plumbing values come from. */
function bagOf(elements: Elements, el: BimElement): { readonly bag: QuantityBag; readonly designator: string | null } | null {
  if (el.kind === "load_point") return { bag: loadPointQuantities(elements, el), designator: el.connectionType || null };
  if (el.kind !== "part") return null;
  const lp = loadPointsOfPart(elements, el.id)[0];
  if (lp) return { bag: loadPointQuantities(elements, lp), designator: lp.connectionType || null };
  const name = partConnectionTypeName(elements, el);
  const ct = name ? connectionTypeOf(elements, name) : null;
  return ct ? { bag: mergeBags(ct.quantities, undefined), designator: ct.designator } : null;
}

/** A load point's or fixture's own quantity, unrounded, in the quantity's own unit (`QUANTITIES`); undefined when it has none. */
export function plumbingQuantity(elements: Elements, el: BimElement, q: QuantityKey): number | undefined {
  return bagOf(elements, el)?.bag[q];
}

/** What a pipe carries in `q`, unrounded; undefined when that is not its system's quantity. */
export function pipeCarriesQuantity(elements: Elements, el: BimElement, q: QuantityKey): number | undefined {
  if (el.kind !== "run_segment" && el.kind !== "run_fitting") return undefined;
  const system = elements[el.systemId];
  if (system?.kind === "mep_system" && system.domain === "duct") return q === "cfm" && el.kind === "run_segment" ? el.flow : undefined;
  const carries = engineFor(elements).carries({ elements } as Pick<ModelState, "elements"> as ModelState, el.id);
  return carries && carries.quantity === q ? carries.value : undefined;
}

/** What a pipe's whole system carries at its source or outfall in `q`, unrounded. */
export function systemTotalQuantity(elements: Elements, el: BimElement, q: QuantityKey): number | undefined {
  const systemId = el.kind === "mep_system" ? el.id : el.kind === "run_segment" || el.kind === "run_fitting" ? el.systemId : null;
  const system = systemId ? elements[systemId] : undefined;
  if (system?.kind !== "mep_system" || primaryQuantity(system.systemKind) !== q) return undefined;
  return engineFor(elements).systemTotal({ elements } as Pick<ModelState, "elements"> as ModelState, system.id)?.value;
}

/** Plumbing field paths: load points, fixtures attached to them, and what pipes carry. */
export const PLUMBING_FIELD_PATHS: readonly FieldPathInfo[] = [
  { path: "load.wsfu_cold", label: "Cold water fixture units", on: "load_point", example: "1.5" },
  { path: "load.wsfu_hot", label: "Hot water fixture units", on: "load_point", example: "1.5" },
  { path: "load.wsfu_total", label: "Total water fixture units", on: "load_point", example: "2" },
  { path: "load.dfu", label: "Drainage fixture units", on: "load_point", example: "3" },
  { path: "load.gph_demand", label: "Hot water demand (gal/h)", on: "load_point", example: "5" },
  { path: "load.mbh", label: "Gas input (MBH)", on: "load_point", example: "90" },
  { path: "load.cfm", label: "Airflow (CFM)", on: "load_point", example: "150" },
  { path: "load.size.cw", label: "Cold water connection size", on: "load_point", example: '1/2"' },
  { path: "connection_type.mark", label: "Connection type", on: "load_point", example: "K01" },
  { path: "connection_type.description", label: "Connection type description", on: "load_point", example: "Hand sink" },
  { path: "pipe.carries.dfu", label: "Drainage fixture units the pipe carries", on: "pipe", example: "59" },
  { path: "pipe.carries.wsfu_cold", label: "Water fixture units the pipe carries", on: "pipe", example: "43.25" },
  { path: "pipe.carries.mbh", label: "Gas input the pipe carries (MBH)", on: "pipe", example: "1,024.41" },
  { path: "system.total.dfu", label: "System total at the outfall (DFU)", on: "pipe", example: "88" },
];

export const PLUMBING_FIELD_PREFIXES = ["load.", "connection_type.", "pipe.carries.", "system.total."] as const;

export function isPlumbingFieldPath(path: string): boolean {
  return PLUMBING_FIELD_PREFIXES.some((p) => path.startsWith(p));
}

export function resolvePlumbingField(elements: Elements, elementId: string, path: string): PlumbingResolved | null {
  if (!isPlumbingFieldPath(path)) return null;
  const el = elements[elementId];
  if (!el) return { value: null, text: "" };
  const segs = path.split(".");
  if (segs[0] === "load") {
    const from = bagOf(elements, el);
    if (!from) return { value: null, text: "" };
    if (segs[1] === "size" && segs[2] && (CONNECTION_SIZE_KEYS as readonly string[]).includes(segs[2])) return textField(from.bag.sizes?.[segs[2] as (typeof CONNECTION_SIZE_KEYS)[number]]);
    if (segs[1] === "custom" && segs[2]) {
      const name = segs.slice(2).join(".").toLowerCase();
      const c = from.bag.custom?.find((x) => x.name.toLowerCase() === name);
      return c ? { value: c.value, text: `${n2(c.value)}${c.unit ? ` ${c.unit}` : ""}` } : { value: null, text: "" };
    }
    const q = segs[1];
    return q && isQuantityKey(q) ? numberField(from.bag[q]) : { value: null, text: "" };
  }
  if (segs[0] === "connection_type") {
    const from = el.kind === "load_point" ? { designator: el.connectionType, entry: connectionTypeOfLoadPoint(elements, el) } : el.kind === "part" ? (() => {
      const d = loadPointsOfPart(elements, el.id)[0]?.connectionType ?? partConnectionTypeName(elements, el);
      return { designator: d ?? "", entry: d ? connectionTypeOf(elements, d) : null };
    })() : null;
    if (!from) return { value: null, text: "" };
    if (segs[1] === "mark") return textField(from.entry?.designator ?? from.designator);
    if (segs[1] === "description") return textField(from.entry?.description);
    return { value: null, text: "" };
  }
  // pipe.carries.<q> / system.total.<q>
  const q = segs[2];
  if (!q || !isQuantityKey(q)) return { value: null, text: "" };
  if (segs[0] === "pipe" && segs[1] === "carries") return numberField(pipeCarriesQuantity(elements, el, q));
  if (segs[0] === "system" && segs[1] === "total") return numberField(systemTotalQuantity(elements, el, q));
  return { value: null, text: "" };
}
