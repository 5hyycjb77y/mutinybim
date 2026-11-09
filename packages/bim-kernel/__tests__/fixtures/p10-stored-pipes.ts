import { fittingFamily, pipeParams, resolveParams, type BimElement, type ElementId, type FittingFamily, type MepSystem, type ModelState, type RunFitting, type RunSegment, type RunSize, type SystemKind, DEFAULT_SETTINGS } from "../../src";

/**
 * Round 10 lane P10: a stored model with a piece of every pipe product and a
 * fitting of every family made in its material, written as records (the way
 * a changeset stores them). Round 9's kernel chose each fitting's joint
 * (`pipeParams`); this builder is only run to write the fixture, so the
 * stored `params` are round 9's choice, frozen in `pipe-every-product.json`.
 */
const IN = 25.4;

export interface ProductKey {
  readonly material: Extract<RunSize, { shape: "pipe" }>["material"];
  readonly spec: NonNullable<Extract<RunSize, { shape: "pipe" }>["spec"]>;
  readonly services: readonly string[];
  readonly nominalIn: number;
  readonly joints: readonly string[];
}

const KIND_OF: Readonly<Record<string, SystemKind>> = { water: "domestic_cold_water", drainage: "sanitary", gas: "natural_gas" };

/** Every family made in `material`, each as a stored fitting on its own short piece; bends once per joint the family offers. */
export function everyProductModel(products: readonly ProductKey[], families: readonly FittingFamily[]): ModelState {
  const elements: Record<string, BimElement> = {};
  const base = { version: 0, authoredRev: {}, domain: "pipe" as const, levelId: "lvl" as ElementId };
  products.forEach((p, i) => {
    const kind = KIND_OF[p.services[0] ?? "water"] ?? "other";
    const sysId = `sys-${i}` as ElementId;
    const system: MepSystem = { id: sysId, kind: "mep_system", version: 0, authoredRev: {}, name: `${p.material} ${p.spec}`, systemKind: kind, domain: "pipe" };
    elements[sysId] = system;
    const size: RunSize = { shape: "pipe", nominalMm: p.nominalIn * IN, material: p.material, spec: p.spec };
    const y0 = i * 20_000;
    const made = families.filter((f) => f.pipe?.materials.includes(p.material));
    made.forEach((fam, j) => {
      const x0 = j * 4000;
      const hostId = `h-${i}-${j}` as ElementId;
      const fid = `f-${i}-${j}` as ElementId;
      const host: RunSegment = { ...base, systemId: sysId, id: hostId, kind: "run_segment", start: { x: x0, y: y0, z: 0 }, end: { x: x0 + 3000, y: y0, z: 0 }, size, links: {}, branches: [], flow: 0 };
      const form = fam.pipe?.form;
      const accessory = fam.fittingTypes.includes("accessory");
      const params = resolveParams(fam, pipeParams(fam, size, undefined));
      const common = { ...base, systemId: sysId, kind: "run_fitting" as const, label: fam.name, family: fam.id };
      if (accessory) {
        elements[hostId] = { ...host, branches: [fid] };
        elements[fid] = { ...common, id: fid, fittingType: "accessory", position: { x: x0 + 1500, y: y0, z: 0 }, host: { segmentId: hostId, s: 1500, side: 1 }, ports: [], params } satisfies RunFitting;
        return;
      }
      if (form === "tee") {
        const b = `b-${i}-${j}` as ElementId;
        elements[hostId] = { ...host, branches: [fid] };
        elements[b] = { ...base, systemId: sysId, id: b, kind: "run_segment", start: { x: x0 + 1500, y: y0, z: 0 }, end: { x: x0 + 1500, y: y0 + 2000, z: 0 }, size, links: { start: { elementId: fid, port: "branch" } }, branches: [], flow: 0 } satisfies RunSegment;
        elements[fid] = { ...common, id: fid, fittingType: fam.fittingTypes.includes("tee") ? "tee" : "wye", position: { x: x0 + 1500, y: y0, z: 0 }, host: { segmentId: hostId, s: 1500, side: 1 }, ports: [{ id: "branch", position: { x: x0 + 1500, y: y0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, size, link: { elementId: b, port: "start" } }], params } satisfies RunFitting;
        return;
      }
      elements[hostId] = host;
      const at = { x: x0, y: y0, z: 0 };
      if (form === "cap") {
        elements[fid] = { ...common, id: fid, fittingType: "cap", position: at, ports: [{ id: "a", position: at, direction: { x: 1, y: 0, z: 0 }, size }], params } satisfies RunFitting;
        return;
      }
      if (form === "reducer") {
        const smaller: RunSize = { ...size, nominalMm: size.nominalMm * 0.75 };
        elements[fid] = { ...common, id: fid, fittingType: "transition", position: at, ports: [{ id: "a", position: at, direction: { x: 1, y: 0, z: 0 }, size }, { id: "b", position: at, direction: { x: -1, y: 0, z: 0 }, size: smaller }], params } satisfies RunFitting;
        return;
      }
      const angle = fam.angles === "45" ? 45 : fam.angles === "22.5" ? 22.5 : 90;
      const rad = (angle * Math.PI) / 180;
      const joints = j === made.findIndex((f) => f.pipe?.form === "bend") ? (fam.pipe?.joints ?? []) : [params.joint];
      joints.forEach((joint, k) => {
        const id = (k === 0 ? fid : `${fid}-j${k}`) as ElementId;
        const jp = typeof joint === "string" ? { ...params, joint } : params;
        elements[id] = { ...common, id, fittingType: "elbow", angleDeg: angle, position: { ...at, z: k * 500 }, ports: [{ id: "a", position: at, direction: { x: -1, y: 0, z: 0 }, size }, { id: "b", position: at, direction: { x: -Math.cos(Math.PI - rad), y: Math.sin(rad), z: 0 }, size }], params: jp } satisfies RunFitting;
      });
    });
  });
  return { modelId: "p10-every-product", revision: 1 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

export function familyOrThrow(id: string): FittingFamily {
  const f = fittingFamily(id);
  if (!f) throw new Error(id);
  return f;
}
