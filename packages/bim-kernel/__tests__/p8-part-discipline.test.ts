/**
 * @jest-environment node
 *
 * Round 8 lane P: a part can be filed under a registered discipline. Fails on
 * round 7 (and on lane D's cut), where `place_part` / `plan_part` took the
 * partition from the type's category only, so an add-on's elevator part was
 * saved as architecture and the `discipline` field was stripped at parse.
 * Commands are parsed outside any model scope, the way the agent tool and the
 * model server parse, then run inside the model's set by `executeCommand`.
 */
import { commandSchema, DEFAULT_SETTINGS, DISCIPLINE_POINT, DISCIPLINES_REGISTRY_FEATURE, executeCommand, withUpgradePolicy, type DisciplineDef, type ModelState, type PartTypeDefinition } from "../src";
import { bindModelPacks, contribute, definePack, PackSet, unbindModelPacks } from "../src/packs";

const ELEVATORS: DisciplineDef = { id: "vt.elevators", label: "Elevators", group: { id: "vt", label: "Vertical transportation" }, display: { colour: "#0f766e" } };
const VT = definePack({ id: "vt", name: "Vertical transportation (test)", version: "1.0.0", kernel: "^1.5.0" }, [contribute(DISCIPLINE_POINT, [ELEVATORS])]);
const WITH_VT = "p8-model-with-vt";
const WITHOUT_VT = "p8-model-without-vt";

/** A generic part type (its category's discipline is architecture). */
const CAR: PartTypeDefinition = { familyName: "Elevator car", typeName: "3500 lb", category: "generic", typeParams: [], typeValues: {}, instanceParams: [], connectors: [], geometry: [{ kind: "box", center: [0, 0, 1200], size: [2000, 1600, 2400] }], symbol: [{ kind: "rect", center: [0, 0], size: [2000, 1600] }], tagFields: ["mark"], source: { kind: "builtin", libraryVersion: "test" } };

type Policy = (feature: string) => boolean;
const ALL: Policy = () => true;
const OLDER_SERVER: Policy = (f) => f !== DISCIPLINES_REGISTRY_FEATURE;

function model(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const r = executeCommand(empty, commandSchema.parse({ type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 }));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

function run(head: ModelState, raw: Record<string, unknown>, policy: Policy = ALL) {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, at: "parse" as const, message: parsed.error.issues[0]?.message ?? "unparsed" };
  const r = withUpgradePolicy(policy, () => executeCommand(head, parsed.data));
  return r.ok ? { ok: true as const, model: r.model } : { ok: false as const, at: "execute" as const, message: r.error.message };
}

const place = (discipline?: string) => ({ type: "place_part", partId: "car-1", typeId: "type-car", partType: CAR, levelId: "lvl-1", position: { x: 0, y: 0 }, ...(discipline !== undefined ? { discipline } : {}) });
const plan = (discipline?: string) => ({ type: "plan_part", partId: "car-2", typeId: "type-car", partType: CAR, levelHint: "lvl-1", ...(discipline !== undefined ? { discipline } : {}) });

function storedDiscipline(r: ReturnType<typeof run>, id: string): string | undefined {
  if (!r.ok) throw new Error(`${r.at}: ${r.message}`);
  return r.model.elements[id]?.partition?.discipline;
}

beforeAll(() => bindModelPacks(WITH_VT, PackSet.create([VT])));
afterAll(() => unbindModelPacks(WITH_VT));

describe("p8-part-discipline", () => {
  it("place_part with vt loaded saves the part under vt.elevators", () => {
    expect(storedDiscipline(run(model(WITH_VT), place("vt.elevators")), "car-1")).toBe("vt.elevators");
  });

  it("plan_part with vt loaded saves the planned part under vt.elevators", () => {
    expect(storedDiscipline(run(model(WITH_VT), plan("vt.elevators")), "car-2")).toBe("vt.elevators");
  });

  it("without the add-on both are refused in plain words naming the add-on", () => {
    const words = "Elevators comes from the vt add-on, which this model doesn't use. Turn that add-on on for this model first";
    expect(run(model(WITHOUT_VT), place("vt.elevators"))).toMatchObject({ ok: false, at: "execute", message: words });
    expect(run(model(WITHOUT_VT), plan("vt.elevators"))).toMatchObject({ ok: false, at: "execute", message: words });
  });

  it("a peer without disciplines:registry gets the older-server words", () => {
    const r = run(model(WITH_VT), place("vt.elevators"), OLDER_SERVER);
    expect(r).toMatchObject({ ok: false, at: "execute" });
    expect(r.ok ? "" : r.message).toMatch(/^This can't be saved under Elevators yet: the model server/);
  });

  it("with no discipline given it falls back to the category's", () => {
    expect(storedDiscipline(run(model(WITH_VT), place()), "car-1")).toBe("architecture");
    expect(storedDiscipline(run(model(WITHOUT_VT), plan()), "car-2")).toBe("architecture");
  });

  it("a malformed id is refused when the command is read", () => {
    expect(run(model(WITH_VT), place("Vertical Transport"))).toMatchObject({ ok: false, at: "parse" });
  });

  it("placing a planned part keeps the discipline it was filed under", () => {
    const planned = run(model(WITH_VT), plan("vt.elevators"));
    if (!planned.ok) throw new Error(planned.message);
    const placed = run(planned.model, { type: "place_planned_part", partId: "car-2", levelId: "lvl-1", position: { x: 1000, y: 0 } });
    expect(storedDiscipline(placed, "car-2")).toBe("vt.elevators");
  });
});
