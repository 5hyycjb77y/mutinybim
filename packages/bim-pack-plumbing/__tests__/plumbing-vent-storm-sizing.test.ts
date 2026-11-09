/**
 * @jest-environment node
 *
 * Vent and storm sizing on the plumbing sizing path. Before this,
 * `plumbing.size_system` refused both ("Vent sizing is not calculated yet",
 * "Storm drains ... aren't in the plumbing pack yet"), so a vent stack or a
 * roof leader drawn too small was never caught and auto-sizing skipped them.
 *
 * Vent: a 3-storey stack of water closets (4 DFU each) on a sanitary stack,
 * vented by a vent stack through the roof with a branch vent from each
 * closet. VPC 2021 Table 906.1 on the stack's size, the units vented and the
 * developed length sizes the vent stack; each closet's branch vent is half
 * the drain Table 710.1(2) needs for 4 DFU (2"), so 1-1/4" least (906.2).
 *
 * Storm: two roof drains (6,000 and 3,000 sq ft) at 4 in/h. The leader under
 * the 6,000 sq ft drain is 5" (Table 1106.2(1), 4,600 sq ft is the most a 4"
 * leader takes); the 3,000 sq ft branch at 1/8 in/ft is 5" (Table 1106.3);
 * the main carrying 9,000 sq ft at 1/8 in/ft is 8".
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { planAutoSize, type PipeSystemSizing } from "../src";

const registry = builtinCalcRegistry();
const FT = 304.8;
const IN = 25.4;
const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
const VENT = { id: "sys-v", kind: "vent" as const, name: "Vent" };
const STORM = { id: "sys-st", kind: "storm" as const, name: "Storm" };

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `k-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-25T06:00:00.000Z", []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function build(commands: readonly Command[]): ModelState {
  let m: ModelState = { modelId: "vs", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const c of [{ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 } as Command, ...commands]) m = commit(m, c);
  return m;
}

function size(model: ModelState, systemId: string): PipeSystemSizing {
  const r = registry.run({ calc: "plumbing.size_system", inputs: { system_id: systemId }, model, state: "VA" });
  if (!r.ok) throw new Error(r.reason);
  if (!r.run.detail) throw new Error(r.run.issues.map((i) => i.message).join(" "));
  return r.run.detail as PipeSystemSizing;
}
const proposal = (s: PipeSystemSizing, id: string) => s.proposals.find((p) => p.segmentId === id);

/** Sanitary stack at x = 20 ft with a closet branch at 4, 14 and 24 ft; a vent stack at x = 22 ft through the roof, a branch vent from each closet. */
function ventStack(ventStackIn = 1.5): ModelState {
  const commands: Command[] = [
    { type: "save_connection_type", entry: { designator: "WC", trade: "plumbing", description: "Water closet", quantities: { dfu: 4 } } },
    { type: "route_run", idPrefix: "san", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -1 * FT, system: SAN, flow: "against_points", points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0, elevationMm: 30 * FT }] },
    { type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "pipe", size: pvc(ventStackIn), elevationMm: 0, system: VENT, points: [{ x: 22 * FT, y: -1 * FT }, { x: 22 * FT, y: 0, elevationMm: 34 * FT }] },
  ];
  const points: Array<{ hostId: string; port: string; connectionType: string; mark: string }> = [];
  for (const k of [1, 2, 3]) {
    const z = (4 + (k - 1) * 10) * FT;
    commands.push({ type: "route_run", idPrefix: `san-wc${k}`, levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: z, system: SAN, points: [{ x: 26 * FT, y: 0 }, { x: 20 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "san-s2" } });
    points.push({ hostId: `san-wc${k}-s1`, port: "start", connectionType: "WC", mark: `WC-${k}` });
    if (k === 1) points.push({ hostId: "v-s1", port: "start", connectionType: "WC", mark: "WC-1" });
    else {
      commands.push({ type: "route_run", idPrefix: `v-wc${k}`, levelId: "lvl-1", domain: "pipe", size: pvc(1.5), elevationMm: z + 4 * FT, system: VENT, points: [{ x: 26 * FT, y: 0 }, { x: 22 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "v-s2" } });
      points.push({ hostId: `v-wc${k}-s1`, port: "start", connectionType: "WC", mark: `WC-${k}` });
    }
  }
  commands.push({ type: "create_load_point", points });
  return build(commands);
}

/** A storm main falling to the outfall at x = 0, a leader up to a 6,000 sq ft roof drain at x = 40 ft, and a 3,000 sq ft drain on a branch. */
function roof(rate: number | null, sizingMode: "check" | "auto" = "check"): ModelState {
  const area = (sqft: number) => ({ custom: [{ name: "Roof area", unit: "sq ft", value: sqft }] });
  const commands: Command[] = [
    { type: "route_run", idPrefix: "st", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, slopeInPerFt: 0.125, flow: "against_points", system: STORM, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0, elevationMm: 20 * FT }] },
    { type: "route_run", idPrefix: "st-b", levelId: "lvl-1", domain: "pipe", size: pvc(4), slopeInPerFt: 0.125, system: STORM, points: [{ x: 20 * FT, y: 12 * FT }, { x: 20 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "st-s1" } },
    { type: "create_load_point", points: [
      { hostId: "st-s2", port: "end", connectionType: "", values: area(6000), mark: "RD-1" },
      { hostId: "st-b-s1", port: "start", connectionType: "", values: area(3000), mark: "RD-2" },
    ] },
    { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode } },
  ];
  if (rate !== null) commands.push({ type: "set_system_design", systemId: "sys-st", design: { pipe: { rainfallInPerHr: rate } } });
  return build(commands);
}

describe("vent sizing (VPC 906)", () => {
  const model = ventStack();
  const vent = size(model, "sys-v");

  it("sizes vent systems instead of refusing them", () => {
    expect(vent.service).toBe("vent");
    expect(vent.totalLoad).toBe(12);
  });

  it("sizes the vent stack by Table 906.1 on the 3\" stack it serves, 12 DFU and its developed length", () => {
    const stack = proposal(vent, "v-s2");
    expect(stack?.role).toBe("vent_stack");
    expect(stack?.carries).toMatch(/^12 DFU vented, 35 ft developed length, serving the 3" stack$/);
    expect(stack?.governs).toBe('Table 906.1 (3" stack, 21 DFU row)');
    // 1-1/2" reaches 32 ft on that row; 35 ft needs 2".
    expect(stack?.proposed).toBe("2");
    expect(stack?.change).toBe("up");
    expect(vent.findings.some((f) => f.code === "undersized_pipe" && f.elementId === "v-s2")).toBe(true);
  });

  it("sizes each closet's branch vent at half the 2\" drain Table 710.1(2) needs for 4 DFU, 1-1/4\" least (906.2), measured to the vent stack", () => {
    for (const id of ["v-wc2-s1", "v-wc3-s1"]) {
      const p = proposal(vent, id);
      expect(p?.role).toBe("branch_vent");
      expect(p?.carries).toMatch(/^4 DFU vented, 4 ft developed length/);
      expect(p?.proposedIn).toBeGreaterThanOrEqual(1.25);
      expect(p?.proposedIn).toBeLessThanOrEqual(1.5);
    }
  });

  it("goes one size up for a branch vent over 40 ft of developed length", () => {
    // A far fixture's vent joins closet 3's branch vent 44 ft away.
    const long = commit(ventStack(), { type: "route_run", idPrefix: "v-far", levelId: "lvl-1", domain: "pipe", size: pvc(1.5), elevationMm: 28 * FT, system: VENT, points: [{ x: 24 * FT, y: 44 * FT }, { x: 24 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "v-wc3-s1" } });
    const withPoint = commit(long, { type: "create_load_point", points: [{ hostId: "v-far-s1", port: "start", connectionType: "WC", mark: "WC-9" }] });
    const p = proposal(size(withPoint, "sys-v"), "v-far-s1");
    expect(p?.governs).toMatch(/one size up over 40 ft developed length$/);
  });

  it("sizes nothing on a model with a sized vent stack: a 2\" vent stack is left alone", () => {
    expect(proposal(size(ventStack(2), "sys-v"), "v-s2")?.change).toBe("same");
  });
});

describe("storm sizing (VPC 1106)", () => {
  it("refuses by name when the system has no rainfall rate: Figure 1106.1 is only an image in the code library", () => {
    const s = size(roof(null), "sys-st");
    expect(s.service).toBe("storm");
    expect(s.proposals).toEqual([]);
    const f = s.findings.find((x) => x.code === "no_rainfall_rate");
    expect(f?.severity).toBe("error");
    expect(f?.message).toMatch(/^Figure 1106\.1 \(100-year, 1-hour rainfall maps\) is only an image in the code library, not numbers/);
    expect(f?.message).toMatch(/Set Storm's design rainfall/);
  });

  const storm = size(roof(4), "sys-st");

  it("sizes the leader by Table 1106.2(1): 6,000 sq ft at 4 in/h needs 5\"", () => {
    const leader = proposal(storm, "st-s2");
    expect(leader?.role).toBe("storm_leader");
    expect(leader?.carries).toBe("6000 sq ft of roof at 4 in/h");
    expect(leader?.proposed).toBe("5");
  });

  it("sizes horizontal storm drains by Table 1106.3 at their fall, never smaller downstream", () => {
    const branch = proposal(storm, "st-b-s1");
    expect(branch?.role).toBe("storm_drain");
    expect(branch?.governs).toBe("Table 1106.3 at 0.125 in/ft");
    expect(branch?.proposed).toBe("5");
    const main = proposal(storm, "st-s1");
    expect(main?.carries).toMatch(/^9000 sq ft of roof at 4 in\/h/);
    expect(main?.proposed).toBe("8");
    expect(storm.totalLoad).toBe(9000);
    expect(storm.rainfallInPerHr).toBe(4);
  });

  it("refuses a horizontal drain past Table 1106.3's 6 in/h, in words", () => {
    const s = size(roof(7), "sys-st");
    expect(s.findings.some((f) => f.code === "no_size_fits" && /beyond Table 1106\.3's 6 in\/h/.test(f.message))).toBe(true);
    expect(proposal(s, "st-s2")?.governs).toBe("Table 1106.2(1), leader");
  });

  it("auto-sizes a storm system set to auto", () => {
    const plan = planAutoSize(registry, roof(4, "auto"), { state: "VA" }, { idPrefix: "auto" });
    const edit = plan.edits.find((e) => e.systemId === "sys-st");
    expect(edit?.command.sizes).toEqual(expect.arrayContaining([{ segmentId: "st-s2", nominalIn: 5 }, { segmentId: "st-s1", nominalIn: 8 }]));
  });
});
