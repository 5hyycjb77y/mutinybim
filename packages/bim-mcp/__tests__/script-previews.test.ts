/**
 * @jest-environment node
 *
 * Kept scripts (scripts/previews.ts): what an id is bound to, exact
 * replacements, and the in-memory store. None of this existed before scripts
 * were sent once, so every case fails on the code before it.
 */
import {
  KEPT_PREVIEWS_MAX,
  KEPT_SCRIPT_ID,
  KEPT_SCRIPT_KEEP_MS,
  MemoryScriptPreviewStore,
  applyReplacements,
  keepScript,
  keptScriptId,
  notePreview,
  parseKeptScript,
  previewOf,
  readKeptScript,
  type KeptPreview,
  type KeptScript,
  type ScriptPreviewStore,
} from "@permitzip/bim-mcp";
import { declaredReadsOf } from "../src/scripts/tools";

const SOURCE = 'import { defineScript } from "@permitzip/bim-script";\nexport default defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run(ctx) {} });\n';
const READS = { levels: true };
const T0 = 1_800_000_000_000;

const preview = (over: Partial<KeptPreview> = {}): KeptPreview => ({ projectId: "local", modelId: "demo", level: null, zone: null, values: {}, selection: null, outputHash: `sha256:${"a".repeat(64)}`, at: T0, ...over });

describe("script-previews: what a script id is bound to", () => {
  it("the id is a fingerprint of the person, the text and the reads", () => {
    const id = keptScriptId("sam", SOURCE, READS);
    expect(id).toMatch(KEPT_SCRIPT_ID);
    expect(keptScriptId("sam", SOURCE, READS)).toBe(id);
    expect(keptScriptId("pat", SOURCE, READS)).not.toBe(id);
    expect(keptScriptId("sam", `${SOURCE} `, READS)).not.toBe(id);
    expect(keptScriptId("sam", SOURCE, { levels: true, kinds: ["wall"] })).not.toBe(id);
  });

  it("only the person who sent a script reads it back, and only before it expires", async () => {
    const store = new MemoryScriptPreviewStore(() => T0);
    const kept = await keepScript(store, "sam", SOURCE, READS, T0);
    expect(kept.expiresAt).toBe(T0 + KEPT_SCRIPT_KEEP_MS);
    expect(await readKeptScript(store, "sam", kept.id, T0 + 1)).toMatchObject({ id: kept.id, source: SOURCE, reads: READS });
    expect(await readKeptScript(store, "pat", kept.id, T0 + 1)).toBeNull();
    expect(await readKeptScript(store, "sam", kept.id, T0 + KEPT_SCRIPT_KEEP_MS)).toBeNull();
    expect(await readKeptScript(store, "sam", "scr_not-an-id", T0)).toBeNull();
    expect(await readKeptScript(store, "sam", keptScriptId("sam", "another script", READS), T0)).toBeNull();
  });

  it("a record whose text was swapped in the store no longer matches its id and is not used", async () => {
    const real = new MemoryScriptPreviewStore(() => T0);
    const kept = await keepScript(real, "sam", SOURCE, READS, T0);
    const swapped: ScriptPreviewStore = { put: async () => undefined, get: async () => ({ ...kept, source: SOURCE.replace("run(ctx) {}", 'run(ctx) { ctx.edit({ type: "delete_elements", ids: ["x"] }); }') }) };
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await readKeptScript(swapped, "sam", kept.id, T0 + 1)).toBeNull();
    expect(errors).toHaveBeenCalled();
    const otherOwner: ScriptPreviewStore = { put: async () => undefined, get: async () => ({ ...kept, ownerId: "pat" }) };
    expect(await readKeptScript(otherOwner, "pat", kept.id, T0 + 1)).toBeNull();
  });

  it("keeping a script again starts its time over and keeps its previews; a preview is found by project, model and output", async () => {
    const store = new MemoryScriptPreviewStore(() => T0);
    const kept = await keepScript(store, "sam", SOURCE, READS, T0);
    const noted = await notePreview(store, kept, preview({ values: { height: 3 } }));
    expect(previewOf(noted, { projectId: "local", modelId: "demo", outputHash: preview().outputHash })).toMatchObject({ values: { height: 3 } });
    expect(previewOf(noted, { projectId: "local", modelId: "other", outputHash: preview().outputHash })).toBeNull();
    expect(previewOf(noted, { projectId: "local", modelId: "demo", outputHash: `sha256:${"b".repeat(64)}` })).toBeNull();
    const again = await keepScript(store, "sam", SOURCE, READS, T0 + 5_000);
    expect(again.id).toBe(kept.id);
    expect(again.expiresAt).toBe(T0 + 5_000 + KEPT_SCRIPT_KEEP_MS);
    expect(again.previews).toHaveLength(1);
  });

  it("the same run is noted once, the newest first, and only the newest few are kept", async () => {
    const store = new MemoryScriptPreviewStore(() => T0);
    let kept: KeptScript = await keepScript(store, "sam", SOURCE, READS, T0);
    kept = await notePreview(store, kept, preview({ values: { n: 1 } }));
    kept = await notePreview(store, kept, preview({ values: { n: 2 }, at: T0 + 1 }));
    expect(kept.previews).toHaveLength(1);
    expect(kept.previews[0]?.values).toEqual({ n: 2 });
    for (let i = 0; i < KEPT_PREVIEWS_MAX + 3; i++) kept = await notePreview(store, kept, preview({ outputHash: `sha256:${String(i).padStart(64, "0")}`, at: T0 + 10 + i }));
    expect(kept.previews).toHaveLength(KEPT_PREVIEWS_MAX);
    expect(kept.previews[0]?.outputHash).toBe(`sha256:${String(KEPT_PREVIEWS_MAX + 2).padStart(64, "0")}`);
  });

  it("a record comes back whole from JSON, and anything else is not a record", async () => {
    const store = new MemoryScriptPreviewStore(() => T0);
    const kept = await notePreview(store, await keepScript(store, "sam", SOURCE, READS, T0), preview({ selection: ["a", "b"], level: "L1" }));
    expect(parseKeptScript(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
    expect(parseKeptScript(null)).toBeNull();
    expect(parseKeptScript({ id: kept.id })).toBeNull();
    expect(parseKeptScript({ ...kept, reads: { levels: "yes" } })).toBeNull();
  });
});

describe("script-previews: the in-memory store", () => {
  it("drops a record once its time is up", async () => {
    let now = T0;
    const store = new MemoryScriptPreviewStore(() => now);
    const kept = await keepScript(store, "sam", SOURCE, READS, now);
    expect(await store.get(kept.id)).not.toBeNull();
    now = T0 + KEPT_SCRIPT_KEEP_MS + 1;
    expect(await store.get(kept.id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("holds a bounded number of scripts: the oldest go first, the newest stays", async () => {
    const store = new MemoryScriptPreviewStore(() => T0);
    const first = await keepScript(store, "sam", "script 0", READS, T0);
    let last = first;
    for (let i = 1; i <= 320; i++) last = await keepScript(store, "sam", `script ${i}`, READS, T0);
    expect(store.size).toBeLessThanOrEqual(300);
    expect(await store.get(first.id)).toBeNull();
    expect(await store.get(last.id)).not.toBeNull();
  });
});

describe("script-previews: exact replacements", () => {
  const text = ["const a = 1;", "const b = 2;", "const c = a + b;", "const d = a + b;"].join("\n");

  it("makes each replacement in order", () => {
    expect(applyReplacements(text, [{ old: "const a = 1;", new: "const a = 10;" }, { old: "const b = 2;", new: "const b = 20;" }])).toEqual({ ok: true, source: text.replace("= 1;", "= 10;").replace("= 2;", "= 20;") });
  });

  it("refuses text that isn't in the script, naming the replacement, and changes nothing", () => {
    const result = applyReplacements(text, [{ old: "const a = 1;", new: "const a = 10;" }, { old: "const z = 9;", new: "const z = 0;" }]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('Replacement 2 ("const z = 9;")');
    expect(!result.ok && result.message).toContain("isn't in the script");
    expect(!result.ok && result.message).toContain("Nothing was changed");
  });

  it("refuses text that is there more than once, with the lines, unless all is set", () => {
    const result = applyReplacements(text, [{ old: "a + b", new: "a * b" }]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("2 times (lines 3, 4)");
    expect(!result.ok && result.message).toContain("all: true");
    expect(applyReplacements(text, [{ old: "a + b", new: "a * b", all: true }])).toEqual({ ok: true, source: text.split("a + b").join("a * b") });
  });

  it("refuses a replacement that changes nothing", () => {
    expect(applyReplacements(text, [{ old: "const a = 1;", new: "const a = 1;" }])).toMatchObject({ ok: false, message: expect.stringContaining("changes nothing") });
  });
});

describe("script-previews: the reads a script declares, read from its text", () => {
  it("reads plain values, and gives up on anything else", () => {
    expect(declaredReadsOf(SOURCE)).toEqual({ levels: true });
    expect(declaredReadsOf("defineScript({ reads: { levels: true, kinds: ['wall', \"door\"], }, run() {} })")).toEqual({ levels: true, kinds: ["wall", "door"] });
    expect(declaredReadsOf('defineScript({ reads: { ids: "selection" } })')).toEqual({ ids: "selection" });
    expect(declaredReadsOf("defineScript({ reads: READS })")).toBeNull();
    expect(declaredReadsOf("defineScript({ reads: { ...base, levels: true } })")).toBeNull();
    expect(declaredReadsOf("no reads here")).toBeNull();
  });
});
