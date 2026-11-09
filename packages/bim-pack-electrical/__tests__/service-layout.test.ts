/**
 * @jest-environment node
 *
 * One-line skeleton from a service size: planServiceLayout turns "400 A
 * 120/208 V 3-phase, MDP, L1, L2" into one place_service_layout edit of sized
 * starter parts and the feeders the engineer named; the live one-line then
 * draws it from the model. Also: what a selected part needs before it can be
 * circuited (circuitReadiness).
 */
import { canonicalJson, evaluateDiagram, type PartTypeDefinition, type ViewElement } from "@permitzip/bim-kernel";
import { circuitReadiness, distributionOf, isCircuitableLoad, panelSchedule, planServiceLayout, type ServiceLayoutRequest } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function plan(b: Building, request: Omit<ServiceLayoutRequest, "levelId">) {
  return planServiceLayout(b.head, { levelId: "lvl-1", ...request });
}

function place(b: Building, request: Omit<ServiceLayoutRequest, "levelId">) {
  const p = plan(b, request);
  if (!p.ok) throw new Error(p.reason);
  b.ok(p.command);
  return p;
}

function byName(b: Building, name: string): string {
  for (const el of Object.values(b.head.elements)) {
    if (el.kind !== "part") continue;
    if (distributionOf(b.head.elements, el)?.name === name) return el.id;
  }
  throw new Error(`no equipment named ${name}`);
}

function oneLineTexts(b: Building): { texts: string[]; warnings: string[] } {
  b.ok({ type: "create_view", viewId: "v-ol", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line", hints: {} } } });
  const view = b.head.elements["v-ol"] as ViewElement;
  const ev = evaluateDiagram(b.head.elements, view);
  const texts = (ev?.items ?? []).flatMap((i) => (i.shape === "text" ? (i.note?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")) : []));
  return { texts, warnings: (ev?.warnings ?? []).map((w) => w.kind) };
}

const SMALL: Omit<ServiceLayoutRequest, "levelId"> = {
  serviceA: 400,
  system: "208Y/120",
  equipment: [
    { kind: "panel", name: "L1", fedFrom: "MDP", busA: 225, mains: "MCB" },
    { kind: "panel", name: "L2", fedFrom: "MDP", busA: 100 },
  ],
};

describe("service layout from a service size", () => {
  it("places meter, MDP and panels as one edit, each fed as listed", () => {
    const b = new Building();
    const before = b.log.length;
    const p = place(b, SMALL);
    expect(b.log.length).toBe(before + 1);
    b.valid();
    expect(p.items.map((i) => [i.name, i.fedFrom, i.breakerA])).toEqual([
      ["METER", null, null],
      ["MDP", "METER", null],
      ["L1", "MDP", 225],
      ["L2", "MDP", 100],
    ]);
    const els = b.head.elements;
    const mdp = panelSchedule(els, byName(b, "MDP"));
    expect(mdp?.fedBy?.sourceName).toBe("METER");
    expect(mdp?.busA).toBe(400);
    expect(mdp?.system).toContain("120/208");
    const l1 = panelSchedule(els, byName(b, "L1"));
    expect(l1?.fedBy?.sourceName).toBe("MDP");
    expect(l1?.fedBy?.ratingA).toBe(225);
    expect(panelSchedule(els, byName(b, "L2"))?.busA).toBe(100);
  });

  it("the live one-line draws the layout from the model: utility over the meter, nothing unfed", () => {
    const b = new Building();
    place(b, SMALL);
    const { texts, warnings } = oneLineTexts(b);
    expect(texts.some((t) => /UTILITY/i.test(t))).toBe(true);
    expect(texts).toEqual(expect.arrayContaining(["MDP", "L1", "L2"]));
    expect(texts.some((t) => t.includes("400A BUS"))).toBe(true);
    expect(warnings).not.toContain("not_fed");
  });

  it("a 480 V service needs the transformer's primary breaker, then feeds a 208 V panel from it", () => {
    const b = new Building();
    const request: Omit<ServiceLayoutRequest, "levelId"> = {
      serviceA: 800,
      system: "480Y/277",
      equipment: [
        { kind: "panel", name: "H1", fedFrom: "MDP", busA: 225, system: "480Y/277" },
        { kind: "transformer", name: "T1", fedFrom: "MDP", kva: 75, system: "208Y/120" },
        { kind: "panel", name: "L1", fedFrom: "T1", busA: 225, system: "208Y/120", mains: "MCB" },
      ],
    };
    const refused = plan(b, request);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/T1's primary breaker in MDP/);
    const rows = request.equipment ?? [];
    const p = place(b, { ...request, equipment: rows.map((r) => (r.name === "T1" ? { ...r, breakerA: 125 } : r)) });
    b.valid();
    expect(p.items.find((i) => i.name === "MDP")?.what).toMatch(/switchboard/);
    const els = b.head.elements;
    expect(panelSchedule(els, byName(b, "T1"))?.fedBy?.ratingA).toBe(125);
    expect(panelSchedule(els, byName(b, "L1"))?.fedBy?.sourceName).toBe("T1");
  });

  it("says why in plain words instead of placing something wrong", () => {
    const b = new Building();
    const mismatch = plan(b, { serviceA: 800, system: "480Y/277", equipment: [{ kind: "panel", name: "L1", fedFrom: "MDP", busA: 225, system: "208Y/120" }] });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/Add a transformer and feed L1 from it/);
    const unknown = plan(b, { serviceA: 400, system: "208Y/120", equipment: [{ kind: "panel", name: "L1", fedFrom: "MSB", busA: 225 }] });
    if (unknown.ok) throw new Error("expected a refusal");
    expect(unknown.reason).toMatch(/fed from MSB, which isn't in this layout/);
    const twice = plan(b, { serviceA: 400, system: "208Y/120", equipment: [{ kind: "panel", name: "MDP", fedFrom: "METER", busA: 225 }] });
    if (twice.ok) throw new Error("expected a refusal");
    expect(twice.reason).toMatch(/Two pieces are named MDP/);
    place(b, SMALL);
    const again = plan(b, SMALL);
    if (again.ok) throw new Error("expected a refusal");
    expect(again.reason).toMatch(/already has equipment named METER/);
  });

  it("is deterministic: the same request is the same edit", () => {
    const a = plan(new Building(), SMALL);
    const b = plan(new Building(), SMALL);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(canonicalJson(a.command)).toBe(canonicalJson(b.command));
  });

  it("a main disconnect makes the MDP main lugs only; a 120/240 V service gets a single-phase panelboard", () => {
    const b = new Building();
    const p = place(b, { serviceA: 200, system: "120/240", mainDisconnect: true, equipment: [{ kind: "panel", name: "A", fedFrom: "MDP", busA: 100 }] });
    b.valid();
    expect(p.items.map((i) => i.name)).toEqual(["METER", "MAIN DISC", "MDP", "A"]);
    expect(p.items.find((i) => i.name === "MDP")?.what).toMatch(/MLO panelboard/);
    const els = b.head.elements;
    expect(panelSchedule(els, byName(b, "MDP"))?.fedBy?.sourceName).toBe("MAIN DISC");
    expect(panelSchedule(els, byName(b, "A"))?.system).toContain("120/240");
  });
});

describe("what a selected part needs before it can be circuited", () => {
  const rtu = (withVoltage: boolean): PartTypeDefinition => ({
    familyName: "Rooftop unit",
    typeName: "10 ton",
    category: "mechanical_equipment",
    typeParams: [],
    typeValues: {},
    instanceParams: withVoltage
      ? [
          { name: "voltage", label: "Voltage", kind: "number", unit: "v", min: 0 },
          { name: "mca", label: "MCA", kind: "number", unit: "a", min: 0 },
        ]
      : [],
    connectors: [],
    geometry: [{ kind: "box", center: [0, 0, 500], size: [2000, 1200, 1000] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [2000, 1200] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  });

  it("names the field to fill in, then the part is circuitable", () => {
    const b = new Building();
    b.ok({ type: "place_part", partId: "rtu-bare", typeId: "t-rtu-bare", partType: rtu(false), levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "RTU-1" });
    b.ok({ type: "place_part", partId: "rtu-2", typeId: "t-rtu", partType: rtu(true), levelId: "lvl-1", position: { x: 5000, y: 0 }, mark: "RTU-2" });
    const part = (id: string) => {
      const el = b.head.elements[id];
      if (el?.kind !== "part") throw new Error(id);
      return el;
    };
    expect(circuitReadiness(b.head.elements, part("rtu-bare"))).toMatch(/RTU-1's part type has no electrical fields/);
    expect(circuitReadiness(b.head.elements, part("rtu-2"))).toMatch(/RTU-2 has no electrical nameplate: set its voltage and MCA/);
    b.ok({ type: "set_parameters", id: "rtu-2", scope: "instance", values: { voltage: 460 } });
    expect(circuitReadiness(b.head.elements, part("rtu-2"))).toMatch(/no MCA, MOCP or load/);
    b.ok({ type: "set_parameters", id: "rtu-2", scope: "instance", values: { mca: 28 } });
    expect(circuitReadiness(b.head.elements, part("rtu-2"))).toBeNull();
    expect(isCircuitableLoad(b.head.elements, part("rtu-2"))).toBe(true);
  });
});
