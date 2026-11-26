import { agentBranchSchema, readAgentBranchAction } from "../src/coordination/branch-input";
import { noBranchActions } from "../src/coordination/local";

describe("agent branch checkout input & local fallback", () => {
  it("parses branch.checkout for an existing branch or main", () => {
    const parsed = agentBranchSchema.parse({ checkout: "Moke HVAC fixes" });
    expect(readAgentBranchAction(parsed)).toEqual({ kind: "checkout", target: "Moke HVAC fixes" });

    const mainParsed = agentBranchSchema.parse({ checkout: "main" });
    expect(readAgentBranchAction(mainParsed)).toEqual({ kind: "checkout", target: "main" });
  });

  it("rejects combining branch.checkout with branch.start or branch.propose_merge", () => {
    expect(readAgentBranchAction({ start: "a", checkout: "b" })).toMatch(/only one/i);
    expect(readAgentBranchAction({ checkout: "b", propose_merge: true })).toMatch(/only one/i);
    expect(readAgentBranchAction({ checkout: "b", from_version: 5 })).toMatch(/from_version goes with branch\.start/i);
  });

  it("refuses checkout cleanly on the local server", async () => {
    const actions = await noBranchActions({} as never, "proj-1");
    const res = await actions.checkout({ session: {} as never, target: "Moke HVAC" });
    expect(res.status).toBe("refused");
  });
});
