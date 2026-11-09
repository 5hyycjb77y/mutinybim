/**
 * @jest-environment node
 *
 * Round 11 L11: a round 8b branch row reads as a lineage (role `proposal`,
 * return policy `merge`, parent the base's first lineage at the base
 * revision) and its model id is unchanged. Fails on round 10's code: there is
 * no lineage reader.
 */
import { branchModelId, type BranchRef } from "@permitzip/bim-kernel";
import { lineageModelId, readBranchAsLineage, readLineage, rootLineageOf } from "../src/lineages/branch";
import { lineageChain, lineageLookup } from "../src/lineages/chain";
import { AVERY } from "./l11-fixtures";

const branch: BranchRef = Object.freeze({
  branchId: "b1",
  modelId: branchModelId("m-1", "b1"),
  baseModelId: "m-1",
  baseRevision: 12,
  name: "Option with the shaft moved",
  createdBy: "u-rao",
  createdAt: "2026-10-01T10:00:00Z",
  state: "merge_proposed",
});

describe("l11-branch-reads-as-lineage", () => {
  it("reads a branch as a proposal copy of the first lineage at its base revision", () => {
    const l = readBranchAsLineage(branch);
    expect(l).toMatchObject({ id: "b1", parent: { lineageId: "main", revision: 12 }, role: "proposal", returnPolicy: "merge", state: "open", name: branch.name, createdAt: branch.createdAt });
    expect(l.createdBy).toEqual({ provider: "unsigned", subject: "u-rao", kind: "person" });
    expect(lineageModelId("m-1", l)).toBe(branch.modelId);
  });

  it("reads merged and closed branches as closed (merged is an event, not a state) and an unknown state as closed", () => {
    expect(readBranchAsLineage({ ...branch, state: "merged" }).state).toBe("closed");
    expect(readBranchAsLineage({ ...branch, state: "closed" }).state).toBe("closed");
    expect(readBranchAsLineage({ ...branch, state: "frozen-by-a-newer-host" as BranchRef["state"] }).state).toBe("closed");
  });

  it("chains a branch to its base's first lineage", () => {
    const root = rootLineageOf({ name: "Design", createdBy: AVERY, createdAt: "2026-09-01T00:00:00Z" });
    const chain = lineageChain(lineageLookup([root, readBranchAsLineage(branch)]), "b1");
    expect(chain.map((c) => [c.lineage.id, c.pinnedAt])).toEqual([
      ["b1", null],
      ["main", 12],
    ]);
    expect(lineageModelId("m-1", root)).toBe("m-1");
  });

  it("reads stored lineage rows tolerantly: unknown roles and states kept, an unknown return policy never widens", () => {
    const read = readLineage({ id: "c1", parent: { lineage_id: "main", revision: 3 }, role: "acme.tenant_fitout", return_policy: "teleport", state: "archived", name: "Tenant", created_by: AVERY, created_at: "2026-11-02T00:00:00Z" });
    expect(read.ok && read.value).toMatchObject({ role: "acme.tenant_fitout", state: "archived", returnPolicy: "never", parent: { lineageId: "main", revision: 3 } });
    expect(readLineage({ id: "c1" }).ok).toBe(false);
  });
});
