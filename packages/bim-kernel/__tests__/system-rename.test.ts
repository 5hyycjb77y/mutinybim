/**
 * @jest-environment node
 *
 * Naming a system (review video V1, 6:51: "if we're going to create a new system
 * every time… I should be able to name it"). A route can create a system with
 * a typed name; `set_system_design` with `name` renames one, refusing a name
 * another system already has. Before, systems could not be renamed at all.
 */
import { DEFAULT_SETTINGS, executeCommand, planCommit, type Command, type ModelState } from "../src";

const FT = 304.8;
const IN = 25.4;
let k = 0;
function submit(model: ModelState, command: Command) {
  return planCommit(model, [], { idempotencyKey: `sr-${++k}`, baseRevision: model.revision, actor: { id: "k", name: "K", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
}
function ok(model: ModelState, command: Command): ModelState {
  const d = submit(model, command);
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}
const nameOf = (m: ModelState, id: string) => {
  const s = m.elements[id];
  return s?.kind === "mep_system" ? s.name : null;
};

function model(): ModelState {
  let m: ModelState = { modelId: "sr", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = ok(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = ok(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "pex" }, elevationMm: 9 * FT, system: { id: "sys-cw", kind: "domestic_cold_water", name: "DCW-1" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
  return ok(m, { type: "route_run", idPrefix: "hw", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "pex" }, elevationMm: 9 * FT, system: { id: "sys-hw", kind: "domestic_hot_water", name: "Domestic hot water 1" }, points: [{ x: 0, y: 2 * FT }, { x: 10 * FT, y: 2 * FT }] });
}

describe("naming systems", () => {
  it("a route creates its new system with the name typed", () => {
    expect(nameOf(model(), "sys-cw")).toBe("DCW-1");
  });

  it("set_system_design with a name renames it, and says so", () => {
    const rename: Command = { type: "set_system_design", systemId: "sys-hw", name: "DHW-1" };
    expect(nameOf(ok(model(), rename), "sys-hw")).toBe("DHW-1");
    const r = executeCommand(model(), rename);
    expect(r.ok && r.summary).toEqual(["Domestic hot water 1 is now called DHW-1"]);
  });

  it("a name another system already has is refused in plain words (any case)", () => {
    const d = submit(model(), { type: "set_system_design", systemId: "sys-hw", name: "dcw-1" });
    expect(d.ok ? null : d.error.message).toBe("There is already a system called DCW-1; pick another name");
  });
});
