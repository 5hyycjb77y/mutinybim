/**
 * @jest-environment node
 *
 * A single-machine host saves `snapshot()` and starts again from it: Main's
 * history, its branches (with their own edits), saved versions and answered
 * save keys all come back. Fails on the code before snapshots: a restarted
 * host had only Main's head, no branches, no versions and no history.
 */
import { canonicalJson } from "@permitzip/bim-kernel";
import { InMemoryBranchHost } from "../src";
import { FT, attach, avery, expectAnswer, settle, startHost } from "./support/b8-branch-host";

/** What the hosted app writes to disk and reads back. */
function throughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("in-memory host snapshot", () => {
  it("brings back Main's history, branches with their edits, and saved versions", async () => {
    const host = await startHost();
    let changes = 0;
    host.onChange(() => (changes += 1));
    const onMain = attach(host.main.hub, avery, "main", { modelId: "site-1" });
    await settle();
    onMain.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 500 });
    await settle();
    const v1 = await host.main.store.head();
    expectAnswer(await onMain.client.request({ type: "version_save", name: "Issued for review" }), "version_saved");
    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "Option B" }), "branch_saved");
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const onBranch = attach(served.hub, avery, "branch", { modelId: created.branch.modelId });
    await settle();
    onBranch.client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    await settle();
    onMain.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 420 });
    await settle();
    expect([...onMain.outcomes, ...onBranch.outcomes].map((o) => o.status)).toEqual(["committed", "committed", "committed"]);
    expect(changes).toBeGreaterThanOrEqual(5);

    const saved = throughJson(await host.snapshot());
    const mainHead = await host.main.store.head();
    const branchHead = await served.store.head();

    const again = await InMemoryBranchHost.start(mainHead, {}, null, {}, saved);
    expect(canonicalJson(await again.main.store.head())).toBe(canonicalJson(mainHead));
    expect((await again.main.store.changesSince(0)).map((c) => c.revision)).toEqual([v1.revision, mainHead.revision]);
    expect((await again.registry.versions("site-1")).map((v) => [v.name, v.revision])).toEqual([["Issued for review", v1.revision]]);
    expect((await again.registry.list("site-1")).map((b) => b.name)).toEqual(["Option B"]);
    expect(again.registry.pinnedRevisions("site-1")).toEqual([v1.revision, v1.revision]);

    const reopened = await again.open(created.branch.modelId);
    if (!reopened) throw new Error("branch not served after the restart");
    expect(canonicalJson(await reopened.store.head())).toBe(canonicalJson(branchHead));

    // A second save after the restart still holds the branch's own edit (it is in the copy's log, not only replayed).
    const savedTwice = throughJson(await again.snapshot());
    expect(savedTwice.copies[created.branch.modelId]?.length).toBe(1);

    // A resend of a key answered before the restart gets the same answer, not a second edit.
    const first = (await host.main.store.changesSince(0))[0];
    if (!first) throw new Error("no history");
    const replay = await again.main.sequencer.submit({ idempotencyKey: first.idempotencyKey, baseRevision: first.baseRevision, actor: avery, command: first.command });
    expect(replay).toMatchObject({ status: "committed", revision: first.revision });
    expect((await again.main.store.head()).revision).toBe(mainHead.revision);
  });
});
