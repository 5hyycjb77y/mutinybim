/**
 * @jest-environment node
 *
 * The exporter at tower size (`ifc.export.synthetic_tower`, 20 storeys,
 * 7,000 parts and runs): every record exported, every GlobalId unique,
 * nothing dangling, and the same bytes twice. The time is printed for the
 * perf budget (lane C owns the budget file); this test never asserts a time.
 */
import { danglingReferences, exportIfc, readStep, rootedEntities } from "../src";
import { PROJECT_ID, TIME_STAMP } from "./c5i-model";
import { TOWER_CASE, syntheticTower } from "./c5i-tower";

describe("ifc.export.synthetic_tower", () => {
  it("exports the whole tower deterministically", () => {
    const model = syntheticTower(TOWER_CASE);
    const t0 = performance.now();
    const a = exportIfc({ model, project: { id: PROJECT_ID, name: "Tower" }, timeStamp: TIME_STAMP });
    const ms = performance.now() - t0;
    console.log(`[ifc.export.synthetic_tower] ${ms.toFixed(0)} ms, ${(a.bytes.byteLength / 1e6).toFixed(1)} MB`);
    const s = TOWER_CASE.storeys;
    expect(a.report.counts).toMatchObject({ storeys: s, spaces: s * TOWER_CASE.spacesPerStorey, zones: s, systems: s, elements: s * (TOWER_CASE.runsPerStorey + TOWER_CASE.partsPerStorey) });
    const file = readStep(a.text);
    expect(danglingReferences(file)).toEqual([]);
    const rooted = rootedEntities(file);
    expect(new Set(rooted.map((r) => r.globalId)).size).toBe(rooted.length);
    expect(exportIfc({ model, project: { id: PROJECT_ID, name: "Tower" }, timeStamp: TIME_STAMP }).text).toBe(a.text);
  });
});
