/**
 * @jest-environment node
 *
 * Round 8 lane D: a firm's own discipline in its library. Fails on round 7,
 * where a library had no discipline items and a class's discipline was the
 * closed ten.
 */
import { DISCIPLINE_POINT, disciplineAncestors, disciplineWriteProblem } from "@permitzip/bim-kernel";
import { contribute, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { firmDisciplineRows, loadBundle, type DisciplineItem, type LibraryBundleInput, type LibraryEnvironment } from "../src";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

const env: LibraryEnvironment = { formula: bimFormulaEngine, units: bimUnitsCatalog };

const LOW_VOLTAGE: DisciplineItem = { id: "d8-disc-lv", revision: 1, key: "firm:low_voltage", label: "Low voltage", parent: "electrical", colour: "#7c3aed", defaultResponsibleRole: "Low voltage designer" };
const SECURITY: DisciplineItem = { id: "d8-disc-sec", revision: 1, key: "firm:security", label: "Security", parent: "firm:low_voltage", colour: "#9333ea" };

function bundle(extra: Partial<LibraryBundleInput>): LibraryBundleInput {
  return { format: "mutinybim-library", version: 1, id: "d8-firm", name: "Firm", publisher: "Firm", revision: 1, ...extra };
}

function problems(input: LibraryBundleInput, e: LibraryEnvironment = env): string[] {
  const r = loadBundle(input, e);
  return r.ok ? [] : r.problems.map((p) => p.message);
}

describe("d8-library-discipline-item", () => {
  it("a firm discipline under a built-in, and one under it in the same bundle, load; a class may name either", () => {
    const input = bundle({ disciplines: [LOW_VOLTAGE, SECURITY], classes: [{ id: "d8-cls", revision: 1, key: "firm.card_reader", label: "Card readers", discipline: "firm:security" }] });
    const r = loadBundle(input, env);
    if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("\n"));
    const rows = firmDisciplineRows(r.bundle.disciplines);
    expect(rows.map((d) => d.id)).toEqual(["firm:low_voltage", "firm:security"]);
    // On a model, the rows join the set as firm rows (lane X pins them through setup entries).
    withPackSet(PackSet.create([], { firm: [contribute(DISCIPLINE_POINT, rows)] }), () => {
      expect(disciplineAncestors("firm:security")).toEqual(["firm:low_voltage", "electrical"]);
      expect(disciplineWriteProblem("firm:security")).toBeNull();
    });
  });

  it("a discipline whose parent isn't registered is refused, naming where the parent would come from", () => {
    expect(problems(bundle({ disciplines: [{ ...LOW_VOLTAGE, parent: "firm:systems" }] }))).toEqual([
      'Discipline firm:low_voltage: sits under a parent that isn\'t registered: "Systems" (firm:systems), which isn\'t in this library or the ones below it. Add it under Disciplines first.',
    ]);
    expect(problems(bundle({ disciplines: [{ ...LOW_VOLTAGE, parent: "vt.elevators" }] }))).toEqual([
      'Discipline firm:low_voltage: sits under a parent that isn\'t registered: "Elevators" (vt.elevators), which comes from the vt add-on, and that add-on isn\'t installed here.',
    ]);
  });

  it("a host that installs the vt add-on passes its rows, and the same parent loads", () => {
    const withVt: LibraryEnvironment = { ...env, disciplines: [{ id: "vt.elevators", label: "Elevators", display: { colour: "#0f766e" } }] };
    expect(problems(bundle({ disciplines: [{ ...LOW_VOLTAGE, parent: "vt.elevators" }] }), withVt)).toEqual([]);
  });

  it("a class naming an unknown discipline gets a plain problem; a stored built-in or first-party one loads", () => {
    expect(problems(bundle({ classes: [{ id: "d8-cls", revision: 1, key: "firm.card_reader", label: "Card readers", discipline: "firm:security" }] }))).toEqual([
      'Object class firm.card_reader: names discipline "Security" (firm:security), which isn\'t in this library or the ones below it. Add it under Disciplines first.',
    ]);
    expect(problems(bundle({ classes: [{ id: "d8-cls", revision: 1, key: "firm.horn_strobe", label: "Horn strobes", discipline: "fire_alarm" }] }))).toEqual([]);
    expect(problems(bundle({ scheduleTemplates: [{ id: "d8-tpl", revision: 1, key: "lv", name: "LV devices", discipline: "low_voltage", definition: {} }] }))).toEqual([
      'Schedule template lv: names discipline "Low voltage" (low_voltage), which isn\'t a built-in discipline. Use a firm discipline (firm:low_voltage) and add it under Disciplines.',
    ]);
  });

  it("a discipline that sits under itself through the bundle is refused", () => {
    const a: DisciplineItem = { ...LOW_VOLTAGE, parent: "firm:security" };
    expect(problems(bundle({ disciplines: [a, SECURITY] }))).toEqual([
      "Discipline firm:low_voltage: sits under itself (firm:low_voltage → firm:security → firm:low_voltage). Pick a parent outside that circle.",
      "Discipline firm:security: sits under itself (firm:security → firm:low_voltage → firm:security). Pick a parent outside that circle.",
    ]);
  });
});
