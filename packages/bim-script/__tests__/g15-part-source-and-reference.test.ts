/** @jest-environment node */
import { DEFAULT_SETTINGS, GEOMETRY_SOLID_PROGRAM_2_FEATURE, executeCommand, partTypeDefinitionSchema, withUpgradePolicy, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { contentHashOf, makeItem, scriptItemSchema } from "@permitzip/bim-library";
import { defineScript, parts, partTypeItemsFromRun, runScript, searchReference, sliceModel, units } from "../src";

/**
 * G15 H7: a script's parts carry the source kind `script`, and saving them
 * (bim_save_part_type → partTypeItemsFromRun) names the saved script key and
 * version; an older peer is refused in words rather than sent a part it can't
 * store. H6: the script reference answers "part definition" with its shape.
 * Fails on round 14: the kit labelled every part "builtin" (bim-script-kit)
 * and the reference had no part definition.
 */

const PERSON = { provider: "test.identity", subject: "avery", kind: "person" } as const;

function head(): ModelState {
  return { modelId: "g15-src", revision: 1 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

const script = defineScript({
  kind: "part",
  reads: {},
  parameters: {},
  run(ctx) {
    ctx.parts.define("acme.duct_cap", parts.part("Duct cap", { type: "12", category: "duct_accessory" }).extrude(parts.circle(units.in(12)), { to: units.in(2) }).build());
  },
});

describe("g15-part-source-script", () => {
  it("the kit marks its parts as made by a script; saving names the script key and version", async () => {
    const output = await runScript(script, { slice: sliceModel(head(), {}), values: {}, scriptHash: "sha256:g15" });
    if (output.kind !== "part_types") throw new Error("part types");
    expect(output.types[0]?.definition.source).toEqual({ kind: "script" });
    const body = scriptItemSchema.parse({ id: "acme.caps", revision: 1, key: "acme.caps", name: "Caps", version: "2.1.0", language: "typescript", kit: ">=0.1.0", manifest: script.manifest, source: "export default 1;\n", license: "LicenseRef-Firm", authors: [PERSON] });
    const [item] = partTypeItemsFromRun(output, { script: { ...body, contentHash: contentHashOf(makeItem("script", body)) }, values: {}, generatedBy: PERSON, generatedAt: "2026-11-04T23:00:00.000Z" });
    expect(item?.definition.source).toEqual({ kind: "script", key: "acme.caps", version: "2.1.0" });
    expect(partTypeDefinitionSchema.safeParse(item?.definition).success).toBe(true);
  });

  it("an older model server that doesn't read solid programs is refused in words, not sent the part", async () => {
    const output = await runScript(script, { slice: sliceModel(head(), {}), values: {}, scriptHash: "sha256:g15" });
    if (output.kind !== "part_types") throw new Error("part types");
    const partType = output.types[0]?.definition;
    if (!partType) throw new Error("no part");
    let m = head();
    const level = executeCommand(m, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
    if (!level.ok) throw new Error(level.error.message);
    m = level.model;
    const old = withUpgradePolicy(() => false, () => executeCommand(m, { type: "place_part", partId: "c1", typeId: "acme.duct_cap", partType, levelId: "l1", position: { x: 0, y: 0 } }));
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.error.message).toMatch(/older version that doesn't store parts made with sweeps, lofts and patterns or by scripts/);
    const current = withUpgradePolicy((f) => f === GEOMETRY_SOLID_PROGRAM_2_FEATURE, () => executeCommand(m, { type: "place_part", partId: "c1", typeId: "acme.duct_cap", partType, levelId: "l1", position: { x: 0, y: 0 } }));
    expect(current.ok).toBe(true);
  });
});

describe("g15-script-reference-has-part-definition", () => {
  it("searching for the part definition finds its shape: fields, connectors, the solid program, source script", () => {
    const hit = searchReference("part definition shape")[0];
    expect(hit).toMatchObject({ kind: "recipe", name: "Part definition" });
    const steps = hit && "steps" in hit ? hit.steps.join("\n") : "";
    expect(steps).toMatch(/typeParams/);
    expect(steps).toMatch(/connectors\[\]/);
    expect(steps).toMatch(/schema: 2/);
    expect(steps).toMatch(/kind: \\?"script\\?"/);
    expect(searchReference("bim_part_definition_example")[0]).toMatchObject({ name: "Part definition" });
  });
});
