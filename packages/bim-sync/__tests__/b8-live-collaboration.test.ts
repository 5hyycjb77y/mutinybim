/**
 * @jest-environment node
 *
 * Round 8b lane B: two people and an agent edit one branch live, each sees
 * the others' edits, and Main does not change. A branch from an older
 * version opens at that version. Fails on round 8's code: no branch messages,
 * no branch sessions (InMemoryBranchHost, `branch_create`) exist.
 */
import { canonicalJson } from "@permitzip/bim-kernel";
import { agentActor } from "../src";
import { FT, attach, expectAnswer, jordan, avery, settle, startHost } from "./support/b8-branch-host";

describe("b8-live-collaboration", () => {
  it("two sessions and an agent edit one branch, see each other live, and Main is unchanged", async () => {
    const host = await startHost();
    const onMain = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    expect(onMain.client.branchesAvailable()).toBe(true);
    const mainBefore = await host.main.store.head();

    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "Lobby option B" }), "branch_saved");
    expect(created.branch).toMatchObject({ name: "Lobby option B", baseModelId: "site-1", baseRevision: mainBefore.revision, state: "open", createdBy: avery.id });
    expect(created.branch.modelId).toBe(`site-1~${created.branch.branchId}`);

    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const a = attach(served.hub, avery, "branch-avery", { modelId: created.branch.modelId });
    const b = attach(served.hub, jordan, "branch-jordan", { modelId: created.branch.modelId });
    const agent = attach(served.hub, agentActor(avery.id, "run-1", "Host agent"), "branch-agent", { modelId: created.branch.modelId });
    await settle();
    expect(a.client.branch()?.name).toBe("Lobby option B");
    expect(agent.client.branch()?.modelId).toBe(created.branch.modelId);

    const base = a.client.confirmedModel();
    if (!base) throw new Error("not connected");
    a.client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    await settle();
    agent.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 420 });
    await settle();
    b.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 380 });
    await settle();

    expect([...a.outcomes, ...b.outcomes, ...agent.outcomes].map((o) => o.status)).toEqual(["committed", "committed", "committed"]);
    const branchHead = await served.store.head();
    expect(branchHead.revision).toBe(mainBefore.revision + 3);
    for (const viewer of [a, b, agent]) {
      const seen = viewer.client.confirmedModel();
      expect(seen?.revision).toBe(branchHead.revision);
      expect(canonicalJson(seen?.elements["sd-1"])).toBe(canonicalJson(branchHead.elements["sd-1"]));
      expect(canonicalJson(seen?.elements["sd-2"])).toBe(canonicalJson(branchHead.elements["sd-2"]));
      expect(canonicalJson(seen?.elements["tap-1"])).toBe(canonicalJson(branchHead.elements["tap-1"]));
    }

    const mainAfter = await host.main.store.head();
    expect(mainAfter.revision).toBe(mainBefore.revision);
    expect(canonicalJson(mainAfter.elements)).toBe(canonicalJson(mainBefore.elements));
    expect(onMain.client.confirmedModel()?.revision).toBe(mainBefore.revision);
  });

  it("a branch from an older version opens at that version, without Main's later edits", async () => {
    const host = await startHost();
    const person = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const v0 = await host.main.store.head();
    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 500 });
    await settle();
    expect((await host.main.store.head()).revision).toBe(v0.revision + 1);

    const created = expectAnswer(await person.client.request({ type: "branch_create", name: "From v0", fromRevision: v0.revision }), "branch_saved");
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const opened = await served.store.head();
    expect(opened.revision).toBe(v0.revision);
    expect(opened.modelId).toBe(created.branch.modelId);
    expect(canonicalJson(opened.elements)).toBe(canonicalJson(v0.elements));
    // Elements Main's later edit didn't touch are the same objects (copy on write).
    expect(opened.elements["tap-1"]).toBe((await host.main.store.head()).elements["tap-1"]);
    expect(host.registry.pinnedRevisions("site-1")).toEqual([v0.revision]);
  });

  it("compares with Main: state at a Main revision and the ids changed on either side", async () => {
    const host = await startHost();
    const person = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const created = expectAnswer(await person.client.request({ type: "branch_create", name: "Compare" }), "branch_saved");
    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 610 });
    await settle();
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const onBranch = attach(served.hub, avery, "branch-avery", { modelId: created.branch.modelId });
    await settle();
    onBranch.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 222 });
    await settle();

    const mainHead = await host.main.store.head();
    const changed = expectAnswer(await onBranch.client.request({ type: "changed_between", from: { model: "main", revision: mainHead.revision }, to: "head" }), "changed_between_result");
    expect(changed.ids).toEqual(expect.arrayContaining(["sd-1", "sd-2"]));
    const mainSd1 = expectAnswer(await onBranch.client.request({ type: "state_at", model: "main", revision: mainHead.revision, ids: ["sd-1"] }), "state_at_result");
    expect(canonicalJson(mainSd1.elements["sd-1"])).toBe(canonicalJson(mainHead.elements["sd-1"]));
    // A branch session learns Main's head without knowing its number.
    const atMainHead = expectAnswer(await onBranch.client.request({ type: "state_at", model: "main", revision: "head", ids: ["sd-1"] }), "state_at_result");
    expect(atMainHead.revision).toBe(mainHead.revision);
    const sameIds = expectAnswer(await onBranch.client.request({ type: "changed_between", from: { model: "main", revision: "head" }, to: "head" }), "changed_between_result");
    expect(sameIds.ids).toEqual(changed.ids);
  });
});
