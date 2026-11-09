/**
 * @jest-environment node
 *
 * A Load summary block re-renders when a space estimate counted at its service
 * changes (e2-electrical's patch to blocks/render.ts). The block's freshness hash
 * was already right, but the sheet scene only re-renders a block when something
 * in `dependsOn` changes, and before this change `distributionDeps` listed the
 * distribution tree's parts and links only, never the loads it serves: so
 * `blockAffectedBy(rendered, ["est-rec"])` was false and the sheet kept printing
 * the old kVA until something else moved.
 */
import { LOAD_SUMMARY_TEMPLATE, LOAD_SUMMARY_TITLE, blockAffectedBy, renderFieldBlock, type Command } from "../src";
import { referenceBuilding } from "./fixtures/electrical-building";

describe("Load summary dependencies", () => {
  it("lists the estimates its service counts and their space, so editing the estimate re-renders the block", () => {
    const b = referenceBuilding();
    b.ok({ type: "create_space", spaces: [{ spaceId: "sp-dining", number: "101", name: "Dining" }] });
    b.ok({ type: "save_connection_type", entry: { designator: "E-REC", loadClass: "receptacle", description: "Receptacles" } } as Command);
    b.ok({ type: "create_load", loads: [{ id: "est-rec", anchor: { kind: "space", id: "sp-dining" }, connectionType: "E-REC", values: { va: 2000 }, servedBy: "mdp", source: { kind: "engineer", ref: "SD receptacle allowance" } }] } as Command);
    const block = { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE };
    const rendered = renderFieldBlock(b.head, block);
    expect(rendered.dependsOn).toEqual(expect.arrayContaining(["mdp", "est-rec", "sp-dining"]));
    const cs = b.ok({ type: "edit_load_point", loadId: "est-rec", values: { va: 3000 } } as Command);
    expect(blockAffectedBy(rendered, ["est-rec"])).toBe(true);
    expect(blockAffectedBy(rendered, cs.elements.map((e) => e.id))).toBe(true);
  });
});
