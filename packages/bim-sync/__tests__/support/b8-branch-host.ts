import { type Actor, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryBranchHost, SyncClient, type BranchServerMessage, type CommitOutcome, type SyncHub } from "../../src";

export const FT = 304.8;
export const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
export const jordan: Actor = { id: "user-jordan", name: "Jordan", kind: "human" };

export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

export interface Attached {
  readonly client: SyncClient;
  readonly outcomes: CommitOutcome[];
  readonly denied: string[];
}

/** A client on an in-memory link to a hub, admitted as `actor` (as the authority does after sign-in). */
export function attach(hub: SyncHub, actor: Actor, id: string, opts: { canWrite?: boolean; modelId?: string } = {}): Attached {
  const outcomes: CommitOutcome[] = [];
  const denied: string[] = [];
  const conn = { id, send: (data: string) => client.receive(data) };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
    actor,
    { onOutcome: (_req, outcome) => outcomes.push(outcome), onDenied: (reason) => denied.push(reason) },
    60_000,
    { clientSessionId: `${id}-session`, meter: null, ...(opts.modelId ? { modelId: opts.modelId } : {}) },
  );
  hub.join(conn, { actorId: actor.id, canWrite: opts.canWrite ?? true });
  client.opened();
  return { client, outcomes, denied };
}

export async function startHost(model: ModelState = createDemoModel("site-1")): Promise<InMemoryBranchHost> {
  return InMemoryBranchHost.start(model);
}

/** Answer of one request, narrowed to the expected type (fails the test loudly otherwise). */
export function expectAnswer<T extends BranchServerMessage["type"]>(msg: BranchServerMessage, type: T): Extract<BranchServerMessage, { type: T }> {
  if (msg.type !== type) throw new Error(`expected ${type}, got ${msg.type}${msg.type === "request_refused" ? `: ${msg.reason}` : ""}`);
  return msg as Extract<BranchServerMessage, { type: T }>;
}
