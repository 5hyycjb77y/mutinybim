/**
 * @jest-environment node
 *
 * Round 13 (product decision, Nov 4): the typical label is a template the firm and the
 * project set ("P2-1 (3) TYP." or "(3) TYP."), not a hard-coded choice. The
 * project's choice is a catalog record in the model, so plans read it; the
 * firm's standard is a library tag type that seeds it. Fails on the build
 * before this change: the label was fixed in code and nothing stored a choice.
 */
import { VIEW_TYP_LABELS_FEATURE, commandSchema, withUpgradePolicy, type Command, type ModelState, type PartInstance, type ViewElement } from "@permitzip/bim-kernel";
import { DRAFTING_STANDARD_NAME, TYP_LABEL_PRESETS, deriveCircuitGraphics, firmTypLabelTemplate, typLabelFrom, typLabelTemplateOf, typLabelTemplateProblem } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const SCALE = 48;
const CROP = { min: { x: -22000, y: -12000 }, max: { x: 40000, y: 6000 } };
const reads = (f: string) => f === VIEW_TYP_LABELS_FEATURE;

function units(): Building {
  const b = new Building();
  b.place("p2", "panel208", { panel_name: "P2" }, "P2", { x: -20000, y: 0 });
  b.place("u-r1", "receptacle", { voltage: 120, load_va: 180 }, "", { x: 2000, y: 0 });
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p2", positions: [1], members: [{ elementId: "u-r1" }] });
  b.ok({ type: "create_group", groupId: "grp-unit", name: "Unit 001" });
  b.ok({ type: "assign_elements_to_group", ids: ["u-r1"], groupId: "grp-unit" });
  b.ok({ type: "set_group_typical", groupId: "grp-unit", label: "Unit", mark: "001", array: { count: 3, columns: 3, spacingMm: { x: 10000, y: 0 } } });
  const view: Command = { type: "create_view", viewId: "v1", name: "Units", viewType: "floor_plan", crop: CROP, props: { level: "Level 1", scale: SCALE, discipline: "electrical", circuitGraphics: { style: "arcs", allCopies: true } } };
  withUpgradePolicy(reads, () => b.ok(view));
  return b;
}

function firstLabel(m: ModelState): string {
  const v = m.elements.v1 as ViewElement;
  const shown = new Map<string, PartInstance>();
  for (const el of Object.values(m.elements)) if (el.kind === "part") shown.set(el.id, el);
  return deriveCircuitGraphics(m, v, shown, SCALE).flatMap((g) => (g.homeRun ? [g.homeRun.label] : []))[0] ?? "";
}

describe("e13 typical label template", () => {
  it("fills {circuit} and {count}; the two presets read as the product owner's examples", () => {
    expect(TYP_LABEL_PRESETS.map((p) => typLabelFrom(p.template, "P2-1", 3))).toEqual(["P2-1 (3) TYP.", "(3) TYP."]);
  });

  it("refuses a template without {count} or with an unknown field, in words", () => {
    expect(typLabelTemplateProblem("TYP.")).toMatch(/add \{count\}/);
    expect(typLabelTemplateProblem("{panel} ({count}) TYP.")).toMatch(/\{panel\}, which isn't a field here/);
    expect(typLabelTemplateProblem("({count}) TYP.")).toBeNull();
  });

  it("plans follow the project's record; with none they use the default preset", () => {
    const b = units();
    expect(typLabelTemplateOf(b.head)).toBe("{circuit} ({count}) TYP.");
    expect(firstLabel(b.head)).toBe("P2-1 (3) TYP.");
    b.ok({ type: "save_catalog_entry", entry: { type: "electrical_drafting", name: DRAFTING_STANDARD_NAME, typLabelTemplate: "({count}) TYP.", source: { kind: "preset", presetId: "count_only" } } });
    expect(firstLabel(b.head)).toBe("(3) TYP.");
  });

  it("a project record with a bad template is refused when the command is read (server, agent and screens all parse it)", () => {
    units();
    const parsed = commandSchema.safeParse({ type: "save_catalog_entry", entry: { type: "electrical_drafting", name: DRAFTING_STANDARD_NAME, typLabelTemplate: "TYP.", source: { kind: "project" } } });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ")).toMatch(/\{count\}/);
  });

  it("the firm's standard is a tag type keyed electrical.typ_label", () => {
    expect(firmTypLabelTemplate({ key: "electrical.typ_label", definition: { template: "{circuit} TYP. ({count})" } })).toBe("{circuit} TYP. ({count})");
    expect(firmTypLabelTemplate({ key: "other", definition: { template: "({count}) TYP." } })).toBeNull();
    expect(firmTypLabelTemplate({ key: "electrical.typ_label", definition: { template: "TYP." } })).toBeNull();
  });
});
