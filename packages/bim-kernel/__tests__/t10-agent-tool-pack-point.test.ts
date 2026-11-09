/**
 * @jest-environment node
 *
 * Round 10 (T10): tool packs are part of the add-on contract. An
 * `AGENT_TOOL_POINT` row names its pack; an add-on declares a pack of its own
 * on `AGENT_TOOL_PACK_POINT`; untagged rows form `addon.<packId>`. Every tool
 * is in exactly one pack.
 */
import {
  AGENT_TOOL_PACK_POINT,
  AGENT_TOOL_POINT,
  PACK_CONTRACT_VERSION,
  PackSet,
  agentToolPackOf,
  agentToolPackRowProblems,
  agentToolPackSetProblems,
  contribute,
  definePack,
  type AgentToolDescriptor,
  type AgentToolPackDescriptor,
} from "../src/packs";

const tool = (name: string, extra: Partial<AgentToolDescriptor> = {}): AgentToolDescriptor => ({
  name,
  title: name,
  description: "Counts elements. Read-only.",
  input: { type: "object", properties: {} },
  permission: "read",
  target: { kind: "read", read: `${name}.read` },
  ...extra,
});

const ownPack: AgentToolPackDescriptor = { id: "acme.doors", label: "Doors", purpose: "Door hardware and swing checks", skill: "acme-doors", slug: "acme-doors", tokenCap: 3_000 };

describe("t10-addon-pack-zero-kernel-edits: the agent tool pack point", () => {
  it("an add-on declares its own pack and tags its tools with it, with no kernel edit", () => {
    const pack = definePack({ id: "acme", name: "Acme doors", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
      contribute(AGENT_TOOL_PACK_POINT, [ownPack]),
      contribute(AGENT_TOOL_POINT, [tool("acme_door_swing", { pack: "acme.doors" }), tool("acme_hardware")]),
    ]);
    const set = PackSet.create([pack]);
    const packs = set.packItems(AGENT_TOOL_PACK_POINT).filter((p) => p.id.startsWith("acme."));
    expect(packs.map((p) => p.id)).toEqual(["acme.doors"]);
    const tools = set.packItems(AGENT_TOOL_POINT).filter((t) => t.name.startsWith("acme_"));
    expect(tools.map((t) => agentToolPackOf("acme", t))).toEqual(["acme.doors", "addon.acme"]);
    expect(agentToolPackSetProblems(packs, tools.map((t) => ({ packId: "acme", tool: t })))).toEqual([]);
  });

  it("an add-on's pack id is namespaced by the add-on", () => {
    expect(() => definePack({ id: "acme", name: "Acme", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(AGENT_TOOL_PACK_POINT, [{ ...ownPack, id: "doors" }])])).toThrow(/acme\./);
  });

  it("a pack row needs a label, purpose, slug, skill name and a numeric token cap", () => {
    expect(agentToolPackRowProblems(ownPack)).toEqual([]);
    expect(agentToolPackRowProblems({ ...ownPack, slug: "Acme Doors", skill: "acme--doors", tokenCap: Number.NaN, purpose: " " })).toHaveLength(4);
  });

  it("every tool in exactly one pack; pack ids, slugs and skills unique; a read-only pack holds only reads; a named pack must exist", () => {
    const readOnly: AgentToolPackDescriptor = { ...ownPack, id: "acme.audit", slug: "acme-audit", skill: "acme-audit", readOnly: true };
    const problems = agentToolPackSetProblems(
      [ownPack, readOnly, { ...ownPack, id: "acme.copy" }],
      [
        { packId: "acme", tool: tool("acme_a", { pack: "acme.doors" }) },
        { packId: "acme", tool: tool("acme_a", { pack: "acme.audit" }) },
        { packId: "acme", tool: tool("acme_b", { pack: "acme.audit", permission: "write", target: { kind: "command", command: "acme.b" } }) },
        { packId: "acme", tool: tool("acme_c", { pack: "acme.missing" }) },
      ],
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('share the slug "acme-doors"'),
        expect.stringContaining('"acme_a" is in two packs'),
        expect.stringContaining("is read-only"),
        expect.stringContaining('names pack "acme.missing"'),
      ]),
    );
  });
});
