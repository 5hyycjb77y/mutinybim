import type { MergeApprovalSource, ModelAuthorizer } from "@permitzip/bim-sync";
import type { LineageActRecorder, LineageCaller } from "@permitzip/bim-sync/lineages";
import type { Sql } from "../pg-store";

/**
 * The model server's host plug-in point. The server signs people in and asks
 * a ModelAuthorizer (packages/bim-sync/AUTHORIZATION.md) what they may do; a
 * host plug-in supplies both for the product the server runs inside. The open
 * server knows no host: it loads one module named by MUTINYBIM_AUTHORIZER_MODULE
 * at start (`load.ts`), or runs with test logins only (MUTINYBIM_SUPABASE_URL).
 *
 * A host module exports `createModelServerHost(context)` and, optionally,
 * `forbiddenDbRefDigests`. `single-user.ts` is a complete example.
 */

/** Said to the person when the host could not be asked (unreachable, malformed answer). */
export const PERMISSION_CHECK_FAILED = "Couldn't check your project permissions right now. Try again in a moment.";

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Where a host's sign-in tokens come from: tokens whose `iss` is `issuer` are verified against `jwksUrl`. */
export interface SignInSource {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
}

/** A Supabase Auth project as a sign-in source (ES256, published key set). */
export function supabaseSignIn(url: string): SignInSource {
  const base = url.replace(/\/$/, "");
  return { issuer: `${base}/auth/v1`, jwksUrl: `${base}/auth/v1/.well-known/jwks.json`, audience: "authenticated" };
}

/** Which host project a model on this server belongs to (bim.models.host_project_id). */
export interface ModelProjectResolver {
  /** The host project a model belongs to, or null when it isn't linked to one. */
  hostProjectOf(modelId: string): Promise<string | null>;
}

export interface ModelProvisioner {
  /**
   * Create the empty model for this host project if there is none (idempotent).
   * Returns the host project the model is hosted for, which differs from the
   * one asked for when another project with the same number got there first.
   */
  provision(input: { readonly modelId: string; readonly hostProjectId: string; readonly projectNumber: string }): Promise<string | null>;
}

export interface ModelServerHost {
  /** For logs. */
  readonly name: string;
  readonly signIn: SignInSource;
  /**
   * The authorizer for this host's sign-ins. `projectHint` is the project the
   * page named (`?project=`) on a connection, or null (live re-checks, HTTP
   * calls, pages that name none). It is only a candidate: the host confirms it.
   */
  authorizer(projectHint: string | null): ModelAuthorizer;
  /** Models served on demand beyond BIM_AUTHORITY_SERVED_MODELS (each is still authorized per person). */
  servesOnDemand?(modelId: string): boolean;
  /** Who is responsible and who approved, for merges. Absent: merges answer "not available". */
  readonly mergeApprovals?: MergeApprovalSource;
  /**
   * Where a copy's reviews and accept backs are signed (the host's sign-off
   * chain), as the person who asked: `tokenOf` is the sign-in a request came
   * on, or null when that connection has gone. Absent: neither is offered.
   */
  lineageActs?(tokenOf: (caller: LineageCaller) => string | null): LineageActRecorder;
  /** Signed file URLs a linked-model import may read. Absent: none. */
  allowsImportSource?(url: string): boolean;
}

/** What the server hands a host module at start. */
export interface ModelServerHostContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** MUTINYBIM_LOCAL_STACK=1: a laptop test authority (hosts may accept http://127.0.0.1 there). */
  readonly local: boolean;
  /** The authority's own database. */
  readonly sql: Sql;
  readonly hostProjects: ModelProjectResolver;
  readonly provisioner: ModelProvisioner;
  readonly fetch: FetchLike;
}

export interface ModelServerHostModule {
  /** SHA-256 hex digests of database refs the authority must never use as its own database (the host's production). */
  readonly forbiddenDbRefDigests?: readonly string[];
  createModelServerHost(context: ModelServerHostContext): ModelServerHost | Promise<ModelServerHost>;
}
