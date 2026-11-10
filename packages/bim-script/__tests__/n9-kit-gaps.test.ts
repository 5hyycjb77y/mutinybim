/**
 * @jest-environment node
 *
 * Kit gaps an agent hit scripting a model, Nov 9: no ceiling helper (a raw
 * create_ceiling with units.ft arithmetic sent NaN), no way to see a value
 * but throwing, a room traced from walls the script never read ("nothing on
 * this level bounds rooms yet"), and level arguments given as names. Each
 * case fails on the kit before the fix.
 */
import { CEILINGS_FEATURE, DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type BimElement, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import {
  MAX_SCRIPT_REPORT_BYTES,
  ScriptOutputError,
  building,
  checkScriptOutput,
  defineScript,
  equipment,
  jsonBytes,
  parseScriptOutput,
  readsWarnings,
  runScript,
  sliceModel,
  units,
  type ScriptContext,
} from "@permitzip/bim-script";
import type { ScriptReads } from "@permitzip/bim-library";

const ft = units.ft;
const at = (x: number, y: number) => ({ x: ft(x), y: ft(y) });
const BOX = [at(0, 0), at(20, 0), at(20, 12), at(0, 12)];
const FEATURES = Object.values(PROTOCOL_FEATURES);

function head(extra: (m: ModelState) => ModelState = (m) => m): ModelState {
  const els = [
    { id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 },
    { id: "L2", version: 1, authoredRev: {}, kind: "level", name: "Level 2", elevationMm: 4000 },
    { id: "L3", version: 1, authoredRev: {}, kind: "level", name: "Mezzanine", elevationMm: 2000 },
    { id: "L4", version: 1, authoredRev: {}, kind: "level", name: "Mezzanine", elevationMm: 2500 },
  ] as unknown as BimElement[];
  return extra({ modelId: "n9", revision: 3 as Revision, elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS });
}

function walled(): ModelState {
  return head((m) => {
    const r = withUpgradePolicy(() => true, () => executeCommand(m, { type: "create_elements", idPrefix: "w", levelId: "L1", kind: "wall", points: BOX.map((p) => ({ x: p.x.value * 1000, y: p.y.value * 1000 })), closed: true, size: { thicknessMm: 150, heightMm: 3000 } }));
    if (!r.ok) throw new Error(r.error.message);
    return r.model;
  });
}

async function run(reads: ScriptReads, body: (ctx: ScriptContext) => void, model = head(), features: readonly string[] = FEATURES) {
  const def = defineScript({ kind: "layout", reads, parameters: {}, run: (ctx) => body(ctx) });
  return runScript(def, { slice: sliceModel(model, reads, [], features), values: {}, scriptHash: "sha256:n9" });
}

describe("building.ceiling", () => {
  it("makes a ceiling from units.* values, decided under the server's features", async () => {
    const out = await run({ levels: true }, (ctx) => void building.ceiling(ctx, { level: "L1", outline: BOX, height: ft(9), id: "c-1" }));
    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") return;
    const step = out.batches[0]?.commands[0];
    expect(step).toMatchObject({ type: "create_ceiling", ceilings: [{ ceilingId: "c-1", levelId: "L1", heightMm: 2743.2 }] });
    expect(checkScriptOutput(head(), out, { features: FEATURES }).ok).toBe(true);
  });

  it("is refused in the kernel's words only when the server doesn't store ceilings", async () => {
    const without = FEATURES.filter((f) => f !== CEILINGS_FEATURE);
    await expect(run({ levels: true }, (ctx) => void building.ceiling(ctx, { level: "L1", outline: BOX, height: ft(9) }), head(), without)).rejects.toThrow(/older version that doesn't store them/);
  });

  it("a raw edit with units.ft arithmetic says it is NaN and that commands take millimetres", async () => {
    await expect(
      run({ levels: true }, (ctx) => {
        const feet = ft(9) as unknown as number;
        ctx.edit({ type: "create_ceiling", ceilings: [{ ceilingId: "c-2", levelId: "L1", outline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3600 }], heightMm: Math.round(feet * 3048) / 10 }] });
      }),
    ).rejects.toThrow(/ceilings\[0\]\.heightMm is NaN.*plain millimetres/);
  });
});

describe("ctx.report", () => {
  it("returns what the script reported with its edits, and a script that only reports still runs", async () => {
    const out = await run({ levels: true }, (ctx) => {
      ctx.report("Levels", ctx.model.levels().map((l) => l.id));
      building.level(ctx, { name: "Roof", elevation: ft(30), id: "roof" });
    });
    expect(out.report).toEqual([{ label: "Levels", value: ["L1", "L2", "L3", "L4"] }]);
    const only = await run({ levels: true }, (ctx) => ctx.report("Count", ctx.model.levels().length));
    expect(only).toMatchObject({ kind: "edits", steps: 0, batches: [], report: [{ label: "Count", value: 4 }] });
    expect(parseScriptOutput(JSON.parse(JSON.stringify(only)))).toEqual(only);
  });

  it("a run that stops says what it reported first", async () => {
    await expect(
      run({ levels: true }, (ctx) => {
        ctx.report("Level ids", ["L1", "L2"]);
        throw new Error("not this one");
      }),
    ).rejects.toThrow(/not this one\. What it reported before stopping: Level ids: \["L1","L2"\]/);
  });

  it("takes plain data only, and keeps a run's reports to the limit", async () => {
    await expect(run({}, (ctx) => ctx.report("fn", () => 1))).rejects.toThrow(/plain data/);
    const big = await run({}, (ctx) => {
      for (let i = 0; i < 40; i++) ctx.report(`Chunk ${i}`, "x".repeat(1000));
    });
    expect(jsonBytes(big.report)).toBeLessThanOrEqual(MAX_SCRIPT_REPORT_BYTES);
    expect(big.report?.at(-1)?.label).toBe("more");
    expect(() => parseScriptOutput({ kind: "edits", label: "x", steps: 0, batches: [], report: [{ label: "big", value: "x".repeat(MAX_SCRIPT_REPORT_BYTES) }] })).toThrow(ScriptOutputError);
  });
});

describe("reads the call needs", () => {
  const traces = (ctx: ScriptContext) => void building.spaceInWalls(ctx, { level: "L1", inside: at(5, 5) });

  it("building.spaceInWalls says you didn't read walls when the model has them and the reads don't", async () => {
    await expect(run({ levels: true }, traces, walled())).rejects.toThrow(/you didn't read walls.*Add "wall" to reads\.kinds/);
    const out = await run({ levels: true, kinds: ["wall"] }, traces, walled());
    expect(out).toMatchObject({ kind: "edits", steps: 1 });
  });

  it("the check warns before the run, and not when the script reads or draws the walls", () => {
    const src = 'run(ctx) {\n  building.spaceInWalls(ctx, { level: "L1", inside: p });\n}';
    expect(readsWarnings(src, { levels: true })).toEqual([expect.objectContaining({ line: 2, rule: "reads", message: expect.stringMatching(/you didn't read walls: add "wall" to reads\.kinds/) })]);
    expect(readsWarnings(src, { levels: true, kinds: ["wall"] })).toEqual([]);
    expect(readsWarnings(`building.walls(ctx, w);\n${src}`, { levels: true })).toEqual([]);
  });

  it("the check warns about a level given by name when the script doesn't read the levels", () => {
    expect(readsWarnings('equipment.place(ctx, { level: "Level 2", type: "t", at: p });', {})).toEqual([expect.objectContaining({ line: 1, message: expect.stringMatching(/level's id/) })]);
    expect(readsWarnings('equipment.place(ctx, { level: "Level 2", type: "t", at: p });', { levels: true })).toEqual([]);
  });
});

describe("level arguments", () => {
  it("take a level's id, or the name of exactly one level the script read", async () => {
    const out = await run({ levels: true }, (ctx) => void building.ceiling(ctx, { level: "level 2", outline: BOX, height: ft(9) }));
    expect(out.kind === "edits" && out.batches[0]?.commands[0]).toMatchObject({ ceilings: [{ levelId: "L2" }] });
  });

  it("refuse a shared or unknown name with the levels there are", async () => {
    await expect(run({ levels: true }, (ctx) => void building.ceiling(ctx, { level: "Mezzanine", outline: BOX, height: ft(9) }))).rejects.toThrow(/2 levels are named "Mezzanine" \(L3, L4\)/);
    await expect(run({ levels: true }, (ctx) => void equipment.place(ctx, { level: "Roof", type: "builtin:plumbing-lavatory@1", at: at(1, 1) }))).rejects.toThrow(/"Roof" isn't a level here.*L1 \("Level 1"\)/);
  });
});
