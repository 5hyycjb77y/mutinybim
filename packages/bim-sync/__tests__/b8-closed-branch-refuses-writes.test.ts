/**
 * @jest-environment node
 *
 * Round 8b lane B: once a branch is closed or merged, every edit on it is
 * refused with words that say what to do, and nothing is written. Fails on
 * round 8's code: there was no branch state and no write gate.
 */
import { branchClosedMessage } from "@permitzip/bim-kernel";
import { attach, expectAnswer, jordan, avery, settle, startHost } from "./support/b8-branch-host";

describe("b8-closed-branch-refuses-writes", () => {
  it("closed from Main while someone is editing: their next edit is refused and nothing is written", async () => {
    const host = await startHost();
    const lead = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const made = expectAnswer(await lead.client.request({ type: "branch_create", name: "Try" }), "branch_saved");
    const served = await host.open(made.branch.modelId);
    if (!served) throw new Error("branch not served");
    const editor = attach(served.hub, jordan, "branch-jordan", { modelId: made.branch.modelId });
    await settle();
    editor.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 300 });
    await settle();
    expect(editor.outcomes.map((o) => o.status)).toEqual(["committed"]);
    const before = await served.store.head();

    const closed = expectAnswer(await lead.client.request({ type: "branch_close", branchId: made.branch.branchId }), "branch_saved");
    expect(closed.branch.state).toBe("closed");
    expect(host.registry.pinnedRevisions("site-1")).toEqual([]);

    editor.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 310 });
    await settle();
    const refused = editor.outcomes[1];
    expect(refused?.status).toBe("rejected");
    if (refused?.status === "rejected") expect(refused.error.message).toBe("This branch was closed. Start a new branch to keep working.");
    expect((await served.store.head()).revision).toBe(before.revision);

    // Closing twice says so plainly.
    expect(expectAnswer(await lead.client.request({ type: "branch_close", branchId: made.branch.branchId }), "request_refused").reason).toMatch(/already closed or merged/);
  });

  it("merged: refused with the merged words", async () => {
    const host = await startHost();
    const lead = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const made = expectAnswer(await lead.client.request({ type: "branch_create", name: "Merged one" }), "branch_saved");
    const served = await host.open(made.branch.modelId);
    if (!served) throw new Error("branch not served");
    const editor = attach(served.hub, avery, "branch-avery", { modelId: made.branch.modelId });
    await settle();
    host.registry.markMerged(made.branch.modelId);
    editor.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 200 });
    await settle();
    const refused = editor.outcomes[0];
    expect(refused?.status).toBe("rejected");
    if (refused?.status === "rejected") expect(refused.error.message).toBe(branchClosedMessage("merged"));
  });
});
