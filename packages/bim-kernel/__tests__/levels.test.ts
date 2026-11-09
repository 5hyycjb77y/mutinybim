/**
 * @jest-environment node
 *
 * Levels from the building: syncing a linked model's storeys (one change,
 * idempotent, re-sync moves and renames instead of duplicating, undoable) and
 * moving / renaming a level with everything on it.
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  builtinPartType,
  canonicalJson,
  executeCommand,
  modelLevels,
  planCommit,
  planLevelSync,
  validateModel,
  type BimElement,
  type Changeset,
  type Command,
  type CommandRequest,
  type Level,
  type LibraryEntry,
  type ModelState,
  type SyncStorey,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-21T00:00:00.000Z";
const REF = "ref-arch";

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

let counter = 0;
function request(base: number, command: Command, who = "priya"): CommandRequest {
  counter += 1;
  return { idempotencyKey: `${who}-${counter}`, baseRevision: base, actor: { id: who, name: who, kind: "human" }, command, clientSessionId: `tab-${who}` };
}

class Model {
  head: ModelState = { modelId: "levels", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  submit(command: Command, who = "priya") {
    const base = this.head.revision;
    const decision = planCommit(this.head, [], request(base, command, who), NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command, who?: string): Changeset {
    const d = this.submit(command, who);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(command: Command): string {
    const before = this.head;
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    expect(this.head).toBe(before);
    return d.error.message;
  }
  el(id: string): BimElement {
    const el = this.head.elements[id];
    if (!el) throw new Error(`missing ${id}`);
    return el;
  }
  levels(): { name: string; ft: number }[] {
    return modelLevels(this.head)
      .map((l) => ({ name: l.name, ft: Math.round((l.elevationMm / FT) * 1000) / 1000 }))
      .sort((a, b) => a.ft - b.ft);
  }
}

const storey = (storeyId: string, name: string, ft: number): SyncStorey => ({ storeyId, name, elevationMm: ft * FT, levelId: `lvl-${storeyId}` });
const ARCHITECT = [storey("g1", "01 FIRST FLOOR", 0), storey("g2", "02 SECOND FLOOR", 12), storey("g3", "ROOF", 26.5)];
const sync = (storeys: SyncStorey[], referenceId = REF): Command => ({ type: "sync_levels", referenceId, storeys });

describe("syncing a linked model's storeys", () => {
  it("adds every storey as a level in one change, each tied to its storey", () => {
    const m = new Model();
    const result = executeCommand(m.head, sync(ARCHITECT));
    expect(result.ok && result.summary).toEqual(expect.arrayContaining(['Added ROOF at 26\'-6"', `Added 01 FIRST FLOOR at 0'-0"`]));
    m.ok(sync(ARCHITECT));
    expect(m.levels()).toEqual([
      { name: "01 FIRST FLOOR", ft: 0 },
      { name: "02 SECOND FLOOR", ft: 12 },
      { name: "ROOF", ft: 26.5 },
    ]);
    expect(m.log).toHaveLength(1);
    const roof = m.el("lvl-g3") as Level;
    expect(roof.source).toEqual({ referenceId: REF, storeyId: "g3", storeyName: "ROOF" });
    expect(validateModel(m.head)).toEqual([]);
  });

  it("is idempotent: the same storeys again change nothing and say so", () => {
    const m = new Model();
    m.ok(sync(ARCHITECT));
    expect(planLevelSync(m.head, REF, ARCHITECT).changes).toBe(false);
    expect(m.refused(sync(ARCHITECT))).toMatch(/already match/);
    expect(modelLevels(m.head)).toHaveLength(3);
  });

  it("re-sync moves and renames the levels made from storeys instead of adding new ones", () => {
    const m = new Model();
    m.ok(sync(ARCHITECT));
    const moved = [storey("g1", "01 FIRST FLOOR", 0), storey("g2", "02 SECOND FLOOR", 13), storey("g3", "MAIN ROOF", 26.5), storey("g4", "PENTHOUSE ROOF", 36)];
    const plan = planLevelSync(m.head, REF, moved);
    expect(plan.rows.map((r) => [r.storeyName, r.action])).toEqual([
      ["01 FIRST FLOOR", "unchanged"],
      ["02 SECOND FLOOR", "update"],
      ["MAIN ROOF", "update"],
      ["PENTHOUSE ROOF", "add"],
    ]);
    m.ok(sync(moved));
    expect(m.levels()).toEqual([
      { name: "01 FIRST FLOOR", ft: 0 },
      { name: "02 SECOND FLOOR", ft: 13 },
      { name: "MAIN ROOF", ft: 26.5 },
      { name: "PENTHOUSE ROOF", ft: 36 },
    ]);
    // The ids are the first sync's: nothing was duplicated.
    expect((m.el("lvl-g3") as Level).name).toBe("MAIN ROOF");
  });

  it("ties a level a person already made for the floor to the storey, keeping their name", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-mine", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 26 * FT });
    const plan = planLevelSync(m.head, REF, [storey("g1", "LEVEL 01", 0), storey("g3", "ROOF", 26.5)]);
    expect(plan.rows.map((r) => [r.storeyName, r.action, r.levelId, r.name])).toEqual([
      ["LEVEL 01", "match", "lvl-mine", "Level 1"],
      ["ROOF", "match", "lvl-roof", "Roof"],
    ]);
    m.ok(sync([storey("g1", "LEVEL 01", 0), storey("g3", "ROOF", 26.5)]));
    expect(m.levels()).toEqual([
      { name: "Level 1", ft: 0 },
      { name: "Roof", ft: 26.5 },
    ]);
    expect((m.el("lvl-mine") as Level).source).toEqual({ referenceId: REF, storeyId: "g1", storeyName: "LEVEL 01" });
    // The architect renaming the storey later does not rename the person's level.
    m.ok(sync([storey("g1", "GROUND FLOOR", 0), storey("g3", "ROOF", 26.5)]));
    expect(m.levels().map((l) => l.name)).toEqual(["Level 1", "Roof"]);
    expect(planLevelSync(m.head, REF, [storey("g1", "GROUND FLOOR", 0), storey("g3", "ROOF", 26.5)]).changes).toBe(false);
  });

  it("matches by elevation when the names differ, and never matches one level twice", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-ground", name: "Ground", elevationMm: 1 });
    const plan = planLevelSync(m.head, REF, [storey("a", "FIRST", 0), storey("b", "FIRST MEZZ", 0)]);
    expect(plan.rows.map((r) => r.action)).toEqual(["match", "add"]);
  });

  it("never takes over another linked model's level; a new level gets a free name instead", () => {
    const m = new Model();
    m.ok(sync([storey("x", "ROOF", 30)], "ref-other"));
    m.ok(sync([storey("g3", "ROOF", 26.5)]));
    expect(m.levels().map((l) => l.name)).toEqual(["ROOF (2)", "ROOF"]);
  });

  it("keeps a level whose storey the architect removed, and says so", () => {
    const m = new Model();
    m.ok(sync(ARCHITECT));
    const fewer = sync([storey("g1", "01 FIRST FLOOR", 0), storey("g2", "02 SECOND FLOOR", 12.5)]);
    const result = executeCommand(m.head, fewer);
    expect(result.ok && result.summary).toContain("ROOF is no longer in the linked model; it was kept");
    m.ok(fewer);
    expect(modelLevels(m.head)).toHaveLength(3);
  });

  it("is one undoable change", () => {
    const m = new Model();
    const cs = m.ok(sync(ARCHITECT));
    m.ok({ type: "undo", revision: cs.revision });
    expect(modelLevels(m.head).filter((l) => !("deleted" in l))).toHaveLength(0);
  });
});

describe("moving and renaming a level", () => {
  /** Level 2 at 12 ft with an RTU on its framing (12 ft above it) and a duct from it to a diffuser. */
  function withDuct(): Model {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 12 * FT });
    m.ok({ type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-2", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
    m.ok({ type: "place_part", partId: "sd", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-2", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
    m.ok({
      type: "route_run",
      idPrefix: "run",
      levelId: "lvl-2",
      domain: "duct",
      size: { shape: "rect", width: 14 * IN, height: 10 * IN },
      elevationMm: 10 * FT,
      system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" },
      points: [],
      from: { kind: "part", partId: "rtu", connectorId: "supply" },
      to: { kind: "part", partId: "sd", connectorId: "neck" },
    });
    return m;
  }
  const runZs = (m: Model) =>
    Object.values(m.head.elements)
      .flatMap((el) => (el.kind === "run_segment" ? [el.start.z, el.end.z] : el.kind === "run_fitting" ? [el.position.z, ...el.ports.map((p) => p.position.z)] : []))
      .sort((a, b) => a - b);

  it("takes the runs and parts on it along: their heights above it are unchanged and they are part of the change", () => {
    const m = withDuct();
    const before = runZs(m);
    expect(before.length).toBeGreaterThan(0);
    const cs = m.ok({ type: "update_level", levelId: "lvl-2", elevationMm: 14 * FT });
    expect(runZs(m)).toEqual(before);
    const rtu = m.el("rtu");
    expect(rtu.kind === "part" ? rtu.offsetMm : NaN).toBeCloseTo(12 * FT, 3);
    const changed = cs.elements.map((el) => el.id);
    expect(changed).toEqual(expect.arrayContaining(["lvl-2", "rtu", "sd", ...Object.keys(m.head.elements).filter((k) => k.startsWith("run-"))]));
    expect(changed).not.toContain("lvl-1");
    expect((m.el("lvl-2") as Level).elevationMm).toBe(14 * FT);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("renames every reference: element partitions and plans on the level", () => {
    const m = withDuct();
    m.ok({ type: "create_view", viewId: "v-2", name: "Level 2 plan", viewType: "floor_plan", props: { level: "Level 2" } });
    m.ok({ type: "update_level", levelId: "lvl-2", name: "Second Floor" });
    const rtu = m.el("rtu");
    expect(rtu.partition?.level).toBe("Second Floor");
    const runs = Object.values(m.head.elements).filter((el) => el.kind === "run_segment");
    expect(runs.every((r) => r.partition?.level === "Second Floor")).toBe(true);
    const view = m.head.elements["v-2"];
    expect(view?.kind === "view" && view.props?.level).toBe("Second Floor");
    expect(m.levels().map((l) => l.name)).toEqual(["Level 1", "Second Floor"]);
  });

  it("refuses a name another level has, and a change that changes nothing", () => {
    const m = withDuct();
    expect(m.refused({ type: "update_level", levelId: "lvl-2", name: "level 1" })).toMatch(/already a level named Level 1/);
    expect(m.refused({ type: "update_level", levelId: "lvl-2", name: "Level 2", elevationMm: 12 * FT })).toMatch(/already called that/);
  });

  it("is undoable: the level and the names on it go back", () => {
    const m = withDuct();
    const cs = m.ok({ type: "update_level", levelId: "lvl-2", elevationMm: 15 * FT, name: "L2" });
    m.ok({ type: "undo", revision: cs.revision });
    expect(m.levels()).toEqual([
      { name: "Level 1", ft: 0 },
      { name: "Level 2", ft: 12 },
    ]);
    expect(m.el("rtu").partition?.level).toBe("Level 2");
  });

  it("a re-sync that moves a level moves the work on it", () => {
    const m = withDuct();
    m.ok(sync([storey("g1", "Level 1", 0), storey("g2", "LEVEL 2", 12)]));
    const again = sync([storey("g1", "Level 1", 0), storey("g2", "LEVEL 2", 13)]);
    const result = executeCommand(m.head, again);
    expect(result.ok && result.summary).toContain(`Moved Level 2 from 12'-0" to 13'-0"`);
    const cs = m.ok(again);
    expect(cs.elements.map((el) => el.id)).toEqual(expect.arrayContaining(["lvl-2", "rtu", "sd"]));
    expect((m.el("lvl-2") as Level).elevationMm).toBeCloseTo(13 * FT, 3);
  });
});
