# Editor demo

The full Building Model editor in your browser, editing a model held in
memory on your computer. No account, no database, no cloud.

```bash
npm install
npm run demo
```

Then open <http://127.0.0.1:3095/> (it sends you to `/m/f-a-demo`). Open the
same address in a second window with `&name=Priya` added and edit together.
Another port: `BIM_DEV_PORT=3096 npm run demo`.

The first start builds the editor (about a minute). Later starts reuse that
build until a source file changes. The build lives in your temp folder
(`MUTINYBIM_DEMO_OUT` moves it). `node --import tsx packages/bim-editor/demo/build.ts`
forces a rebuild.

## What works here

- Plan, 3D and sheet views; placing, routing, sizing and editing elements;
  levels, spaces, schedules, notes and sheets.
- Several people (or windows) editing the same model live.
- Branches and versions: make a branch, edit it, compare it with Main.
- Sheet fonts, PDF drawings, geometry and IFC files load from this computer.

Everything is kept in memory: stopping the server forgets the model, its
branches and its versions.

## What says "not available here"

Some screens read things a hosted app keeps: saved preferences, a firm's
equipment and part libraries, design limits and route defaults, stored
drawings and images, linked models (IFC or Revit), project questions, code studies,
file storage and a built-in AI agent. The local server has none of these, so
those requests answer `501` and the editor says, in words, what's missing. The
rest of the editor keeps working.

## Connect your own AI

The demo has no built-in agent. Connect your own (Claude, Cursor, any MCP
client) to the model through the tool server: see
[docs/CONNECT-AN-AGENT.md](../../../docs/CONNECT-AN-AGENT.md).

## Other addresses

| Address | What |
| --- | --- |
| `/m/<model>` | The editor. Any model name opens Main; branches use the name the Branch list gives them. |
| `/sync` | The model server (WebSocket). |
| `/feasibility` | The small feasibility viewer. |
| `/metrics` | Model server counters. |
| `/export.pdf` | The demo sheet as a PDF. |

## Files

| File | What |
| --- | --- |
| `entry.tsx` | Mounts the editor with the standalone host (`createLocalEditorHost`). |
| `styles.css`, `tokens.css` | The Tailwind stylesheet and the design tokens the UI primitives read. |
| `build.ts` | Bundles the editor with esbuild and builds the stylesheet. |
| `server.ts` | The editor routes `packages/bim-devserver` serves next to the model. |
