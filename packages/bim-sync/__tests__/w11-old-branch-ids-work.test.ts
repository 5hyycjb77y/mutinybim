/**
 * @jest-environment node
 *
 * Round 11 W11 (D1 "Replaces"): today's branches keep working as one kind of
 * copy. A branch made the round 8b way (`branch_create`, a `<base>~<id>`
 * model id, no copy row of its own) reads as a proposal copy, is edited by
 * whoever edits the design (as before), read by the design's readers, and
 * listed to every page as a branch; a branch on a branch session is a copy of
 * that copy edited the same way.
 *
 * Fails on round 10's code: copies had no rights of their own to keep this
 * rule against (the host had no per-copy admission), and a branch on a branch
 * session was refused.
 */
import { LINEAGE_RIGHTS_WORDS } from "../src/lineages";
import { admit, BASE, editTerminal, expectLineage, avery, sam, startCopies } from "./support/w11-copies";

describe("w11-old-branch-ids-work", () => {
  it("a round 8b branch keeps its id, its readers and its editors", async () => {
    const env = await startCopies();
    const averyOnDesign = await admit(env, avery, BASE);
    const made = await averyOnDesign.client.request({ type: "branch_create", name: "Option A" });
    if (made.type !== "branch_saved") throw new Error(made.type);
    expect(made.branch.modelId).toBe(`${BASE}~${made.branch.branchId}`);

    // Edited by the design's editors, read by its readers.
    const averyOn = await admit(env, avery, made.branch.modelId);
    expect(await editTerminal(averyOn, 333)).toEqual({ status: "committed" });
    const samOn = await admit(env, sam, made.branch.modelId);
    expect(await editTerminal(samOn, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEdit });

    // Read as a proposal copy, and still listed as a branch.
    const listed = expectLineage(await averyOn.ask({ type: "lineage_list" }), "lineages").lineages.find((l) => l.id === made.branch.branchId);
    expect(listed).toMatchObject({ role: "proposal", returnPolicy: "merge", parent: { lineageId: "main", revision: made.branch.baseRevision } });
    const branches = await samOn.client.request({ type: "branch_list" });
    expect(branches.type === "branches" ? branches.branches.map((b) => b.modelId) : []).toEqual([made.branch.modelId]);

    // A branch on the branch session: a copy of that copy, edited by the branch's editors.
    const child = await averyOn.client.request({ type: "branch_create", name: "Option A, variant" });
    if (child.type !== "branch_saved") throw new Error(child.type === "request_refused" ? child.reason : child.type);
    const childRow = await env.host.registry.rowOf(child.branch.modelId);
    expect(childRow?.lineage.parent).toEqual({ lineageId: made.branch.branchId, revision: made.branch.baseRevision + 1 });
    const averyOnChild = await admit(env, avery, child.branch.modelId);
    expect(await editTerminal(averyOnChild, 334)).toEqual({ status: "committed" });

    // Closing it needs edit on it.
    const refused = await samOn.client.request({ type: "branch_close", branchId: made.branch.branchId });
    expect(refused).toMatchObject({ type: "request_refused", reason: LINEAGE_RIGHTS_WORDS.noEdit });
    const closed = await averyOnDesign.client.request({ type: "branch_close", branchId: made.branch.branchId });
    expect(closed).toMatchObject({ type: "branch_saved", branch: { state: "closed" } });
  });
});
