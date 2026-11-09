import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, type ModelState } from "@permitzip/bim-kernel";
import { InMemoryCommitStore, Sequencer, SyncHub, builtinWebSocketFactory, type AgentSocketFactory, type HubConnection } from "@permitzip/bim-sync";

/**
 * Where the local tool server finds models: an in-memory model server in this
 * process (the same sequencer and sync protocol the real model server runs,
 * nothing saved after it stops), or a running one at a WebSocket address (the
 * MutinyBIM dev server's `/sync`).
 */
export interface LocalModelServer {
  /** The sync address sessions connect to. */
  readonly url: string;
  readonly socketFactory: AgentSocketFactory;
  /** Model ids this server is known to hold (in memory: the ones created so far). */
  models(): readonly string[];
  /** Puts a model in (in memory only; refused for a remote server). */
  seed(model: ModelState): Promise<void>;
  /** The committed head (in memory only): what a test asserts against. */
  head(modelId: string): Promise<ModelState | null>;
  close(): Promise<void>;
}

const IN_MEMORY_URL = "memory://mutinybim/sync";

interface Hosted {
  readonly sequencer: Sequencer;
  readonly hub: SyncHub;
}

function emptyModel(modelId: string): ModelState {
  return { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

export function startInMemoryModelServer(): LocalModelServer {
  const hosted = new Map<string, Promise<Hosted>>();
  const host = (model: ModelState): Promise<Hosted> => {
    const started = (async () => {
      const sequencer = await Sequencer.start(new InMemoryCommitStore(model));
      return { sequencer, hub: new SyncHub(sequencer) };
    })();
    hosted.set(model.modelId, started);
    return started;
  };
  const of = (modelId: string): Promise<Hosted> => hosted.get(modelId) ?? host(emptyModel(modelId));
  const socketFactory: AgentSocketFactory = (url, handlers) => {
    const modelId = new URL(url).searchParams.get("model");
    let joined: { hub: SyncHub; conn: HubConnection } | null = null;
    let closed = false;
    const ready = (async () => {
      if (!modelId) throw new Error("the sync address names no model");
      const { hub } = await of(modelId);
      // Delivered on a later turn, as a socket would: the client never receives inside its own send.
      const conn: HubConnection = { id: randomUUID(), send: (data) => setTimeout(() => !closed && handlers.onMessage(data), 0) };
      hub.join(conn);
      joined = { hub, conn };
      handlers.onOpen();
    })().catch((err: unknown) => {
      console.error("[bim-mcp] the in-memory model server couldn't open a session", { modelId, err });
      handlers.onClose(err instanceof Error ? err.message : String(err));
    });
    return {
      send: (data) => {
        void ready.then(() => joined?.hub.handle(joined.conn, data)).catch((err: unknown) => console.error("[bim-mcp] the in-memory model server failed on a message", err));
      },
      close: () => {
        if (closed) return;
        closed = true;
        void ready.then(() => joined?.hub.leave(joined.conn));
        handlers.onClose("closed");
      },
    };
  };
  return {
    url: IN_MEMORY_URL,
    socketFactory,
    models: () => [...hosted.keys()],
    async seed(model) {
      if (hosted.has(model.modelId)) throw new Error(`Model ${model.modelId} is already on this server.`);
      await host(model);
    },
    async head(modelId) {
      const found = hosted.get(modelId);
      if (!found) return null;
      return (await found).sequencer.head();
    },
    async close() {
      hosted.clear();
    },
  };
}

/** A model server already running at `url` (for example the dev server's ws://127.0.0.1:3095/sync). */
export function remoteModelServer(url: string, knownModels: readonly string[] = []): LocalModelServer {
  return {
    url,
    socketFactory: builtinWebSocketFactory(),
    models: () => knownModels,
    async seed() {
      throw new Error("Models on a running model server are made there, not by the tool server.");
    },
    async head() {
      return null;
    },
    async close() {},
  };
}
