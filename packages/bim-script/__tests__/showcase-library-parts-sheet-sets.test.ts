/**
 * @jest-environment node
 *
 * Nov 8 showcase. (2) A script placing a built-in part
 * (`builtin:water-closet-floor@1`) was refused "isn't in this model yet; send
 * its definition", and a script has no way to get the definition: the kit
 * now sends the definition from the library's part types (the kernel's and
 * the add-ons' rows). (4) The kit offered `documents.sheetSet`, which the
 * kernel refuses ("Sheet sets aren't built yet"): the kit no longer offers
 * it, and a script that sends the command is told why before anything runs.
 */
import { DEFAULT_SETTINGS, GLOBAL_PARTITION, builtinPartType, type BimElement, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import * as kit from "../src";

const { defineScript, equipment, runScript, sliceModel, units, checkScriptOutput } = kit;
const WC = "builtin:water-closet-floor@1";

function model(withType = false): ModelState {
  const els: BimElement[] = [{ id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement];
  const m: ModelState = { modelId: "showcase", revision: 3 as Revision, elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
  if (!withType) return m;
  const def = builtinPartType(WC)?.definition;
  if (!def) throw new Error("no built-in water closet");
  const type = { id: WC, kind: "part_type", version: 1, authoredRev: {}, partition: GLOBAL_PARTITION, definition: def } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, [WC]: type } };
}

const placeWc = defineScript({
  kind: "layout",
  reads: { levels: true, kinds: ["part_type"] },
  parameters: {},
  run(ctx) {
    equipment.place(ctx, { level: "L1", type: WC, at: { x: units.ft(4), y: units.ft(8) }, mark: "WC-1" });
    ctx.label("A water closet from the library");
  },
});

async function run(script: kit.ScriptDefinition, m: ModelState) {
  return runScript(script, { slice: sliceModel(m, script.manifest.reads), values: {}, scriptHash: `sha256:${"2".repeat(64)}` });
}
const steps = (o: kit.ScriptOutput): Command[] => (o.kind === "edits" ? o.batches.flatMap((b) => b.commands as Command[]) : []);

describe("showcase: library parts and sheet sets from a script", () => {
  it("a built-in part places from a script: the kit sends its definition, and the model takes it", async () => {
    const out = await run(placeWc, model());
    const [place] = steps(out);
    expect(place).toMatchObject({ type: "place_part", typeId: WC, partType: builtinPartType(WC)?.definition });
    const check = checkScriptOutput(model(), JSON.parse(JSON.stringify(out)));
    expect(check.kind === "edits" && check.batches.map((b) => b.status)).toEqual(["checked"]);
  });

  it("a type the model already has goes by id alone", async () => {
    const [place] = steps(await run(placeWc, model(true)));
    expect(place).toMatchObject({ type: "place_part", typeId: WC });
    expect(place && "partType" in place ? place.partType : undefined).toBeUndefined();
  });

  it("an id that is neither in the model nor in the library still gets the kernel's own refusal", async () => {
    const typo = defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run(ctx) {
      equipment.place(ctx, { level: "L1", type: "builtin:no-such-part@1", at: { x: units.ft(0), y: units.ft(0) } });
    } });
    await expect(run(typo, model())).rejects.toThrow(/builtin:no-such-part@1 isn't in this model yet/);
  });

  it("the kit offers no sheet set, and a script that sends one is told why", async () => {
    expect("sheetSet" in kit.documents).toBe(false);
    expect(kit.scriptCommands().map((c) => c.type)).not.toContain("create_sheet_set");
    const direct = defineScript({ kind: "layout", reads: {}, parameters: {}, run(ctx) {
      ctx.edit({ type: "create_sheet_set", setId: "set-1", name: "Permit set", sheetIds: [] });
    } });
    await expect(run(direct, model())).rejects.toThrow(/Sheet sets aren't built yet, so a script can't make one/);
  });
});
