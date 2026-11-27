# MutinyBIM web app

The hosted MutinyBIM app: free accounts, a person's saved models (and the
ones shared with them), the full
Building Model editor in the browser, the model server those models sync
through, bring-your-own-AI settings, and the tool server outside assistants
(Claude, ChatGPT, Grok, Cursor) reach over the internet at `/mcp`.

It is one Node process with no framework: accounts live in a SQLite file
(`node:sqlite`), each model (Main and its history, every branch with its own
edits, every saved version) is kept as one file next to it, and models are
served in the same process through the sync protocol the model server speaks.
Every page is drawn with the MutinyBIM primitives and theme the editor uses
(`packages/bim-ui`), light, dark or the computer's setting.

```bash
npm install
npm run web          # http://127.0.0.1:3100
```

Sign up with any email and password, make a model, open it. Make a second
account in a private window and share the model with it to edit together.

## What it does

| Page | What a person does there |
| --- | --- |
| `/` | Reads what this is; signs up or logs in. |
| `/signup`, `/login` | Email and password, or a configured sign-in provider ("Log in with …"). |
| `/forgot`, `/reset/<link>` | Getting back in without email: a linked sign-in, or a one-time link from the operator. |
| `/models` | Their models and the ones shared with them; makes one (blank or the sample); renames; deletes (asks first). |
| `/models/<model>/share` | The owner shares with an existing account by email, to view or to edit; changes or removes it (asks first). |
| `/m/<model>` | The editor. The bar above it has the way back, the theme toggle, **Ask AI** and **Connect an assistant**; "View only" on a model shared to view. |
| `/settings` | Their name; password; linking a sign-in provider; **Your AI**: their own provider key, kept only in their browser. |
| `/connect` | The address to paste into Claude, ChatGPT, Grok or Cursor (`<this app>/mcp`), the assistants they have signed in (and Sign out), and agent keys for a tool server on their own computer. |
| `/oauth/authorize` | "Let “<assistant>” use your models?": Allow or Don't allow. |
| `/approvals`, `/approvals/<id>` | Changes an assistant proposed when it couldn't ask the person itself: exactly what changes, Approve or Decline. The header's Approvals link counts what is waiting; every signed-in page and the editor show a notice with Approve / Decline while any wait (the editor and the header re-check `/api/hosted/approvals/waiting`, the signed-in person's own requests, every few seconds). |

### Bring your own AI

The app pays for no AI and has no AI account. Two ways to use one:

- **Ask AI** in the editor sends a question and a summary of the model from
  the person's browser straight to their provider (Anthropic, OpenAI, xAI, or
  any OpenAI-style address) with the key they pasted in Settings. The key is
  kept in that browser's storage only; it never reaches this server.
- **Connect an assistant** by address: paste `https://<this app>/mcp` into
  the assistant (below). Or run the tool server on your own computer with
  an agent key (`mbk_…`, shown once, stored as a digest):
  `node packages/bim-mcp/bin/mutinybim-mcp.mjs --model-server "wss://<this app>/sync?key=mbk_…" --model <model id>`.
  Every change the assistant proposes asks the person first.

### Outside assistants over the internet

`/mcp` is MCP Streamable HTTP with MCP's own sign-in, so an assistant connects
by address and the person signs in; there is no key to paste.

- **Tools.** `/mcp` lists only the core pack (the script tools, four reads
  and `bim_enable_pack`; ten at most). Every other family is opt-in:
  `/packs/<family>/mcp` is the core plus that family, or the assistant turns
  one on in the session with `bim_enable_pack` (the tool list changes with
  `notifications/tools/list_changed`). The core, the families and the
  switch come from `@permitzip/bim-mcp`; the app only hosts them.
- **Sign-in** (the MCP authorization spec): protected resource metadata at
  `/.well-known/oauth-protected-resource/mcp` (and per family), authorization
  server metadata at `/.well-known/oauth-authorization-server`, dynamic
  client registration at `/oauth/register` and client ID metadata documents
  (an https `client_id`, fetched only from public addresses), authorization
  code with PKCE (S256 only), the `resource` parameter checked, `iss` on every
  redirect. Public clients only; no client secrets. Access tokens last an
  hour; refresh tokens 30 days and rotate (using one twice ends the sign-in).
  Tokens are stored as digests and reach only the tool server.
- **Rights.** An assistant acts for the person who signed it in: their models
  and the ones shared with them, nothing else. A model shared view-only can
  be read and is refused for every change before the person is asked.
- **Approval.** Every change asks the person: in the assistant's own approval
  box (MCP elicitation) when it has one; otherwise on `/approvals/<id>`
  (an assistant that can open links is asked to show it). The call waits
  about a minute; after that the change stays on the page for 30 minutes and
  lands the moment the person approves it.
- **Scripts** run here (`bim_run_script`, `bim_check_output`,
  `bim_apply_output`, `bim_save_part_type`): a preview changes nothing, and
  its result lands only after the person approves it, as one undo step. Each
  run is in the sealed script box below. An assistant that runs the
  open-source kit itself can still send its output to `bim_apply_output`.
  A script is sent once: it is kept in the account database for 36 hours
  under a short id, so the assistant names the id to preview it, to fix it
  (exact replacements) and to land it, also after a restart. Only the
  person who sent it can use the id.
- **Its name.** The assistant's changes, and the editor's list of who is
  here, carry the name it registered with ("Claude", "ChatGPT"), marked as an
  agent.
- **Restarts.** Sessions and waiting approvals are kept in the account
  database. After a restart an assistant carries on in the same session
  (the same agent run, the families it turned on), and a change approved
  after the restart still lands.

### The sealed script box

The scripts run by the open runner (`@permitzip/bim-script-runner`, the same
two files a host app and the local tool server use), each run inside a box on
this machine made with bubblewrap, a Linux sandbox that needs no root:

- **No network.** The box has a network of its own with no connections in
  it: a script can't reach the internet, this app, or anything else.
- **Nothing of ours.** It starts from an empty file system holding only the
  system's programs (`/usr`, read-only), the runner (read-only) and the one
  request (the script and the slice of the model it asked to read). The
  account database, model files, settings and this app's code aren't in it.
- **Nobody.** Its own user ("nobody"), process list and hostname, every
  privilege dropped, no settings or keys in its environment.
- **Limits.** The runner's caps (1 GB of JavaScript memory, 30 s, 2 MB of
  output), CPU time and open files capped, and the box goes first if the
  machine runs short of memory, so a script that hogs memory is stopped
  before the app is. Inside, Node's permission model also forbids file
  writes, child processes and workers, and the script sees only the kit.
- **Turns.** One run at a time per person, two at once on the machine
  (`MUTINYBIM_WEB_SCRIPT_RUNS`), two more waiting per person; past that the
  assistant is told to wait.
- **Checked first.** At start the app tries the box once: if it reaches a
  network, writes to the system folder, sees a setting or runs as the app's
  user, scripts are refused in words rather than run unsealed.

What the box shares with the app is the machine's kernel; a kernel flaw is
the one way out of it. The next step, when traffic warrants it, is the same
box on a separate machine that holds no data.

## Settings

All optional; read once at start.

| Variable | Default | What |
| --- | --- | --- |
| `MUTINYBIM_WEB_PORT` | `3100` | Port. |
| `MUTINYBIM_WEB_HOST` | `127.0.0.1` | Listen address (`0.0.0.0` in a container). |
| `MUTINYBIM_WEB_ORIGIN` | `http://127.0.0.1:<port>` | The public address, e.g. `https://app.example.com`. Cookies are `Secure` when it is https. |
| `MUTINYBIM_WEB_DATA` | `./mutinybim-web-data` | Folder for `accounts.sqlite`, `models/` and the editor build. Put it on a persistent disk. |
| `MUTINYBIM_WEB_MODEL_LIMIT` | `25` | Models one account may own. |
| `MUTINYBIM_WEB_SIGNUP` | `open` | `closed` stops new email sign-ups. |
| `MUTINYBIM_WEB_PROVIDERS` | none | JSON array of sign-in providers, below. |
| `MUTINYBIM_WEB_QUOTE` | none (off) | Optional quote link, below. Leave unset. |
| `MUTINYBIM_WEB_SCRIPTS` | `sealed` | Where outside assistants' scripts run: `sealed` (the box above; Linux with bubblewrap, as in the image), `off`, or `local` (plain processes on this computer; allowed only when the public address is a loopback address). |
| `MUTINYBIM_WEB_SCRIPT_RUNNER` | `/usr/local/lib/mutinybim/script-runner` | The runner's two built files (the image builds them there, root-owned). |
| `MUTINYBIM_WEB_SCRIPT_RUNS` | `2` | Scripts running at once on this machine; each may use about 1.2 GB. |
| `MUTINYBIM_WEB_LINK_KEY` | none (linked hosts off) | A secret of 32+ characters. The app keeps the passes linked hosts issue (below) encrypted under it (AES-256-GCM). Unset: linked hosts are off, and My models says so. |
| `MUTINYBIM_WEB_LINK_KEY_PREVIOUS` | none | The key before the current one, while a new key rolls in: passes kept under it still open, and are written back under the current key when read. |
| `MUTINYBIM_WEB_SUPABASE_URL` | none | Optional Supabase project URL (`https://<ref>.supabase.co`). Turns on Supabase Auth (email sign-up/login, password-reset emails, and Continue with Google). Leave unset for self-contained local email/SQLite mode. |
| `MUTINYBIM_WEB_SUPABASE_PUBLISHABLE_KEY` | none | Supabase publishable (or anon) key; required when `MUTINYBIM_WEB_SUPABASE_URL` is set. |
| `MUTINYBIM_WEB_SUPABASE_SECRET_KEY` | none | Optional Supabase secret (`service_role`) key. When set, stores app records (users, sessions, model metadata, shares, assistant grants) in Supabase Postgres. Apply the SQL files in `db/migrations/` in filename order before starting the new version. |
| `MUTINYBIM_WEB_SUPABASE_GOOGLE` | `1` | Set to `0` to hide the **Continue with Google** button when Supabase Auth is enabled. |
| `MUTINYBIM_WEB_TRUST_PROXY` | auto (`1` when `FLY_APP_NAME` is set) | Trusts `Fly-Client-IP` / `X-Forwarded-For` for sign-in and OAuth registration rate limits behind a reverse proxy. |

### Supabase Auth & Google sign-in

Set `MUTINYBIM_WEB_SUPABASE_URL` and `MUTINYBIM_WEB_SUPABASE_PUBLISHABLE_KEY` to delegate email/password sign-up, password-reset emails, and **Continue with Google** (OAuth 2.0 PKCE) to a Supabase project:

1. If Postgres stores the app's accounts, apply each unapplied SQL file in `apps/mutinybim-web/db/migrations/` in filename order before updating the app. The sign-in code uses the account lookup and creation functions in `20261126040000_supabase_user_identity.sql`. SQLite handles the update automatically.
2. In Supabase Auth → URL Configuration, add `<MUTINYBIM_WEB_ORIGIN>/auth/supabase/callback` to **Redirect URLs**.
3. Keep **Confirm email** on (Supabase Auth → Sign In / Providers → Email). With it off, Supabase treats every address as confirmed at sign-up.
4. In Supabase Auth → Providers → Google, enable Google and add your Google OAuth Client ID and Client Secret (with Google's authorized redirect URI set to `https://<project-ref>.supabase.co/auth/v1/callback`).
5. Optionally set `MUTINYBIM_WEB_SUPABASE_SECRET_KEY` (as a secret on your deployment host) to store all app metadata tables in Supabase Postgres instead of local SQLite. If migrating an existing deployment off SQLite, copy existing rows first with `node --import tsx apps/mutinybim-web/src/migrate-sqlite.ts` (supports `--dry-run`).

A first Google sign-in can link an existing MutinyBIM account when Supabase confirms the address, Google verifies that same address, and Google is the only linked provider. If those details are missing, use the existing account's password. Later sign-ins use the saved account link.

Finish every copy pass before enabling writes on Postgres. Replaying an older
SQLite snapshot can restore a share that someone removed on Postgres.

### Sign-in providers

`MUTINYBIM_WEB_PROVIDERS` is a JSON array of OIDC providers. Each entry takes `id`, `label`, and `issuer`, plus optional `clientId`, `scope`, `clientName`, `domains` (e.g. `["example.com"]` to show a one-time dismissible *"Link your Example account?"* prompt on My models when someone signs in with a matching email domain), and `models` (for linked hosts).

Any OAuth 2.1 / OpenID Connect server that publishes its metadata and a
UserInfo endpoint. The app is a public client (authorization code with PKCE,
no client secret). Without a `clientId` it registers itself with the
provider (RFC 7591) and remembers the id.

```bash
MUTINYBIM_WEB_PROVIDERS='[{"id":"example","label":"Log in with Example","issuer":"https://id.example.com","clientName":"MutinyBIM","scope":"identity"}]'
```

`scope` defaults to `openid email profile`. A provider that offers an
identity-only scope (name and email, no other access) should be given that
one, as above.

The provider's access token is used once, to ask UserInfo who signed in, and
then dropped; it is never stored or logged.

When a configured provider returns the JSON boolean `email_verified: true` in
UserInfo, the app records confirmation for the matching account email at sign-in
or when the person links that provider in Settings. Changing the account email
clears its confirmation. Older accounts can gain confirmation on their next verified sign-in.

### Linked hosts

A provider can also be a *linked host*: a service that keeps building models
of its own (a firm's project models) and lets the people who sign in with it
open them from here. Give the provider a `models` object
([docs/LINKED-HOSTS.md](../../docs/LINKED-HOSTS.md) is the contract the host
implements):

```bash
MUTINYBIM_WEB_PROVIDERS='[{"id":"example","label":"Log in with Example","issuer":"https://id.example.com","clientName":"MutinyBIM","scope":"identity",
  "models":{"label":"Example projects","scope":"models:open","list":"https://id.example.com/api/models","mcp":"https://id.example.com/api/mcp","token":"https://id.example.com/api/models/token","revoke":"https://id.example.com/oauth/revoke"}}]'
```

Right after someone's first sign-in with that provider, the app asks once
whether to show their projects too; yes sends them to the host to allow a
narrow pass (the `models.scope`) that opens building models only. My models
then lists the host's models under the person's own (each with Open in the
host, in a new tab), and assistants connected here can read them and propose
changes. The host decides on every call what the person may see and change;
changes ask the person here first, exactly as for their own models; scripts on
those models run on the host's machines; other tool families don't reach
them. Settings → Ways to log in turns it off (the pass is handed back). The
pass is kept only as ciphertext under `MUTINYBIM_WEB_LINK_KEY`; nothing from
the host is copied here but the list. Unlinking, or the host being down,
never touches the person's own models. A provider account whose email
already has a password account here is not merged silently: the person logs in
with the password and links the provider under Settings.

### Quote link (off)

Unset, there is no quote button, page or wording anywhere, and nothing turns
it on by default. The code stays for a deployment that later decides to ask a
services firm for quotes: `MUTINYBIM_WEB_QUOTE` takes a JSON object with
`label`, `provider`, `url` and an optional `blurb` (see `QuoteConfig` in
`src/config.ts`). Set it only on purpose.

## Sharing

The owner of a model shares it with another account on the same server by
email: **Can edit** (edit, make branches, save versions) or **View only** (the
model server refuses their edits). There are no invitations by email; the
person needs an account first. Changing or removing someone's access
disconnects them at once. Only the owner shares, renames or deletes.

Under **Transfer ownership**, choose a direct viewer or editor and the access
you want to keep. The recipient has 14 days to accept in **My models**.
Acceptance uses one of their model slots. If their account is full, they
can free a slot and accept the same offer before it expires. The model ID,
history and other people's shares stay with the model. Removing the
recipient's share ends the offer.

## Getting back in

The app sends no email, so it has no emailed reset link. Two ways back:

- **A linked sign-in.** Log in with the linked provider; for ten minutes after
  that, Settings → Password sets a new password without the old one.
- **The operator.** On the server, `npm run web:reset-password -- person@example.com`
  prints a link that sets a new password once, within an hour (only its digest
  is stored). Using it signs the person out everywhere else.

## Deploying

`Dockerfile` builds an image of this app from the repository root:

```bash
docker build -f apps/mutinybim-web/Dockerfile -t mutinybim-web .
docker run -p 3100:3100 -v mutinybim-web-data:/data -e MUTINYBIM_WEB_ORIGIN=http://localhost:3100 mutinybim-web
```

It needs a long-running server with WebSockets and a persistent disk (a VM or
a container platform with volumes), not a serverless host. One process serves
everything; run one copy per data folder. The script box needs a Linux kernel
that lets an ordinary user make namespaces (Fly.io machines are expected to; the start-up log says either way. Docker's
default seccomp profile doesn't, so a plain `docker run` reports scripts off).
Size the machine for the app (3 GB) plus about 1.2 GB per script running at
once: 8 GB for the default two.

The image starts as root only to give the mounted `/data` to its own user
(`docker-entrypoint.sh`), then runs the app as that user.

### Fly.io

`fly.toml` is the deployment at `https://app.mutinybim.com`: one machine, one
volume on `/data`, scripts pinned to `sealed`. The sign-in providers and the
link key (`MUTINYBIM_WEB_LINK_KEY`, and `_PREVIOUS` while a new key rolls in)
are Fly secrets set on the app; the operator's own secret tooling should write
the link key. From the repository root:

```bash
fly apps create mutinybim-web
fly volumes create mutinybim_web_data --app mutinybim-web --region iad --size 10 --yes
fly deploy . --config apps/mutinybim-web/fly.toml --dockerfile apps/mutinybim-web/Dockerfile --ha=false
fly logs --app mutinybim-web --no-tail | grep "script box"   # must say "the script box is sealed"
fly certs add app.mutinybim.com --app mutinybim-web
```

Always pass `--ha=false`: a second machine would start with an empty volume.
Operator commands run as the app's user:
`fly ssh console --app mutinybim-web --user mutinybim -C "sh -c 'cd /app && HOME=/tmp MUTINYBIM_WEB_DATA=/data MUTINYBIM_WEB_ORIGIN=https://app.mutinybim.com npm run web:reset-password -- person@example.com'"`.

## Limits today

- One machine. Each model is written to disk within a second of each change,
  whole (Main with its history, branches, saved versions), so very long-lived
  models grow their file; a deployment that outgrows that points the editor at
  a model server with a Postgres commit store.
- Sharing is by account email on the same server; there are no emailed
  invitations or links for people without an account.
- The editor screens that need hosted storage (firm part libraries, stored
  drawings, linked models (IFC or Revit), code studies, file storage) say in words that
  they are not available here; the rest of the editor works.
- Sign-up has no email confirmation (the app sends no email).
- A tool call that was waiting for the person when the server restarted
  ends; the request stays on the approvals page and lands if approved.
- Files the tool families write (printed sheets, issued sets) are kept under
  the data folder per person; the app has no page to download them yet.

## Files

| File | What |
| --- | --- |
| `src/server.ts` | Starts the app. |
| `src/app.ts` | Routes, forms, sessions, sharing, the editor routes and the model server socket. |
| `src/admin.ts` | Operator commands (`npm run web:reset-password`). |
| `src/config.ts` | The settings above. |
| `src/db.ts` | Accounts, sessions, models, shares, reset links, agent keys and assistant sign-ins (SQLite). |
| `src/assistant-auth.ts` | The assistants' sign-in: metadata, registration, PKCE codes, tokens. |
| `src/assistant-tools.ts` | `/mcp` and `/packs/<family>/mcp`: the bim-mcp tool server hosted per person, with rights and approvals. |
| `src/assistant-approvals.ts` | Asking the person before a change lands (kept in the database). |
| `src/script-sandbox.ts` | The sealed script box and its queue. |
| `src/models.ts` | Serving and saving models (bim-sync's in-memory host, saved whole to one file per model). |
| `src/oauth.ts` | "Log in with …" (OAuth 2.1 with PKCE, dynamic registration, UserInfo). |
| `src/linked-hosts.ts` | Linked hosts: the narrow pass (kept encrypted), the host's list, and assistants' calls sent to the host's tool server. |
| `src/secrets.ts` | Password hashing, random tokens and their digests. |
| `src/pages.tsx`, `src/ui.tsx` | The server-rendered pages, drawn with `@permitzip/bim-ui` components and theme. |
| `styles/app.css` | Tailwind over the same primitives; no colors of its own. |
| `tsconfig.runtime.json` | What tsx reads to run the app (automatic JSX for server rendering). |
| `client/entry.tsx` | The editor page: the editor plus the hosted bar and Ask AI. |
| `client/ai.ts`, `client/settings.ts` | Bring-your-own-AI in the browser. |
| `public/confirm.js` | The confirm-before-delete script. |
