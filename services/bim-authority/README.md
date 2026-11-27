# MutinyBIM model authority

The server that people's browsers and their agents edit a MutinyBIM model
through. One process per machine; each model is served by exactly one process
at a time (the one holding its lease). Every edit is in Postgres before its
author is told "saved". Other people see it as soon as it is decided (group
commit); if the process dies before the write, they reload the durable model.

It imports the engine packages by path (`packages/bim-kernel`,
`packages/bim-sync`). It knows no host product: who may sign in and what they
may do comes from a **host plug-in** loaded at start (`MUTINYBIM_AUTHORIZER_MODULE`,
the contract in `src/host/contract.ts`, the rules in
`packages/bim-sync/AUTHORIZATION.md`, "Hosts"). Without one it accepts the
disposable stack's test logins only. `src/host/single-user.ts` is a complete
example host (one person, every right).

## What it guarantees

| Promise | How |
| --- | --- |
| Nobody touches a model before signing in | The first message must be `hello`. The token is verified (the host plug-in's sign-in keys, or the disposable stack's ES256 keys) and the person's capabilities are fetched **before** this process leases, loads or warms the model. Preload is an explicit list (`BIM_AUTHORITY_PRELOAD`), never "everything". |
| One owner per model | `bim.models.lease_owner / lease_owner_machine / lease_expires_at / lease_generation`, judged by the **database clock** (`clock_timestamp()`). Acquire only when free, expired, or already ours. Renewal (every 3 s, lease 10 s) keeps the generation; every new term, including a reacquire after expiry, increments it. |
| A stale owner can't write | Every durable write (`guardedWrite`, `guardedReject`, the locked fallback) checks owner, generation and `lease_expires_at > clock_timestamp()` **in the same SQL statement**. A process stopped past its lease is refused even when nobody has taken over. |
| Renewal failure stops commits | `LeaseKeeper`: a refused renewal, or no successful renewal for TTL − one renewal interval, halts the hub (commands answer "not saved yet"), tells clients plainly, closes their sockets and releases the lease. |
| Clients reach the owner | The socket address carries `?model=`. On upgrade the server looks the holder up in the database and answers `fly-replay: instance=<machine>`. A client header (`fly-force-instance-id`) only picks which machine asks; it is never trusted. |
| Access can be removed mid-session | The authority rechecks live connections every `BIM_AUTHORITY_REAUTH_MS` (10 s by default). Losing read access closes the socket. Losing edit access makes the connection read-only. Hosted JWTs refresh shortly before expiry. A native session closes when a check observes expiry or sign-out. |
| Agents are separate identities | `agent:<userId>:<runId>`, bound to the signed-in person (`packages/bim-sync/src/agent-principal.ts`); each run is its own editing session. |
| Same person, two tabs | Each client has its own `clientSessionId`; the kernel only skips conflict checks for earlier edits from the **same** session (`packages/bim-kernel/src/changeset.ts`). |

## Configuration

Validated at start (`src/config.ts`); anything wrong stops the process with a list.

| Name | Kind | Meaning |
| --- | --- | --- |
| `MUTINYBIM_DB_URL` | secret | The authority's own Postgres, direct connection. A host plug-in's production database is refused (`forbiddenDbRefDigests`), as is any ref in `MUTINYBIM_FORBIDDEN_DB_REFS`. |
| `MUTINYBIM_AUTH_MODE` | config | Defaults to `hosted`. Set `native` for WebSocket sessions issued by a standalone installation. Startup checks the database's installation mode. |
| `BIM_AUTHORITY_BIND_HOST` | config | Optional listen address. Use `127.0.0.1` for a loopback-only walkthrough. |
| `MUTINYBIM_DISPOSABLE_PROJECT_REF` | config | The Supabase project the database URL must belong to. |
| `MUTINYBIM_AUTHORIZER_MODULE` | config | The host plug-in: a path from the working directory, or a package name. It reads its own settings from the same environment. A module that doesn't keep the contract stops the process at start. |
| `MUTINYBIM_FORBIDDEN_DB_REFS` | config | More database project refs the authority must never use (comma-separated). |
| `MUTINYBIM_SUPABASE_URL` | config | The disposable stack's own Auth, for seeded test logins (must be the same project as the database). |
| `BIM_AUTHORITY_SERVED_MODELS` | config | Model ids this deployment serves. |
| `BIM_AUTHORITY_MODEL_ALIASES` | config | `demo=demo-b,…`: names clients ask for → stored ids. |
| `BIM_AUTHORITY_PRELOAD` | config | Explicit list to lease and warm at start. |
| `BIM_AUTHORITY_LEASE_TTL_MS` / `_RENEW_MS` | config | 10000 / 3000. Renew must be under half the TTL. |
| `BIM_AUTHORITY_REAUTH_MS` | config | Live access re-check interval (10000). |
| `BIM_AUTHORITY_GROUP_COMMIT` | config | Default on. Edits are shown to everyone else as soon as they are decided and written in batches; the author hears "saved" only after its batch is durable. `0`: one write per commit before anyone sees it. Crash semantics: `packages/bim-sync/src/group-commit.ts`. |
| `BIM_AUTHORITY_GROUP_MAX` / `_WINDOW_MS` | config | 64 commits per batch; 0 ms window (write at once when idle, batch whatever arrives during a write). |
| `BIM_AUTHORITY_DRILLS` | config | `1` on disposable stacks only: drill endpoints (editors only). |
| `MUTINYBIM_LOCAL_STACK` | config | `1`: a test authority on a laptop. The database must be on this machine (a throwaway Postgres with `db/local`, `db/disposable` and `db/migrations` applied) and sign-ins may come from a stack on this machine (`http://127.0.0.1:54321`). `MUTINYBIM_DISPOSABLE_PROJECT_REF` is then not needed. Refused when `FLY_APP_NAME` is set. Used by `e2e/building-model-parts.spec.ts` and `drills/parts-store.ts`. |

A host plug-in may also serve models on demand beyond `BIM_AUTHORITY_SERVED_MODELS`
(`servesOnDemand`): each is opened only after the host confirms, as the person,
that they may read it; readers of a model that doesn't exist yet are told
"No such model", and the host may create an empty one for an editor's first
opening (`bim.provision_hosted_model`). People without access always get the
no-access refusal.

Fly sets `FLY_MACHINE_ID`, `FLY_REGION`, `FLY_APP_NAME`. Credentials and their
rotation: [CREDENTIALS.md](CREDENTIALS.md).

## Database

`db/migrations/` is the authority's schema, applied to the authority's own
database (never a host's). `db/disposable/` holds test-stack fixtures (identity
shim, drill project); the migrator does not apply those.

**The deploy applies the migrations.** Nobody pastes SQL or handles a database
password. Each app's `fly.toml` has a release step
(`release_command = "node --import tsx src/migrate.ts"`): on every deploy,
before any machine restarts, Fly starts a temporary machine from the new
image, with the app's own secrets (`MUTINYBIM_DB_URL`, registered as
`BIM_AUTHORITY_DB_URL` / `BIM_AUTHORITY_SIN_DB_URL`), and the migrator:

1. validates the full configuration (a setting the new code would refuse
   stops the deploy here instead of crash-looping machines);
2. takes a Postgres advisory lock, so two migrators on one database never
   overlap (each region has its own database, so regions never contend);
3. reads `bim.schema_migrations` (version, name, sha256, `applied` or
   `baselined`, time), creating it on first run;
4. runs every unrecorded file in filename order, each in one transaction
   with its record, and logs `[migrate] applied` / `skip` / `baselined` per
   file and a `done` line with the schema version. No connection settings
   are logged.

It fails loudly (exit 1, the deploy stops, the running version keeps
serving) when a recorded file was edited (checksum differs), a new file sorts
before one already recorded, a file fails, or another migrator holds the lock
for over a minute. A database newer than the image (a rollback) only warns.
`lock_timeout` is 3 s, so a migration never queues the live server's commits
and lease renewals behind a table lock for long; if it can't get the lock,
deploy again.

Rules for a new file:

- **Expand only.** The database changes first and machines follow one at a
  time, so the version still running must keep working: add nullable columns,
  new tables and functions; drop or rename only after a release that no
  longer reads them. The new code may check for its objects (as `pg-store.ts`
  does for `changesets.patch`).
- Name it `<UTC timestamp>_<snake_case>.sql`, newer than every recorded file.
  No `begin`/`commit`, no `concurrently` (it runs inside a transaction).
- Never edit a file once it has deployed; write another.

**Adopting hand-applied databases.** Files through `20261029130000` were
applied by hand before the migrator. Each has a probe in
`src/migration-baseline.ts` for an object only it creates; when a database
has no record of such a file and the probe finds its object, the file is
recorded `baselined` without running. Files after that never get a probe
(a test enforces it). On Oct 29 both regions had everything through
`20261019150000`, so their first self-migrating deploy baselines eight files
and applies `20261022000000_bim_models_settings_object.sql` and
`20261029130000_bim_changeset_patches_checkpoints.sql`.

### Native PostgreSQL installation

`--native` installs storage in an **empty PostgreSQL 17 database**. Use the
database-owning installation role through a direct or session-pooled
connection. The command needs only `MUTINYBIM_DB_URL`; it does not require a
Supabase project, a sign-in provider or a list of served models. It checks for
PostgreSQL 17 or newer; the installer rehearsal uses PostgreSQL 17. Port 6543
is refused because the migrator holds a session advisory lock. Other
transaction poolers are also unsuitable, regardless of their port.

From a repository checkout with the authority dependencies installed:

```bash
cd services/bim-authority
export MUTINYBIM_DB_URL='postgresql://installer@127.0.0.1:5432/native'
node --import tsx src/migrate.ts --native --dry-run
node --import tsx src/migrate.ts --native
# After a database or process restart, use the same command:
node --import tsx src/migrate.ts --native
```

The role must own the database and the objects it installs. It needs neither
superuser privileges nor permission to create cluster roles. Native
installation creates no `auth` or `realtime` schema, no `public.projects`
table, no hosted roles and no extension. Both project-ID columns remain in
`bim.models` for the existing copy writers, with a native-only constraint
that keeps them null. Do not apply the local or disposable hosted
compatibility scripts to this database.

The native baseline is
`db/native/20261125000000_native_baseline.sql`. It supplies the model, commit,
lease, branch, lineage, checkpoint and retention storage represented by the
sixteen hosted files through `20261103100200`, without replaying those
files. Later files in `db/migrations/` are shared by both installer modes.
Native installation records the native baseline,
`20261125010000_native_model_storage.sql`, and
`20261125020000_native_signin_sessions.sql`. The default hosted path
validates the full runtime configuration and runs its sixteen historical
files followed by the two shared migrations. Hosted databases record the
session migration in their ledger. It creates tables only in native mode.

Both modes use the existing migration lock, transaction-per-file behavior,
SHA-256 ledger and rerun/checksum guards. `bim.installation` records the
chosen mode. `--native` refuses existing hosted history or application
objects; the default command refuses a marked native database. Neither
command converts one installation mode into the other. Native dry-run sets
the PostgreSQL session to read-only and performs no schema, data or ledger
writes, including on an empty database. It uses only transient session
settings and the advisory lock. The existing forbidden-database list and
explicit local-mode restrictions remain active.

Wait for the installer to finish successfully before allowing model writes.
A failure rolls back the current file together with its ledger row; earlier
files remain recorded. A rerun resumes that recorded history. A native
baseline interrupted before the shared file may be resumed while its model
tables remain empty; model rows in that incomplete installation require
review instead of being assigned an inferred permission source. Keep the
native baseline immutable once deployed, and make future shared migrations
work on both storage histories. `stage.sh` and the Dockerfile include the
native SQL directory in the authority image.

The shared addition supplies people, issuer-and-subject identities, explicit
legacy identity mappings, model authority and memberships.
`bim.create_native_model(model_id, owner_person_id, settings)` creates a
standalone root and its manager membership in one transaction. The operator
must name an existing person as the first owner and supply valid model
settings. Equal subjects from different issuers stay separate until an
explicit mapping is recorded; historical actor strings are preserved.

To create a standalone model after installation, set `MUTINYBIM_DB_URL`
for the native database operator and `PERSON_ID` to the existing native
person's UUID. From `services/bim-authority`, run

```sh
node --import tsx src/create-native-model.ts east-plant --owner "$PERSON_ID"
```

The new base model uses the kernel's default settings. Repeating the command
with the same owner confirms the stored grant, including after the model has
been edited. A different owner for the same ID produces a conflict.

The session store persists single-use sign-in transactions and maps each
verified issuer and subject to a stable person ID. Use that ID with the
operator command above. Sessions expire and can be revoked independently
of model membership. See the [handler contract](NATIVE-SESSIONS.md).

On a native authority, send a membership change to the base model's address.
Use the caller's native session in the Authorization header and the coworker's
person ID from sign-in in the JSON body. This example grants viewer access.

```http
POST /models/east-plant/members
Authorization: Bearer <native session>
Content-Type: application/json

{"personId":"12345678-0000-0000-0000-000000000036","expectedRole":null,"role":"viewer"}
```

Both role fields are required and accept `viewer`, `editor`, `manager` or
`null`. In `expectedRole`, null means the person has no membership. In `role`,
it removes their membership. The designated owner can manage other members.
A manager can add, change and remove ordinary viewers and editors. The
designated owner's role and the caller's own role are protected.

HTTP 200 returns `{"result":"changed","role":"viewer"}` after commit, or
`unchanged` when the expected and requested roles already match the stored role.
HTTP 409 returns `conflict` and the role observed in that transaction. Review
that role before submitting another change. Only a committed change advances
the model's authorization revision. Each open connection picks up its new
rights on recheck. Removing model membership leaves the person's sign-in valid.

To serve an installed model locally, keep `MUTINYBIM_DB_URL` set to its database
and start the authority from this directory.

```sh
MUTINYBIM_AUTH_MODE=native BIM_AUTHORITY_SERVED_MODELS=east-plant BIM_AUTHORITY_BIND_HOST=127.0.0.1 npm start
```

The editor sends the person's ID and opaque session in its WebSocket `hello`.
The authority checks the session, base membership and requested copy together
at admission and on each live recheck. Sign-out or expiry closes that session
when the authority observes it. The [browser walkthrough](NATIVE-SESSIONS.md#browser-sign-in-and-the-east-plant-walkthrough)
exercises the membership endpoint from the editor's origin.

From the authority directory, run
`python3 drills/native-install.py --pg-bin /path/to/postgres/bin` with
Node 22 and PostgreSQL 17 to rehearse the operator command. The drill uses
synthetic identities and restarts its own database. The owner and viewer
then open `east-plant` through the sync hub. The owner saves an East roof
level and the viewer sees a read-only model. The drill also checks the
viewer's rights on their own open and closed proposal. It then starts the
model server and connects two editor sync clients over loopback WebSockets.
The owner adds **Service deck**, the viewer sees it, and the viewer's own edit
is refused. A fresh database connection checks the saved model. The drill
also checks live session revocation and expiry before stopping both services.

### Repairing a recorded checksum

An applied file is history: never edit it, comments included. Put any change
in a new, later migration. `npm run lint` and Lint (PR) fail on an edit to a
shipped file (`scripts/check-migration-immutability.mjs --dir db/migrations`).

If a comment-only edit has already shipped (the release step then stops with
"already-recorded files were edited"), keep the file as it is and repair the
record in every model database, one transaction each:

1. Check the SQL is unchanged: the old and new versions match once `--`
   comments and whitespace are removed.
2. Read the recorded row (`select version, name, checksum from bim.schema_migrations where version = '<version>'`)
   and compute the new checksum the way the migrator does (SHA-256 of the
   file read as UTF-8, `checksumOf` in `src/migrations.ts`).
3. Update exactly that row, guarded by its old checksum, and expect one row:
   `update bim.schema_migrations set checksum = '<new>' where version = '<version>' and name = '<name>' and checksum = '<old>'`.
4. Add the repair to `db/checksum-repairs.json` (file, old and new checksum,
   databases, date). The lint allows exactly that edit; the migrator itself
   has no exceptions.
5. Deploy from a clean checkout: `/health` shows the commit with no `-dirty`.

Check a database without changing it: `fly ssh console -a <app> -C "node --import tsx src/migrate.ts --dry-run"`.
`/health` reports `schema`, the newest recorded version, read at boot.

Local test stacks (the Building Model e2e specs) still
apply the files directly with `psql` to a throwaway database. `npm run migrate`
(with `MUTINYBIM_LOCAL_STACK=1`) can do that instead, with the record; don't
mix the two on one database once there are files after `20261029130000`,
because those have no probe and would run again.

## Deploy

```bash
# from the repository root
services/bim-authority/deploy.sh services/bim-authority/fly.toml       # Ashburn  (mutinybim-example)
services/bim-authority/deploy.sh services/bim-authority/fly.sin.toml   # Singapore (mutinybim-example-sin)
```

The release step migrates the app's database first (above). When `fly deploy`
returns, `deploy.sh` reads `/health` and prints `OK: <app> serves <commit> on
database schema <version>`, or fails if either is not this checkout's. The
release step's own lines: `fly logs -a <app> --no-tail | grep '\[migrate\]'`.

The image reports its commit on `/health` and `/metrics` (`-dirty` when the
shipped paths had uncommitted changes). CI (`BIM Authority (build)`) builds the
same image from `stage.sh` and boots it.

Several machines may run per app. Clients send `?model=`,
so a connection that lands on a machine that doesn't hold the model's lease is
replayed to the holder at upgrade (`fly-replay`); a client without it is told
to reconnect and retries until it reaches the owner. Each app runs two machines
(`fly scale count 2 --region <r>`, live since 2026-10-23; `deploy.sh` passes
`--ha=false`, so a deploy updates the machines that exist and never adds or
removes one). Cost, hand-off and the measured deploy gap:
`drills/RESULTS.md`.

## Metrics (`GET /metrics`)

For the performance gate, without changing what it measures elsewhere:

- `join.cold` / `join.warm`: hello received → welcome sent, server side; cold = this join leased, loaded and warmed the model.
- `auth.verifyMs`, `auth.capabilitiesMs`: sign-in and the host's permission check per join.
- `models.<id>.serverCommitMs`: decide + durable write per commit; `paths` counts which commit path ran and why a fast path gave up.
- `models.<id>.lease`: generation, expiry, renewals, longest renewal gap.
- `sessions`: what guided-session browsers reported (local preview, durable commit, remote visibility, join; p50/p95; browser, time zone, network, page cache).
- `retired`: when and why this process stopped serving a model.
- `models.<id>.schedules`: open schedule subscriptions and distinct evaluations, `schedule_rows` and patches sent, refusals, failures, resets, model reloads, and p50/p95 of the first build (`buildMs`), each schedule's incremental apply (`applyMs`) and the whole batch including delivery (`flushMs`).

## Live schedules

People open schedules on the socket (`schedule_open` by view id or ad hoc
definition, with a row window). This process evaluates them with the kernel's
row engine over the **whole** model it holds, whatever areas the person
loaded, sends the window, then patches as commits land: one evaluation per
distinct schedule shared by everyone who has it open, batched per tick off the
commit path, and the whole schedule is only materialized when rows move.
Losing read access on the 10 s re-check closes every subscription with
`denied`. `editing_cell` holds (TTL at most 8 s) make a second person's edit
to that cell wait. Protocol and engine seam: `packages/bim-sync/src/schedules/`.

## Drills

Two kinds, labelled separately. Only the first touches real machines.

**Deployed, real-process** (`drills/deployed.ts`): real Fly machines in one
app, real processes killed (`fly machine kill`, SIGKILL) or stopped
(`SIGSTOP`/`SIGCONT` over `fly ssh`), real WebSockets through the public `wss`
edge, real Postgres. Needs two started machines and `BIM_AUTHORITY_DRILLS=1`.
Test sign-ins and database checks run as scripts **on** a machine, so the
database URL and test password never leave Fly. Results land in
`drills/results/`; the latest run is summarized in [drills/RESULTS.md](drills/RESULTS.md).

Both apps run two machines (since 2026-10-23). `routing`, `two-tabs`,
`agents`, `reconnect` and `ambiguous` kill nothing; `kill`, `pause`,
`pause-db` and `takeover` stop the machine serving every model on the app, and
`revoke` deletes and re-adds a drill membership row. `rolling-deploy` is
opt-in: it ships a checkout to the app while two people edit and reports the
longest stretch with no save.

**Schedules under load** (`drills/schedules-load.ts`, local): 25 people with
three whole-building schedules each on a 250k building, against a throwaway
Postgres on this machine (`db/local`, then `db/migrations` and
`db/disposable/20261017000000_*` in timestamp order) and a child authority
process on `--port` (default 8191). Exits 1 when commit p50/p95 leaves
`stress.commit.25` or any edit or schedule is lost.

```bash
cd services/bim-authority && BIM_SCHEDULES_DRILL_DB_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres node --import tsx drills/schedules-load.ts
```

```bash
cd services/bim-authority
node --import tsx drills/deployed.ts --only=routing,two-tabs,agents,reconnect,ambiguous
node --import tsx drills/deployed.ts            # everything except rolling-deploy
DRILL_DEPLOY_CONFIG=services/bim-authority/fly.toml DRILL_DEPLOY_ROOT=<clean checkout> \
  node --import tsx drills/deployed.ts --only=rolling-deploy
```

The drill project exists only on the Ohio database; `DRILL_APP=mutinybim-example-sin`
needs it seeded there first.

**In-process** (no machines, no network):

- `packages/bim-sync/__tests__/drills.test.ts`, `sessions.test.ts`: the engine against the in-memory store.
- `src/__tests__/authority-units.test.ts`: config guards, owner routing, the lease keeper (fake clock).
- `src/__tests__/host-contract.test.ts`: the host plug-in contract, sign-in routing, the single-user example host.
- On the feasibility branch, `experiments/mutinybim-backends/src/b-drills.ts`: the real Postgres store, sequencer, hub and client in **one process** with an in-memory link instead of a socket. It never involved a second machine, a process restart or a network. Earlier write-ups that called these "drills against the persistent model servers" overstated them.
