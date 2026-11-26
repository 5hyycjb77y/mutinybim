/** Run with native-install.py --browser. Existing profiles and databases never enter this walkthrough. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PgNativeModelMembers } from "../src/native-model-members.ts";
import { connect, PostgresCommitStore } from "../src/pg-store.ts";

const [temp, playwrightModule, providerPort, authorityPort, editorPort, screenshots, channel] = process.argv.slice(2);
const db = process.env.MUTINYBIM_NATIVE_DRILL_URL;
if (!temp || !db || new URL(db).hostname !== "127.0.0.1" || new URL(db).pathname !== "/native_drill" ||
    [providerPort, authorityPort, editorPort].some(port => !/^\d{1,5}$/.test(port))) throw new Error("Use native-install.py --browser");
const { chromium } = await import(playwrightModule);
const authorityDir = process.cwd(), repo = path.resolve(authorityDir, "../..");
const local = port => "http://127.0.0.1:" + port;
const editor = local(editorPort), provider = local(providerPort), authority = local(authorityPort);
const socket = "ws://127.0.0.1:" + authorityPort + "/sync";
const modelId = "east-plant", modelUrl = editor + "/m/east-plant?view=plan";
const sheetNumber = "M-101", title = "East plant field check";
const password = randomBytes(24).toString("base64url");
const cleanEnv = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const jobs = new Set(), profiles = [];

async function waitFor(check, message, ms = 45_000) {
  const end = Date.now() + ms;
  do { if (await check()) return; await delay(150); } while (Date.now() < end);
  throw new Error(message);
}
async function service(name, file, cwd, config, health) {
  const log = await open(path.join(temp, name + ".log"), "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", file], { cwd, env: { ...cleanEnv, ...config }, stdio: ["ignore", log.fd, log.fd] });
  jobs.add(child);
  await log.close();
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(name + " exited before becoming ready");
    try { return (await fetch(health, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, name + " did not start", 90_000);
  return child;
}
async function stop(child) {
  if (child.exitCode === null && !child.signalCode) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await done; } finally { clearTimeout(force); }
  }
  jobs.delete(child);
}
const startAuthority = () => service("authority", "src/server.ts", authorityDir, {
  MUTINYBIM_AUTH_MODE: "native", MUTINYBIM_LOCAL_STACK: "1", MUTINYBIM_DB_URL: db, MUTINYBIM_OIDC_ISSUER: provider,
  MUTINYBIM_OIDC_CLIENT_ID: "east-plant-editor", MUTINYBIM_EDITOR_ORIGIN: editor, BIM_AUTHORITY_SERVED_MODELS: modelId,
  BIM_AUTHORITY_BIND_HOST: "127.0.0.1", BIM_AUTHORITY_REAUTH_MS: "1000", PORT: authorityPort,
}, authority + "/health");

async function browserProfile(name) {
  const context = await chromium.launchPersistentContext(path.join(temp, name + "-profile"), {
    headless: true, channel: channel || undefined, env: cleanEnv, viewport: { width: 1500, height: 950 },
    colorScheme: name === "viewer" ? "dark" : "light", args: ["--enable-unsafe-swiftshader", "--disable-background-networking"],
  });
  profiles.push(context);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(35_000);
  const welcomes = [], hellos = [], outcomes = [], requests = [];
  page.on("response", response => {
    const pathname = new URL(response.url()).pathname;
    if (["/authorize", "/login", "/auth/native/start", "/auth/native/callback", "/auth/native/finish"].includes(pathname)) requests.push(pathname + " " + response.status());
  });
  page.on("websocket", ws => {
    if (ws.url() !== socket) return;
    ws.on("framesent", frame => {
      const m = JSON.parse(String(frame.payload));
      if (m.type === "hello") hellos.push({ actor: m.actor.id, token: m.token, modelId: m.modelId });
    });
    ws.on("framereceived", frame => {
      const m = JSON.parse(String(frame.payload));
      if (m.type === "welcome") welcomes.push(m);
      if (m.type === "outcome") outcomes.push(m.outcome);
    });
  });
  return { page, welcomes, hellos, outcomes, requests };
}
async function signIn({ page, requests }, username) {
  await page.goto(modelUrl, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill(username);
  assert.equal(new URL(page.url()).origin, provider);
  await page.getByLabel("Password").fill(password);
  const finish = page.waitForResponse(r => r.url() === editor + "/auth/native/finish" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await finish.catch(() => { throw new Error("Browser sign-in stopped after " + requests.join(", ")); });
  assert.equal(response.status(), 200, "The actual OIDC callback must issue a session");
  const identity = await response.json();
  await page.waitForURL(modelUrl);
  return identity;
}
async function sheetTool(page) {
  await page.getByTestId("ribbon-tab-sheets").click();
  return page.getByRole("toolbar", { name: "Sheets tools" }).getByRole("button", { name: "New sheet", exact: true });
}
function savedSheet(model) {
  return Object.values(model.elements).find(e => e.kind === "sheet" && e.number === sheetNumber && e.title === title);
}
async function head() {
  const sql = connect(db, 1);
  try { return await new PostgresCommitStore(sql, { modelId, owner: "browser-drill-reader", ownerMachine: null, leaseTtlMs: 10000 }).head(); }
  finally { await sql.end(); }
}

function changeMember(page, token, personId, expectedRole, role) {
  return page.evaluate(async ({ url, token, change }) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(change) });
    return { status: response.status, body: await response.json() };
  }, { url: authority + "/models/" + modelId + "/members", token, change: { personId, expectedRole, role } });
}

try {
  await service("provider", "drills/native-browser-provider.ts", authorityDir, { NATIVE_DRILL_ISSUER_PORT: providerPort,
    MUTINYBIM_EDITOR_ORIGIN: editor, NATIVE_DRILL_PASSWORD: password }, provider + "/.well-known/openid-configuration");
  let running = await startAuthority();
  await service("editor", "packages/bim-devserver/src/server.ts", repo, { BIM_DEV_PORT: editorPort,
    BIM_DEV_AUTHORITY_URL: socket, BIM_DEV_NATIVE_SIGNIN: "1", MUTINYBIM_DEMO_OUT: path.join(temp, "editor-build") }, editor + "/demo-config.json");
  const owner = await browserProfile("owner"), viewer = await browserProfile("viewer");
  // First sign-in creates the two native people. A test operator creates only this fresh model.
  const mara = await signIn(owner, "mara"), jules = await signIn(viewer, "jules");
  assert.notEqual(mara.userId, jules.userId);
  assert.ok(mara.displayName === "Mara" && jules.displayName === "Jules");
  execFileSync(process.execPath, ["--import", "tsx", "src/create-native-model.ts", modelId, "--owner", mara.userId],
    { cwd: authorityDir, env: { ...cleanEnv, MUTINYBIM_DB_URL: db }, stdio: "pipe" });
  const grant = await changeMember(owner.page, mara.token, jules.userId, null, "viewer");
  assert.deepEqual(grant, { status: 200, body: { result: "changed", role: "viewer" } });
  const stale = await changeMember(owner.page, mara.token, jules.userId, null, "editor");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.result, "conflict");
  assert.equal(stale.body.role, "viewer");
  const same = await changeMember(owner.page, mara.token, jules.userId, "viewer", "viewer");
  assert.deepEqual(same, { status: 200, body: { result: "unchanged", role: "viewer" } });
  const sql = connect(db, 1);
  try {
    const members = new PgNativeModelMembers(sql);
    assert.equal(await members.roleOf(modelId, mara.userId), "manager");
    assert.equal(await members.roleOf(modelId, jules.userId), "viewer");
    const [row] = await sql`select authorization_revision::int as revision from bim.model_authority where model_id = ${modelId}`;
    assert.equal(row.revision, 2, "The conflict and no-op must leave the grant revision unchanged");
  } finally { await sql.end(); }
  console.log("Both browser sign-ins completed. The operator designated Mara and her session granted Jules viewer access.");
  const m = await signIn(owner, "mara"), j = await signIn(viewer, "jules");
  assert.ok(m.userId === mara.userId && j.userId === jules.userId && m.token !== mara.token && j.token !== jules.token);
  await waitFor(() => owner.welcomes.at(-1)?.canWrite === true && viewer.welcomes.at(-1)?.canWrite === false, "Missing copy grants");
  const viewOnly = viewer.page.getByTestId("building-model-save-state");
  await waitFor(async () => (await viewOnly.textContent()) === "View only on this copy", "Viewer badge did not show read-only access");
  assert.ok(await (await sheetTool(viewer.page)).isDisabled(), "Viewer could create a sheet");
  const newSheet = await sheetTool(owner.page);
  assert.ok(await newSheet.isEnabled());
  await newSheet.click();
  const dialog = owner.page.getByRole("dialog", { name: "New sheet" });
  await dialog.getByLabel("Number", { exact: true }).fill(sheetNumber);
  await dialog.getByLabel("Name", { exact: true }).fill(title);
  const before = (await head()).revision;
  await dialog.getByRole("button", { name: "Create and open" }).click();
  await waitFor(() => owner.outcomes.some(o => o.status === "committed" && o.revision === before + 1), "Missing owner's commit receipt");
  const saved = await head(), sheet = savedSheet(saved);
  assert.ok(sheet, "Fresh PostgreSQL read did not contain the sheet"); assert.equal(saved.revision, before + 1);
  const count = viewer.welcomes.length;
  console.log("Owner saved " + sheetNumber + " at revision " + saved.revision + ". Restarting the real model server.");
  await stop(running);
  running = await startAuthority();
  await waitFor(() => viewer.welcomes.length > count, "Viewer did not reconnect to the restarted authority");
  const welcome = viewer.welcomes.at(-1), hello = viewer.hellos.at(-1);
  assert.equal(welcome.model.modelId, modelId); assert.equal(welcome.model.revision, saved.revision);
  assert.equal(welcome.canWrite, false); assert.deepEqual(savedSheet(welcome.model), sheet);
  assert.ok(hello.actor === j.userId && hello.modelId === modelId && hello.token === j.token, "Viewer identity or session changed on reconnect");
  await waitFor(async () => (await viewOnly.textContent()) === "View only on this copy", "Viewer badge lost its read-only state");
  assert.ok(await (await sheetTool(viewer.page)).isDisabled(), "Viewer's sheet editing tool was enabled after reconnect");
  const row = viewer.page.getByTestId("sheet-row-" + sheetNumber);
  await row.getByRole("button", { name: new RegExp(title) }).click();
  assert.ok(await row.isVisible(), "Viewer could not see the saved sheet in the editor");
  for (const profile of [owner, viewer]) {
    await profile.page.getByTestId("drawing-paper").waitFor({ state: "visible" });
    await waitFor(async () => (await profile.page.getByTestId("printed-pdf").getAttribute("data-revision")) === String(saved.revision),
      "The sheet preview did not render the saved revision");
    await profile.page.getByLabel("1 other person here", { exact: true }).waitFor();
    assert.equal(await profile.page.getByTestId("mutiny-root").getAttribute("data-mutiny-scheme"), profile === viewer ? "dark" : "light");
  }
  assert.ok(await viewer.page.getByRole("button", { name: "Edit title block", exact: true }).isDisabled());
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await owner.page.screenshot({ path: path.join(screenshots, "owner.png") });
    await viewer.page.screenshot({ path: path.join(screenshots, "viewer.png") });
  }
  // A regular save on another socket from the same viewer profile checks the authority independently of its disabled button.
  const refused = await viewer.page.evaluate(({ socket, modelId, person, token }) => new Promise((resolve, reject) => {
    const ws = new WebSocket(socket), key = crypto.randomUUID(), actor = { id: person, name: "Jules", kind: "human" };
    const timer = setTimeout(() => { ws.close(); reject(new Error("No viewer save result")); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", modelId, actor, token, lastRevision: -1 }));
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === "welcome") ws.send(JSON.stringify({ type: "command", request: { actor, baseRevision: msg.model.revision,
        idempotencyKey: key, command: { type: "create_level", levelId: "viewer-check", name: "Viewer check", elevationMm: 6700 } } }));
      if (msg.type === "outcome" || msg.type === "denied" || msg.type === "error") {
        clearTimeout(timer); ws.close(); resolve(msg.outcome?.error?.code ?? msg.type);
      }
    };
  }), { socket, modelId, person: j.userId, token: j.token });
  assert.equal(refused, "forbidden");
  const final = await head();
  assert.equal(final.revision, saved.revision); assert.ok(!final.elements["viewer-check"]); assert.deepEqual(savedSheet(final), sheet);
  const promoted = await changeMember(owner.page, m.token, j.userId, "viewer", "editor");
  assert.deepEqual(promoted, { status: 200, body: { result: "changed", role: "editor" } });
  await waitFor(async () => (await viewOnly.textContent()) === "Connected. All changes saved", "Jules did not receive edit access");
  assert.ok(await (await sheetTool(viewer.page)).isEnabled());
  const demoted = await changeMember(owner.page, m.token, j.userId, "editor", "viewer");
  assert.deepEqual(demoted, { status: 200, body: { result: "changed", role: "viewer" } });
  await waitFor(async () => (await viewOnly.textContent()) === "View only on this copy", "Jules did not receive the viewer grant");
  assert.ok(await (await sheetTool(viewer.page)).isDisabled());
  const removed = await changeMember(owner.page, m.token, j.userId, "viewer", null);
  assert.deepEqual(removed, { status: 200, body: { result: "changed", role: null } });
  await waitFor(async () => (await viewOnly.textContent()) === "No access to edit this model", "Jules did not receive the model access denial");
  console.log(JSON.stringify({ modelId, sheet: sheetNumber, title, before, saved: saved.revision, viewerReconnectedAt: welcome.model.revision,
    sameViewerSession: true, viewerWrite: refused, membershipHttp: { stale: stale.status, noOp: same.body.result,
      promoted: promoted.body.role, demoted: demoted.body.role, removed: removed.body.role }, final: final.revision }));
} finally {
  for (const profile of profiles.reverse()) await profile.close();
  for (const job of [...jobs].reverse()) await stop(job);
}
