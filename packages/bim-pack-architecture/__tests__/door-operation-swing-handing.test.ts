/**
 * @jest-environment node
 *
 * Verifies arch.door schema parameters (`door_operation`, `door_swing`,
 * `door_handing`), 2D plan graphics (`DOOR_PLAN_GRAPHICS`), 3D bodies
 * (`DOOR_BODY`), schedule fields (`swing`, `handing`, `swing_side`), and
 * `flipDoorOperation` across every IFC4 door operation type.
 */
import {
  DEFAULT_SETTINGS,
  executeCommand,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
  type PlanGraphic,
  type Revision,
} from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import {
  ARCHITECTURE_FIELD_PROVIDER,
  ARCHITECTURE_PACK,
  ARCHITECTURE_PARAMETER_SET,
  DOOR_BODY,
  DOOR_HANDING_KEY,
  DOOR_OPERATION_KEY,
  DOOR_PLAN_GRAPHICS,
  DOOR_SWING_KEY,
  flipDoorOperation,
  resolveDoorHanding,
  resolveDoorOperation,
  resolveDoorSide,
} from "../src";

type Arc = Extract<PlanGraphic, { form: "arc" }>;
type Line = Extract<PlanGraphic, { form: "line" }>;
type Poly = Extract<PlanGraphic, { form: "polyline" }>;

function run(commands: readonly Command[]): ModelState {
  let cur: ModelState = { modelId: "door-ops", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) throw new Error(`${command.type} failed: ${res.error.code} — ${res.error.message}`);
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

function makeDoorModel(values: Record<string, string | number | boolean> = {}, side: 1 | -1 = 1, widthMm = 1800): ModelState {
  return withPackSet(PackSet.create([ARCHITECTURE_PACK]), () =>
    withUpgradePolicy(
      () => true,
      () =>
        run([
          { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
          { type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } },
          { type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", mark: "D1", hostId: "w", s: 3000, side, size: { widthMm, heightMm: 2100 }, values },
        ]),
    ),
  );
}

const planOf = (m: ModelState): readonly PlanGraphic[] =>
  DOOR_PLAN_GRAPHICS.planGraphics(m.elements.d!, { elements: m.elements, scale: 100, levelId: "L1", detail: "medium", drawing: "view", lookingUp: false, connectedTo: () => null }) ?? [];

const bodyOf = (m: ModelState) => DOOR_BODY.solids(m.elements.d!, { elements: m.elements, floorMm: 0 }) ?? [];

const arcs = (g: readonly PlanGraphic[]) => g.filter((x): x is Arc => x.form === "arc");
const lines = (g: readonly PlanGraphic[]) => g.filter((x): x is Line => x.form === "line");
const polys = (g: readonly PlanGraphic[]) => g.filter((x): x is Poly => x.form === "polyline" && x.closed);

describe("arch.door operation, swing, and handing", () => {
  it("registers door_operation, door_swing, and door_handing parameters on arch.door", () => {
    const keys = ARCHITECTURE_PARAMETER_SET.parameters.filter((p) => p.classes.includes("arch.door")).map((p) => p.key);
    expect(keys).toContain(DOOR_OPERATION_KEY);
    expect(keys).toContain(DOOR_SWING_KEY);
    expect(keys).toContain(DOOR_HANDING_KEY);
  });

  it("renders DOUBLE_SWING_LEFT / RIGHT as single-leaf double-acting (2 opposite arcs, 1 centered 3D leaf)", () => {
    const left = makeDoorModel({ [DOOR_OPERATION_KEY]: "DOUBLE_SWING_LEFT" }, 1, 1000);
    const leftArcs = arcs(planOf(left));
    expect(leftArcs).toHaveLength(2);
    expect(leftArcs.map((a) => a.center.y).sort((a, b) => a - b)).toEqual([-100, 100]);
    expect(leftArcs[0]?.center.x).toBe(leftArcs[1]?.center.x);
    expect(leftArcs[0]?.radiusMm).toBe(910); // full clear width (1000 - 2*45)
    // 3D: 3 frame pieces + 1 centered leaf = 4 boxes (NOT 2 leaves!)
    expect(bodyOf(left)).toHaveLength(4);

    const right = makeDoorModel({ [DOOR_OPERATION_KEY]: "DOUBLE_SWING_RIGHT" }, 1, 1000);
    const rightArcs = arcs(planOf(right));
    expect(rightArcs).toHaveLength(2);
    expect(rightArcs[0]?.center.x).toBeGreaterThan(leftArcs[0]!.center.x);
    expect(bodyOf(right)).toHaveLength(4);
  });

  it("renders DOUBLE_DOOR_DOUBLE_SWING with 4 arcs (both leaves swinging both ways) and 2 3D leaves", () => {
    const m = makeDoorModel({ [DOOR_OPERATION_KEY]: "DOUBLE_DOOR_DOUBLE_SWING" }, 1, 1800);
    const a = arcs(planOf(m));
    expect(a).toHaveLength(4);
    expect(a.filter((x) => x.center.y === 100)).toHaveLength(2);
    expect(a.filter((x) => x.center.y === -100)).toHaveLength(2);
    // 3D: 3 frame boxes + 2 half leaves = 5
    expect(bodyOf(m)).toHaveLength(5);
  });

  it("renders SWING_FIXED_LEFT and SWING_FIXED_RIGHT with active swing leaf + fixed sidelite in 2D and 3D", () => {
    const l = makeDoorModel({ [DOOR_OPERATION_KEY]: "SWING_FIXED_LEFT" }, 1, 1500);
    const lArcs = arcs(planOf(l));
    expect(lArcs).toHaveLength(1);
    expect(lArcs[0]?.radiusMm).toBeCloseTo((1500 - 90) * 0.6, 1);
    // 3D has frame + mullion + active leaf + glazing sidelite + bottom kickplate
    expect(bodyOf(l).some((p) => p.look === "glazing")).toBe(true);

    const r = makeDoorModel({ [DOOR_OPERATION_KEY]: "SWING_FIXED_RIGHT" }, 1, 1500);
    const rArcs = arcs(planOf(r));
    expect(rArcs).toHaveLength(1);
    expect(rArcs[0]!.center.x).toBeGreaterThan(lArcs[0]!.center.x);
  });

  it("distinguishes SLIDING_TO_LEFT, SLIDING_TO_RIGHT, and DOUBLE_DOOR_SLIDING with directional arrows", () => {
    const sl = planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "SLIDING_TO_LEFT" }, 1, 1800));
    const sr = planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "SLIDING_TO_RIGHT" }, 1, 1800));
    const sd = planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "DOUBLE_DOOR_SLIDING" }, 1, 2400));
    expect(arcs(sl)).toEqual([]);
    // Single-slider arrow has 3 line segments (shaft + 2 wings); arrow tip points -x for LEFT and +x for RIGHT
    const slShaft = lines(sl)[0]!;
    const srShaft = lines(sr)[0]!;
    expect(slShaft.b.x).toBeLessThan(slShaft.a.x);
    expect(srShaft.b.x).toBeGreaterThan(srShaft.a.x);
    // Double bi-parting slider has 4 panel polylines (+ mask + 2 jambs = 7) and 2 arrows (6 lines)
    expect(polys(sd)).toHaveLength(7);
    expect(lines(sd)).toHaveLength(6);
  });

  it("renders FOLDING_TO_LEFT, FOLDING_TO_RIGHT, DOUBLE_DOOR_FOLDING, ROLLINGUP (dashed tracks), and REVOLVING", () => {
    const fl = lines(planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "FOLDING_TO_LEFT" }, 1, 1200)));
    const fr = lines(planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "FOLDING_TO_RIGHT" }, 1, 1200)));
    const fd = lines(planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "DOUBLE_DOOR_FOLDING" }, 1, 1800)));
    expect(fl[0]?.a.x).toBeLessThan(3000);
    expect(fr[0]?.a.x).toBeGreaterThan(3000);
    expect(fd).toHaveLength(6); // 2 symmetric pairs x (2 fold leaves + 1 dashed track)

    const roll = lines(planOf(makeDoorModel({ [DOOR_OPERATION_KEY]: "ROLLINGUP" }, 1, 3000)));
    expect(roll).toHaveLength(3);
    expect(roll.every((l) => l.dash === "dashed")).toBe(true);

    const revModel = makeDoorModel({ [DOOR_OPERATION_KEY]: "REVOLVING" }, 1, 2200);
    const revPlan = planOf(revModel);
    expect(arcs(revPlan)).toHaveLength(2); // full circular drum
    expect(lines(revPlan)).toHaveLength(2); // 4-wing cross
    expect(bodyOf(revModel).filter((p) => p.look === "glazing")).toHaveLength(2);
  });

  it("honors door_swing (OUTWARD/INWARD), door_handing (LH/RH/LHR/RHR), explicit host.side override, and schedule fields", () => {
    const outward = makeDoorModel({ [DOOR_SWING_KEY]: "OUTWARD" }, 1, 900);
    expect(resolveDoorSide(outward.elements.d!, outward.elements)).toBe(-1);
    expect(arcs(planOf(outward))[0]?.center.y).toBe(-100);

    const rhr = makeDoorModel({ [DOOR_HANDING_KEY]: "RHR" }, 1, 900);
    expect(resolveDoorOperation(rhr.elements.d!, rhr.elements)).toBe("SINGLE_SWING_RIGHT");
    expect(resolveDoorSide(rhr.elements.d!, rhr.elements)).toBe(-1);
    expect(resolveDoorHanding(rhr.elements.d!, rhr.elements)).toBe("RHR");
    const rhrArc = arcs(planOf(rhr))[0]!;
    expect(rhrArc.center.x).toBeGreaterThan(3000);
    expect(rhrArc.center.y).toBe(-100);

    // Explicit host.side overrides door_swing
    const forced = makeDoorModel({ [DOOR_SWING_KEY]: "OUTWARD", "host.side": 1 }, 1, 900);
    expect(resolveDoorSide(forced.elements.d!, forced.elements)).toBe(1);

    // Fields provide swing, handing, and swing_side even for default doors
    const def = makeDoorModel({}, 1, 900);
    const fieldOf = (path: string) => ARCHITECTURE_FIELD_PROVIDER.fields?.find((f) => f.path === path && f.classes.includes("arch.door"))?.read?.(def.elements.d as BimElement, { elements: def.elements });
    expect(fieldOf("swing")).toBe("Single swing left");
    expect(fieldOf("handing")).toBe("LH");
    expect(fieldOf("swing_side")).toBe("Inward (+1)");

    // flipDoorOperation covers all handed operations and returns null for symmetric ones
    expect(flipDoorOperation("SINGLE_SWING_LEFT")).toBe("SINGLE_SWING_RIGHT");
    expect(flipDoorOperation("DOUBLE_SWING_RIGHT")).toBe("DOUBLE_SWING_LEFT");
    expect(flipDoorOperation("SWING_FIXED_LEFT")).toBe("SWING_FIXED_RIGHT");
    expect(flipDoorOperation("SLIDING_TO_LEFT")).toBe("SLIDING_TO_RIGHT");
    expect(flipDoorOperation("FOLDING_TO_RIGHT")).toBe("FOLDING_TO_LEFT");
    expect(flipDoorOperation("DOUBLE_DOOR_SINGLE_SWING")).toBeNull();
    expect(flipDoorOperation("ROLLINGUP")).toBeNull();
    expect(flipDoorOperation("REVOLVING")).toBeNull();
  });
});
