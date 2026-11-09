# Who may read and edit a MutinyBIM model

## In plain language

MutinyBIM has its own short list of things a person can do to a model:
**view it**, **edit it**, and **issue drawings from it**. The engine only ever
asks one question: *"what may this signed-in person do to this model?"*

Who answers that question depends on where MutinyBIM runs:

- **On its own (open source).** It ships a small built-in answer: each model has
  members, and each member is a viewer, an editor or a manager. Nothing from
  PermitZIP comes along.
- **Inside a host product.** The answer comes from the product's existing
  permissions, through a host plug-in on the model server: for example, you must
  belong to the project, and the project's permissions decide whether you can
  view or edit its models. No second permission system.

AI agents never get more than the person who started them. An agent edits under
its own name, tied to that person; a host may hold every agent edit for that
person's approval, and when an agent's edit clashes with someone's
newer change it stops and asks rather than redoing it.

Someone swapping in their own backend keeps the same three questions and plugs
in their own answer. "Taking the permissions with you" means taking this small
contract, not any product's permission tables.

## The engine contract

```ts
type ModelCapability = "model.read" | "model.edit" | "model.issue";

interface ModelAuthorizer {
  // Capabilities this verified person has on this model; empty = no access.
  capabilities(input: { userId: string; modelId: string; token: string }): Promise<ModelGrant>;
}
type ModelGrant =
  | { ok: true; capabilities: ReadonlySet<ModelCapability> }
  | { ok: false; reason: string };
```

`authorizeConnection()` combines it with the actor rules in
`agent-principal.ts`: a login may act as itself, or as an agent bound to that
same person (`agent:<userId>:<runId>`). The agent receives exactly the person's
capabilities, never more. No `model.read` → denied; no `model.edit` → read-only
connection; commands from a read-only connection are refused by the hub.

Hosts decide **before** touching a model: the authority signs the person in and
asks the host's authorizer, then leases and loads, then admits the connection with the
decided principal (`SyncHub.join(conn, principal)`, no second check). While the
session lives, the host asks again periodically and applies the answer with
`SyncHub.revoke` (plain reason, then close) or `SyncHub.setPrincipal`
(view-only). Each client is its own editing session (`clientSessionId`): the
same person in two tabs, or two agent runs, conflict like anyone else.

- **Native default** (`NativeModelAuthorizer`): members per model with roles
  `viewer` → read, `editor` → read + edit, `manager` → read + edit + issue.
  Its store is an interface; the reference store is in memory. A standalone
  Postgres store is one table:
  `bim.model_members(model_id text, user_id uuid, role text check (role in ('viewer','editor','manager')), primary key (model_id, user_id))`.
- **A host product's authorizer**, supplied by its host plug-in (below). It
  should ask the product's own permission system **as the signed-in person**
  (their own token), never with a service key, and keep no copy of membership.

### Per copy (round 11, W11)

A copy (`<base>~<copy>`, any depth) is no longer authorized as its base. The
host still answers what the person may do on the **project** (read gates
everything; edit is edit on the **first copy**, the design, only) and, through
the optional `lineageGrants()`, who is named on which copy. The model server
holds the copies (parent, purpose, maker) and passes the chain to
`authorizeConnection(…, { lineage })`; the engine's rule (`lineageRights`,
`lineages/rights.ts`) decides per copy, one code path at every depth:

- a copy's maker and named editors edit it; named readers / reviewers hold that;
- everyone who reads its parent reads it (and may copy it) unless its purpose
  reads `named_only` (shop drawings, submittals, operations records);
- the parent's responsible professionals whose scope covers what the copy
  changes hold the purpose's `parentResponsible.holds` (propose, review), raised
  to edit only by an edit grant the purpose allows;
- a round 8b branch row with no copy row keeps its rule: its parent's editors edit it;
- a copy that isn't open is read only; nothing on a child reaches an ancestor:
  review needs `review` on the child, accept back and merge need `edit` on the target.

A host that only records who granted what returns `grantedBy`; the engine honours such a grant only
when it traces back to the copy's maker through edit grants (`honoredGrants`).
A standalone host vouches for its own rows (`bim.lineage_members`,
`NativeModelAuthorizer(members, copies)`).

## Hosts: the model server's plug-in point

The model server (`services/bim-authority`) ships no product's permissions. At
start it loads the module named by `MUTINYBIM_AUTHORIZER_MODULE` (a path from
its working directory, or a package name) and checks it against the contract
in `services/bim-authority/src/host/contract.ts`; a module that doesn't keep
it stops the server at start. The module exports:

- `createModelServerHost(context)` returning
  - `name`, for logs and `/health`;
  - `signIn`: the issuer, published key set and audience of the host's
    sign-in tokens (`supabaseSignIn(url)` for a Supabase Auth project);
  - `authorizer(projectHint)`: the `ModelAuthorizer` for those sign-ins.
    `projectHint` is the project the page named on a connection, a candidate
    the host must confirm, or null (live re-checks, HTTP calls);
  - optionally `servesOnDemand(modelId)` (models beyond the configured list,
    each still authorized per person), `mergeApprovals` (a
    `MergeApprovalSource`), and `allowsImportSource(url)` (the signed file
    addresses a linked-model import may read);
- optionally `forbiddenDbRefDigests`: SHA-256 digests of database refs the
  model server must never use as its own database (the host's production).

`context` carries the environment, the server's own database, and helpers for
the host project a model belongs to and for creating an empty model.

Open hosts in the tree: the disposable-stack test logins
(`MUTINYBIM_SUPABASE_URL`, `auth/test-authorizer.ts`, members of the model's
test project), and `host/single-user.ts`, one person with every right, the
smallest complete host to copy. `src/__tests__/host-contract.test.ts` is the
contract's test.

