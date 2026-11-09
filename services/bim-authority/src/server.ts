/**
 * MutinyBIM model authority. One process per machine; each model is served by
 * the one process holding its lease (bim.models.lease_*). Every connection is
 * signed in and authorized BEFORE this process touches the model's lease, loads
 * it, or warms it. Commits are durable in Postgres before anyone is told
 * "saved", and every durable write re-checks the lease in SQL.
 *
 *   node --import tsx src/server.ts     # ws://127.0.0.1:8080/sync?model=<id>
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  NO_MODEL_ACCESS,
  NO_SUCH_MODEL,
  STORAGE_UNAVAILABLE,
  BranchService,
  Sequencer,
  SyncHub,
  authorizationModelId,
  authorizeConnection,
  branchHistory,
  storeHistory,
  kernelScheduleEvaluator,
  mergeSessionHandler,
  sequencerLander,
  type HistoryReader,
  type MainLander,
  parseClientMessage,
  percentiles,
  PROTOCOL_FEATURES,
  serverProtocol,
  type BranchRegistry,
  type ConnectionPrincipal,
  type MergeApprovalSource,
  type ModelAuthorizer,
  type SessionReport,
  type StaleLeaseError,
} from "@permitzip/bim-sync";
import {
  type ChildLineageRegistry,
  LineageService,
  type LineageStore,
} from "@permitzip/bim-sync/lineages";
import { LineageError, lineageModelId } from "@permitzip/bim-kernel/lineages";
import { branchAcceptsEdits, branchClosedMessage, hostedIds, parseBranchModelId, warmModel, type Actor, type BranchRef, type Changeset, type ModelState, type WarmTimings } from "@permitzip/bim-kernel";
import { unbindModelPacks, withModelPacks } from "@permitzip/bim-kernel/packs";
import { bindServedModelState, ensureFirstPartyAddOns, touchesModelSetup } from "./packs";
import { loadConfig, servedModelId, type ServedModels } from "./config";
import { OPENING_ELSEWHERE, RECONNECTING, REFRESHING_SIGN_IN, REVOKED, WRONG_MODEL } from "./messages";
import { connect, LeaseHeldError, loadHeadTimed, PostgresCommitStore } from "./pg-store";
import { PgBranchRegistry, loadBranchHead, type BaseSource } from "./pg-branches";
import { PgLineageStore } from "./lineages/store";
import { PgLineageCheckpointStore, lineageCheckpointer } from "./lineages/checkpoints";
import { connectionLineageFor, copyLine, recheckCopyRights } from "./lineages/admission";
import { recordedSchemaVersion } from "./pg-migration-session";
import { LeaseKeeper, type LeaseLossReason } from "./lease";
import { LoginVerifier, type LoginIssuer, type VerifiedLogin } from "./auth/verify";
import { TestProjectAuthorizer } from "./auth/test-authorizer";
import { PERMISSION_CHECK_FAILED } from "./host/contract";
import { createHost, loadModelServerHostModule } from "./host/load";
import { hostProjectResolver, hostedModelProvisioner } from "./host/hosted-models";
import { decideRoute, isFlyMachineId, routeHolder } from "./routing";
import { logMergeReply } from "./merge";
import { handleQuantityDeltaMessage } from "./delta";
import { ImportService, PgImportRuns, convertInThread, proposalOwnerCanWrite } from "./import";

/** The host plug-in (host/contract.ts): who may sign in and what they may do. Null: test logins only. */
const hostModule = await loadModelServerHostModule(process.env.MUTINYBIM_AUTHORIZER_MODULE);
const config = loadConfig(process.env, { forbiddenDbRefDigests: hostModule?.forbiddenDbRefDigests ?? [] });
const sql = connect(config.dbUrl, 8);
const host =
  hostModule && config.hostModule
    ? await createHost(hostModule, { env: process.env, local: config.local, sql, hostProjects: hostProjectResolver(sql), provisioner: hostedModelProvisioner(sql), fetch }, config.hostModule)
    : null;
if (host) console.log(`[bim-authority] host plug-in ${host.name} (${config.hostModule})`);
const verifier = new LoginVerifier({ host: host?.signIn ?? null, testUrl: config.testAuthUrl });
const hostAuthorizer = host?.authorizer(null) ?? null;
const testAuthorizer = config.testAuthUrl ? new TestProjectAuthorizer(sql) : null;
/** Who is responsible and who approved, from the host as the person (merges). Null: no host source, merges answer "not available". */
const mergeApprovals: MergeApprovalSource | null = host?.mergeApprovals ?? null;
/** The models this deployment serves: the configured list, plus the host's on-demand models. */
const served: ServedModels = { servedModels: config.servedModels, aliases: config.aliases, ...(host?.servesOnDemand ? { servesOnDemand: (id: string) => host.servesOnDemand?.(id) === true } : {}) };
const startedAt = Date.now();
/** Newest db/migrations file recorded in this database (the release step wrote it), reported on /health for deploy.sh. */
let schemaVersion: string | null = null;
recordedSchemaVersion(sql).then(
  (version) => {
    schemaVersion = version;
    console.log(`[bim-authority] database schema ${version ?? "not recorded (bim.schema_migrations missing: run src/migrate.ts)"}`);
  },
  (err: unknown) => console.error("[bim-authority] reading the database schema version failed", err instanceof Error ? err.message : err),
);
/** Schedules are evaluated here, over the whole model, for whoever has one open (one evaluator for every model). */
const scheduleEvaluator = kernelScheduleEvaluator();

function authorizerFor(issuer: LoginIssuer): ModelAuthorizer | null {
  return issuer === "host" ? hostAuthorizer : testAuthorizer;
}

// ----------------------------------------------------------------- metrics

const SAMPLE_CAP = 2000;
function sample(list: number[], value: number): void {
  list.push(value);
  if (list.length > SAMPLE_CAP) list.splice(0, list.length - SAMPLE_CAP);
}
const timings = { verifyMs: [] as number[], capabilitiesMs: [] as number[], joinColdMs: [] as number[], joinWarmMs: [] as number[] };
const counters = { connections: 0, compressed: 0, replays: 0, routeRetries: 0, denied: 0, revoked: 0, downgraded: 0, refreshed: 0, leaseHeldAtJoin: 0 };
const retiredLog: { modelId: string; reason: string; at: string; generation: number | null }[] = [];
const sessionReports = new Map<string, { readonly report: SessionReport; readonly actorKind: "human" | "agent"; readonly receivedAt: string }>();

// ----------------------------------------------------------------- models

interface LiveConn {
  readonly id: string;
  readonly socket: WebSocket;
  readonly modelId: string;
  readonly userId: string;
  readonly issuer: LoginIssuer;
  readonly token: string;
  readonly expiresAt: number | null;
  readonly actorId: string;
  canWrite: boolean;
  checkFailingSince: number | null;
}

interface ModelRuntime {
  readonly hub: SyncHub;
  /** Branches, saved versions and history reads for this model; on a branch, its record. */
  readonly branches: BranchService;
  readonly sequencer: Sequencer;
  readonly store: PostgresCommitStore;
  readonly keeper: LeaseKeeper;
  readonly generation: number;
  readonly startup: { readonly leaseMs: number; readonly loadMs: number; readonly warm: WarmTimings | null };
  readonly conns: Map<string, LiveConn>;
}

const models = new Map<string, ModelRuntime>();

// ----------------------------------------------------------------- branches

/** Asked for a branch id the database has no row for (or one of another base). */
class NoSuchBranchError extends Error {
  constructor(readonly modelId: string) {
    super(`No branch ${modelId}`);
    this.name = "NoSuchBranchError";
  }
}

const pgBranches = new PgBranchRegistry(sql);
/** Round 11 (W11): copies with a purpose over the branch rows, and their checkpoints. */
const pgLineages = new PgLineageStore(sql, pgBranches);
const lineageCheckpoints = new PgLineageCheckpointStore(sql);
/** Linked-model imports (round 9 I9): who opened which proposal branch, and the import endpoints. */
const importRuns = new PgImportRuns(sql);
const imports = new ImportService({
  runs: importRuns,
  verify: async (token) => {
    try {
      return { userId: (await verifier.verify(token)).userId };
    } catch (err) {
      console.error("[bim-authority] import sign-in rejected", err instanceof Error ? err.message : err);
      return null;
    }
  },
  canRead: async (_login, modelId, token) => {
    const login = await verifier.verify(token);
    const grant = await authorizerFor(login.issuer)?.capabilities({ userId: login.userId, modelId: authorizationModelId(modelId), token });
    return grant?.ok === true && grant.capabilities.has("model.read");
  },
  servedModelId: (requested) => servedModelId(served, requested),
  mainHead: async (modelId) => (await runtimeFor(modelId)).runtime.sequencer.head(),
  landDeps: (modelId) => ({
    createBranch: (input) => branchRegistry.create({ baseModelId: modelId, ...input }),
    closeBranch: async (id) => void (await branchRegistry.close(id, "import")),
    openBranch: async (id) => (await runtimeFor(id)).runtime.sequencer,
  }),
  convert: convertInThread,
  allowedSource: (url) => host?.allowsImportSource?.(url) === true,
});

/** Tell a branch served here that it was closed or merged, so its next edit is refused before reaching the database. */
function branchChanged(ref: BranchRef): BranchRef {
  models.get(ref.modelId)?.branches.setCurrent(ref);
  return ref;
}

const branchRegistry: BranchRegistry & LineageStore & ChildLineageRegistry = {
  list: (base) => pgBranches.list(base),
  rows: (base) => pgLineages.rows(base),
  createCopy: (input) => pgLineages.createCopy(input),
  createChild: (input) => pgLineages.createChild(input),
  get: (id) => pgBranches.get(id),
  create: (input) => pgBranches.create(input),
  close: async (id) => branchChanged(await pgBranches.close(id)),
  versions: (id) => pgBranches.versions(id),
  saveVersion: (input) => pgBranches.saveVersion(input),
  deleteVersion: (id, versionId) => pgBranches.deleteVersion(id, versionId),
};

/** A base's changesets after a revision, from the database (the base is not served here). */
async function storedChangesSince(modelId: string, revision: number): Promise<readonly Changeset[]> {
  const rows = await sql<{ body: Changeset }[]>`select body from bim.changesets where model_id = ${modelId} and revision > ${revision} order by revision`;
  return rows.map((r) => r.body);
}

/**
 * Where a branch reads its base: the base's live head when this machine serves
 * it (shared element objects, copy on write), otherwise one consistent read of
 * the base's stored head. Never leases the base.
 */
function baseSourceFor(baseModelId: string): BaseSource {
  return {
    async head(): Promise<ModelState> {
      const live = models.get(baseModelId);
      if (live) return live.sequencer.head();
      return sql.begin("isolation level repeatable read read only", async (tx) => {
        await tx`set local statement_timeout = '120s'`; // a whole building is a legitimately long read
        return (await loadHeadTimed(tx, baseModelId)).head.model;
      });
    },
    async changesSince(revision: number): Promise<readonly Changeset[]> {
      const live = models.get(baseModelId);
      return live ? live.sequencer.changesSince(revision) : storedChangesSince(baseModelId, revision);
    },
  };
}
/**
 * Round 11 (W11): where a copy reads the copy it came from, at any depth. A
 * first copy (or a copy served here) is `baseSourceFor`; a copy not served
 * here is rebuilt the way its own runtime would open it (its parent's state
 * at its pin, its checkpoint, its own changesets), in one read-only snapshot.
 */
function lineageSourceFor(modelId: string): BaseSource {
  const plain = baseSourceFor(modelId);
  return {
    async head(): Promise<ModelState> {
      const live = models.get(modelId);
      const ref = live || !parseBranchModelId(modelId) ? null : await pgBranches.get(modelId);
      if (!ref) return plain.head();
      const parent = lineageSourceFor(await pgLineages.parentModelIdOf(ref));
      return sql.begin("isolation level repeatable read read only", async (tx) => {
        await tx`set local statement_timeout = '120s'`; // a whole building is a legitimately long read
        return (await loadBranchHead(tx, modelId, ref.baseRevision, parent)).model;
      });
    },
    changesSince: (revision) => plain.changesSince(revision),
  };
}

/**
 * Merge preview and apply on a branch session. The branch's and Main's
 * histories are read here; approvals are read from the host as the person on
 * the connection; approved parts land on Main through Main's own runtime
 * (opened here when no machine holds it), one revision per part. Only a
 * person lands a merge: an agent's session may preview, never apply.
 */
function mergeHandler(input: {
  readonly modelId: string;
  readonly branchRef: BranchRef;
  /** The copy a merge lands on (round 11: the parent, at any depth). */
  readonly parentModelId: string;
  readonly parentLineageId: string;
  readonly service: BranchService;
  readonly sequencer: Sequencer;
  readonly store: PostgresCommitStore;
  readonly mainHistory: HistoryReader;
  readonly conns: ReadonlyMap<string, LiveConn>;
  readonly source: MergeApprovalSource;
}) {
  return mergeSessionHandler({
    source: input.source,
    sides: async () => ({ branch: input.service.current() ?? input.branchRef, mainHistory: input.mainHistory, branchHistory: branchHistory(input.branchRef, input.store, input.mainHistory), branchHead: await input.sequencer.head() }),
    who: (connectionId, principal) => {
      const conn = input.conns.get(connectionId);
      // A merge lands on the parent: edit there decides (round 11), never edit on this copy.
      const canEdit = principal.lineage ? (principal.lineage.rights.get(input.parentLineageId)?.has("edit") ?? false) : conn?.canWrite === true;
      return conn ? { userId: conn.userId, token: conn.token, canEdit } : null;
    },
    lander: (actor) => {
      // One lander per apply: its parts share one session, so later parts don't read earlier ones as someone else's change.
      let onMain: MainLander | null = null;
      return {
        async land(part) {
          if (!onMain) {
            try {
              const main = await runtimeFor(input.parentModelId);
              onMain = sequencerLander({ sequencer: main.runtime.sequencer, actor, branchModelId: input.modelId });
            } catch (err) {
              if (err instanceof LeaseHeldError) return { ok: false, message: "Main is open on another model server right now, so this part didn't land. Try Merge approved parts again in a moment." };
              console.error("[bim-authority] opening Main to land a merge failed", { branch: input.modelId, err });
              return { ok: false, message: STORAGE_UNAVAILABLE };
            }
          }
          return onMain.land(part);
        },
      };
    },
    onAnswered: async (_msg, reply) => {
      logMergeReply({ branch: input.service.current() ?? input.branchRef }, reply);
      if (reply.type !== "merge_apply_result" || !reply.allLanded) return;
      try {
        branchChanged(await pgBranches.markMerged(input.modelId));
      } catch (err) {
        console.error("[bim-authority] every part landed but marking the branch merged failed; it stays open", { branch: input.modelId, err });
      }
    },
  });
}

const creating = new Map<string, Promise<ModelRuntime>>();
/**
 * Drills only (BIM_AUTHORITY_DRILLS=1): turning this off stops renewals and every
 * in-process lease check, so a lapsed owner reaches the database and only the
 * database's write fence refuses it. Always on in normal operation.
 */
const processChecksOff = new Set<string>();
const processChecksFor = (modelId: string) => (): boolean => !processChecksOff.has(modelId);

function runtimeFor(modelId: string): Promise<{ runtime: ModelRuntime; cold: boolean }> {
  const existing = models.get(modelId);
  if (existing) return Promise.resolve({ runtime: existing, cold: false });
  let pending = creating.get(modelId);
  if (!pending) {
    pending = createRuntime(modelId).finally(() => creating.delete(modelId));
    creating.set(modelId, pending);
  }
  return pending.then((runtime) => ({ runtime, cold: true }));
}

async function createRuntime(modelId: string): Promise<ModelRuntime> {
  const asBranch = parseBranchModelId(modelId);
  const branchRef = asBranch ? await branchRegistry.get(modelId) : null;
  if (asBranch && (!branchRef || branchRef.baseModelId !== asBranch.baseModelId)) throw new NoSuchBranchError(modelId);
  // Round 11: a copy opens over its parent (the base for a round 8b branch; another copy at any depth).
  const chain = branchRef ? await pgLineages.chainOf(branchRef.baseModelId, modelId) : null;
  const parentModelId = branchRef ? await pgLineages.parentModelIdOf(branchRef) : null;
  const baseSource = parentModelId ? lineageSourceFor(parentModelId) : null;
  let branchService: BranchService | null = null;
  const store = new PostgresCommitStore(sql, {
    modelId,
    owner: config.owner,
    ownerMachine: config.machineId,
    leaseTtlMs: config.leaseTtlMs,
    processLeaseChecks: processChecksFor(modelId),
    // A kept validation state is adopted only by the build that wrote it; no build id (or the Dockerfile's "unknown") keeps nothing.
    validationCodeKey: config.commit && config.commit !== "unknown" ? config.commit : null,
    ...(branchRef && baseSource
      ? {
          branch: { baseRevision: branchRef.baseRevision, base: baseSource },
          onBranchState: (state) => {
            const current = branchService?.current();
            if (current && current.state !== state) branchService?.setCurrent({ ...current, state });
          },
        }
      : {}),
  });
  const t0 = performance.now();
  const sequencer = await Sequencer.start(store, config.groupCommit); // throws LeaseHeldError while another process owns the model
  const mainHistory = baseSource ? storeHistory(baseSource) : null;
  branchService = new BranchService({
    modelId,
    registry: branchRegistry,
    history: branchRef && mainHistory ? branchHistory(branchRef, store, mainHistory) : storeHistory(store),
    ...(mainHistory ? { main: mainHistory } : {}),
    branch: branchRef,
    head: () => sequencer.head(),
  });
  const service = branchService;
  // A merged or closed branch refuses edits here first; the write's own guard refuses them in the database too.
  sequencer.setWriteGate(() => {
    const ref = service.current();
    return ref && !branchAcceptsEdits(ref.state) ? branchClosedMessage(ref.state) : null;
  });
  const generation = store.leaseTerm()?.generation ?? -1;
  const t1 = performance.now();
  const keeper = new LeaseKeeper(modelId, store, config.leaseTtlMs, config.leaseRenewMs, (reason) => retire(modelId, reason), undefined, processChecksFor(modelId));
  keeper.start();
  let head;
  try {
    head = await store.head();
  } catch (err) {
    keeper.stop();
    await store.releaseLease().catch((releaseErr) => console.error("[bim-authority] release after failed load failed", { modelId, releaseErr }));
    throw err;
  }
  const t2 = performance.now();
  bindServedModelState(head);
  // Commands already resolve a switch from the model itself; this keeps reads by id (graph, schedules, warm-up) in step.
  sequencer.onCommit((changeset) => {
    if (!touchesModelSetup(changeset.elements.map((element) => element.id))) return;
    sequencer
      .head()
      .then((next) => bindServedModelState(next))
      .catch((err) => console.error("[bim-authority] rebind after a model setup change failed", { modelId, revision: changeset.revision, err }));
  });
  // Index and check the building now, while nobody waits on the first edit.
  const warm = config.prewarm ? withModelPacks(modelId, () => warmModel(head)) : null;
  const conns = new Map<string, LiveConn>();
  const storage = store.storageFeatures();
  // The head as last committed, for what a host holds now (quantity deltas read openings through it).
  let headNow: ModelState = head;
  sequencer.onCommit(() => {
    sequencer
      .head()
      .then((next) => {
        headNow = next;
      })
      .catch((err) => console.error("[bim-authority] reading the head after a commit failed", { modelId, err }));
  });
  const ownHistory = branchRef && mainHistory ? branchHistory(branchRef, store, mainHistory) : storeHistory(store);
  const parentLineageId = chain?.[1]?.lineage.id ?? null;
  const merge = mergeApprovals && branchRef && mainHistory && parentModelId && parentLineageId ? mergeHandler({ modelId, branchRef, parentModelId, parentLineageId, service, sequencer, store, mainHistory, conns, source: mergeApprovals }) : null;
  const baseModelId = branchRef?.baseModelId ?? modelId;
  const lineages = new LineageService({
    baseModelId,
    lineageId: chain?.[0]?.lineage.id ?? (await pgLineages.rows(baseModelId))[0]?.lineage.id ?? "",
    store: branchRegistry,
    line: (id) => copyLine(pgLineages, baseModelId, id, lineageSourceFor),
    // Reviews and accept backs are signed on the host's sign-off chain as the person; a host with no recorder: neither is offered.
    ...(host?.lineageActs
      ? {
          acts: host.lineageActs((caller) => (caller.connectionId ? (conns.get(caller.connectionId)?.token ?? null) : null)),
          lander: async (targetLineageId: string, actor: Actor, fromLineageId: string) => {
            const rows = await pgLineages.rows(baseModelId);
            const target = rows.find((r) => r.lineage.id === targetLineageId);
            const from = rows.find((r) => r.lineage.id === fromLineageId);
            if (!target || !from) throw new LineageError(`"${target ? fromLineageId : targetLineageId}" isn't a copy of this model.`);
            let opened;
            try {
              opened = await runtimeFor(lineageModelId(baseModelId, target.lineage));
            } catch (err) {
              if (err instanceof LeaseHeldError) throw new LineageError("The copy these records go back to is open on another model server right now, so nothing landed. Try again in a moment.");
              console.error("[bim-authority] opening a copy to accept records back failed", { baseModelId, targetLineageId, err });
              throw new LineageError(STORAGE_UNAVAILABLE);
            }
            return sequencerLander({ sequencer: opened.runtime.sequencer, actor, branchModelId: lineageModelId(baseModelId, from.lineage) });
          },
        }
      : {}),
  });
  const here = chain?.[0];
  if (here?.lineage.parent && branchRef) {
    // Off the commit path: a copy writes its net change every LINEAGE_CHECKPOINT_EVERY own revisions once they are durable.
    sequencer.onDurable(
      lineageCheckpointer({ store: lineageCheckpoints, modelId, lineageId: here.lineage.id, forkRevision: branchRef.baseRevision, head: () => sequencer.head(), ownChanges: (since) => storedChangesSince(modelId, since) }),
    );
  }
  const hub = new SyncHub(sequencer, {
    branches: service,
    lineages,
    ...(merge ? { merge } : {}),
    quantityDelta: async (msg) =>
      (await handleQuantityDeltaMessage(msg, { history: ownHistory, ...(mainHistory ? { main: mainHistory } : {}), branch: branchRef, hostedNow: (hostId) => hostedIds(headNow.elements, hostId) }, modelId)) ?? {
        type: "quantity_delta_refused",
        requestId: msg.requestId,
        reason: "That comparison request wasn't understood. Reload and try again.",
      },
    schedules: scheduleEvaluator,
    // Storage features ride in welcome so clients and drills can see what this database holds; none changes the wire.
    protocol: serverProtocol([PROTOCOL_FEATURES.pagedBoot, PROTOCOL_FEATURES.branchesImport, ...(storage.changesetPatch ? [PROTOCOL_FEATURES.changesetPatch] : [])]),
    onLeaseLost: (err: StaleLeaseError) => retire(modelId, "stale_lease_on_write", err),
    onReport: ({ actorId, report }) => {
      const actorKind = actorId.startsWith("agent:") ? "agent" : "human";
      sessionReports.set(report.clientSessionId, { report, actorKind, receivedAt: new Date().toISOString() });
      if (sessionReports.size > 500) sessionReports.delete(sessionReports.keys().next().value ?? "");
      console.log(`[bim-authority][session-report] ${JSON.stringify({ modelId, region: config.region, machine: config.machineId, actorKind, ...report })}`);
    },
  });
  const runtime: ModelRuntime = {
    hub,
    branches: service,
    sequencer,
    store,
    keeper,
    generation,
    startup: { leaseMs: t1 - t0, loadMs: t2 - t1, warm },
    conns,
  };
  models.set(modelId, runtime);
  console.log(`[bim-authority] serving ${modelId} at revision ${head.revision}, lease generation ${generation} (lease ${Math.round(t1 - t0)} ms, load ${Math.round(t2 - t1)} ms)`);
  return runtime;
}

/**
 * Stop serving a model: no more commits, clients told plainly and disconnected
 * (they reconnect through the edge to whoever owns it next), lease released.
 */
function retire(modelId: string, reason: LeaseLossReason | "stale_lease_on_write" | "shutdown", err?: StaleLeaseError): void {
  const runtime = models.get(modelId);
  if (!runtime) return;
  models.delete(modelId);
  unbindModelPacks(modelId);
  runtime.hub.halt(RECONNECTING);
  runtime.keeper.stop();
  console.error(`[bim-authority] stopped serving ${modelId}: ${reason}`, { generation: runtime.generation, attempted: err?.attempted, current: err?.current });
  retiredLog.push({ modelId, reason, at: new Date().toISOString(), generation: runtime.generation });
  if (retiredLog.length > 50) retiredLog.shift();
  for (const conn of runtime.conns.values()) {
    conn.socket.send(JSON.stringify({ type: "unavailable", message: RECONNECTING }));
    conn.socket.close(4001, "model handed off");
  }
  runtime.conns.clear();
  // The kept validation state: on shutdown the lease still holds, so a pending write lands first; a lost lease can't write, so it only stops.
  const validationSettled = (reason === "shutdown" ? runtime.store.flushValidationState() : runtime.store.settleValidationState()).catch((stateErr) =>
    console.error("[bim-authority] settling the kept validation state failed; the next open checks the model from scratch", { modelId, stateErr }),
  );
  validationSettled
    .then(() => runtime.store.releaseLease())
    .then((released) => console.log(`[bim-authority] lease on ${modelId} ${released ? "released" : "was already gone"}`))
    .catch((releaseErr) => console.error("[bim-authority] lease release failed; it expires on its own", { modelId, releaseErr }));
}

// ----------------------------------------------------------------- sign-in

interface Admission {
  readonly login: VerifiedLogin;
  readonly modelId: string;
  readonly principal: ConnectionPrincipal;
}

type AdmissionResult = { readonly ok: true; readonly admission: Admission } | { readonly ok: false; readonly reason: string };

/** Sign-in and authorization, done before this process leases, loads or warms anything. */
async function admit(
  hello: { readonly token?: string; readonly modelId?: string; readonly actor: Actor },
  urlModel: string | null,
  urlProject: string | null,
): Promise<AdmissionResult> {
  if (!hello.token) return { ok: false, reason: "Sign in first" };
  if (!hello.modelId) return { ok: false, reason: "Say hello with a model id first" };
  const modelId = servedModelId(served, hello.modelId);
  if (!modelId) return { ok: false, reason: NO_MODEL_ACCESS };
  if (urlModel !== null && servedModelId(served, urlModel) !== modelId) return { ok: false, reason: WRONG_MODEL };
  const t0 = performance.now();
  let login: VerifiedLogin;
  try {
    login = await verifier.verify(hello.token);
  } catch (err) {
    console.error("[bim-authority] sign-in rejected", err instanceof Error ? err.message : err);
    return { ok: false, reason: "Sign in again: your session is not valid" };
  }
  const t1 = performance.now();
  sample(timings.verifyMs, t1 - t0);
  // The page's project is only a candidate for a model not on this server yet; the host confirms it as the person.
  const authorizer = login.issuer === "host" ? (host?.authorizer(urlProject) ?? null) : authorizerFor(login.issuer);
  if (!authorizer) return { ok: false, reason: "Sign in again: your session is not valid" };
  // Round 11 (W11): decided per copy; a copy id with no row is refused below when the runtime opens.
  const lineage = await connectionLineageFor(pgLineages, modelId);
  const decision = await authorizeConnection(authorizer, { actor: hello.actor, verifiedUserId: login.userId, modelId, token: hello.token, ...(lineage ? { lineage } : {}) });
  sample(timings.capabilitiesMs, performance.now() - t1);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const canWrite = await proposalOwnerCanWrite(importRuns, { modelId, userId: login.userId, canRead: true, canWrite: decision.principal.canWrite });
  return { ok: true, admission: { login, modelId, principal: { ...decision.principal, canWrite } } };
}

// ----------------------------------------------------------------- sockets

const wss = new WebSocketServer({
  noServer: true,
  // A zone welcome is ~2 MB of JSON at 250k elements; compressed it crosses an ocean in far fewer round trips.
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
});

function deny(socket: WebSocket, reason: string, code = 4003): void {
  counters.denied += 1;
  socket.send(JSON.stringify({ type: "denied", reason }));
  socket.close(code, "denied");
}

function onConnection(socket: WebSocket, req: IncomingMessage, urlModel: string | null, urlProject: string | null): void {
  counters.connections += 1;
  if ((req.headers["sec-websocket-extensions"] ?? "").includes("permessage-deflate")) counters.compressed += 1;
  const id = randomUUID();
  let live: { runtime: ModelRuntime; conn: LiveConn } | null = null;
  let helloAt = 0;
  let cold = false;
  let welcomed = false;
  const hubConn = {
    id,
    send: (data: string) => {
      if (!welcomed && data.startsWith('{"type":"welcome"')) {
        welcomed = true;
        sample(cold ? timings.joinColdMs : timings.joinWarmMs, performance.now() - helloAt);
      }
      socket.send(data);
    },
  };
  let queue: Promise<void> = Promise.resolve();
  socket.on("message", (data) => {
    const raw = data.toString();
    // One message at a time per connection, so hello is fully handled before anything after it.
    queue = queue
      .then(async () => {
        if (live) {
          // A paused or partitioned process finds out here before acting: no renewal for too long = not ours.
          if (!live.runtime.keeper.fresh()) {
            retire(live.conn.modelId, "renewal_deadline_passed");
            return;
          }
          await live.runtime.hub.handle(hubConn, raw);
          return;
        }
        const msg = parseClientMessage(raw);
        if (!msg || msg.type !== "hello") {
          deny(socket, "Say hello with a model id first");
          return;
        }
        helloAt = performance.now();
        const admitted = await admit(msg, urlModel, urlProject);
        if (!admitted.ok) {
          if (admitted.reason === NO_SUCH_MODEL) console.log("[bim-authority] no live model yet for a reader", { id, model: urlModel });
          else console.error("[bim-authority] connection refused", { id, reason: admitted.reason });
          deny(socket, admitted.reason);
          return;
        }
        const { admission } = admitted;
        let got;
        try {
          got = await runtimeFor(admission.modelId);
        } catch (err) {
          if (err instanceof LeaseHeldError) {
            counters.leaseHeldAtJoin += 1;
            socket.send(JSON.stringify({ type: "unavailable", message: OPENING_ELSEWHERE }));
            socket.close(4002, "model owned elsewhere");
            return;
          }
          if (err instanceof NoSuchBranchError) {
            console.log("[bim-authority] asked for a branch that does not exist", { id, model: admission.modelId });
            deny(socket, NO_SUCH_MODEL);
            return;
          }
          console.error("[bim-authority] could not open the model", { modelId: admission.modelId, err });
          socket.send(JSON.stringify({ type: "unavailable", message: STORAGE_UNAVAILABLE }));
          socket.close(1011, "model unavailable");
          return;
        }
        if (socket.readyState !== socket.OPEN) return;
        cold = got.cold;
        const conn: LiveConn = {
          id,
          socket,
          modelId: admission.modelId,
          userId: admission.login.userId,
          issuer: admission.login.issuer,
          token: msg.token ?? "",
          expiresAt: admission.login.expiresAt,
          actorId: admission.principal.actorId,
          canWrite: admission.principal.canWrite,
          checkFailingSince: null,
        };
        live = { runtime: got.runtime, conn };
        got.runtime.conns.set(id, conn);
        got.runtime.hub.join(hubConn, admission.principal);
        await got.runtime.hub.handle(hubConn, raw);
      })
      .catch((err) => console.error("[bim-authority] message failed", { id, err }));
  });
  socket.on("close", () => {
    if (!live) return;
    live.runtime.conns.delete(id);
    live.runtime.hub.leave(hubConn);
  });
  socket.on("error", (err) => console.error("[bim-authority] socket error", { id, err }));
}

// ----------------------------------------------------------------- live access re-check

/** Access can be removed mid-session: re-check every live connection and act on the answer. */
async function recheckAccess(): Promise<void> {
  const nowS = Date.now() / 1000;
  for (const runtime of models.values()) {
    for (const conn of [...runtime.conns.values()]) {
      if (conn.expiresAt !== null && nowS > conn.expiresAt - 30) {
        // The token is about to expire; the client reconnects and signs in with a fresh one.
        counters.refreshed += 1;
        conn.socket.send(JSON.stringify({ type: "unavailable", message: REFRESHING_SIGN_IN }));
        conn.socket.close(4401, "sign-in expiring");
        continue;
      }
      const authorizer = authorizerFor(conn.issuer);
      if (!authorizer) continue;
      let grant;
      try {
        grant = await authorizer.capabilities({ userId: conn.userId, modelId: authorizationModelId(conn.modelId), token: conn.token });
      } catch (err) {
        console.error("[bim-authority] access re-check threw", { modelId: conn.modelId, err });
        grant = { ok: false as const, reason: PERMISSION_CHECK_FAILED };
      }
      if (!grant.ok && grant.reason === NO_MODEL_ACCESS) {
        counters.revoked += 1;
        console.log("[bim-authority] access removed mid-session; disconnecting", { modelId: conn.modelId, connection: conn.id });
        runtime.hub.revoke(conn.id, REVOKED);
        runtime.conns.delete(conn.id);
        conn.socket.close(4003, "access removed");
        continue;
      }
      if (!grant.ok) {
        // Could not ask (the host unreachable). Keep serving briefly; past a minute, reconnect so sign-in runs again.
        conn.checkFailingSince ??= Date.now();
        if (Date.now() - conn.checkFailingSince > 60_000) {
          conn.socket.send(JSON.stringify({ type: "unavailable", message: PERMISSION_CHECK_FAILED }));
          conn.socket.close(4002, "access check unavailable");
        }
        continue;
      }
      // Round 11 (W11): edit is per copy; a grant revoked mid-session downgrades or removes this connection.
      const copy = await recheckCopyRights(authorizer, pgLineages, { userId: conn.userId, modelId: conn.modelId, token: conn.token, capabilities: grant.capabilities });
      if (!copy.ok) {
        conn.checkFailingSince ??= Date.now();
        continue;
      }
      if (!copy.canRead) {
        counters.revoked += 1;
        console.log("[bim-authority] copy access removed mid-session; disconnecting", { modelId: conn.modelId, connection: conn.id });
        runtime.hub.revoke(conn.id, REVOKED);
        runtime.conns.delete(conn.id);
        conn.socket.close(4003, "access removed");
        continue;
      }
      conn.checkFailingSince = null;
      const canWrite = await proposalOwnerCanWrite(importRuns, { modelId: conn.modelId, userId: conn.userId, canRead: grant.capabilities.has("model.read"), canWrite: copy.canWrite });
      if (canWrite !== conn.canWrite) {
        conn.canWrite = canWrite;
        if (!canWrite) counters.downgraded += 1;
      }
      runtime.hub.setPrincipal(conn.id, { actorId: conn.actorId, canWrite, lineage: copy.lineage });
    }
  }
}

/**
 * A branch closed or merged on another machine (round 9 B9): one read of the
 * open branches served here, each pass; a changed row updates the runtime,
 * whose hub tells its pages in place (`branch_state`) and whose write gate
 * refuses the next edit before it reaches the database.
 */
async function refreshServedBranchStates(): Promise<number> {
  const open: string[] = [];
  for (const [id, runtime] of models) {
    const ref = runtime.branches.current();
    if (ref && parseBranchModelId(id) && branchAcceptsEdits(ref.state)) open.push(id);
  }
  if (open.length === 0) return 0;
  let changed = 0;
  for (const ref of await pgBranches.getMany(open)) {
    if (models.get(ref.modelId)?.branches.current()?.state === ref.state) continue;
    branchChanged(ref);
    changed += 1;
  }
  if (changed > 0) console.log("[bim-authority] branch state changed elsewhere; told the pages on this machine", { changed });
  return changed;
}

let rechecking = false;
setInterval(() => {
  if (rechecking) return;
  rechecking = true;
  Promise.all([
    recheckAccess().catch((err) => console.error("[bim-authority] access re-check pass failed", err)),
    refreshServedBranchStates().catch((err) => console.error("[bim-authority] reading served branches' states failed; their write fence still refuses a closed branch", err)),
  ]).finally(() => {
    rechecking = false;
  });
}, config.reauthMs);

// ----------------------------------------------------------------- HTTP

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers });
  res.end(JSON.stringify(body));
}

/** Route a request for a model to its owner (DB lookup), or null to serve it here. */
async function routeFor(modelId: string, req: IncomingMessage): Promise<{ status: number; headers: Record<string, string> } | null> {
  const decision = decideRoute({
    selfMachine: config.machineId,
    holder: await routeHolder(sql, modelId),
    alreadyReplayed: typeof req.headers["fly-replay-src"] === "string",
  });
  if (decision.kind === "local") return null;
  if (decision.kind === "retry" || !isFlyMachineId(decision.machine)) {
    counters.routeRetries += 1;
    return { status: 503, headers: { "retry-after": "1" } };
  }
  counters.replays += 1;
  return { status: 409, headers: { "fly-replay": `instance=${decision.machine}` } };
}

async function authorizeBearer(req: IncomingMessage, modelId: string): Promise<boolean> {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  try {
    const login = await verifier.verify(token);
    const authorizer = authorizerFor(login.issuer);
    if (!authorizer) return false;
    const grant = await authorizer.capabilities({ userId: login.userId, modelId: authorizationModelId(modelId), token });
    return grant.ok && grant.capabilities.has("model.edit");
  } catch (err) {
    console.error("[bim-authority] bearer rejected", err instanceof Error ? err.message : err);
    return false;
  }
}

function metrics(): Record<string, unknown> {
  const perModel: Record<string, unknown> = {};
  for (const [id, rt] of models) {
    const { commitMs, joins, schedules, ...counts } = rt.hub.metrics;
    if (commitMs.length > SAMPLE_CAP) commitMs.splice(0, commitMs.length - SAMPLE_CAP);
    const term = rt.store.leaseTerm();
    perModel[id] = {
      ...counts,
      connections: rt.conns.size,
      serverCommitMs: percentiles(commitMs),
      schedules: schedules
        ? (({ buildMs, applyMs, advanceMs, flushMs, ...scheduleCounts }) => ({ ...scheduleCounts, buildMs: percentiles(buildMs), applyMs: percentiles(applyMs), advanceMs: percentiles(advanceMs), flushMs: percentiles(flushMs) }))(schedules)
        : null,
      lastJoins: joins.slice(-5),
      lease: { generation: rt.generation, expiresAt: term?.expiresAt.toISOString() ?? null, fresh: rt.keeper.fresh(), ...rt.keeper.stats },
      paths: rt.store.pathStats,
      changesetWrites: rt.store.writeBytes,
      storage: rt.store.storageFeatures(),
      groupCommit: rt.sequencer.groupCommit()
        ? {
            batches: rt.sequencer.groupStats.batches,
            commits: rt.sequencer.groupStats.commits,
            failures: rt.sequencer.groupStats.failures,
            maxPending: rt.sequencer.groupStats.maxPending,
            fallbacks: rt.sequencer.groupStats.fallbacks,
            batchSize: percentiles(rt.sequencer.groupStats.batchSizes),
            writeMs: percentiles(rt.sequencer.groupStats.flushMs),
            durableRevision: rt.store.durableRevision(),
          }
        : null,
      startup: rt.startup,
      lastHeadLoad: rt.store.lastHeadLoad,
    };
  }
  const sessions = [...sessionReports.values()].map(({ report, actorKind, receivedAt }) => ({ ...report, actorKind, receivedAt, serverRegion: config.region }));
  return {
    service: "bim-authority",
    commit: config.commit,
    app: config.app,
    machine: config.machineId,
    region: config.region,
    owner: config.owner,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
    lease: { ttlMs: config.leaseTtlMs, renewMs: config.leaseRenewMs, processChecksOff: [...processChecksOff] },
    counters,
    auth: { verifyMs: percentiles(timings.verifyMs), capabilitiesMs: percentiles(timings.capabilitiesMs) },
    // hello received → welcome sent, server side. Cold = this join leased, loaded and warmed the model.
    join: { cold: percentiles(timings.joinColdMs), warm: percentiles(timings.joinWarmMs) },
    models: perModel,
    retired: retiredLog,
    sessions,
  };
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error("[bim-authority] request failed", { url: req.url, err });
    if (!res.headersSent) json(res, 500, { error: "Something went wrong on the model server; see its log" });
  });
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, GET, OPTIONS" });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, machine: config.machineId, region: config.region, commit: config.commit, schema: schemaVersion, host: host?.name ?? null });
    return;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    json(res, 200, metrics());
    return;
  }
  // Load and warm a model before anyone waits on it (perf gate: cold vs warm). Editors only.
  const prepare = url.pathname.match(/^\/models\/([^/]+)\/prepare$/);
  if (req.method === "POST" && prepare?.[1]) {
    const modelId = servedModelId(served, decodeURIComponent(prepare[1]));
    if (!modelId) return json(res, 404, { error: "No such model on this server" });
    if (!(await authorizeBearer(req, modelId))) return json(res, 403, { error: "Only people who can edit this model can prepare it" });
    const route = await routeFor(modelId, req);
    if (route) return json(res, route.status, { error: "Ask the server that owns this model" }, route.headers);
    try {
      const { runtime, cold } = await runtimeFor(modelId);
      const t0 = performance.now();
      const head = await runtime.store.head();
      return json(res, 200, { revision: head.revision, cold, headMs: performance.now() - t0, startup: runtime.startup, machine: config.machineId });
    } catch (err) {
      if (err instanceof LeaseHeldError) return json(res, 503, { error: OPENING_ELSEWHERE }, { "retry-after": "1" });
      throw err;
    }
  }
  if (await imports.handle(req, res, url)) return;
  const drop = url.pathname.match(/^\/debug\/models\/([^/]+)\/drop-next-broadcast$/);
  if (config.drills && req.method === "POST" && drop?.[1]) {
    const modelId = servedModelId(served, decodeURIComponent(drop[1]));
    if (!modelId || !(await authorizeBearer(req, modelId))) return json(res, 403, { error: "Only people who can edit this model can run drills" });
    const runtime = models.get(modelId);
    if (!runtime) return json(res, 404, { error: "This server is not serving that model right now" });
    runtime.hub.dropNextBroadcasts(1);
    return json(res, 200, { ok: true, machine: config.machineId });
  }
  const checks = url.pathname.match(/^\/debug\/models\/([^/]+)\/process-lease-checks$/);
  if (config.drills && req.method === "POST" && checks?.[1]) {
    const modelId = servedModelId(served, decodeURIComponent(checks[1]));
    if (!modelId || !(await authorizeBearer(req, modelId))) return json(res, 403, { error: "Only people who can edit this model can run drills" });
    const enabled = url.searchParams.get("enabled") !== "0";
    if (enabled) processChecksOff.delete(modelId);
    else processChecksOff.add(modelId);
    console.error(`[bim-authority] DRILL: in-process lease checks for ${modelId} ${enabled ? "on" : "OFF (database fence only)"}`);
    return json(res, 200, { ok: true, modelId, processLeaseChecks: enabled, machine: config.machineId });
  }
  json(res, 404, { error: "Not found" });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/sync") return rejectUpgrade(socket, 404, "Not Found");
  const requested = url.searchParams.get("model");
  const modelId = requested ? servedModelId(served, requested) : null;
  // Old clients send no model in the address: serve here; if another machine owns it, the hello says so and they retry.
  const routed = modelId ? routeFor(modelId, req) : Promise.resolve(null);
  routed
    .then((route) => {
      if (route) return rejectUpgrade(socket, route.status, route.status === 409 ? "Conflict" : "Service Unavailable", route.headers);
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, requested, url.searchParams.get("project")));
    })
    .catch((err) => {
      console.error("[bim-authority] routing lookup failed", { requested, err });
      rejectUpgrade(socket, 503, "Service Unavailable", { "retry-after": "1" });
    });
});

ensureFirstPartyAddOns();
server.listen(config.port, () => {
  console.log(`[bim-authority] listening on :${config.port} (machine ${config.machineId ?? "local"}, region ${config.region ?? "local"}, commit ${config.commit ?? "unknown"}, lease ${config.leaseTtlMs}/${config.leaseRenewMs} ms)`);
});

// Explicit list only: leasing a model at start is a choice, never "everything in the database".
for (const modelId of config.preload) {
  runtimeFor(modelId).catch((err) => {
    if (err instanceof LeaseHeldError) console.log(`[bim-authority] preload of ${modelId} skipped: ${err.message}`);
    else console.error(`[bim-authority] preload of ${modelId} failed; it will load on first use`, err);
  });
}

function shutdown(signal: string): void {
  console.log(`[bim-authority] ${signal}: releasing ${models.size} model(s)`);
  for (const modelId of [...models.keys()]) retire(modelId, "shutdown");
  // Give the releases a moment to reach the database; a lease left behind expires within the TTL anyway.
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
