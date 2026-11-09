/**
 * @jest-environment node
 *
 * Round 8 lane D: disciplines as a registry (contract 1.5.0). Each case
 * fails on round 7's code, where disciplines were closed unions with no
 * registry, fire alarm and sprinkler were one `fire_protection`, and a pack
 * or firm had no way to add a discipline.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLASS_DISCIPLINES,
  DISCIPLINE_POINT,
  DISCIPLINES_REGISTRY_FEATURE,
  disciplineAncestors,
  disciplineCovers,
  disciplineDef,
  disciplineLabel,
  disciplineSchema,
  disciplineWords,
  disciplineWriteFeature,
  disciplineWriteProblem,
  inInterest,
  isStoredDiscipline,
  listDisciplines,
  listDisciplinesWithSource,
  storedDiscipline,
  type DisciplineDef,
  type LinkedModelDiscipline,
  type NetworkService,
  type ReferenceDiscipline,
} from "@permitzip/bim-kernel";
import { PackSet, PackSetError, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";

const ELEVATORS: DisciplineDef = { id: "vt.elevators", label: "Elevators", group: { id: "vt", label: "Vertical transportation" }, display: { colour: "#0f766e" }, defaultResponsibleRole: "Elevator consultant" };
const VT = definePack({ id: "vt", name: "Vertical transportation (test)", version: "1.0.0", kernel: "^1.5.0" }, [contribute(DISCIPLINE_POINT, [ELEVATORS])]);
const LOW_VOLTAGE: DisciplineDef = { id: "firm:low_voltage", label: "Low voltage", parent: "electrical", display: { colour: "#7c3aed" } };

describe("d8 disciplines as a registry", () => {
  it("d8-discipline-point: every stored id has a row with a label and display; fire alarm and fire sprinkler sit under fire protection", () => {
    const ids = listDisciplines().map((d) => d.id);
    for (const id of CLASS_DISCIPLINES) expect({ id, registered: ids.includes(id) }).toEqual({ id, registered: true });
    expect(disciplineDef("fire_alarm")).toMatchObject({ label: "Fire alarm", parent: "fire_protection" });
    expect(disciplineDef("fire_sprinkler")).toMatchObject({ label: "Fire sprinkler", parent: "fire_protection" });
    expect(disciplineDef("mechanical")?.group).toEqual({ id: "mep", label: "MEP" });
    for (const d of listDisciplines()) expect(d.display.colour).toMatch(/^#[0-9a-f]{6}$/);
    const sources = new Map(listDisciplinesWithSource().map((l) => [l.row.id, l.source] as const));
    expect(sources.get("architecture")).toEqual({ kind: "builtin" });
    expect(sources.get("electrical")).toMatchObject({ kind: "addon", packId: "electrical", firstParty: true });
    expect(sources.get("fire_alarm")).toMatchObject({ kind: "addon", packId: "fire_protection", firstParty: true });
  });

  it("d8-writer-accepts-registered: a model with the test add-on may store vt.elevators; without it, a plain refusal naming the add-on (the edit gate's words; d8-writer-edit-spine runs it through executeCommand)", () => {
    const set = PackSet.create([VT]);
    withPackSet(set, () => expect(disciplineWriteProblem("vt.elevators")).toBeNull());
    expect(disciplineWriteProblem("vt.elevators")).toBe("Elevators comes from the vt add-on, which this model doesn't use. Turn that add-on on for this model first");
    expect(disciplineWriteProblem("mechanical")).toBeNull();
    expect(disciplineWriteProblem("fire_alarm")).toBeNull();
    expect(disciplineWriteProblem("firm:low_voltage")).toMatch(/^Low voltage isn't a discipline in this model's firm library/);
    // The schema reads before any model's add-ons are in force, so it checks the id's shape only.
    expect(disciplineSchema.safeParse("vt.elevators").success).toBe(true);
    expect(disciplineSchema.safeParse("Fire Alarm").success).toBe(false);
  });

  it("d8-reader-tolerant: an id no row knows reads, is kept, and is labelled from its words, never shown raw", () => {
    expect(isStoredDiscipline("vt.escalators")).toBe(true);
    expect(disciplineLabel("vt.escalators")).toBe("Escalators");
    expect(disciplineLabel("firm:site_work")).toBe("Site work");
    expect(disciplineWords("fire_alarm")).toBe("Fire alarm");
    expect(disciplineWords("structure", { architecture: "A", structure: "Structure", mechanical: "M", plumbing: "P", electrical: "E", fire_protection: "FP" })).toBe("Structure");
  });

  it("d8-fire-children: a stored fire_protection reads unchanged; a Fire protection filter covers both children", () => {
    expect(disciplineAncestors("fire_sprinkler")).toEqual(["fire_protection"]);
    expect(disciplineCovers("fire_protection", "fire_alarm")).toBe(true);
    expect(disciplineCovers("fire_protection", "fire_protection")).toBe(true);
    expect(disciplineCovers("fire_alarm", "fire_sprinkler")).toBe(false);
    const fp = { areas: [{ level: "L1" }], disciplines: ["fire_protection"] };
    expect(inInterest({ level: "L1", zone: "Z1", discipline: "fire_sprinkler" }, fp)).toBe(true);
    expect(inInterest({ level: "L1", zone: "Z1", discipline: "fire_protection" }, fp)).toBe(true);
    expect(inInterest({ level: "L1", zone: "Z1", discipline: "mechanical" }, fp)).toBe(false);
    expect(inInterest({ level: "L1", zone: "Z1", discipline: "fire_protection" }, { areas: [{ level: "L1" }], disciplines: ["fire_alarm"] })).toBe(false);
  });

  it("d8-mixed-version: an id beyond the ten goes only to peers that read the registry; the ten keep their round 5c gates", () => {
    expect(disciplineWriteFeature("mechanical")).toBeNull();
    expect(disciplineWriteFeature("civil")).toBe("partition:class_disciplines");
    expect(disciplineWriteFeature("fire_alarm")).toBe(DISCIPLINES_REGISTRY_FEATURE);
    expect(storedDiscipline("fire_alarm", "fire_protection", true, false)).toBe("fire_protection");
    expect(storedDiscipline("fire_alarm", "fire_protection", true, true)).toBe("fire_alarm");
    expect(storedDiscipline("civil", "mechanical", false, true)).toBe("mechanical");
    expect(storedDiscipline("vt.elevators", "mechanical", true, true)).toBe("mechanical");
    withPackSet(PackSet.create([VT]), () => expect(storedDiscipline("vt.elevators", "mechanical", true, true)).toBe("vt.elevators"));
  });

  it("d8-open-types: network services, linked-model and reference disciplines take registered values", () => {
    const service: NetworkService = "vt.hoistway";
    const reference: ReferenceDiscipline = "civil";
    const linked: LinkedModelDiscipline = "fire_alarm";
    expect([service, reference, linked]).toEqual(["vt.hoistway", "civil", "fire_alarm"]);
  });

  it("firm rows join a model's set as firm:<slug> only, and are writable there", () => {
    const set = PackSet.create([], { firm: [contribute(DISCIPLINE_POINT, [LOW_VOLTAGE])] });
    withPackSet(set, () => {
      expect(disciplineWriteProblem("firm:low_voltage")).toBeNull();
      expect(disciplineAncestors("firm:low_voltage")).toEqual(["electrical"]);
      expect(listDisciplinesWithSource().find((l) => l.row.id === "firm:low_voltage")?.source).toEqual({ kind: "firm" });
    });
    expect(() => PackSet.create([], { firm: [contribute(DISCIPLINE_POINT, [{ ...LOW_VOLTAGE, id: "low_voltage" }])] })).toThrow(PackSetError);
    expect(() => PackSet.create([], { firm: [contribute(DISCIPLINE_POINT, [{ ...LOW_VOLTAGE, id: "low_voltage" }])] })).toThrow(/must be "firm:<name>"/);
    expect(set.revision).toContain("firm:kernel.discipline:firm:low_voltage");
  });

  it("d8-default-role-is-only-default: a row's default role names no one", () => {
    const row = disciplineDef("fire_alarm");
    expect(row?.defaultResponsibleRole).toBe("Fire alarm engineer of record");
    expect(Object.keys(row ?? {})).not.toContain("owner");
  });

  it("d8-ratchet: the kernel's trade-term baseline total is not higher than round 7's (3,916); trade-terms.test.ts holds the source to it", () => {
    const baseline: unknown = JSON.parse(readFileSync(path.join(__dirname, "../src/__tests__/trade-terms.baseline.json"), "utf8"));
    const files = typeof baseline === "object" && baseline !== null && "files" in baseline && typeof baseline.files === "object" && baseline.files !== null ? Object.values(baseline.files) : [];
    let total = 0;
    for (const counts of files) if (typeof counts === "object" && counts !== null) for (const n of Object.values(counts)) if (typeof n === "number") total += n;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(3_916);
  });

  // The 2,000 ns per call budget is Perf Gate (BIM) row kernel.discipline.lookup
  // (scripts/perf/mutinybim/discipline-lookup.ts). Here: the work each call does.
  it("kernel.discipline.lookup stays a map read: 200,000 lookups read the set's rows once", () => {
    const CALLS = 200_000;
    const ids = ["fire_alarm", "mechanical", "vt.unknown", "architecture"];
    const set = PackSet.create([]);
    const reads = jest.spyOn(set, "items");
    let sink = 0;
    for (let i = 0; i < CALLS; i++) {
      const id = ids[i % 4] ?? "";
      sink += disciplineLabel(id, set).length + (disciplineCovers("fire_protection", id, set) ? 1 : 0);
    }
    expect(sink).toBeGreaterThan(0);
    expect(disciplineLabel("vt.unknown", set)).toBe("Unknown");
    expect(disciplineCovers("fire_protection", "fire_alarm", set)).toBe(true);
    expect(reads.mock.calls.filter(([point]) => point === DISCIPLINE_POINT)).toHaveLength(1);
  });
});
