# Connect an AI assistant

MutinyBIM is built for AI agents to work beside people. This page says how an
outside assistant (Claude, ChatGPT, Grok, Cursor, Codex or any other) works
with this repository **today**, and what is coming.

The short version:

| Today | Coming |
| --- | --- |
| Connect any MCP client to the tool server (`packages/bim-mcp`) and change a model by running scripts, approving each change; add every other tool family with `--packs all`. | Hosted services for the packs that need one (Autodesk Docs linking, branches, reading pictures with AI). |
| Write and check scripts with the scripting kit and its command line. | The full editor in the open packages, so tools and screens share one host. |
| Drive a live model over the sync protocol, as the demo's scripted agents do. | A hosted free app you can point your own assistant at. |

## Rules that hold for every agent

- **An agent never has more access than its person.** An agent acts for one
  signed-in person, under its own actor id tied to that person, with exactly
  that person's capabilities.
- **Same commands, same checks.** An agent sends the same intent commands as
  the editor. The server re-runs every command on the current model and
  refuses conflicts in words. Nothing an agent sends is trusted as written.
- **People approve.** Script output is a set of ordinary edit batches with a
  label and a preview, meant to be approved by a person before it lands. How
  approval looks is up to the host application.
- **Your assistant, your bill.** MutinyBIM does not call an AI model itself.

## 1. The tool server

`packages/bim-mcp` serves MutinyBIM's agent tools over the Model Context
Protocol, on stdio (your assistant starts it) or streamable HTTP (your
assistant connects to a URL).

### The tools

The core pack is small on purpose. Its main job is running the scripts your
assistant writes; everything else a model can do (walls, routes, equipment,
circuits, sheets, schedules) is a function in the scripting kit, so the
assistant learns the kit instead of a hundred tools.

| Tool | What it does |
| --- | --- |
| `bim_script_reference` | Start here, once per conversation. A short index: the workflow, the kit's functions by name, whether scripts can run here. Then `search` a topic, `topic` for one function or recipe whole, `command` for one command's fields, `example` for a whole script. |
| `bim_check_output` | Lint and syntax of a script with line numbers, kit functions and commands that don't exist, what its reads would send, or the kernel's checks on an output. Runs nothing. |
| `bim_run_script` | Runs a script and checks its output: a preview. Saves nothing; returns what would change, `apply_with` and the script's `script_id`. |
| `bim_apply_output` | Lands the preview as one undo step after you approve. Re-runs the script, with what the preview ran with, and lands only exactly what was previewed. |
| `bim_save_part_type` | Saves a part script's part types and the script to the library after you approve. |
| `bim_model_summary` | Counts by kind, levels, zones, systems, open issues, questions, and the revision read. |
| `bim_query_elements` | Elements by kind, class, area and discipline, with the facts an edit needs. |
| `bim_inspect_network` | One element's connected system, up to its equipment. |
| `bim_validation_issues` | Open validation issues with the elements involved. |

Add-on packs register more tools on the same server through the extension
point (`BimToolPack` in `packages/bim-mcp/src/server.ts`), without touching
the core. Pack membership lives in one place, the `packages/bim-plugin`
catalogue.

**Every other tool family** (parts and equipment, routing and fittings,
electrical and plumbing, views, sheets, drafting and detailing, drawing sets,
schedules, coordination lint, groups and phases, linked models) is in
`packages/bim-mcp-packs`. Start the server with `--packs all` to add them
(159 tools on top of the core's 9). They keep the tool names and arguments
hosted products use, so they take a `project_id` (any uuid on a local
server, which has one workspace). On your computer, printed sheets, issued
sets and saved pictures are written under `--files <dir>` (default
`./mutinybim-files`); schedules, firm parts, lint settings and route
defaults are kept in memory; and the few tools that need a hosted MutinyBIM
(Autodesk Docs linking, branches, reading a picture with AI, a project's
adopted code editions) answer in plain words that they aren't available
here. Every edit any pack makes asks you first, like the core's.

### Start it

```bash
npm install
npm run mcp:http                     # http://127.0.0.1:3333/mcp
# or
npm run mcp                          # stdio (normally your assistant starts it; see below)
```

| Option | Default | What it does |
| --- | --- | --- |
| `--http`, `--port <n>`, `--host <h>` | stdio | Streamable HTTP at `http://127.0.0.1:<port>/mcp`. It listens on this computer only unless you pass `--host`. |
| `--model-server <ws url>` | in memory | Use a running model server, for example the demo's `ws://127.0.0.1:3095/sync` (`npm run demo`), with `--model <id>` for each model. |
| `--model <id>` | `demo` | Models to serve (in memory: each starts with one level). |
| `--approve ask\|auto` | `ask` | `ask`: every change asks you in your assistant first. `auto`: changes land without asking. A local demo only. |
| `--read-only` | off | Reads and previews only; every edit and save is refused. |
| `--no-scripts` | off | Scripts are refused. |
| `--packs none\|all` | `none` | `all` adds every add-on tool family to the core. |
| `--files <dir>` | `./mutinybim-files` | Where printed sheets, issued sets and saved pictures go. |

The in-memory model server keeps nothing after the server stops.

### Approvals

Every change asks you before it lands. The server asks through your
assistant (MCP elicitation): you see what will land and approve or decline;
the assistant cannot answer for you. If your assistant cannot ask (it does
not support elicitation), changes are refused in words and nothing lands.
`--approve auto` lands changes without asking; use it only for a local demo
on your own computer.

### Where scripts run

On your computer, each script runs in a fresh Node process with Node's
permission model (it reads only its own bundle and writes nothing), an empty
environment, and the kit's caps (1 GB memory, 30 s, 2 MB of output). Node
cannot deny a process the network, so this runner is for **your own
scripts on your own computer only**. Never use it to run other people's
scripts on a shared server: a host that does runs the same two runner files
(`packages/bim-script-runner`) on a sealed machine with a deny-all network.

### Connect your assistant

Use the absolute path to your checkout in place of `/path/to/mutinybim`.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mutinybim": {
      "command": "node",
      "args": ["/path/to/mutinybim/packages/bim-mcp/bin/mutinybim-mcp.mjs"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add mutinybim -- node /path/to/mutinybim/packages/bim-mcp/bin/mutinybim-mcp.mjs
# or, with npm run mcp:http running:
claude mcp add --transport http mutinybim http://127.0.0.1:3333/mcp
```

**Cursor** (`.cursor/mcp.json` in your project, or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mutinybim": {
      "command": "node",
      "args": ["/path/to/mutinybim/packages/bim-mcp/bin/mutinybim-mcp.mjs"]
    }
  }
}
```

or, over HTTP: `{ "mcpServers": { "mutinybim": { "url": "http://127.0.0.1:3333/mcp" } } }`.

**ChatGPT** (a custom connector in developer mode) and other hosted
assistants connect from the internet to an HTTPS address, so they cannot
reach `127.0.0.1`. To try it, run `npm run mcp:http` and put it behind an
HTTPS tunnel you control, for as long as you are trying it, and keep
`--approve ask`. The local server has no sign-in, so anyone who has the
tunnel address can read your models; never share it.

**Any other MCP client:** stdio with the command above, or streamable HTTP at
`http://127.0.0.1:3333/mcp`.

### A worked example

Ask your assistant: *"In the MutinyBIM model `demo`, add a second level 4 m
above Level 1 with a script."* It does this:

1. `bim_script_reference` with no arguments: scripts can run here, the
   workflow, the kit.
2. It writes the script:

   ```ts
   import { defineScript } from "@permitzip/bim-script";
   export default defineScript({
     kind: "layout",
     reads: { levels: true },
     parameters: {},
     run(ctx) {
       ctx.edit({ type: "create_level", levelId: "level-2", name: "Level 2", elevationMm: 4000 });
     },
   });
   ```

3. `bim_check_output({ model_id: "demo", script: { source, reads: { levels: true } } })`:
   `status: "ok"`, no findings, and `script_id: "scr_…"`. This is the only
   time the script's text is sent.
4. `bim_run_script({ model_id: "demo", script: { id: "scr_…" } })`:
   `status: "previewed"`, `changes: { creates: 1, edits: 0, deletes: 0 }`, and
   `apply_with`. The model has not changed.
5. `bim_apply_output(apply_with.args)`: `apply_with.args` names the script by
   its id, not its text. Your assistant shows you *land "…" in model demo as
   one undo step: 1 new, 0 changed, 0 deleted. Approve?* You approve; the
   answer is `status: "saved"` with the new revision.
6. `bim_model_summary({ model_id: "demo" })` now counts two levels.

If the model moved between the preview and the approval, the apply answers
`stale_preview` and nothing lands; the assistant runs the preview again.
This exact sequence runs in CI
(`packages/bim-mcp/__tests__/oss-local-end-to-end.test.ts`).

### A script is sent once

An assistant pays for every character it sends and reads, on every step. So
the tools keep each script it sends and give it a short id:

| The assistant sends | When |
| --- | --- |
| `script: { source, reads }` | The first time. `reads` may be left out when the script declares them as plain values. |
| `script: { id }` | Any later call about the same script: the preview after a check, a second preview with other values. |
| `script: { id, replace: [{ old, new }] }` | A fix after an error. `old` is exact text that is in the script once (`all: true` changes every place). A replacement that isn't found, or is found more than once, changes nothing and says which one. The answer carries the changed script's own id. |
| `script: { key, version }` | A script saved in the library. |

What an id is tied to, so nothing can be swapped between the preview you saw
and the change you approve:

- The id is a fingerprint of the person, the script's text and its reads.
  Another text, other reads or another person is another id, and only the
  person who sent a script can use its id.
- A successful preview is recorded with what it ran with: the model, the
  level or zone, the values, the selection, and a fingerprint of its output.
  `bim_apply_output` and `bim_save_part_type` by id run exactly that again
  and land only that output. A call that names other values, another
  selection, another area or another model is refused.
- An id lasts 36 hours, longer than an approval can wait. After that the
  answer is "That preview has expired; run the script again".

Answers are kept short too: a search returns its two best matches whole and
the rest by name; a preview lists at most 40 part types and a few plan
pictures; long error messages are cut and say so. Each says how to get the
rest.

### Hosting the tool server

A product that hosts MutinyBIM gives the tool server its own answers to five
questions through one interface (`BimToolHost` in
`packages/bim-mcp/src/host.ts`), and the tools stay the same:

- **Who is calling:** the person and the agent run acting for them.
- **May they do it:** the host checks read access before a model is read and
  edit access before an edit, before any model server contact; it is asked
  before a script runs; its library says who may save.
- **Approval:** a gate decides before anything lands. A host with its own
  approval cards and a durable record of each decision passes the call
  through only after the person approved (`hostDecidedApproval`); the local
  host asks through the client (`elicitationApproval`).
- **Where scripts run:** a sealed machine per conversation, never the
  process serving the tools.
- **The model server:** sessions on the model server as that person.

One more, optional, answer saves an assistant most of what it would send
again: **where scripts are kept between calls** (`previews` on the host, a
`ScriptPreviewStore` with two methods, `put` and `get`, that stores each
record whole under its id). A hosted product keeps them somewhere that
outlives a restart and its longest approval wait (the hosted app uses its
account database); one person's computer uses `MemoryScriptPreviewStore`. The
tools check the owner, the expiry and the id themselves, so the store has no
rules of its own. A host that gives no store still works: a preview then
returns the whole script in `apply_with.args`, as before.

`registerBimCoreTools(server, host)` puts the core pack on a server a host
already runs (its own transport, sign-in and middleware);
`createBimToolServer({ host, packs })` makes a ready one.

## 2. Work in the repository


The simplest way: open this repository in an AI coding assistant and ask it to
build an add-on, write a script, fix a bug or add a test. Point it at:

- [ADD-ON-CONTRACT.md](ADD-ON-CONTRACT.md) for add-ons;
- [SCRIPTING.md](SCRIPTING.md) for scripts;
- [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md)
  for the rules (build on the kernel, typed units, performance budgets).

The kit reference is generated from the kernel's command schemas, so an
assistant can ask for exact command shapes:

```ts
import { searchReference, referenceMarkdown, commandFields } from "@permitzip/bim-script";

searchReference("route a duct");     // ranked commands and helpers
commandFields("route_run");          // fields and JSON Schema of one command
referenceMarkdown();                 // the whole reference as Markdown
```

## 3. Scripts and the command line

An assistant writes a script with `defineScript`, then runs and checks it
against a slice of a model:

```bash
mutinybim-script run   script.json --slice slice.json --out output.json
mutinybim-script check output.json --slice slice.json
```

`check` previews every batch against the slice and reports refusals, what
would re-open, quantity changes and lint, without changing anything. The
output is ordinary `batch_edits` that any MutinyBIM server accepts and
re-checks. Details: [SCRIPTING.md](SCRIPTING.md).

## 4. A live model over the sync protocol

A program can join a live model the same way the editor does. Start the demo:

```bash
npm run demo        # dev server on http://localhost:3095, sync on ws://localhost:3095/sync
```

Then connect with the sync client from `@permitzip/bim-sync`:

```ts
import WebSocket from "ws";
import { SyncClient } from "@permitzip/bim-sync";
import type { Actor } from "@permitzip/bim-kernel";

const actor: Actor = { id: "agent-1", name: "Layout agent", kind: "agent" };
const ws = new WebSocket("ws://localhost:3095/sync");
let started = false;

const client = new SyncClient(
  { send: (data) => ws.readyState === WebSocket.OPEN && ws.send(data), close: () => ws.close() },
  actor,
  {
    // Fires once the server's welcome has arrived, and again on every change.
    onView: (model) => {
      if (started) return;
      started = true;
      console.log("model has", Object.keys(model.elements).length, "elements");
      client.publishPresence({ kind: "working", note: "Adding a level" });
      const result = client.submit({ type: "create_level", levelId: "lvl-9", name: "Level 9", elevationMm: 36_000 });
      if (!result.ok) console.log("refused before sending:", result.error.message);
    },
    onOutcome: (request, outcome) => {
      if (outcome.status === "committed") console.log("saved", request.command.type);
      else console.log("not saved:", outcome.error.message);
    },
  },
);
ws.on("open", () => client.opened());
ws.on("message", (data) => client.receive(data.toString()));
```

`client.view()` returns the model as this client sees it (confirmed edits
plus its own pending ones), or `null` before the welcome.
`packages/bim-devserver/scripts/agents.ts` is a complete example:
scripted agents that read, think, commit (sometimes from a stale base) and
report commits, rebases and conflicts.

Everyone in the demo editor sees the agent's presence and its edits live.

**On the model server** the flow is the same, with two differences: the
`hello` message carries a sign-in token and a model id, and the server asks
its authorizer what that person may do before it loads the model. A person
with view-only access gets a read-only connection. See
`services/bim-authority/README.md` and `packages/bim-sync/AUTHORIZATION.md`.

## 5. The plugin standard: tool packs, skills and MCP

`packages/bim-plugin` describes MutinyBIM's agent tools as an
[Agent Plugins 1.0](https://agent-plugins.org) package:

- **Tool packs.** About a dozen packs (core, drafting, ducts and pipes,
  electrical, plumbing, views and sheets, coordination, groups and phases,
  parts, calculations, schedules, model). An assistant connects the core
  plus only the packs a job needs, which keeps its tool list small. Each pack
  has a token cap for the tool text it may advertise.
- **One Agent Skill per pack** (`packages/bim-plugin/skills/*/SKILL.md`),
  telling the assistant how to use that pack's tools. The guidance in each
  is written by hand; its frontmatter and tool list are rendered from the
  catalogue (`npm run build:files` in the package), so a tool moved between
  packs moves in its skill too. A host app reads the same skills with
  `bimPluginSkills()` and adds its own notes on top; nothing host-specific
  is written here.
- **One MCP server entry per pack.** `renderMcpJson(baseUrl)` writes
  `mcp.json` for any server; each pack is served at
  `<base>/packs/<slug>/mcp`.
- **Add-ons bring tools too.** An add-on declares agent tools as data
  (`AGENT_TOOL_POINT`) and may group them in its own pack.

```ts
import { bimPackCatalogue, renderMcpJson, renderPackageFiles } from "@permitzip/bim-plugin";

bimPackCatalogue();                              // packs, their tools and caps
renderMcpJson("https://your-host.example/bim");  // mcp.json for your server
```

The tool server in this repository (section 1) serves the core pack. The
other packs in the catalogue are served today by host applications that
embed MutinyBIM; they move into this repository as tool server packs.

## Coming next

- **Hosted services for the packs that need one** (Autodesk Docs linking,
  branches, reading pictures with AI) in the hosted free app.
- **A sealed script runner you can run yourself:** the same runner files in a
  container with a deny-all network, for hosting other people's scripts.
- **A hosted free app** where you bring your own assistant.

Follow progress in [ROADMAP.md](../ROADMAP.md).
