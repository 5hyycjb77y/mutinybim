/**
 * @jest-environment node
 *
 * Round 8 lane X, model server: a served model's set follows its own add-on
 * switches and pinned firm disciplines, on the commit path (the registered
 * binder) and for reads by id after the server rebinds from the head. Fails
 * on round 7: the server shipped no add-ons and bound only `settings.packs`.
 */
import { DEFAULT_SETTINGS, DISCIPLINE_POINT, addonSetupId, commandSchema, planCommit, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { activePackSet, unbindModelPacks, withModelPacks } from "@permitzip/bim-kernel/packs";
import { bindServedModelState, ensureFirstPartyAddOns, touchesModelSetup } from "../packs";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: unknown, peers: (f: string) => boolean = () => true) {
  seq += 1;
  const d = withUpgradePolicy(peers, () => planCommit(head, [], { idempotencyKey: `x8-served-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-31T00:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return d;
}

function model(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(empty, { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 }).model;
}

beforeAll(() => ensureFirstPartyAddOns());
afterEach(() => {
  unbindModelPacks("x8-served");
  unbindModelPacks("x8-served-other");
});

it("x8-preview-switch (server): a committed switch rebinds the served model; a model without one stays without", () => {
  const head = model("x8-served");
  bindServedModelState(head);
  expect(withModelPacks("x8-served", () => activePackSet().has("civil"))).toBe(false);
  const on = commit(head, { type: "set_model_addon", packId: "civil", version: "0.1.0", on: true });
  expect(touchesModelSetup(on.changeset.elements.map((e) => e.id))).toBe(true);
  expect(on.changeset.elements.map((e) => e.id)).toEqual([addonSetupId("civil")]);
  bindServedModelState(on.model);
  expect(withModelPacks("x8-served", () => activePackSet().has("civil"))).toBe(true);

  const other = model("x8-served-other");
  bindServedModelState(other);
  expect(withModelPacks("x8-served-other", () => activePackSet().has("civil"))).toBe(false);
});

it("x8-firm-discipline-pin (server binder): the commit path stores a view under the pinned firm discipline", () => {
  const pinned = commit(model("x8-served"), { type: "pin_firm_discipline", discipline: { id: "firm:low_voltage", label: "Low voltage", parent: "electrical", display: { colour: "#7c3aed" } } }).model;
  const viewed = commit(pinned, { type: "create_view", viewId: "v-lv", name: "LV plan", viewType: "floor_plan", props: { level: "L1", scale: 48, discipline: "firm:low_voltage" } }).model;
  expect(viewed.elements["v-lv"]?.partition?.discipline).toBe("firm:low_voltage");
  bindServedModelState(viewed);
  expect(withModelPacks("x8-served", () => activePackSet().firmItems(DISCIPLINE_POINT).map((d) => d.id))).toEqual(["firm:low_voltage"]);
});

it("x8-setup-entries-mixed-version (server): with an older client connected the switch is refused, never stored", () => {
  const head = model("x8-served");
  expect(() => commit(head, { type: "set_model_addon", packId: "civil", version: "0.1.0", on: true }, (f) => f !== "organization:setup")).toThrow(/older version that doesn't store add-on and discipline settings/);
});
