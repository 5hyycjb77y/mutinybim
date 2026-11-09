import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildViewScene, diagramBoxesFor, diagramElementAt, diagramNodes, evaluateDiagram, resolveField, sceneToSvg, type DiagramEvaluation, type ViewElement } from "@permitzip/bim-kernel";
import { plumbingDiagramGraph } from "../src";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";
import { STACK_RISER_TOTALS, stackRisers } from "../../bim-kernel/__tests__/fixtures/stack-risers";
import { attach, partType, riserViewCommands, SAN, SAN_LEGS, sampleMarketMarks, sampleMarketRisers } from "../../bim-kernel/__tests__/fixtures/sample-market-risers";

const GOLDEN = path.join(__dirname, "golden");
const FT = 304.8;
const IN = 25.4;

/** Compare against a checked-in golden file; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

function view(b: Building, id: string): ViewElement {
  const v = b.head.elements[id];
  if (v?.kind !== "view") throw new Error(`missing view ${id}`);
  return v;
}

function texts(ev: DiagramEvaluation | null): string[] {
  return (ev?.items ?? []).flatMap((i) => (i.shape === "text" ? (i.note?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")) : []));
}

/** Where a text is drawn (its note's insertion point), for order checks. */
function textAt(ev: DiagramEvaluation | null, text: string): { x: number; y: number } {
  const item = ev?.items.find((i) => i.shape === "text" && (i.note?.paragraphs ?? []).some((p) => p.runs.map((r) => r.text).join("") === text));
  const p = item?.points[0];
  if (!p) throw new Error(`no text ${text}`);
  return p;
}

function sampleMarketModel(): Building {
  const { building } = sampleMarketRisers();
  for (const c of riserViewCommands()) building.ok(c);
  return building;
}

const svgOf = (b: Building, viewId: string) => sceneToSvg(buildViewScene(b.head, viewId).scene);
const count = (words: readonly string[], w: string) => words.filter((x) => x === w).length;

describe("Sample Market (7492) risers from the model", () => {
  it("P2 sanitary riser: the main falls right to the sewer at 20 → 26 → 59 → 88 DFU, every fixture on its branch, the vent dashed through the roof", () => {
    const b = sampleMarketModel();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-san"));
    const words = texts(ev);
    for (const leg of SAN_LEGS) for (const mark of leg) expect(words).toContain(mark);
    expect(words).toEqual(expect.arrayContaining(["20 DFU", "26 DFU", "59 DFU", "88 DFU", "TO SEWER", '4"', '2"', '1/8"/FT', "THRU ROOF", "VENT"]));
    expect(count(words, "CO")).toBe(2);
    // The running loads read left to right towards the outfall, as on the sheet.
    const xs = ["20 DFU", "26 DFU", "59 DFU", "88 DFU"].map((t) => textAt(ev, t).x);
    expect([...xs].sort((a, c) => a - c)).toEqual(xs);
    expect(textAt(ev, "TO SEWER").x).toBeGreaterThan(xs[3] as number);
    // Each fixture prints its own DFU (FS3-1 is 5, though the pipe it sits on carries the 20 of its leg).
    expect(words[words.indexOf("FS3-1") + 1]).toBe("5 DFU");
    // Vent dashed in print; the sanitary pipe solid (the vent is the only dashed linework, and there's more sanitary than vent).
    const lines = (ev?.items ?? []).filter((i) => i.shape === "line");
    const dashed = lines.filter((i) => i.lineStyle?.pattern === "dashed").length;
    expect(dashed).toBeGreaterThan(2);
    expect(lines.length - dashed).toBeGreaterThan(dashed * 5);
    golden("riser-sample-market-sanitary.svg", svgOf(b, "v-san"));
  });

  it("P3 domestic cold water riser: meter, shut-off, 2\" main at 37 WFU, a drop per cold fixture, the water heater, capped", () => {
    const b = sampleMarketModel();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-dcw"));
    const words = texts(ev);
    expect(words).toEqual(expect.arrayContaining(["WM-1", "DOMESTIC COLD WATER", '2"', "37 WFU", "SOV", "GWH", "CAP", '½"', '1½"']));
    const cold = sampleMarketMarks().filter(({ row }) => row.cold > 0 || (row.total > 0 && row.hot === 0) || (row.cold === 0 && row.hot === 0 && row.total === 0 && row.dfu === 0));
    for (const { mark } of cold) expect(words).toContain(mark);
    expect(words).not.toContain("15.75 WFU");
    golden("riser-sample-market-dcw.svg", svgOf(b, "v-dcw"));
  });

  it("P3 domestic water riser: hot water leaves the water heater on the cold line, 15.75 WFU, to every hot fixture", () => {
    const b = sampleMarketModel();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-dhw"));
    const words = texts(ev);
    expect(words).toEqual(expect.arrayContaining(["37 WFU", "15.75 WFU", "GWH"]));
    // K01-1 is on both: its cold drop and its hot drop.
    expect(count(words, "K01-1")).toBe(2);
    // One riser, one source: the hot system continues from the heater instead of drawing a second tree.
    const graph = plumbingDiagramGraph(b.head.elements, { systemKinds: ["domestic_cold_water", "domestic_hot_water"] });
    expect(graph.roots.map((r) => r.name)).toEqual(["WM-1"]);
    const heater = diagramNodes(graph).find((n) => n.elementId === "gwh");
    expect(heater?.children.length).toBeGreaterThan(0);
    expect(heater?.children.every((c) => c.service === "domestic_hot_water")).toBe(true);
    golden("riser-sample-market-dhw.svg", svgOf(b, "v-dhw"));
  });

  it("GR gas riser: the main from the entry with each appliance's drop and shut-off, size and length on every piece", () => {
    const b = sampleMarketModel();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-gas"));
    const words = texts(ev);
    expect(words).toEqual(expect.arrayContaining(["GAS ENTRY", "K07", "K08", "K09-1", "K09-2", "GWH", "DOAS-1", "90 MBH", "220 MBH", "120 MBH", '1"', '¾"', '½"', "CAP"]));
    expect(count(words, "SOV")).toBe(6);
    // The source says the system's gas (propane on the 7492 sheet), its pressure and the total.
    expect(words).toEqual(expect.arrayContaining([expect.stringMatching(/^PROPANE, 7 IN\. W\.C\., 1,024\.41 MBH TOTAL$/)]));
    expect(words.join(" ")).not.toMatch(/NATURAL GAS/);
    expect(words.filter((w) => /^\d+ LF$/.test(w)).length).toBeGreaterThanOrEqual(10);
    // The appliances in the order the main reaches them from the entry.
    const order = ["GWH", "DOAS-1", "K07", "K08", "K09-2", "K09-1"].map((t) => textAt(ev, t).x);
    expect([...order].sort((a, c) => a - c)).toEqual(order);
    golden("riser-sample-market-gas.svg", svgOf(b, "v-gas"));
  });
});

describe("two-way selection between the riser and the model", () => {
  it("every drawn piece of pipe is a target that stands for the model pipe, and a model selection lights the pieces it is part of", () => {
    const b = sampleMarketModel();
    const ev = evaluateDiagram(b.head.elements, view(b, "v-san"));
    if (!ev) throw new Error("no riser");
    // Leg 3 of the main (san-s3) is drawn as several pieces between its branches; selecting it lights all of them.
    const lit = diagramBoxesFor(ev, ["san-s3"]);
    expect(lit.length).toBeGreaterThan(3);
    expect(lit.every((x) => x.pipe?.elementIds.some((id) => id === "san-s3"))).toBe(true);
    // Clicking the middle of one of them picks that pipe.
    const piece = lit[1];
    if (!piece) throw new Error("no piece");
    const mid = { x: (piece.min.x + piece.max.x) / 2, y: (piece.min.y + piece.max.y) / 2 };
    expect(diagramElementAt(ev, mid)).toBe(piece.elementId);
    // A fixture's own branch pipe and the fixture are separate targets.
    expect(diagramBoxesFor(ev, ["san-P01-1-s1"]).length).toBeGreaterThan(0);
    expect(ev.boxes.some((x) => x.elementId === "san-p01-1" && !x.pipe)).toBe(true);
    // Gas: the drop to K08 lights from its pipe and from its shut-off.
    const gas = evaluateDiagram(b.head.elements, view(b, "v-gas"));
    if (!gas) throw new Error("no gas riser");
    expect(diagramBoxesFor(gas, ["gas-k08-s1"]).length).toBeGreaterThan(0);
    expect(gas.boxes.some((x) => x.elementId === "gas-k08-cock")).toBe(true);
  });
});

describe("live and deterministic", () => {
  it("the same model draws the same bytes, however its elements were stored", () => {
    const a = sampleMarketModel();
    const b = sampleMarketModel();
    const reversed = Object.fromEntries(Object.entries(b.head.elements).reverse());
    for (const id of ["v-san", "v-dcw", "v-dhw", "v-gas"]) {
      const one = evaluateDiagram(a.head.elements, view(a, id));
      const two = evaluateDiagram(reversed, view(b, id));
      expect(JSON.stringify(two?.items)).toBe(JSON.stringify(one?.items));
      expect(JSON.stringify(two?.boxes)).toBe(JSON.stringify(one?.boxes));
    }
  });

  it("a fixture added to leg 2 shows on the riser in the same revision: 26 → 31, 59 → 64, 88 → 93 DFU", () => {
    const b = sampleMarketModel();
    b.ok({ type: "route_run", idPrefix: "san-FD5", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 2 * IN, material: "pvc" }, system: SAN, points: [{ x: 26 * FT, y: -9 * FT }, { x: 20 * FT, y: -9 * FT }], to: { kind: "run_branch", segmentId: "san-s2" } });
    attach(b, "san-FD5-s1", "start", "san-fd5-1", "t-fd5", partType("Floor drain", "plumbing_fixture", [{ id: "c", kind: "sanitary", flow: 5 }]), "FD5-1");
    const words = texts(evaluateDiagram(b.head.elements, view(b, "v-san")));
    expect(words).toEqual(expect.arrayContaining(["FD5-1", "20 DFU", "31 DFU", "64 DFU", "93 DFU"]));
    expect(words).not.toContain("88 DFU");
  });

  it("hidden fixtures and systems drop out; the drawing is never stored on the view", () => {
    const b = sampleMarketModel();
    b.ok({ type: "set_view_properties", viewId: "v-san", props: { diagram: { kind: "plumbing_riser", hints: { systemKinds: ["sanitary", "vent"], hidden: ["san-fd2-1", "sys-vent"] } } } });
    const words = texts(evaluateDiagram(b.head.elements, view(b, "v-san")));
    expect(words).not.toContain("FD2-1");
    expect(words).not.toContain("THRU ROOF");
    expect(Object.values(b.head.elements).filter((el) => el.kind === "drawing_item" && el.ownerId === "v-san")).toEqual([]);
  });
});

describe("pipe field paths (shared with tags and schedules)", () => {
  it("size, length, slope, inverts and what the pipe carries", () => {
    const els = sampleMarketModel().head.elements;
    expect(resolveField(els, "san-s4", "pipe.size").text).toBe('4"');
    expect(resolveField(els, "san-s4", "pipe.size_full").text).toBe('4" PVC');
    expect(resolveField(els, "san-s4", "pipe.slope").text).toBe('1/8"/FT');
    expect(resolveField(els, "san-s4", "pipe.length_lf").text).toBe("32 LF");
    expect(resolveField(els, "san-s4", "pipe.invert_end").value).toBeLessThan(resolveField(els, "san-s4", "pipe.invert_start").value as number);
    expect(resolveField(els, "san-s4", "pipe.flow").text).toBe("88 DFU");
    expect(resolveField(els, "gas-s1", "pipe.system").text).toBe("Gas");
    expect(resolveField(els, "gwh", "pipe.size").value).toBeNull();
  });
});

describe("three-storey stack: floors, the stack and the isometric", () => {
  function stack(): Building {
    const s = stackRisers();
    s.ok({ type: "create_view", viewId: "v-stack-san", name: "Sanitary and vent riser", viewType: "detail", props: { diagram: { kind: "plumbing_riser", hints: { systemKinds: ["sanitary", "vent"] } } } });
    s.ok({ type: "create_view", viewId: "v-stack-water", name: "Water riser", viewType: "detail", props: { diagram: { kind: "plumbing_riser", hints: { systemKinds: ["domestic_cold_water", "domestic_hot_water"] } } } });
    s.ok({ type: "create_view", viewId: "v-iso", name: "Plumbing isometric", viewType: "detail", props: { diagram: { kind: "plumbing_isometric" } } });
    return s;
  }

  it("each floor's fixtures on its own band, each floor branch 10 DFU into the stack, 30 at the base", () => {
    const s = stack();
    const ev = evaluateDiagram(s.head.elements, view(s, "v-stack-san"));
    const words = texts(ev);
    // Three floor branches, and the stack piece below Level 3 (the stack is split at each floor and labelled where its load changes: 10, 20, 30).
    expect(count(words, `${STACK_RISER_TOTALS.dfuPerFloor} DFU`)).toBe(4);
    expect(words).toContain(`${2 * STACK_RISER_TOTALS.dfuPerFloor} DFU`);
    expect(words).toEqual(expect.arrayContaining([`${STACK_RISER_TOTALS.dfuBase} DFU`, "LEVEL 1", "LEVEL 2", "LEVEL 3", "CO", "THRU ROOF"]));
    const y = (id: string) => ev?.boxes.find((x) => x.elementId === id && !x.pipe)?.min.y ?? NaN;
    expect(y("san-wc-3-1")).toBeGreaterThan(y("san-wc-2-1"));
    expect(y("san-wc-2-1")).toBeGreaterThan(y("san-wc-1-1"));
    golden("riser-stack-sanitary.svg", svgOf(s, "v-stack-san"));
    const water = texts(evaluateDiagram(s.head.elements, view(s, "v-stack-water")));
    expect(water).toEqual(expect.arrayContaining([`${STACK_RISER_TOTALS.cwService} WFU`, "13 WFU"]));
  });

  it("the isometric projects every pipe from the model: risers stand vertical, each fixture named where it is", () => {
    const s = stack();
    const ev = evaluateDiagram(s.head.elements, view(s, "v-iso"));
    if (!ev) throw new Error("no isometric");
    const words = texts(ev);
    for (const f of [1, 2, 3]) for (const m of ["WC", "LAV"]) expect(words).toContain(`${m}-${f}-1`);
    const segments = Object.values(s.head.elements).filter((el) => el.kind === "run_segment");
    // One target per modelled pipe.
    for (const seg of segments) expect(ev.boxes.some((x) => x.pipe?.elementIds.includes(seg.id))).toBe(true);
    // The cold riser is vertical on paper: its line has one x.
    const riser = ev.boxes.find((x) => x.pipe && x.elementId === "cw-s1");
    expect(riser && Math.abs(riser.max.x - riser.min.x)).toBeLessThan(3);
    golden("isometric-stack.svg", svgOf(s, "v-iso"));
  });
});
