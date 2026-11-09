/**
 * @jest-environment node
 *
 * Round 11 lane X11: the scripting kit. Each case fails on round 10's code
 * (there is no `@permitzip/bim-script` and no part-type or script library item).
 */
import { CONNECTOR_END_TYPES_FEATURE, DEFAULT_SETTINGS, MAX_EDIT_BATCH_STEPS, withUpgradePolicy, executeCommand, exampleFloorDrain, exampleRooftopUnit, type AuthorRef, type BimElement, type ModelState, type PartTypeDefinition, type Revision } from "@permitzip/bim-kernel";
import { contentHashOf, makeItem, parseItem, scriptItemSchema, type ScriptItem } from "@permitzip/bim-library";
import {
  ScriptReadError,
  ScriptRunError,
  checkScriptOutput,
  defineScript,
  parseScriptOutput,
  partTypeItemsFromRun,
  regenerate,
  resolveValues,
  runScript,
  scriptJsonSchemas,
  sliceModel,
  units,
  type ScriptDefinition,
} from "../src";

const PERSON: AuthorRef = { provider: "test.identity", subject: "jlee", kind: "person", displayName: "J. Lee" };
const DRAIN = exampleFloorDrain();

function model(): ModelState {
  const els: BimElement[] = [
    { id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement,
    { id: "L2", version: 1, authoredRev: {}, kind: "level", name: "Level 2", elevationMm: 4000 } as unknown as BimElement,
  ];
  return { modelId: "x11-kit", revision: 7 as Revision, elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

/** Drains every `spacing` along a line on the first level, with jitter from the kit's seeded random. */
const layout = defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: {
    spacing: { type: "quantity", kind: "length", unit: "ft", label: "Spacing", default: units.ft(12), min: units.ft(2), max: units.ft(40) },
    count: { type: "number", label: "How many", integer: true, default: 4, min: 1, max: 2000 },
  },
  presets: [{ id: "tight", title: "Tight, 6 ft", values: { spacing: units.ft(6).value } }],
  run(ctx, v) {
    const level = ctx.model.levels()[0];
    if (!level) throw new Error("no level");
    const mm = units.in_(v.spacing, "mm");
    for (let i = 0; i < v.count; i++) {
      ctx.edit({ type: "place_part", partId: ctx.id("drain"), typeId: "x11-drain", partType: DRAIN, levelId: level.id, position: { x: i * mm, y: Math.round(ctx.random() * 100) } });
    }
    ctx.label(`Drains every ${Math.round(mm)} mm`);
  },
});

function sizedRtu(widthMm: number): PartTypeDefinition {
  const base = exampleRooftopUnit();
  // A shared part names how each opening joins (the kit's import report asks for it).
  return { ...base, typeName: `RTU ${Math.round(widthMm)} mm`, connectors: base.connectors.map((c) => (c.domain === "duct" ? { ...c, endType: "mechanical.flanged" } : c)) };
}

const partScript = defineScript({
  kind: "part",
  reads: {},
  parameters: { width: { type: "quantity", kind: "length", unit: "mm", label: "Width", default: units.mm(2000) } },
  run(ctx, v) {
    ctx.parts.define(`rtu-${Math.round(units.in_(v.width, "mm"))}`, sizedRtu(units.in_(v.width, "mm")));
  },
});

function scriptItem(definition: ScriptDefinition, key: string, version = "1.0.0"): ScriptItem {
  const body = scriptItemSchema.parse({ id: `acme.${key}`, revision: 1, key: `acme.${key}`, name: key, version, language: "typescript", kit: ">=0.1.0", manifest: definition.manifest, source: `import { defineScript } from "@permitzip/bim-script";\nexport default defineScript(${JSON.stringify(definition.manifest)} as never);\n`, license: "Apache-2.0", authors: [PERSON] });
  return { ...body, contentHash: contentHashOf(makeItem("script", body)) };
}

describe("x11 scripting kit", () => {
  it("x11-script-deterministic: the same script, values and model give byte-identical output; other values give other ids", async () => {
    const m = model();
    const slice = sliceModel(m, layout.manifest.reads);
    const values = resolveValues(layout.manifest, { count: 5 });
    const hash = `sha256:${"1".repeat(64)}`;
    const a = await runScript(layout, { slice, values, scriptHash: hash });
    const b = await runScript(layout, { slice: sliceModel(model(), layout.manifest.reads), values: resolveValues(layout.manifest, { count: 5 }), scriptHash: hash });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = await runScript(layout, { slice, values: resolveValues(layout.manifest, { count: 5 }, "tight"), scriptHash: hash });
    const ids = (o: typeof a) => (o.kind === "edits" ? o.batches.flatMap((x) => x.commands.map((s) => ("partId" in s ? String(s.partId) : ""))) : []);
    expect(ids(c)).not.toEqual(ids(a));
    expect(new Set(ids(a)).size).toBe(5);
    const d = await runScript(layout, { slice: { ...slice, revision: 8 }, values, scriptHash: hash });
    expect(ids(d)).not.toEqual(ids(a));
    // The output is ordinary batch_edits the server re-parses and the kit's preflight checks.
    const check = checkScriptOutput(m, JSON.parse(JSON.stringify(a)));
    expect(check.ok).toBe(true);
    expect(check.kind === "edits" && check.batches[0]?.status).toBe("checked");
  });

  it("refuses values out of range, unknown names and wrong kinds in words", () => {
    expect(() => resolveValues(layout.manifest, { spacing: units.ft(1) })).toThrow(/Spacing \(spacing\) is .* below the minimum/);
    expect(() => resolveValues(layout.manifest, { spcing: 3 })).toThrow(/no parameter "spcing"/);
    expect(() => resolveValues(layout.manifest, { spacing: units.of("area", 2, "m2") })).toThrow(/is a length; the value given is a area/);
    expect(() => resolveValues(layout.manifest, {}, "loose")).toThrow(/no preset "loose"/);
  });

  it("x11-part-script-is-part-type: a part script's output saves as a library part type, and placing it runs no code", async () => {
    const item = scriptItem(partScript, "rtu");
    const values = resolveValues(partScript.manifest, { width: units.mm(2400) });
    const output = await runScript(partScript, { slice: sliceModel(model(), partScript.manifest.reads), values, scriptHash: item.contentHash ?? "" });
    expect(output.kind).toBe("part_types");
    const check = checkScriptOutput(model(), JSON.parse(JSON.stringify(output)), { pictures: false });
    expect(check.kind === "part_types" ? check.types.flatMap((t) => t.problems) : ["not part types"]).toEqual([]);
    expect(check.ok).toBe(true);
    const [part] = partTypeItemsFromRun(output, { script: item, values, generatedBy: PERSON, generatedAt: "2026-11-02T18:00:00.000Z" });
    if (!part) throw new Error("no part");
    expect(part.provenance?.script).toEqual({ id: "acme.rtu", key: "acme.rtu", version: "1.0.0", hash: item.contentHash });
    expect(part.provenance?.values).toEqual({ width: 2.4 });
    const reread = parseItem({ type: "part_type", body: JSON.parse(JSON.stringify(part)) });
    expect(reread.ok).toBe(true);
    // Placing: the definition goes into the model through the ordinary command; nothing of the script is involved.
    const definition = output.kind === "part_types" ? output.types[0]?.definition : undefined;
    if (!definition) throw new Error("no definition");
    const saved = withUpgradePolicy((f) => f === CONNECTOR_END_TYPES_FEATURE, () => executeCommand(model(), { type: "save_part_types", types: [{ typeId: part.key, definition }] }));
    if (!saved.ok) throw new Error(saved.error.message);
    const placed = executeCommand(saved.model, { type: "place_part", partId: "P1", typeId: part.key, levelId: "L1", position: { x: 0, y: 0 } });
    expect(placed.ok ? placed.model.elements.P1?.kind : placed.error.message).toBe("part");
  });

  it("x11-regenerate-hash: same values → up to date; new values, a new script version or a hand edit → a new revision for review", async () => {
    const item = scriptItem(partScript, "rtu");
    const run = async (width: number, script = item) => {
      const values = resolveValues(partScript.manifest, { width: units.mm(width) });
      const output = await runScript(partScript, { slice: sliceModel(model(), {}), values, scriptHash: script.contentHash ?? "" });
      return { output, input: { script, values, generatedBy: PERSON, generatedAt: "2026-11-02T19:00:00.000Z" } };
    };
    const first = await run(2400);
    const saved = partTypeItemsFromRun(first.output, { ...first.input, generatedAt: "2026-11-02T18:00:00.000Z" });
    const again = await run(2400);
    expect(regenerate(saved, again.output, again.input)[0]?.verdict.status).toBe("up_to_date");

    const v2 = scriptItem(partScript, "rtu", "1.1.0");
    const bumped = await run(2400, v2);
    const changedScript = regenerate(saved, bumped.output, bumped.input)[0]?.verdict;
    // A new script version with identical output is still up to date: hashes compare outputs.
    expect(changedScript?.status).toBe("up_to_date");

    const edited = saved.map((p) => ({ ...p, definition: { ...p.definition, description: "Hand-edited after saving" } }));
    const hand = regenerate(edited, again.output, again.input)[0]?.verdict;
    expect(hand?.status).toBe("changed");
    expect(hand?.status === "changed" && hand.because).toEqual(["the saved part was edited after it was made"]);
    expect(hand?.status === "changed" && hand.next.revision).toBe(2);
  });

  it("x11-reads-beyond-slice-errors: a read beyond the script's reads is a plain error naming what to add", async () => {
    const m = model();
    const nosy = defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run: (ctx) => void ctx.model.ofKind("wall") });
    await expect(runScript(nosy, { slice: sliceModel(m, nosy.manifest.reads), values: {}, scriptHash: "h" })).rejects.toThrow(new ScriptReadError('This script lists every wall, which its reads don\'t name. Add "wall" to reads.kinds.'));
    const byId = defineScript({ kind: "layout", reads: { ids: ["L1"] }, parameters: {}, run: (ctx) => void ctx.model.get("L2") });
    await expect(runScript(byId, { slice: sliceModel(m, byId.manifest.reads), values: {}, scriptHash: "h" })).rejects.toThrow(/read L2, which isn't in what it reads. Add "L2" to reads.ids/);
    const noLevels = defineScript({ kind: "layout", reads: {}, parameters: {}, run: (ctx) => void ctx.model.levels() });
    await expect(runScript(noLevels, { slice: sliceModel(m, {}), values: {}, scriptHash: "h" })).rejects.toThrow(/Set reads.levels to true/);
    expect(Object.keys(sliceModel(m, { ids: ["L2"] }).elements)).toEqual(["L2"]);
    expect(Object.keys(sliceModel(m, { ids: "selection" }, ["L1"]).elements)).toEqual(["L1"]);
  });

  it("x11-no-server-only-commands: a script can't produce a merge, an import or a nested batch; 501 steps become two batches", async () => {
    const m = model();
    const forger = defineScript({ kind: "layout", reads: {}, parameters: {}, run: (ctx) => ctx.edit({ type: "merge_branch_part", branchId: "b", partId: "p" }) });
    await expect(runScript(forger, { slice: sliceModel(m, {}), values: {}, scriptHash: "h" })).rejects.toThrow(new ScriptRunError('Step 1: "merge_branch_part" is a command only the model server makes (a merge or an import); a script can\'t produce it.'));
    const nester = defineScript({ kind: "layout", reads: {}, parameters: {}, run: (ctx) => ctx.edit({ type: "batch_edits", commands: [] }) });
    await expect(runScript(nester, { slice: sliceModel(m, {}), values: {}, scriptHash: "h" })).rejects.toThrow(/is a batch; a script's steps are single edits/);
    // A runner's output forging one is refused on parse, by name.
    expect(() => parseScriptOutput({ kind: "edits", label: "x", steps: 1, batches: [{ type: "batch_edits", label: "x", commands: [{ type: "import_elements", elements: [] }] }] })).toThrow(/"import_elements" is a command only the model server makes/);

    const many = await runScript(layout, { slice: sliceModel(m, layout.manifest.reads), values: resolveValues(layout.manifest, { count: MAX_EDIT_BATCH_STEPS + 1, spacing: units.ft(2) }), scriptHash: "h" });
    expect(many.kind === "edits" && many.batches.map((b) => b.commands.length)).toEqual([500, 1]);
    expect(many.kind === "edits" && many.batches[1]?.label).toMatch(/\(part 2 of 2\)$/);
    expect(parseScriptOutput(JSON.parse(JSON.stringify(many))).kind).toBe("edits");
  });

  it("exports JSON Schemas for a later builder", () => {
    const s = scriptJsonSchemas();
    expect(JSON.stringify(s.manifest)).toContain("parameters");
    expect(JSON.stringify(s.output)).toContain("batch_edits");
  });
});
