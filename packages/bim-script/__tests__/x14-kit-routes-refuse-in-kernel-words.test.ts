/**
 * @jest-environment node
 *
 * Round 14 lane X14 slice 2: the kit's `parts` and `routes` helpers. They
 * build the kernel's own part-type definitions and `route_run` commands, so
 * a refusal is the kernel's sentence, word for word. Fails on round 13 (the
 * kit has no `parts` / `routes`).
 */
import { DEFAULT_SETTINGS, executeCommand, partTypeIssues, resolveConnectors, type BimElement, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { PartBuildError, ScriptRunError, checkScriptOutput, defineScript, parts, routes, runScript, sliceModel, units, type ScriptContext } from "../src";

function model(): ModelState {
  const els: BimElement[] = [
    { id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement,
    { id: "L2", version: 1, authoredRev: {}, kind: "level", name: "Level 2", elevationMm: 4000 } as unknown as BimElement,
  ];
  return { modelId: "x14-kit", revision: 3 as Revision, elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

/** The commands a helper sends, without running them. */
function recorder(m: ModelState): { ctx: ScriptContext; sent: Command[] } {
  const sent: Command[] = [];
  const slice = sliceModel(m, { levels: true });
  const ctx: ScriptContext = {
    kind: "route",
    model: { get: (id) => { const e = slice.elements[id]; if (!e) throw new Error(id); return e; }, find: (id) => slice.elements[id], ofKind: () => [], levels: () => Object.values(slice.elements).filter((e) => e.kind === "level"), selection: () => [], partTypes: () => [], libraryPart: () => undefined, revision: slice.revision },
    id: (p) => `${p ?? "x"}-1`,
    random: () => 0.5,
    edit: (c) => void sent.push(c as Command),
    label: () => undefined,
    report: () => undefined,
    reads: () => [],
    read: () => { throw new Error("not in this recorder"); },
    proposers: () => [],
    propose: () => { throw new Error("not in this recorder"); },
    acceptGhosts: () => undefined,
    editSteps: (c) => void sent.push(c as Command),
    parts: { define: () => undefined },
    calcs: () => [],
    calc: () => ({ ok: false, reason: "not in this recorder" }),
  };
  return { ctx, sent };
}

const SUPPLY = { id: "sys-supply", kind: "supply_air", name: "Supply" } as const;

async function run(body: (ctx: ScriptContext) => void, reads = { levels: true }) {
  const script = defineScript({ kind: "route", reads, parameters: {}, run: (ctx) => body(ctx) });
  const m = model();
  return { m, out: runScript(script, { slice: sliceModel(m, script.manifest.reads), values: {}, scriptHash: "sha256:x14" }) };
}

describe("x14 kit helpers", () => {
  it("parts: a box with a round connector on top is the kernel's definition, and the connector follows the height parameter", () => {
    const p = parts.part("Plenum", { type: "24x12", category: "duct_accessory" });
    const H = p.param("height", { label: "Height", value: units.in(12) });
    p.box({ length: units.in(24), width: units.in(12), height: H });
    p.connector("top", { id: "outlet", label: "Outlet", domain: "duct", systemKind: "supply_air", shape: "round", diameter: units.in(10), flowDirection: "out" });
    p.connector("back", { id: "inlet", label: "Inlet", domain: "duct", systemKind: "supply_air", shape: "rect", width: units.in(12), height: H });
    const { definition, warnings } = p.check();
    expect(partTypeIssues(definition)).toEqual([]);
    expect(warnings).toEqual([]);
    const [outlet] = resolveConnectors(definition);
    expect(outlet?.position).toEqual([0, 0, 304.8]);
    expect(outlet?.direction).toEqual([0, 0, 1]);
    const taller = resolveConnectors({ ...definition, typeValues: { ...definition.typeValues, height: 600 } });
    expect(taller[0]?.position[2]).toBe(600);
    expect(taller[1]?.position).toEqual([-304.8, 0, 300]);
    // Open, keyed parameters (fabrication rule 2) and the script's own ids.
    expect(definition.typeParams.map((x) => x.name)).toEqual(["height"]);
  });

  it("parts: refusals are the kernel's part rules, in its words", () => {
    expect(() => parts.part("Bare", { type: "x", category: "generic" }).connector("top", { id: "c", label: "C", domain: "duct", systemKind: "supply_air", shape: "round", diameter: units.in(4) })).toThrow(new PartBuildError("Connector c goes on a face of the part: draw a box, cylinder or transition first."));
    const p = parts.part("Bad formula", { type: "x", category: "generic" });
    p.box({ length: units.in(10), width: { formula: "missing_param * 2" }, height: units.in(10) });
    const issue = partTypeIssues(p.draft())[0];
    if (!issue) throw new Error("the kernel accepted a formula over a parameter that doesn't exist");
    expect(() => p.check()).toThrow(new PartBuildError(`Bad formula x: ${issue.message}`));
  });

  it("routes.along: one route_run the kernel routes; the kit's preflight checks it", async () => {
    const { m, out } = await run((ctx) => {
      routes.along(ctx, { id: "r1", level: "L1", domain: "duct", size: routes.rect(units.in(12), units.in(8)), system: SUPPLY, height: units.ft(9), points: [{ x: units.ft(0), y: units.ft(0) }, { x: units.ft(20), y: units.ft(0) }, { x: units.ft(20), y: units.ft(10) }] });
    });
    const output = await out;
    expect(output.kind === "edits" && output.batches[0]?.commands[0]?.type).toBe("route_run");
    const check = checkScriptOutput(m, JSON.parse(JSON.stringify(output)));
    expect(check.ok).toBe(true);
  });

  it("x14-kit-routes-refuse-in-kernel-words: a leg too short and a branch on another system are refused in the kernel's own sentence", async () => {
    const short = (ctx: ScriptContext) => routes.along(ctx, { id: "r1", level: "L1", domain: "duct", size: routes.rect(units.in(12), units.in(8)), system: SUPPLY, height: units.ft(9), points: [{ x: units.mm(0), y: units.mm(0) }, { x: units.mm(20), y: units.mm(0) }] });
    const rec = recorder(model());
    short(rec.ctx);
    const [cmd] = rec.sent;
    if (!cmd) throw new Error("nothing sent");
    const kernel = executeCommand(model(), cmd);
    if (kernel.ok) throw new Error("the kernel routed a 20 mm leg");
    const { out } = await run(short);
    await expect(out).rejects.toThrow(new ScriptRunError(`Step 1 (route_run) was refused: ${kernel.error.message}`));

    const twoSystems = (ctx: ScriptContext) => {
      const trunk = routes.along(ctx, { id: "t", level: "L1", domain: "duct", size: routes.rect(units.in(24), units.in(12)), system: SUPPLY, height: units.ft(9), points: [{ x: units.ft(0), y: units.ft(0) }, { x: units.ft(30), y: units.ft(0) }] });
      routes.branch(ctx, { id: "b", trunk: trunk.segment(1), level: "L1", domain: "duct", size: routes.rect(units.in(8), units.in(8)), system: { id: "sys-return", kind: "return_air", name: "Return" }, height: units.ft(9), points: [{ x: units.ft(10), y: units.ft(0) }, { x: units.ft(10), y: units.ft(8) }] });
    };
    const { out: branched } = await run(twoSystems);
    await expect(branched).rejects.toThrow(/^Step 2 \(route_run\) was refused: .*branch it on that system$/);
  });

  it("routes.branch and routes.drop: a branch at a trunk's side and a run that drops to the level below", async () => {
    const { out } = await run((ctx) => {
      const trunk = routes.along(ctx, { id: "t", level: "L2", domain: "duct", size: routes.rect(units.in(24), units.in(12)), system: SUPPLY, height: units.ft(9), points: [{ x: units.ft(0), y: units.ft(0) }, { x: units.ft(30), y: units.ft(0) }] });
      routes.branch(ctx, { id: "b", trunk: trunk.segment(1), level: "L2", domain: "duct", size: routes.rect(units.in(10), units.in(8)), system: SUPPLY, height: units.ft(9), points: [{ x: units.ft(10), y: units.ft(0) }, { x: units.ft(10), y: units.ft(8) }] });
      routes.drop(ctx, { id: "d", level: "L2", toLevel: "L1", heightAbove: units.ft(9), domain: "duct", size: routes.round(units.in(10)), system: { id: "sys-2", kind: "supply_air", name: "Supply 2" }, height: units.ft(9), points: [{ x: units.ft(40), y: units.ft(0) }, { x: units.ft(50), y: units.ft(0) }] });
    });
    const output = await out;
    if (output.kind !== "edits") throw new Error("no edits");
    const drop = output.batches[0]?.commands[2];
    expect(drop?.type === "route_run" && drop.points[1]?.elevationMm).toBeCloseTo(-4000 + 9 * 304.8, 3);
  });
});
