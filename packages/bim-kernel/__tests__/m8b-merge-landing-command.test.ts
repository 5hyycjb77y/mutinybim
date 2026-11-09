/**
 * @jest-environment node
 *
 * Round 8b coordinator: `merge_branch_part`, the one server-only command.
 * It lands a merged part only with the records the model server supplies
 * (never from the wire), and the commit decision refuses it when anyone else
 * changed what it writes on Main after the merge read Main (the race between
 * preview and landing). Fails on the lanes' code alone: no command could
 * land a part, so the merge engine had no way to write Main.
 */
import { asElementId, executeCommand, isServerOnlyCommand, planCommit, type Actor, type BimElement, type CommandRequest } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const jordan: Actor = { id: "user-jordan", name: "Jordan", kind: "human" };
const merge = { type: "merge_branch_part" as const, branchModelId: "site-1~b1", discipline: "mechanical", label: "Merge Lobby B: Mechanical" };

function withCfm(el: BimElement | undefined, cfm: number): BimElement {
  if (!el || el.kind !== "terminal") throw new Error("expected a terminal");
  return { ...el, cfm };
}

describe("m8b-merge-landing-command", () => {
  const head = createDemoModel("site-1");
  const sd1 = asElementId("sd-1");

  it("is server-only: refused without the server's records, lands exactly them with", () => {
    expect(isServerOnlyCommand(merge)).toBe(true);
    const bare = executeCommand(head, merge);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("Merge approved parts") });

    const landed = executeCommand(head, merge, { mergeLanding: { writes: [{ elementId: sd1, record: withCfm(head.elements[sd1], 999) }], add: [], remove: [] } });
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    // The record it was given, plus what derives from it (the ducts upstream recompute their airflow).
    expect(landed.changedIds[0]).toBe(sd1);
    expect(landed.model.elements[sd1]).toMatchObject({ cfm: 999 });
    expect(landed.changedIds).not.toContain(asElementId("sd-2"));
  });

  it("refuses the part when someone else changed what it writes on Main since the merge read it", () => {
    const theirs: CommandRequest = { idempotencyKey: "jordan-edit-1", baseRevision: head.revision, actor: jordan, clientSessionId: "jordan-tab", command: { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 500 } };
    const moved = planCommit(head, [], theirs);
    if (!moved.ok) throw new Error(moved.error.message);
    const landing = { mergeLanding: { writes: [{ elementId: sd1, record: withCfm(head.elements[sd1], 999) }], add: [], remove: [] } };
    const request: CommandRequest = { idempotencyKey: "merge-part-0001", baseRevision: head.revision, actor: avery, clientSessionId: "merge-apply-1", command: merge };

    const refused = planCommit(moved.model, [moved.changeset], request, undefined, [moved.changeset], landing);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: "conflict", message: expect.stringContaining("Main changed while merging: Jordan changed sd-1") });

    // The same apply's earlier part (same session) is not someone else's change.
    const ownEarlier = { ...moved.changeset, actor: avery, clientSessionId: "merge-apply-1" };
    const allowed = planCommit(moved.model, [ownEarlier], request, undefined, [ownEarlier], landing);
    expect(allowed.ok).toBe(true);

    // A part that writes something else lands beside Jordan's edit, even though both re-derive the shared trunk.
    const sd2 = asElementId("sd-2");
    const elsewhere = planCommit(moved.model, [moved.changeset], request, undefined, [moved.changeset], { mergeLanding: { writes: [{ elementId: sd2, record: withCfm(head.elements[sd2], 300) }], add: [], remove: [] } });
    expect(elsewhere.ok).toBe(true);
  });
});
