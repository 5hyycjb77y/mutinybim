import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { branchModelId, parseBranchModelId } from "@permitzip/bim-kernel";

/**
 * Everything the authority reads from its environment, validated once at start.
 * Names are listed in README.md (configuration) and CREDENTIALS.md (secrets).
 *
 * Secret: MUTINYBIM_DB_URL, the authority's own Postgres (direct connection).
 * Plain configuration: everything else. A host plug-in (MUTINYBIM_AUTHORIZER_MODULE)
 * reads its own settings from the same environment.
 */

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * True when the project ref or any ref-shaped token in the database URL is
 * refused: its SHA-256 digest is listed (a host plug-in lists its production
 * this way), or it is one of `plainRefs` (MUTINYBIM_FORBIDDEN_DB_REFS).
 */
export function isForbiddenDbRef(
  target: { readonly projectRef?: string; readonly dbUrl: string },
  plainRefs: readonly string[] = [],
  digests: readonly string[] = [],
): boolean {
  if (plainRefs.some((ref) => ref === target.projectRef || target.dbUrl.includes(ref))) return true;
  const candidates = target.dbUrl.split(/[^a-z0-9]+/).filter((token) => token.length === 20);
  if (target.projectRef) candidates.push(target.projectRef);
  return candidates.some((ref) => digests.includes(sha256Hex(ref)));
}

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const intFrom = (name: string, fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `${name} must be an integer between ${min} and ${max} (got "${v}")` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  PORT: intFrom("PORT", 8080, 1, 65535),
  MUTINYBIM_DB_URL: z.string().min(1, "MUTINYBIM_DB_URL is required: the authority's own Postgres"),
  /** Supabase project ref the database URL must belong to (guards against pointing at the wrong database). */
  MUTINYBIM_DISPOSABLE_PROJECT_REF: z.string().regex(/^[a-z0-9]{20}$/, "MUTINYBIM_DISPOSABLE_PROJECT_REF must be a 20-character Supabase project ref").optional(),
  /** More Supabase project refs the authority's database must never be (comma-separated). */
  MUTINYBIM_FORBIDDEN_DB_REFS: z.string().optional(),
  /**
   * "1": a test authority on a laptop. Its database must be on this machine and
   * sign-ins may come from a stack on this machine (http://127.0.0.1:<port>).
   * Refused on Fly.
   */
  MUTINYBIM_LOCAL_STACK: z.enum(["0", "1"]).optional(),
  /** The host plug-in (host/contract.ts): a path from the working directory, or a package name. */
  MUTINYBIM_AUTHORIZER_MODULE: z.string().optional(),
  /** The authority database's own Supabase Auth, for seeded test logins (disposable stacks only). */
  MUTINYBIM_SUPABASE_URL: z.string().optional(),
  BIM_AUTHORITY_SERVED_MODELS: z.string().min(1, "BIM_AUTHORITY_SERVED_MODELS must list the model ids this deployment serves"),
  /** Plain names clients ask for → the id stored here, e.g. site-7301=site-7301-b. */
  BIM_AUTHORITY_MODEL_ALIASES: z.string().optional(),
  /** Models to lease and warm at start. Explicit list; empty = load on first use. */
  BIM_AUTHORITY_PRELOAD: z.string().optional(),
  BIM_AUTHORITY_LEASE_TTL_MS: intFrom("BIM_AUTHORITY_LEASE_TTL_MS", 10_000, 2_000, 120_000),
  BIM_AUTHORITY_LEASE_RENEW_MS: intFrom("BIM_AUTHORITY_LEASE_RENEW_MS", 3_000, 500, 60_000),
  /** How often each live connection's access is checked again (live revocation). */
  BIM_AUTHORITY_REAUTH_MS: intFrom("BIM_AUTHORITY_REAUTH_MS", 10_000, 1_000, 300_000),
  BIM_AUTHORITY_PREWARM: z.enum(["0", "1"]).optional(),
  /**
   * Group commit (default on): edits are shown to other people as soon as
   * they are decided and written in batches; the author hears "saved" after
   * the batch is durable. "0" writes each commit on its own before anyone sees it.
   */
  BIM_AUTHORITY_GROUP_COMMIT: z.enum(["0", "1"]).optional(),
  /** Most commits one batch carries. */
  BIM_AUTHORITY_GROUP_MAX: intFrom("BIM_AUTHORITY_GROUP_MAX", 64, 1, 1000),
  /** With no write in flight, wait this long for more edits before writing (0: write at once). */
  BIM_AUTHORITY_GROUP_WINDOW_MS: intFrom("BIM_AUTHORITY_GROUP_WINDOW_MS", 0, 0, 50),
  /** Fault-injection endpoints for drills (members only). Off unless "1". */
  BIM_AUTHORITY_DRILLS: z.enum(["0", "1"]).optional(),
  /** Git commit baked into the image by deploy.sh, reported on /metrics. */
  BIM_AUTHORITY_COMMIT: z.string().optional(),
  FLY_MACHINE_ID: z.string().optional(),
  FLY_REGION: z.string().optional(),
  FLY_APP_NAME: z.string().optional(),
});

export interface AuthorityConfig {
  readonly port: number;
  readonly dbUrl: string;
  readonly dbRef: string;
  /** MUTINYBIM_LOCAL_STACK=1. */
  readonly local: boolean;
  /** The host plug-in to load (MUTINYBIM_AUTHORIZER_MODULE), or null: test logins only. */
  readonly hostModule: string | null;
  /** The authority database's own Auth URL, accepted for seeded test logins only. */
  readonly testAuthUrl: string | null;
  readonly servedModels: ReadonlySet<string>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly preload: readonly string[];
  readonly leaseTtlMs: number;
  readonly leaseRenewMs: number;
  readonly reauthMs: number;
  readonly prewarm: boolean;
  readonly groupCommit: { readonly enabled: boolean; readonly maxBatch: number; readonly windowMs: number };
  readonly drills: boolean;
  readonly commit: string | null;
  /** This process: unique per start, so a restart is a new ownership term. */
  readonly owner: string;
  readonly machineId: string | null;
  readonly region: string | null;
  readonly app: string | null;
}

/** A Supabase project URL: hosted, or on this machine for a laptop test authority. */
export function supabaseUrl(name: string, value: string, local: boolean): string {
  const hosted = /^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(value);
  const onThisMachine = local && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(value);
  if (!hosted && !onThisMachine) throw new Error(`[config] ${name} must be https://<ref>.supabase.co${local ? " or http://127.0.0.1:<port>" : ""} (got "${value}")`);
  return value.replace(/\/$/, "");
}

/** A Postgres URL whose host is this machine. */
function isLocalDbUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch (err) {
    console.error("[config] MUTINYBIM_DB_URL is not a URL", err instanceof Error ? err.message : err);
    return false;
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly forbiddenDbRefDigests?: readonly string[] } = {},
): AuthorityConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`[config] invalid environment:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const e = parsed.data;
  const local = e.MUTINYBIM_LOCAL_STACK === "1";
  if (local && e.FLY_APP_NAME) throw new Error("[config] MUTINYBIM_LOCAL_STACK is for a laptop test authority; it is refused on Fly");
  if (isForbiddenDbRef({ projectRef: e.MUTINYBIM_DISPOSABLE_PROJECT_REF, dbUrl: e.MUTINYBIM_DB_URL }, csv(e.MUTINYBIM_FORBIDDEN_DB_REFS), options.forbiddenDbRefDigests ?? [])) {
    throw new Error("[config] refusing a forbidden database (a host's production) as the authority's database");
  }
  let dbRef: string;
  if (local) {
    if (!isLocalDbUrl(e.MUTINYBIM_DB_URL)) throw new Error("[config] with MUTINYBIM_LOCAL_STACK=1 the database must be on this machine (127.0.0.1)");
    dbRef = "local";
  } else {
    if (!e.MUTINYBIM_DISPOSABLE_PROJECT_REF) throw new Error("[config] MUTINYBIM_DISPOSABLE_PROJECT_REF is required: the Supabase project the database belongs to");
    dbRef = e.MUTINYBIM_DISPOSABLE_PROJECT_REF;
    if (!e.MUTINYBIM_DB_URL.includes(dbRef)) throw new Error(`[config] MUTINYBIM_DB_URL is not on project ${dbRef}`);
  }

  const hostModule = e.MUTINYBIM_AUTHORIZER_MODULE?.trim() || null;

  let testAuthUrl: string | null = null;
  if (e.MUTINYBIM_SUPABASE_URL) {
    testAuthUrl = supabaseUrl("MUTINYBIM_SUPABASE_URL", e.MUTINYBIM_SUPABASE_URL, local);
    // Test logins come only from the authority's own disposable project.
    if (!local && !testAuthUrl.includes(dbRef)) throw new Error(`[config] MUTINYBIM_SUPABASE_URL is not on project ${dbRef}`);
  }
  if (!hostModule && !testAuthUrl) throw new Error("[config] no sign-in source: set MUTINYBIM_AUTHORIZER_MODULE (a host plug-in) and/or MUTINYBIM_SUPABASE_URL (test logins)");

  const servedModels = new Set(csv(e.BIM_AUTHORITY_SERVED_MODELS));
  const aliases = new Map<string, string>();
  for (const pair of csv(e.BIM_AUTHORITY_MODEL_ALIASES)) {
    const [from, to] = pair.split("=").map((s) => s.trim());
    if (!from || !to || !servedModels.has(to)) throw new Error(`[config] BIM_AUTHORITY_MODEL_ALIASES entry "${pair}" must be <name>=<served model id>`);
    aliases.set(from, to);
  }
  const preload = csv(e.BIM_AUTHORITY_PRELOAD);
  for (const id of preload) if (!servedModels.has(id)) throw new Error(`[config] BIM_AUTHORITY_PRELOAD names ${id}, which is not served`);

  // Two renewals must fit inside one lease, or a single slow renewal loses the model.
  if (e.BIM_AUTHORITY_LEASE_RENEW_MS * 2 >= e.BIM_AUTHORITY_LEASE_TTL_MS) {
    throw new Error("[config] BIM_AUTHORITY_LEASE_RENEW_MS must be less than half of BIM_AUTHORITY_LEASE_TTL_MS");
  }
  const machineId = e.FLY_MACHINE_ID ?? null;
  return {
    port: e.PORT,
    dbUrl: e.MUTINYBIM_DB_URL,
    dbRef,
    local,
    hostModule,
    testAuthUrl,
    servedModels,
    aliases,
    preload,
    leaseTtlMs: e.BIM_AUTHORITY_LEASE_TTL_MS,
    leaseRenewMs: e.BIM_AUTHORITY_LEASE_RENEW_MS,
    reauthMs: e.BIM_AUTHORITY_REAUTH_MS,
    prewarm: e.BIM_AUTHORITY_PREWARM !== "0",
    groupCommit: { enabled: e.BIM_AUTHORITY_GROUP_COMMIT !== "0", maxBatch: e.BIM_AUTHORITY_GROUP_MAX, windowMs: e.BIM_AUTHORITY_GROUP_WINDOW_MS },
    drills: e.BIM_AUTHORITY_DRILLS === "1",
    commit: e.BIM_AUTHORITY_COMMIT ?? null,
    owner: `${machineId ?? "local"}/${randomUUID()}`,
    machineId,
    region: e.FLY_REGION ?? null,
    app: e.FLY_APP_NAME ?? null,
  };
}

/**
 * The id stored here for what a client asked for, or null when this deployment
 * does not serve it. A branch (`<base>~<branch>`) is served wherever its base
 * is; whether that branch exists is the database's answer, at open. A host
 * plug-in may serve more models on demand (`servesOnDemand`).
 */
export type ServedModels = Pick<AuthorityConfig, "servedModels" | "aliases"> & { readonly servesOnDemand?: (modelId: string) => boolean };

export function servedModelId(config: ServedModels, requested: string): string | null {
  const branch = parseBranchModelId(requested);
  if (branch) {
    const base = servedModelId(config, branch.baseModelId);
    return base ? branchModelId(base, branch.branchId) : null;
  }
  const id = config.aliases.get(requested) ?? requested;
  if (config.servedModels.has(id)) return id;
  return config.servesOnDemand?.(id) === true ? id : null;
}
