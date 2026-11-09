/**
 * @jest-environment node
 *
 * A firm's tag style "{mark} @ {cfm} cfm" on a supply diffuser printed
 * "SD-1 @  cfm" (CI run 42258218369, drawings-ws6): the built-in air terminal
 * tag read the diffuser's airflow, a style line's {cfm} read only a
 * parameter named "cfm". The mechanical pack's tag field alias reads the
 * airflow for it now; the kernel holds no trade names for it.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_SETTINGS, builtinPartType, commandSchema, executeCommand, renderTagStyleLines, tagLines, type ModelState, type TagSpec } from "@permitzip/bim-kernel";

installFirstPartyAddOns();

function diffuserModel(): ModelState {
  let m: ModelState = { modelId: "r4-tags", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (c: unknown) => {
    const r = executeCommand(m, commandSchema.parse(c));
    if (!r.ok) throw new Error(r.error.message);
    m = { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
  };
  run({ type: "create_level", levelId: "l1", name: "L1", elevationMm: 0 });
  const d = builtinPartType("builtin:supply-diffuser-24@1");
  if (!d) throw new Error("the starter library has no supply diffuser");
  run({ type: "place_part", partId: "sd1", typeId: d.id, partType: d.definition, levelId: "l1", position: { x: 0, y: 0 }, offsetMm: 2743, mark: "SD-1", values: { airflow: 150 } });
  return m;
}

describe("a style line's {cfm} on an air terminal", () => {
  it("prints the airflow the built-in tag prints", () => {
    const m = diffuserModel();
    const sd = m.elements["sd1"];
    if (!sd) throw new Error("no diffuser");
    expect(renderTagStyleLines(m, sd, ["{mark} @ {cfm} cfm"])).toEqual(["SD-1 @ 150 cfm"]);
    const spec: TagSpec = { elementId: sd.id, template: "air_terminal", leader: false };
    expect(tagLines(m, spec)).toEqual(["SD-1", "150 CFM"]);
  });
});
