/**
 * @jest-environment node
 *
 * Round 11 W11 (product decision answer 2: anyone who can read a copy may copy it; the
 * chain has any depth, no special cases). The GC starts a coordination copy
 * of the design; Sam, a reader, copies that copy to propose a change and
 * edits only their proposal: not the coordination copy, not the design. The
 * proposal's parent is the coordination copy, and its accept back targets it
 * (or the design) only by someone who edits that target.
 *
 * Fails on round 10's code: a copy could only start from Main ("Branches
 * start from Main", then a refusal until a registry recorded a parent), and
 * every copy was edited by whoever edits Main.
 */
import { LINEAGE_RIGHTS_WORDS } from "../src/lineages";
import { admit, BASE, editTerminal, expectLineage, gc, sam, startCopies } from "./support/w11-copies";

describe("w11-copy-of-copy-rights", () => {
  it("a reader copies a copy and edits only that, three deep", async () => {
    const env = await startCopies();
    const gcOnDesign = await admit(env, gc, BASE);
    const coordination = expectLineage(await gcOnDesign.ask({ type: "lineage_create", name: "Level 3 coordination", role: "coordination" }), "lineage_saved").lineage;
    const coordinationId = `${BASE}~${coordination.id}`;
    const gcOnCoordination = await admit(env, gc, coordinationId);
    expect(await editTerminal(gcOnCoordination, 350)).toEqual({ status: "committed" });

    // Sam reads the coordination copy (it inherits the design's readers) and copies it.
    const samOnCoordination = await admit(env, sam, coordinationId);
    expect(samOnCoordination.principal.canWrite).toBe(false);
    const proposal = expectLineage(await samOnCoordination.ask({ type: "lineage_create", name: "Acme reroute", role: "proposal" }), "lineage_saved").lineage;
    const coordinationHead = (await (await env.host.line(coordination.id)).head()).revision;
    expect(proposal.parent).toEqual({ lineageId: coordination.id, revision: coordinationHead });

    const proposalId = `${BASE}~${proposal.id}`;
    const samOnProposal = await admit(env, sam, proposalId);
    expect(samOnProposal.principal.canWrite).toBe(true);
    expect(await editTerminal(samOnProposal, 360)).toEqual({ status: "committed" });
    // The proposal sees the coordination copy's change under it (copy on write down the chain).
    expect((await (await env.host.open(proposalId))?.store.head())?.elements["sd-1"]).toMatchObject({ kind: "terminal" });

    // Not the copy above it, not the design.
    expect(await editTerminal(samOnCoordination, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEdit });
    const samOnDesign = await admit(env, sam, BASE);
    expect(await editTerminal(samOnDesign, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEditOnAncestor });

    // Rights at each depth come from the same rule.
    expect([...(samOnProposal.principal.lineage?.rights.entries() ?? [])].map(([id, caps]) => [id, [...caps].sort()])).toEqual([
      ["main", ["propose", "read"]],
      [coordination.id, ["propose", "read"]],
      [proposal.id, ["edit", "propose", "read"]],
    ]);

    // Listed to readers of the chain; the GC (a reader of the coordination copy they made) sees it too.
    const listed = expectLineage(await gcOnCoordination.ask({ type: "lineage_list" }), "lineages").lineages.map((l) => l.id);
    expect(listed).toEqual(["main", coordination.id, proposal.id]);
  });
});
