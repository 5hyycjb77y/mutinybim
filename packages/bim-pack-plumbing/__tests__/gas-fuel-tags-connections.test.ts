/**
 * @jest-environment node
 *
 * Gas, as the issued 7492 (Sample Market) gas sheets print it:
 *
 * - The fuel comes from the system's data. A propane system's pipe labels,
 *   tags and riser say propane; before this every gas pipe said "natural
 *   gas" whatever the system carried.
 * - Every gas segment is tagged with its size and developed length
 *   (`1" 3 LF`), and tag fields read the developed length from the source
 *   and the pressure zone. Before this a gas pipe tag said `¾" black steel`
 *   and tag fields on a pipe read nothing.
 * - The gas connection schedule: one row per appliance or load point with
 *   its input (MBH, CFH), pressure zone, regulator, the size of the pipe
 *   that feeds it, the developed length from the source along the routed
 *   pipe, and its sizing basis. It did not exist.
 * - A load point on a gas pipe end is an outlet: before this the gas zones
 *   walk skipped it, so its input was not sized.
 * - Polyethylene is a gas pipe material with the fuel gas code's PE
 *   dimensions (½" SDR 9, 0.660" ID).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildViewScene, builtinFormTemplate, createTagStyleFromPreset, evaluateDiagram, evaluateFormSchedule, fieldText, pipeDims, pipeRow, planCommit, runLabel, sceneToSvg, sizeLabel, systemKindLabel, tagLines, tagStylePreset, tagStylePresets, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { GAS_SIZE_LENGTH_TAG_PRESET, gasConnectionRows, gasNetwork, plumbingDiagramGraph } from "../src";
import { buildSampleMarketGas, SAMPLE_MARKET_GAS_SYSTEM } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { buildGasLine, GAS_LINE_SYSTEM } from "../../bim-kernel/__tests__/fixtures/gas-pe-line";

const GOLDEN = path.join(__dirname, "golden");

/** Compare against a checked-in golden file; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

const seg = (m: ModelState, id: string): RunSegment => {
  const el = m.elements[id];
  if (el?.kind !== "run_segment") throw new Error(`${id} isn't a run segment`);
  return el;
};

describe("gas labels use the system's fuel", () => {
  const propane = buildSampleMarketGas();
  const natural = buildGasLine({ fuel: "natural", material: "black_steel", end: "doas", nominalIn: 1 });

  it("a propane system's pipe labels say propane; a natural gas system's say natural gas", () => {
    expect(runLabel(propane.elements, seg(propane, "k08-b-s1"))).toBe('¾" black steel propane pipe');
    expect(runLabel(natural.elements, seg(natural, "line-s1"))).toBe('1" black steel natural gas pipe');
    const sys = propane.elements[SAMPLE_MARKET_GAS_SYSTEM];
    expect(sys?.kind === "mep_system" && systemKindLabel(sys)).toBe("Propane");
  });

  it("the riser's source says which gas it is", () => {
    const graph = plumbingDiagramGraph(natural.elements, { systemKinds: ["natural_gas"] });
    expect(graph.roots[0]?.lines.map((l) => l.text)).toEqual(["GM-1", "GAS LINE", "NATURAL GAS, 7 IN. W.C., 224.41 MBH TOTAL"]);
  });

  it("the drawn gas riser says propane, never natural gas (golden)", () => {
    const d = planCommit(propane, [], { idempotencyKey: "gas-riser-view", baseRevision: propane.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: { type: "create_view", viewId: "v-gas", name: "Gas riser", viewType: "detail", props: { diagram: { kind: "plumbing_riser", hints: { systemKinds: ["natural_gas"] } } } } }, () => "2026-10-24T00:00:00.000Z");
    if (!d.ok) throw new Error(d.error.message);
    const v = d.model.elements["v-gas"];
    if (v?.kind !== "view") throw new Error("view");
    const words = (evaluateDiagram(d.model.elements, v)?.items ?? []).flatMap((i) => (i.shape === "text" ? (i.note?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")) : []));
    expect(words).toEqual(expect.arrayContaining(["PROPANE, 2 PSI, 1,024.41 MBH TOTAL"]));
    expect(words.join(" ")).not.toMatch(/NATURAL GAS/);
    golden("riser-gas-propane.svg", sceneToSvg(buildViewScene(d.model, "v-gas").scene));
  });

  it("tag fields say the fuel", () => {
    expect(fieldText(propane.elements, "main-s1", "gas.fuel")).toBe("Propane");
    expect(fieldText(natural.elements, "line-s1", "gas.fuel")).toBe("Natural gas");
  });
});

describe("gas segment tags: size and developed length", () => {
  const m = buildSampleMarketGas();

  it("an automatic tag on a gas pipe prints its size and length, as the sheet tags every piece", () => {
    expect(tagLines(m, { elementId: "main-s1", template: "auto", leader: false })).toEqual(['¾" 50 LF']);
    expect(tagLines(m, { elementId: "k08-b-s1", template: "gas_pipe", leader: false })).toEqual(['¾" 5 LF']);
    expect(tagLines(m, { elementId: "main-s3", template: "pipe_size", leader: false })).toEqual(['¾" black steel']);
  });

  it("the same content as a tag style: its lines print what the built-in gas tag prints", () => {
    const style = tagLines({ elements: styleElement(m) }, { elementId: "k08-b-s1", template: "auto", leader: false, styleId: "ts-gas" });
    expect(GAS_SIZE_LENGTH_TAG_PRESET.lines).toEqual(["{gas.size} {gas.length}"]);
    expect(style).toEqual(['¾" 5 LF']);
  });

  it("is a registered tag style preset: a style started from it prints the gas tag", () => {
    const preset = tagStylePreset("gas.size_length");
    expect(preset).toEqual(GAS_SIZE_LENGTH_TAG_PRESET);
    expect(tagStylePresets().filter((p) => p.trade === "gas").map((p) => p.id)).toEqual(["gas.size_length"]);
    if (!preset) throw new Error("gas preset not registered");
    const r = planCommit(m, [], { idempotencyKey: "gas-preset-style", baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: createTagStyleFromPreset(preset, "ts-gas-preset", []) }, () => "2026-10-25T00:00:00.000Z");
    if (!r.ok) throw new Error(r.error.message);
    expect(tagLines(r.model, { elementId: "k08-b-s1", template: "auto", leader: false, styleId: "ts-gas-preset" })).toEqual(['¾" 5 LF']);
  });

  it("tag fields read the developed length from the source and the pressure zone from the sizing walk", () => {
    expect(fieldText(m.elements, "main-s1", "gas.from_source")).toBe("50 LF");
    expect(fieldText(m.elements, "k08-b-s1", "gas.from_source")).toBe("129 LF");
    expect(fieldText(m.elements, "main-s1", "gas.zone")).toBe("2 psi");
    expect(fieldText(m.elements, "main-s3", "gas.zone")).toBe("11 in. w.c.");
    expect(tagLines(m, { elementId: "main-s4", template: "fields", fields: ["pipe.size", "gas.from_source"], leader: false })).toEqual(['¾"', "143 LF"]);
  });

  it("a PE gas pipe's size says its SDR and material; a missing pipe reads nothing", () => {
    const pe = buildGasLine({ fuel: "natural", end: "doas" });
    expect(fieldText(pe.elements, "line-s1", "gas.size")).toBe('½" SDR 9 PE');
    expect(fieldText(m.elements, "nope", "gas.size")).toBe("");
  });
});

describe("gas connection schedule (one row per appliance or load point)", () => {
  const m = buildSampleMarketGas();

  it("gives every outlet's input, zone, regulator, feed size and developed length from the source along the routed pipe", () => {
    expect(gasConnectionRows(m).map((r) => [r.mark, r.inputMbh, r.inputCfh, r.zoneInletInWc, r.regulatorLabel, r.pipeNominalIn, r.developedLengthFt, r.zoneLengthFt, r.basis.lengthFt])).toEqual([
      ["DOAS-1", 224.407, 89.2, 11, "Appliance regulator AR-DOAS", 0.75, 40, 15, 15],
      ["GWH", 250, 99.4, 11, "Appliance regulator AR-GWH", 0.75, 55, 15, 15],
      ["K07", 90, 35.8, 11, "Line regulator LR-1", 0.75, 119, 68, 97],
      ["K08", 220, 87.4, 11, "Line regulator LR-1", 0.75, 129, 78, 97],
      ["K09", 120, 47.7, 11, "Line regulator LR-1", 0.75, 138, 87, 97],
      // The far fryer: 51 ft of 2 psi main to LR-1, then the 97 ft cook line that sets the zone's length.
      ["K09", 120, 47.7, 11, "Line regulator LR-1", 0.75, 148, 97, 97],
    ]);
  });

  it("prints as a form schedule beside the gas equipment schedule", () => {
    const form = evaluateFormSchedule(m, { kind: "gas_connections", template: builtinFormTemplate("gas_connections") });
    expect(form.title).toBe("GAS CONNECTION SCHEDULE");
    expect(form.grid.headings).toEqual(["ID", "DESCRIPTION", "GAS", "INPUT (MBH)", "INPUT (CFH)", "PRESSURE ZONE", "REGULATOR", "PIPE SIZE", "DEVELOPED LENGTH (FT)", "SIZING BASIS"]);
    expect(form.grid.rows[3]).toEqual(["K08", "Gas range, 36 in.", "Propane", "220", "87.4", "11 in. w.c.", "Line regulator LR-1", '¾"', "129", "Longest length, 97 ft, 11 in. w.c. inlet, 0.5 in. w.c. drop"]);
    expect(form.grid.rowIds[5]).toEqual(["k09a"]);
    expect(form.totals).toEqual([{ label: "TOTAL GAS INPUT", value: "1,024,407 BTU/H" }]);
  });

  it("branch length method: each outlet is sized on its own length from the zone's start", () => {
    const branch = gasConnectionRows({ elements: { ...m.elements, [SAMPLE_MARKET_GAS_SYSTEM]: withSizing(m, "branch_length") } });
    expect(branch.find((r) => r.elementId === "k07")?.basis).toMatchObject({ method: "branch_length", lengthFt: 68 });
  });
});

/** A project tag style made from the gas preset (the organization record tag styles live in). */
function styleElement(m: ModelState): Record<string, ModelState["elements"][string]> {
  const r = planCommit(m, [], { idempotencyKey: "gas-style", baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: { type: "create_tag_style", styleId: "ts-gas", name: GAS_SIZE_LENGTH_TAG_PRESET.name, lines: [...GAS_SIZE_LENGTH_TAG_PRESET.lines] } }, () => "2026-10-24T00:00:00.000Z");
  if (!r.ok) throw new Error(r.error.message);
  return r.model.elements;
}

function withSizing(m: ModelState, gasSizing: "branch_length" | "longest_run") {
  const sys = m.elements[SAMPLE_MARKET_GAS_SYSTEM];
  if (sys?.kind !== "mep_system") throw new Error("system");
  return { ...sys, design: { ...sys.design, pipe: { ...sys.design?.pipe, gasSizing } } };
}

describe("a load point on a gas pipe end is an outlet", () => {
  const m = buildGasLine({ fuel: "propane", end: { loadPointMbh: 150 } });

  it("its input is on the zone, sized, and on the connection schedule", () => {
    const net = gasNetwork(m, GAS_LINE_SYSTEM);
    expect(net?.totalMbh).toBe(150);
    expect(net?.appliances.map((a) => [a.mark, a.source, a.mbh, a.fromSourceFt, a.feedElementId])).toEqual([["K10", "load_point", 150, 40, "line-s1"]]);
    expect(net?.issues).toEqual([]);
    const rows = gasConnectionRows(m);
    expect(rows.map((r) => [r.mark, r.source, r.developedLengthFt, r.pipeNominalIn, r.pipeMaterial])).toEqual([["K10", "load_point", 40, 0.5, "pe"]]);
  });
});

describe("polyethylene gas pipe", () => {
  it("has the fuel gas code's PE dimensions and designations", () => {
    const half = { shape: "pipe" as const, nominalMm: 12.7, material: "pe" as const, spec: "sdr11" as const };
    expect(pipeDims(half)).toMatchObject({ idMm: 16.764, listed: true });
    expect(pipeRow(half)?.designation).toBe("SDR 9");
    expect(pipeRow({ ...half, nominalMm: 1.25 * 25.4 })?.designation).toBe("SDR 10");
    expect(sizeLabel(half)).toBe('½" SDR 9 PE');
    expect(sizeLabel({ ...half, nominalMm: 25.4 })).toBe('1" SDR 11 PE');
  });

  it("routes as gas pipe with fusion fittings and is tagged with its SDR", () => {
    const m = buildGasLine({ fuel: "propane", end: "doas" });
    expect(seg(m, "line-s1").size).toMatchObject({ material: "pe" });
    expect(tagLines(m, { elementId: "line-s1", template: "auto", leader: false })).toEqual(['½" SDR 9 PE 40 LF']);
  });
});
