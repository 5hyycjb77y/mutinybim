/**
 * @jest-environment node
 *
 * Group commit: edits are shown to other people before their batch is
 * durable, so killing the authority mid-batch must still leave every client
 * on the durable model with every edit applied exactly once. The drill itself
 * is in support/kill-drill.ts; scripts/perf/mutinybim/kill-drill.ts runs it at
 * 25 and 50 editors.
 */
import { type Actor } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { DurableLog, GroupCommitMemoryStore, Sequencer, SyncHub, type HubConnection } from "../src";
import { runKillDrill } from "./support/kill-drill";

const FT = 304.8;

describe("group commit", () => {
  it("killing the authority mid-batch leaves no divergence and applies every edit exactly once", async () => {
    const report = await runKillDrill({ editors: 8, kills: 3, rate: 20, phaseMs: 250, writeDelayMs: 8, seed: 7 });
    expect(report.killsWithUndurableShown).toBeGreaterThan(0); // the drill really killed with edits shown and not yet durable
    expect(report.maxShownButLost).toBeGreaterThan(0);
    expect(report.unsettledClients).toBe(0);
    expect(report.divergentClients).toBe(0);
    expect(report.exactlyOnceViolations).toBe(0);
    expect(report.duplicateKeysInLog).toBe(0);
    expect(report.durableWrites).toBeLessThan(report.committed); // batched: fewer writes than commits
  }, 30_000);

  it("a backlog of unanswered edits at every kill still settles, decided in memory, exactly once", async () => {
    // Before 2026-10-23 a backlog based older than the kept history fell back to one serial write per edit
    // (and the drill's headless clients re-ran every prediction per incoming change): it never settled.
    const report = await runKillDrill({ editors: 8, kills: 2, rate: 10, phaseMs: 250, writeDelayMs: 5, seed: 11, backlog: 60, settleMs: 15_000 });
    expect(report.unsettledClients).toBe(0);
    expect(report.fallbacks).toBe(0);
    expect(report.divergentClients).toBe(0);
    expect(report.exactlyOnceViolations).toBe(0);
    expect(report.duplicateKeysInLog).toBe(0);
  }, 60_000);

  it("decides a command on a head older than the kept history in memory, even when more than that commits while its history is read", async () => {
    // Before 2026-10-23 the read of the missing changesets happened before the queue and was not topped
    // up: with 256+ commits decided meanwhile the command fell back to the serial path (drain, then one write).
    const log = new DurableLog(createDemoModel(), 5);
    const sequencer = await Sequencer.start(new GroupCommitMemoryStore(log));
    const head = await sequencer.head();
    const [tapA, tapB] = Object.values(head.elements).filter((el) => el.kind === "tap");
    if (!tapA || !tapB) throw new Error("demo model needs two taps");
    const busy: Actor = { id: "busy", name: "Busy", kind: "human" };
    let n = 0;
    const slide = (base: number) =>
      sequencer.submit({ idempotencyKey: `busy-${(n += 1)}-key`, baseRevision: base, actor: busy, clientSessionId: "busy-session", command: { type: "slide_branch", tapId: tapA.id, s: (3 + (n % 2) * 0.25) * FT } });
    for (let i = 0; i < 300; i++) await slide((await sequencer.head()).revision);
    const stale = sequencer.submit({
      idempotencyKey: "stale-edit-key",
      baseRevision: head.revision,
      actor: { id: "late", name: "Late", kind: "human" },
      clientSessionId: "late-session",
      command: { type: "slide_branch", tapId: tapB.id, s: tapB.kind === "tap" ? tapB.s + 0.25 * FT : 3 * FT },
    });
    // 300 more decide while the stale command's history read is out.
    const current = (await sequencer.head()).revision;
    const more = Array.from({ length: 300 }, () => slide(current));
    const outcome = await stale;
    await Promise.all(more);
    expect(outcome.status).toBe("committed");
    expect(sequencer.groupStats.fallbacks).toBe(0);
  }, 30_000);

  it("shows an edit to other people before it is durable, and tells its author only after", async () => {
    const log = new DurableLog(createDemoModel(), 30);
    const sequencer = await Sequencer.start(new GroupCommitMemoryStore(log));
    const hub = new SyncHub(sequencer);
    const received: Record<string, Array<{ type: string; at: number }>> = { author: [], peer: [] };
    const t0 = performance.now();
    const conn = (id: string): HubConnection => ({
      id,
      send: (data: string) => {
        const msg: unknown = JSON.parse(data);
        if (typeof msg === "object" && msg !== null && "type" in msg && typeof msg.type === "string") received[id]?.push({ type: msg.type, at: performance.now() - t0 });
      },
    });
    const author = conn("author");
    const peer = conn("peer");
    hub.join(author);
    hub.join(peer);
    const actor: Actor = { id: "a", name: "A", kind: "human" };
    const head = await sequencer.head();
    const tapId = Object.values(head.elements).find((el) => el.kind === "tap")?.id;
    if (!tapId) throw new Error("demo model has no tap");
    const done = hub.handle(author, JSON.stringify({ type: "command", request: { idempotencyKey: "key-0001", baseRevision: head.revision, actor, command: { type: "slide_branch", tapId, s: 3 * FT } } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(received.peer?.map((m) => m.type)).toEqual(["changeset"]); // shown at once
    expect(received.author).toEqual([]); // not "saved" yet
    expect(log.model.revision).toBe(head.revision); // and not durable yet
    await done;
    expect(received.author?.map((m) => m.type)).toEqual(["changeset", "outcome"]);
    expect(received.author?.[1]?.at ?? 0).toBeGreaterThanOrEqual(25);
    expect(log.model.revision).toBe(head.revision + 1);
  });

  it("writes what arrives during a write as one batch", async () => {
    const log = new DurableLog(createDemoModel(), 20);
    const sequencer = await Sequencer.start(new GroupCommitMemoryStore(log), { maxBatch: 64 });
    const head = await sequencer.head();
    const taps = Object.values(head.elements).filter((el) => el.kind === "tap");
    const actor: Actor = { id: "a", name: "A", kind: "human" };
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sequencer.submit({ idempotencyKey: `batch-key-${i}`, baseRevision: head.revision, actor, clientSessionId: `s${i}`, command: { type: "slide_branch", tapId: taps[i % taps.length]?.id ?? "", s: (3 + (i % 3) * 0.25) * FT } }),
      ),
    );
    expect(outcomes.every((o) => o.status === "committed" || o.status === "rejected")).toBe(true);
    expect(log.writes).toBeLessThanOrEqual(3); // first edit alone, then the rest together
    // A repeated key gets the first answer and writes nothing new.
    const again = await sequencer.submit({ idempotencyKey: "batch-key-0", baseRevision: head.revision, actor, clientSessionId: "s0", command: { type: "slide_branch", tapId: taps[0]?.id ?? "", s: 3 * FT } });
    expect(again).toEqual(outcomes[0]);
  });
});
