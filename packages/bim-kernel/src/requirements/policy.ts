import { catalogElementId } from "../catalog/model";
import type { LoadPolicyEntry, ServiceCatalogElement } from "../catalog/types";
import type { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import type { BimElement } from "../types";
import { DEFAULT_ALLOCATION_POLICY, type AllocationPolicy } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/** The one load allocation record a model has. */
export const LOAD_POLICY_NAME = "Project";

/** The model's allocation policy, else the firm's default, else `max`. */
export function allocationPolicyOf(elements: Elements, firmDefault: AllocationPolicy = DEFAULT_ALLOCATION_POLICY): AllocationPolicy {
  const el = elements[catalogElementId("load_policy", LOAD_POLICY_NAME)];
  return el?.kind === "service_catalog" && el.entry.type === "load_policy" ? el.entry.policy : firmDefault;
}

/**
 * How estimates count in one space or zone: the space's own setting
 * ("Estimate until devices exceed it", "Devices only once any are placed",
 * "Estimate only") when it has one, else the model's. Zones use the model's.
 */
export function scopePolicyOf(elements: Elements, scope: { readonly kind: "space" | "zone"; readonly id: string }, modelPolicy: AllocationPolicy): AllocationPolicy {
  if (scope.kind !== "space") return modelPolicy;
  const s = elements[scope.id];
  return s?.kind === "space" && s.estimateCounting ? s.estimateCounting : modelPolicy;
}

/** "Estimate until devices exceed it" and the rest: what a person reads for each policy. */
export const ALLOCATION_POLICY_LABELS: Readonly<Record<AllocationPolicy, string>> = {
  max: "Estimate until devices exceed it",
  actual_only: "Devices only once any are placed",
  allocation_only: "Estimate only",
};

/** One line on what each policy does, for a control's help text. */
export const ALLOCATION_POLICY_HELP: Readonly<Record<AllocationPolicy, string>> = {
  max: "The estimate counts until the devices placed in the space add up to more, quantity by quantity.",
  actual_only: "Once any device is placed in the space, only the devices count; until then the estimate does.",
  allocation_only: "Only the estimate counts, whatever is placed (early studies).",
};

/** The record `set_load_allocation_policy` writes, or null when the model already says that. */
export function loadPolicyRecord(reader: TrackedReader, policy: AllocationPolicy): ServiceCatalogElement | null {
  const id = catalogElementId("load_policy", LOAD_POLICY_NAME);
  const prior = reader.find(id);
  if (prior?.kind === "service_catalog" && prior.entry.type === "load_policy" && prior.entry.policy === policy) return null;
  const entry: LoadPolicyEntry = { type: "load_policy", name: LOAD_POLICY_NAME, policy };
  const base = prior?.kind === "service_catalog" ? prior : { id, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION };
  return { ...base, id, kind: "service_catalog", trade: "electrical", entry };
}
