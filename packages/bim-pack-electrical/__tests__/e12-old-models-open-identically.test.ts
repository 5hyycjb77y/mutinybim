/**
 * @jest-environment node
 *
 * Round 12 lane E, the move: Electrical's catalog record types, its one-line
 * layout and its circuit lines leave the kernel for the add-on, and old
 * models open identically. `fixtures/e12-round11-goldens.json` holds sha256
 * digests round 11's tree (6eccc2969, all three in the kernel) computed for
 * the same inputs; this test reads only names that exist both before and
 * after the move, so the same file ran on both trees.
 *
 * Covered: the stored bytes `save_catalog_entry` leaves for every record type
 * and the ids it derives (`etype:feeder:F225`); the catalog reads in order;
 * the one-line layout of a spec using every equipment kind, both orientations;
 * the evaluated one-line of the reference building; plan primitives (circuit
 * lines in every style, typicals, home runs) on the reference building, the
 * demo, full-BIM XS and a circuited 7903-shaped synthetic model; and the load
 * sections each record reads in.
 *
 * On round 11's code with the move half done (a feeder id prefix taken from a
 * row that says `feeders`, a one-line item reordered, a circuit line drawn
 * before the parts) a digest differs and the test fails.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildViewScene,
  canonicalJson,
  catalogElementId,
  catalogRecords,
  connectionTypeSections,
  connectionTypeTrades,
  evaluateDiagram,
  layoutOneLine,
  loadSections,
  loadTradesOf,
  totalsOf,
  type Command,
  type ModelState,
  type OneLineSpec,
} from "@permitzip/bim-kernel";
import { syntheticDistribution } from "@permitzip/bim-pack-electrical";
// Round 12 M12 moves the seeders out of the kernel; the models they build are unchanged.
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { Building, referenceBuilding } from "../../bim-kernel/__tests__/fixtures/electrical-building";

interface Golden {
  readonly sha256: string;
  readonly length: number;
}

const FILE = path.join(__dirname, "fixtures/e12-round11-goldens.json");
const WRITE = process.env.E12_WRITE_GOLDENS === "1";
const written: Record<string, Golden> = {};
const GOLDENS: Readonly<Record<string, Golden>> = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as { goldens: Record<string, Golden> }).goldens : {};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function expectGolden(key: string, text: string): void {
  if (WRITE) {
    written[key] = { sha256: sha(text), length: text.length };
    return;
  }
  const golden = GOLDENS[key];
  expect(golden).toBeDefined();
  expect({ key, length: text.length, sha256: sha(text) }).toEqual({ key, length: golden?.length, sha256: golden?.sha256 });
}

afterAll(() => {
  if (WRITE) writeFileSync(FILE, `${JSON.stringify({ comment: "e12: round 11 output (6eccc2969) the move must reproduce byte for byte. Regenerate only on round 11's tree: E12_WRITE_GOLDENS=1.", goldens: written }, null, 2)}\n`);
});

/** Every record type round 11 stores, one or two of each, saved through the ordinary command. */
const CATALOG_COMMANDS: readonly Command[] = [
  { type: "save_catalog_entry", entry: { type: "feeder_type", mark: "F225", ratingA: 225, poles: 3, conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" }, insulation: "THHN", conduit: { type: "emt", tradeSize: "2-1/2" }, conduitBelowGrade: { type: "pvc40", tradeSize: "3" }, description: "" } },
  { type: "save_catalog_entry", entry: { type: "feeder_type", mark: "f1000 ", ratingA: 1000, poles: 3, conductors: { sets: 3, phaseSize: "400", neutralSize: "400", groundSize: "2/0", material: "al" }, insulation: "XHHW-2", conduit: null, conduitBelowGrade: null, description: "Service", basis: { source: "engineer", text: "By hand", cite: ["220.40"] } } },
  { type: "save_catalog_entry", entry: { type: "circuit_template", name: "Two bedroom", description: "Unit A", rules: [{ room: "bedroom", devices: "receptacles", circuit: 1 }, { room: "living", devices: "all", description: "Living", breakerA: 20 }] } },
  // A caller may send only the fields it sets; the record type's schema fills the rest (the stored command keeps what was sent).
  { type: "save_catalog_entry", entry: { type: "connection_type", designator: "E.05", description: "Reach-in freezer", loadVa: 1320, loadClass: "kitchen" } } as Command,
  { type: "save_connection_type", entry: { designator: "K07", trade: "gas", description: "Fryer", quantities: { mbh: 80, va: 1800, dfu: 1 } } },
  { type: "save_catalog_entry", entry: { type: "load_policy", name: "Project", policy: "actual_only" } },
  { type: "save_catalog_entry", entry: { type: "feeder_type", mark: "F100", ratingA: 100, poles: 3, conductors: { sets: 1, phaseSize: "3", groundSize: "8", material: "cu" }, insulation: "THHN", conduit: { type: "emt", tradeSize: "1-1/4" }, conduitBelowGrade: null, description: "" } },
  { type: "save_catalog_entry", entry: { type: "feeder_type", mark: "F100A", ratingA: 100, poles: 3, conductors: { sets: 1, phaseSize: "3", groundSize: "8", material: "cu" }, insulation: "THHN", conduit: null, conduitBelowGrade: null, description: "" }, replaces: "F100" },
];

const RECORD_TYPES = ["connection_type", "feeder_type", "circuit_template", "load_policy"] as const;

function catalogBuilding(): Building {
  const b = new Building();
  for (const c of CATALOG_COMMANDS) b.ok(c);
  return b;
}

/** Every equipment kind, every device, accessories, a placeholder, an emergency source, title and notes. */
const SPEC: OneLineSpec = {
  title: "Power one-line",
  notes: ["Fault current by others", "Verify utility transformer"],
  roots: [
    {
      id: "u",
      kind: "utility",
      name: "Utility",
      ratings: ["1000 kVA 480Y/277"],
      feeder: { sets: 3, conductors: "4#500 kcmil Cu", conduit: '3" C.', length_ft: 40 },
      children: [
        {
          id: "m",
          kind: "meter",
          name: "Meter",
          children: [
            {
              id: "ct",
              kind: "ct_cabinet",
              name: "CT cabinet",
              children: [
                {
                  id: "msb",
                  kind: "switchboard",
                  name: "MSB",
                  ratings: ["1200 A 480Y/277", "! 65 kAIC needed"],
                  main: { device: "drawout_breaker", label: "1200AF/1200AT" },
                  spd: true,
                  ground: true,
                  children: [
                    { id: "h1", kind: "panelboard", name: "H1", feeder: { device: "breaker", device_label: "225AF/225AT 3P", conductors: "4#4/0 Cu, 1#4 G", conduit: '2-1/2" C.', type_mark: "F225" }, children: [{ id: "rtu", kind: "equipment", name: "RTU-1", feeder: { device: "fused_switch" } }] },
                    { id: "t1", kind: "transformer", name: "T1", ratings: ["75 kVA"], feeder: { device: "fuse", type_mark: "F100T" }, children: [{ id: "l1", kind: "panelboard", name: "L1", main: { device: "breaker" }, children: [{ id: "sp", kind: "panelboard", name: "Future", placeholder: true }] }] },
                    { id: "mcc", kind: "mcc", name: "MCC-1", feeder: { device: "switch" }, children: [{ id: "vfd", kind: "vfd", name: "VFD-1", children: [{ id: "mtr", kind: "motor", name: "P-1" }] }, { id: "d1", kind: "disconnect", name: "DS-1", children: [{ id: "m2", kind: "motor", name: "P-2" }] }] },
                    { id: "ats", kind: "ats", name: "ATS", feeder: { device: "breaker" }, emergency: { id: "gen", kind: "generator", name: "GEN", feeder: { device: "breaker", conductors: "4#3/0" } }, children: [{ id: "ups", kind: "ups", name: "UPS", children: [{ id: "fd", kind: "fused_disconnect", name: "FD-1" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function planView(b: Building, id: string, circuitGraphics: Record<string, unknown> | undefined): void {
  b.ok({ type: "create_view", viewId: id, name: `Level 1 Power ${id}`, viewType: "floor_plan", crop: { min: { x: -30000, y: -20000 }, max: { x: 60000, y: 20000 } }, props: { level: "Level 1", scale: 48, discipline: "electrical", ...(circuitGraphics ? { circuitGraphics } : {}) } } as Command);
}

/** The scene a view prints, as stable text. */
function scene(model: ModelState, viewId: string): string {
  return canonicalJson(buildViewScene(model, viewId).scene.primitives);
}

function viewIds(model: ModelState): string[] {
  return Object.values(model.elements)
    .filter((el) => el.kind === "view")
    .map((el) => el.id)
    .sort();
}

describe("e12: old models open identically after Electrical leaves the kernel", () => {
  it("catalog: stored bytes, derived ids and reads for every record type", () => {
    const b = catalogBuilding();
    expectGolden("catalog.elements", canonicalJson(Object.fromEntries(Object.entries(b.head.elements).filter(([, el]) => el.kind === "service_catalog"))));
    // What each save sends and writes: the stored command, the records, the authored fingerprints and what it removed.
    expectGolden("catalog.log", canonicalJson(b.log.map((c) => ({ command: c.command, elements: c.elements, authored: c.authored, intents: c.intents, removed: c.removedIds ?? [] }))));
    expectGolden("catalog.ids", JSON.stringify([catalogElementId("feeder_type", "f225 "), catalogElementId("circuit_template", "two  bedroom"), catalogElementId("connection_type", "e.05"), catalogElementId("load_policy", "project")]));
    expectGolden("catalog.reads", canonicalJson(RECORD_TYPES.map((t) => catalogRecords(b.head, t))));
  });

  it("one-line: the layout of every equipment kind, both orientations", () => {
    expectGolden("one_line.vertical", canonicalJson(layoutOneLine(SPEC)));
    expectGolden("one_line.horizontal", canonicalJson(layoutOneLine(SPEC, { orientation: "horizontal" })));
  });

  it("one-line: the reference building's evaluated diagram and its printed primitives", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_view", viewId: "v-one-line", name: "One-line diagram", viewType: "detail", props: { diagram: { kind: "one_line" } } });
    b.ok({ type: "create_view", viewId: "v-one-line-h", name: "One-line across", viewType: "detail", props: { diagram: { kind: "one_line", hints: { orientation: "horizontal", title: "Across" } } } });
    for (const id of ["v-one-line", "v-one-line-h"]) {
      const v = b.head.elements[id];
      if (v?.kind !== "view") throw new Error(`no view ${id}`);
      expectGolden(`one_line.reference.${id}.evaluated`, canonicalJson(evaluateDiagram(b.head.elements, v)));
      expectGolden(`one_line.reference.${id}.scene`, scene(b.head, id));
    }
  });

  it("circuit lines: the reference building in every style", () => {
    const b = referenceBuilding();
    planView(b, "v-default", undefined);
    planView(b, "v-arcs", { style: "arcs" });
    planView(b, "v-orth", { style: "orthogonal", homeRuns: false });
    planView(b, "v-numbers", { style: "numbers" });
    planView(b, "v-off", { style: "off" });
    for (const id of ["v-default", "v-arcs", "v-orth", "v-numbers", "v-off"]) expectGolden(`circuits.reference.${id}`, scene(b.head, id));
  });

  it("plans: every view of the demo and full-BIM XS", () => {
    const demo = createDemoModel();
    for (const id of viewIds(demo)) expectGolden(`plans.demo.${id}`, scene(demo, id));
    const xs = createFullBimModel({ floors: 1, zonesPerFloor: 1, modelId: "xs" });
    const ids = viewIds(xs);
    expectGolden("plans.fullbim_xs.views", JSON.stringify(ids));
    for (const id of ids) expectGolden(`plans.fullbim_xs.${id}`, scene(xs, id));
  });

  it("plans: a circuited 7903-shaped synthetic distribution", () => {
    const d = syntheticDistribution({ floors: 1, zonesPerFloor: 1, prefix: "s" });
    const model: ModelState = { modelId: "s", revision: 0 as ModelState["revision"], elements: d.elements, connections: [], settings: new Building().head.settings };
    const b = new Building();
    b.head = model;
    b.ok({ type: "create_view", viewId: "v-s", name: "Synthetic power", viewType: "floor_plan", crop: { min: { x: -200000, y: -200000 }, max: { x: 200000, y: 200000 } }, props: { level: "Electrical", scale: 96, discipline: "electrical", circuitGraphics: { style: "orthogonal" } } } as Command);
    expectGolden("plans.synthetic.v-s", scene(b.head, "v-s"));
  });

  it("load sections: each record reads in the same sections and trades", () => {
    const b = catalogBuilding();
    const types = catalogRecords(b.head, "connection_type").map((r) => r.entry);
    expectGolden("sections.connection_types", canonicalJson(types.map((e) => ({ sections: connectionTypeSections(e), trades: connectionTypeTrades(e) }))));
    const samples = [{}, { va: 1800 }, { mbh: 80, min_inlet_pressure: 0.25 }, { min_inlet_pressure: 25 }, { wsfu_cold: 1.5, wsfu_hot: 1.5, wsfu_total: 2, gpm_fixed: 1 }, { dfu: 2 }, { cfm: 3000 }];
    expectGolden("sections.loads", canonicalJson(samples.map((s) => ({ sections: loadSections(totalsOf(s)), trades: loadTradesOf(undefined, totalsOf(s)), gas: loadTradesOf("gas", totalsOf(s), "electrical") }))));
  });
});
