/**
 * @jest-environment node
 *
 * Round 8b lane B: mixed versions. A client that asks for a branch from a
 * server that doesn't serve branches (it answers with Main) shows nothing and
 * says "No such model", never Main's data under the branch's name. A server
 * without branches answers branch requests plainly and doesn't advertise
 * them, so no branch picker appears. Fails on round 8's code: the client
 * showed whatever model the welcome carried.
 */
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { BRANCHES_UNAVAILABLE, InMemoryCommitStore, NO_SUCH_MODEL, Sequencer, SyncHub } from "../src";
import { attach, expectAnswer, avery, settle } from "./support/b8-branch-host";

async function oldStyleHub(): Promise<SyncHub> {
  return new SyncHub(await Sequencer.start(new InMemoryCommitStore(createDemoModel("site-1"))));
}

describe("b8-mixed-version", () => {
  it("asked for a branch, answered with Main: nothing shown, plain refusal", async () => {
    const hub = await oldStyleHub();
    const asked = attach(hub, avery, "asks-for-branch", { modelId: "site-1~abc123" });
    await settle();
    expect(asked.client.confirmedModel()).toBeNull();
    expect(asked.client.view()).toBeNull();
    expect(asked.denied).toEqual([NO_SUCH_MODEL]);
    expect(asked.client.branch()).toBeNull();
  });

  it("a server without branches: no picker (not advertised) and a plain answer to a branch request", async () => {
    const hub = await oldStyleHub();
    const person = attach(hub, avery, "on-main", { modelId: "site-1" });
    await settle();
    expect(person.client.confirmedModel()?.modelId).toBe("site-1");
    expect(person.client.branchesAvailable()).toBe(false);
    expect(expectAnswer(await person.client.request({ type: "branch_list" }), "request_refused").reason).toBe(BRANCHES_UNAVAILABLE);
  });
});
