/**
 * Schedules under load (SCHEDULES-PLAN Stream G): 25 people on one 250k
 * building, each with three whole-building schedules open (air terminals
 * ~31,750 rows, mechanical equipment, sheet list), each editing terminals in
 * their own zone at 2 edits/s. Run twice against the same throwaway Postgres:
 * once with schedules off (baseline), once on. Commit p50/p95 must stay inside
 * `stress.commit.25` (80 / 250 ms), and each author's own schedule must show
 * their edit.
 *
 * The authority side is drills/schedules-server.ts (real Postgres store,
 * lease, group commit, SyncHub, kernel schedule evaluator, ws), started here
 * as a child process. Throwaway database on this machine only:
 *
 *   BIM_SCHEDULES_DRILL_DB_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
 *   node --import tsx services/bim-authority/drills/schedules-load.ts [--people=25] [--seconds=20] [--rate=2] [--port=8191]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { evaluateSchedule, executeCommand, type Actor, type Command, type ModelState, type ScheduleDefinition } from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { SyncClient, SyncScheduleConnection, actorColor, percentiles, type ScheduleEvent } from "@permitzip/bim-sync";
import { connect } from "../src/pg-store";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const url = process.env.BIM_SCHEDULES_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_SCHEDULES_DRILL_DB_URL to a throwaway database on this machine");
const host = new URL(url).hostname;
if (host !== "127.0.0.1" && host !== "localhost") throw new Error("This drill writes; it refuses any database that is not on this machine");

const PEOPLE = Number(arg("people", "25"));
const SECONDS = Number(arg("seconds", "20"));
const RATE = Number(arg("rate", "2"));
const PORT = Number(arg("port", "8191"));
const TIER = arg("tier", "250k") as keyof typeof FULL_BIM_TIERS;
const WINDOW = 200;
const INFLIGHT = 4;
const MODEL_ID = `schedules-drill-${TIER}`;
const BUDGET = { p50: 80, p95: 250 };
const here = dirname(fileURLToPath(import.meta.url));

const SCHEDULES: readonly { readonly viewId: string; readonly name: string; readonly def: ScheduleDefinition }[] = [
  { viewId: "drill-sched-terminals", name: "Drill air terminal schedule", def: { category: "air_terminal", columns: [{ field: "mark" }, { field: "type" }, { field: "level" }, { field: "cfm" }] } },
  { viewId: "drill-sched-equipment", name: "Drill mechanical equipment schedule", def: { category: "mechanical_equipment", columns: [{ field: "mark" }, { field: "type" }, { field: "level" }, { field: "cfm" }] } },
  { viewId: "drill-sched-sheets", name: "Drill sheet list", def: { category: "sheet_list", columns: [{ field: "number" }, { field: "name" }] } },
];

// ------------------------------------------------------------------ model + seed

function buildModel(): ModelState {
  let model = createFullBimModel({ ...FULL_BIM_TIERS[TIER], modelId: MODEL_ID });
  for (const s of SCHEDULES) {
    const command: Command = { type: "create_view", viewId: s.viewId, name: s.name, viewType: "schedule", props: { schedule: s.def } };
    const res = executeCommand(model, command);
    if (!res.ok) throw new Error(`could not add ${s.viewId}: ${res.error.message}`);
    model = { ...res.model, revision: model.revision };
  }
  return model;
}

type Sql = ReturnType<typeof connect>;

async function seed(sql: Sql, model: ModelState): Promise<void> {
  await sql`delete from bim.models where id = ${MODEL_ID}`;
  const project = randomUUID();
  await sql`insert into public.projects (id, project_number, name) values (${project}, ${MODEL_ID}, ${"Schedules load drill"})`;
  await sql`insert into bim.models (id, project_id, revision, lease_generation, settings)
            values (${MODEL_ID}, ${project}, ${model.revision}, 0, ${sql.json(JSON.parse(JSON.stringify(model.settings)))})`;
  const elements = Object.values(model.elements);
  for (let i = 0; i < elements.length; i += 2000) {
    const rows = elements.slice(i, i + 2000).map((el) => ({ model_id: MODEL_ID, element_id: el.id, kind: el.kind, version: el.version, body: JSON.stringify(el) }));
    await sql`insert into bim.elements (model_id, element_id, kind, version, body)
              select model_id, element_id, kind, version, body::jsonb from json_populate_recordset(null::record, ${JSON.stringify(rows)}::json)
              as t(model_id text, element_id text, kind text, version bigint, body text)`;
  }
  for (let i = 0; i < model.connections.length; i += 5000) {
    const rows = model.connections.slice(i, i + 5000).map((c, k) => ({ model_id: MODEL_ID, connection_id: c.id, ordinal: i + k, a_element: c.a.elementId, a_end: c.a.end, b_element: c.b.elementId, b_end: c.b.end }));
    await sql`insert into bim.connections (model_id, connection_id, ordinal, a_element, a_end, b_element, b_end)
              select * from json_populate_recordset(null::record, ${JSON.stringify(rows)}::json)
              as t(model_id text, connection_id text, ordinal integer, a_element text, a_end text, b_element text, b_end text)`;
  }
}

// ------------------------------------------------------------------ authority child

function startServer(schedules: boolean): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--max-old-space-size=3072", "--import", "tsx", join(here, "schedules-server.ts"), `--model=${MODEL_ID}`, `--port=${PORT}`, `--schedules=${schedules ? "on" : "off"}`], {
    cwd: join(here, ".."),
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("authority did not become ready in 180 s")), 180_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[authority] ${text}`);
      if (text.includes("@@ready")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => reject(new Error(`authority exited early (${code})`)));
  });
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.removeAllListeners("exit");
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
  });
}

async function stats(): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${PORT}/stats`);
  const body: unknown = await res.json();
  return typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};
}

// ------------------------------------------------------------------ people

interface Person {
  readonly client: SyncClient;
  readonly socket: WebSocket;
  readonly schedules: SyncScheduleConnection;
  readonly targets: readonly string[];
  /** Edits sent and when (ms, monotonic), to time commit and own-schedule visibility. */
  readonly sent: Map<string, number>;
  readonly elementOfKey: Map<string, string>;
  rowsReady: number;
}

const commitMs: number[] = [];
const visibleMs: number[] = [];
let refused = 0;
let closedSchedules = 0;

function join_(index: number, model: ModelState, order: readonly string[], withSchedules: boolean): Promise<Person> {
  const zones = FULL_BIM_TIERS[TIER];
  const floors = "floors" in zones ? zones.floors : 1;
  const zonesPerFloor = "zonesPerFloor" in zones ? zones.zonesPerFloor : 1;
  const level = `L${String((index % floors) + 1).padStart(2, "0")}`;
  const zone = `Z${(Math.floor(index / floors) % zonesPerFloor) + 1}`;
  const mine = order.filter((id) => {
    const el = model.elements[id];
    return el?.partition?.level === level && el.partition.zone === zone;
  });
  const firstIndex = order.indexOf(mine[0] ?? "");
  const offset = Math.max(0, firstIndex);
  const inWindow = new Set(order.slice(offset, offset + WINDOW));
  const targets = mine.filter((id) => inWindow.has(id));
  const actor: Actor = { id: `drill-person-${index}`, name: `Person ${index}`, kind: "human" };
  const sent = new Map<string, number>();
  const elementOfKey = new Map<string, string>();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/sync`, { perMessageDeflate: true });
  const client: SyncClient = new SyncClient(
    { send: (data) => socket.send(data), close: () => socket.close() },
    actor,
    {
      onOutcome: (request, outcome) => {
        const at = sent.get(request.idempotencyKey);
        if (at === undefined) return;
        if (outcome.status === "committed") commitMs.push(performance.now() - at);
        else refused += 1;
        if (!withSchedules) sent.delete(request.idempotencyKey);
      },
    },
    60_000,
    { interest: { areas: [{ level, zone }] }, modelId: MODEL_ID },
  );
  const schedules = new SyncScheduleConnection(client, { id: actor.id, name: actor.name, color: actorColor(actor.id) });
  const person: Person = { client, socket, schedules, targets, sent, elementOfKey, rowsReady: 0 };
  socket.on("message", (data) => client.receive(data.toString()));
  return new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("open", () => {
      client.opened();
      if (!withSchedules) {
        const wait = setInterval(() => {
          if (client.confirmedModel()) {
            clearInterval(wait);
            resolve(person);
          }
        }, 20);
        return;
      }
      for (const s of SCHEDULES) {
        const terminals = s.viewId === "drill-sched-terminals";
        const listener = (e: ScheduleEvent) => {
          if (e.type === "rows") {
            person.rowsReady += 1;
            if (person.rowsReady === SCHEDULES.length) resolve(person);
          } else if (e.type === "closed") {
            closedSchedules += 1;
            console.error(`[drill] ${actor.name}'s ${s.viewId} closed: ${e.message}`);
          } else if (e.type === "patch" && terminals) {
            const now = performance.now();
            for (const u of e.patch.upserts) {
              for (const [key, el] of elementOfKey) {
                if (el !== u.elementId) continue;
                const at = sent.get(key);
                if (at !== undefined) visibleMs.push(now - at);
                sent.delete(key);
                elementOfKey.delete(key);
              }
            }
          }
        };
        const sub = schedules.open({ viewId: s.viewId }, listener);
        sub.requestWindow({ offset: terminals ? offset : 0, limit: WINDOW });
      }
    });
  });
}

async function runPhase(withSchedules: boolean, model: ModelState, order: readonly string[]): Promise<Record<string, unknown>> {
  commitMs.length = 0;
  visibleMs.length = 0;
  refused = 0;
  closedSchedules = 0;
  const child = await startServer(withSchedules);
  const people: Person[] = [];
  const joinStarted = performance.now();
  try {
    for (let i = 0; i < PEOPLE; i++) people.push(await join_(i, model, order, withSchedules));
    const joinedMs = performance.now() - joinStarted;
    console.log(`[drill] ${PEOPLE} people joined${withSchedules ? ` with ${SCHEDULES.length} schedules each` : ""} in ${Math.round(joinedMs)} ms`);
    await fetch(`http://127.0.0.1:${PORT}/reset`, { method: "POST" });
    const until = performance.now() + SECONDS * 1000;
    let sentEdits = 0;
    const timers = people.map((p, i) => {
      let n = 0;
      const tick = () => {
        if (performance.now() > until) return;
        if (p.client.pendingCount() < INFLIGHT && p.targets.length > 0) {
          const id = p.targets[n % p.targets.length] ?? "";
          n += 1;
          const started = performance.now();
          const res = p.client.submit({ type: "set_terminal_cfm", terminalId: id, cfm: 200 + ((n * 7 + i) % 300) });
          if (res.ok) {
            sentEdits += 1;
            p.sent.set(res.request.idempotencyKey, started);
            p.elementOfKey.set(res.request.idempotencyKey, id);
          } else refused += 1;
        }
      };
      const start = setTimeout(() => {
        tick();
        timers2.push(setInterval(tick, 1000 / RATE));
      }, Math.random() * (1000 / RATE));
      return start;
    });
    const timers2: ReturnType<typeof setInterval>[] = [];
    await new Promise((r) => setTimeout(r, SECONDS * 1000 + 3000));
    timers.forEach(clearTimeout);
    timers2.forEach(clearInterval);
    const server = await stats();
    const commit = percentiles(commitMs);
    const visible = percentiles(visibleMs);
    return {
      schedules: withSchedules,
      people: PEOPLE,
      seconds: SECONDS,
      rate: RATE,
      joinAllMs: Math.round(joinedMs),
      sent: sentEdits,
      committed: commitMs.length,
      refused,
      closedSchedules,
      commitMs: commit,
      ownScheduleVisibleMs: withSchedules ? visible : null,
      server,
    };
  } finally {
    for (const p of people) {
      p.schedules.dispose();
      p.client.closed();
      p.socket.close();
    }
    await stopServer(child);
  }
}

// ------------------------------------------------------------------ main

const model = buildModel();
const order = evaluateSchedule(model, SCHEDULES[0]?.def ?? { category: "air_terminal", columns: [] }).elementIds.map((ids) => ids[0] ?? "");
console.log(`[drill] ${TIER}: ${Object.keys(model.elements).length} elements, ${order.length} air terminals in the schedule`);
const sql = connect(url, 4);
if (!args.includes("--no-seed")) {
  const t0 = performance.now();
  await seed(sql, model);
  console.log(`[drill] seeded ${MODEL_ID} in ${Math.round(performance.now() - t0)} ms`);
}
await sql.end();

const baseline = await runPhase(false, model, order);
console.log(JSON.stringify(baseline));
const loaded = await runPhase(true, model, order);
console.log(JSON.stringify(loaded));

const ok = (r: Record<string, unknown>): boolean => {
  const c = r.commitMs;
  if (typeof c !== "object" || c === null) return false;
  const p50 = "p50" in c && typeof c.p50 === "number" ? c.p50 : Infinity;
  const p95 = "p95" in c && typeof c.p95 === "number" ? c.p95 : Infinity;
  return p50 <= BUDGET.p50 && p95 <= BUDGET.p95;
};
const pass = ok(baseline) && ok(loaded) && loaded.closedSchedules === 0 && loaded.refused === 0;
console.log(`${pass ? "PASS" : "FAIL"}  25 people x 3 schedules: commit within stress.commit.25 (p50 <= ${BUDGET.p50} ms, p95 <= ${BUDGET.p95} ms)`);
const out = join(here, "results", `schedules-load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ tier: TIER, budget: BUDGET, baseline, loaded, pass }, null, 2));
console.log(`[drill] results: ${out}`);
process.exit(pass ? 0 : 1);
