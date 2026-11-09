import { DEFAULT_SETTINGS, asElementId, asRevision, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { ahuType, fryerType } from "./c5i-model";

/**
 * The `ifc.export.synthetic_tower` case: `storeys` levels, each with
 * `spacesPerStorey` drawn spaces in a thermal zone, a supply-air system of
 * `runsPerStorey` linked duct segments, and `partsPerStorey` parts (every
 * fourth one planned) with connectors. Synthetic, no client data.
 */
export function syntheticTower(opts: { readonly storeys: number; readonly spacesPerStorey: number; readonly runsPerStorey: number; readonly partsPerStorey: number }): ModelState {
  const els: BimElement[] = [
    { id: asElementId("pt-ahu"), version: 1, authoredRev: {}, kind: "part_type", definition: ahuType() },
    { id: asElementId("pt-fryer"), version: 1, authoredRev: {}, kind: "part_type", definition: fryerType() },
  ];
  const base = { version: 1, authoredRev: {} };
  for (let s = 0; s < opts.storeys; s++) {
    const lv = asElementId(`lvl-${s}`);
    els.push({ ...base, id: lv, kind: "level", name: `Level ${s + 1}`, elevationMm: s * 4000 });
    const spaceIds = [];
    for (let i = 0; i < opts.spacesPerStorey; i++) {
      const x = (i % 10) * 6000;
      const y = Math.floor(i / 10) * 6000;
      const id = asElementId(`sp-${s}-${i}`);
      spaceIds.push(id);
      els.push({ ...base, id, kind: "space", number: `${s + 1}${String(i).padStart(2, "0")}`, name: "Office", levelId: lv, bounds: { kind: "outline", outline: [{ x, y }, { x: x + 5800, y }, { x: x + 5800, y: y + 5800 }, { x, y: y + 5800 }] }, origin: { kind: "drawn" }, occupants: 4, ceilingHeightMm: 2700 });
    }
    els.push({ ...base, id: asElementId(`zone-${s}`), kind: "zone", name: `Zone ${s + 1}`, purpose: "thermal", spaceIds, servedBy: asElementId(`part-${s}-0`) });
    const sys = asElementId(`sys-${s}`);
    els.push({ ...base, id: sys, kind: "mep_system", name: `Supply Air ${s + 1}`, systemKind: "supply_air", domain: "duct" });
    for (let r = 0; r < opts.runsPerStorey; r++) {
      const prev = r > 0 ? { elementId: asElementId(`run-${s}-${r - 1}`), port: "end" } : undefined;
      const next = r < opts.runsPerStorey - 1 ? { elementId: asElementId(`run-${s}-${r + 1}`), port: "start" } : undefined;
      els.push({
        ...base,
        id: asElementId(`run-${s}-${r}`),
        kind: "run_segment",
        domain: "duct",
        systemId: sys,
        levelId: lv,
        start: { x: r * 3000, y: 100, z: 3000 },
        end: { x: (r + 1) * 3000, y: 100, z: 3000 },
        size: { shape: "rect", width: 600, height: 400 },
        links: { ...(prev ? { start: prev } : {}), ...(next ? { end: next } : {}) },
        branches: [],
        flow: 1000,
      });
    }
    for (let p = 0; p < opts.partsPerStorey; p++) {
      const planned = p % 4 === 3;
      els.push({
        ...base,
        id: asElementId(`part-${s}-${p}`),
        kind: "part",
        typeId: asElementId(p % 2 === 0 ? "pt-ahu" : "pt-fryer"),
        levelId: lv,
        position: { x: (p % 20) * 2500, y: Math.floor(p / 20) * 2500 },
        offsetMm: 0,
        rotationDeg: (p % 4) * 90,
        mark: `M-${s + 1}-${p}`,
        values: {},
        ...(planned ? { planned: { levelHint: lv, spaceHint: asElementId(`sp-${s}-${p % Math.max(1, opts.spacesPerStorey)}`) } } : {}),
      });
    }
  }
  return { modelId: "tower", revision: asRevision(1), elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

/** The perf case's size: 20 storeys × (50 spaces, 100 duct runs, 250 parts). */
export const TOWER_CASE = { storeys: 20, spacesPerStorey: 50, runsPerStorey: 100, partsPerStorey: 250 } as const;
