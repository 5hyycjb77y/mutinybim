/**
 * @jest-environment node
 *
 * The `lint` block one saved edit returns: new findings near the edit,
 * what it resolved, what is around it, the 2 KB / 8-finding caps, and
 * "deferred" (never a slower save) when the budget runs out.
 */
import { capBlock, LintEngine, lintEdit, LINT_BLOCK_MAX_BYTES, refusalContext, type LintBlock } from "../src";
import { config, FT, linkedBuilding, Model, RETURN, SUPPLY } from "./fixtures";

function edit(engine: LintEngine, m: Model, apply: () => string[]): LintBlock {
  const before = m.head;
  const changed = apply();
  // No time budget: these check what the lint finds, not how fast the machine is.
  // The budget has its own test below.
  const block = lintEdit(engine, { before, after: m.head, changedIds: changed, options: { config: config() }, budgetMs: Number.POSITIVE_INFINITY });
  expect(block.status).toBe("ok");
  return block;
}

describe("lint block", () => {
  it("an RTU off the roof edge and a supply duct through the return: new findings; the fixes list them resolved", () => {
    const m = new Model();
    const engine = new LintEngine();
    engine.build(m.head, [linkedBuilding()]);

    const placed = edit(engine, m, () => m.placeRtu("rtu-1", { x: 70 * FT, y: 20 * FT }));
    expect(placed.status).toBe("ok");
    expect(placed.new.map((f) => f.rule)).toEqual(["outside-building", "floating-equipment"]);
    expect(placed.new[0]?.ids).toEqual(["rtu-1", "linked:2Fq-roof-slab"]);
    expect(placed.new[0]?.fix).toMatch(/^bim_move_elements: /);
    expect(placed.near.level).toBe("ROOF");

    edit(engine, m, () => m.duct("ra", RETURN, [[30, 0], [30, 30]], 9));
    const crossed = edit(engine, m, () => m.duct("sa", SUPPLY, [[10, 10], [50, 10]], 9));
    expect(crossed.new.map((f) => f.rule)).toEqual(["clash-hard"]);
    expect(crossed.new[0]?.msg).toMatch(/Supply Air 1 .* passes 12 in\. into Return Air 1/);
    expect(crossed.near.level).toBe("Level 1");
    expect(crossed.near.within.some((w) => w.startsWith("Return Air 1"))).toBe(true);
    expect(crossed.open_errors).toBe(1);

    const moved = edit(engine, m, () => m.ok({ type: "move_elements", ids: ["rtu-1"], delta: { x: -30 * FT, y: 0 } }));
    expect(moved.new).toEqual([]);
    expect(moved.resolved).toEqual(["floating-equipment:rtu-1", "outside-building:rtu-1|linked:2Fq-roof-slab"]);
    expect(moved.near.host).toBe('linked ROOF top 24\'-6"');

    const segment = Object.values(m.head.elements).find((e) => e.kind === "run_segment" && e.systemId === "sys-ra");
    if (!segment) throw new Error("no return segment");
    const dropped = edit(engine, m, () => m.ok({ type: "change_elevation", idPrefix: "drop", segmentId: segment.id, fromMm: 5 * FT, toMm: 15 * FT, elevationMm: 6 * FT, style: "90" }));
    expect(dropped.resolved.some((r) => r.startsWith("clash-hard:"))).toBe(true);
    expect(dropped.new.filter((f) => f.sev === "error")).toEqual([]);
  });

  it("stays under 2 KB and 8 findings, saying it was truncated", () => {
    const m = new Model();
    const engine = new LintEngine();
    engine.build(m.head);
    for (let i = 0; i < 12; i++) edit(engine, m, () => m.duct(`ra${i}`, RETURN, [[2 + i * 3, 0], [2 + i * 3, 30]], 9));
    const block = edit(engine, m, () => m.duct("sa", SUPPLY, [[0, 10], [45, 10]], 9));
    expect(block.new.length).toBeLessThanOrEqual(8);
    expect(block.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(block)).length).toBeLessThanOrEqual(LINT_BLOCK_MAX_BYTES);
  });

  it("caps a block whose messages alone pass 2 KB", () => {
    const long = { rule: "clash-hard", sev: "error" as const, ids: ["a", "b"], msg: "x".repeat(160), fix: "bim_offset_run: " + "y".repeat(100) };
    const block: LintBlock = { status: "ok", ruleset: "default", rev: 1, ms: 1, new: Array.from({ length: 8 }, () => long), resolved: [], near: { level: null, room: null, host: null, radius_ft: 10, within: [] }, open_errors: 8, truncated: false };
    const capped = capBlock(block);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(LINT_BLOCK_MAX_BYTES);
    expect(capped.truncated).toBe(true);
    expect(capped.new.length).toBeGreaterThan(0);
  });

  it("over budget returns deferred and still moves the engine to the new revision", () => {
    const m = new Model();
    const engine = new LintEngine();
    engine.build(m.head);
    const before = m.head;
    const changed = m.duct("sa", SUPPLY, [[0, 10], [45, 10]], 9);
    const block = lintEdit(engine, { before, after: m.head, changedIds: changed, options: { config: config() }, budgetMs: -1 });
    expect(block.status).toBe("deferred");
    expect(block.reason).toMatch(/budget/);
    expect(engine.revision).toBe(m.head.revision);
  });

  it("a refusal names the open issue on the element it blames", () => {
    const m = new Model();
    const ids = m.duct("sa", SUPPLY, [[0, 0], [20, 0]], 9);
    const seg = m.head.elements[ids.find((x) => x.startsWith("sa-s")) as string];
    if (seg?.kind !== "run_segment") throw new Error("no segment");
    m.put({ ...seg, levelId: "lvl-gone" as typeof seg.levelId });
    expect(refusalContext(m.head, [seg.id]).blocking[0]).toMatch(/which does not exist/);
  });
});
