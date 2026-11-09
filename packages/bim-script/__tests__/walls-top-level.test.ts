/**
 * @jest-environment node
 *
 * Showcase run, Nov 8: `building.walls` took only a fixed height, so a script
 * that wanted exterior walls running floor to floor had to send the kernel's
 * raw `create_elements` with `topLevelId` itself. The kernel has carried a
 * wall's top tied to a level since #3371; the kit now says so.
 *
 * Fails on the old kit: the command carries no `topLevelId`, and the wall
 * keeps the kernel's default height instead of running up to Level 2.
 */
import { DEFAULT_SETTINGS, ELEMENTS_CREATE_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE, executeCommand, withUpgradePolicy, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { building, defineScript, runScript, sliceModel, units } from "../src";

const FT = 304.8;
/** A model server that takes drawn elements and stores wall tops tied to levels. */
const FEATURES = [ELEMENTS_CREATE_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE];
const peerReads = (f: string) => FEATURES.includes(f);

function twoLevels(): ModelState {
  let m: ModelState = { modelId: "walls-top", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of [
    { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
    { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 12 * FT },
  ] as const) {
    const r = executeCommand(m, command);
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  }
  return m;
}

const tied = defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    building.walls(ctx, { level: "L1", points: [{ x: units.ft(0), y: units.ft(0) }, { x: units.ft(30), y: units.ft(0) }], thickness: units.in(8), topLevel: "L2", topOffset: units.in(-6), id: "ext" });
  },
});

describe("building.walls can run a wall's top up to a level", () => {
  it("sends the tie, and the kernel makes a wall from Level 1 to 6 in below Level 2", async () => {
    const m = twoLevels();
    const out = await runScript(tied, { slice: sliceModel(m, tied.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:walls-top" });
    const commands = out.kind === "edits" ? out.batches.flatMap((b) => b.commands) : [];
    expect(commands).toEqual([expect.objectContaining({ type: "create_elements", kind: "wall", topLevelId: "L2", topOffsetMm: -152.4 })]);
    const r = withUpgradePolicy(peerReads, () => executeCommand(m, commands[0] as Command));
    if (!r.ok) throw new Error(r.error.message);
    const wall = r.model.elements["ext-1"];
    expect(wall?.kind === "wall" && wall.height).toBe(Math.round(12 * FT - 152.4));
    expect(wall && "placement" in wall && wall.placement?.kind === "line" && wall.placement.topLevelId).toBe("L2");
  });

  it("refuses an offset with no top level, in plain words", async () => {
    const bad = defineScript({ kind: "layout", reads: {}, parameters: {}, run: (ctx) => void building.walls(ctx, { level: "L1", points: [{ x: units.ft(0), y: units.ft(0) }, { x: units.ft(10), y: units.ft(0) }], topOffset: units.in(6) }) });
    await expect(runScript(bad, { slice: sliceModel(twoLevels(), {}), values: {}, scriptHash: "sha256:bad" })).rejects.toThrow(/needs the level the top runs up to/);
  });
});
