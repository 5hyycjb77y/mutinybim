# MutinyBIM roadmap: proposals and professional seals

Not built yet. This records what we intend, what it depends on, and what is
still undecided.

## In plain language

**Proposals.** Anyone allowed to propose — a client, an architect, one of our
engineers, an agent — can take their own copy of the model, change it however
they like, save it, attach it to an RFI, and offer it back: "route the duct
this way instead." The real model doesn't change until a reviewer looks at
the difference and accepts it. Accepting runs the same conflict rules as live
editing, so a proposal never silently overwrites newer work; it stops and asks.
Declining leaves the proposal on record.

**Professional seals.** Issuing a drawing set and sealing it are different
acts. Anyone who can edit can issue. Record drawings also need a licensed
professional's seal: a verified architect seals the architectural sheets, a
verified mechanical engineer seals the mechanical ones, each confirming with
their password. Each seal records exactly which PDF was sealed (a fingerprint
of the file), who sealed it, under which licence, and when, and carries a
digital signature that Adobe Acrobat can check. Change one byte of the PDF and
the seal visibly breaks.

## 1. Proposals (branches)

### What it is

- A **proposal** is a named branch of a model: it starts at a revision of the
  main model and has its own changesets after that point.
- Its owner (and anyone they invite) edits it with the normal tools and agents.
  Nothing on a proposal reaches the main model or anyone else's view of it.
- A proposal can be attached to an RFI, a markup or a task order and shown as a
  before/after difference.
- A reviewer **accepts** (the proposal's changesets are replayed onto the
  current main model) or **declines** (closed, kept for the record).

### Why the existing model already fits

- Every edit is a **changeset** with a `baseRevision` and the commands that
  produced it, not a snapshot. A proposal is a list of changesets whose base is
  the revision it forked from.
- **Accepting = replaying those changesets** against the main head through the
  normal sequencer. The commit rules already refuse a competing authored value
  or a broken intent recorded after the base (`conflict` with `withActor` and
  `withRevision`). The default stays "stop and ask", exactly as for agents.
  Conflicts show the reviewer which proposal edit clashed with whose newer
  change.
- **Diffs** come from the same changesets: elements added, removed and changed
  between the fork revision and the proposal head.
- **Area loading** applies unchanged: a proposal on level 3 mechanical is a
  small changeset list; viewing it loads the main model's area plus the
  proposal's changes on top.

### What the authorization contract needs

- A new capability **`model.propose`**: may create and edit proposals on this
  model. It is not `model.edit` — it never writes the main model.
- **Proposal ownership**: each proposal has an owner (person; an agent's
  proposal belongs to its person) and optional collaborators. Editing a
  proposal needs `model.propose` plus owner or collaborator. Viewing it needs
  `model.read` plus owner, collaborator, or "shared with the project".
- **Accepting** needs `model.edit` on the main model (later perhaps a separate
  `model.review`). Declining needs `model.edit` or proposal ownership.
- Native default: `viewer` could get `model.propose` per model, so clients and
  outside architects can propose without edit access.
- Host mapping: a host grants `model.propose` from its own permission system
  (for example to staff, clients and outside reviewers on the project), and its
  authorizer adds it to the capabilities it returns.
- Agents still get exactly their person's capabilities. A client's agent can
  draft a proposal; it cannot accept one.

### Depends on

- Durable changeset log per branch on the model server (today there is one
  linear log per model).
- A difference view in the model tab (3D and plan), plus RFI/markup links.
- An approval surface for accept/decline in the host (a durable approval
  record per decision, not a browser-only button).

### Open questions

- Does a proposal track the main model (rebase as the main moves) or stay
  pinned to its fork revision until accepted?
- Partial accept: can a reviewer take some of a proposal's edits?
- Can a client see other clients' proposals on a shared project?
- Do proposals bill time like agent runs, and to whom?
- Retention: how long are declined proposals kept?

## 2. Professional seals

### What it is

1. **Professional identity.** A person records each licence: type (PE, RA,
   …), state, number, discipline, expiry. An admin verifies it against the
   state board's public lookup; unverified licences can't seal.
2. **Sealing a set.** On an issued set, a verified licensee picks the sheets
   they are responsible for (the architect the A sheets, the mechanical PE the
   M sheets), re-enters their password, and seals.
3. **What a seal records.** A content fingerprint (SHA-256) of the exact PDF,
   the signer, the licence (type, state, number), the time, the issued-set
   revision, and the sheet list.
4. **Cryptographic signature.** Prefer a **PAdES / PDF digital signature**
   embedded in the PDF so Acrobat shows "signed by … , document not modified".
   The signing certificate is the licensee's (their own, or one issued to
   them through a provider some states require). A signature we generate
   ourselves without a trusted certificate would only be checkable in the
   app that made it.
5. **Separate from issuing.** Issuing (`model.issue`) creates the set. Sealing
   is a separate capability tied to the person's verified licence, never to a
   project role, and never available to an agent.

### Building on a host's licences

A host may already keep professional licences and seal artwork. MutinyBIM
seals build on the host's professional identity and its visible seal, and add
the seal record, password re-confirmation, fingerprint and PAdES signature.

### Per-state rules (UNVERIFIED — confirm with each board before relying on them)

- **Florida (PE):** digitally sealed documents need a third-party-issued
  digital certificate; printed copies carry a statement that the item was
  digitally signed and sealed (FAC 61G15-23).
- **Texas (PE):** seal, signature and date on each sheet; electronic seals
  allowed if the signature is under the engineer's sole control (TBPELS
  §137.33).
- **Virginia (PE/RA):** seal, signature and date on final documents;
  electronic signatures must be unique to the signer, verifiable and under
  sole control (18VAC10-20-760).
- **North Carolina (PE):** each sheet sealed; an electronic seal needs a
  digital signature that invalidates on change (21 NCAC 56.1103).
- **Maryland, DC, Ohio, South Carolina:** the existing stamp templates cover
  their artwork; signing rules not yet reviewed.

### Depends on

- Issued sets pinned to a model revision producing final vector PDFs (M4).
- Admin verification flow for licences, with a reason and an audit trail.
- Architect licence types (`RA`) in `licensing.license_type`.
- A signing approach: per-licensee certificates (provider TBD) and a signing
  service that holds no long-lived key of ours on a laptop or in an env file;
  any key it does hold goes through the secret registry.
- Password re-confirmation that works with Google sign-in (most staff have no
  password) — likely a fresh sign-in or passkey instead.

### Open questions

- Who verifies licences: any admin, or a named compliance role?
- Certificate provider and cost per licensee; do any of our states accept a
  self-issued certificate?
- One signature per discipline set, or one per sheet?
- Re-issue after a correction: new seal on the new PDF, old one kept and
  marked superseded?
- Do clients (portal) see seal records, or just the sealed PDF?
- Should the public stamp generator ever link to sealing, or stay artwork only?
