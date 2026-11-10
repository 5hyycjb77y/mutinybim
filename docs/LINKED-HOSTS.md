# Linked hosts

A **linked host** is a service that keeps MutinyBIM models of its own (for
example, a firm's project models) and lets people who sign in with it open
those models from the hosted MutinyBIM app, and lets their assistants work on
them, while the host keeps deciding, on every call, what each person may do.

The hosted app (`apps/mutinybim-web`) is the client. This page is what a host
implements. Configuration on the app side is in the app's README ("Linked
hosts").

## What the host provides

All addresses are https (or this computer, for development).

### 1. A sign-in provider

The host is already one of the app's sign-in providers: OAuth 2.1 with PKCE,
metadata at `/.well-known/oauth-authorization-server` (or OpenID discovery),
dynamic client registration or a pre-registered public client id, and a
UserInfo endpoint whose `sub` names the person.

### 2. A narrow pass (`models.scope`)

After a person signs in, the app may ask for one more authorization, with
`scope` set to the host's models scope **only**, and its own callback address:

```
<origin>/auth/<provider id>/models/callback
```

The host:

- shows its own consent ("open the building models of projects you can open
  here; nothing else"), and refuses the scope for apps it hasn't approved;
- issues, at `models.token` (default: its token endpoint), an access handle
  (about an hour) and a refresh handle that rotates on every use, where using
  an old refresh handle a second time ends the pass;
- accepts those handles **only** at `models.list`, `models.mcp` and
  `models.revoke`, never as a general sign-in.

Token responses are ordinary OAuth JSON: `access_token`, `refresh_token`,
`expires_in`, `token_type: "Bearer"`, `scope`. Errors are OAuth errors; a
`400 invalid_grant` on refresh means the person must connect again.

### 3. The list (`models.list`)

`GET` with `Authorization: Bearer <access handle>`:

```json
{
  "subject": "<the same id UserInfo names the person with>",
  "models": [
    {
      "id": "<the model id the host's tool server takes>",
      "project_id": "<the project id the host's tool server takes>",
      "label": "9901 Sample Warehouse",
      "group": "Example projects",
      "can_edit": true,
      "open_url": "https://host.example/models/<project>"
    }
  ],
  "next_offset": null
}
```

- Only models the person may open, as the host decides now. `can_edit` is
  the host's answer for changing it.
- `subject`, when present, must match the person's linked sign-in; the app
  refuses a pass for a different account.
- `open_url` opens the model in the host (the app opens it in a new tab). An
  address on another origin than `models.list` is not shown.
- At most 500 rows per page; `next_offset` (or `null`) for the next page.
- `401`: the pass ended; the app asks the person to reconnect. Any other
  failure: the app says the host can't be reached and leaves the person's own
  models alone.

### 4. The tool server (`models.mcp`)

MCP Streamable HTTP with the open core tools and the same arguments as the
open tool server (`@permitzip/bim-mcp`, `PROJECT_SCHEMAS`): the app sends the
`model_id` and `project_id` from the list, and the bearer from the pass. It
also sends:

| Header | What |
| --- | --- |
| `x-linked-agent-name` | The assistant acting, as it named itself (for the model's history and who-is-here list). |
| `x-linked-run-id` | The assistant's session, as a stable id. |

The host:

- checks the person's rights on every call (a `forbidden` refusal means they
  lost access, and the app says so);
- runs scripts on its own sealed machines and may cap them (a refusal names
  the cap);
- treats `bim_apply_output` and `bim_save_part_type` as already approved by
  the person: the app asks the person **before** it sends them, in the
  assistant's own approval box or on the app's approvals page. The host still
  refuses what the person's role doesn't allow.

The app sends only the core tools for linked models. Other tool families are
refused on linked models, in words, pointing at `open_url`.

### 5. Revocation (`models.revoke`, optional)

RFC 7009: `POST` `token=<handle>`. The app hands back both handles when the
person turns linked projects off. The host should also let the person end the
pass from its own settings.

## What the app keeps

- The pass, as AES-256-GCM ciphertext under the deployment's
  `MUTINYBIM_WEB_LINK_KEY` (no key: the feature is off).
- The list, under local ids (`lk-…`), refreshed from the host at most once a
  minute and replaced on every read.
- Nothing else from the host: no model contents, no files.

## Testing a host

`apps/mutinybim-web/__tests__/linked-hosts.test.ts` runs the app against a
fake host on this computer and is the reference for what the app sends and
expects.
