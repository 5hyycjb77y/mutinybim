/**
 * @jest-environment node
 *
 * Round 12 lane P12 (round 11's P11, step 0): pipe fitting families are rows
 * of the kernel's `FITTING_FAMILY_POINT`, contributed by the Plumbing and gas
 * add-on, and every family reader (`fittingFamily`, `fittingFamilies()`,
 * `systemDefault`, the fit check and the placed label) reads them there.
 * Installs only Plumbing and gas (@mutinybim-bare-kernel), so the proof
 * doesn't lean on any other add-on.
 *
 * Fails on round 11's code: the kernel's static `FITTING_FAMILIES` held every
 * pipe family, the add-on contributed none, and there was no
 * `fittingFamilies()` reader.
 */
import {
  FITTING_FAMILIES,
  FITTING_FAMILY_POINT,
  familyMismatch,
  fittingFamilies,
  fittingFamily,
  fittingFamilyRowProblems,
  packFittingFamilyRow,
  pipeFittingLabel,
  systemDefault,
  type RunSize,
} from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PIPE_FITTING_FAMILIES, PIPE_FITTING_FAMILY_ROWS, PLUMBING_GAS_CONTRIBUTIONS, PLUMBING_GAS_PACK } from "../src";

const IN = 25.4;
const copper = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "copper" });

describe("p12-fitting-family-point", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("the kernel's own list holds no pipe family; the add-on contributes all of them as rows", () => {
    expect(FITTING_FAMILIES.filter((f) => f.domain === "pipe")).toEqual([]);
    expect(PLUMBING_GAS_CONTRIBUTIONS.some((c) => c.pointId === FITTING_FAMILY_POINT.id)).toBe(true);
    expect(PIPE_FITTING_FAMILY_ROWS.map((r) => r.family)).toEqual(PIPE_FITTING_FAMILIES);
    expect(fittingFamilyRowProblems(PIPE_FITTING_FAMILY_ROWS)).toEqual([]);
  });

  it("fittingFamily and fittingFamilies() read the rows: kernel rows first, then the add-on's in row order", () => {
    const all = fittingFamilies();
    expect(all.slice(0, FITTING_FAMILIES.length)).toEqual(FITTING_FAMILIES);
    expect(all.slice(FITTING_FAMILIES.length).map((f) => f.id)).toEqual(PIPE_FITTING_FAMILIES.map((f) => f.id));
    expect(fittingFamily("dwv.sanitary_tee")).toBe(PIPE_FITTING_FAMILIES.find((f) => f.id === "dwv.sanitary_tee"));
    expect(fittingFamilies()).toBe(all);
  });

  it("slot defaults, the fit rule and the label come from the add-on's rows", () => {
    expect(systemDefault({ systemKind: "sanitary", domain: "pipe" }, "drain_branch_hv")).toEqual({ family: "dwv.sanitary_tee" });
    expect(systemDefault({ systemKind: "natural_gas", domain: "pipe" }, "pipe_tee", { shape: "pipe", nominalMm: 25.4, material: "csst" })).toEqual({ family: "pipe.gas.csst_tee" });
    const vent = fittingFamily("dwv.vent_tee");
    if (!vent) throw new Error("dwv.vent_tee");
    expect(packFittingFamilyRow("dwv.vent_tee")?.mismatch).toBeDefined();
    expect(familyMismatch(vent, { fittingType: "tee", domain: "pipe", sizes: [{ shape: "pipe", nominalMm: 101.6, material: "pvc" }], systemKind: "sanitary" })).toBe(
      "A vent tee has no sweep, so it can't take drainage; use a sanitary tee or a combination wye & 1/8 bend",
    );
    const tee = fittingFamily("pipe.water.tee");
    if (!tee) throw new Error("pipe.water.tee");
    expect(pipeFittingLabel(tee, [copper(1)], copper(2))).toBe("Reducing tee");
    expect(pipeFittingLabel(tee, [copper(2)], copper(2))).toBe("Tee");
  });
});
