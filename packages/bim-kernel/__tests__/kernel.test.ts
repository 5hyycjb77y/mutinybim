/**
 * @jest-environment node
 */
import {
  applyChangeset,
  asElementId,
  buildSheetScene,
  demoSheetDefinition,
  executeCommand,
  planCommit,
  slideLimit,
  validateModel,
  type Changeset,
  type CommandRequest,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;
const id = asElementId;

function el(model: ModelState, key: string) {
  const found = model.elements[key];
  if (!found) throw new Error(`missing ${key}`);
  return found;
}

function request(base: number, command: CommandRequest["command"], name = "Priya", key?: string): CommandRequest {
  return {
    idempotencyKey: key ?? `${name}-${Math.random().toString(36).slice(2)}-key`,
    baseRevision: base,
    actor: { id: name.toLowerCase(), name, kind: "human" },
    command,
  };
}

/** Minimal in-test sequencer: the same planCommit every candidate uses. */
function commitAll(model: ModelState, log: Changeset[], req: CommandRequest) {
  const sinceBase = log.filter((cs) => cs.revision > req.baseRevision);
  const decision = planCommit(model, sinceBase, req, () => "2026-10-16T00:00:00.000Z");
  if (decision.ok) log.push(decision.changeset);
  return decision;
}

describe("demo model", () => {
  it("is valid and fully connected, with airflow totals summed up the tree", () => {
    const model = createDemoModel();
    expect(validateModel(model)).toEqual([]);
    const ahu = el(model, "ahu-1");
    expect(ahu.kind === "equipment" && ahu.totalCfm).toBe(650);
    const trunk = el(model, "seg-trunk");
    expect(trunk.kind === "duct_segment" && trunk.flowCfm).toBe(650);
    const run1 = el(model, "seg-run-1");
    expect(run1.kind === "duct_segment" && run1.flowCfm).toBe(350);
  });
});

describe("slide_branch propagation", () => {
  it("moves the tap, translates the riser and elbow, stretches the run, and keeps the diffuser fixed", () => {
    const model = createDemoModel();
    const res = executeCommand(model, { type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tap = el(res.model, "tap-1");
    const riser = el(res.model, "seg-riser-1");
    const elbow = el(res.model, "elbow-1");
    const run = el(res.model, "seg-run-1");
    const sd = el(res.model, "sd-1");
    if (tap.kind !== "tap" || riser.kind !== "duct_segment" || elbow.kind !== "elbow" || run.kind !== "duct_segment" || sd.kind !== "terminal") {
      throw new Error("unexpected kinds");
    }
    expect(tap.s).toBeCloseTo(10 * FT);
    expect(riser.start.x).toBeCloseTo(10 * FT);
    expect(riser.end.x).toBeCloseTo(10 * FT);
    expect(elbow.position.x).toBeCloseTo(10 * FT);
    expect(run.start.x).toBeCloseTo(10 * FT);
    expect(run.end.x).toBeCloseTo(18 * FT);
    expect(sd.position.x).toBeCloseTo(18 * FT);
    expect(validateModel(res.model)).toEqual([]);
  });

  it("derives the read set and authored writes on the server side", () => {
    const res = executeCommand(createDemoModel(), { type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    if (!res.ok) throw new Error(res.error.message);
    expect(Object.keys(res.readSet)).toEqual(expect.arrayContaining(["tap-1", "seg-trunk", "seg-riser-1", "elbow-1", "seg-run-1"]));
    expect(res.authored).toEqual([{ elementId: "tap-1", field: "s", value: 10 * FT }]);
  });

  it("refuses an impossible slide with a named reason instead of clamping", () => {
    const model = createDemoModel();
    const res = executeCommand(model, { type: "slide_branch", tapId: "tap-1", s: 18 * FT });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("min_straight_length");
    expect(res.error.elementIds).toContain("seg-run-1");
  });

  it("reports the accepted limit and the binding constraint for a drag that goes too far", () => {
    const model = createDemoModel();
    const limit = slideLimit(model, "tap-1", 18 * FT);
    expect(limit.binding?.code).toBe("min_straight_length");
    // Run must keep >= 150 mm: tap stops 150 mm short of the diffuser line.
    // The limit search resolves to 1 mm.
    expect(Math.abs(limit.accepted - (18 * FT - 150))).toBeLessThanOrEqual(1);
    expect(limit.accepted).toBeLessThan(limit.requested);
    const atLimit = executeCommand(model, { type: "slide_branch", tapId: "tap-1", s: limit.accepted });
    expect(atLimit.ok).toBe(true);
  });

  it("a drag cannot pass through its diffuser even when the far side would be valid", () => {
    const model = createDemoModel();
    // tap-2 is at 26 ft, its diffuser at 33 ft. 36 ft is a valid final state (run doubles back)...
    expect(executeCommand(model, { type: "slide_branch", tapId: "tap-2", s: 36 * FT }).ok).toBe(true);
    // ...but a continuous drag stops before the run gets shorter than its minimum.
    const limit = slideLimit(model, "tap-2", 36 * FT);
    expect(limit.binding?.code).toBe("min_straight_length");
    expect(Math.abs(limit.accepted - (33 * FT - 150))).toBeLessThanOrEqual(1);
  });

  it("refuses tap spacing violations and end clearance", () => {
    const model = createDemoModel();
    const tooClose = executeCommand(model, { type: "slide_branch", tapId: "tap-2", s: 12 * FT + 300 });
    expect(tooClose.ok).toBe(false);
    const offEnd = executeCommand(model, { type: "slide_branch", tapId: "tap-1", s: 100 });
    expect(offEnd.ok).toBe(false);
  });

  it("property: random slides never produce an invalid model", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let model = createDemoModel();
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const tapId = rand() < 0.5 ? "tap-1" : "tap-2";
      const s = rand() * 40 * FT;
      const res = executeCommand(model, { type: "slide_branch", tapId, s });
      if (res.ok) {
        expect(validateModel(res.model)).toEqual([]);
        model = res.model;
        accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});

describe("commit policy", () => {
  it("competing authored values conflict instead of last-write-wins", () => {
    let model = createDemoModel();
    const log: Changeset[] = [];
    const big = { shape: "rect" as const, width: 30 * 25.4, height: 12 * 25.4 };
    const bigger = { shape: "rect" as const, width: 32 * 25.4, height: 12 * 25.4 };
    const a = commitAll(model, log, request(0, { type: "resize_run", segmentId: "seg-trunk", profile: big }, "Priya"));
    expect(a.ok).toBe(true);
    if (a.ok) model = a.model;
    const b = commitAll(model, log, request(0, { type: "resize_run", segmentId: "seg-trunk", profile: bigger }, "Avery"));
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.code).toBe("conflict");
    expect(b.conflict?.withActor.name).toBe("Priya");
  });

  it("your own unconfirmed earlier edit is not a conflict with yourself", () => {
    let model = createDemoModel();
    const log: Changeset[] = [];
    const first = commitAll(model, log, request(0, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 }, "Agent"));
    if (!first.ok) throw new Error(first.error.message);
    model = first.model;
    // Same actor, still at base 0 (batch sent before the first confirmed).
    const second = commitAll(model, log, request(0, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 }, "Agent"));
    expect(second.ok).toBe(true);
  });

  it("different diffusers on the same trunk both commit and totals are correct", () => {
    let model = createDemoModel();
    const log: Changeset[] = [];
    const a = commitAll(model, log, request(0, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 }, "Priya"));
    if (!a.ok) throw new Error(a.error.message);
    model = a.model;
    const b = commitAll(model, log, request(0, { type: "set_terminal_cfm", terminalId: "sd-2", cfm: 250 }, "Avery"));
    if (!b.ok) throw new Error(b.error.message);
    model = b.model;
    const ahu = el(model, "ahu-1");
    expect(ahu.kind === "equipment" && ahu.totalCfm).toBe(650);
    const trunk = el(model, "seg-trunk");
    expect(trunk.kind === "duct_segment" && trunk.flowCfm).toBe(650);
    expect(b.changeset.rebased).toBe(true);
  });

  it("a propagation that would move another user's just-placed tap conflicts", () => {
    let model = createDemoModel();
    const log: Changeset[] = [];
    // Avery places tap-2 deliberately.
    const placed = commitAll(model, log, request(0, { type: "slide_branch", tapId: "tap-2", s: 27 * FT }, "Avery"));
    if (!placed.ok) throw new Error(placed.error.message);
    model = placed.model;
    // Priya, still at revision 0, moves the unit along the trunk; that shifts every tap.
    const move = commitAll(model, log, request(0, { type: "move_equipment", equipmentId: "ahu-1", delta: { x: 600, y: 0 } }, "Priya"));
    expect(move.ok).toBe(false);
    if (move.ok) return;
    expect(move.error.code).toBe("conflict");
    expect(move.conflict?.withActor.name).toBe("Avery");
    expect(move.conflict?.reason).toBe("intent_broken");
  });

  it("the same move with no unseen edits commits and the branches absorb it", () => {
    const model = createDemoModel();
    const log: Changeset[] = [];
    const move = commitAll(model, log, request(0, { type: "move_equipment", equipmentId: "ahu-1", delta: { x: 600, y: 0 } }, "Priya"));
    if (!move.ok) throw new Error(move.error.message);
    expect(validateModel(move.model)).toEqual([]);
    const sd = el(move.model, "sd-1");
    expect(sd.kind === "terminal" && sd.position.x).toBeCloseTo(18 * FT);
  });

  it("applies changesets in order and detects gaps", () => {
    const model = createDemoModel();
    const log: Changeset[] = [];
    const a = commitAll(model, log, request(0, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 }));
    if (!a.ok) throw new Error(a.error.message);
    const b = commitAll(a.model, log, request(1, { type: "set_terminal_cfm", terminalId: "sd-2", cfm: 200 }));
    if (!b.ok) throw new Error(b.error.message);
    expect(() => applyChangeset(model, b.changeset)).toThrow(/does not follow/);
    const replayed = applyChangeset(applyChangeset(model, a.changeset), b.changeset);
    expect(replayed.revision).toBe(2);
    expect(JSON.stringify(replayed.elements)).toBe(JSON.stringify(b.model.elements));
  });
});

describe("sheet scene", () => {
  it("draws at true scale: 10 ft at 1/4\" = 1'-0\" is 2.5 inches on paper", () => {
    const scene = buildSheetScene(createDemoModel(), demoSheetDefinition());
    const def = demoSheetDefinition();
    expect((10 * FT) / def.scale).toBeCloseTo(2.5 * 25.4, 6);
    expect(scene.paper).toEqual({ x: 36 * 25.4, y: 24 * 25.4 });
    expect(scene.tags.find((t) => t.elementId === id("sd-1"))?.text).toBe("SD-1 / 350 CFM");
    expect(scene.schedule.map((r) => r.mark)).toEqual(["RTU-1", "SD-1", "SD-2"]);
  });

  it("tags follow the model: moving a tap moves its run tag", () => {
    const model = createDemoModel();
    const before = buildSheetScene(model, demoSheetDefinition()).tags.find((t) => t.elementId === id("seg-run-1"));
    const res = executeCommand(model, { type: "slide_branch", tapId: "tap-1", s: 6 * FT });
    if (!res.ok) throw new Error(res.error.message);
    const after = buildSheetScene(res.model, demoSheetDefinition()).tags.find((t) => t.elementId === id("seg-run-1"));
    expect(before && after && after.at.x < before.at.x).toBe(true);
  });
});
