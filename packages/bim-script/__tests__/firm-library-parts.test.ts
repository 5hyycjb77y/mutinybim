/**
 * @jest-environment node
 *
 * A script places a part from the host's library (a firm's), the same way it
 * places a built-in: the host puts the definitions the script's
 * `reads.partTypes` name into the slice, and `equipment.place` sends one's
 * definition with the placement. Before, a library part that wasn't in the
 * model yet was refused "isn't in this model yet; send its definition", and
 * the sealed runner had no way to get it. Nothing here names a firm: the open
 * kit ships no library parts.
 */
import { DEFAULT_SETTINGS, exampleFloorDrain, type BimElement, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { checkScriptOutput, defineScript, equipment, modelSliceSchema, runScript, sliceModel, units } from "../src";

const DRAIN = { ...exampleFloorDrain(), typeName: "Library floor drain" };
const LIBRARY = { "lib.floor-drain-3": DRAIN, "lib.other": { ...DRAIN, typeName: "Other" } };

function model(): ModelState {
  const els = [{ id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 }] as unknown as BimElement[];
  return { modelId: "lib", revision: 2 as Revision, elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

const placeDrain = defineScript({
  kind: "layout",
  reads: { levels: true, partTypes: ["lib.floor-drain-*"] },
  parameters: {},
  run(ctx) {
    equipment.place(ctx, { level: "L1", type: "lib.floor-drain-3", at: { x: units.ft(2), y: units.ft(2) }, mark: "FD-1" });
  },
});

describe("library parts from a script", () => {
  it("the slice carries only the library parts the script names, and the runner's parse keeps them", () => {
    const slice = sliceModel(model(), placeDrain.manifest.reads, [], [], LIBRARY);
    expect(Object.keys(slice.partLibrary ?? {})).toEqual(["lib.floor-drain-3"]);
    const parsed = modelSliceSchema.parse(JSON.parse(JSON.stringify(slice)));
    expect(Object.keys(parsed.partLibrary ?? {})).toEqual(["lib.floor-drain-3"]);
    expect(sliceModel(model(), { levels: true }, [], [], LIBRARY).partLibrary).toBeUndefined();
  });

  it("equipment.place sends the library part's definition, and the model takes it", async () => {
    const slice = JSON.parse(JSON.stringify(sliceModel(model(), placeDrain.manifest.reads, [], [], LIBRARY)));
    const out = await runScript(placeDrain, { slice: modelSliceSchema.parse(slice), values: {}, scriptHash: `sha256:${"3".repeat(64)}` });
    const [place] = out.kind === "edits" ? out.batches.flatMap((b) => b.commands) : [];
    expect(place).toMatchObject({ type: "place_part", typeId: "lib.floor-drain-3", partType: { typeName: "Library floor drain" } });
    const check = checkScriptOutput(model(), JSON.parse(JSON.stringify(out)));
    expect(check.kind === "edits" && check.batches.map((b) => b.status)).toEqual(["checked"]);
  });

  it("with no library in the slice the kernel's own refusal stands", async () => {
    await expect(runScript(placeDrain, { slice: sliceModel(model(), placeDrain.manifest.reads), values: {}, scriptHash: `sha256:${"4".repeat(64)}` })).rejects.toThrow(/lib.floor-drain-3 isn't in this model yet/);
  });
});
