/**
 * @jest-environment node
 *
 * Round 8 (coordinator, closing lane X's open item 2): reads that run an
 * add-on's contribution (proposers here; graph reads go through the same
 * `withModelStatePacks`) resolve the add-on set from the model state they are
 * handed, like `executeCommand` does. Fails on round 7's reads by id
 * (`withModelPacks(model.modelId)`): right after an add-on is switched on, a
 * host that has not rebound yet saw no proposer, and a preview of a switch
 * could not be read before it was committed.
 */
import { DEFAULT_SETTINGS, PROPOSER_POINT, commandSchema, executeCommand, installModelSetupHost, proposersFor, runProposer, withUpgradePolicy, type ModelState, type ProposerDef } from "../src";
import { contribute, definePack, type Pack } from "../src/packs";

const ECHO: ProposerDef = {
  id: "zs.echo",
  label: "Echo",
  hosts: "rooms",
  propose: (_model, request) => ({ ghosts: [], summary: `echo ${request.roomIds.length}`, passes: true, notes: [] }),
};
const ZS: Pack = definePack({ id: "zs", name: "State-read test", version: "1.0.0", kernel: "^1.5.0" }, [contribute(PROPOSER_POINT, [ECHO])]);

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [ZS]);
});
afterAll(() => uninstall());

function run(head: ModelState, command: unknown): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(head, commandSchema.parse(command)));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

function model(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return run(empty, { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 });
}

describe("x8-state-reads", () => {
  it("a proposer appears on the state that switched its add-on on, with no host rebind, and only there", () => {
    const off = model("x8-state-a");
    expect(proposersFor(off).map((p) => p.id)).not.toContain("zs.echo");
    const on = run(off, { type: "set_model_addon", packId: "zs", version: "1.0.0", on: true });
    expect(proposersFor(on).map((p) => p.id)).toContain("zs.echo");
    expect(runProposer(on, "zs.echo", { typeId: "t", roomIds: ["r1", "r2"] })).toMatchObject({ summary: "echo 2" });
    // The head it came from (same model id) is untouched: a preview never leaks into reads of the head.
    expect(proposersFor(off).map((p) => p.id)).not.toContain("zs.echo");
    expect(proposersFor(model("x8-state-b")).map((p) => p.id)).not.toContain("zs.echo");
  });

  it("switching it off closes the proposer again", () => {
    const on = run(model("x8-state-c"), { type: "set_model_addon", packId: "zs", version: "1.0.0", on: true });
    const off = run(on, { type: "set_model_addon", packId: "zs", version: "1.0.0", on: false });
    expect(proposersFor(off).map((p) => p.id)).not.toContain("zs.echo");
    expect(runProposer(off, "zs.echo", { typeId: "t", roomIds: ["r1"] })).toMatchObject({ refused: expect.stringMatching(/Its add-on isn't loaded here/) });
  });
});
