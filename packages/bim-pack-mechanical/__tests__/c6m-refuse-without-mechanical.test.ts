/**
 * @jest-environment node
 *
 * @mutinybim-bare-kernel: the test setup must not install the first-party
 * add-ons; this file proves what a host without Mechanical says.
 *
 * A model with Mechanical content opened where the Mechanical add-on isn't
 * loaded keeps that content and says so in words: a stored insulation edit is
 * refused naming the add-on, and a placed ventilation or pressurization table
 * still parses and prints "This model uses Mechanical, which isn't loaded
 * here" instead of disappearing. Before the move the kernel ran these itself;
 * a host without the add-on had no refusal to give (tables read "No add-on in
 * this model draws ventilation tables", commands were kernel commands).
 */
import { blockTableInputSchema, blockTableSpec, commandSchema, renderTableBlock, type ModelState } from "@permitzip/bim-kernel";
import { installedFirstPartyPacks, packNotLoadedMessage } from "@permitzip/bim-kernel/packs";

const NOT_LOADED = "This model uses Mechanical, which isn't loaded here";

const EMPTY: Pick<ModelState, "elements"> = { elements: {} };

describe("a host without the Mechanical add-on", () => {
  it("has no Mechanical pack installed (the bare kernel)", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("mechanical");
    expect(packNotLoadedMessage("mechanical")).toBe(NOT_LOADED);
  });

  it("refuses a stored insulation edit by naming the add-on", () => {
    for (const raw of [
      { type: "set_run_insulation", elementId: "seg-1", insulation: { kind: "wrap", thicknessMm: 25.4 }, scope: "piece" },
      { type: "set_pipe_insulation", systemId: "sys-1", pieces: [{ segmentId: "p-1", insulation: null }] },
    ]) {
      const r = commandSchema.safeParse(raw);
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual([NOT_LOADED]);
    }
  });

  it("keeps a placed ventilation or pressurization table and prints the refusal in its place", () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    for (const kind of ["ventilation", "pressurization"] as const) {
      const input = blockTableInputSchema.parse({ kind, scope: { kind: "model" } });
      const rendered = renderTableBlock(EMPTY, blockTableSpec(input));
      expect(rendered.text).toBe(NOT_LOADED);
      expect(rendered.unresolved).toEqual([kind]);
    }
  });
});
