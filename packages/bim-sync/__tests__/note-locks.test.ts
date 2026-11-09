/**
 * @jest-environment node
 *
 * Note edit soft locks over real hub presence: when Avery opens a note, Casey
 * sees "Avery is editing this note" and can't start editing it; the lock
 * lapses when Avery finishes, disconnects, or goes quiet past its TTL. An edit
 * that slips past a lock (an agent) is still refused by the kernel, never
 * silently merged over Avery's words.
 */
import { commandSchema, noteContentFingerprint, type Actor, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import {
  InMemoryCommitStore,
  NOTE_LOCK_TTL_MS,
  PresenceClock,
  Sequencer,
  SyncClient,
  SyncHub,
  editingNoteActivity,
  lockMessage,
  noteLocks,
  type CommitOutcome,
  type Presence,
} from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
const casey: Actor = { id: "user-casey", name: "Casey", kind: "human" };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function attach(hub: SyncHub, actor: Actor, id: string) {
  const people = new Map<string, Presence>();
  const outcomes: CommitOutcome[] = [];
  const conn = { id, send: (data: string) => client.receive(data) };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
    actor,
    {
      onOutcome: (_req, outcome) => outcomes.push(outcome),
      onPresence: (connectionId, presence) => {
        if (presence) people.set(connectionId, presence);
        else people.delete(connectionId);
      },
    },
    60_000,
  );
  hub.join(conn, { actorId: actor.id, canWrite: true });
  client.opened();
  return { client, people, outcomes, conn };
}

async function hubWithNote() {
  let model: ModelState = createDemoModel();
  const store = new InMemoryCommitStore(model);
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer, {});
  const k = attach(hub, avery, "conn-avery");
  const c = attach(hub, casey, "conn-casey");
  await settle();
  k.client.submit(commandSchema.parse({ type: "create_sheet", sheetId: "s-1", number: "M-001", name: "Notes" }));
  await settle();
  k.client.submit(commandSchema.parse({ type: "create_text_note", itemId: "n-1", ownerId: "s-1", at: { x: 40, y: 40 }, width: 60, paragraphs: [{ runs: [{ text: "DRAFT" }] }] }));
  await settle();
  model = k.client.confirmedModel() ?? model;
  return { hub, k, c, model };
}

describe("note edit locks", () => {
  it("shows the editor's name to others, and lapses when they finish or disconnect", async () => {
    const { hub, k, c } = await hubWithNote();
    const clock = new PresenceClock();
    k.client.publishPresence(editingNoteActivity("n-1", "s-1"));
    await settle();
    const t0 = 1_000_000;
    let locks = noteLocks(clock.update(c.people, t0), t0);
    expect(locks.get("n-1")?.actor.name).toBe("Avery");
    expect(lockMessage(locks.get("n-1") ?? { actor: avery })).toBe("Avery is editing this note");
    // Avery's own connection never hears its own presence, so he isn't locked out.
    expect(noteLocks(new PresenceClock().update(k.people, t0), t0).size).toBe(0);

    k.client.publishPresence({ kind: "idle" });
    await settle();
    locks = noteLocks(clock.update(c.people, t0 + 10), t0 + 10);
    expect(locks.size).toBe(0);

    k.client.publishPresence(editingNoteActivity("n-1", "s-1"));
    await settle();
    expect(noteLocks(clock.update(c.people, t0 + 20), t0 + 20).size).toBe(1);
    hub.leave(k.conn);
    await settle();
    expect(noteLocks(clock.update(c.people, t0 + 30), t0 + 30).size).toBe(0);
  });

  it("the same person in another tab sees the lock, worded as their own", async () => {
    const { hub, k } = await hubWithNote();
    const otherTab = attach(hub, avery, "conn-avery-tab-2");
    await settle();
    k.client.publishPresence(editingNoteActivity("n-1", "s-1"));
    await settle();
    const lock = noteLocks(new PresenceClock().update(otherTab.people, 1), 1).get("n-1");
    expect(lock && lockMessage(lock, avery.id)).toBe("You're editing this note in another tab or window");
  });

  it("expires on the receiver's clock when the editor goes quiet, and a refresh keeps it", async () => {
    const { k, c } = await hubWithNote();
    const clock = new PresenceClock();
    k.client.publishPresence(editingNoteActivity("n-1", "s-1"));
    await settle();
    const t0 = 5_000_000;
    clock.update(c.people, t0);
    expect(noteLocks(clock.update(c.people, t0 + NOTE_LOCK_TTL_MS - 1), t0 + NOTE_LOCK_TTL_MS - 1).size).toBe(1);
    expect(noteLocks(clock.update(c.people, t0 + NOTE_LOCK_TTL_MS + 1), t0 + NOTE_LOCK_TTL_MS + 1).size).toBe(0);
    k.client.publishPresence(editingNoteActivity("n-1", "s-1"));
    await settle();
    const t1 = t0 + NOTE_LOCK_TTL_MS + 5;
    expect(noteLocks(clock.update(c.people, t1), t1).size).toBe(1);
  });

  it("an edit that ignores the lock is refused once Avery's words are saved, and Avery's stay", async () => {
    const { k, c, model } = await hubWithNote();
    const item = model.elements["n-1"];
    if (item?.kind !== "drawing_item") throw new Error("note missing");
    const opened = noteContentFingerprint(item);
    k.client.submit(commandSchema.parse({ type: "edit_text_note", itemId: "n-1", expectedContent: opened, paragraphs: [{ runs: [{ text: "AVERY" }] }] }));
    await settle();
    // Casey's client already has Avery's saved words, so it refuses before sending.
    const local = c.client.submit(commandSchema.parse({ type: "edit_text_note", itemId: "n-1", expectedContent: opened, paragraphs: [{ runs: [{ text: "CASEY" }] }] }));
    expect(local.ok ? null : local.error.code).toBe("conflict");
    expect(local.ok ? "" : local.error.message).toMatch(/while you were editing it/);
    await settle();
    const saved = c.client.confirmedModel()?.elements["n-1"];
    expect(saved?.kind === "drawing_item" ? saved.note?.paragraphs[0]?.runs[0]?.text : null).toBe("AVERY");
  });
});
