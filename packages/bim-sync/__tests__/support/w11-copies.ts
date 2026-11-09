import { type Actor } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import {
  authorizeConnection,
  InMemoryBranchHost,
  InMemoryLineageActs,
  InMemoryLineageMemberStore,
  InMemoryModelMemberStore,
  NativeModelAuthorizer,
  SyncClient,
  type CommitOutcome,
  type ConnectionPrincipal,
  type InMemoryLineageOptions,
  type SyncHub,
} from "../../src";
import type { LineageServerMessage } from "../../src/lineages";

export const avery: Actor = { id: "user-avery", name: "Avery (engineer of record)", kind: "human" };
export const sam: Actor = { id: "user-sam", name: "Sam (Acme Mechanical)", kind: "human" };
export const riley: Actor = { id: "user-riley", name: "Riley (Acme Mechanical)", kind: "human" };
export const gc: Actor = { id: "user-gc", name: "Grace (general contractor)", kind: "human" };
export const outsider: Actor = { id: "user-x", name: "X", kind: "human" };

export const BASE = "site-1";

export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

/**
 * A model with one design editor (Avery) and three readers: a contractor's
 * two people and the GC. Copy grants go through the standalone per-copy
 * member store, as an open-source host keeps them.
 */
export async function startCopies(options: InMemoryLineageOptions = {}) {
  const members = new InMemoryModelMemberStore();
  members.set(BASE, avery.id, "editor");
  members.set(BASE, sam.id, "viewer");
  members.set(BASE, riley.id, "viewer");
  members.set(BASE, gc.id, "viewer");
  const copies = new InMemoryLineageMemberStore();
  const authorizer = new NativeModelAuthorizer(members, copies);
  const acts = new InMemoryLineageActs();
  const host = await InMemoryBranchHost.start(createDemoModel(BASE), {}, null, { acts, ...options });
  return { host, members, copies, authorizer, acts };
}

export interface Session {
  readonly hub: SyncHub;
  readonly principal: ConnectionPrincipal;
  readonly client: SyncClient;
  readonly outcomes: CommitOutcome[];
  ask(msg: Record<string, unknown> & { readonly type: string }): Promise<LineageServerMessage>;
}

let nextConn = 0;

/**
 * Admit `actor` to `modelId` as the model server does (per copy, round 11),
 * then attach a client. Throws with the refusal when they are not admitted.
 */
export async function admit(env: Awaited<ReturnType<typeof startCopies>>, actor: Actor, modelId: string): Promise<Session> {
  const lineage = await env.host.connectionLineage(modelId, actor.id);
  if (!lineage) throw new Error(`no such copy ${modelId}`);
  const decision = await authorizeConnection(env.authorizer, { actor, verifiedUserId: actor.id, modelId, token: `token-${actor.id}`, lineage });
  if (!decision.ok) throw new Error(decision.reason);
  const served = await env.host.open(modelId);
  if (!served) throw new Error(`copy ${modelId} not served`);
  const hub = served.hub;
  const id = `conn-${++nextConn}`;
  const outcomes: CommitOutcome[] = [];
  const replies = new Map<string, (msg: LineageServerMessage) => void>();
  const conn = {
    id,
    send: (data: string) => {
      const msg: unknown = JSON.parse(data);
      if (typeof msg === "object" && msg !== null && "requestId" in msg && typeof msg.requestId === "string") {
        const resolve = replies.get(msg.requestId);
        if (resolve) {
          replies.delete(msg.requestId);
          resolve(msg as LineageServerMessage);
          return;
        }
      }
      client.receive(data);
    },
  };
  const client: SyncClient = new SyncClient(
    { send: (data) => void hub.handle(conn, data), close: () => hub.leave(conn) },
    actor,
    { onOutcome: (_req, outcome) => outcomes.push(outcome) },
    60_000,
    { clientSessionId: `${id}-session`, meter: null, modelId },
  );
  hub.join(conn, decision.principal);
  client.opened();
  await settle();
  let seq = 0;
  return {
    hub,
    principal: decision.principal,
    client,
    outcomes,
    ask: (msg) =>
      new Promise((resolve) => {
        const requestId = `${id}-r${++seq}`;
        replies.set(requestId, resolve);
        void hub.handle(conn, JSON.stringify({ ...msg, requestId }));
      }),
  };
}

/** Narrow a lineage answer to the expected type (fails loudly otherwise). */
export function expectLineage<T extends LineageServerMessage["type"]>(msg: LineageServerMessage, type: T): Extract<LineageServerMessage, { type: T }> {
  if (msg.type !== type) throw new Error(`expected ${type}, got ${msg.type}${msg.type === "request_refused" ? `: ${msg.reason}` : ""}`);
  return msg as Extract<LineageServerMessage, { type: T }>;
}

/** Edit one terminal's airflow; resolves to the outcome status and words. */
export async function editTerminal(s: Session, cfm: number, terminalId = "sd-1"): Promise<{ status: string; message?: string }> {
  const before = s.outcomes.length;
  s.client.submit({ type: "set_terminal_cfm", terminalId, cfm });
  await settle();
  const outcome = s.outcomes[before];
  if (!outcome) throw new Error("no outcome");
  return outcome.status === "rejected" ? { status: outcome.status, message: outcome.error.message } : { status: outcome.status };
}
