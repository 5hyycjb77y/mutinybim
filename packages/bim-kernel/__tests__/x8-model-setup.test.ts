/**
 * @jest-environment node
 *
 * Round 8 lane X: model settings travel in changesets. An add-on switch and a
 * pinned firm discipline are organization records written by ordinary
 * commands, and `executeCommand` resolves the model's pack set from the state
 * it runs on (the registered model-state binder), so the next command on the
 * resulting state sees the switch with no host rebind. Fails on round 7:
 * `set_model_addon`, `pin_firm_discipline` and `unpin_firm_discipline` don't
 * exist, and the set came only from what the host bound to the model's id.
 */
import {
  ORGANIZATION_SETUP_FEATURE,
  DEFAULT_SETTINGS,
  DISCIPLINE_POINT,
  DISCIPLINES_REGISTRY_FEATURE,
  addonSetupId,
  canonicalJson,
  commandSchema,
  createModelStateBinder,
  executeCommand,
  disciplineSetupId,
  installModelSetupHost,
  modelSetupOf,
  organizationOf,
  planCommit,
  withUpgradePolicy,
  withoutUpgrades,
  type Changeset,
  type DisciplineDef,
  type ModelState,
} from "../src";
import { contribute, definePack, modelStatePackSet, type Pack } from "../src/packs";

const ELEVATORS: DisciplineDef = { id: "vt.elevators", label: "Elevators", display: { colour: "#0f766e" } };
const VT: Pack = definePack({ id: "vt", name: "Vertical transportation (test)", version: "1.0.0", kernel: "^1.5.0" }, [contribute(DISCIPLINE_POINT, [ELEVATORS])]);
const LOW_VOLTAGE: DisciplineDef = { id: "firm:low_voltage", label: "Low voltage", parent: "electrical", display: { colour: "#7c3aed" } };

type Policy = (feature: string) => boolean;
const ALL: Policy = () => true;
/** A server one release back: stores registered disciplines but not setup entries. */
const OLDER_SERVER: Policy = (f) => f !== ORGANIZATION_SETUP_FEATURE;

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;
let host: readonly Pack[] = [VT];
let uninstall: () => void = () => undefined;

beforeAll(() => {
  uninstall = installModelSetupHost(() => host);
});
afterAll(() => uninstall());

function commit(head: ModelState, command: unknown, policy: Policy = ALL, history: readonly Changeset[] = []): { model: ModelState; changeset: Changeset; summary: readonly string[] } {
  seq += 1;
  const parsed = commandSchema.parse(command);
  const d = withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `x8-setup-${seq}`, baseRevision: head.revision, actor, command: parsed }, () => "2026-10-31T00:00:00.000Z", history));
  if (!d.ok) throw new Error(d.error.message);
  // The words the person sees come from the same run on the same head.
  const run = parsed.type === "undo" ? null : withUpgradePolicy(policy, () => executeCommand(head, parsed));
  return { model: d.model, changeset: d.changeset, summary: run?.ok ? (run.summary ?? []) : [] };
}

function attempt(head: ModelState, command: unknown, policy: Policy = ALL): string | null {
  try {
    commit(head, command, policy);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function model(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(empty, { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 }).model;
}

const view = (discipline: string, id = `v-${discipline.replace(/[^a-z]/g, "")}`) => ({ type: "create_view", viewId: id, name: `Plan ${id}`, viewType: "floor_plan", props: { level: "L1", scale: 48, discipline } });

describe("x8-preview-switch", () => {
  it("on pins the add-on for the next command, off unpins it, undo brings it back", () => {
    const start = model("x8-switch");
    expect(attempt(start, view("vt.elevators"))).toMatch(/^Elevators comes from the vt add-on/);

    const on = commit(start, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true });
    expect(on.summary).toContain("Vertical transportation (test) is on for this model");
    expect(organizationOf(on.model).addons.map((a) => a.entry)).toEqual([{ type: "addon", packId: "vt", version: "1.0.0", on: true }]);
    expect(modelSetupOf(on.model).pins).toEqual([{ id: "vt", version: "1.0.0" }]);
    expect(modelStatePackSet(on.model)?.has("vt")).toBe(true);
    // No host rebind between the two commits: the binder reads the state.
    const placed = commit(on.model, view("vt.elevators"));
    expect(placed.model.elements["v-vtelevators"]?.partition?.discipline).toBe("vt.elevators");

    const off = commit(placed.model, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: false });
    expect(off.summary).toContain("Vertical transportation (test) is off for this model: its rows are hidden; nothing is deleted");
    expect(off.model.elements["v-vtelevators"]?.partition?.discipline).toBe("vt.elevators");
    expect(modelStatePackSet(off.model)?.has("vt")).toBe(false);
    expect(attempt(off.model, view("vt.elevators", "v-second"))).toMatch(/^Elevators comes from the vt add-on/);

    const undone = withoutUpgrades(() => commit(off.model, { type: "undo", revision: off.changeset.revision }, ALL, [off.changeset]));
    expect(modelStatePackSet(undone.model)?.has("vt")).toBe(true);
    expect(attempt(undone.model, view("vt.elevators", "v-second"))).toBeNull();
  });

  it("an add-on this server lacks, or another version of it, can't be switched on; a built-in trade can't be switched at all", () => {
    const start = model("x8-refusals");
    expect(attempt(start, { type: "set_model_addon", packId: "civil", version: "0.1.0", on: true })).toBe("civil 0.1.0 isn't installed on this server, so it can't be switched on. Settings › MutinyBIM library › Add-ons lists what is installed");
    // Structural is first-party since round 14: built in, like Electrical.
    expect(attempt(start, { type: "set_model_addon", packId: "struct", version: "0.1.0", on: true })).toBe("Structural is built in: every model has it, so it can't be switched per model");
    expect(attempt(start, { type: "set_model_addon", packId: "vt", version: "2.0.0", on: true })).toBe("This server has Vertical transportation (test) 1.0.0, not 2.0.0. Switch on the version it has");
    expect(attempt(start, { type: "set_model_addon", packId: "electrical", version: "1.0.0", on: false })).toMatch(/is built in: every model has it, so it can't be switched per model$/);
  });

  it("switching on what is already on says so and writes nothing", () => {
    const on = commit(model("x8-noop"), { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true });
    const again = commit(on.model, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true });
    expect(again.summary).toContain("Vertical transportation (test) is already on for this model");
    expect(again.model.elements[addonSetupId("vt")]).toBe(on.model.elements[addonSetupId("vt")]);
  });
});

describe("x8-not-installed-elsewhere", () => {
  it("a model without the switch never sees the add-on's rows, though the host installs it", () => {
    const switched = commit(model("x8-a"), { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true }).model;
    const plain = model("x8-b");
    expect(modelStatePackSet(switched)?.has("vt")).toBe(true);
    // Never had a setup entry: the binder stands aside and the model keeps the built-in set.
    expect(modelStatePackSet(plain)).toBeNull();
    expect(attempt(plain, view("vt.elevators"))).toMatch(/^Elevators comes from the vt add-on/);
  });
});

describe("x8-setup-entries-mixed-version", () => {
  it("an older server never receives a setup entry: switch and pin are refused with the older-server words", () => {
    const words = "This can't be saved yet: the model server this model is open on is an older version that doesn't store add-on and discipline settings. Try again once the server is updated";
    const start = model("x8-older");
    expect(attempt(start, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true }, OLDER_SERVER)).toBe(words);
    expect(attempt(start, { type: "pin_firm_discipline", discipline: LOW_VOLTAGE }, OLDER_SERVER)).toBe(words);
    // No peer policy at all (the kernel default) is the oldest peer.
    expect(attempt(start, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true }, () => false)).toBe(words);
  });

  it("readers skip setup entries and entry types they don't know; groups and phases read the same", () => {
    const on = commit(model("x8-reader"), { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true }).model;
    const before = organizationOf(model("x8-reader-plain"));
    const org = organizationOf(on);
    expect(org.groups.map((g) => g.id)).toEqual(before.groups.map((g) => g.id));
    expect(org.phases.map((p) => p.id)).toEqual(before.phases.map((p) => p.id));
    // A record a newer release wrote, with a type this one doesn't know.
    const future = { ...on, elements: { ...on.elements, "setup-future": { id: "setup-future", version: 1, authoredRev: {}, partition: { level: "*", zone: "organization", discipline: "architecture" }, kind: "organization", entry: { type: "future_setting", value: 3 } } } } as unknown as ModelState;
    expect(modelSetupOf(future).pins).toEqual([{ id: "vt", version: "1.0.0" }]);
    expect(organizationOf(future).groups.map((g) => g.id)).toEqual(before.groups.map((g) => g.id));
  });
});

describe("x8-firm-discipline-pin", () => {
  const OLDER_DISCIPLINES: Policy = (f) => f !== DISCIPLINES_REGISTRY_FEATURE;

  it("a pinned firm:low_voltage is writable on that model only, and unpinning closes it again", () => {
    const pinned = commit(model("x8-pin"), { type: "pin_firm_discipline", discipline: LOW_VOLTAGE });
    expect(pinned.summary).toContain("Low voltage is a discipline on this model");
    expect(pinned.model.elements[disciplineSetupId("firm:low_voltage")]).toMatchObject({ kind: "organization", entry: { type: "discipline", discipline: LOW_VOLTAGE } });
    const filed = commit(pinned.model, view("firm:low_voltage"));
    expect(filed.model.elements["v-firmlowvoltage"]?.partition?.discipline).toBe("firm:low_voltage");
    // Writing a registered discipline still needs peers that store it (lane D's gate).
    expect(attempt(pinned.model, view("firm:low_voltage"), OLDER_DISCIPLINES)).toMatch(/older version that doesn't store that discipline/);

    expect(attempt(model("x8-pin-other"), view("firm:low_voltage"))).toMatch(/^Low voltage isn't a discipline in this model's firm library/);

    const unpinned = commit(filed.model, { type: "unpin_firm_discipline", disciplineId: "firm:low_voltage" });
    expect(unpinned.summary).toEqual(["Low voltage is no longer a discipline on this model", "1 element stay filed under it and keep its name; new work can't be filed there"]);
    expect(unpinned.model.elements["v-firmlowvoltage"]?.partition?.discipline).toBe("firm:low_voltage");
    expect(attempt(unpinned.model, view("firm:low_voltage", "v-again"))).toMatch(/^Low voltage isn't a discipline/);
  });

  it("the parent must be on this model; re-pinning the same row writes nothing; a changed row replaces the copy", () => {
    const start = model("x8-pin-parent");
    expect(attempt(start, { type: "pin_firm_discipline", discipline: { ...LOW_VOLTAGE, id: "firm:elevator_pits", label: "Elevator pits", parent: "vt.elevators" } })).toBe(
      'Elevator pits is filed under "vt.elevators", which this model doesn\'t have. Pin that discipline first, or switch on the add-on it comes from',
    );
    const pinned = commit(start, { type: "pin_firm_discipline", discipline: LOW_VOLTAGE }).model;
    expect(commit(pinned, { type: "pin_firm_discipline", discipline: LOW_VOLTAGE }).summary).toContain("Low voltage is already pinned to this model");
    const renamed = commit(pinned, { type: "pin_firm_discipline", discipline: { ...LOW_VOLTAGE, label: "Low voltage and data" } });
    expect(renamed.summary).toContain("Low voltage and data on this model now matches the firm library");
    // A firm row under another pinned firm row is fine; its parent can't be unpinned first.
    const child = commit(pinned, { type: "pin_firm_discipline", discipline: { id: "firm:security", label: "Security", parent: "firm:low_voltage", display: { colour: "#be123c" } } }).model;
    expect(attempt(child, { type: "unpin_firm_discipline", disciplineId: "firm:low_voltage" })).toBe("Security is filed under Low voltage. Unpin it first");
    expect(attempt(start, { type: "pin_firm_discipline", discipline: { ...LOW_VOLTAGE, id: "low_voltage" } })).toMatch(/firm:<name>/);
  });

  it("client and server binders over the same installed list resolve the same set", () => {
    const pinned = commit(commit(model("x8-two-hosts"), { type: "pin_firm_discipline", discipline: LOW_VOLTAGE }).model, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true }).model;
    const client = createModelStateBinder(() => [VT]);
    const server = createModelStateBinder(() => [VT]);
    const a = client(pinned);
    const b = server(pinned);
    expect(a?.revision).toBe(b?.revision);
    expect(a?.has("vt")).toBe(true);
    expect(a?.firmItems(DISCIPLINE_POINT).map((d) => d.id)).toEqual(["firm:low_voltage"]);
    // Memoised: the same state (and a later one with the same setup) returns the same set object.
    expect(client(pinned)).toBe(a);
    const later = commit(pinned, { type: "create_level", levelId: "lvl-2", name: "L2", elevationMm: 3000 }).model;
    expect(client(later)).toBe(a);
  });
});

describe("x8 perf: kernel.packs.lookup is unchanged by setup entries", () => {
  it("resolving a set from a state with setup entries stays a few map reads (≤ 2,000 ns)", () => {
    const pinned = commit(commit(model("x8-perf"), { type: "pin_firm_discipline", discipline: LOW_VOLTAGE }).model, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true }).model;
    const binder = createModelStateBinder(() => host);
    binder(pinned);
    const n = 20000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) binder(pinned);
    const perCall = Number(process.hrtime.bigint() - t0) / n;
    process.stdout.write(`[x8] kernel.packs.state_lookup ${perCall.toFixed(0)} ns\n`);
    expect(perCall).toBeLessThan(2000);
  });
});

it("setup records are attributed edits like any organization record", () => {
  const on = commit(model("x8-attrib"), { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true });
  expect(on.changeset.elements.map((e) => e.id)).toEqual([addonSetupId("vt")]);
  expect(on.changeset.actor.id).toBe("avery");
  expect(canonicalJson(on.model.elements[addonSetupId("vt")]?.partition)).toBe(canonicalJson({ level: "*", zone: "organization", discipline: "architecture" }));
});
