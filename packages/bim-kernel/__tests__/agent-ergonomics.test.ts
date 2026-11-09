/**
 * @jest-environment node
 *
 * Bug log 2026-10-23 (site-7352), ergonomics items: a field an edit carries
 * is used or refused by name, never dropped (#2, #4); refusals name the real
 * cause (#3 crop follow, #5 a removed viewport's id, #25 turn depth); a run
 * 0.05 mm off a connector's height meets it (#17); a duct system with no
 * terminals says its pressure isn't meaningful (#13).
 */
import {
  DEFAULT_SETTINGS,
  builtinPartType,
  commandIssueMessage,
  commandSchema,
  executeCommand,
  planCommit,
  type Command,
  type CommandRequest,
  type LibraryEntry,
  type ModelState,
  type RunSegment,
} from "../src";
import {
  systemPressure,
} from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-23T00:00:00.000Z";
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const DUCT = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };

let n = 0;
function commit(head: ModelState, command: Command): ModelState {
  n += 1;
  const req: CommandRequest = { idempotencyKey: `ergo-${n}-key`, baseRevision: head.revision, actor: { id: "a", name: "Agent", kind: "agent" }, command };
  const d = planCommit(head, [], req, NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

function refused(head: ModelState, command: Command) {
  const r = executeCommand(head, command);
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error;
}

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}

describe("strict command schemas (#2, #4)", () => {
  test("set_view_crop with crop_min_ft is refused by name, with what it takes and in what unit", () => {
    const raw = { type: "set_view_crop", viewId: "v-1", crop_min_ft: { x: 0, y: 0 }, crop_max_ft: { x: 175, y: 100 } };
    const parsed = commandSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = commandIssueMessage(parsed.error, raw);
    expect(message).toMatch(/^set_view_crop doesn't take crop_min_ft, crop_max_ft/);
    expect(message).toMatch(/crop \{ min: \{x, y\}, max: \{x, y\} \} in millimetres/);
  });

  test("inside a batch the step is named by its path", () => {
    const raw = { type: "batch_documents", commands: [{ type: "rename_view", viewId: "v-1", name: "A" }, { type: "set_view_crop", viewId: "v-1", crop_min_ft: { x: 0, y: 0 } }] };
    const parsed = commandSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(commandIssueMessage(parsed.error, raw)).toMatch(/set_view_crop doesn't take crop_min_ft \(at commands\.1\)/);
  });

  test("create_view with a top-level level is refused by name, not created without its level", () => {
    const raw = { type: "create_view", viewId: "v-2", name: "L1", viewType: "floor_plan", level: "L1" };
    const parsed = commandSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(commandIssueMessage(parsed.error, raw)).toMatch(/create_view doesn't take level.*props \{ level, scale/);
  });
});

/** Demo model, a level-1 plan with a 40 x 30 ft crop placed at 1/4" = 1'-0" on M-101. */
function placedPlan(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Plan", viewType: "floor_plan", crop: { min: { x: 0, y: 0 }, max: { x: 40 * FT, y: 30 * FT } }, props: { level: "L1", scale: 48 } });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "v-plan", center: { x: 300, y: 250 } });
  return m;
}

describe("a placed view's crop (#3)", () => {
  // 175 ft read as 175 mm put the crop's centre ~20 ft from the old one: the viewport followed it off the sheet.
  const shifted = { min: { x: 300 * FT, y: 0 }, max: { x: 340 * FT, y: 30 * FT } };

  test("the refusal names the crop shift and the viewport's old and new centre, and the keep-centre option", () => {
    const err = refused(placedPlan(), { type: "set_view_crop", viewId: "v-plan", crop: shifted });
    expect(err.message).toMatch(/crop centre moves \(91440, 0\) mm in the model/);
    expect(err.message).toMatch(/from \(300, 250\) to \(\d+, 250\) mm on paper, off the \d+ x \d+ mm sheet/);
    expect(err.message).toMatch(/keepViewportCenter: true/);
    expect(err.elementIds).toEqual(["vp-1", "v-plan"]);
  });

  test("keepViewportCenter keeps the viewport where it is and takes the new crop", () => {
    const m = commit(placedPlan(), { type: "set_view_crop", viewId: "v-plan", crop: shifted, keepViewportCenter: true });
    const vp = m.elements["vp-1"];
    expect(vp?.kind === "viewport" && vp.center).toEqual({ x: 300, y: 250 });
    const view = m.elements["v-plan"];
    expect(view?.kind === "view" && view.cropMin.x).toBe(300 * FT);
  });
});

describe("a removed viewport's id (#5)", () => {
  test("is refused as a removed viewport's, not 'already used by another element'", () => {
    const m = commit(placedPlan(), { type: "remove_viewport", viewportId: "vp-1" });
    const err = refused(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "v-plan", center: { x: 300, y: 250 } });
    expect(err.message).toBe("vp-1 belonged to a removed viewport; ids aren't reused. Use a new id.");
    expect(err.elementIds).toEqual(["vp-1"]);
  });
});

function levelWithTrunk(): ModelState {
  let m: ModelState = { modelId: "ergo", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return commit(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
}

describe("pressure with no terminals (#13)", () => {
  test("a connected duct with nothing drawing air is not calculable, and says why", () => {
    const report = systemPressure(levelWithTrunk(), "sys-sa");
    expect(report?.calculable).toBe(false);
    expect(report?.reason).toMatch(/No terminals with airflow on Supply Air 1, so its pressure isn't meaningful/);
  });
});

describe("a run meeting a connector a hair off its height (#17)", () => {
  test("continuing an open end 0.05 mm higher snaps to it and routes level", () => {
    const m = commit(levelWithTrunk(), { type: "route_run", idPrefix: "more", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 10 * FT + 0.05, system: SA, points: [{ x: 30 * FT, y: 0 }], from: { kind: "run_end", elementId: "trunk-s1", port: "end" } });
    const seg = m.elements["more-s1"] as RunSegment | undefined;
    expect(seg?.start.z).toBeCloseTo(10 * FT, 6);
    expect(seg?.end.z).toBeCloseTo(10 * FT, 6);
  });
});

describe("routing onto a down-facing connector (#25)", () => {
  test("the first refusal states the turn depth the run needs", () => {
    let m = levelWithTrunk();
    const rtu = lib("builtin:rtu-5-ton@1");
    m = commit(m, { type: "place_part", partId: "rtu", typeId: rtu.id, partType: rtu.definition, levelId: "lvl-1", position: { x: 0, y: 20 * FT }, offsetMm: 12 * FT, mark: "RTU-1" });
    const err = refused(m, { type: "route_run", idPrefix: "bad", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 12 * FT, system: SA, points: [{ x: 10 * FT, y: 20 * FT }], from: { kind: "part", partId: "rtu", connectorId: "supply" } });
    expect(err.message).toMatch(/RTU-1's supply faces down, so the run has to be below it \(it is at 12 ft\) by about [\d.]+ ft or more for a 90° elbow plus the shortest straight piece: at [\d.]+ ft or lower/);
  });
});
