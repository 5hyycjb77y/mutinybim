/**
 * @jest-environment node
 *
 * Round 13 lane E: a panel's spare capacity against the design limit
 * `electrical.panel_spare_capacity`, and a service's cushion against
 * `electrical.service_cushion`. 25 % is the default; the firm's 30 % wins over
 * it; this project's 20 % wins over the firm's. Under the target the line says
 * "Below target" in words, and each reading says which layer set the target.
 *
 * Fails on round 12's code: there is no spare-capacity reading (the panel
 * schedule had no footer line) and the targets didn't say which layer set them.
 */
import type { DesignLimit } from "@permitzip/bim-kernel/policy";
import { ELECTRICAL_DESIGN_LIMIT_DEFAULTS, PANEL_SPARE_LIMIT_ID, SERVICE_CUSHION_LIMIT_ID, spareCapacityReading, serviceCushionReading } from "@permitzip/bim-pack-electrical";

const base = (id: string): DesignLimit => {
  const d = ELECTRICAL_DESIGN_LIMIT_DEFAULTS.find((l) => l.id === id);
  if (!d) throw new Error(`no default ${id}`);
  return d;
};
const at = (id: string, min: number): DesignLimit => ({ ...base(id), band: { min }, citation: { source: "Firm standard" } });

/** A 225 A panel carrying 155 A: 70 A left, 31 %. */
const PANEL = { limitA: 225, headroomA: 70 };

describe("e13: spare capacity on the panel schedule footer", () => {
  it("reads against the 25 % default", () => {
    const r = spareCapacityReading(PANEL);
    expect(r).toMatchObject({ percent: 31, below: false, text: "Spare capacity: 31 % (target 25 %)" });
    expect(r.target.layer).toBe("addon");
  });

  it("the firm's 30 % wins over the default; this project's 20 % wins over the firm's", () => {
    const firm = spareCapacityReading({ limitA: 225, headroomA: 50 }, { firm: [at(PANEL_SPARE_LIMIT_ID, 30)] });
    expect(firm).toMatchObject({ percent: 22, below: true, text: "Spare capacity: 22 % — Below target (30 %)" });
    expect(firm.target.layer).toBe("firm");
    const project = spareCapacityReading({ limitA: 225, headroomA: 50 }, { firm: [at(PANEL_SPARE_LIMIT_ID, 30)], project: [at(PANEL_SPARE_LIMIT_ID, 20)] });
    expect(project).toMatchObject({ percent: 22, below: false, text: "Spare capacity: 22 % (target 20 %)" });
    expect(project.target.layer).toBe("project");
  });

  it("says below target in words, and says so when there is nothing to measure", () => {
    expect(spareCapacityReading({ limitA: 225, headroomA: 50 }).text).toContain("Below target");
    expect(spareCapacityReading({ limitA: 225, headroomA: -20 })).toMatchObject({ percent: -9, below: true });
    expect(spareCapacityReading({ limitA: null, headroomA: null })).toMatchObject({ percent: null, below: false, text: "Spare capacity: no rating to measure against (target 25 %)" });
  });

  it("the service-size dialog reads the cushion over demand the same way", () => {
    expect(serviceCushionReading({ demandA: 342, serviceA: 400 })).toMatchObject({ percent: 17, below: true, text: "Cushion over demand: 17 % — Below target (30 %)" });
    expect(serviceCushionReading({ demandA: 300, serviceA: 400 }, { project: [at(SERVICE_CUSHION_LIMIT_ID, 25)] })).toMatchObject({ percent: 33, below: false, text: "Cushion over demand: 33 % (target 25 %)" });
    expect(serviceCushionReading({ demandA: 300, serviceA: null }).percent).toBeNull();
  });
});
