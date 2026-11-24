/**
 * @jest-environment node
 *
 * Verifies `building.column` (`height`, `topLevel`, `topOffset`, `baseOffset`,
 * `rotationDeg`, `section`, `grade`, `mark`), `building.beam`, `building.footing`,
 * and one-way `building.floor` end-to-end through `defineScript` + `runScript`.
 */
import { columnVerticalSpan, DEFAULT_SETTINGS, ELEMENTS_CREATE_FEATURE, executeCommand, WALLS_TOP_CONSTRAINT_FEATURE, withUpgradePolicy, type Column, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { structuralLoadPath } from "@permitzip/bim-pack-structural";
import { building, defineScript, runScript, sliceModel, units } from "../src";

describe("building structural script helpers", () => {
  beforeAll(() => {
    installFirstPartyAddOns();
  });

  it("creates height-constrained and top-level-tied columns, beams, footings, and one-way decks cleanly", async () => {
    const empty: ModelState = { modelId: "script-struct", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    const script = defineScript({
      kind: "layout",
      reads: { levels: true },
      parameters: {},
      run(ctx) {
        building.level(ctx, { id: "L1", name: "Level 1", elevation: units.ft(0) });
        building.level(ctx, { id: "L2", name: "Level 2", elevation: units.ft(12) });
        building.level(ctx, { id: "ROOF", name: "Roof", elevation: units.ft(22) });

        building.footing(ctx, { id: "f1", level: "L1", at: { x: units.ft(0), y: units.ft(0) }, width: units.ft(5), thickness: units.in(18), mark: "F1" });
        building.footing(ctx, { id: "f2", level: "L1", at: { x: units.ft(20), y: units.ft(0) }, width: units.ft(5), thickness: units.in(18), mark: "F2" });

        building.column(ctx, { id: "c1", level: "L1", at: { x: units.ft(0), y: units.ft(0) }, topLevel: "L2", topOffset: units.in(-8), section: "W10x33", grade: "A992", mark: "C1", rotationDeg: 90 });
        building.column(ctx, { id: "c2", level: "L1", at: { x: units.ft(20), y: units.ft(0) }, height: units.ft(11.3333), section: "W10x33", grade: "A992", mark: "C2" });
        building.column(ctx, { id: "c3", level: "L1", at: { x: units.ft(0), y: units.ft(14) }, topLevel: "ROOF", topOffset: units.in(-4), baseOffset: units.in(6), section: "W8x31", mark: "C3" });

        building.beam(ctx, { id: "b1", level: "L2", from: { x: units.ft(0), y: units.ft(0) }, to: { x: units.ft(20), y: units.ft(0) }, section: "W16x26", grade: "A992", camber: units.in(0.75), mark: "B1" });
        building.floor(ctx, {
          id: "deck1",
          level: "L2",
          points: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(20), y: units.ft(0) },
            { x: units.ft(20), y: units.ft(14) },
            { x: units.ft(0), y: units.ft(14) },
          ],
          thickness: units.in(6),
          classId: "struct.floor_deck",
          spanDirectionDeg: 90,
          occupancy: "office_space",
        });
      },
    });

    const out = await runScript(script, {
      slice: sliceModel(empty, script.manifest.reads, [], [ELEMENTS_CREATE_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE]),
      values: {},
      scriptHash: "sha256:struct-test",
    });
    expect(out.kind).toBe("edits");
    let model = empty;
    withUpgradePolicy(
      () => true,
      () => {
        if (out.kind !== "edits") return;
        for (const cmd of out.batches) {
          const res = executeCommand(model, cmd);
          if (!res.ok) throw new Error(`${cmd.type} failed: ${res.error.code} — ${res.error.message}`);
          model = { ...res.model, revision: (model.revision + 1) as Revision };
        }
      },
    );

    const c1 = model.elements["c1"] as Column;
    const c2 = model.elements["c2"] as Column;
    const c3 = model.elements["c3"] as Column;
    expect(columnVerticalSpan(model.elements, c1, 0).heightMm).toBeCloseTo(12 * 304.8 - 8 * 25.4, 0);
    expect(c1.placement).toMatchObject({ kind: "point", topLevelId: "L2", topOffsetMm: -Math.round(8 * 25.4 * 10) / 10, rotationDeg: 90 });
    expect(columnVerticalSpan(model.elements, c2, 0).heightMm).toBeCloseTo(11.3333 * 304.8, 0);
    const span3 = columnVerticalSpan(model.elements, c3, 0);
    expect(span3.baseZMm).toBeCloseTo(6 * 25.4, 1);
    expect(span3.topLevelId).toBe("ROOF");

    const lp = structuralLoadPath(model);
    expect(lp.beams.length).toBe(1);
    expect(lp.footings.length).toBe(2);
    expect(lp.footings[0]!.load.total).toBeGreaterThan(0);
    expect(lp.footings[1]!.load.total).toBeGreaterThan(0);
  });
});
