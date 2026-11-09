/**
 * @jest-environment node
 *
 * Pipe insulation, like duct insulation: a wrap on pipe (never a liner),
 * set per run or from the project's schedule by system kind and size band,
 * drawn as a dashed outline in plan and a skin in 3D, in a pipe schedule and
 * in pipe size tags. Before this the kernel refused insulation on pipe
 * ("pipe insulation isn't modelled yet") and nothing read a schedule.
 */
import {
  DEFAULT_SETTINGS,
  drawInsulationPlan,
  evaluateSchedule,
  executeCommand,
  insulationEnvelope,
  planCommit,
  tagLines,
  type Command,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from "@permitzip/bim-kernel";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { pipeInsulationPlan, STARTER_PIPE_INSULATION, STARTER_PIPE_INSULATION_SOURCE } from "../src";

const IN = 25.4;

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `k-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-24T12:00:00.000Z", []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function sampleMarketModel(): ModelState {
  let m: ModelState = { modelId: "7492", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commit(m, c);
  return commit(m, sampleMarketLoadPointCommand(build.points));
}

const seg = (m: ModelState, id: string) => m.elements[id] as RunSegment;
const oneInch = { kind: "wrap" as const, thicknessMm: IN, material: "fiberglass" };

describe("insulation on pipe", () => {
  const base = sampleMarketModel();

  it("wraps a pipe run (refused before: pipe insulation wasn't modelled); the fittings at its ends take it", () => {
    const run = executeCommand(base, { type: "set_run_insulation", elementId: "hw-s2", insulation: oneInch, scope: "piece" });
    expect(run.ok).toBe(true);
    const m = commit(base, { type: "set_run_insulation", elementId: "hw-s2", insulation: oneInch, scope: "piece" });
    expect(seg(m, "hw-s2").insulation).toEqual(oneInch);
    const elbow = Object.values(m.elements).find((e): e is RunFitting => e?.kind === "run_fitting" && e.systemId === "sys-hw" && e.ports.some((p) => p.link?.elementId === "hw-s2"));
    expect(elbow?.insulation).toEqual(oneInch);
  });

  it("refuses a liner on pipe, with the reason", () => {
    const run = executeCommand(base, { type: "set_run_insulation", elementId: "hw-s2", insulation: { kind: "liner", thicknessMm: IN }, scope: "piece" });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.message).toMatch(/wrap/);
  });

  it("system scope covers every pipe of the system and nothing else", () => {
    const m = commit(base, { type: "set_run_insulation", elementId: "hw-s2", insulation: oneInch, scope: "system" });
    const hot = Object.values(m.elements).filter((e): e is RunSegment => e?.kind === "run_segment" && e.systemId === "sys-hw");
    expect(hot.every((s) => s.insulation?.thicknessMm === IN)).toBe(true);
    expect(seg(m, "cw-s1").insulation).toBeUndefined();
  });

  it("draws a dashed outline beside the pipe in plan and a skin in 3D", () => {
    const m = commit(base, { type: "set_run_insulation", elementId: "hw-s2", insulation: oneInch, scope: "piece" });
    const lines: Array<{ dash: number[] | undefined }> = [];
    drawInsulationPlan(m, seg(m, "hw-s2"), (_a, _b, _pen, dash) => lines.push({ dash }));
    expect(lines.length).toBe(2);
    expect(lines.every((l) => (l.dash ?? []).length > 0)).toBe(true);
    expect(insulationEnvelope(m, seg(m, "hw-s2")).length).toBe(1);
    expect(insulationEnvelope(base, seg(base, "hw-s2"))).toEqual([]);
  });
});

describe("the project's pipe insulation schedule", () => {
  const scheduled = commit(sampleMarketModel(), { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode: "check", pipeInsulation: [...STARTER_PIPE_INSULATION], pipeInsulationSource: STARTER_PIPE_INSULATION_SOURCE } });

  it("gives each hot water pipe its band's thickness: 1\" below 1-1/2\", 1-1/2\" from there up; cold water has no row", () => {
    const plan = pipeInsulationPlan(scheduled, "sys-hw");
    if ("reason" in plan) throw new Error(plan.reason);
    const by = new Map(plan.pieces.map((p) => [p.segmentId, p.insulation?.thicknessMm]));
    expect(by.get("hw-s2")).toBeCloseTo(1.5 * IN, 3);
    expect(by.get("hw-K01-1-s1")).toBeCloseTo(IN, 3);
    expect(plan.source).toBe(STARTER_PIPE_INSULATION_SOURCE);
    const cold = pipeInsulationPlan(scheduled, "sys-cw");
    expect("reason" in cold && cold.reason).toMatch(/no row for Domestic Cold Water/);
  });

  it("applies as one set_pipe_insulation edit; a second plan has nothing left to change", () => {
    const plan = pipeInsulationPlan(scheduled, "sys-hw");
    if ("reason" in plan) throw new Error(plan.reason);
    const m = commit(scheduled, { type: "set_pipe_insulation", systemId: "sys-hw", pieces: plan.pieces.map((p) => ({ segmentId: p.segmentId, insulation: p.insulation })) });
    expect(seg(m, "hw-s2").insulation).toMatchObject({ kind: "wrap", material: "fiberglass" });
    const again = pipeInsulationPlan(m, "sys-hw");
    expect("pieces" in again && again.pieces).toEqual([]);
  });

  it("prints in a pipe schedule and in the pipe size tag", () => {
    const plan = pipeInsulationPlan(scheduled, "sys-hw");
    if ("reason" in plan) throw new Error(plan.reason);
    const m = commit(scheduled, { type: "set_pipe_insulation", systemId: "sys-hw", pieces: plan.pieces.map((p) => ({ segmentId: p.segmentId, insulation: p.insulation })) });
    const table = evaluateSchedule(m, { category: "pipe", columns: [{ field: "system" }, { field: "size" }, { field: "insulation" }, { field: "insulation_thickness" }], filters: [{ field: "system", op: "equals", value: "Domestic Hot Water" }] });
    expect(table.headings).toEqual(["SYSTEM", "SIZE", "INSULATION", "INSULATION THICKNESS"]);
    const row = table.rows.find((_r, i) => table.elementIds[i]?.includes("hw-s2"));
    expect(row?.[2]).toMatch(/wrap/);
    expect(row?.[3]).toBe('1½"');
    expect(tagLines(m, { elementId: "hw-s2", template: "pipe_size_insulation", leader: false })?.[0]).toMatch(/\(1½" ins\.\)$/);
    expect(tagLines(m, { elementId: "hw-s2", template: "pipe_size", leader: false })?.[0]).not.toMatch(/ins\./);
  });
});
