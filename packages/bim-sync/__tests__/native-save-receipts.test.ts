/** @jest-environment node */
import type { Actor, Command } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { commandDigest, PROTOCOL_FEATURES, serverProtocol, SyncClient, type ClientMessage, type CommitOutcome } from "../src";

const actor: Actor = { id: "jules", kind: "human", name: "Jules" };
const key = "jules-east-plant-save";
const command: Command = { type: "create_level", levelId: "level-service", name: "Service", elevationMm: 3600 };
const query = { type: "read_save_receipt", idempotencyKey: key, commandDigest: commandDigest(command) };
const rejected: CommitOutcome = { status: "rejected", authorizationRevision: "4", error: { code: "forbidden", message: "View only", elementIds: [] } };

function fixture(receipts = true) {
  const sent: ClientMessage[] = [];
  const onOutcome = jest.fn();
  const client = new SyncClient({ send: wire => { sent.push(JSON.parse(wire)); }, close: () => {} }, actor, { onOutcome }, 60_000,
    { modelId: "east-plant", clientSessionId: "original-tab", meter: null });
  const model = createDemoModel();
  function reconnect(canWrite: boolean) {
    client.opened();
    client.receive(JSON.stringify({ type: "welcome", model, canWrite, protocol: serverProtocol(receipts ? [PROTOCOL_FEATURES.saveReceipts] : []) }));
  }
  function received(outcome: CommitOutcome | null) {
    client.receive(JSON.stringify({ type: "save_receipt", idempotencyKey: key, outcome }));
  }
  reconnect(true);
  expect(client.submit(command, { idempotencyKey: key }).ok).toBe(true);
  return { client, sent, onOutcome, reconnect, received, revision: model.revision };
}

describe("recovering a native save after a downgrade", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(["saved", "refused"])("recovers a %s edit exactly once through an actor-scoped receipt read", kind => {
    const { client, sent, onOutcome, reconnect, received, revision } = fixture();
    try {
      client.closed();
      expect(client.saveState()).toMatchObject({ pending: 1, unconfirmed: true, message: expect.stringContaining("Keep this tab open") });
      reconnect(false);
      expect(sent.filter(m => m.type === "command")).toHaveLength(1);
      expect(sent.filter(m => m.type === "read_save_receipt")).toEqual([query]);
      expect(client.view()?.elements["level-service"]).toBeUndefined();
      const answer: CommitOutcome = kind === "saved" ? { status: "committed", revision: revision + 1, rebased: false, authorizationRevision: "3" } : rejected;
      received(answer);
      received(answer);
      expect(onOutcome).toHaveBeenCalledTimes(1);
      expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: key }), answer, true);
      expect(client.saveState().pending).toBe(0);
      expect(sent.filter(m => m.type === "command")).toHaveLength(1);
    } finally { client.dispose(); }
  });

  it("retries a lost or missing receipt as a read, including after a fresh write grant", () => {
    const { client, sent, onOutcome, reconnect, received } = fixture();
    try {
      client.receive(JSON.stringify({ type: "model_access", canWrite: false }));
      expect(sent.filter(m => m.type === "read_save_receipt")).toEqual([query]);
      jest.advanceTimersByTime(1100); // the first receipt response was lost
      received(null);
      client.receive(JSON.stringify({ type: "model_access", canWrite: true }));
      client.closed();
      reconnect(true);
      expect(client.saveState()).toMatchObject({ pending: 1, unconfirmed: true });
      expect(onOutcome).not.toHaveBeenCalled();
      expect(sent.filter(m => m.type === "read_save_receipt").length).toBeGreaterThanOrEqual(3);
      expect(sent.filter(m => m.type === "command")).toHaveLength(1);
      received(rejected);
      jest.advanceTimersByTime(10_000);
      expect(onOutcome).toHaveBeenCalledTimes(1);
      expect(client.saveState().pending).toBe(0);
    } finally { client.dispose(); }
  });

  it("uses the established resend protocol with a server that does not advertise receipt reads", () => {
    const { client, sent, reconnect } = fixture(false);
    try {
      client.closed();
      reconnect(true);
      expect(sent.filter(m => m.type === "command")).toHaveLength(2);
      expect(sent.filter(m => m.type === "read_save_receipt")).toHaveLength(0);
    } finally { client.dispose(); }
  });
});
