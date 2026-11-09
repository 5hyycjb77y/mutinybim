/**
 * Round 7 lane G fixtures: a small synthetic floor and a synthetic code study.
 * Every rule here is invented for the test and written in our own words; the
 * citations name a made-up "Test Building Code". No client data, no project
 * names, no code text.
 *
 *   y 6000 ┌────────┬────────┬────────┬────────┐
 *          │ Office │ Office │ Office │ Room   │
 *          │  101   │  102   │  103   │  104   │
 *   y 2000 ├─W-20───┴─W-14───┴─W-21───┴─W-22───┤
 *          │ Corridor 100                      │
 *   y    0 └───────────────────────────────────┘
 *          x 0     4000     8000    12000    16000
 *   W-12 at x 4000 (101|102), W-13 at x 8000 (102|103), W-14 the corridor wall of 102.
 */
import { bindRequirementsSnapshot, CLASS_POINT, DEFAULT_SETTINGS, executeCommand, withUpgradePolicy, type BimElement, type Command, type ModelState, type RequirementsSnapshot, type RuleRecord } from "../src";
import { contribute, definePack } from "../src/packs";

export const FT = 304.8;
const base = { version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" as const } };
const spaceBase = { version: 1, authoredRev: {} };

function rect(x0: number, y0: number, x1: number, y1: number) {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

function space(id: string, name: string, number: string, outline: ReturnType<typeof rect>, useId: string, occupants: number): BimElement {
  return { ...spaceBase, id, kind: "space", name, number, levelId: "L1", bounds: { kind: "outline", outline }, origin: { kind: "drawn" }, use: { libraryId: "test", useId }, occupants } as unknown as BimElement;
}

function wall(id: string, x0: number, y0: number, x1: number, y1: number): BimElement {
  return { ...base, id, kind: "wall", start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement;
}

function determination(id: string, subjectId: string | null, key: string, value: string | number | boolean, unit?: string): BimElement {
  return {
    id,
    kind: "determination",
    version: 1,
    authoredRev: {},
    determination: {
      subject: subjectId ? { kind: "space", id: subjectId } : { kind: "model" },
      key,
      value,
      ...(unit ? { unit } : {}),
      inputs: subjectId ? [{ key: "space.use", elementId: subjectId }] : [],
      reasoning: "Synthetic test decision.",
      decidedBy: "K. Example",
      decidedAt: "2026-10-30T15:00:00.000Z",
      confidence: "high",
      status: "recorded",
    },
  } as unknown as BimElement;
}

function head(id: string, x: number, y: number): BimElement {
  return { version: 1, authoredRev: {}, id, kind: "part", typeId: "pt-head", levelId: "L1", position: { x, y }, offsetMm: 2700, rotationDeg: 0, mark: id, values: {}, classId: "zt.head" } as unknown as BimElement;
}

export function ceilingIn(id: string, spaceId: string, x0: number, x1: number, heightMm: number): BimElement {
  return { ...base, id, kind: "ceiling", levelId: "L1", spaceId, outline: rect(x0, 2000, x1, 6000), form: "flat", heightMm } as unknown as BimElement;
}

/** The synthetic floor with its determinations, two heads and Room 104's ceiling. */
export function floor(modelId = "g7-floor"): ModelState {
  const els: BimElement[] = [
    { id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement,
    space("S100", "Corridor", "100", rect(0, 0, 16000, 2000), "corridor", 10),
    space("S101", "Office", "101", rect(0, 2000, 4000, 6000), "office", 4),
    space("S102", "Office", "102", rect(4000, 2000, 8000, 6000), "office", 4),
    space("S103", "Office", "103", rect(8000, 2000, 12000, 6000), "office", 4),
    space("S104", "Room", "104", rect(12000, 2000, 16000, 6000), "storage", 2),
    wall("W-12", 4000, 2000, 4000, 6000),
    wall("W-13", 8000, 2000, 8000, 6000),
    wall("W-14", 4000, 2000, 8000, 2000),
    wall("W-20", 0, 2000, 4000, 2000),
    wall("W-21", 8000, 2000, 12000, 2000),
    wall("W-22", 12000, 2000, 16000, 2000),
    wall("W-30", 12000, 2000, 12000, 6000),
    ...["S101", "S102", "S103"].map((s) => determination(`D-occ-${s}`, s, "occupancy", "B")),
    determination("D-occ-S104", "S104", "occupancy", "S-1"),
    ...["S101", "S102", "S103"].map((s) => determination(`D-haz-${s}`, s, "hazard", "light")),
    determination("D-haz-S104", "S104", "hazard", "ordinary_1"),
    head("SP-14", 13000, 3000),
    head("SP-15", 15000, 5000),
    ceilingIn("CLG-104", "S104", 12000, 16000, 10 * FT),
  ];
  return { modelId, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

const citation = (section: string) => ({ instrument: "Test Building Code", edition: "2024", section });

function rule(r: Omit<RuleRecord, "provider" | "verification" | "citation"> & { readonly section: string }, provider = "zt.code_study"): RuleRecord {
  const { section, ...rest } = r;
  return { ...rest, provider, citation: citation(section), verification: { status: "verified", by: "Test author" } };
}

/** The synthetic code study: six space rules, a ceiling-sensitive head count, a model-wide area limit and the design choice that relaxes it. */
export const STUDY_RULES: readonly RuleRecord[] = [
  rule({ ruleId: "occ-load", section: "T-1.1", title: "Occupant load", summary: "Count people from floor area at the test factor.", discipline: "architecture", applies: { spaceUses: ["office", "storage"] }, reads: ["space.area"], parameters: { area_per_person: { value: 100, unit: "ft2/occ" } }, produces: [{ key: "arch.occupant_load", anchor: "space", value: "ceil({space.area} / {param.area_per_person}, 1 occ)", unit: "occ", compare: "at_least" }] }),
  rule({ ruleId: "exits", section: "T-2.1", title: "Exit count", summary: "Rooms with more than 49 people need two ways out.", discipline: "architecture", applies: { spaceUses: ["office", "storage"] }, reads: ["space.occupants"], produces: [{ key: "arch.exit_count", anchor: "space", value: "if({space.occupants} > 49 occ, 2 ea, 1 ea)", unit: "ea", compare: "at_least" }] }),
  rule({ ruleId: "outside-air", section: "T-3.1", title: "Outside air", summary: "Supply outside air by floor area at the test rate.", discipline: "air", applies: { spaceUses: ["office", "storage"] }, reads: ["space.area"], parameters: { per_area: { value: 0.06, unit: "cfm/ft2" } }, produces: [{ key: "air.outside_air", anchor: "space", value: "{space.area} * {param.per_area}", unit: "cfm", compare: "at_least" }] }),
  rule({ ruleId: "hazard", section: "T-4.1", title: "Hazard class", summary: "Carry the room's hazard determination into the head layout.", discipline: "fire_protection", applies: { spaceUses: ["office", "storage"] }, reads: ["determination.hazard"], produces: [{ key: "fp.hazard_class", anchor: "space", value: "{determination.hazard}", unit: "1", compare: "equal" }] }),
  rule({ ruleId: "corridor-rating", section: "T-5.1", title: "Corridor separation", summary: "Walls between offices and the corridor carry a one-hour rating.", discipline: "architecture", applies: { spaceUses: ["office"], occupancy: ["B"] }, reads: ["determination.occupancy"], parameters: { rating: { value: 1, unit: "h" } }, produces: [{ key: "arch.corridor_rating", anchor: "space", value: "{param.rating}", unit: "h", compare: "at_least" }] }),
  rule({ ruleId: "corridor-width", section: "T-5.2", title: "Corridor width", summary: "Corridors stay at least the test width clear.", discipline: "architecture", applies: { spaceUses: ["corridor"] }, reads: [], parameters: { width: { value: 44, unit: "in" } }, produces: [{ key: "arch.corridor_width", anchor: "space", value: "{param.width}", unit: "in", compare: "at_least" }] }),
  rule({ ruleId: "finish-class", section: "T-6.1", title: "Interior finish class", summary: "Storage rooms take the stricter finish class.", discipline: "architecture", applies: { spaceUses: ["storage"] }, reads: [], produces: [{ key: "arch.finish_class", anchor: "space", value: "\"A\"", unit: "1", compare: "equal" }] }),
  rule({
    ruleId: "head-count",
    section: "T-7.1",
    title: "Head spacing",
    summary: "Each head covers the test area for the room's hazard; low ceilings cover less.",
    discipline: "fire_protection",
    applies: { spaceUses: ["storage"] },
    reads: ["space.area", "determination.hazard", "ceiling.height_at", "class.zt.head"],
    tables: [{ id: "coverage", columns: ["hazard", "max_area ft2"], rows: [["light", 225], ["ordinary_1", 100]] }],
    produces: [{ key: "fp.head_count", anchor: "space", value: "ceil({space.area} / (lookup(coverage, {determination.hazard}) * if({ceiling.height_at} < 2700 mm, 0.8, 1)))", unit: "ea", compare: "at_least", delivered: "class.zt.head" }],
  }),
  rule({ ruleId: "allowable-area", section: "T-8.1", title: "Allowable floor area", summary: "The building's floor area limit for its construction.", discipline: "architecture", applies: {}, reads: [], parameters: { base_area: { value: 12000, unit: "ft2" } }, produces: [{ key: "arch.allowable_area", anchor: "model", value: "{param.base_area}", unit: "ft2", compare: "at_most" }] }),
  rule({ ruleId: "sprinklered-increase", section: "T-8.2", title: "Sprinklered area increase", summary: "A fully sprinklered building may be three times larger.", discipline: "architecture", applies: { when: "{model.sprinklered}" }, reads: ["model.sprinklered"], produces: [], relaxes: [{ target: "arch.allowable_area", effect: "relaxes", value: "{value} * 3", cause: "fully sprinklered: allowable floor area tripled" }] }),
];

export const STUDY: RequirementsSnapshot = {
  source: { id: "zt.code_study", label: "Test code study", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "firm" },
  revision: "r1",
  rules: STUDY_RULES,
};

/** The test add-on that names the head class the head-count rule reads. */
export const ZT_PACK = definePack({ id: "zt", name: "Graph test classes", version: "1.0.0", kernel: "^1.4.0" }, [contribute(CLASS_POINT, [{ id: "zt.head", label: "Test heads", discipline: "general" }])]);

export function bindStudy(modelId: string): void {
  bindRequirementsSnapshot(modelId, STUDY);
}

/** Every graph feature advertised (a peer of this release). */
export const writes = <T>(fn: () => T): T => withUpgradePolicy(() => true, fn);

export function run(m: ModelState, c: Command): ModelState {
  const r = writes(() => executeCommand(m, c));
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return r.model;
}
