/**
 * MutinyBIM local dev server: the full Building Model editor in a browser,
 * the model it edits (an in-process sequencer behind the same sync protocol
 * the real model server speaks, with branches and versions), and the small
 * F-a feasibility viewer. Everything lives in memory until it stops. Not a
 * production service.
 *
 *   npm run demo                                             # http://127.0.0.1:3095 (in the open-source tree)
 *   node --import tsx packages/bim-devserver/src/server.ts   # the same, from any checkout
 *   BIM_DEV_PORT=3096 node --import tsx packages/bim-devserver/src/server.ts
 *
 * Routes: `/` and `/m/<model>` the editor, `/dist/*` its bundle, `/sync`
 * the model, `/feasibility` the feasibility viewer, `/metrics`, `/export.pdf`
 * and `/issue` as before. Host app APIs the editor asks for answer 501 in
 * plain words.
 *
 * BIM_DEV_EDITOR: `eager` builds the editor at start (the default), `lazy`
 * on the first editor page (the default with BIM_DEV_MODEL, so browser tests
 * that only need the model don't pay for it), `off` serves no editor.
 *
 * BIM_DEV_AUTHORITY_URL (with BIM_DEV_SIGNIN_URL): the editor opens that model
 * server instead of the in-process one, signed in through the local sign-in
 * service (`docker compose up`; services/bim-authority/src/local-stack). `/demo-config.json` tells
 * the page which.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { branchModelId, buildSheetScene, demoSheetDefinition, executeCommand, isBranchId, parseBranchModelId, type Command, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { createDemoModel, createPlacedDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { captureSnapshot, issueFromSnapshot, renderSheetPdf } from "@permitzip/bim-sheets";
import { InMemoryBranchHost, type SyncHub } from "@permitzip/bim-sync";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { createEditorDemo, type EditorDemo } from "../../bim-editor/demo/server";

// The kernel carries no trade: gas, plumbing and air systems are first-party add-ons, installed before any model is built.
installFirstPartyAddOns();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const port = Number(process.env.BIM_DEV_PORT ?? 3095);
const RENDERER = "mutinybim-devserver/0.2 pdf-lib/1.17.1";
const ISSUE_DIR = process.env.BIM_ISSUE_DIR ?? "/tmp/mutinybim-issued/dev";

/** 7301 Demo Site: the demo system placed inside the linked architecture (same origin as the feasibility site model). */
const SITE_7301_ORIGIN = { x: 119_500, y: -26_000 } as const;
/**
 * The demo with one routed run already invalid (tilted 5 mm), as an older
 * model or an import leaves it: edits elsewhere must still save (bug log #18,
 * e2e/building-model-open-issue.spec.ts).
 */
function openIssueModel(): ModelState {
  let m = createDemoModel("f-a-demo");
  const steps: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
    { type: "route_run", idPrefix: "bad", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 304.8, height: 203.2 }, elevationMm: 2743.2, system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" }, points: [{ x: 0, y: 24_384 }, { x: 6096, y: 24_384 }] },
  ];
  for (const command of steps) {
    const r = executeCommand(m, command);
    if (!r.ok) throw new Error(`[bim-devserver] open-issue model: ${command.type}: ${r.error.message}`);
    m = { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
  }
  const seg = m.elements["bad-s1"] as RunSegment;
  return { ...m, elements: { ...m.elements, [seg.id]: { ...seg, end: { ...seg.end, z: seg.end.z + 5 } } } };
}

/** The 7492 Sample Market propane system as drawn, every pipe 3/4" (e2e/building-model-gas-zones.spec.ts). */
const sampleMarketGasModel = (): ModelState => buildSampleMarketGas();

const startingModel =
  process.env.BIM_DEV_MODEL === "site-7301"
    ? createPlacedDemoModel("site-7301", SITE_7301_ORIGIN)
    : process.env.BIM_DEV_MODEL === "open-issue"
      ? openIssueModel()
      : process.env.BIM_DEV_MODEL === "sample-market-gas"
        ? sampleMarketGasModel()
        : createDemoModel("f-a-demo");
// Main plus branches, versions and copies, all in memory (bim-sync's in-memory branch host).
const models = await InMemoryBranchHost.start(startingModel);
const { sequencer, hub } = models.main;
const mainModelId = startingModel.modelId;

/**
 * The hub a connection's first hello names. Main, or a branch or copy made on
 * this server. A plain model id this server doesn't know (a host app's
 * project model, or no id at all) gets Main, as this server always did; an
 * unknown branch gets null.
 */
async function hubFor(modelId: string | null): Promise<SyncHub | null> {
  if (modelId === null) return hub;
  const served = await models.open(modelId);
  if (served) return served.hub;
  return parseBranchModelId(modelId) ? null : hub;
}

/** The model id a connection's first message asks for: undefined when it is not a hello, null when the hello names none. */
function helloModelId(raw: string): string | null | undefined {
  if (!raw.startsWith('{"type":"hello"')) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null && "modelId" in parsed && typeof parsed.modelId === "string") return parsed.modelId;
  return null;
}

const editorMode = process.env.BIM_DEV_EDITOR ?? (process.env.BIM_DEV_MODEL ? "lazy" : "eager");
if (!["eager", "lazy", "off"].includes(editorMode)) {
  console.error(`[bim-devserver] BIM_DEV_EDITOR="${editorMode}" is not one of eager, lazy, off`);
  process.exit(1);
}

const editor: EditorDemo | null =
  editorMode === "off"
    ? null
    : createEditorDemo({
        mainModelId: async () => mainModelId,
        authority: async (branch) => {
          const url = `ws://127.0.0.1:${port}/sync`;
          if (branch === null) return { url, modelId: mainModelId };
          if (!isBranchId(branch)) return { error: "That branch address isn't usable. Pick the branch again from the Branch list." };
          return { url, modelId: branchModelId(mainModelId, branch), mainModelId, branchId: branch };
        },
      });

async function bundleClient(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(root, "packages/bim-viewer/src/main.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    tsconfig: path.join(root, "packages/tsconfig.bim.json"),
    logLevel: "silent",
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error("esbuild produced no output");
  return out.text;
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MutinyBIM - feasibility</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/mutinybim-mark-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/mutinybim-mark-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/brand/mutinybim-mark-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/mutinybim-mark-180.png">
<link rel="stylesheet" href="/feasibility/viewer.css"></head>
<body><div id="app"></div><script type="module" src="/feasibility/client.js"></script></body></html>`;

function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

async function exportPdf(res: ServerResponse) {
  // Capture an immutable snapshot at the current head; render only from it.
  const snapshot = await sequencer.exportSnapshot();
  const sha = createHash("sha256").update(snapshot.canonical).digest("hex");
  const scene = buildSheetScene(snapshot.model, demoSheetDefinition());
  const started = performance.now();
  const pdf = (
    await renderSheetPdf(scene, {
      title: "M-101 Mechanical Plan",
      modelRevision: snapshot.revision,
      snapshotSha256: sha,
      renderer: RENDERER,
    })
  ).bytes;
  const ms = Math.round(performance.now() - started);
  console.log("[bim-devserver] exported M-101", { revision: snapshot.revision, sha256: sha.slice(0, 12), ms, bytes: pdf.length });
  send(res, 200, "application/pdf", pdf, {
    "content-disposition": `inline; filename="M-101-rev${snapshot.revision}.pdf"`,
    "x-model-revision": String(snapshot.revision),
    "x-snapshot-sha256": sha,
    "x-render-ms": String(ms),
  });
}

const externalAuthority = process.env.BIM_DEV_AUTHORITY_URL ?? null;
const signInUrl = process.env.BIM_DEV_SIGNIN_URL ?? null;
if (externalAuthority && !signInUrl) {
  console.error("[bim-devserver] BIM_DEV_AUTHORITY_URL needs BIM_DEV_SIGNIN_URL: the model server only opens to someone signed in");
  process.exit(1);
}

/** Which model server the editor page opens, and the sign-in it presents there. */
async function demoConfig(res: ServerResponse, url: URL): Promise<void> {
  if (!externalAuthority || !signInUrl) return send(res, 200, "application/json", JSON.stringify({ authority: "in-process" }));
  const name = (url.searchParams.get("name") ?? "You").slice(0, 60);
  const answer = await fetch(`${signInUrl}/token?name=${encodeURIComponent(name)}`);
  if (!answer.ok) {
    console.error("[bim-devserver] the local sign-in service refused a token", { status: answer.status });
    return send(res, 502, "application/json", JSON.stringify({ error: `The local sign-in service answered ${answer.status}. Is it running (docker compose ps)?` }));
  }
  const body: unknown = await answer.json();
  if (typeof body !== "object" || body === null || !("access_token" in body) || !("user_id" in body) || typeof body.access_token !== "string" || typeof body.user_id !== "string") {
    console.error("[bim-devserver] the local sign-in service answered without a token");
    return send(res, 502, "application/json", JSON.stringify({ error: "The local sign-in service answered without a token." }));
  }
  return send(res, 200, "application/json", JSON.stringify({ authority: "external", authorityUrl: externalAuthority, token: body.access_token, userId: body.user_id, displayName: name }));
}

async function handle(req: IncomingMessage, res: ServerResponse, clientJs: () => Promise<string>, css: string) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/demo-config.json") return demoConfig(res, url);
  if (req.method === "GET" && url.pathname === "/feasibility") return send(res, 200, "text/html; charset=utf-8", INDEX_HTML);
  if (req.method === "GET" && url.pathname === "/feasibility/client.js") return send(res, 200, "text/javascript", await clientJs());
  if (req.method === "GET" && url.pathname === "/feasibility/viewer.css") return send(res, 200, "text/css", css);
  if (req.method === "GET" && url.pathname === "/" && !editor) {
    res.writeHead(302, { location: "/feasibility" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/export.pdf") return exportPdf(res);
  if (req.method === "POST" && url.pathname === "/issue") {
    // Capture the pinned snapshot first; rendering reads only that file.
    const head = await sequencer.head();
    const capturedAt = new Date().toISOString();
    const snap = await captureSnapshot(ISSUE_DIR, head);
    const manifest = await issueFromSnapshot(ISSUE_DIR, snap.file, demoSheetDefinition(), RENDERER, capturedAt);
    console.log("[bim-devserver] issued", { revision: manifest.modelRevision, pdf: manifest.pdfFile, snapshot: manifest.snapshotSha256.slice(0, 12) });
    return send(res, 200, "application/json", JSON.stringify({ pdfUrl: `/issued/${manifest.pdfFile}`, revision: manifest.modelRevision, manifest }));
  }
  const issued = url.pathname.match(/^\/issued\/([\w.-]+\.(?:pdf|json))$/);
  if (req.method === "GET" && issued?.[1]) {
    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path.join(ISSUE_DIR, issued[1]));
    return send(res, 200, issued[1].endsWith(".pdf") ? "application/pdf" : "application/json", data);
  }
  const brand = url.pathname.match(/^\/brand\/(mutinybim-mark-(?:16|32|48|180|192|512)\.png)$/);
  if (req.method === "GET" && brand?.[1]) {
    const { readFile } = await import("node:fs/promises");
    const png = await readFile(path.join(root, "packages/bim-viewer/assets", brand[1]));
    return send(res, 200, "image/png", png, { "cache-control": "public, max-age=86400" });
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    const { readFile } = await import("node:fs/promises");
    const png = await readFile(path.join(root, "packages/bim-viewer/assets/mutinybim-mark-32.png"));
    return send(res, 200, "image/png", png, { "cache-control": "public, max-age=86400" });
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    const m = hub.metrics;
    const sorted = [...m.commitMs].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
    return send(res, 200, "application/json", JSON.stringify({
      revision: (await sequencer.head()).revision,
      connections: hub.connectionCount(),
      commits: m.commits,
      rejections: m.rejections,
      broadcasts: m.broadcasts,
      droppedBroadcasts: m.droppedBroadcasts,
      bytesOut: m.bytesOut,
      serverCommitMs: { p50: pct(0.5), p95: pct(0.95), max: sorted.at(-1) ?? null },
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    }, null, 2));
  }
  if (req.method === "POST" && url.pathname === "/debug/drop-next-broadcast") {
    hub.dropNextBroadcasts(1);
    return send(res, 200, "application/json", JSON.stringify({ ok: true }));
  }
  if (req.method === "GET" && url.pathname === "/debug/head") {
    const served = await models.open(url.searchParams.get("model") ?? mainModelId);
    if (!served) return send(res, 404, "application/json", JSON.stringify({ error: "No such model or branch here." }));
    const head = await served.sequencer.head();
    return send(res, 200, "application/json", JSON.stringify({ modelId: head.modelId, revision: head.revision, elements: Object.keys(head.elements).length, connections: served.hub.connectionCount() }));
  }
  if (editor && (await editor.handle(req, res, url))) return;
  send(res, 404, "text/plain", "Not found");
}

async function main() {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(path.join(root, "packages/bim-viewer/src/viewer.css"), "utf8");
  let cached: string | null = null;
  const clientJs = async () => {
    // Rebuild on each request in dev so edits show up on reload.
    try {
      cached = await bundleClient();
    } catch (err) {
      console.error("[bim-devserver] client bundle failed", err);
      if (!cached) throw err;
    }
    return cached;
  };
  await clientJs();

  const server = createServer((req, res) => {
    handle(req, res, clientJs, css).catch((err) => {
      console.error("[bim-devserver] request failed", { url: req.url, err });
      send(res, 500, "text/plain", "Server error: see devserver log");
    });
  });

  const wss = new WebSocketServer({ server, path: "/sync" });
  wss.on("connection", (socket) => {
    const conn = { id: randomUUID(), send: (data: string) => socket.send(data) };
    // One address serves Main and every branch (as the model server does): the first hello names the model.
    let joined: SyncHub | null = null;
    let queue: Promise<void> = Promise.resolve();
    const receive = async (raw: string) => {
      if (!joined) {
        const modelId = helloModelId(raw);
        if (modelId === undefined) {
          conn.send(JSON.stringify({ type: "error", message: "Say hello first: this connection has not named a model yet." }));
          return;
        }
        const target = await hubFor(modelId);
        if (!target) {
          console.error("[bim-devserver] a connection asked for a branch this server doesn't have", { id: conn.id, modelId });
          conn.send(JSON.stringify({ type: "denied", reason: "This branch isn't on the local dev server (it keeps branches only until it restarts). Switch back to Main." }));
          return;
        }
        joined = target;
        joined.join(conn);
      }
      await joined.handle(conn, raw);
    };
    socket.on("message", (data) => {
      const raw = data.toString();
      queue = queue.then(() => receive(raw)).catch((err: unknown) => console.error("[bim-devserver] message failed", { id: conn.id, err }));
    });
    socket.on("close", () => {
      queue = queue.then(() => joined?.leave(conn)).catch((err: unknown) => console.error("[bim-devserver] leave failed", { id: conn.id, err }));
    });
    socket.on("error", (err) => console.error("[bim-devserver] socket error", { id: conn.id, err }));
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[bim-devserver] Port ${port} is already in use (another MutinyBIM dev server is probably running).\n` +
          `  Open http://127.0.0.1:${port}/ to use it, stop it with: lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
          `  or start on another port: BIM_DEV_PORT=${port + 1} npm run demo  (or BIM_DEV_PORT=${port + 1} node --import tsx packages/bim-devserver/src/server.ts)`,
      );
      process.exit(1);
    }
    console.error("[bim-devserver] server error", err);
    process.exit(1);
  });
  // The WebSocket server re-emits listen errors; the http server handler above reports them.
  wss.on("error", (err) => console.error("[bim-devserver] websocket server error", err.message));

  server.listen(port, () => {
    if (editor) {
      console.log(`[bim-devserver] MutinyBIM editor at http://127.0.0.1:${port}/m/${encodeURIComponent(mainModelId)}?view=plan  (open twice with &name=Priya and &name=Avery to edit together)`);
      console.log(`[bim-devserver] editor build ${editorMode === "eager" ? "starting now" : "starts on the first editor page"} (cached in ${editor.outDir})`);
    } else {
      console.log("[bim-devserver] editor off (BIM_DEV_EDITOR=off)");
    }
    console.log(`[bim-devserver] MutinyBIM F-a demo at http://localhost:${port}/feasibility  (open twice: ?name=Priya and ?name=Avery)`);
    console.log(`[bim-devserver] model ${mainModelId} at ws://127.0.0.1:${port}/sync  (pid ${process.pid}; branches and versions kept until it stops)`);
    if (editorMode === "eager") editor?.warm();
  });
}

main().catch((err) => {
  console.error("[bim-devserver] failed to start", err);
  process.exit(1);
});
