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
import { asRevision, branchModelId, buildSheetScene, buildSheetSceneFor, definitionTypes, demoSheetDefinition, documentIndex, elementValues, exampleRooftopUnit, executeCommand, isBranchId, parseBranchModelId, type Command, type DrawingItem, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { createDemoModel, createPlacedDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { captureSnapshot, issueFromSnapshot, renderSheetPdf } from "@permitzip/bim-sheets";
import { InMemoryBranchHost, type SyncHub } from "@permitzip/bim-sync";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { createShowcaseDemoModel } from "@permitzip/bim-first-party/seed";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { createEditorDemo, type EditorDemo } from "../../bim-editor/demo/server";
import { createElectricalDemoModel } from "./electrical-demo";
import { createArchOverhaulDemoModel } from "./arch-overhaul-demo";
import { enlargedPlansDemoModel } from "./enlarged-plans-demo";
import { createMechanicalDetailsDemoModel } from "./mechanical-details-demo";
import type { LocalFirmParts } from "./firm-parts";

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

/** Project A has a drawn family to publish. Project B starts with a roof to place it on. */
function firmPartsDemo(id: "firm-parts-a" | "firm-parts-b"): ModelState {
  let model = createDemoModel(id);
  const setup: Command[] = [{ type: "create_level", levelId: "roof", name: "Roof", elevationMm: 0 }];
  if (id === "firm-parts-a") {
    setup.push({ type: "save_part_types", label: "Rooftop unit on curb", types: definitionTypes(exampleRooftopUnit()) });
  }
  for (const command of setup) {
    const result = executeCommand(model, command);
    if (!result.ok) throw new Error(`[bim-devserver] ${id}: ${result.error.message}`);
    model = { ...result.model, revision: asRevision(model.revision + 1) };
  }
  return model;
}

const startingModel =
  process.env.BIM_DEV_MODEL === "showcase"
    ? createShowcaseDemoModel("showcase-demo")
    : process.env.BIM_DEV_MODEL === "arch-overhaul"
      ? createArchOverhaulDemoModel("arch-overhaul-demo")
      : process.env.BIM_DEV_MODEL === "electrical-plan"
        ? createElectricalDemoModel("electrical-plan-demo")
        : process.env.BIM_DEV_MODEL === "mechanical-details"
          ? await createMechanicalDetailsDemoModel("mechanical-details-demo")
          : process.env.BIM_DEV_MODEL === "site-7301"
            ? createPlacedDemoModel("site-7301", SITE_7301_ORIGIN)
            : process.env.BIM_DEV_MODEL === "open-issue"
              ? openIssueModel()
              : process.env.BIM_DEV_MODEL === "sample-market-gas"
                ? sampleMarketGasModel()
                : process.env.BIM_DEV_MODEL === "enlarged-plans"
                  ? enlargedPlansDemoModel()
                  : process.env.BIM_DEV_MODEL === "firm-parts-a" || process.env.BIM_DEV_MODEL === "firm-parts-b"
                    ? firmPartsDemo(process.env.BIM_DEV_MODEL)
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

const editorMode = process.env.BIM_DEV_EDITOR ?? (process.env.BIM_DEV_MODEL && process.env.BIM_DEV_MODEL !== "showcase" ? "lazy" : "eager");
if (!["eager", "lazy", "off"].includes(editorMode)) {
  console.error(`[bim-devserver] BIM_DEV_EDITOR="${editorMode}" is not one of eager, lazy, off`);
  process.exit(1);
}

const externalAuthority = process.env.BIM_DEV_AUTHORITY_URL ?? null;
const signInUrl = process.env.BIM_DEV_SIGNIN_URL ?? null;
const nativeSignIn = process.env.BIM_DEV_NATIVE_SIGNIN === "1";
if (nativeSignIn && (!externalAuthority || signInUrl)) throw new Error("Native sign-in needs BIM_DEV_AUTHORITY_URL and its own OIDC provider");
if (externalAuthority && !signInUrl && !nativeSignIn) {
  console.error("[bim-devserver] BIM_DEV_AUTHORITY_URL needs BIM_DEV_SIGNIN_URL: the model server only opens to someone signed in");
  process.exit(1);
}
const landingModel = nativeSignIn && externalAuthority ? new URL(externalAuthority).searchParams.get("model") ?? mainModelId : mainModelId;

const editor: EditorDemo | null =
  editorMode === "off"
    ? null
    : createEditorDemo({
        mainModelId: async () => landingModel,
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
  const firstSheet = elementValues(snapshot.model.elements).find((el): el is Extract<typeof el, { kind: "sheet" }> => el.kind === "sheet" && !el.deleted);
  const scene = firstSheet ? buildSheetSceneFor(snapshot.model, firstSheet.id, { projectName: "MutinyBIM Showcase" }) : buildSheetScene(snapshot.model, demoSheetDefinition());
  const title = firstSheet ? `${firstSheet.number} ${firstSheet.title}` : "M-101 Mechanical Plan";
  const rawFileTag = firstSheet ? firstSheet.number : "M-101";
  const fileTag = rawFileTag.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "sheet";
  const started = performance.now();
  const pdf = (
    await renderSheetPdf(scene, {
      title,
      modelRevision: snapshot.revision,
      snapshotSha256: sha,
      renderer: RENDERER,
    })
  ).bytes;
  const ms = Math.round(performance.now() - started);
  console.log(`[bim-devserver] exported ${fileTag}`, { revision: snapshot.revision, sha256: sha.slice(0, 12), ms, bytes: pdf.length });
  send(res, 200, "application/pdf", pdf, {
    "content-disposition": `inline; filename="${fileTag}-rev${snapshot.revision}.pdf"`,
    "x-model-revision": String(snapshot.revision),
    "x-snapshot-sha256": sha,
    "x-render-ms": String(ms),
  });
}

/** Which model server the editor page opens, and the sign-in it presents there. */
async function demoConfig(res: ServerResponse, url: URL, firmParts: LocalFirmParts | null): Promise<void> {
  if (nativeSignIn) return send(res, 200, "application/json", JSON.stringify({ authority: "native", authorityUrl: externalAuthority }));
  if (!externalAuthority || !signInUrl) return send(res, 200, "application/json", JSON.stringify({ authority: "in-process", firmPartsId: firmParts?.id }));
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

async function serveFirmParts(req: IncomingMessage, res: ServerResponse, url: URL, catalog: LocalFirmParts) {
  const json = (status: number, body: unknown) => send(res, status, "application/json", JSON.stringify(body));
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || (req.headers.origin && req.headers.origin !== url.origin)) {
    return json(403, { error: "Open the local editor on this computer to use its catalog." });
  }
  if (url.searchParams.get("library") !== catalog.id) return json(412, { error: "The editor is connected to a different parts catalog." });
  if (req.method === "GET") return json(200, catalog.list());
  if (req.method !== "POST") return json(405, { error: "Use GET to list parts or POST to publish." });
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return json(415, { error: "The publish request must be JSON." });

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) {
      req.resume();
      return json(413, { error: "The part definition exceeds the 8 MiB local catalog limit." });
    }
    chunks.push(chunk);
  }
  let request: unknown;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(400, { error: "The publish request could not be read as JSON." });
  }
  const result = catalog.publish(request);
  return json(result.status, result.body);
}

async function handle(req: IncomingMessage, res: ServerResponse, clientJs: () => Promise<string>, css: string, firmParts: LocalFirmParts | null) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (nativeSignIn && req.method === "GET" && url.pathname === "/auth/native/callback" && editor) {
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    await editor.handle(req, res, new URL("/m/sign-in", url));
    return;
  }
  if (nativeSignIn && externalAuthority && req.method === "POST" && ["/auth/native/start", "/auth/native/finish", "/auth/native/sign-out"].includes(url.pathname)) {
    const target = new URL(url.pathname, externalAuthority);
    target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    const transport = target.protocol === "https:" ? await import("node:https") : await import("node:http");
    const forward = transport.request(target, { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "",
      origin: req.headers.origin ?? "", cookie: req.headers.cookie ?? "",
      ...(url.pathname === "/auth/native/sign-out" && req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on("error", () => { if (!res.headersSent) send(res, 502, "text/plain", "The local model server is unavailable."); else res.end(); });
    req.pipe(forward);
    return;
  }
  if (req.method === "GET" && url.pathname === "/demo-config.json") return demoConfig(res, url, firmParts);
  if (firmParts && url.pathname === "/api/bim/library/part-types") return serveFirmParts(req, res, url, firmParts);
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
  if (req.method === "GET" && url.pathname === "/debug/markups") {
    const served = await models.open(url.searchParams.get("model") ?? mainModelId);
    if (!served) return send(res, 404, "application/json", JSON.stringify({ error: "No such model or branch here." }));
    const head = await served.sequencer.head();
    const idx = documentIndex(head);
    const all: Array<{
      itemId: string;
      sheetId: string;
      sheetNumber: string;
      points: DrawingItem["points"];
      markup: NonNullable<DrawingItem["markup"]>;
    }> = [];
    for (const sheet of idx.sheets) {
      for (const item of idx.markupsBySheet.get(sheet.id) ?? []) {
        if (item.deleted || !item.markup) continue;
        all.push({
          itemId: item.id,
          sheetId: sheet.id,
          sheetNumber: sheet.number,
          points: item.points,
          markup: item.markup,
        });
      }
    }
    return send(res, 200, "application/json", JSON.stringify({ modelId: head.modelId, revision: head.revision, count: all.length, markups: all }, null, 2));
  }
  if (req.method === "POST" && url.pathname === "/debug/save-showcase-markups") {
    const allowSave = process.env.MUTINYBIM_ALLOW_SAVE_SHOWCASE_MARKUPS === "1" || process.argv.includes("--allow-save-showcase-markups");
    if (!allowSave) {
      return send(
        res,
        403,
        "application/json",
        JSON.stringify({
          error: "Showcase markup saving is disabled by default. Restart devserver with MUTINYBIM_ALLOW_SAVE_SHOWCASE_MARKUPS=1 (or --allow-save-showcase-markups) and send header 'X-Mutiny-Dev-Save: 1'.",
        }),
      );
    }
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const origin = req.headers.origin;
    const originOk =
      !origin ||
      origin === `http://127.0.0.1:${url.port || "80"}` ||
      origin === `http://localhost:${url.port || "80"}`;
    const saveHeader = req.headers["x-mutiny-dev-save"];
    if (!isLoopback || !originOk || saveHeader !== "1") {
      return send(
        res,
        403,
        "application/json",
        JSON.stringify({ error: "Forbidden: requires loopback client, same-origin (or no Origin), and 'X-Mutiny-Dev-Save: 1' header." }),
      );
    }
    const served = await models.open(url.searchParams.get("model") ?? mainModelId);
    if (!served) return send(res, 404, "application/json", JSON.stringify({ error: "No such model or branch here." }));
    const head = await served.sequencer.head();
    const idx = documentIndex(head);
    const commands: Array<Extract<Command, { type: "add_sheet_markup" }>> = [];
    for (const sheet of idx.sheets) {
      for (const item of idx.markupsBySheet.get(sheet.id) ?? []) {
        if (item.deleted || !item.markup) continue;
        commands.push({
          type: "add_sheet_markup",
          itemId: item.id,
          sheetId: sheet.id,
          points: item.points.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
          markup: item.markup,
        });
      }
    }
    const targetPath = path.join(root, "packages/bim-first-party/src/seed/showcase-markups.ts");
    const tsSource =
      `import type { Command } from "@permitzip/bim-kernel";\n\n` +
      `export type ShowcaseMarkupCommand = Extract<Command, { type: "add_sheet_markup" }>;\n\n` +
      `/**\n` +
      ` * Seeded sheet review markups for the MutinyBIM showcase model (\`createShowcaseDemoModel\`).\n` +
      ` * Saved from live showcase rev ${head.revision} (${commands.length} stroke${commands.length === 1 ? "" : "s"}).\n` +
      ` */\n` +
      `export const SHOWCASE_SHEET_MARKUPS: readonly ShowcaseMarkupCommand[] = ${JSON.stringify(commands, null, 2)};\n`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(targetPath, tsSource, "utf8");
    console.log("[bim-devserver] saved showcase markups", { count: commands.length, revision: head.revision, targetPath });
    return send(res, 200, "application/json", JSON.stringify({ ok: true, saved: commands.length, revision: head.revision, file: "packages/bim-first-party/src/seed/showcase-markups.ts" }));
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

  const catalogPath = process.env.BIM_DEV_FIRM_PARTS_DB;
  const firmParts = catalogPath && !externalAuthority ? new (await import("./firm-parts")).LocalFirmParts(catalogPath) : null;
  const server = createServer((req, res) => {
    handle(req, res, clientJs, css, firmParts).catch((err) => {
      console.error("[bim-devserver] request failed", { path: req.url?.split("?")[0], err });
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

  server.on("close", () => firmParts?.close());
  // Docker forwards the host's loopback port to the editor's container interface.
  const listenHost = process.env.BIM_DEV_BIND_HOST ?? (nativeSignIn || firmParts ? "127.0.0.1" : undefined);
  server.listen({ port, host: listenHost }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    if (editor) {
      if (nativeSignIn) console.log("[bim-devserver] Native sign-in ready. Open a served model at the configured editor origin.");
      else console.log(`[bim-devserver] MutinyBIM editor at http://127.0.0.1:${listenPort}/m/${encodeURIComponent(mainModelId)}?view=plan  (open twice with &name=Priya and &name=Avery to edit together)`);
      console.log(`[bim-devserver] editor build ${editorMode === "eager" ? "starting now" : "starts on the first editor page"} (cached in ${editor.outDir})`);
    } else {
      console.log("[bim-devserver] editor off (BIM_DEV_EDITOR=off)");
    }
    console.log(`[bim-devserver] MutinyBIM F-a demo at http://localhost:${listenPort}/feasibility  (open twice: ?name=Priya and ?name=Avery)`);
    console.log(`[bim-devserver] model ${mainModelId} at ws://127.0.0.1:${listenPort}/sync  (pid ${process.pid}; branches and versions kept until it stops)`);
    if (editorMode === "eager") editor?.warm();
  });
}

main().catch((err) => {
  console.error("[bim-devserver] failed to start", err);
  process.exit(1);
});
