import { connectorEndTypeTable, type ConnectorEndTypeItem } from "../../connections/end-types";
import { peerReads } from "../../elements/feature";
import { activePackSet } from "../../packs/scope";
import type { PackSet } from "../../packs/set";
import { rawRegistryWords } from "../../ids";
import { firstPartyStoredOwner } from "../../packs/first-party/manifests";
import { packNotLoadedMessage } from "../../packs/set";
import { PIPES_OPEN_SPECS_FEATURE } from "../../elements/create-feature";
import { PIPES_ADDON_PRODUCTS_FEATURE, PIPE_JOINT_END_TYPE_PARAM, PIPE_JOINT_PARAM, pipeProductTable, type PipeProduct, type PipeProductSize } from "../../registry/pipe-product-point";
import { PIPE_MATERIALS, PIPE_SPEC_IDS, type PipeMaterial, type PipeSpecId, type RunSize } from "../types";

export * from "../../registry/pipe-product-point";

/**
 * Pipe products as the kernel reads them: rows of `PIPE_PRODUCT_POINT`
 * (a first-party add-on ships the built-in materials' catalogue). A pipe size
 * names its product by material (`materialId` first) and stored spec; its
 * joints are end types (`CONNECTOR_END_TYPE_POINT`), stored on a fitting as
 * the frozen `joint` name an end type reads, or by id under `end_type` for a
 * joint no stored name covers.
 */

/** Which service a pipe product is for: domestic water, drainage and vent, fuel gas. */
export type PipeService = "water" | "drainage" | "gas";

export type PipeSpec = PipeProduct;
export type PipeSizeRow = PipeProductSize;

const IN = 25.4;
const STORED_JOINTS_KEY = "kernel.pipe_product#stored_joints";

/** Whether a product's spec name is one a pipe size can store today (`PIPE_SPEC_IDS`). */
export function isStoredPipeSpec(spec: string): spec is PipeSpecId {
  return (PIPE_SPEC_IDS as readonly string[]).includes(spec);
}

/** Whether a product's spec name may be stored on a pipe size here: a built-in name, or any add-on's once every peer reads it (`pipes:open_specs`). */
export function pipeSpecStorable(spec: string): boolean {
  return isStoredPipeSpec(spec) || peerReads(PIPES_OPEN_SPECS_FEATURE);
}

/** The older-server words when a pipe size would newly name an add-on's spec and a peer can't store it; null when it may. */
export function pipeSpecWriteRefusal(spec: string | undefined, was: string | undefined): string | null {
  if (spec === undefined || spec === was || pipeSpecStorable(spec)) return null;
  return `${pipeSpecLabel(spec)} pipe can't be saved yet: the model server this model is open on is an older version that only stores the built-in pipe specs. Try again once the server is updated. Nothing changed`;
}

/** Whether a product's material id is a built-in material (`PIPE_MATERIALS`), not a pack's. */
export function isPipeMaterial(id: string): id is PipeMaterial {
  return (PIPE_MATERIALS as readonly string[]).includes(id);
}

/** Every pipe product of the set in force, in row order. */
export function pipeProducts(): readonly PipeProduct[] {
  return pipeProductTable().rows;
}

/** The stored spec a material's sizes mean when they name none; undefined when no add-on here makes the material. */
export function defaultPipeSpec(material: string): string | undefined {
  return pipeProductTable().defaultFor(material)?.spec;
}

/** The short words for a stored spec name ("type L"); its raw words when no product here stores it. */
export function pipeSpecLabel(spec: string): string {
  return pipeProductTable().specLabel(spec) ?? spec.replace(/_/g, " ");
}

/** The product a material and stored spec mean (no spec: the material's default), or null. */
export function pipeSpec(material: string, spec?: string): PipeProduct | null {
  return pipeProductTable().product(material, spec);
}

type PipeSize = Extract<RunSize, { shape: "pipe" }>;

/** A size's product: its pack material's own product when one is made, else its built-in material's. */
export function specOfSize(size: PipeSize): PipeProduct | null {
  return pipeProductTable().ofSize(size);
}

/** The row for a pipe size (nominal within 1 mm), or null when the product doesn't make that size. */
export function pipeRow(size: PipeSize): PipeProductSize | null {
  const spec = specOfSize(size);
  return spec?.sizes.find((r) => Math.abs(r.nominalIn * IN - size.nominalMm) < 1) ?? null;
}

/** OD and ID of a pipe size: the product's row, else the nominal size for both (an unlisted size). */
export function pipeDims(size: PipeSize): { odMm: number; idMm: number; listed: boolean } {
  const row = pipeRow(size);
  return row ? { odMm: row.odMm, idMm: row.idMm, listed: true } : { odMm: size.nominalMm, idMm: size.nominalMm, listed: false };
}

/** The pack a namespaced id comes from (`civil.rcp` → civil), or null for a bare built-in id. */
function supplierOf(id: string): string | null {
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : null;
}

/** Why a spec can't be used with a material, or a size isn't made in it; null when fine. */
export function pipeSizeIssue(size: PipeSize): string | null {
  const spec = specOfSize(size);
  if (!spec) {
    const table = pipeProductTable();
    const material = size.materialId ?? size.material;
    if (table.forMaterial(material).length === 0 && table.forMaterial(size.material).length === 0) {
      const owner = firstPartyStoredOwner("pipe_material", size.material);
      const from = supplierOf(material);
      const who = owner ? packNotLoadedMessage(owner) : `No add-on here makes ${rawRegistryWords(material).toLowerCase()} pipe`;
      return `${who}, so this ${rawRegistryWords(material).toLowerCase()} pipe's size isn't checked. Turn on ${owner ? "that add-on" : from ? `the add-on that supplies it (${from})` : "the add-on that supplies its pipe products"}`;
    }
    return `${size.material.replace(/_/g, " ")} doesn't come in ${size.spec?.replace(/_/g, " ") ?? "that spec"}`;
  }
  if (!pipeRow(size)) {
    const made = spec.sizes.map((r) => r.label ?? `${r.nominalIn}"`).join(", ");
    return `${spec.name} isn't made in ${Math.round((size.nominalMm / IN) * 1000) / 1000}"; sizes are ${made}`;
  }
  return null;
}

// ------------------------------------------------------------------ joints

function storedJointRow(name: string): ConnectorEndTypeItem | undefined {
  return connectorEndTypeTable().resolveStored(PIPE_JOINT_PARAM, name, "pipe");
}

/** The end type a stored joint name reads as, or undefined when no add-on here declares it. */
export function endTypeOfStoredJoint(name: string): string | undefined {
  return storedJointIndex().get(name);
}

/** The stored joint name an end type is kept under on older records, or undefined when it has none (it is kept by id). */
export function storedJointName(endType: string): string | undefined {
  const row = connectorEndTypeTable().row(endType);
  return row?.stored?.param === PIPE_JOINT_PARAM ? row.stored.values[0] : undefined;
}

/** A pipe fitting's joint as an end type id: `end_type` when it keeps one, else what its stored `joint` reads as. */
export function pipeJointEndType(params: Readonly<Record<string, number | string>> | undefined): string | undefined {
  const byId = params?.[PIPE_JOINT_END_TYPE_PARAM];
  if (typeof byId === "string") return byId;
  const stored = params?.[PIPE_JOINT_PARAM];
  return typeof stored === "string" ? storedJointIndex().get(stored) : undefined;
}

/** Every stored joint name the set's end types read, to its end type id (built once per set). */
function storedJointIndex(set: PackSet = activePackSet()): ReadonlyMap<string, string> {
  return set.memo(STORED_JOINTS_KEY, () => {
    const table = connectorEndTypeTable(set);
    const out = new Map<string, string>();
    for (const id of table.ids) {
      const row = table.row(id);
      if (row?.stored?.param !== PIPE_JOINT_PARAM) continue;
      for (const name of row.stored.values) {
        const resolved = table.resolveStored(PIPE_JOINT_PARAM, name, "pipe");
        if (resolved && !out.has(name)) out.set(name, resolved.id);
      }
    }
    return out;
  });
}

/** What a person calls a joint, given its end type id or its stored name ("Sweat (soldered)"); undefined when no add-on here declares it. */
export function pipeJointLabel(joint: string): string | undefined {
  const table = connectorEndTypeTable();
  return (table.row(joint) ?? storedJointRow(joint))?.label;
}

/**
 * Every pipe fitting's joint as its end type, read once from the stored
 * records (the open read, `pipes.lift.stored`). Nothing is rewritten: a
 * record keeps the form it was stored in.
 */
export function liftPipeJoints(elements: Iterable<{ readonly id: string; readonly kind: string; readonly domain?: string; readonly params?: Readonly<Record<string, number | string>> }>): Map<string, string | undefined> {
  const index = storedJointIndex();
  const out = new Map<string, string | undefined>();
  for (const el of elements) {
    if (el.kind !== "run_fitting" || el.domain !== "pipe") continue;
    const byId = el.params?.[PIPE_JOINT_END_TYPE_PARAM];
    const stored = el.params?.[PIPE_JOINT_PARAM];
    out.set(el.id, typeof byId === "string" ? byId : typeof stored === "string" ? index.get(stored) : undefined);
  }
  return out;
}

/** The older-server words when a pipe fitting would newly keep a joint by end type id and a peer can't store it; null when it may. */
export function pipeJointWriteRefusal(fittingName: string, endType: string | undefined, was: string | undefined): string | null {
  if (endType === undefined || endType === was || peerReads(PIPES_ADDON_PRODUCTS_FEATURE)) return null;
  return `A ${fittingName} with a ${(pipeJointLabel(endType) ?? rawRegistryWords(endType)).toLowerCase()} joint can't be saved yet: the model server this model is open on is an older version that doesn't store add-on pipe joints. Try again once the server is updated. Nothing changed`;
}

/**
 * `el` as a peer without `PIPES_ADDON_PRODUCTS_FEATURE` stores it: a pipe
 * fitting's joint kept by end type id goes back under its stored `joint`
 * name when the end type has one. A joint with no stored name stays by id
 * (an older peer keeps it as an unknown parameter). Unchanged otherwise.
 */
export function lowerPipeJointForOlderPeer<T extends { readonly kind: string; readonly domain?: string; readonly params?: Readonly<Record<string, number | string>> }>(el: T): T {
  if (el.kind !== "run_fitting" || el.domain !== "pipe") return el;
  const byId = el.params?.[PIPE_JOINT_END_TYPE_PARAM];
  if (typeof byId !== "string") return el;
  const name = storedJointName(byId);
  if (name === undefined) return el;
  const params: Record<string, number | string> = { ...el.params, [PIPE_JOINT_PARAM]: name };
  delete params[PIPE_JOINT_END_TYPE_PARAM];
  return { ...el, params };
}
