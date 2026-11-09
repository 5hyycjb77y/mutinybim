/**
 * @jest-environment node
 *
 * Round 8 lane D: a registered discipline through the edit spine. A command
 * is parsed before the model's add-ons are in force (the agent tool, the model
 * server), then `executeCommand` runs inside the model's set. Fails on round
 * 7, where the writer schema was the closed six, and on the first round 8 cut,
 * where the schema checked the registry at parse time and refused
 * `vt.elevators` even on a model that uses the vt add-on.
 */
import { commandSchema, DEFAULT_SETTINGS, DISCIPLINE_POINT, DISCIPLINES_REGISTRY_FEATURE, executeCommand, PARTITION_DISCIPLINES_FEATURE, withUpgradePolicy, type DisciplineDef, type ModelState } from "../src";
import { bindModelPacks, contribute, definePack, PackSet, unbindModelPacks } from "../src/packs";

const ELEVATORS: DisciplineDef = { id: "vt.elevators", label: "Elevators", group: { id: "vt", label: "Vertical transportation" }, display: { colour: "#0f766e" } };
const VT = definePack({ id: "vt", name: "Vertical transportation (test)", version: "1.0.0", kernel: "^1.5.0" }, [contribute(DISCIPLINE_POINT, [ELEVATORS])]);
const WITH_VT = "d8-model-with-vt";
const WITHOUT_VT = "d8-model-without-vt";

type Policy = (feature: string) => boolean;
const ALL: Policy = () => true;
const OLDER_SERVER: Policy = (f) => f !== DISCIPLINES_REGISTRY_FEATURE;
const OLDEST_SERVER: Policy = (f) => f !== DISCIPLINES_REGISTRY_FEATURE && f !== PARTITION_DISCIPLINES_FEATURE;

function model(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const r = executeCommand(empty, commandSchema.parse({ type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 }));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

function createView(head: ModelState, discipline: string, policy: Policy = ALL) {
  // Parsed outside any model scope, the way an agent tool or the model server parses.
  const parsed = commandSchema.safeParse({ type: "create_view", viewId: "v-hoist", name: "Hoistway plan", viewType: "floor_plan", props: { level: "L1", scale: 48, discipline } });
  if (!parsed.success) return { ok: false as const, message: parsed.error.issues[0]?.message ?? "unparsed", at: "parse" as const };
  const r = withUpgradePolicy(policy, () => executeCommand(head, parsed.data));
  return r.ok ? { ok: true as const, model: r.model } : { ok: false as const, message: r.error.message, at: "execute" as const };
}

beforeAll(() => bindModelPacks(WITH_VT, PackSet.create([VT])));
afterAll(() => unbindModelPacks(WITH_VT));

describe("d8-writer-accepts-registered (edit spine)", () => {
  it("a model with the vt add-on stores a view partitioned vt.elevators", () => {
    const r = createView(model(WITH_VT), "vt.elevators");
    if (!r.ok) throw new Error(`${r.at}: ${r.message}`);
    expect(r.model.elements["v-hoist"]?.partition?.discipline).toBe("vt.elevators");
  });

  it("a model without it refuses in executeCommand, in plain words naming the add-on", () => {
    const r = createView(model(WITHOUT_VT), "vt.elevators");
    expect(r).toMatchObject({ ok: false, at: "execute", message: "Elevators comes from the vt add-on, which this model doesn't use. Turn that add-on on for this model first" });
  });

  it("a firm discipline this model's library doesn't have is refused, pointing at Settings", () => {
    const r = createView(model(WITHOUT_VT), "firm:low_voltage");
    expect(r).toMatchObject({ ok: false, at: "execute" });
    expect(r.ok ? "" : r.message).toMatch(/^Low voltage isn't a discipline in this model's firm library\. Add it in Settings › MutinyBIM library › Disciplines first$/);
  });

  it("a malformed id is still refused when the command is read", () => {
    expect(createView(model(WITH_VT), "Vertical Transport")).toMatchObject({ ok: false, at: "parse" });
  });
});

describe("d8-mixed-version (edit spine)", () => {
  it("a peer without disciplines:registry never receives vt.elevators: refused with the older-server words", () => {
    const r = createView(model(WITH_VT), "vt.elevators", OLDER_SERVER);
    expect(r).toMatchObject({ ok: false, at: "execute" });
    expect(r.ok ? "" : r.message).toBe("This can't be saved under Elevators yet: the model server this model is open on is an older version that doesn't store that discipline. Try again once the server is updated");
  });

  it("an add-on child (fire_alarm) needs the registry feature too; a class discipline (civil) only the round 5c one", () => {
    expect(createView(model(WITH_VT), "fire_alarm", OLDER_SERVER)).toMatchObject({ ok: false, at: "execute" });
    expect(createView(model(WITH_VT), "civil", OLDER_SERVER).ok).toBe(true);
    expect(createView(model(WITH_VT), "civil", OLDEST_SERVER)).toMatchObject({ ok: false, at: "execute" });
  });

  it("the six frozen disciplines pass under every policy", () => {
    for (const policy of [ALL, OLDER_SERVER, OLDEST_SERVER]) expect(createView(model(WITHOUT_VT), "fire_protection", policy).ok).toBe(true);
  });
});
