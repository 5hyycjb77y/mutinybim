/**
 * @jest-environment node
 *
 * Round 16 B2 (review video, Nov 6, 01:02–02:13): "It's weird that that's not
 * a date picker… system level parameters." Project facts are stated once,
 * typed (a date is a date, a status is one of a list) and printed on every
 * sheet; a sheet's own value wins. Fails on round 15's code: there was no
 * `set_project_parameters`, sheet fields were untyped strings, and a sheet
 * with no fields printed no date, status or address at all.
 */
import {
  ISSUE_STATUS_CHOICES,
  buildSheetSceneFor,
  commandSchema,
  executeCommand,
  formatParameterValue,
  isoDateOf,
  organizationOf,
  parseParameterValue,
  projectParametersOf,
  sheetFieldValues,
  standardProjectParameter,
  withUpgradePolicy,
  PROJECT_PARAMETERS_FEATURE,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

/** As the model server decides it: every peer of this release reads project parameter records. */
const decide = (model: ModelState, command: Record<string, unknown> & { type: string }) => withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse(command)));

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = decide(model, command);
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function refused(model: ModelState, command: Record<string, unknown> & { type: string }): string {
  const r = decide(model, command);
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

const sheetTexts = (model: ModelState, sheetId: string) => buildSheetSceneFor(model, sheetId, { projectName: "Host project" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));

function withSheets(): ModelState {
  let m = run(createDemoModel(), { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Level 1 plan" });
  m = run(m, { type: "create_sheet", sheetId: "s2", number: "M-102", name: "Level 2 plan" });
  return m;
}

describe("b2 project parameters: typed values", () => {
  it("a date is a real calendar day and prints MM/DD/YYYY", () => {
    expect(isoDateOf("2026-11-06")).toBe("2026-11-06");
    expect(isoDateOf("2026-02-30")).toBeNull();
    expect(isoDateOf("next tuesday")).toBeNull();
    const date = standardProjectParameter("date");
    expect(date?.valueType).toBe("date");
    expect(formatParameterValue(date, "2026-11-06")).toBe("11/06/2026");
    expect(parseParameterValue(date!, "Nov 6")).toEqual({ ok: false, reason: expect.stringMatching(/must be a date/) });
  });

  it("a status is one of its list, stored as the list spells it", () => {
    const status = standardProjectParameter("status");
    expect(status?.valueType).toBe("choice");
    expect(status?.choices).toEqual(ISSUE_STATUS_CHOICES);
    expect(parseParameterValue(status!, "issued for PERMIT")).toEqual({ ok: true, value: "Issued for permit" });
    expect(parseParameterValue(status!, "Approved")).toEqual({ ok: false, reason: expect.stringMatching(/isn't on the list/) });
  });
});

describe("b2 project parameters: set once, every sheet prints them", () => {
  it("stores the project's facts as model records and checks each against its type", () => {
    const m = run(withSheets(), {
      type: "set_project_parameters",
      values: { address: "100 Example St, Anytown VA", client: "Sample School", date: "2026-11-06", status: "issued for permit" },
    });
    expect(projectParametersOf(m).values).toEqual({ address: "100 Example St, Anytown VA", client: "Sample School", date: "2026-11-06", status: "Issued for permit" });
    expect(organizationOf(m).projectParameters.map((p) => p.id).sort()).toEqual(["project-parameter:address", "project-parameter:client", "project-parameter:date", "project-parameter:status"]);
    expect(refused(m, { type: "set_project_parameters", values: { date: "next tuesday" } })).toMatch(/Issue date must be a date/);
    expect(refused(m, { type: "set_project_parameters", values: { status: "Approved" } })).toMatch(/Status is one of: Preliminary, For review, Issued for permit/);
  });

  it("every sheet's title block prints them; a sheet's own value wins; clearing one removes it", () => {
    let m = run(withSheets(), { type: "set_project_parameters", values: { address: "100 Example St", date: "2026-11-06", status: "For review" } });
    for (const id of ["s1", "s2"]) {
      const texts = sheetTexts(m, id);
      expect(texts).toEqual(expect.arrayContaining(["100 Example St", "11/06/2026", "For review"]));
    }
    m = run(m, { type: "set_sheet_properties", sheetId: "s2", fields: { status: "Issued for permit" } });
    expect(sheetTexts(m, "s1")).toContain("For review");
    expect(sheetTexts(m, "s2")).toContain("Issued for permit");
    expect(sheetTexts(m, "s2")).not.toContain("For review");
    m = run(m, { type: "set_project_parameters", values: { address: null } });
    expect(projectParametersOf(m).values.address).toBeUndefined();
    expect(sheetTexts(m, "s1")).not.toContain("100 Example St");
  });

  it("a sheet's own ISO date prints formatted like the project's", () => {
    const m = withSheets();
    expect(sheetFieldValues(m, { props: { fields: { date: "2026-12-01" } } })).toMatchObject({ date: "12/01/2026" });
  });

  it("an older model server that doesn't store them refuses in words, saving nothing", () => {
    const r = withUpgradePolicy((f) => f !== PROJECT_PARAMETERS_FEATURE, () => executeCommand(withSheets(), commandSchema.parse({ type: "set_project_parameters", values: { client: "Sample School" } })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/older version that doesn't store it/);
  });

  it("a fact outside the standard list is defined first, then typed like the rest", () => {
    const m = withSheets();
    expect(refused(m, { type: "set_project_parameters", values: { phase: "Phase 2" } })).toMatch(/isn't a project fact yet/);
    const defined = run(m, {
      type: "set_project_parameters",
      define: [{ key: "phase", label: "Project phase", valueType: "choice", choices: ["Phase 1", "Phase 2"] }],
      values: { phase: "phase 2" },
    });
    expect(projectParametersOf(defined).values.phase).toBe("Phase 2");
    expect(projectParametersOf(defined).byKey.get("phase")?.label).toBe("Project phase");
    expect(refused(defined, { type: "set_project_parameters", values: { phase: "Phase 3" } })).toMatch(/Project phase is one of: Phase 1, Phase 2/);
    expect(refused(m, { type: "set_project_parameters", define: [{ key: "date", label: "Date", valueType: "text" }], values: { date: "x" } })).toMatch(/standard project fact/);
  });
});
