import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BRANCHES_IMPORT_FEATURE, parseBranchModelId, type Actor, type BranchRef, type IfcImportReport, type ImportSource, type ModelState } from "@permitzip/bim-kernel";
import { BRANCH_NAME_TAKEN, BranchRefusal } from "@permitzip/bim-sync";
import { ConvertRefusal, type ConvertInput, type RunningConvert } from "./convert";
import { ImportRefusal, landImportOnBranch, type ImportLandDeps } from "./land";
import type { ImportRunRow, ImportRunStore } from "./runs";

/**
 * The model server's import endpoints (round 9 I9), people only:
 *
 *   POST /models/:model/import             start (anyone who can read Main)
 *   GET  /models/:model/import/:run        progress and report (the person who started it)
 *   POST /models/:model/import/:run/cancel stop it
 *
 * The host calls them as the person (their own sign-in), after recording the
 * data-use agreement and minting a short-lived address for the file. The
 * server converts, makes the branch and lands the records itself; nothing
 * on the wire becomes a record.
 */

export interface ImportLogin {
  readonly userId: string;
}

export interface ImportServiceDeps {
  readonly runs: ImportRunStore;
  /** The verified login behind a bearer token, or null. */
  verify(token: string): Promise<ImportLogin | null>;
  /** Whether that login may read the model (its base for a branch). */
  canRead(login: ImportLogin, modelId: string, token: string): Promise<boolean>;
  /** The served model id for an address segment (aliases), or null. */
  servedModelId(requested: string): string | null;
  /** Main's head, on this server (it leases the model if it has to). */
  mainHead(modelId: string): Promise<ModelState>;
  /** Branch creation and the branch's sequencer, for one Main. */
  landDeps(modelId: string): ImportLandDeps;
  convert(input: ConvertInput): RunningConvert;
  /** Only the host's storage addresses are fetched (its plug-in's `allowsImportSource`). */
  allowedSource(url: string): boolean;
}

const startSchema = z.object({
  name: z.string().trim().min(1).max(70),
  personName: z.string().trim().min(1).max(80),
  referenceId: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  disciplines: z.array(z.string().min(1).max(100)).max(20),
  sourceUrl: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The host's own record of this import, kept with the run. */
  hostJobId: z.string().min(1).max(200).optional(),
  /** Earlier name of `hostJobId`, still read while older pages and hosts send it. */
  hoursJobId: z.string().min(1).max(200).optional(),
  placement: z.object({ dx: z.number().finite(), dy: z.number().finite(), dz: z.number().finite(), rotationDeg: z.number().finite() }).optional(),
});

export type ImportStartBody = z.infer<typeof startSchema>;

export interface ImportProgress {
  readonly runId: string;
  readonly status: ImportRunRow["status"];
  readonly total: number;
  readonly landed: number;
  readonly branch: BranchRef | null;
  readonly report: IfcImportReport | null;
  readonly error: string | null;
  readonly feature: typeof BRANCHES_IMPORT_FEATURE;
}

interface Live {
  readonly run: ImportRunRow;
  cancelled: boolean;
  convert: RunningConvert | null;
  branch: BranchRef | null;
  landed: number;
  total: number;
  status: ImportRunRow["status"];
  report: IfcImportReport | null;
  error: string | null;
}

const NOT_FOUND = "That import isn't on this model server (it may have restarted). Start Propose changes again.";
const STOPPED_ON_RESTART = "The model server restarted while this ran. Whatever landed is on the branch; start Propose changes again for a complete one.";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.byteLength;
    if (size > limit) throw new ImportRefusal("That request is too large.");
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    console.error("[bim-authority/import] a start request wasn't JSON", { err });
    throw new ImportRefusal("That request wasn't readable. Reload the page and try again.");
  }
}

export class ImportService {
  private readonly live = new Map<string, Live>();

  constructor(private readonly deps: ImportServiceDeps) {}

  /** Handle the request when it is one of ours; false: not an import address. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = url.pathname.match(/^\/models\/([^/]+)\/import(?:\/([0-9a-f-]{36})(\/cancel)?)?$/);
    if (!m?.[1]) return false;
    const modelId = this.deps.servedModelId(decodeURIComponent(m[1]));
    if (!modelId || parseBranchModelId(modelId)) {
      json(res, 404, { error: "Propose changes starts from a project's main model on this server." });
      return true;
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const login = token ? await this.deps.verify(token) : null;
    if (!login) {
      json(res, 401, { error: "Sign in again: this request carried no login the model server accepts." });
      return true;
    }
    try {
      if (req.method === "POST" && !m[2]) {
        if (!(await this.deps.canRead(login, modelId, token))) {
          json(res, 403, { error: "You can't open this model, so you can't propose changes to it. Ask a project admin to add you." });
          return true;
        }
        const body = startSchema.safeParse(await readBody(req));
        if (!body.success) {
          json(res, 400, { error: "That request is missing what it needs (the linked model and its file). Reload the page and try again." });
          return true;
        }
        if (!this.deps.allowedSource(body.data.sourceUrl)) {
          json(res, 400, { error: "The linked model's file must come from this project's storage." });
          return true;
        }
        const runId = await this.start(modelId, login, body.data);
        json(res, 202, { runId, feature: BRANCHES_IMPORT_FEATURE });
        return true;
      }
      if (req.method === "GET" && m[2] && !m[3]) {
        const progress = await this.progress(m[2], login);
        if (!progress) json(res, 404, { error: NOT_FOUND });
        else json(res, 200, progress);
        return true;
      }
      if (req.method === "POST" && m[2] && m[3]) {
        const stopped = this.cancel(m[2], login);
        if (!stopped) json(res, 404, { error: NOT_FOUND });
        else json(res, 200, { ok: true });
        return true;
      }
      json(res, 405, { error: "Not allowed" });
      return true;
    } catch (err) {
      if (err instanceof ImportRefusal) {
        json(res, 409, { error: err.message });
        return true;
      }
      throw err;
    }
  }

  async start(modelId: string, login: ImportLogin, body: ImportStartBody): Promise<string> {
    const runId = randomUUID();
    const row: ImportRunRow = {
      id: runId,
      baseModelId: modelId,
      branchModelId: null,
      createdBy: login.userId,
      referenceId: body.referenceId,
      sourceVersionId: body.versionId,
      sourceSha256: body.sha256,
      hostJobId: body.hostJobId ?? body.hoursJobId ?? null,
      status: "converting",
      total: 0,
      landed: 0,
      report: null,
      error: null,
    };
    await this.deps.runs.create(row);
    const live: Live = { run: row, cancelled: false, convert: null, branch: null, landed: 0, total: 0, status: "converting", report: null, error: null };
    this.live.set(runId, live);
    console.log("[bim-authority/import] started", { runId, modelId, referenceId: body.referenceId, versionId: body.versionId });
    void this.run(live, modelId, { id: login.userId, name: body.personName, kind: "human" }, body).catch((err: unknown) => {
      console.error("[bim-authority/import] the run failed", { runId, modelId, err });
    });
    return runId;
  }

  private async run(live: Live, modelId: string, actor: Actor, body: ImportStartBody): Promise<void> {
    const finish = async (patch: Partial<Pick<Live, "status" | "report" | "error">>) => {
      Object.assign(live, patch);
      await this.deps.runs.update(live.run.id, { status: live.status, landed: live.landed, total: live.total, ...(live.branch ? { branchModelId: live.branch.modelId } : {}), ...(live.report ? { report: live.report } : {}), ...(live.error ? { error: live.error } : {}) });
      console.log("[bim-authority/import] finished", { runId: live.run.id, status: live.status, landed: live.landed, total: live.total, branch: live.branch?.modelId ?? null });
    };
    let source: ImportSource;
    try {
      live.convert = this.deps.convert({ url: body.sourceUrl, sha256: body.sha256, read: { sourceId: body.versionId, label: body.label, disciplines: body.disciplines, ...(body.placement ? { placement: body.placement } : {}) } });
      source = await live.convert.result;
    } catch (err) {
      if (live.cancelled) return finish({ status: "cancelled", error: "Stopped. Nothing was converted and Main didn't change." });
      console.error("[bim-authority/import] reading the linked model failed", { runId: live.run.id, err });
      return finish({ status: "failed", error: err instanceof ConvertRefusal ? err.message : "The linked model couldn't be read. Try again; if it keeps happening, tell the software team." });
    } finally {
      live.convert = null;
    }
    if (live.cancelled) return finish({ status: "cancelled", error: "Stopped. Nothing was converted and Main didn't change." });
    live.status = "landing";
    await this.deps.runs.update(live.run.id, { status: "landing" });
    try {
      const main = await this.deps.mainHead(modelId);
      const base = this.deps.landDeps(modelId);
      const deps: ImportLandDeps = {
        ...base,
        createBranch: async (input) => {
          try {
            return await base.createBranch(input);
          } catch (err) {
            if (err instanceof BranchRefusal && err.message === BRANCH_NAME_TAKEN) return base.createBranch({ ...input, name: `${input.name} ${live.run.id.slice(0, 4)}` });
            throw err;
          }
        },
      };
      const result = await landImportOnBranch(deps, {
        main,
        source,
        referenceId: body.referenceId,
        sourceKey: body.versionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "src",
        branchName: body.name,
        actor,
        isCancelled: () => live.cancelled,
        onProgress: (p) => {
          live.landed = p.landed;
          live.total = p.total;
          live.branch = p.branch;
          if (p.branch) void this.deps.runs.update(live.run.id, { branchModelId: p.branch.modelId, total: p.total, landed: p.landed }).catch((err: unknown) => console.error("[bim-authority/import] saving progress failed", { runId: live.run.id, err }));
        },
      });
      if (result.status === "nothing") return finish({ status: "failed", report: result.report, error: "Nothing in this linked model could be converted, so no branch was made. The report says why for each kind of item." });
      if (result.status === "cancelled") return finish({ status: "cancelled", report: result.report, error: "Stopped. The half-made branch was closed; Main didn't change." });
      live.branch = result.branch;
      return finish({ status: "done", report: result.report });
    } catch (err) {
      console.error("[bim-authority/import] landing the import failed", { runId: live.run.id, err });
      return finish({ status: "failed", error: err instanceof ImportRefusal || err instanceof BranchRefusal ? err.message : "The branch couldn't be made on the model server. Try again; if it keeps happening, tell the software team." });
    }
  }

  async progress(runId: string, login: ImportLogin): Promise<ImportProgress | null> {
    const live = this.live.get(runId);
    if (live) {
      if (live.run.createdBy !== login.userId) return null;
      return { runId, status: live.status, total: live.total, landed: live.landed, branch: live.branch, report: live.report, error: live.error, feature: BRANCHES_IMPORT_FEATURE };
    }
    const row = await this.deps.runs.get(runId);
    if (!row || row.createdBy !== login.userId) return null;
    const stale = row.status === "converting" || row.status === "landing";
    const branch = row.branchModelId ? branchRefOf(row) : null;
    return { runId, status: stale ? "failed" : row.status, total: row.total, landed: row.landed, branch, report: row.report, error: stale ? STOPPED_ON_RESTART : row.error, feature: BRANCHES_IMPORT_FEATURE };
  }

  cancel(runId: string, login: ImportLogin): boolean {
    const live = this.live.get(runId);
    if (!live || live.run.createdBy !== login.userId) return false;
    live.cancelled = true;
    live.convert?.cancel();
    console.log("[bim-authority/import] cancel asked", { runId, status: live.status });
    return true;
  }
}

/** A minimal branch reference from a finished run's row (the page only needs its id to open it). */
function branchRefOf(row: ImportRunRow): BranchRef | null {
  const parsed = row.branchModelId ? parseBranchModelId(row.branchModelId) : null;
  if (!parsed || !row.branchModelId) return null;
  return { branchId: parsed.branchId, modelId: row.branchModelId, baseModelId: row.baseModelId, baseRevision: 0, name: "Proposal", createdBy: row.createdBy, createdAt: "", state: "open" };
}
