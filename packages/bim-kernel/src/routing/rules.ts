import type { ConnectorDomain } from "../parts";
import { activeServiceRegistry, serviceRoutingRules, type ServiceRegistry } from "../services/registry";
import type { Discipline } from "../types";
import { defaultPipeSpec, pipeRow, pipeSpecLabel } from "./pipe/specs";
import { pipeMaterialOf } from "./pipe/material-rows";
import type { FittingType, RunDomain, RunSize } from "./types";

/**
 * Per-system fitting rules. Routing itself is the same for every discipline;
 * only these choices differ: which fitting a branch uses, what each fitting
 * is called, how flow is counted, and who owns the work.
 */
export interface SystemRules {
  readonly domain: RunDomain;
  readonly discipline: Discipline;
  readonly label: string;
  /** Hosted branch fitting this system uses. */
  readonly branch: Extract<FittingType, "tap" | "tee" | "wye">;
  /** Unit of the flow the loads give (shown with the number). */
  readonly flowUnit: "CFM" | "WFU" | "DFU" | "GPM" | "VA" | "MBH" | "";
  /** A branch may be as large as its trunk (pipe tees); ducts need a smaller branch. */
  readonly branchMayEqualTrunk: boolean;
}

const RULES_BY_REGISTRY = new WeakMap<ServiceRegistry, Map<string, SystemRules>>();

/** Rules for a stored kind, derived from its service row in the registry in force; one this reader doesn't know routes as Other pipe under its own words. */
export function systemRules(kind: string): SystemRules {
  const registry = activeServiceRegistry();
  let byKind = RULES_BY_REGISTRY.get(registry);
  if (!byKind) RULES_BY_REGISTRY.set(registry, (byKind = new Map()));
  let rules = byKind.get(kind);
  if (!rules) byKind.set(kind, (rules = serviceRoutingRules(kind, registry)));
  return rules;
}

/** The part-connector domain a run domain plugs into. */
export function connectorDomainOf(domain: RunDomain): ConnectorDomain {
  return domain === "conduit" ? "electrical" : domain;
}

export function sizeFitsDomain(size: RunSize, domain: RunDomain): boolean {
  switch (size.shape) {
    case "rect":
    case "round":
    case "oval":
      return domain === "duct";
    case "pipe":
      return domain === "pipe";
    case "conduit":
      return domain === "conduit";
  }
}

const DOMAIN_WORD: Readonly<Record<RunDomain, string>> = { duct: "duct", pipe: "pipe", conduit: "conduit" };

export function domainWord(domain: RunDomain): string {
  return DOMAIN_WORD[domain];
}

/** What each fitting is called on this system, in words for drawings, properties and refusals. */
export function fittingLabel(type: FittingType, rules: SystemRules, branchSize: RunSize | null, angleDeg?: number): string {
  switch (type) {
    case "elbow":
      return `${angleDeg ?? 90}° elbow`;
    case "transition":
      return rules.domain === "duct" ? "Transition" : "Reducer";
    case "cap":
      return rules.domain === "duct" ? "End cap" : "Cap";
    case "tap":
      return branchSize?.shape === "round" ? "Conical tap" : "Straight tap";
    case "tee":
      return "Tee";
    case "wye":
      return "Combination wye";
    case "offset":
      return "Offset";
    case "accessory":
      return "Accessory";
  }
}

export function sameSize(a: RunSize, b: RunSize): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) < 0.5;
  switch (a.shape) {
    case "rect":
    case "oval":
      return b.shape === a.shape && close(a.width, b.width) && close(a.height, b.height);
    case "round":
      return b.shape === "round" && close(a.diameter, b.diameter);
    case "pipe":
      return b.shape === "pipe" && close(a.nominalMm, b.nominalMm) && a.material === b.material && (a.spec ?? defaultPipeSpec(a.material)) === (b.spec ?? defaultPipeSpec(b.material));
    case "conduit":
      return b.shape === "conduit" && close(a.tradeSizeMm, b.tradeSizeMm) && a.conduitType === b.conduitType;
  }
}

/** Width seen in plan (what double-line duct draws, and how far a branch sits off the trunk's centreline). */
export function sizeWidth(size: RunSize): number {
  switch (size.shape) {
    case "rect":
    case "oval":
      return size.width;
    case "round":
      return size.diameter;
    case "pipe":
      return size.nominalMm;
    case "conduit":
      return size.tradeSizeMm;
  }
}

/** Height seen in section. */
export function sizeHeight(size: RunSize): number {
  return size.shape === "rect" || size.shape === "oval" ? size.height : sizeWidth(size);
}

function inches(mm: number): string {
  const v = Math.round((mm / 25.4) * 8) / 8;
  const whole = Math.floor(v);
  const frac = v - whole;
  const fracText = frac === 0 ? "" : frac === 0.5 ? "½" : frac === 0.25 ? "¼" : frac === 0.75 ? "¾" : frac === 0.125 ? "⅛" : frac === 0.375 ? "⅜" : frac === 0.625 ? "⅝" : frac === 0.875 ? "⅞" : `.${String(frac).slice(2)}`;
  return whole === 0 && fracText ? `${fracText}"` : `${whole}${fracText}"`;
}

/** Millimetres as the inch size people say (`¾"`, `1½"`). */
export const inchSizeText = inches;

/** A pipe's nominal size alone, as risers and tags print it (`1½"`); other runs print their full size. */
export function nominalSizeText(size: RunSize): string {
  return size.shape === "pipe" ? inches(size.nominalMm) : sizeLabel(size);
}

const MATERIAL_LABEL: Readonly<Record<string, string>> = {
  copper: "copper",
  pex: "PEX",
  cpvc: "CPVC",
  cast_iron: "cast iron",
  pvc: "PVC",
  abs: "ABS",
  steel: "steel",
  black_steel: "black steel",
  galvanized: "galvanized",
  pp_r: "PP-R",
  csst: "CSST",
  pe: "PE",
};

/** A size as people say it: 12"x8", 10"Ø, 2" copper. */
export function sizeLabel(size: RunSize): string {
  switch (size.shape) {
    case "rect":
      return `${inches(size.width)}x${inches(size.height)}`;
    case "oval":
      return `${inches(size.width)}x${inches(size.height)} oval`;
    case "round":
      return `${inches(size.diameter)}Ø`;
    case "pipe": {
      const spec = size.spec ? (pipeRow(size)?.designation ?? pipeSpecLabel(size.spec)) : "";
      // A pack's material prints its own name (kept by id when this host lacks the pack); a built-in its usual word.
      const material = size.materialId !== undefined ? pipeMaterialOf(size).label : (MATERIAL_LABEL[size.material] ?? size.material);
      return `${inches(size.nominalMm)}${spec ? ` ${spec}` : ""} ${material}`;
    }
    case "conduit":
      return `${inches(size.tradeSizeMm)} ${size.conduitType.toUpperCase()}`;
  }
}

/**
 * Can one fitting change `from` into `to`? One size change per fitting:
 * any duct shape to any duct shape; a pipe reducer keeps the material.
 */
export function transitionReason(from: RunSize, to: RunSize): string | null {
  if (from.shape === "pipe" && to.shape === "pipe" && from.material !== to.material) {
    return `A ${sizeLabel(from)} pipe can't join ${sizeLabel(to)} pipe with a reducer; changing material needs an adapter, which routing doesn't place yet`;
  }
  if (from.shape === "conduit" || to.shape === "conduit") return "Conduit can't change size inside a run yet";
  return null;
}
