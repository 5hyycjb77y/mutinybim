# Connect Claude or another assistant

You can connect your own AI assistant to your models. It can read them and
propose changes, and every change asks you first. Claude, ChatGPT, Grok,
Cursor, or any assistant that speaks the Model Context Protocol (MCP) can
connect.

You pay your AI provider. The app pays for no AI and sees nothing of your
AI account.

This page covers the hosted app at `https://app.mutinybim.com`. If you run
your own copy, use your own address in its place. For running the tool
server on your own computer, the full tool list and the scripting kit, see
[Connect an AI assistant](../CONNECT-AN-AGENT.md).

## The address

The address your assistant connects to is the app's address with `/mcp` on
the end:

```text
https://app.mutinybim.com/mcp
```

The **Connect an assistant** page (in the top bar, and in the bar above the
editor) shows this address with steps for each assistant.

<!-- screenshot: the Connect an assistant page with the address and the steps -->

## Add it to your assistant

Add MutinyBIM as a custom connector (an MCP server) and paste the address.

- **Claude** (claude.ai or Claude Desktop): Settings → Connectors → Add
  custom connector, paste the address, then Connect.
- **ChatGPT:** Settings → Apps & Connectors → Create (developer mode), paste
  the address, choose OAuth, then Create.
- **Grok:** add a custom connector (MCP server) and paste the address.
- **Claude Code:**

  ```bash
  claude mcp add --transport http mutinybim https://app.mutinybim.com/mcp
  ```

- **Cursor:** add this to `~/.cursor/mcp.json`:

  ```json
  { "mcpServers": { "mutinybim": { "url": "https://app.mutinybim.com/mcp" } } }
  ```

These menu names belong to each assistant and may change. If a step doesn't
match what you see, look for "custom connector" or "MCP server" in your
assistant's settings.

## Sign in and press Allow

When you connect, your assistant opens a MutinyBIM sign-in page. Log in, and
the app asks, with your assistant's name: **Let "Claude" use your
models?** There is no key to copy.

<!-- screenshot: the Let "Claude" use your models? page with Allow and Don't allow -->

The page says what the assistant can do:

- It can read your models and the ones shared with you.
- It can propose changes. Every change asks you first, and models shared
  with you to view stay view-only.
- It can't see your password, your settings or your AI keys, and it can't
  share or delete models.
- You can sign it out any time under **Connect an assistant**.

The name at the top is the one the assistant gave itself. Only allow it if
you asked your assistant to connect to MutinyBIM a moment ago. Press **Allow**, or
**Don't allow**.

After you allow it, the assistant is listed under **Assistants signed in**
on the Connect an assistant page, with when it signed in and when it was
last used. **Sign out** there cuts its access to your models at once.

An assistant acts for you and nobody else: it reaches your models and the
ones shared with you, nothing more. Its changes, and the editor's list of
who is here, carry the name it registered with, marked as an agent.

## How approvals work

Nothing an assistant does lands in a model until you approve it.

- **In the assistant.** If your assistant has its own approval box, it asks
  you there. You see what will change and approve or decline. The assistant
  can't answer for you.
- **On the Approvals page.** If your assistant can't ask you itself, the
  change waits on **Approvals** in the app. The **Approvals** link in the
  top bar shows how many are waiting. Open one to see exactly what changes,
  then press **Approve** or **Decline**.
- **In the editor and on every page.** While something waits, a notice
  shows it with **Approve**, **Decline** and **See exactly what changes**.

The assistant waits about a minute for your answer. After that the request
stays on Approvals for 30 minutes and lands the moment you approve it. After
30 minutes it is dropped.

A script your assistant runs only previews at first. It changes the model
only after you approve, and it lands as one undo step. Scripts run on the
app's server in a sealed box with no network.

## Try it: build a small office

The project ships four example scripts. The
[small office](../../packages/bim-script/examples/small-office.ts) builds
two floors of a 40 x 30 ft office: exterior and interior walls, doors and
windows, rooms found from the walls (open office, conference room, office),
a 9 ft ceiling in each room, and a plan of each floor on its own sheet.

1. On **My models**, make a new blank model. Call it "Small office".
2. In your connected assistant, ask:

   > In my MutinyBIM model "Small office", run the small-office example
   > script.

3. The assistant fetches the example, checks it and runs a preview. Nothing
   changes yet.
4. It asks you to approve: in its own approval box, or on **Approvals**.
   Look at what will change, then approve.
5. Open the model. You should see the walls, rooms and sheets on two levels.

You can also paste the script's text into the assistant and say "run this
script". The other examples build a rooftop unit with its ducts, a plumbing
riser and an electrical room; see the
[examples list](../../packages/bim-script/examples/README.md).

## Tool families

When an assistant connects to `/mcp`, it starts with the core tools, ten at
most. Their main job is writing, checking, previewing and landing scripts,
plus a few reads to look at the model first. Most work is done by scripts.

Other tools come in families. An assistant turns one on when a job needs
it; you can ask it to ("turn on the electrical tools"). Or connect a family
directly at its own address, `https://app.mutinybim.com/packs/<family>/mcp`,
for example `https://app.mutinybim.com/packs/electrical/mcp`.

The families are `model`, `drafting`, `ducts-pipes`, `electrical`,
`plumbing`, `views-sheets`, `coordination`, `groups-phases`, `parts`,
`calcs` and `schedules`. What each one covers, and every tool in it, is in
the [tool server reference](../reference/mcp-tools.md), generated from the
tool server itself.

Every change from any family asks you first, the same as the core.

## Run the tool server on your own computer

Some assistants only start local tools. For those, the **Connect an
assistant** page has **Or run the tool server on your own computer**: make
an agent key with **Make a key**, and run the command it shows. The key is
shown once; anyone with it can edit your models, so treat it like a
password. **Turn off** a key to cut its access. See
[Connect an AI assistant](../CONNECT-AN-AGENT.md) for the details.

## Ask AI or connect an assistant?

- **Ask AI**, in the editor, answers questions from a summary of the model
  with your own key. It does not change the model. See
  [Getting started](getting-started.md#ask-ai).
- **A connected assistant** reads the model and proposes changes you
  approve.
