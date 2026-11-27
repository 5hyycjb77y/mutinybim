# Native browser sign-in persistence

`src/native-session-store.ts` stores sign-in transactions and opaque sessions
for standalone PostgreSQL. The running authority resolves those sessions at
WebSocket admission and on each live recheck in `src/auth/native-socket.ts`.

## Installation and authority

Apply `20261125020000_native_signin_sessions.sql` after the reviewed
`20261125010000_native_model_storage.sql`:

```sh
cd services/bim-authority
node --import tsx src/migrate.ts --native --dry-run
node --import tsx src/migrate.ts --native
```

The existing migrator selects this additive file for both installation
streams. On a native database it adds `bim.native_signin_transactions` and
`bim.native_sessions`, their constraints and indexes. On a hosted database it
returns without schema changes; only its normal migration ledger entry is
added. The default hosted command and all historical SQL remain unchanged.
Do not construct this native store against a hosted database.

The trusted owning database role runs the native store, matching the native
installer's boundary. Both tables have RLS enabled, no browser policies,
and no PUBLIC or nonowner anon/authenticated/service_role grants. The owning
role stays trusted regardless of its name. A dedicated role with
different privileges needs its own reviewed deployment configuration. The
store accepts a top-level `postgres.Sql` pool and owns each READ COMMITTED
transaction; do not pass a transaction belonging to a caller.

## Handler-facing interface

```ts
import postgres from "postgres";
import { PgNativeSessionStore } from "./src/native-session-store";

const sql = postgres(databaseUrl, {
  // Configure the installation's existing connection/TLS rules here.
  max: 10,
  debug: false,
  onnotice: () => undefined,
});
const sessions = new PgNativeSessionStore(sql, {
  transactionTtlSeconds: 300,
  sessionTtlSeconds: 28_800,
});
```

Durations are trusted server configuration. Transaction lifetime is 1–600
seconds (default 300); session lifetime is 1–86,400 seconds (default 28,800).
There is no sliding session renewal or process-local session cache.

| Method | Trusted input | Result |
| --- | --- | --- |
| `startSignIn({ issuer, clientId, redirectUri })` | Exact configured provider and callback | `transactionId`, random `state`, random `browserBinding`, random `nonce`, S256 `codeChallenge`, database `expiresAt` |
| `claimSignIn({ state, browserBinding })` | Callback state and the initiating browser's binding | `claimed` with server-only `claimToken`, `codeVerifier`, `nonce`, provider fields, ID and expiry; otherwise `unavailable` |
| `completeSignIn({ transactionId, claimToken, identity })` | Retained claim capability and already verified `{ issuer, subject, displayName }` | `issued` with one raw `sessionToken`, session ID, person ID and expiry; otherwise `unavailable` |
| `abandonSignIn({ transactionId, claimToken })` | Retained server-only claim capability | Closes a claimed transaction as `failed`; safe to repeat |
| `resolveSession(sessionToken)` | Opaque bearer presented by the client | Session ID, person ID and expiry, or `null` |
| `revokeSession(sessionToken)` | Opaque bearer presented at sign-out | Records revocation and accepts repeated sign-out requests |

All successful mutation results are returned only after the driver's COMMIT
acknowledgement. No caller receives a usable session before commit. Invalid
opaque-token syntax is rejected before any SQL. Operational errors are
replaced by `NativeSessionStoreError` with a fixed message and code
`native_session_storage_unavailable`; driver detail, query, parameters and
cause are not forwarded. Such an error does **not** prove that COMMIT failed.
Provider-field validation errors name the invalid field without echoing it.

The provider fields must be configured by the authority. The callback must
not choose its own issuer, client ID or redirect URI. The store treats
`identity` as the provider verifier's trusted output: it does not authenticate
a browser-supplied identity object. In v1 one configured OIDC provider belongs
to the installation. Supporting multiple issuer strings in persistence
preserves identity separation across tests or a reviewed provider change.

### Browser and exchange sequence

1. Call `startSignIn`. Keep `browserBinding` in a short-lived, Secure,
   HttpOnly cookie associated with this transaction and this browser. The
   handler must support overlapping transactions without silently overwriting
   their bindings. Put state, nonce and the S256 challenge into the provider's
   authorization request. Choose cookie SameSite behavior for the actual
   callback transport; a typical GET redirect uses Lax.
2. On callback, call `claimSignIn` with the returned state and cookie binding.
   A wrong binding changes nothing, so it cannot consume another browser's
   transaction. `unavailable` means do not exchange the authorization code.
3. `claimed` means the claim has committed. Only this caller receives the
   verifier and nonce. Keep its capability and private material in the trusted
   handler; never return them to the browser or record the result object in
   logs. Exchange the code using the exact stored callback/client context.
4. The provider verifier must check the signature, allowed algorithm/key,
   issuer, audience/authorized party, time claims and the returned nonce. Only
   after verification call `completeSignIn`. Its issuer must exactly match the
   claimed issuer. The store does not perform provider HTTP calls.
5. On `issued`, clear the transaction cookie. The editor
   delivers the session token to page memory through the sign-in completion
   response. Keep it out of URLs. The editor presents it in the existing
   WebSocket `hello`. Admission and live rechecks resolve the session using
   its server expiry, then look up the person's rights on the model or copy.
6. **Manage → Sign out** closes this tab’s editor and socket. The editor posts
   its bearer to the same-origin `/auth/native/sign-out`. The authority
   waits for `revokeSession` before returning 204. If confirmation is lost,
   the tab retries once with the same bearer and offers **Retry sign-out**
   if needed. Its other browser sessions can continue working.

Route-level CSRF protection, cookie/path/domain choices, request logging
redaction and safe post-login redirects belong to the browser integration.

## Single use, interruption and recovery

The transaction becomes single-use at the **claim commit**, before any
external exchange. The row moves from `pending` to `claimed`; its live nonce
and verifier columns are cleared, and only a completion-capability digest is
retained. There is no lease expiry or recovery path back to `pending`.
Expiration does not authorize a second exchange.

| Interruption or competing call | Durable outcome and handler action |
| --- | --- |
| Start/claim reply lost or commit unknown | Discard any uncertain local result and start a fresh transaction. No exchange without a confirmed claim response. |
| Exchange fails, process dies, or provider reply is uncertain | Optionally abandon with the retained capability; start a fresh transaction. Never repeat an uncertain exchange using the old transaction. |
| Provider result verified, completion definitely rolls back | Person/identity/session/completion changes all roll back. A process retaining the same verified result and claim capability may retry completion before expiry, without repeating the exchange. |
| Completion commit or reply uncertain | The same bounded retry is safe: it either issues after a rollback, or returns `unavailable` after an earlier commit. If unavailable, state was lost, or another error occurs, start a fresh sign-in. |
| Two completions for one transaction overlap | One returns `issued`; the other returns `unavailable`. The database contains exactly one session for that transaction. |
| Successful commit but browser loses the reply | The old bearer is unrecoverable because only its digest was persisted. A fresh verified sign-in returns the same person ID and a new usable session. The inaccessible old session remains expiry-bound; this operation does not revoke other sessions. |
| Authority or database restarts | A still-live pending transaction can be claimed with its original binding. Claimed transactions never reopen. A holder of a previously issued bearer resolves the same committed session. Revocation survives restart. |

The store returns no old bearer on a duplicate completion. It makes no
exactly-once claim about an external provider exchange or HTTP delivery.

## Concurrency, identity and clock

Completion locks the sign-in row, then acquires one transaction-scoped
advisory lock for a length-unambiguous encoding of the exact issuer/subject
pair. It rereads the indexed identity under that lock. Hash collisions cause
extra serialization, never identity equivalence. Two valid transactions for
the same first-time identity therefore produce one person and two separate
sessions. Different issuers with the same subject remain different people.

No URL, case, whitespace or Unicode normalization is applied. Issuer and
subject are nonempty valid Unicode strings, each at most 1,000 UTF-8 bytes,
with NUL rejected. These bounds also fit the existing compound identity
index. Display names are at most 200 characters/800 UTF-8 bytes; an existing
person's name is not silently rewritten on each sign-in. Identity changes
by an operator must coordinate with the same store boundary; a conflicting
external insert fails and rolls back rather than orphaning a new person.

Session insertion, any new person/identity, and transaction completion share
one database transaction. A unique transaction ID in `native_sessions` and
deferred reciprocal foreign keys bind the completed transaction to that
exact session and person. Completion never writes `model_members`,
`model_authority` or `legacy_identity_mappings`. A coincident email, display
name or historical actor string is not a legacy mapping. An operator must
record any reviewed mapping explicitly.

PostgreSQL's `clock_timestamp()` decides both transaction and session
expiry, with strict `expires_at > clock_timestamp()` checks. The process
clock is irrelevant. Completion checks after the row and identity lock
waits and again after its potentially blocking writes. If the last guard
finds expiry, it rolls the whole attempt back. This is validity at the
guarded database statement; COMMIT acknowledgement or HTTP delivery can
happen after that deadline. An old `now()` value taken at transaction start
would incorrectly extend a deadline while waiting for locks.

Session resolution holds a shared row lock and checks time in the following
statement, so waiting for a revoker cannot extend session validity.
Revocation takes an exclusive row lock and preserves its first timestamp.
A lookup ordered after a successful revocation commit returns no session,
including in a fresh process. A lookup that won the lock first may return
before the concurrent revoke completes. An admitted native WebSocket closes
on the live check that observes revocation or expiry.

## Sensitive material and retention

State, browser binding, completion capability and session bearer use separate
32-byte random values. Domain-separated SHA-256 digests identify them in
storage. The 43-character session token is an opaque bearer with 256 bits of
randomness; it contains no person ID or claims. The PKCE verifier and nonce
are private protocol values stored only in the live pending row. Claiming
clears those columns, not PostgreSQL WAL, snapshots or backups.

Keep pool `debug`/parameter logging disabled. Database statement/error
logging must also avoid parameter values for this pool, and route-level
logs must exclude callbacks, cookies and result objects. The store itself
does not log. Evidence fixtures report statuses, synthetic IDs, counts and
nonsecret hashes rather than raw tokens, verifiers or nonce values.

The authority logs a failed browser sign-in with its stage and a short reason.
An origin mismatch also names the configured editor origin and the browser's
origin. Open the configured address. For a discovery mismatch, compare the
configured issuer with the provider's discovery document, including any
trailing slash.

This change does not schedule retention. An expired pending row can be
deleted by the operator's retention job. Retiring a completed transaction
and its session requires deleting both in one transaction because their
deferred foreign keys prevent half-removal. Do not delete identities or
people as session cleanup. Protect backups as part of the trusted database
boundary and decide retention before production deployment.

## Browser sign-in and the East plant walkthrough

In native mode, set `MUTINYBIM_OIDC_ISSUER`, `MUTINYBIM_OIDC_CLIENT_ID`
and `MUTINYBIM_EDITOR_ORIGIN` on the authority. Register the editor's
`/auth/native/callback` URL with the provider. A confidential client can set
`MUTINYBIM_OIDC_CLIENT_SECRET` for HTTP Basic authentication at the token endpoint.
With `BIM_DEV_NATIVE_SIGNIN=1` and `BIM_DEV_AUTHORITY_URL` set to the authority
WebSocket, the standalone editor serves the callback and forwards the two same-origin
sign-in requests. HTTP is supported on loopback in local-stack mode. The tab
keeps the active transaction and return path across the redirect. The session
credential stays in page memory. Reloading the page starts a fresh sign-in.

### Manage members in the standalone editor

Open **Manage → Manage members**. Every signed-in person can copy their own
person ID here. The owner or a manager can see the model roster and look up a
coworker by their exact ID after that person has signed in. Use **Change role**
for an existing member. The owner can appoint managers. A manager can grant,
change or remove viewer and editor access. The owner and the caller's own
membership are protected. On a proposal this control manages the base model.

Choose the new role, select **Review change**, then **Confirm change**. The
server checks the role seen at review against the role in PostgreSQL. If they
differ, the dialog shows the role at review, the current role and the requested
role. **Keep current role** returns to the roster. **Review again** starts from
the returned role and requires another confirmation. A fresh review also lets
the caller go back and choose a different role. Connected editors apply saved
access changes on their next permission check.

The native bearer endpoint `GET /models/{baseModel}/members` reads that model's
roster for its owner and managers. The optional `personId` query reads one exact
ID and returns a null role for a known person who has no membership there.
`POST` accepts the person ID, expected role and requested role. A conflict
returns HTTP 409 with the current role and preserves the authorization revision.

### A model save during a role change

Standalone saves take a shared lock on the base model’s authority row before
reading the author’s rights on the exact copy. Membership updates take an
exclusive row lock there. PostgreSQL holds the locks through commit. If an
authorized edit commits first, its receipt gives its model revision. If a
downgrade commits first and takes away write access on that copy, the save
records a refusal and leaves the model revision alone. Both decisions store
the membership revision they observed. Each new edit still uses the normal
copy resolver, so a base viewer can save to their own writable proposal.

The native sequencer uses the locked single-edit path even when group commit
is configured. It broadcasts an edit only after PostgreSQL commits, so peers
cannot build on a preview that the permission check might refuse. This trades
batch throughput for a defined commit order. A hosted authority continues to
use its configured commit strategy and permission provider.

A read-only tab with an outstanding edit asks for a receipt using the original
key and command digest. The server checks the session, author and copy read
access. The browser retries the receipt read if the response is lost. A
missing record keeps the save unconfirmed. An open tab retains its request
through reconnect and authority restart. Reloading or closing the tab clears
its in-memory requests.

Viewer refusals are stored in `bim.command_outcomes` with other save outcomes.
The standalone stack leaves cleanup of outcomes, sign-in transactions and
sessions to the operator. The existing receipt purge defaults to 24 hours when invoked. A committed
changeset can still prove the original save after its receipt expires if the
changeset is retained. A refusal can be recovered while its receipt remains.
The editor treats a missing receipt and a matching element value as
insufficient evidence to announce a final outcome.

### Browser drill

From the repo root, the following command uses PostgreSQL 17 on PATH, Playwright
and an installed Chrome. `--pg-bin` and `--playwright-module` accept explicit
tool paths. Omit `--browser-channel` to use Playwright's own Chromium.

```sh
python3 services/bim-authority/drills/native-install.py --browser --browser-channel chrome
```

The drill starts a disposable database and loopback development issuer. Mara and
Jules sign in using separate Chrome profiles. The operator designates Mara as
owner, and her browser grants Jules viewer access through `POST /models/east-plant/members`.
A stale grant returns the current role and HTTP 409. Confirming the existing
viewer role returns `unchanged`. Both leave the authorization revision intact.
Mara saves a sheet in the editor. After an authority restart, Jules opens the
same sheet with the original session. The drill checks the read-only controls,
the server's response to a viewer save and the final PostgreSQL revision.
The owner promotes Jules, demotes Jules and removes the membership through the
same endpoint. The editor applies each new grant on recheck. `--screenshots
<directory>` saves the owner and viewer sheet views.
The earlier [socket drill](README.md#native-postgresql-installation) also covers
expiry and revocation.

### Compose install and upgrade walkthrough

From the candidate checkout, supply a clean pre-#36 checkout and a fresh
output directory. Use Node 22 with the repository dependencies, Playwright
with Chromium, Python 3, and a disposable Docker context with Compose 2.23.1
or later. The walkthrough uses loopback ports 3095, 8080, 9999, 8180 and
8065. It builds the application images, creates randomly named test projects
and removes their volumes after each scenario.

```sh
python3 services/bim-authority/drills/native-compose.py \
  --previous-checkout /path/to/previous/mutinybim --output /tmp/east-plant-results
```

The native run starts with an empty database, designates an owner through
the CLI, and changes a coworker’s role in the editor. It restarts PostgreSQL
and the authority and checks sign-out after a lost reply. It repeats with
Keycloak using the same built images. Use `--playwright-module` for an
existing Playwright installation and `--browser-channel chrome` for Chrome.

The upgrade run creates data in the previous version, preserves that volume,
then starts the candidate. Both the local demo login and a real Supabase
Auth instance use the existing demo project's membership through the public
authority interfaces. The checks compare model history, project membership,
policies and migration records, then reconnect members and nonmembers.
`--only native` and `--only upgrade` run the two groups independently.

The independent `native-sessions-*` drill and bounded model in the handoff
package exercise real PostgreSQL 17, deterministic overlapping connections,
rollback, lost completion reply, database/process restart, and populated
native/hosted upgrades. The focused unit suite covers input boundaries and
error redaction. Read the handoff results for exact versions, commands,
observations and test limits.

PostgreSQL references: [date/time functions](https://www.postgresql.org/docs/17/functions-datetime.html),
[explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html),
and [READ COMMITTED isolation](https://www.postgresql.org/docs/17/transaction-iso.html).
