/**
 * @jest-environment node
 *
 * Round 9 lane B9, sync side.
 *
 * - b9-branch-state-quiet: closing a branch tells every page on it once, in
 *   place (`branch_state`): no second welcome, no denial, no reconnect; the
 *   page's branch reads closed and its next edit is refused in the branch's
 *   words. A page without the feature gets nothing new and is refused on
 *   its next edit as before.
 * - b9-server-coverage: `coverage_check` reads what changed and its records
 *   from the server's own history; a responsibility covers only what the
 *   model says it covers, whatever records a page would have sent.
 *
 * Fails on round 8b: no `branch_state`, no `coverage_check`.
 */
import { partitionOf, type Actor, type BranchRef, type Responsibility } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { BRANCHES_STATE_BROADCAST_FEATURE, HISTORY_COVERAGE_READ_FEATURE, SyncClient, type CommitOutcome, type SyncHub } from "../src";
import { expectAnswer, jordan, avery, settle, startHost } from "./support/b8-branch-host";

function page(hub: SyncHub, actor: Actor, id: string, modelId: string, opts: { oldPage?: boolean } = {}) {
  const received: string[] = [];
  const states: BranchRef[] = [];
  const outcomes: CommitOutcome[] = [];
  const denied: string[] = [];
  const statuses: string[] = [];
  const conn = {
    id,
    send: (data: string) => {
      const msg: unknown = JSON.parse(data);
      if (typeof msg === "object" && msg !== null && "type" in msg && typeof msg.type === "string") received.push(msg.type);
      client.receive(data);
    },
  };
  const toServer = (data: string) => {
    if (!opts.oldPage) return data;
    const msg: unknown = JSON.parse(data);
    if (typeof msg !== "object" || msg === null || !("type" in msg) || msg.type !== "hello" || !("protocol" in msg)) return data;
    const hello = Object.fromEntries(Object.entries(msg));
    const protocol = hello.protocol as { version: number; features: string[] };
    return JSON.stringify({ ...hello, protocol: { ...protocol, features: protocol.features.filter((f) => f !== BRANCHES_STATE_BROADCAST_FEATURE) } });
  };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, toServer(data)), close: () => hub.leave(conn) },
    actor,
    { onOutcome: (_r, o) => outcomes.push(o), onDenied: (r) => denied.push(r), onBranchState: (b) => states.push(b), onStatus: (st) => statuses.push(st) },
    60_000,
    { clientSessionId: `${id}-session`, meter: null, modelId },
  );
  hub.join(conn, { actorId: actor.id, canWrite: true });
  client.opened();
  return { client, received, states, outcomes, denied, statuses };
}

describe("b9 branch state broadcast", () => {
  it("b9-branch-state-quiet: one branch_state per page that reads it, nothing reconnects, the next edit is refused in words", async () => {
    const host = await startHost();
    const lead = page(host.main.hub, avery, "main-avery", "site-1");
    await settle();
    const made = expectAnswer(await lead.client.request({ type: "branch_create", name: "Lobby B" }), "branch_saved");
    const served = await host.open(made.branch.modelId);
    if (!served) throw new Error("branch not served");
    expect(served.hub.protocol.features).toContain(BRANCHES_STATE_BROADCAST_FEATURE);
    const reader = page(served.hub, jordan, "branch-jordan", made.branch.modelId);
    const older = page(served.hub, avery, "branch-avery-old", made.branch.modelId, { oldPage: true });
    await settle();
    expect(reader.client.branch()?.state).toBe("open");

    // Closed from Main (another session, as another machine would through its runtime).
    expectAnswer(await lead.client.request({ type: "branch_close", branchId: made.branch.branchId }), "branch_saved");
    await settle();

    expect(reader.states.map((b) => b.state)).toEqual(["closed"]);
    expect(reader.client.branch()?.state).toBe("closed");
    expect(reader.received.filter((t) => t === "welcome")).toHaveLength(1);
    expect(reader.received.filter((t) => t === "branch_state")).toHaveLength(1);
    expect(reader.denied).toEqual([]);
    expect(reader.statuses).not.toContain("denied");
    expect(reader.statuses.filter((st) => st === "connecting")).toHaveLength(0);
    expect(older.received).not.toContain("branch_state");

    reader.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 310 });
    older.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 210 });
    await settle();
    for (const p of [reader, older]) {
      const refused = p.outcomes[0];
      expect(refused?.status).toBe("rejected");
      if (refused?.status === "rejected") expect(refused.error.message).toBe("This branch was closed. Start a new branch to keep working.");
    }

    // Closing it again is refused and tells no one again.
    expectAnswer(await lead.client.request({ type: "branch_close", branchId: made.branch.branchId }), "request_refused");
    await settle();
    expect(reader.states.map((b) => b.state)).toEqual(["closed"]);
  });
});

describe("b9 server coverage", () => {
  it("b9-server-coverage: coverage is the server's, from its own records; a level scope that doesn't hold the change covers nothing", async () => {
    const host = await startHost(createDemoModel("site-1"));
    expect(host.main.hub.protocol.features).toContain(HISTORY_COVERAGE_READ_FEATURE);
    const lead = page(host.main.hub, avery, "main-avery", "site-1");
    await settle();
    lead.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 330 });
    await settle();
    expect(lead.outcomes.map((o) => o.status)).toEqual(["committed"]);
    const head = lead.client.confirmedModel()?.revision ?? 0;
    const sd1 = lead.client.confirmedModel()?.elements["sd-1"];
    if (!sd1) throw new Error("sd-1");
    const discipline = partitionOf(sd1).discipline;
    const row = (id: string, scope: Responsibility["scope"]): Responsibility => ({ id, party: { kind: "person", ref: avery.id, label: "Avery" }, discipline, ...(scope ? { scope } : {}), acceptedAt: "2026-11-01T12:00:00Z" });
    // A page could send sd-1 with `partition.level: "Level 9"` to fall inside this scope; the server reads the real record.
    const levelNine = row("r-level-9", { levels: ["Level 9"] });
    // The whole discipline: the server's record (no level of its own) falls to it.
    const realLevel = row("r-real", undefined);
    const ask = (responsibilities: readonly Responsibility[]) =>
      lead.client.request({ type: "coverage_check", target: { kind: "version_range", fromRevision: 0, toRevision: head }, personRef: avery.id, responsibilities: responsibilities.map((r) => ({ id: r.id, party: { ...r.party }, discipline: r.discipline, ...(r.acceptedAt ? { acceptedAt: r.acceptedAt } : {}), ...(r.scope ? { scope: { levels: [...(r.scope.levels ?? [])] } } : {}) })) });

    const narrow = expectAnswer(await ask([levelNine]), "coverage_result");
    expect(narrow.changed).toBeGreaterThan(0);
    expect(narrow.classifying).toEqual([]);
    const right = expectAnswer(await ask([levelNine, realLevel]), "coverage_result");
    expect(right.classifying).toEqual(["r-real"]);
    // Someone else's row never lets this person classify.
    const theirs = expectAnswer(await ask([{ ...realLevel, id: "r-theirs", party: { kind: "person", ref: jordan.id, label: "Jordan" } }]), "coverage_result");
    expect(theirs.classifying).toEqual([]);
    // Backwards ranges are refused in words; a branch target on Main is refused.
    expect(expectAnswer(await lead.client.request({ type: "coverage_check", target: { kind: "version_range", fromRevision: head, toRevision: 0 }, personRef: avery.id, responsibilities: [] }), "request_refused").reason).toBe("The later version has to come after the earlier one.");
    expect(expectAnswer(await lead.client.request({ type: "coverage_check", target: { kind: "branch", mainRevision: "head" }, personRef: avery.id, responsibilities: [] }), "request_refused").reason).toMatch(/on Main/);
  });
});
