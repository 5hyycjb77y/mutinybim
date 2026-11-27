/** Run against a disposable, already-started native Compose project. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const modelId = "east-plant";
const savedStatus = "Connected. All changes saved";
const noAccess = "No access to edit this model";
const viewOnly = "View only on this copy";
const deck = "East plant operator deck";

async function configuration(file) {
  let cfg;
  try { cfg = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("Pass the private browser fixture JSON as the only argument."); }
  assert.ok(["demo", "keycloak"].includes(cfg.issuerMode), "Expected a demo or Keycloak fixture");
  assert.ok(typeof cfg.dockerExecutable === "string" && Array.isArray(cfg.dockerArgs) && cfg.dockerArgs.every(arg => typeof arg === "string") &&
    cfg.dockerArgs[0] === "compose" && cfg.dockerArgs.some(arg => arg === "-p" || arg === "--project-name"), "Use an explicitly named disposable Compose project");
  for (const person of ["mara", "jules"]) {
    const credential = cfg.credentials?.[person];
    assert.ok(typeof credential?.username === "string" && Boolean(credential.username) && typeof credential.password === "string" &&
      Boolean(credential.password), "Supply both disposable sign-in credentials");
  }
  return cfg;
}

function loopback(value, protocols = ["http:", "https:"]) {
  const url = new URL(value);
  assert.ok(protocols.includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    !url.username && !url.password, "The browser drill requires loopback service URLs");
  return url;
}

function compose(cfg, args, input) {
  try {
    return execFileSync(cfg.dockerExecutable, [...cfg.dockerArgs, ...args], { input, encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], timeout: 45_000 }).trim();
  } catch {
    throw new Error("The local Compose " + args[0] + " command failed.");
  }
}

function sql(cfg, query) {
  return JSON.parse(compose(cfg, ["exec", "-T", "db", "sh", "-c",
    'exec psql -XAtv ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'], query));
}

function installation(cfg) {
  return sql(cfg, `select json_build_object('mode', (select mode from bim.installation where id),
    'migrations', (select count(*) from bim.schema_migrations), 'models', (select count(*) from bim.models),
    'people', (select count(*) from bim.people), 'postgresMajor', current_setting('server_version_num')::int / 10000,
    'started', pg_postmaster_start_time());`);
}

function uuid(value) {
  assert.ok(typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value), "The editor did not return a person ID");
  return "'" + value + "'::uuid";
}

function roles(cfg, owner, coworker = null) {
  const mara = uuid(owner), jules = coworker === null ? "null::uuid" : uuid(coworker);
  return sql(cfg, `select json_build_object('maraDesignated', a.owner_person_id = ${mara},
    'authorizationRevision', a.authorization_revision, 'mainRevision', m.revision,
    'maraRole', (select role from bim.model_members where model_id = m.id and person_id = ${mara}),
    'julesRole', (select role from bim.model_members where model_id = m.id and person_id = ${jules}))
    from bim.model_authority a join bim.models m on m.id = a.model_id where m.id = 'east-plant';`);
}

function head(cfg) {
  return sql(cfg, `select json_build_object('revision', m.revision, 'levels', coalesce((select json_agg(body) from bim.elements
    where model_id = m.id and kind = 'level'), '[]'::json)) from bim.models m where m.id = 'east-plant';`);
}

async function waitFor(probe, message, timeout = 45_000) {
  const end = Date.now() + timeout;
  do { if (await probe()) return; await delay(120); } while (Date.now() < end);
  throw new Error(message);
}

async function healthy(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(800) })).ok; }
  catch { return false; }
}

async function restart(cfg, editor, authority) {
  const discovery = cfg.issuerUrl.replace(/\/$/, "") + "/.well-known/openid-configuration";
  if (cfg.issuerMode === "demo") {
    compose(cfg, ["stop", "editor", "authority", "signin", "db"]);
    compose(cfg, ["up", "-d", "--no-build", "--pull", "never"]);
  } else {
    // Keycloak shares the database container's network namespace.
    compose(cfg, ["stop", "editor", "authority", "review-issuer"]);
    compose(cfg, ["restart", "db"]);
    await waitFor(() => {
      try { return Boolean(installation(cfg).started); } catch { return false; }
    }, "PostgreSQL did not return after restart");
    compose(cfg, ["start", "review-issuer"]);
    await waitFor(() => healthy(discovery), "The local issuer did not return");
    compose(cfg, ["up", "-d", "--no-deps", "--no-recreate", "--no-build", "--pull", "never", "authority", "editor"]);
  }
  await waitFor(async () => await healthy(authority + "/health") && await healthy(editor + "/demo-config.json"),
    "The native authority and editor did not restart");
  await waitFor(() => healthy(discovery), "The local issuer did not return");
}

function observe(page, endpoint) {
  page.setDefaultTimeout(25_000);
  const events = { page, sockets: [], hellos: [], welcomes: [], grants: [], changes: [], outcomes: [] };
  page.on("websocket", socket => {
    if (socket.url() !== endpoint) return;
    events.sockets.push(socket);
    socket.on("framesent", frame => {
      const msg = JSON.parse(String(frame.payload));
      if (msg.type === "hello") events.hellos.push(msg);
    });
    socket.on("framereceived", frame => {
      const msg = JSON.parse(String(frame.payload));
      if (msg.type === "welcome") events.welcomes.push(msg);
      if (msg.type === "model_access") events.grants.push(msg.canWrite);
      if (msg.type === "changeset") events.changes.push(msg.changeset);
      if (msg.type === "outcome") events.outcomes.push(msg.outcome);
    });
  });
  return events;
}

async function signIn(tab, editor, issuer, credential) {
  const page = tab.page, target = editor + "/m/east-plant?view=plan";
  const started = Date.now(), remaining = () => Math.max(1, 75_000 - (Date.now() - started));
  const field = page.getByLabel(/username|email/i).first();
  const password = page.getByLabel("Password", { exact: true });
  const hasLoginForm = async () => (await field.isVisible()) && (await password.isVisible());
  const requests = new Map();
  let reply, stage = "opening-model";
  const onRequest = request => {
    const url = new URL(request.url());
    const native = url.origin === editor && request.method() === "POST" &&
      ["/auth/native/start", "/auth/native/finish"].includes(url.pathname);
    if (native || (url.origin === issuer && request.isNavigationRequest())) {
      requests.set(request, { location: url.origin + url.pathname, method: request.method(), status: "pending" });
    }
  };
  const onResponse = response => {
    const trace = requests.get(response.request());
    if (!trace) return;
    trace.status = response.status();
    if (trace.location === editor + "/auth/native/finish") trace.reply = response;
  };
  const onFinished = request => {
    const trace = requests.get(request);
    if (trace?.reply) reply = trace.reply;
  };
  const onFailed = request => {
    const trace = requests.get(request);
    if (trace) trace.status = "network-failed";
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  try {
    await page.goto(target, { waitUntil: "commit", timeout: remaining() });
    stage = "waiting-for-provider-or-completion";
    await waitFor(async () => Boolean(reply) || (new URL(page.url()).origin === issuer && await hasLoginForm()),
      "The provider form or editor completion did not appear", remaining());
    if (!reply) {
      stage = "submitting-provider-login";
      assert.equal(new URL(page.url()).origin, issuer);
      await field.fill(credential.username, { timeout: remaining() });
      await password.fill(credential.password, { timeout: remaining() });
      await page.getByRole("button", { name: /^(sign in|log in)$/i }).click({ timeout: remaining() });
    }
    stage = "waiting-for-editor-completion";
    await waitFor(() => Boolean(reply), "The editor did not complete native sign-in", remaining());
    stage = "validating-editor-completion";
    if (reply.status() !== 200) throw new Error("Provider completion was refused");
    const identity = await reply.json();
    stage = "returning-to-model";
    await page.waitForURL(target, { timeout: remaining() });
    if (credential.displayName !== undefined) assert.equal(identity.displayName, credential.displayName);
    return identity;
  } catch {
    const url = new URL(page.url());
    const location = ["http:", "https:"].includes(url.protocol) ? url.origin + url.pathname : null;
    const error = page.locator('[role="alert"]:visible, .alert-error:visible, #input-error:visible, #kc-error-message:visible').first();
    console.error(JSON.stringify({ signInFailure: { stage, location, elapsedMs: Date.now() - started,
      requests: [...requests.values()].map(({ reply: _reply, ...trace }) => trace).slice(-24),
      loginFormVisible: await hasLoginForm().catch(() => false), errorVisible: await error.isVisible().catch(() => false),
    } }));
    throw new Error("The local provider sign-in did not complete for a fixture profile.");
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  }
}

async function status(tab, expected, identity) {
  await waitFor(async () => (await tab.page.getByTestId("building-model-save-state").textContent()) === expected,
    "The editor did not show " + expected);
  if (identity) {
    const hello = tab.hellos.at(-1);
    assert.ok(hello?.actor.id === identity.userId && hello.token === identity.token && hello.modelId === modelId,
      "The editor did not use its original native session");
  }
}

async function members(tab) {
  await tab.page.getByTestId("ribbon-tab-manage").click();
  await tab.page.getByRole("button", { name: "Manage members", exact: true }).click();
  return tab.page.getByRole("dialog", { name: "Manage members", exact: true });
}

async function personId(tab, identity) {
  const field = (await members(tab)).getByLabel("Your person ID", { exact: true });
  const id = await field.inputValue();
  assert.ok(id === identity.userId && (await field.getAttribute("readonly")) !== null, "The editor did not show the signed-in person ID");
  return { id, field };
}

async function changeRole(tab, displayName, role, id) {
  const dialog = await members(tab);
  if (id) {
    await dialog.getByLabel("Person ID", { exact: true }).fill(id);
    await dialog.getByRole("button", { name: "Look up person" }).click();
  } else {
    await dialog.getByRole("button", { name: "Change role for " + displayName, exact: true }).click();
  }
  await dialog.getByLabel("New role", { exact: true }).selectOption({ label: role });
  await dialog.getByRole("button", { name: "Review change" }).click();
  const result = tab.page.waitForResponse(response => new URL(response.url()).pathname === "/models/east-plant/members" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirm change" }).click();
  const reply = await result;
  assert.equal(reply.status(), 200);
  assert.deepEqual(await reply.json(), { result: "changed", role: role.toLowerCase() });
  await dialog.getByText(displayName + "’s " + role + " role was saved.", { exact: false }).waitFor();
  await tab.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function addLevel(cfg, tab, name, feet) {
  const before = head(cfg).revision;
  await tab.page.getByTestId("ribbon-tab-model").click();
  await tab.page.getByTestId("ribbon-add-level").click();
  const dialog = tab.page.getByRole("dialog", { name: "Add a level" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Floor (ft)").fill(String(feet));
  await dialog.getByTestId("add-level-submit").click();
  await waitFor(() => tab.outcomes.some(outcome => outcome.status === "committed" && outcome.revision === before + 1), "The ordinary save did not complete");
  const after = head(cfg), elevationMm = feet * 3048 / 10;
  assert.equal(after.revision, before + 1);
  assert.equal(after.levels.find(level => level.name === name)?.elevationMm, elevationMm);
  return { name, before, revision: after.revision, elevationMm };
}

async function run() {
  const cfg = await configuration(process.argv[2]);
  const editor = loopback(cfg.editorOrigin).origin, issuer = loopback(cfg.issuerUrl).origin;
  const config = await (await fetch(editor + "/demo-config.json")).json();
  assert.equal(config.authority, "native");
  const endpoint = loopback(config.authorityUrl, ["ws:", "wss:"]);
  const authority = loopback(cfg.authorityOrigin ?? endpoint.origin.replace(/^ws/, "http")).origin;
  const { chromium } = await import(cfg.playwrightModule ?? "playwright");
  const outputDir = cfg.outputDir && path.resolve(cfg.outputDir);
  if (outputDir) await mkdir(outputDir, { recursive: true });
  const profiles = await mkdtemp(path.join(tmpdir(), "native-compose-browser-"));
  const contexts = [], receipt = {};
  const record = async (key, value) => {
    receipt[key] = value;
    console.log(JSON.stringify({ [key]: value }));
    if (outputDir) await writeFile(path.join(outputDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  };
  const capture = async (tab, name, mask = []) => {
    if (outputDir) await tab.page.screenshot({ path: path.join(outputDir, name + ".png"), mask });
  };
  const open = async (label, colorScheme) => {
    const context = await chromium.launchPersistentContext(path.join(profiles, label), {
      headless: true, channel: cfg.browserChannel, colorScheme, viewport: { width: 1500, height: 950 },
      args: ["--enable-unsafe-swiftshader", "--disable-background-networking"],
    });
    contexts.push(context);
    return observe(context.pages()[0] ?? await context.newPage(), endpoint.href);
  };
  try {
    const fresh = installation(cfg);
    assert.ok(fresh.mode === "native" && fresh.migrations === 3 && fresh.models === 0 && fresh.people === 0 && fresh.postgresMajor === 17,
      "Run on a freshly installed, empty native Compose database");
    const { started, ...initial } = fresh;
    await record("installation", { ...initial, issuerMode: cfg.issuerMode, loopbackEndpoints: true });
    const mara = await open("mara", "light"), jules = await open("jules", "dark");
    const root = await fetch(editor + "/", { redirect: "manual" });
    assert.equal(root.status, 302);
    const landing = "/m/" + modelId + "?view=plan";
    assert.equal(root.headers.get("location"), landing);
    const alias = new URL(landing, editor);
    alias.hostname = alias.hostname === "localhost" ? "127.0.0.1" : "localhost";
    await mara.page.goto(alias.href);
    const alert = mara.page.getByRole("alert");
    await alert.waitFor({ state: "visible", timeout: 75_000 });
    assert.equal(await alert.textContent(), "Open the editor at " + editor + " to sign in.");
    await capture(mara, "open-configured-origin");
    await record("editorEntry", { landing, configuredOrigin: editor, alternateOrigin: alias.origin, correctionShown: true });
    const loginMara = () => signIn(mara, editor, issuer, cfg.credentials.mara);
    const loginJules = () => signIn(jules, editor, issuer, cfg.credentials.jules);
    const firstMara = await loginMara();
    await status(mara, noAccess);
    const owner = await personId(mara, firstMara);
    assert.equal(installation(cfg).models, 0);
    await capture(mara, "mara-before-provisioning", [owner.field]);
    const created = compose(cfg, ["exec", "-T", "authority", "node", "--import", "tsx", "src/create-native-model.ts", modelId, "--owner", owner.id]);
    assert.match(created, /Created model "east-plant"/);
    const firstRole = roles(cfg, owner.id);
    assert.deepEqual(firstRole, { maraDesignated: true, authorizationRevision: 1, mainRevision: 0, maraRole: "manager", julesRole: null });
    await record("provisioning", { personIdReadBeforeModelExisted: true, ownerCliExitCode: 0, ...firstRole });

    const activeMara = await loginMara();
    assert.ok(activeMara.userId === owner.id && activeMara.token !== firstMara.token);
    await status(mara, savedStatus, activeMara);
    const firstJules = await loginJules();
    await status(jules, noAccess);
    const coworker = await personId(jules, firstJules);
    assert.notEqual(coworker.id, owner.id);
    await changeRole(mara, firstJules.displayName, "Editor", coworker.id);
    const granted = roles(cfg, owner.id, coworker.id);
    assert.deepEqual(granted, { maraDesignated: true, authorizationRevision: 2, mainRevision: 1, maraRole: "manager", julesRole: "editor" });
    await record("editorGrant", granted);
    const activeJules = await loginJules();
    assert.ok(activeJules.userId === coworker.id && activeJules.token !== firstJules.token);
    await status(jules, savedStatus, activeJules);
    const saved = await addLevel(cfg, jules, deck, 26);
    await waitFor(() => mara.changes.some(change => change.revision === saved.revision), "Mara did not receive the saved change");
    await record("julesSave", { ...saved, ownerReceived: true });

    const socketCount = jules.sockets.length;
    await changeRole(mara, firstJules.displayName, "Viewer");
    await waitFor(() => jules.grants.at(-1) === false, "The open editor did not receive the viewer grant");
    await status(jules, viewOnly, activeJules);
    assert.equal(jules.sockets.length, socketCount);
    const before = roles(cfg, owner.id, coworker.id);
    assert.deepEqual(before, { maraDesignated: true, authorizationRevision: 3, mainRevision: 2, maraRole: "manager", julesRole: "viewer" });
    await record("downgrade", { ...before, sameSocket: true, uiStatus: viewOnly });

    const doc = await jules.page.evaluate(() => performance.timeOrigin);
    const welcomes = [mara.welcomes.length, jules.welcomes.length];
    await restart(cfg, editor, authority);
    assert.notEqual(installation(cfg).started, started);
    await waitFor(() => mara.welcomes.length > welcomes[0] && jules.welcomes.length > welcomes[1], "The original tabs did not reconnect");
    await status(mara, savedStatus, activeMara);
    await status(jules, viewOnly, activeJules);
    assert.equal(await jules.page.evaluate(() => performance.timeOrigin), doc);
    const welcome = jules.welcomes.at(-1);
    assert.ok(welcome.model.modelId === modelId && welcome.model.revision === saved.revision && welcome.canWrite === false);
    assert.equal(Object.values(welcome.model.elements).find(level => level.kind === "level" && level.name === deck)?.elevationMm, saved.elevationMm);
    assert.equal(head(cfg).levels.find(level => level.name === deck)?.elevationMm, saved.elevationMm);
    assert.deepEqual(roles(cfg, owner.id, coworker.id), before);
    await jules.page.getByTestId("ribbon-tab-model").click();
    assert.ok(await jules.page.getByTestId("ribbon-add-level").isDisabled());
    await capture(jules, "jules-reconnected-view-only");
    await record("restart", { postgresStartChanged: true, bothOriginalSessions: true, sameViewerDocument: true,
      viewerReceivedPersistedLevel: true, viewerAddLevelDisabled: true, ...before });

    const marker = await addLevel(cfg, mara, "East plant restart marker", 35);
    await waitFor(() => jules.changes.some(change => change.revision === marker.revision), "Jules did not receive the new owner edit");
    await status(jules, viewOnly, activeJules);
    const final = roles(cfg, owner.id, coworker.id);
    assert.deepEqual(final, { ...before, mainRevision: 3 });
    await record("postRestartSave", { ...marker, viewerReceived: true, final });

    const otherMara = await open("mara-independent", "dark");
    const independent = await signIn(otherMara, editor, issuer, cfg.credentials.mara);
    assert.ok(independent.userId === activeMara.userId && independent.token !== activeMara.token,
      "The second owner tab needs its own session for the same person");
    await status(otherMara, savedStatus, independent);
    const { createHash } = await import("node:crypto");
    const digest = identity => createHash("sha256").update("bim-native:session\0").update(identity.token).digest("hex");
    const sessionState = () => sql(cfg, `select json_build_object(
      'originalRevoked', original.revoked_at is not null,
      'originalLive', original.revoked_at is null and original.expires_at > clock_timestamp(),
      'independentLive', other.revoked_at is null and other.expires_at > clock_timestamp(),
      'samePerson', original.person_id = other.person_id, 'distinctSessions', original.session_id <> other.session_id)
      from bim.native_sessions original cross join bim.native_sessions other
      where original.token_digest = '${digest(activeMara)}' and other.token_digest = '${digest(independent)}';`);
    assert.deepEqual(sessionState(), { originalRevoked: false, originalLive: true, independentLive: true, samePerson: true, distinctSessions: true });

    const requests = [];
    let releaseAcknowledgement;
    const held = new Promise(resolve => { releaseAcknowledgement = resolve; });
    await mara.page.route(editor + "/auth/native/sign-out", async route => {
      const request = route.request(), index = requests.length;
      assert.ok(index < 2 && request.method() === "POST" && request.postData() === "{}" &&
        await request.headerValue("authorization") === "Bearer " + activeMara.token, "Sign-out did not use just the original credential");
      const reply = await route.fetch({ maxRedirects: 0 });
      assert.equal(reply.status(), 204);
      requests.push(reply.status());
      if (index === 0) await route.abort("failed");
      else {
        await held;
        await route.fulfill({ response: reply });
      }
    });
    const originalSocket = mara.sockets.at(-1), originalConnections = mara.sockets.length;
    const independentSocket = otherMara.sockets.at(-1);
    try {
      await mara.page.getByTestId("ribbon-tab-manage").click();
      await mara.page.getByRole("button", { name: "Sign out", exact: true }).click();
      await waitFor(() => requests.length === 2 && originalSocket.isClosed(), "The original tab did not stop and automatically retry sign-out");
      await mara.page.getByRole("heading", { name: "Sign-out pending", exact: true }).waitFor();
      assert.equal(await mara.page.getByTestId("building-model-save-state").count(), 0);
      assert.deepEqual(sessionState(), { originalRevoked: true, originalLive: false, independentLive: true, samePerson: true, distinctSessions: true });
      await capture(mara, "mara-signout-pending");
    } finally {
      releaseAcknowledgement();
    }
    await mara.page.getByRole("heading", { name: "Signed out", exact: true }).waitFor();
    await capture(mara, "mara-signout-confirmed");
    const independentSave = await addLevel(cfg, otherMara, "East plant independent session marker", 42);
    await status(otherMara, savedStatus, independent);
    assert.ok(otherMara.sockets.at(-1) === independentSocket && !independentSocket.isClosed());
    assert.equal(mara.sockets.length, originalConnections);
    assert.deepEqual(requests, [204, 204]);
    const afterSignOut = sessionState();
    assert.deepEqual(afterSignOut, { originalRevoked: true, originalLive: false, independentLive: true, samePerson: true, distinctSessions: true });
    const afterIndependentSave = roles(cfg, owner.id, coworker.id);
    assert.deepEqual(afterIndependentSave, { ...final, mainRevision: 4 });
    await record("signOut", { ...afterSignOut, serverStatuses: requests, initialReplyDropped: true, automaticSameSessionRetry: true,
      originalSocketClosed: true, originalTabDidNotReconnect: true, confirmed: true, otherSessionSavedOnOriginalSocket: true,
      independentSave, final: afterIndependentSave });
  } finally {
    for (const context of contexts.reverse()) await context.close();
    await rm(profiles, { recursive: true, force: true });
  }
}

await run();
