import { isRegistryIdShape } from "../ids";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";

/**
 * Pipe products (contract 1.8.0, `kernel.pipe_product` v1): what a pipe is
 * made as. Every row is an add-on's (a first-party add-on ships the built-in
 * materials' catalogue); the kernel only reads the table: a product's
 * sizes and their real outside and inside diameters, its roughness and
 * friction values, which joints it is made with (end types from
 * `CONNECTOR_END_TYPE_POINT`) and how big each joint's hub is.
 *
 * A pipe size names its product the way it always has: its material (or a
 * pack material's `materialId`) and its stored spec name, or no spec for the
 * material's default product. Readers are tolerant: a size whose product no
 * add-on in force declares keeps its stored fields, draws at its nominal
 * size and reads as an ordinary issue naming what supplies it.
 */
export interface PipeProductSize {
  /** Nominal size, inches (1.25 for 1-1/4"). */
  readonly nominalIn: number;
  readonly odMm: number;
  readonly idMm: number;
  readonly wallMm: number;
  /** A size name other than the nominal inch ("20 mm", "EHD 19"). */
  readonly label?: string;
  /** The row's own dimension ratio where it differs within the product. */
  readonly designation?: string;
}

/** A joint's hub (socket, coupling band, threaded end): its outside diameter and length, each over the pipe's outside diameter. */
export interface PipeHub {
  readonly odOverPipe: number;
  readonly lengthOverOd: number;
}

export interface PipeProduct {
  /** `<pack>.<name>`. */
  readonly id: string;
  /** What a person calls it ("Copper tube, type L"). */
  readonly name: string;
  /** The pipe material it is made in: a `PIPE_MATERIAL_POINT` row id (a built-in material, or a pack's). */
  readonly materialId: string;
  /** The spec name a pipe size stores for it (`size.spec`). Frozen once stored. */
  readonly spec: string;
  /** The short spec words on tags and labels ("type L", "Sch 40"); empty when the material says it all. */
  readonly specLabel: string;
  /** True for the product a size of this material means when it names no spec. One per material. */
  readonly defaultForMaterial?: boolean;
  /** The product standard it is dimensioned by ("ASTM B88"). */
  readonly standard: string;
  /** Services it is made for (the service words `serviceOf` reads, or a pack's own). */
  readonly services: readonly string[];
  /** Sizes made, ascending. */
  readonly sizes: readonly PipeProductSize[];
  /** Absolute roughness, mm (new pipe). */
  readonly roughnessMm: number;
  readonly hazenWilliamsC: number;
  readonly manningN: number;
  readonly pressureClass: string;
  /** End types (`CONNECTOR_END_TYPE_POINT` ids) its joints are made with, in the order a person is offered them. */
  readonly endTypes: readonly string[];
  /** The joint it is usually made with; one of `endTypes`. */
  readonly defaultEndType: string;
  /** Each joint's hub, by end type. */
  readonly hubs?: Readonly<Record<string, PipeHub>>;
  readonly note?: string;
}

/** The fitting parameter a joint is kept under by end type id; the same parameter connector integrity reads (`END_TYPE_PARAM`). */
export const PIPE_JOINT_END_TYPE_PARAM = "end_type";
/** The fitting parameter older records keep a joint's stored name in. */
export const PIPE_JOINT_PARAM = "joint";

/** Peers that read and write a pipe fitting's joint by end type (`params.end_type`), for joints no stored name covers. */
export const PIPES_ADDON_PRODUCTS_FEATURE = "pipes:addon_products";

export const PIPE_PRODUCT_POINT = defineExtensionPoint<PipeProduct>({
  id: "kernel.pipe_product",
  version: 1,
  label: "Pipe products",
  idOf: (row) => row.id,
});

/** The set in force's pipe products. */
export interface PipeProductTable {
  /** The product a size of `materialId` with stored spec `spec` means (no spec: the material's default). */
  product(materialId: string, spec: string | undefined): PipeProduct | null;
  /** The product a size of `materialId` means when it names no spec. */
  defaultFor(materialId: string): PipeProduct | null;
  row(id: string): PipeProduct | undefined;
  /** Products made in `materialId`, in row order. */
  forMaterial(materialId: string): readonly PipeProduct[];
  /** The short spec words for a stored spec name (the first product that stores it). */
  specLabel(spec: string): string | undefined;
  /** A joint's hub by end type: the first product that sizes one. */
  hub(endType: string): PipeHub | undefined;
  /** A pipe size's product: its pack material's own when one is made, else its built-in material's. */
  ofSize(size: { readonly material: string; readonly materialId?: string; readonly spec?: string }): PipeProduct | null;
  /** Whether `product` is made with the joint `endType`. */
  makes(product: PipeProduct, endType: string): boolean;
  readonly rows: readonly PipeProduct[];
}

const TABLE_KEY = "kernel.pipe_product#table";
const key = (materialId: string, spec: string): string => `${materialId}\u0000${spec}`;

function buildTable(items: readonly PipeProduct[]): PipeProductTable {
  const byMaterialSpec = new Map<string, Map<string, PipeProduct>>();
  const defaults = new Map<string, PipeProduct>();
  const byMaterial = new Map<string, PipeProduct[]>();
  const rows = new Map<string, PipeProduct>();
  const specLabels = new Map<string, string>();
  const hubs = new Map<string, PipeHub>();
  const made = new Map<PipeProduct, ReadonlySet<string>>();
  for (const p of items) {
    rows.set(p.id, p);
    const specs = byMaterialSpec.get(p.materialId) ?? new Map<string, PipeProduct>();
    if (!specs.has(p.spec)) specs.set(p.spec, p);
    byMaterialSpec.set(p.materialId, specs);
    if (p.defaultForMaterial && !defaults.has(p.materialId)) defaults.set(p.materialId, p);
    const list = byMaterial.get(p.materialId) ?? [];
    list.push(p);
    byMaterial.set(p.materialId, list);
    if (!specLabels.has(p.spec)) specLabels.set(p.spec, p.specLabel);
    for (const [endType, hub] of Object.entries(p.hubs ?? {})) if (!hubs.has(endType)) hubs.set(endType, hub);
    made.set(p, new Set(p.endTypes));
  }
  const defaultFor = (materialId: string): PipeProduct | null => defaults.get(materialId) ?? byMaterial.get(materialId)?.[0] ?? null;
  const product = (materialId: string, spec: string | undefined): PipeProduct | null => (spec === undefined ? defaultFor(materialId) : (byMaterialSpec.get(materialId)?.get(spec) ?? null));
  return {
    product,
    defaultFor,
    row: (id) => rows.get(id),
    forMaterial: (materialId) => byMaterial.get(materialId) ?? [],
    specLabel: (spec) => specLabels.get(spec),
    hub: (endType) => hubs.get(endType),
    ofSize: (size) => (size.materialId !== undefined ? product(size.materialId, size.spec) : null) ?? product(size.material, size.spec),
    makes: (p, endType) => made.get(p)?.has(endType) ?? p.endTypes.includes(endType),
    rows: items,
  };
}

/** The pipe products of `set` (the set in force by default), resolved once per set. */
export function pipeProductTable(set: PackSet = activePackSet()): PipeProductTable {
  return set.memo(TABLE_KEY, () => buildTable(set.items(PIPE_PRODUCT_POINT)));
}

/**
 * Problems with pipe-product rows, in words (pack conformance). `endTypeIds`
 * is every end type the set declares; a product may only name those. Two
 * packs' rows with one id are refused by the set itself.
 */
export function pipeProductRowProblems(items: readonly PipeProduct[], endTypeIds?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const p of items) {
    const name = p.name.trim().length > 0 ? p.name : p.id;
    if (!isRegistryIdShape(p.id) || !p.id.includes(".")) out.push(`pipe product ${p.id}: the id must be "<pack>.<name>"`);
    if (p.name.trim().length === 0) out.push(`pipe product ${p.id} has no name`);
    if (p.materialId.trim().length === 0) out.push(`${name} names no material`);
    if (p.spec.trim().length === 0) out.push(`${name} has no spec name`);
    const k = key(p.materialId, p.spec);
    const first = seen.get(k);
    if (first !== undefined) out.push(`${first} and ${p.id} are both ${p.materialId} ${p.spec}; a size could mean either`);
    else seen.set(k, p.id);
    if (p.defaultForMaterial) {
      const had = defaults.get(p.materialId);
      if (had !== undefined) out.push(`${had} and ${p.id} are both the default ${p.materialId} product`);
      else defaults.set(p.materialId, p.id);
    }
    if (p.sizes.length === 0) out.push(`${name} lists no sizes`);
    p.sizes.forEach((s, i) => {
      if (!(s.idMm > 0 && s.idMm < s.odMm && s.wallMm > 0)) out.push(`${name} ${s.label ?? `${s.nominalIn}"`}: the inside diameter must be above zero and below the outside diameter, with a wall`);
      const before = p.sizes[i - 1];
      if (before && s.nominalIn <= before.nominalIn) out.push(`${name}: sizes must be listed smallest first`);
    });
    if (!(p.roughnessMm > 0) || !(p.hazenWilliamsC > 0) || !(p.manningN > 0)) out.push(`${name}: roughness, C and n must be above zero`);
    if (p.endTypes.length === 0) out.push(`${name} names no joint`);
    if (!p.endTypes.includes(p.defaultEndType)) out.push(`${name}: its usual joint ${p.defaultEndType} isn't one it is made with`);
    for (const e of [...p.endTypes, ...Object.keys(p.hubs ?? {})]) {
      if (endTypeIds && !endTypeIds.has(e)) out.push(`${name} names the joint ${e}, which no add-on here declares as an end type`);
    }
    for (const [e, h] of Object.entries(p.hubs ?? {})) if (!(h.odOverPipe >= 1 && h.lengthOverOd > 0)) out.push(`${name}: the ${e} hub must be at least as big as the pipe and have a length`);
  }
  return out;
}
