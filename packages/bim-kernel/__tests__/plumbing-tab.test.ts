/**
 * @jest-environment node
 *
 * The kernel side of the Plumbing tab: each system's look (colour, line
 * pattern, weight) and the command that changes it, the pipe types catalog
 * (built-in types, project records, fittings that follow the material), and
 * where the auto-sizing setting and demand curve are kept (project record,
 * per-system override). Before this a system had no look of its own (every
 * pipe drew green in 3D), there were no pipe types, and the sizing setting
 * had nowhere to live.
 */
import { DEFAULT_SETTINGS, SYSTEM_PATTERN_DASH, commandSchema, executeCommand, planCommit, systemStyle, type Command, type CommitDecision, type MepSystem, type ModelState, type Pen, type RunSegment, type RunSize } from "../src";
import { BUILTIN_PIPE_TYPES, pipeTypeFittings, pipeTypeMismatch, pipeTypeOf, pipeTypeSchema, projectPipeTypes, projectPlumbingSettings, sizingInputs } from "@permitzip/bim-pack-plumbing";
import { drawRunSegment } from "../src/drawing/runs";

const FT = 304.8;
const IN = 25.4;

let n = 0;
function plan(model: ModelState, command: Command): CommitDecision {
  return planCommit(model, [], { idempotencyKey: `ptab-${++n}-key`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
}
function commit(model: ModelState, command: Command): ModelState {
  const d = plan(model, command);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}
function refusal(model: ModelState, command: Command): string {
  const d = plan(model, command);
  if (d.ok) throw new Error(`${command.type} was expected to be refused`);
  return d.error.message;
}
function system(m: ModelState, id: string): MepSystem {
  const el = m.elements[id];
  if (el?.kind !== "mep_system") throw new Error(`${id} is not a system`);
  return el;
}

const pex = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "pex" });
const pvc = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "pvc" });

function model(): ModelState {
  let m: ModelState = { modelId: "ptab", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: pex(1), elevationMm: 9 * FT, system: { id: "sys-cw", kind: "domestic_cold_water", name: "DCW-1" }, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  m = commit(m, { type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "pipe", size: pvc(2), elevationMm: 9 * FT, system: { id: "sys-v", kind: "vent", name: "Vent 1" }, points: [{ x: 0, y: 5 * FT }, { x: 20 * FT, y: 5 * FT }] });
  m = commit(m, { type: "route_run", idPrefix: "san", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system: { id: "sys-gw", kind: "sanitary", name: "Grease waste" }, points: [{ x: 0, y: 10 * FT }, { x: 20 * FT, y: 10 * FT }] });
  return m;
}

function planLines(m: ModelState, segId: string): Array<{ pen: Pen; dash: number[] | undefined }> {
  const el = m.elements[segId];
  if (el?.kind !== "run_segment") throw new Error(segId);
  const out: Array<{ pen: Pen; dash: number[] | undefined }> = [];
  drawRunSegment(m, el as RunSegment, (_a, _b, pen, dash) => out.push({ pen, dash }), null, 48);
  return out;
}

describe("system look: colour on screen, line pattern and weight on screen and paper", () => {
  const m = model();

  it("each kind has a standard look: cold water blue dash-dot, vent dashed, sanitary brown solid", () => {
    expect(systemStyle(system(m, "sys-cw"))).toMatchObject({ colour: "#1f6fd1", pattern: "dash_dot", weight: undefined });
    expect(systemStyle(system(m, "sys-v"))).toMatchObject({ pattern: "dashed", dash: [4, 2] });
    expect(systemStyle(system(m, "sys-gw"))).toMatchObject({ colour: "#8a5a2b", pattern: "solid", dash: undefined });
  });

  it("vents print dashed: the plan line of a vent pipe carries the vent dash, and the printed patterns match what drew before", () => {
    expect(planLines(m, "v-s1")).toEqual([{ pen: "wide", dash: [4, 2] }]);
    expect(planLines(m, "cw-s1")).toEqual([{ pen: "wide", dash: [6, 1.5, 1, 1.5] }]);
    expect(planLines(m, "san-s1")).toEqual([{ pen: "wide", dash: undefined }]);
  });

  it("a system overrides its look: grease waste heavy and darker; the plan prints it heavy; null goes back to standard", () => {
    const heavy = commit(m, { type: "set_system_graphics", systemId: "sys-gw", colour: "#5A3A1B", weight: "heavy" });
    expect(systemStyle(system(heavy, "sys-gw"))).toMatchObject({ colour: "#5a3a1b", weight: "heavy", overridden: { colour: true, pattern: false, weight: true } });
    expect(planLines(heavy, "san-s1")).toEqual([{ pen: "heavy", dash: undefined }]);
    const d = executeCommand(m, { type: "set_system_graphics", systemId: "sys-gw", colour: "#5a3a1b", weight: "heavy" });
    if (!d.ok) throw new Error("refused");
    expect(d.summary?.join(" ")).toBe("Grease waste now draws with colour #5a3a1b, heavy lines in 3D, plans and print");
    const back = commit(heavy, { type: "set_system_graphics", systemId: "sys-gw", colour: null, weight: null });
    expect(system(back, "sys-gw").graphics).toBeUndefined();
    expect(systemStyle(system(back, "sys-gw")).colour).toBe("#8a5a2b");
  });

  it("a cold water system drawn dashed and a second blue: only that system changes", () => {
    const next = commit(m, { type: "set_system_graphics", systemId: "sys-cw", pattern: "long_dash", colour: "#0b3d91" });
    expect(planLines(next, "cw-s1")).toEqual([{ pen: "wide", dash: [...(SYSTEM_PATTERN_DASH.long_dash ?? [])] }]);
    expect(planLines(next, "v-s1")).toEqual([{ pen: "wide", dash: [4, 2] }]);
  });

  it("refuses in plain words: nothing to change, a colour that isn't #rrggbb, a part that isn't a system", () => {
    expect(refusal(m, { type: "set_system_graphics", systemId: "sys-v" })).toBe("Say what to change on Vent 1: its colour, line pattern or line weight");
    expect(refusal(m, { type: "set_system_graphics", systemId: "sys-v", colour: "green" })).toBe("green isn't a colour; give it as #rrggbb (#1f6fd1)");
    expect(refusal(m, { type: "set_system_graphics", systemId: "cw-s1", weight: "thin" })).toMatch(/mep_system|system/);
  });
});

describe("pipe types: material, spec, sizes, the systems they carry, fittings that follow the material", () => {
  const m = model();

  it("the firm's built-in types are there before anything is saved", () => {
    expect(projectPipeTypes(m).map((r) => r.entry.name)).toEqual(["DW-CPVC", "DW-CU-L", "DW-PEX", "GAS-CSST", "GAS-PE", "GAS-SCH40", "HW-CU-L", "SAN-CI", "SAN-PVC"]);
    expect(pipeTypeOf(m, "dw-pex")?.material).toBe("pex");
  });

  it("switching material switches the fittings: PVC sanitary takes PVC DWV fittings, cast iron takes the same no-hub drainage set, PEX water takes water fittings", () => {
    const pvcType = BUILTIN_PIPE_TYPES.find((t) => t.name === "SAN-PVC");
    const ciType = BUILTIN_PIPE_TYPES.find((t) => t.name === "SAN-CI");
    const pexType = BUILTIN_PIPE_TYPES.find((t) => t.name === "DW-PEX");
    if (!pvcType || !ciType || !pexType) throw new Error("built-ins");
    const wye = (t: typeof pvcType) => pipeTypeFittings(t, "sanitary").find((f) => f.slot === "drain_branch_hh")?.familyId;
    expect(wye(pvcType)).toBe("dwv.combo_wye_eighth");
    expect(wye(ciType)).toBe("dwv.combo_wye_eighth");
    expect(pipeTypeFittings(pexType, "domestic_cold_water").map((f) => [f.slot, f.familyId])).toEqual([
      ["pipe_elbow_90", "pipe.water.elbow_90"],
      ["pipe_elbow_45", "pipe.water.elbow_45"],
      ["pipe_tee", "pipe.water.tee"],
      ["pipe_reducer", "pipe.water.reducer"],
      ["pipe_cap", "pipe.water.cap"],
    ]);
    // Polyethylene gas pipe (below grade) takes fusion fittings, not threaded malleable iron.
    const peType = BUILTIN_PIPE_TYPES.find((t) => t.name === "GAS-PE");
    if (!peType) throw new Error("GAS-PE");
    expect(pipeTypeFittings(peType, "natural_gas").map((f) => [f.slot, f.familyId])).toEqual([
      ["pipe_elbow_90", "pipe.gas.pe_elbow_90"],
      ["pipe_elbow_45", "pipe.gas.pe_elbow_45"],
      ["pipe_tee", "pipe.gas.pe_tee"],
      ["pipe_reducer", "pipe.gas.pe_reducer"],
      ["pipe_cap", "pipe.gas.pe_cap"],
    ]);
  });

  it("a type says why it can't carry a system: PEX on sanitary, cast iron on gas", () => {
    const pexType = BUILTIN_PIPE_TYPES.find((t) => t.name === "DW-PEX");
    const ciType = BUILTIN_PIPE_TYPES.find((t) => t.name === "SAN-CI");
    if (!pexType || !ciType) throw new Error("built-ins");
    expect(pipeTypeMismatch(pexType, "sanitary")).toBe("DW-PEX is for domestic cold water, domestic hot water, domestic hot water return");
    expect(pipeTypeMismatch(ciType, "natural_gas")).toBe("SAN-CI is for sanitary, vent, storm");
    expect(pipeTypeMismatch(pexType, "domestic_hot_water")).toBeNull();
  });

  it("a project saves its own type and it replaces the built-in of that name; an engineer's fitting pick wins over the material's", () => {
    const entry = pipeTypeSchema.parse({ type: "pipe_type", name: "DW-PEX", description: "PEX-a, F1960", material: "pex", minIn: 0.5, maxIn: 2, fittings: { pipe_tee: "pipe.water.tee" } });
    const saved = commit(m, { type: "save_catalog_entry", entry });
    const record = projectPipeTypes(saved).find((r) => r.entry.name === "DW-PEX");
    expect(record).toMatchObject({ saved: true, overridesBuiltin: true, entry: { maxIn: 2 } });
    expect(projectPipeTypes(saved).filter((r) => r.entry.name === "DW-PEX")).toHaveLength(1);
    expect(pipeTypeFittings(entry, "domestic_cold_water").find((f) => f.slot === "pipe_tee")).toMatchObject({ picked: true });
    const gone = commit(saved, { type: "delete_catalog_entry", entryType: "pipe_type", name: "DW-PEX" });
    expect(projectPipeTypes(gone).find((r) => r.entry.name === "DW-PEX")?.saved).toBe(false);
  });

  it("refuses a type whose smallest size is larger than its largest", () => {
    expect(pipeTypeSchema.safeParse({ type: "pipe_type", name: "X", material: "pex", minIn: 2, maxIn: 1 }).success).toBe(false);
  });
});

describe("auto-sizing and demand curve: project record, per-system override", () => {
  const m = model();

  it("is off (check) until someone turns it on, with no curve chosen", () => {
    expect(projectPlumbingSettings(m.elements)).toEqual({ type: "plumbing_settings", name: "Project", sizingMode: "check" });
    expect(sizingInputs(projectPlumbingSettings(m.elements), system(m, "sys-cw").design?.pipe)).toEqual({ project: { sizing_mode: "check" }, system: {} });
  });

  it("the project turns auto-sizing on and picks a restaurant; one system stays on check with its own curve", () => {
    let next = commit(m, { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode: "auto", buildingType: "restaurant" } });
    next = commit(next, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { sizingMode: "check", demandCurve: "ashrae_d" } } });
    expect(projectPlumbingSettings(next.elements)).toMatchObject({ sizingMode: "auto", buildingType: "restaurant" });
    expect(sizingInputs(projectPlumbingSettings(next.elements), system(next, "sys-cw").design?.pipe)).toEqual({
      project: { sizing_mode: "auto", building_type: "restaurant" },
      system: { sizing_mode: "check", demand_curve: "ashrae_d" },
    });
    // Other pipe design inputs on the system are kept.
    next = commit(next, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { maxVelocityFps: 6 } } });
    expect(system(next, "sys-cw").design?.pipe).toMatchObject({ sizingMode: "check", demandCurve: "ashrae_d", maxVelocityFps: 6 });
    // Null hands the system back to the project's setting.
    next = commit(next, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { sizingMode: null } } });
    expect(sizingInputs(projectPlumbingSettings(next.elements), system(next, "sys-cw").design?.pipe).system).toEqual({ demand_curve: "ashrae_d" });
  });

  it("refuses a demand curve that isn't one of the curves the calc pack knows", () => {
    const parsed = commandSchema.safeParse({ type: "set_system_design", systemId: "sys-cw", design: { pipe: { demandCurve: "curve_z" } } });
    expect(parsed.success).toBe(false);
    expect(commandSchema.safeParse({ type: "set_system_design", systemId: "sys-cw", design: { pipe: { demandCurve: "ashrae_a", sizingMode: "auto" } } }).success).toBe(true);
  });
});
