/**
 * @jest-environment node
 *
 * Round 8b lane B (server test that replaces the pgTAP `b8-branch-rls`):
 * a branch is reached by exactly the people who may read its base. No read:
 * no session, so no branch list. Read only: lists and compares, but can't
 * start, close or save versions. Fails on round 8's code: the host was
 * asked about the branch id itself, and branch messages did not exist.
 */
import {
  BRANCH_EDIT_REQUIRED,
  InMemoryModelMemberStore,
  NO_MODEL_ACCESS,
  NativeModelAuthorizer,
  authorizationModelId,
  authorizeConnection,
  type ModelAuthorizer,
} from "../src";
import { attach, expectAnswer, jordan, avery, settle, startHost } from "./support/b8-branch-host";

describe("b8-branch-access", () => {
  it("a branch id is authorized as its base", async () => {
    const members = new InMemoryModelMemberStore();
    members.set("site-1", avery.id, "editor");
    members.set("site-1", jordan.id, "viewer");
    const asked: string[] = [];
    const native = new NativeModelAuthorizer(members);
    const authorizer: ModelAuthorizer = {
      capabilities: (input) => {
        asked.push(input.modelId);
        return native.capabilities(input);
      },
    };
    const branch = "site-1~abc123";
    expect(authorizationModelId(branch)).toBe("site-1");

    const outsider = await authorizeConnection(authorizer, { actor: { id: "user-x", name: "X", kind: "human" }, verifiedUserId: "user-x", modelId: branch, token: "t" });
    expect(outsider).toEqual({ ok: false, reason: NO_MODEL_ACCESS });
    const viewer = await authorizeConnection(authorizer, { actor: jordan, verifiedUserId: jordan.id, modelId: branch, token: "t" });
    expect(viewer.ok && viewer.principal.canWrite).toBe(false);
    const editor = await authorizeConnection(authorizer, { actor: avery, verifiedUserId: avery.id, modelId: branch, token: "t" });
    expect(editor.ok && editor.principal.canWrite).toBe(true);
    expect(new Set(asked)).toEqual(new Set(["site-1"]));
  });

  it("read-only lists and compares, but can't start, close or save versions; nobody unsigned gets anything", async () => {
    const host = await startHost();
    const editor = attach(host.main.hub, avery, "editor", { modelId: "site-1" });
    const viewer = attach(host.main.hub, jordan, "viewer", { canWrite: false, modelId: "site-1" });
    await settle();
    const made = expectAnswer(await editor.client.request({ type: "branch_create", name: "Option A" }), "branch_saved");

    const listed = expectAnswer(await viewer.client.request({ type: "branch_list" }), "branches");
    expect(listed.branches.map((b) => b.name)).toEqual(["Option A"]);
    expect(expectAnswer(await viewer.client.request({ type: "branch_create", name: "Mine" }), "request_refused").reason).toBe(BRANCH_EDIT_REQUIRED);
    expect(expectAnswer(await viewer.client.request({ type: "branch_close", branchId: made.branch.branchId }), "request_refused").reason).toBe(BRANCH_EDIT_REQUIRED);
    expect(expectAnswer(await viewer.client.request({ type: "version_save", name: "Mine" }), "request_refused").reason).toMatch(/not save versions/);
    expect((await host.registry.get(made.branch.modelId))?.state).toBe("open");

    // A connection the host never admitted (no sign-in) is refused before any branch is read.
    const replies: string[] = [];
    await host.main.hub.handle({ id: "stranger", send: (d) => replies.push(d) }, JSON.stringify({ type: "branch_list", requestId: "r1" }));
    expect(replies.map((r) => JSON.parse(r).type)).toEqual(["denied"]);
  });

  it("a branch that does not exist is not served", async () => {
    const host = await startHost();
    expect(await host.open("site-1~nope")).toBeNull();
    expect(await host.open("site-2~nope")).toBeNull();
  });
});
