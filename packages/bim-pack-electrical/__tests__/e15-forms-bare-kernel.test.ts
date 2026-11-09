/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 15 lane E15 (E4): a process with the kernel and no add-ons makes no
 * form schedule kind. It lists none, has no built-in template to start one
 * from (the refusal names the add-on that has it), and refuses to save one,
 * in words. Nothing here imports an add-on. Fails on the old code: the
 * kernel carried the panel, feeder and gas templates and a closed list of
 * their kinds itself.
 */
import { builtinFormTemplate, formScheduleKinds, formScheduleSchema } from "@permitzip/bim-kernel";

const TEMPLATE = { name: "Any", title: "ANY", header: { columns: 1, fields: [] }, body: { layout: "slots" as const, phaseLoads: true, columns: [{ heading: "CKT", value: "{number}" }] }, notes: [] };

describe("e15-forms-bare-kernel", () => {
  it("lists no kinds and has no built-in template; the refusal names the add-on", () => {
    expect(formScheduleKinds()).toEqual([]);
    expect(() => builtinFormTemplate("panel")).toThrow("This model uses Electrical, which isn't loaded here");
    expect(() => builtinFormTemplate("gas_connections")).toThrow("This model uses Plumbing and gas, which isn't loaded here");
  });

  it("refuses to save a form schedule of a kind no add-on here makes", () => {
    const refused = formScheduleSchema.safeParse({ kind: "panel", elementId: "l1", template: TEMPLATE });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues.map((i) => i.message)).toContain("No add-on loaded here makes panel schedules");
  });
});
