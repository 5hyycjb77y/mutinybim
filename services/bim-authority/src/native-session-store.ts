import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";

export interface NativeSessionOptions {
  /** Server configuration, never a browser-supplied duration. Default: 5 minutes; maximum: 10 minutes. */
  transactionTtlSeconds?: number;
  /** Default: 8 hours; maximum: 24 hours. Sessions have no sliding renewal. */
  sessionTtlSeconds?: number;
}
export interface SignInProvider {
  issuer: string;
  clientId: string;
  redirectUri: string;
}
export interface StartedSignIn {
  transactionId: string;
  state: string;
  browserBinding: string;
  nonce: string;
  codeChallenge: string;
  expiresAt: Date;
}
export interface ClaimedSignIn extends SignInProvider {
  status: "claimed";
  transactionId: string;
  claimToken: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: Date;
}
export interface VerifiedNativeIdentity {
  /** Exact values from the trusted provider verifier; no case/URL/Unicode normalization. */
  issuer: string;
  subject: string;
  displayName: string;
}
export interface NativeSession {
  sessionId: string;
  personId: string;
  expiresAt: Date;
}
export interface IssuedNativeSession extends NativeSession {
  status: "issued";
  /** Returned only after COMMIT, once. Never logged or stored in plaintext. */
  sessionToken: string;
}
export interface SignInUnavailable { status: "unavailable" }
export interface SignInClaim { transactionId: string; claimToken: string }

/** No SQL, driver detail, parameters or cause: those may contain private protocol values. */
export class NativeSessionStoreError extends Error {
  readonly code = "native_session_storage_unavailable";
  constructor() {
    super("Native sign-in storage is unavailable. Retry safely or start a fresh sign-in.");
    this.name = "NativeSessionStoreError";
  }
}

const unavailable: SignInUnavailable = Object.freeze({ status: "unavailable" });
const expiredDuringCompletion = Symbol("expired during completion");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secret = () => randomBytes(32).toString("base64url");
const digest = (kind: string, value: string) => createHash("sha256")
  .update(`bim-native:${kind}\0`).update(value).digest("hex");
const validToken = (value: string) => typeof value === "string" && value.length === 43 && tokenPattern.test(value);
const validClaim = (claim: SignInClaim) => typeof claim.transactionId === "string"
  && claim.transactionId.length === 36 && uuidPattern.test(claim.transactionId) && validToken(claim.claimToken);

function duration(value: number | undefined, fallback: number, maximum: number): number {
  const seconds = value ?? fallback;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > maximum) throw new TypeError("Invalid native session duration");
  return seconds;
}
function textValue(value: string, field: string, maxBytes: number): void {
  // Reject NUL and malformed UTF-16 instead of letting the driver normalize it.
  if (typeof value !== "string" || !value.length || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maxBytes
      || Buffer.from(value, "utf8").toString("utf8") !== value) throw new TypeError(`Invalid ${field}`);
}

/** Hold the session row through the caller's transaction, including a dependent membership write. */
export async function resolveNativeSessionInTransaction(tx: postgres.TransactionSql, sessionToken: string): Promise<NativeSession | null> {
  if (!validToken(sessionToken)) return null;
  const [row] = await tx<{ session_id: string; person_id: string; revoked_at: Date | null }[]>`
    select session_id, person_id, revoked_at from bim.native_sessions
    where token_digest = ${digest("session", sessionToken)} for share`;
  if (!row || row.revoked_at !== null) return null;
  // A revoke can make the first statement wait. Check the database clock after acquiring the lock.
  const [live] = await tx<{ expires_at: Date }[]>`select expires_at from bim.native_sessions
    where session_id = ${row.session_id}::uuid and expires_at > clock_timestamp()`;
  return live ? { sessionId: row.session_id, personId: row.person_id, expiresAt: live.expires_at } : null;
}

/**
 * Native-only persistence; the caller owns provider verification and cookies.
 * Use a dedicated postgres pool with parameter/debug logging disabled. This
 * store owns each READ COMMITTED transaction; do not pass an outer transaction.
 * All methods are DB-backed (no process-local identity/session/expiry cache).
 */
export class PgNativeSessionStore {
  private readonly transactionTtl: number;
  private readonly sessionTtl: number;

  constructor(private readonly sql: postgres.Sql, options: NativeSessionOptions = {}) {
    this.transactionTtl = duration(options.transactionTtlSeconds, 300, 600);
    this.sessionTtl = duration(options.sessionTtlSeconds, 28_800, 86_400);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch { throw new NativeSessionStoreError(); }
  }

  async startSignIn(input: SignInProvider): Promise<StartedSignIn> {
    const provider = { ...input };
    textValue(provider.issuer, "issuer", 1000);
    textValue(provider.clientId, "client ID", 2000);
    textValue(provider.redirectUri, "redirect URI", 2000);
    const transactionId = randomUUID();
    const state = secret(), browserBinding = secret(), nonce = secret(), codeVerifier = secret();
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    return this.safe(async () => {
      const expiresAt = await this.sql.begin("isolation level read committed", async (tx) => {
        const [row] = await tx<{ expires_at: Date }[]>`
          insert into bim.native_signin_transactions
            (transaction_id, state_digest, browser_binding_digest, issuer, client_id,
             redirect_uri, nonce, code_verifier, created_at, expires_at)
          select ${transactionId}::uuid, ${digest("state", state)}, ${digest("browser", browserBinding)},
            ${provider.issuer}, ${provider.clientId}, ${provider.redirectUri}, ${nonce}, ${codeVerifier},
            at, at + ${this.transactionTtl} * interval '1 second'
          from (select clock_timestamp() as at) as clock
          returning expires_at`;
        if (!row) throw new Error("Transaction was not created");
        return row.expires_at;
      });
      return { transactionId, state, browserBinding, nonce, codeChallenge, expiresAt };
    });
  }

  /** The claim commit is the single-use boundary, BEFORE the provider exchange. */
  async claimSignIn(input: { state: string; browserBinding: string }): Promise<ClaimedSignIn | SignInUnavailable> {
    const { state, browserBinding } = input;
    if (!validToken(state) || !validToken(browserBinding)) return unavailable;
    const claimToken = secret();
    return this.safe(async () => this.sql.begin("isolation level read committed", async (tx) => {
      const [row] = await tx<{
        transaction_id: string; issuer: string; client_id: string; redirect_uri: string;
        nonce: string | null; code_verifier: string | null; status: string;
      }[]>`select transaction_id, issuer, client_id, redirect_uri, nonce, code_verifier, status
        from bim.native_signin_transactions
        where state_digest = ${digest("state", state)}
          and browser_binding_digest = ${digest("browser", browserBinding)} for update`;
      if (!row || row.status !== "pending") return unavailable;
      const [claimed] = await tx<{ expires_at: Date }[]>`
        update bim.native_signin_transactions set status = 'claimed', claimed_at = clock_timestamp(),
          claim_digest = ${digest("claim", claimToken)}, nonce = null, code_verifier = null
        where transaction_id = ${row.transaction_id}::uuid and expires_at > clock_timestamp()
        returning expires_at`;
      if (!claimed) return unavailable;
      if (row.nonce === null || row.code_verifier === null) throw new Error("Missing protocol material");
      return { status: "claimed" as const, transactionId: row.transaction_id, claimToken,
        issuer: row.issuer, clientId: row.client_id, redirectUri: row.redirect_uri,
        nonce: row.nonce, codeVerifier: row.code_verifier, expiresAt: claimed.expires_at };
    }));
  }

  /** Accept only an identity already verified against the claimed protocol context. */
  async completeSignIn(input: SignInClaim & { identity: VerifiedNativeIdentity }): Promise<IssuedNativeSession | SignInUnavailable> {
    if (!validClaim(input)) return unavailable;
    const { transactionId, claimToken } = input;
    const identity = { ...input.identity };
    textValue(identity.issuer, "verified issuer", 1000);
    textValue(identity.subject, "verified subject", 1000);
    textValue(identity.displayName, "display name", 800);
    if ([...identity.displayName].length > 200) throw new TypeError("Invalid display name");
    const sessionId = randomUUID(), sessionToken = secret();
    return this.safe(async () => {
      try {
        return await this.sql.begin("isolation level read committed", async (tx) => {
          const [row] = await tx<{ issuer: string; status: string }[]>`
            select issuer, status from bim.native_signin_transactions
            where transaction_id = ${transactionId}::uuid
              and claim_digest = ${digest("claim", claimToken)} for update`;
          if (!row || row.status !== "claimed" || row.issuer !== identity.issuer) return unavailable;

          // Row lock first, then exactly one pair lock. Hash collisions only
          // serialize unrelated pairs; the indexed exact pair lookup decides identity.
          const pairKey = JSON.stringify(["bim-native-identity", identity.issuer, identity.subject]);
          await tx`select pg_advisory_xact_lock(hashtextextended(${pairKey}, 0))`;
          const [live] = await tx`select 1 from bim.native_signin_transactions
            where transaction_id = ${transactionId}::uuid and expires_at > clock_timestamp()`;
          if (!live) return unavailable;
          const [existing] = await tx<{ person_id: string }[]>`
            select person_id from bim.person_identities where issuer = ${identity.issuer} and subject = ${identity.subject}`;
          let personId = existing?.person_id;
          if (!personId) {
            personId = randomUUID();
            await tx`insert into bim.people(person_id, display_name) values(${personId}::uuid, ${identity.displayName})`;
            await tx`insert into bim.person_identities(issuer, subject, person_id)
              values(${identity.issuer}, ${identity.subject}, ${personId}::uuid)`;
          }
          const [session] = await tx<{ expires_at: Date }[]>`
            insert into bim.native_sessions(session_id, transaction_id, person_id, token_digest, issued_at, expires_at)
            select ${sessionId}::uuid, ${transactionId}::uuid, ${personId}::uuid,
              ${digest("session", sessionToken)}, at, at + ${this.sessionTtl} * interval '1 second'
            from (select clock_timestamp() as at) as clock returning expires_at`;
          // Recheck after all potentially blocking writes, using the DB wall
          // clock rather than transaction-start now() or any process clock.
          const [completed] = await tx`update bim.native_signin_transactions set status = 'completed',
            completed_at = clock_timestamp(), person_id = ${personId}::uuid,
            completed_session_id = ${sessionId}::uuid, claim_digest = null
            where transaction_id = ${transactionId}::uuid and expires_at > clock_timestamp()
            returning transaction_id`;
          if (!completed) throw expiredDuringCompletion; // Roll back person + identity + session too.
          if (!session) throw new Error("Session was not created");
          return { status: "issued" as const, sessionId, personId, sessionToken, expiresAt: session.expires_at };
        });
      } catch (error) {
        if (error === expiredDuringCompletion) return unavailable;
        throw error;
      }
    });
  }

  /** Provider failure: optional explicit closure; never makes a claim reusable. */
  async abandonSignIn(input: SignInClaim): Promise<void> {
    if (!validClaim(input)) return;
    const { transactionId, claimToken } = input;
    await this.safe(async () => {
      await this.sql.begin("isolation level read committed", async (tx) => {
        await tx`update bim.native_signin_transactions set status = 'failed',
          failed_at = clock_timestamp(), claim_digest = null
          where transaction_id = ${transactionId}::uuid and status = 'claimed'
            and claim_digest = ${digest("claim", claimToken)}`;
      });
    });
  }

  async resolveSession(sessionToken: string): Promise<NativeSession | null> {
    if (!validToken(sessionToken)) return null;
    return this.safe(() => this.sql.begin("isolation level read committed", (tx) => resolveNativeSessionInTransaction(tx, sessionToken)));
  }

  /** Idempotent, including unknown or expired tokens; never reveals whether a token existed. */
  async revokeSession(sessionToken: string): Promise<void> {
    if (!validToken(sessionToken)) return;
    await this.safe(async () => {
      await this.sql.begin("isolation level read committed", async (tx) => {
        const [row] = await tx<{ session_id: string }[]>`select session_id from bim.native_sessions
          where token_digest = ${digest("session", sessionToken)} for update`;
        if (row) await tx`update bim.native_sessions set revoked_at = coalesce(revoked_at, clock_timestamp())
          where session_id = ${row.session_id}::uuid`;
      });
    });
  }
}
