# @permitzip/bim-editor-host

The contract between the MutinyBIM Building Model editor and the app it runs in.
Types only, Apache-2.0, no runtime code.

A host implements `EditorHost` once:

| Service | What the editor asks |
| --- | --- |
| `identity` | Who is editing (id and display name) |
| `session` | The model's session config (references, model server address) and the token the model server accepts |
| `router` | The current location, `push` / `replace` within the editor's page |
| `links` | Addresses of the host's own pages (price books, connecting a source model), or `null` when it has none |
| `notify` | Short messages that come and go |
| `preferences` | One person's editor preferences |
| `storage` (optional) | Uploading and opening files |
| `agent` (optional) | The host's own agent thread, when it has one |
| `capabilities` | The host's name and where a person connects storage or an AI, for messages |

Saving the model itself does not go through the host: the editor talks to the
model server over its WebSocket protocol (`@permitzip/bim-sync`).

`@permitzip/bim-editor` ships a standalone host (`createLocalEditorHost`) and a
conformance check (`checkEditorHostConformance`) every host should pass.
