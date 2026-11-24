/**
 * @jest-environment node
 */
import { asElementId, asRevision, type BimElement, type Level, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { DEFAULT_ELEVATIONS, elementSolids, modelSolids, type Solid } from "../src/native-geometry";

function freshSolids(model: ModelState, levels?: ReadonlySet<string>): Solid[] {
  const out: Solid[] = [];
  for (const el of Object.values(model.elements)) {
    if (levels && !levels.has(el.partition?.level ?? "L1")) continue;
    out.push(...elementSolids(el, DEFAULT_ELEVATIONS, model));
  }
  return out;
}

function sortSolids(solids: readonly Solid[]): Solid[] {
  return [...solids].sort((a, b) => a.elementId.localeCompare(b.elementId) || a.group.localeCompare(b.group) || a.center[0] - b.center[0]);
}

describe("incremental modelSolids equivalence", () => {
  it("matches fresh elementSolids across duct edits, deletions, level changes, and level filters", () => {
    const base = createDemoModel();
    const lvl1: Level = {
      id: asElementId("lvl-1"),
      kind: "level",
      version: 1,
      authoredRev: {},
      name: "L1",
      elevationMm: 0,
      partition: { level: "L1", zone: "Z1", discipline: "architecture" },
    };
    const model: ModelState = {
      ...base,
      elements: { ...base.elements, [lvl1.id]: lvl1 },
    };

    // 1. Cold build
    expect(sortSolids(modelSolids(model))).toEqual(sortSolids(freshSolids(model)));

    // 2. Local edit on a duct segment (incremental path — all other elements reused by reference)
    const seg = Object.values(model.elements).find((e): e is Extract<BimElement, { kind: "duct_segment" }> => e.kind === "duct_segment");
    if (!seg) throw new Error("expected duct_segment in demo model");
    const afterEdit: ModelState = {
      ...model,
      revision: asRevision(Number(model.revision) + 1),
      elements: {
        ...model.elements,
        [seg.id]: { ...seg, version: seg.version + 1, profile: { shape: "rect", width: 550, height: 350 } },
      },
    };
    expect(sortSolids(modelSolids(afterEdit))).toEqual(sortSolids(freshSolids(afterEdit)));

    // 3. Delete one duct segment (incremental removal path)
    const { [seg.id]: _removed, ...restElems } = afterEdit.elements;
    const afterDelete: ModelState = {
      ...afterEdit,
      revision: asRevision(Number(afterEdit.revision) + 1),
      elements: restElems,
    };
    expect(sortSolids(modelSolids(afterDelete))).toEqual(sortSolids(freshSolids(afterDelete)));

    // 4. Level elevation change (non-local kind -> full invalidation)
    const afterLevel: ModelState = {
      ...afterDelete,
      revision: asRevision(Number(afterDelete.revision) + 1),
      elements: { ...afterDelete.elements, [lvl1.id]: { ...lvl1, version: 2, elevationMm: 4200 } },
    };
    expect(sortSolids(modelSolids(afterLevel))).toEqual(sortSolids(freshSolids(afterLevel)));

    // 5. Filtered by level set
    expect(modelSolids(afterLevel, DEFAULT_ELEVATIONS, new Set(["NO_SUCH_LEVEL"]))).toEqual([]);
    const levelName = Object.values(afterLevel.elements).find((e) => e.kind === "duct_segment")?.partition?.level ?? "L1";
    expect(sortSolids(modelSolids(afterLevel, DEFAULT_ELEVATIONS, new Set([levelName])))).toEqual(
      sortSolids(freshSolids(afterLevel, new Set([levelName]))),
    );
  });
});
