# @permitzip/bim-editor

The MutinyBIM Building Model editor, moving here screen by screen. It runs in
any app that implements the host contract in `@permitzip/bim-editor-host`.

## What's in it

- **`src/ui`**: the shadcn/ui primitives the editor draws with (MIT, see
  `src/ui/LICENSE-shadcn.md`), unchanged apart from import paths.
- **`src/host`**: `EditorHostProvider` and `useEditorHost`
  (`@permitzip/bim-editor/host`, light enough for any page of a host app); the
  standalone host `createLocalEditorHost({ authorityUrl })` on its own entry,
  `@permitzip/bim-editor/host/local` (one person on this computer, the local
  model server, no built-in agent, no file storage; it loads the kernel); and
  `checkEditorHostConformance(host)`, which every host should pass.
- **`src/editor`**: the editor's screens and helpers.

## Running it standalone

Wrap the editor in `<EditorHostProvider host={createLocalEditorHost({ authorityUrl: 'ws://127.0.0.1:3095/sync' })}>`
and mount `sonner`'s `<Toaster />` once. Outside AIs (Claude, ChatGPT, Grok…)
connect to the model through the tool server, not through the editor.

Must not import host code: the open-source boundary lint fails the build otherwise.
