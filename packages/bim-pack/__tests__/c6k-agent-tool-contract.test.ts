/**
 * @jest-environment node
 *
 * Round 6 lane K, lane T's contract gaps (1.3.0, additive): a first-party
 * add-on may declare its frozen `bim_` tool names and no other pack may; a
 * write may build its command from the model (`build_command` targets a
 * `COMMAND_BUILDER_POINT` row); the host's input keys are named and refused
 * in a declaration; a refusal is `{ refused }`. Before: `bim_` failed the
 * `<pack>_<verb>` rule for every pack, and none of the rest existed.
 */
import {
  AGENT_TOOL_POINT,
  COMMAND_BUILDER_POINT,
  ELECTRICAL_MANIFEST,
  HOST_RESERVED_TOOL_INPUT_KEYS,
  PackSet,
  agentToolNameProblem,
  contribute,
  definePack,
  isPackRefusal,
  runPackConformance,
  withPackSet,
  type AgentToolDescriptor,
  type CommandBuilderDef,
} from "@permitzip/bim-pack";
import { DEFAULT_SETTINGS, type ModelState } from "@permitzip/bim-kernel";
import { ELECTRICAL_PACK } from "@permitzip/bim-pack-electrical";

const tool = (name: string, extra: Partial<AgentToolDescriptor> = {}): AgentToolDescriptor => ({
  name,
  title: "Tool",
  description: "Does one thing.",
  input: { type: "object", properties: { label: { type: "string" } } },
  permission: "write",
  target: { kind: "build_command", build: "zz.tag_builder" },
  ...extra,
});

const BUILDER: CommandBuilderDef = {
  id: "zz.tag_builder",
  label: "Tag text",
  build: (model, input) => (model.elements["t-1"] ? { command: { type: "set_tag_text", tagId: "t-1", text: typeof input === "object" && input !== null && "label" in input ? String(input.label) : "" } } : { refused: "There is no tag t-1 in this model" }),
};

const MODEL: ModelState = { modelId: "c6k-tools", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

describe("c6k agent-tool contract", () => {
  it("a first-party pack may declare bim_ names; any other pack may not", () => {
    expect(agentToolNameProblem("electrical", "bim_size_circuit", true)).toBeNull();
    expect(agentToolNameProblem("zz", "bim_size_circuit")).toBe('agent tool "bim_size_circuit" must start with "zz_"');
    const firstParty = definePack(ELECTRICAL_MANIFEST, [...ELECTRICAL_PACK.contributions, contribute(AGENT_TOOL_POINT, [tool("bim_c6k_probe")]), contribute(COMMAND_BUILDER_POINT, [BUILDER])]);
    expect(runPackConformance(firstParty).problems.filter((p) => p.includes("bim_c6k_probe"))).toEqual([]);
    const third = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0", firstParty: true }, [contribute(AGENT_TOOL_POINT, [tool("bim_x")]), contribute(COMMAND_BUILDER_POINT, [BUILDER])]);
    expect(runPackConformance(third).problems).toContain('agent tool "bim_x" must start with "zz_"');
  });

  it("refuses a declaration of the keys the host fills", () => {
    expect([...HOST_RESERVED_TOOL_INPUT_KEYS]).toEqual(["project_id", "model_id", "base_revision"]);
    const pack = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [
      contribute(AGENT_TOOL_POINT, [tool("zz_tag", { input: { type: "object", properties: { model_id: { type: "string" }, base_revision: { type: "number" } } } }), tool("zz_plan", { input: { type: "object", properties: { project_id: { type: "string" } } } })]),
      contribute(COMMAND_BUILDER_POINT, [BUILDER]),
    ]);
    const problems = runPackConformance(pack).problems;
    expect(problems).toContain('agent tool "zz_tag" declares model_id, base_revision, which the host fills for every model tool');
    expect(problems.some((p) => p.includes("zz_plan"))).toBe(false);
  });

  it("a command builder answers with a command or a refusal, inside its set only", () => {
    const set = PackSet.create([definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(COMMAND_BUILDER_POINT, [BUILDER])])]);
    const builder = withPackSet(set, () => set.items(COMMAND_BUILDER_POINT).find((b) => b.id === "zz.tag_builder"));
    const refused = builder?.build(MODEL, { label: "A" });
    expect(isPackRefusal(refused)).toBe(true);
    expect(refused).toEqual({ refused: "There is no tag t-1 in this model" });
    expect(isPackRefusal({ command: { type: "x" } })).toBe(false);
    expect(PackSet.create([]).items(COMMAND_BUILDER_POINT)).toEqual([]);
  });
});
