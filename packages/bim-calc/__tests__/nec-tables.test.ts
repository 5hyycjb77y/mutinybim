/**
 * @jest-environment node
 *
 * The NEC tables as data: internal consistency (the Table 9 resistance and
 * reactance columns reproduce the table's own published "Effective Z at
 * 0.85 PF" column), monotonic columns, cells that are easy to mistype, and
 * the clause numbers that changed between 2020 and 2023.
 */
import { CONDUCTOR_SIZES, necCite, necEdition, necTables, sizeIndex, type ConductorSize, type Table9Raceway } from "../src";
import { effectiveImpedance } from "@permitzip/bim-pack-electrical";

const nec = necEdition("2023");

describe("Chapter 9 Table 9", () => {
  // The table's own Effective Z at 0.85 PF column, Ω/kft (uncoated copper unless noted).
  const published: ReadonlyArray<[ConductorSize, "copper" | "aluminum", Table9Raceway, number]> = [
    ["12", "copper", "pvc", 1.7],
    ["10", "copper", "steel", 1.1],
    ["8", "copper", "steel", 0.7],
    ["8", "copper", "pvc", 0.69],
    ["6", "copper", "steel", 0.45],
    ["4", "copper", "steel", 0.3],
    ["1", "copper", "steel", 0.16],
    ["4/0", "copper", "steel", 0.08],
    ["250", "copper", "aluminum", 0.07],
    ["500", "copper", "pvc", 0.043],
    ["500", "copper", "steel", 0.05],
    ["1000", "copper", "steel", 0.04],
    ["12", "aluminum", "steel", 2.8],
    ["250", "aluminum", "steel", 0.1],
    ["750", "aluminum", "pvc", 0.045],
  ];

  // The printed Ze column was computed from unrounded R, so the rounded R and XL reproduce it to within one unit in its last digit.
  it.each(published)("%s %s in %s conduit: R x 0.85 + XL x sin(arccos 0.85) is within one last digit of the published %s", (size, material, raceway, z) => {
    const ze = effectiveImpedance(nec, size, material, raceway, 0.85)?.ze ?? Number.NaN;
    const decimals = String(z).split(".")[1]?.length ?? 0;
    expect(Math.abs(ze - z)).toBeLessThanOrEqual(10 ** -decimals + 1e-9);
  });

  it("resistance falls as the size grows, in every column", () => {
    const listed = CONDUCTOR_SIZES.filter((s) => necTables.TABLE_9[s]);
    for (let i = 1; i < listed.length; i++) {
      const a = necTables.TABLE_9[listed[i - 1] as ConductorSize];
      const b = necTables.TABLE_9[listed[i] as ConductorSize];
      if (!a || !b) throw new Error("table 9 gap");
      for (let c = 0; c < 3; c++) expect(b.rCopper[c]).toBeLessThan(a.rCopper[c] ?? 0);
    }
  });

  it("has no row for sizes the printed table doesn't list", () => {
    for (const s of ["700", "800", "900", "1250", "2000"] as const) expect(necTables.TABLE_9[s]).toBeUndefined();
    expect(necTables.TABLE_9["14"]?.rAluminum).toBeNull();
  });
});

describe("Table 310.16", () => {
  it("every column rises with size", () => {
    for (const metal of ["copper", "aluminum"] as const) {
      for (let c = 0; c < 3; c++) {
        let prev = 0;
        for (const s of CONDUCTOR_SIZES) {
          const v = necTables.AMPACITY_310_16[s][metal][c];
          if (v === null || v === undefined) continue;
          expect(v).toBeGreaterThan(prev);
          prev = v;
        }
      }
    }
  });

  it("spot cells (the ones most often mistyped)", () => {
    expect(necTables.AMPACITY_310_16["12"].copper).toEqual([20, 25, 30]);
    expect(necTables.AMPACITY_310_16["1"].copper).toEqual([110, 130, 145]);
    expect(necTables.AMPACITY_310_16["3/0"].copper).toEqual([165, 200, 225]);
    expect(necTables.AMPACITY_310_16["500"].copper).toEqual([320, 380, 430]);
    expect(necTables.AMPACITY_310_16["8"].aluminum).toEqual([35, 40, 45]);
    expect(necTables.AMPACITY_310_16["600"].aluminum).toEqual([285, 340, 385]);
    expect(necTables.AMPACITY_310_16["14"].aluminum).toEqual([null, null, null]);
  });
});

describe("Table 250.122 and the other lookups", () => {
  it("1250 kcmil aluminum at 5000 A and 6000 A (changed from 1200 kcmil in 2020)", () => {
    expect(necTables.EGC_250_122.find((r) => r.ocpdMaxA === 5000)?.aluminum).toBe("1250");
    expect(necTables.EGC_250_122.find((r) => r.ocpdMaxA === 6000)?.aluminum).toBe("1250");
  });

  it("EGC sizes never shrink as the device grows", () => {
    for (let i = 1; i < necTables.EGC_250_122.length; i++) {
      const a = necTables.EGC_250_122[i - 1];
      const b = necTables.EGC_250_122[i];
      if (!a || !b) throw new Error("gap");
      expect(sizeIndex(b.copper)).toBeGreaterThanOrEqual(sizeIndex(a.copper));
      expect(sizeIndex(b.aluminum)).toBeGreaterThanOrEqual(sizeIndex(a.aluminum));
    }
  });

  it("conduit areas: the printed 40% column is 40% of the total within rounding, and both rise with trade size", () => {
    for (const list of Object.values(necTables.CONDUIT_AREAS)) {
      let prev = 0;
      for (const s of list) {
        expect(Math.abs(s.fill40In2 - s.totalIn2 * 0.4)).toBeLessThanOrEqual(0.0015);
        expect(s.totalIn2).toBeGreaterThan(prev);
        prev = s.totalIn2;
      }
    }
  });

  it("standard ratings are sorted and include 125 A and 1600 A", () => {
    const r = necTables.STANDARD_OCPD_RATINGS;
    expect([...r].sort((a, b) => a - b)).toEqual(r);
    expect(r).toEqual(expect.arrayContaining([125, 1600]));
  });

  it("every table carries a source note", () => {
    for (const s of Object.values(necTables.SOURCES)) expect(s.note).toMatch(/Transcribed 2026-10-2\d/);
  });
});

describe("clause numbers by edition", () => {
  it("2023 renumbered the demand and ambient tables; 2020 keeps the old numbers", () => {
    const n20 = necEdition("2020");
    const n23 = necEdition("2023");
    expect(necCite(n20, "lighting_demand").text).toBe("NEC 2020 Table 220.42");
    expect(necCite(n23, "lighting_demand").text).toBe("NEC 2023 Table 220.45");
    expect(necCite(n20, "receptacle_demand").text).toBe("NEC 2020 Table 220.44");
    expect(necCite(n23, "receptacle_demand").text).toBe("NEC 2023 Table 220.47");
    expect(necCite(n20, "ambient_correction").clause).toBe("Table 310.15(B)(1)");
    expect(necCite(n23, "ambient_correction").clause).toBe("Table 310.15(B)(1)(1)");
    expect(necCite(n23, "ampacity_table", "75°C column").text).toBe("NEC 2023 Table 310.16, 75°C column");
  });
});
