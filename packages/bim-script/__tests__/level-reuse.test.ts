/**
 * @jest-environment node
 *
 * #104: a new model starts with "Level 1" (the tool server's and the hosted
 * app's starter model), and every example script makes "Level 1" at 0 with
 * building.level. The kernel refuses a second level with a taken name, so the
 * examples stopped on a new model. building.level now uses the level the
 * script read when the name and elevation match; anything else is as before.
 *
 * Fails on the old kit: building.level always sends create_level.
 */
import { DEFAULT_SETTINGS, executeCommand, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { building, defineScript, runScript, sliceModel, units } from "../src";

type ScriptReads = Parameters<typeof sliceModel>[1];

/** The starter model: one level, "Level 1" at 0. */
function starter(): ModelState {
  const empty: ModelState = { modelId: "level-reuse", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const r = executeCommand(empty, { type: "create_level", levelId: "level-1", name: "Level 1", elevationMm: 0 });
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

/** Runs building.level once and returns the id it gave and the commands the script sent. */
async function level(reads: ScriptReads, name: string, elevationFt: number): Promise<{ id: string; commands: readonly { type: string }[] }> {
  let id = "";
  const script = defineScript({ kind: "layout", reads, parameters: {}, run: (ctx) => {
    id = building.level(ctx, { name, elevation: units.ft(elevationFt) });
    // A script that makes no edit must report something.
    ctx.report("Level", id);
  } });
  const out = await runScript(script, { slice: sliceModel(starter(), script.manifest.reads), values: {}, scriptHash: "sha256:level-reuse" });
  return { id, commands: out.kind === "edits" ? out.batches.flatMap((b) => b.commands) : [] };
}

describe("building.level uses a level the model already has", () => {
  it("returns Level 1's id and sends nothing when the name and elevation match", async () => {
    const { id, commands } = await level({ levels: true }, "Level 1", 0);
    expect(id).toBe("level-1");
    expect(commands).toEqual([]);
  });

  it("matches the name as level arguments do, case and spaces aside", async () => {
    expect((await level({ levels: true }, " level 1 ", 0)).id).toBe("level-1");
  });

  it("still refuses the name at another elevation, in the kernel's words", async () => {
    await expect(level({ levels: true }, "Level 1", 12)).rejects.toThrow(/There is already a level named Level 1/);
  });

  it("makes a level when the script didn't read the levels, as before", async () => {
    const { commands } = await level({}, "Level 1", 0);
    expect(commands).toEqual([expect.objectContaining({ type: "create_level", name: "Level 1" })]);
  });

  it("makes a new level with a new name", async () => {
    const { id, commands } = await level({ levels: true }, "Level 2", 12);
    expect(id).not.toBe("level-1");
    expect(commands).toEqual([expect.objectContaining({ type: "create_level", name: "Level 2", levelId: id })]);
  });
});
