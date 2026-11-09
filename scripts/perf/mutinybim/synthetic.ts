/**
 * One run of the synthetic full-BIM workload, in one process: the authority
 * (in-memory commit store + sequencer + SyncHub) and every participant's
 * SyncClient, wired by a loopback string transport, so serialization, slicing
 * and client apply are real and only the network and Postgres are absent.
 *
 * Cold figures are the first join / first commit on a freshly loaded,
 * unwarmed head in this process. Warm figures follow warmModel() and a
 * priming join, which is what the authority does at startup.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/synthetic.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts, one tier per process.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BUILTIN_PART_TYPES,
  GLOBAL_LEVEL,
  asElementId,
  computeSelectionScopes,
  displayResolver,
  elementValues,
  dragLimit,
  executeCommand,
  isOrganized,
  scopeSummary,
  warmModel,
  type Actor,
  type Command,
  type Interest,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  PressureEngine,
} from "@permitzip/bim-pack-mechanical";
import { FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import {
  PipeHydraulicsEngine,
} from "@permitzip/bim-pack-plumbing";
import { networkOf } from "../../../packages/bim-kernel/src/network";
import { sampleMarketGasCommands } from "../../../packages/bim-kernel/__tests__/fixtures/sample-market-gas";
import { ifgcEdition } from "@permitzip/bim-calc";
import { sizeGasSystem } from "@permitzip/bim-pack-plumbing";
import { InMemoryCommitStore, Sequencer, SyncClient, SyncHub, type HubConnection } from "@permitzip/bim-sync";
import { modelSolids, changedElements, partSolids } from "../../../packages/bim-viewer-3d/src/native-geometry";
import { boxModeOf, boxSelect, dragRect, screenBoxes } from "../../../packages/bim-viewer-3d/src/box-select";
import { snapPoint, snapTargets } from "@permitzip/bim-editor/editor/placement";
import { emit, gc, memoryMB, round, timeSync, type Counts, type Sample } from "./lib";
import { loadModelLikeServer } from "./server-load";

const FT = 304.8;
const IN = 25.4;
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
/** Where to write the author's zone slice (the browser suite draws it). */
const writeSlice = arg("write-slice", "");
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
if (!(Number.isInteger(samplesPerRun) && samplesPerRun >= 3)) throw new Error("--samples must be an integer >= 3");
if (opts.floors < 2 || opts.zonesPerFloor < 2) throw new Error("tier needs at least 2 floors and 2 zones per floor");

const WAIT_MS = 120_000;

// ------------------------------------------------------------------ loopback participants

interface Waiter {
  readonly match: (data: string) => boolean;
  readonly resolve: (at: number) => void;
}

interface Participant {
  readonly name: string;
  readonly client: SyncClient;
  readonly conn: HubConnection;
  bytesIn: number;
  readonly waiters: Waiter[];
  /** Raw messages kept only while a caller asked for them (to count changeset elements outside timing). */
  capture: string[] | null;
}

function startsWithType(data: string, type: string): boolean {
  return data.startsWith(`{"type":"${type}"`);
}

/** Resolves with performance.now() right after the client applied the first matching message. */
function waitFor(p: Participant, match: (data: string) => boolean, what: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[perf] ${p.name} never received ${what} within ${WAIT_MS} ms`)), WAIT_MS);
    p.waiters.push({
      match,
      resolve: (at) => {
        clearTimeout(timer);
        resolve(at);
      },
    });
  });
}

let connSeq = 0;
function participant(hub: SyncHub, name: string, interest: Interest): Participant {
  connSeq += 1;
  const actor: Actor = { id: name.toLowerCase().replace(/\s+/g, "-"), name, kind: "human" };
  const self: Participant = {
    name,
    bytesIn: 0,
    waiters: [],
    capture: null,
    conn: {
      id: `perf-${connSeq}`,
      send: (data: string) => {
        self.bytesIn += data.length;
        self.client.receive(data);
        const at = performance.now();
        if (self.capture) self.capture.push(data);
        for (let i = self.waiters.length - 1; i >= 0; i--) {
          const w = self.waiters[i];
          if (w && w.match(data)) {
            self.waiters.splice(i, 1);
            w.resolve(at);
          }
        }
      },
    },
    client: new SyncClient(
      {
        send: (data) => {
          hub.handle(self.conn, data).catch((err) => console.error("[perf] hub.handle failed", { name, err }));
        },
        close: () => hub.leave(self.conn),
      },
      actor,
      {},
      600_000,
      { interest },
    ),
  };
  return self;
}

/** Join and wait for the welcome. Returns hello -> welcome-applied milliseconds. */
async function join(hub: SyncHub, p: Participant): Promise<number> {
  hub.join(p.conn);
  const welcomed = waitFor(p, (d) => startsWithType(d, "welcome"), "welcome");
  const t0 = performance.now();
  p.client.opened();
  return (await welcomed) - t0;
}

function leave(p: Participant): void {
  p.client.dispose();
}

function viewOf(p: Participant): ModelState {
  const v = p.client.view();
  if (!v) throw new Error(`[perf] ${p.name} has no view`);
  return v;
}

function zone(level: number, z: number): Interest {
  return { areas: [{ level: `L${String(level).padStart(2, "0")}`, zone: `Z${z}` }] };
}

/** True for a changeset that carries only model-wide definitions (levels, part types), which every area needs. */
function onlyDefinitions(raw: string): boolean {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("changeset" in parsed)) return false;
  const cs: unknown = parsed.changeset;
  if (typeof cs !== "object" || cs === null || !("elements" in cs) || !Array.isArray(cs.elements) || cs.elements.length === 0) return false;
  return cs.elements.every((el: unknown) => typeof el === "object" && el !== null && "partition" in el && typeof el.partition === "object" && el.partition !== null && "level" in el.partition && el.partition.level === GLOBAL_LEVEL);
}

function changesetElementCount(raw: string): number {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("changeset" in parsed)) return 0;
  const cs: unknown = parsed.changeset;
  if (typeof cs !== "object" || cs === null || !("elements" in cs) || !Array.isArray(cs.elements)) return 0;
  return cs.elements.length;
}

/** Elements in the connected system an edit lives in (the trunk tree under one source). */
function networkSize(model: ModelState, sourceId: string): number {
  const net = networkOf(model);
  const seen = new Set<string>([sourceId]);
  const stack = [sourceId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    for (const child of net.children(id)) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
    for (const dep of net.dependents(id)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return seen.size;
}

// ------------------------------------------------------------------ run

async function main(): Promise<void> {
  const samples: Sample[] = [];
  const add = (metric: string, values: number[], counts?: Counts, note?: string): void => {
    samples.push({ metric, values: values.map((v) => round(v, 3)), ...(counts ? { counts } : {}), ...(note ? { note } : {}) });
  };

  // A child process generates the model and streams it as rows; this process only ever holds the
  // loaded copy (plain records), as the server has after reading storage. memory.server.* then
  // measure the model server, not the generator's copy (round 8, product decision 8).
  const loaded = await loadModelLikeServer(tier as keyof typeof FULL_BIM_TIERS);
  const totalElements = Object.keys(loaded.model.elements).length;
  let head: ModelState | null = loaded.model;
  const generateMs = loaded.generateMs;
  const loadMs = loaded.loadMs;
  const memAfterLoad = memoryMB();

  const store = new InMemoryCommitStore(head);
  head = null;
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer);

  const topLevel = opts.floors;
  const lastZone = opts.zonesPerFloor;
  const authorZone = zone(topLevel, lastZone);
  const p = `L${String(topLevel).padStart(2, "0")}-Z${lastZone}`;
  const tapId = `${p}-air-t1-s2-b1-tap`;
  const trunkId = `${p}-air-t2-s2`;
  const levelName = `L${String(topLevel).padStart(2, "0")}`;
  const diffuser = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
  if (!diffuser) throw new Error("starter library has no air terminal");
  const PERF_LEVEL = "perf-level";
  const ROUTE_ELEVATION = 11 * FT;
  /** A route from a placed diffuser: read where the part is now (earlier edits move perf-part-0). */
  const routeFrom = (partId: string, idPrefix: string): Command => {
    const part = viewOf(author).elements[partId];
    if (part?.kind !== "part") throw new Error(`[perf] ${partId} missing from the author's view`);
    const { x, y } = part.position;
    return {
      type: "route_run",
      idPrefix,
      levelId: PERF_LEVEL,
      zone: `Z${lastZone}`,
      domain: "duct",
      size: { shape: "round", diameter: 10 * IN },
      elevationMm: ROUTE_ELEVATION,
      system: { id: "perf-sys", kind: "supply_air", name: "Perf supply" },
      points: [{ x, y: y + 6 * FT }, { x: x + 4 * FT, y: y + 6 * FT }],
      from: { kind: "part", partId, connectorId: "neck" },
    };
  };
  /** A free 2" sanitary drain in the author's zone, sloped by the system's rule as routed. */
  const drainFrom = (i: number): Command => ({
    type: "route_run",
    idPrefix: `perf-drain-${i}`,
    levelId: PERF_LEVEL,
    zone: `Z${lastZone}`,
    domain: "pipe",
    size: { shape: "pipe", nominalMm: 2 * IN, material: "pvc" },
    elevationMm: 8 * FT,
    system: { id: "perf-san", kind: "sanitary", name: "Perf sanitary" },
    points: [{ x: (40 + i * 3) * FT, y: 30 * FT }, { x: (40 + i * 3) * FT, y: 40 * FT }, { x: (42 + i * 3) * FT, y: 40 * FT }],
  });
  const commands: Array<[string, (i: number) => Command, string | null]> = [
    ["slide_branch", (i) => ({ type: "slide_branch", tapId, s: (i % 2 === 0 ? 3.5 : 3.25) * FT }), `${p}-air-t1-src`],
    ["resize_run", (i) => ({ type: "resize_run", segmentId: trunkId, profile: { shape: "rect", width: (i % 2 === 0 ? 26 : 24) * IN, height: 12 * IN } }), `${p}-air-t2-src`],
    // Any part, in the author's zone; the first placement also pins its type into the model.
    [
      "place_part",
      (i) => ({
        type: "place_part",
        partId: `perf-part-${i}`,
        typeId: diffuser.id,
        ...(i === 0 ? { partType: diffuser.definition } : {}),
        levelId: PERF_LEVEL,
        zone: `Z${lastZone}`,
        position: { x: (10 + i * 2) * FT, y: 10 * FT },
        offsetMm: 9 * FT,
      }),
      null,
    ],
    ["move_elements", (i) => ({ type: "move_elements", ids: ["perf-part-0"], delta: { x: (i % 2 === 0 ? 1 : -1) * FT, y: 0 } }), null],
    // Routing: up out of each diffuser's neck, north, then east; 10" round onto the 8" neck, so a transition too.
    ["route_run", (i) => routeFrom(`perf-part-${i}`, `perf-run-${i}`), null],
    ["resize_routed", (i) => ({ type: "resize_run", segmentId: "perf-run-0-s2", profile: { shape: "round", diameter: (i % 2 === 0 ? 12 : 10) * IN } }), null],
    ["move_connected", (i) => ({ type: "move_elements", ids: ["perf-part-0"], delta: { x: (i % 2 === 0 ? -1 : 1) * FT, y: 0 } }), null],
    // Fittings: each run's second elbow (north to east) becomes a smooth round elbow; each run's east leg rises 6" with two 45° elbows.
    ["swap_fitting", (i) => ({ type: "swap_fitting", fittingId: `perf-run-${i}-f2`, family: "duct.elbow.round_smooth" }), null],
    ["offset_run", (i) => ({ type: "offset_run", idPrefix: `perf-jog-${i}`, segmentId: `perf-run-${i}-s3`, atMm: 2.5 * FT, offset: { x: 0, y: 0, z: 6 * IN }, style: "45" }), null],
    // The run's open end leg, which offset_run left as perf-jog-<i>-s1: one elbow left behind, capped.
    ["delete_connected", (i) => ({ type: "delete_elements", ids: [`perf-jog-${i}-s1`], policy: "cascade" }), null],
    // Split each run's north leg, reshape the far piece to 16" round (a transition where it meets the rest), then drag and move it north.
    ["split_run", (i) => ({ type: "split_run", idPrefix: `perf-split-${i}`, segmentId: `perf-run-${i}-s2`, atMm: 3 * FT }), null],
    ["resize_stretch", (i) => ({ type: "resize_stretch", idPrefix: `perf-rs-${i}`, segmentIds: [`perf-split-${i}-s1`], size: { shape: "round", diameter: 16 * IN } }), null],
    ["drag_run", (i) => ({ type: "drag_run", elementId: `perf-split-${i}-s1`, delta: { x: 0, y: 3 * IN, z: 0 } }), null],
    ["move_group", (i) => ({ type: "move_elements", ids: [`perf-split-${i}-s1`], delta: { x: 0, y: 3 * IN } }), null],
    // One atomic resize of every routed leg a box over the perf runs would pick.
    [
      "resize_batch",
      (i) => ({
        type: "resize_stretch",
        idPrefix: `perf-batch-${i}`,
        segmentIds: Object.keys(viewOf(author).elements).filter((id) => /^perf-(run-\d+-s2|split-\d+-s1)$/.test(id)),
        size: { shape: "round", diameter: (i % 2 === 0 ? 14 : 18) * IN },
      }),
      null,
    ],
    // Pipe: a 2" sanitary drain routed sloped (north 10 ft, east 2 ft, one long sweep), then that turn swapped to a 1/4 bend.
    ["route_pipe", (i) => drainFrom(i), null],
    ["swap_pipe_fitting", (i) => ({ type: "swap_fitting", fittingId: `perf-drain-${i}-f1`, family: "dwv.quarter_bend" }), null],
  ];

  // ---------------------------------------------------------------- cold: first join + first commit on an unwarmed head
  const author = participant(hub, "Author", authorZone);
  const coldJoin = await join(hub, author);
  const coldSolids = timeSync(() => modelSolids(viewOf(author)));
  const welcomeBytes = author.bytesIn;
  const subscribedElements = Object.keys(viewOf(author).elements).length;
  const sliceCounts: Counts = { totalElements, subscribedElements, visibleSolids: coldSolids.value.length, bytes: welcomeBytes };
  add("join.cold", [coldJoin], sliceCounts);
  add("view.first.cold", [coldJoin + coldSolids.ms], sliceCounts);
  add("memory.client.zoneWire", [welcomeBytes / 1e6], sliceCounts);

  const firstCommand = commands[0]?.[1](1);
  if (!firstCommand) throw new Error("no commands");
  const firstOutcome = waitFor(author, (d) => startsWithType(d, "outcome"), "first outcome");
  const tFirst = performance.now();
  const firstSubmit = author.client.submit(firstCommand);
  if (!firstSubmit.ok) throw new Error(`[perf] first edit refused locally: ${firstSubmit.error.message}`);
  add("commit.cold", [(await firstOutcome) - tFirst], { totalElements, subscribedElements });

  // ---------------------------------------------------------------- warm the authority the way it does at startup
  const warm = warmModel(await store.head());
  const memWarm = memoryMB();
  add("memory.server.heap", [memWarm.heap], { totalElements }, "Whole head loaded + warm, one participant connected.");
  add("memory.server.rss", [memWarm.rss], { totalElements });

  // ---------------------------------------------------------------- participants
  const sameZone = participant(hub, "Same zone", authorZone);
  const otherZone = participant(hub, "Other zone", zone(topLevel, 1));
  const otherLevel = participant(hub, "Other level", zone(1, 1));
  const observers = [sameZone, otherZone, otherLevel];
  const warmJoins: number[] = [];
  const warmViews: number[] = [];
  // Client cost of one zone, measured on a warm server so the authority's one-time area index is not counted.
  const probe = participant(hub, "Heap probe", authorZone);
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  await join(hub, probe);
  modelSolids(viewOf(probe));
  gc();
  add("memory.client.zoneHeap", [(process.memoryUsage().heapUsed - heapBefore) / 1e6], sliceCounts, "Heap growth for one more participant's zone on a warm server (welcome parse + slice + view).");
  leave(probe);
  for (const o of observers) {
    const ms = await join(hub, o);
    warmJoins.push(ms);
    warmViews.push(ms + timeSync(() => modelSolids(viewOf(o))).ms);
  }
  // Extra warm joins on fresh connections across the building, each left again.
  for (let i = 0; warmJoins.length < samplesPerRun; i++) {
    const level = (i % opts.floors) + 1;
    const z = (Math.floor(i / opts.floors) % opts.zonesPerFloor) + 1;
    const visitor = participant(hub, `Visitor ${i}`, zone(level, z));
    const ms = await join(hub, visitor);
    warmJoins.push(ms);
    warmViews.push(ms + timeSync(() => modelSolids(viewOf(visitor))).ms);
    leave(visitor);
  }
  add("join.warm", warmJoins, sliceCounts);
  add("view.first.warm", warmViews, sliceCounts);

  // ---------------------------------------------------------------- area switch on an open connection
  const roamer = participant(hub, "Roamer", zone(1, 2));
  await join(hub, roamer);
  const switches: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const level = (i % opts.floors) + 1;
    const z = ((i + 2) % opts.zonesPerFloor) + 1;
    const target = zone(level, z);
    const arrived = waitFor(roamer, (d) => startsWithType(d, "area"), "area");
    const t0 = performance.now();
    roamer.client.setInterest(target);
    switches.push((await arrived) - t0);
  }
  leave(roamer);
  add("area.switch", switches, { totalElements, subscribedElements });

  // ---------------------------------------------------------------- a level for the part edits (setup, not measured)
  const levelOutcome = waitFor(author, (d) => startsWithType(d, "outcome"), "create_level outcome");
  const levelSent = author.client.submit({ type: "create_level", levelId: PERF_LEVEL, name: levelName, elevationMm: (topLevel - 1) * 4200 });
  if (!levelSent.ok) throw new Error(`[perf] create_level refused locally: ${levelSent.error.message}`);
  await levelOutcome;
  const levelRevision = (await store.head()).revision;
  for (let spins = 0; [author, ...observers].some((o) => o.client.confirmedRevision() < levelRevision); spins++) {
    if (spins > 10_000) throw new Error("[perf] participants never received the level");
    await new Promise((r) => setImmediate(r));
  }

  // ---------------------------------------------------------------- edits: preview, durable commit, remote visibility
  const participants = 1 + observers.length;
  const invariants: Record<string, number> = { subscribedFraction: subscribedElements / totalElements };
  for (const [name, make, sourceId] of commands) {
    const preview: number[] = [];
    const kernelOnly: number[] = [];
    const commit: number[] = [];
    const visible: number[] = [];
    let affected = 0;
    let rebuilt = 0;
    let outsideBytes = 0;
    let outsideChangesets = 0;
    let definitionChangesets = 0;
    const network = sourceId ? networkSize(await store.head(), sourceId) : 0;
    for (let i = 0; i < samplesPerRun; i++) {
      const command = make(i);
      const before = viewOf(author);
      const authorSeen: string[] = [];
      const outsideSeen: string[] = [];
      author.capture = authorSeen;
      for (const o of [otherZone, otherLevel]) o.capture = outsideSeen;
      const outsideBytesBefore = otherZone.bytesIn + otherLevel.bytesIn;

      const t0 = performance.now();
      // The key is known only after submit; match the next outcome / changeset (edits are sequential here).
      const outcome = waitFor(author, (d) => startsWithType(d, "outcome"), `${name} outcome`);
      const seen = waitFor(sameZone, (d) => startsWithType(d, "changeset"), `${name} changeset`);
      const advancedZone = waitFor(otherZone, (d) => startsWithType(d, "advance") || startsWithType(d, "changeset"), `${name} advance (other zone)`);
      const advancedLevel = waitFor(otherLevel, (d) => startsWithType(d, "advance") || startsWithType(d, "changeset"), `${name} advance (other level)`);
      const submitted = timeSync(() => author.client.submit(command));
      if (!submitted.value.ok) throw new Error(`[perf] ${name} refused locally: ${submitted.value.error.message}`);
      const after = viewOf(author);
      modelSolids(after);
      const tPreview = performance.now();
      kernelOnly.push(submitted.ms);
      preview.push(tPreview - t0);

      commit.push((await outcome) - t0);
      visible.push((await seen) - t0);
      await Promise.all([advancedZone, advancedLevel]);

      rebuilt = changedElements(before, after).changed.length;
      const cs = authorSeen.find((d) => startsWithType(d, "changeset"));
      if (cs) affected = changesetElementCount(cs);
      // A new part type or level goes to everyone once (every area needs it to draw parts); that is not zone content.
      const definitions = outsideSeen.filter((d) => startsWithType(d, "changeset") && onlyDefinitions(d));
      const definitionBytes = definitions.reduce((n, d) => n + d.length, 0);
      outsideBytes = Math.max(outsideBytes, (otherZone.bytesIn + otherLevel.bytesIn - outsideBytesBefore - definitionBytes) / 2);
      outsideChangesets += outsideSeen.filter((d) => startsWithType(d, "changeset") && !onlyDefinitions(d)).length;
      definitionChangesets += definitions.length;
      author.capture = null;
      for (const o of [otherZone, otherLevel]) o.capture = null;
    }
    const counts: Counts = { totalElements, subscribedElements, networkElements: network, affectedElements: affected, solidsRebuilt: rebuilt };
    add(`edit.preview.${name}`, preview, counts, "submit (prediction) + rebuilding every solid in the slice, which is what the viewer's setAuthored does today.");
    add(`edit.kernel.${name}`, kernelOnly, counts, "Prediction only (client.submit), informational.");
    add(`commit.durable.${name}`, commit, counts);
    add(`remote.visible.${name}`, visible, counts);
    if (definitionChangesets > 0) add(`outside.definitions.${name}`, [definitionChangesets], undefined, "Changesets carrying only a new part type or level, sent once to every area (informational).");
    invariants[`editAffected.${name}`] = Math.max(invariants[`editAffected.${name}`] ?? 0, affected);
    invariants["outsideObserver.bytesPerEdit"] = Math.max(invariants["outsideObserver.bytesPerEdit"] ?? 0, outsideBytes);
    invariants["outsideObserver.changesets"] = (invariants["outsideObserver.changesets"] ?? 0) + outsideChangesets;
  }

  // ---------------------------------------------------------------- pointer-follow preview while placing / dragging (nothing sent)
  {
    const view = viewOf(author);
    const levelEl = view.elements[PERF_LEVEL];
    const typeEl = view.elements[diffuser.id];
    const part0 = view.elements["perf-part-0"];
    if (levelEl?.kind !== "level" || typeEl?.kind !== "part_type" || part0?.kind !== "part") throw new Error("[perf] part setup missing from the author's view");
    // The session caches these per view; built once here, timed as info.
    const targetsBuilt = timeSync(() => snapTargets(view, PERF_LEVEL));
    const targets = targetsBuilt.value;
    for (const [name, fixed] of [["place_part", false], ["move_elements", true]] as const) {
      const ghost: number[] = [];
      for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
        const raw = { x: (12 + (i % 17) * 0.37) * FT, y: (11 + (i % 7) * 0.53) * FT };
        ghost.push(
          timeSync(() => {
            const snapped = snapPoint(raw, fixed ? targets.filter((t) => t.id !== part0.id) : targets);
            const moving = fixed ? { ...part0, position: snapped.point } : { ...part0, id: asElementId("ghost"), position: snapped.point };
            return partSolids(moving, typeEl, levelEl.elevationMm).length;
          }).ms,
        );
      }
      add(`edit.ghost.${name}`, ghost, { totalElements, subscribedElements }, `${targets.length} snap targets on the level, built once per view in ${round(targetsBuilt.ms, 2)} ms.`);
    }
  }

  // ---------------------------------------------------------------- pointer-follow route preview (the Route tool, nothing sent)
  {
    const view = viewOf(author);
    const ghost: number[] = [];
    for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
      const x = (14 + (i % 11) * 0.5) * FT;
      const y = (30 + (i % 5)) * FT;
      ghost.push(
        timeSync(() => {
          const r = executeCommand(view, {
            type: "route_run",
            idPrefix: "ghost",
            levelId: PERF_LEVEL,
            zone: `Z${lastZone}`,
            domain: "duct",
            size: { shape: "round", diameter: 10 * IN },
            elevationMm: ROUTE_ELEVATION,
            system: { id: "perf-sys", kind: "supply_air" },
            points: [{ x: 12 * FT, y: 28 * FT }, { x, y: 28 * FT }, { x, y }],
          });
          if (!r.ok) throw new Error(`[perf] route preview refused: ${r.error.message}`);
          return r.changedIds.length;
        }).ms,
      );
    }
    add("edit.ghost.route_run", ghost, { totalElements, subscribedElements }, "Two-leg route with one elbow predicted on the author's zone view per pointer move.");
  }

  // ---------------------------------------------------------------- duct pressure on the full head (authority side)
  {
    const cold: number[] = [];
    const recalc: number[] = [];
    let systemElements = 0;
    let firstHead = await store.head();
    for (let i = 0; i < 3; i++) {
      const fresh = new PressureEngine();
      cold.push(timeSync(() => fresh.report(firstHead, "perf-sys")).ms);
    }
    const engine = new PressureEngine();
    const primed = engine.report(firstHead, "perf-sys");
    if (!primed?.calculable) throw new Error(`[perf] perf-sys has no pressure report: ${primed?.reason ?? "missing"}`);
    for (let i = 0; i < samplesPerRun; i++) {
      const outcome = waitFor(author, (d) => startsWithType(d, "outcome"), "pressure swap outcome");
      const sent = author.client.submit({ type: "swap_fitting", fittingId: `perf-run-${i}-f1`, family: i % 2 === 0 ? "duct.elbow.round_smooth" : "duct.elbow.mitred" });
      if (!sent.ok) throw new Error(`[perf] pressure swap refused locally: ${sent.error.message}`);
      await outcome;
      firstHead = await store.head();
      const head = firstHead;
      const timed = timeSync(() => engine.report(head, "perf-sys", `perf-run-${i}-f1`));
      if (!timed.value?.calculable) throw new Error("[perf] pressure report lost after an edit");
      systemElements = timed.value.memberIds.length;
      recalc.push(timed.ms);
    }
    add("pressure.report.cold", cold, { totalElements, networkElements: systemElements }, "Fresh engine, no hint: one scan for every system's anchor, then the walk.");
    add("pressure.recalc.after_edit", recalc, { totalElements, networkElements: systemElements }, "Same engine after each committed swap in the system.");
  }

  // ---------------------------------------------------------------- pipe hydraulics on the full head (authority side)
  {
    const cold: number[] = [];
    const recalc: number[] = [];
    let systemElements = 0;
    let pipeHead = await store.head();
    for (let i = 0; i < 3; i++) {
      const fresh = new PipeHydraulicsEngine();
      cold.push(timeSync(() => fresh.report(pipeHead, "perf-san")).ms);
    }
    const engine = new PipeHydraulicsEngine();
    const primed = engine.report(pipeHead, "perf-san", "perf-drain-0-s1");
    if (!primed || primed.kind !== "drainage") throw new Error(`[perf] perf-san has no drainage report: ${primed?.kind === "not_calculated" ? primed.reason : "missing"}`);
    for (let i = 0; i < samplesPerRun; i++) {
      const outcome = waitFor(author, (d) => startsWithType(d, "outcome"), "pipe swap outcome");
      const sent = author.client.submit({ type: "swap_fitting", fittingId: `perf-drain-${i}-f1`, family: "dwv.quarter_bend_long_sweep" });
      if (!sent.ok) throw new Error(`[perf] pipe swap refused locally: ${sent.error.message}`);
      await outcome;
      pipeHead = await store.head();
      const head = pipeHead;
      const timed = timeSync(() => engine.report(head, "perf-san", `perf-drain-${i}-f1`));
      if (!timed.value || timed.value.kind !== "drainage") throw new Error("[perf] pipe report lost after an edit");
      systemElements = timed.value.memberIds.length;
      recalc.push(timed.ms);
    }
    add("pipe.report.cold", cold, { totalElements, networkElements: systemElements }, "Fresh engine, no hint: the system's entry run, else one scan, then the walk of that piece of the system.");
    add("pipe.report.after_edit", recalc, { totalElements, networkElements: systemElements }, "Same engine after each committed fitting swap in the drain: re-walks only that piece of the system.");
  }

  // ---------------------------------------------------------------- gas pressure zones on the full head
  {
    // The sample market's propane system (four zones, three regulators, six appliances) added to the tier's head.
    let gasHead = await store.head();
    const level = elementValues(gasHead.elements).find((e) => e.kind === "level");
    if (!level) throw new Error("[perf] the synthetic head has no level for the gas system");
    for (const c of sampleMarketGasCommands()) {
      if (c.type === "create_level") continue;
      const command = JSON.parse(JSON.stringify(c).replaceAll('"lvl-1"', JSON.stringify(level.id))) as Command;
      const r = executeCommand(gasHead, command);
      if (!r.ok) throw new Error(`[perf] gas system: ${command.type}: ${r.error.message}`);
      gasHead = { ...r.model, revision: (gasHead.revision + 1) as ModelState["revision"] };
    }
    const head = gasHead;
    const ifgc = ifgcEdition("2021", { code: "VFGC", libraryText: true });
    const report: number[] = [];
    const sizing: number[] = [];
    let zones = 0;
    for (let i = 0; i < samplesPerRun; i++) {
      const timed = timeSync(() => new PipeHydraulicsEngine().report(head, "sys-gas", "main-s3"));
      if (timed.value?.kind !== "gas" || !timed.value.zones) throw new Error("[perf] the gas report lost its zones");
      zones = timed.value.zones.length;
      report.push(timed.ms);
      const sized = timeSync(() => sizeGasSystem(head, "sys-gas", ifgc));
      if (!sized.value.ok) throw new Error(`[perf] gas sizing: ${sized.value.reason}`);
      sizing.push(sized.ms);
    }
    add("gas.zones.report", report, { totalElements, networkElements: zones }, "A fresh pipe engine's gas report with the zone walk (regulators reset pressure, each zone against its own drop), hinted at a cook line pipe.");
    add("gas.size.proposal", sizing, { totalElements, networkElements: zones }, "plumbing.gas_system's sizing: the zone walk plus each zone through Table 402.4(n) and the 402.4 equation, proposals and the gas equipment rows.");
  }

  // ---------------------------------------------------------------- pointer-follow offset preview (nothing sent)
  {
    const view = viewOf(author);
    const ghost: number[] = [];
    const target = Object.keys(view.elements).find((id) => /^perf-run-\d+-s2$/.test(id));
    if (!target) throw new Error("[perf] no routed run left to offset");
    for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
      ghost.push(
        timeSync(() => {
          const r = executeCommand(view, { type: "offset_run", idPrefix: "ghost-jog", segmentId: target, atMm: (2 + (i % 5) * 0.1) * FT, offset: { x: 0, y: 0, z: 6 * IN }, lengthMm: 1 * FT, style: "45" });
          return r.ok ? r.changedIds.length : 0;
        }).ms,
      );
    }
    add("edit.ghost.offset_run", ghost, { totalElements, subscribedElements }, `Offset with return on ${target} per pointer move (refusals count: they cost the same).`);
  }

  // ---------------------------------------------------------------- hover pre-highlight and Tab to select more (nothing sent)
  {
    const view = viewOf(author);
    const legacyBranch = networkOf(view).children(asElementId(tapId))[0];
    const hovered = [...Object.keys(view.elements).filter((id) => /^perf-(run-\d+-s\d|split-\d+-s1)$/.test(id)), ...(legacyBranch ? [legacyBranch] : []), trunkId];
    const tab: number[] = [];
    let widest = 0;
    for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
      const id = hovered[i % hovered.length];
      if (!id) throw new Error("[perf] nothing to hover");
      tab.push(
        timeSync(() => {
          const scopes = computeSelectionScopes(view, asElementId(id));
          const last = scopes[scopes.length - 1];
          if (last) widest = Math.max(widest, scopeSummary(view, last.ids).count);
          return scopes.length;
        }).ms,
      );
    }
    add("select.prehighlight.tab", tab, { totalElements, subscribedElements, networkElements: widest }, `Uncached scopes + totals for routed legs, a legacy branch and a trunk (${hovered.length} pieces), widest scope ${widest} elements.`);
  }

  // ---------------------------------------------------------------- window / crossing box select over the zone (nothing sent)
  {
    const view = viewOf(author);
    // The viewer keeps the zone's solids from its last redraw; built once here.
    const solids = modelSolids(view);
    const plan = (x: number, _y: number, z: number) => ({ x: x * 20, y: z * 20 });
    const all = screenBoxes(solids, plan);
    const accept = (id: string) => {
      const el = view.elements[id];
      return el?.kind === "run_segment" || el?.kind === "run_fitting" || el?.kind === "part" || el?.kind === "duct_segment" || el?.kind === "tap" || el?.kind === "elbow" || el?.kind === "terminal";
    };
    // Frame the box on the zone's duct, pipe and parts: centred on their median position, sized from their spread (they can sit in clusters).
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [id, b] of all) {
      if (!accept(id)) continue;
      xs.push((b.minX + b.maxX) / 2);
      ys.push((b.minY + b.maxY) / 2);
    }
    xs.sort((p, q) => p - q);
    ys.sort((p, q) => p - q);
    const at = (v: number[], q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? 0;
    const cx = at(xs, 0.5);
    const cy = at(ys, 0.5);
    const spreadX = Math.max(40, at(xs, 0.75) - at(xs, 0.25));
    const spreadY = Math.max(40, at(ys, 0.75) - at(ys, 0.25));
    const minX = cx - spreadX;
    const maxX = cx + spreadX;
    const minY = cy - spreadY;
    const maxY = cy + spreadY;
    const box: number[] = [];
    let mostPicked = 0;
    for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
      const f = 0.2 + (i % 5) * 0.1;
      const a = { x: minX + (maxX - minX) * (0.5 - f), y: minY + (maxY - minY) * (0.5 - f) };
      const b = { x: minX + (maxX - minX) * (0.5 + f), y: minY + (maxY - minY) * (0.5 + f) };
      const [start, end] = i % 2 === 0 ? [a, b] : [b, a];
      box.push(timeSync(() => (mostPicked = Math.max(mostPicked, boxSelect(screenBoxes(solids, plan), dragRect(start, end), boxModeOf(start, end), accept).length))).ms);
    }
    if (mostPicked === 0) {
      const kept = [...all.keys()].filter(accept).length;
      throw new Error(`[perf] box select never picked anything: ${all.size} boxes, ${kept} duct/pipe/parts, services span x ${round(minX, 1)}..${round(maxX, 1)}, y ${round(minY, 1)}..${round(maxY, 1)}`);
    }
    add("select.box", box, { totalElements, subscribedElements, visibleSolids: solids.length }, `Screen boxes for ${solids.length} solids, then window / crossing alternately around the centre of its services; up to ${mostPicked} duct, pipe and parts picked.`);
  }

  // ---------------------------------------------------------------- group and phase display over the whole model
  {
    let model = await store.head();
    const base = model;
    const organized = Object.keys(base.elements).filter((id) => {
      const el = base.elements[id];
      return el !== undefined && isOrganized(el);
    });
    const step = Math.max(1, Math.floor(organized.length / 2000));
    const picked = organized.filter((_, i) => i % step === 0).slice(0, 2000);
    const setup: Command[] = [
      { type: "assign_elements_to_group", ids: picked.slice(0, 1000), groupId: "grp-coordination" },
      { type: "set_element_phases", ids: picked.slice(1000), phaseCreated: "phase-existing", phaseDemolished: "phase-new" },
    ];
    for (const command of setup) {
      const r = executeCommand(model, command);
      if (!r.ok) throw new Error(`[perf] ${command.type} refused: ${r.error.message}`);
      model = r.model;
    }
    const ctx = { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { "grp-coordination": "hide" as const } };
    const all = elementValues(model.elements);
    const resolve: number[] = [];
    let hidden = 0;
    let dashed = 0;
    for (let i = 0; i < Math.max(samplesPerRun, 21); i++) {
      resolve.push(
        timeSync(() => {
          const show = displayResolver(model, ctx);
          let h = 0;
          let d = 0;
          for (const el of all) {
            const r = show(el);
            if (!r.visible) h++;
            else if (r.dashed) d++;
          }
          hidden = h;
          dashed = d;
        }).ms,
      );
    }
    if (hidden === 0 || dashed === 0) throw new Error(`[perf] visibility resolve did nothing: ${hidden} hidden, ${dashed} dashed`);
    add("view.visibility.resolve", resolve, { totalElements, visibleSolids: all.length - hidden }, `Whole head (${all.length} elements): ${hidden} hidden (new work and one group), ${dashed} dashed (demolished).`);
  }

  // ---------------------------------------------------------------- pointer-follow drag of a routed piece (nothing sent)
  {
    const view = viewOf(author);
    const target = Object.keys(view.elements).find((id) => /^perf-split-\d+-s1$/.test(id));
    if (!target) throw new Error("[perf] no split piece left to drag");
    const ghost: number[] = [];
    let accepted = 0;
    let refusal = "";
    for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
      ghost.push(
        timeSync(() => {
          const r = executeCommand(view, { type: "drag_run", elementId: target, delta: { x: 0, y: (1 + (i % 4)) * IN, z: 0 } });
          if (r.ok) accepted += 1;
          else refusal = r.error.message;
          return r.ok ? r.changedIds.length : 0;
        }).ms,
      );
    }
    if (accepted === 0) throw new Error(`[perf] every drag preview was refused: ${refusal}`);
    add("edit.ghost.drag_run", ghost, { totalElements, subscribedElements }, `Drag ${target} along itself per pointer move; ${accepted} of ${ghost.length} previews accepted.`);

    // Dragged far past what the next piece allows: refused, the stop solved, the stop previewed (the UI's worst case).
    const stop: number[] = [];
    let stopped = 0;
    let why = "";
    const far = 200 * 12 * IN;
    const direction = [
      { x: 0, y: far, z: 0 },
      { x: 0, y: -far, z: 0 },
      { x: far, y: 0, z: 0 },
      { x: -far, y: 0, z: 0 },
    ].find((delta) => !executeCommand(view, { type: "drag_run", elementId: target, delta }).ok && dragLimit(view, { type: "drag_run", elementId: target, delta }).accepted);
    if (!direction) throw new Error(`[perf] no direction to drag ${target} that stops at a limit`);
    for (let i = 0; i < Math.max(samplesPerRun, 60); i++) {
      const k = 1 + (i % 4) / 100;
      const cmd = { type: "drag_run" as const, elementId: target, delta: { x: direction.x * k, y: direction.y * k, z: 0 } };
      stop.push(
        timeSync(() => {
          const r = executeCommand(view, cmd);
          if (r.ok) return r.changedIds.length;
          const limit = dragLimit(view, cmd);
          why = limit.binding?.message ?? why;
          const at = limit.accepted ? executeCommand(view, { ...cmd, delta: limit.accepted }) : null;
          if (at?.ok) stopped += 1;
          return at?.ok ? at.changedIds.length : 0;
        }).ms,
      );
    }
    if (stopped === 0) throw new Error(`[perf] no drag stopped at its limit: ${why}`);
    add("edit.ghost.drag_run_stop", stop, { totalElements, subscribedElements }, `Drag ${target} 200 ft per pointer move; ${stopped} of ${stop.length} stopped at the limit (${why}).`);
  }

  if (writeSlice) {
    mkdirSync(path.dirname(writeSlice), { recursive: true });
    writeFileSync(writeSlice, JSON.stringify(author.client.confirmedModel()));
  }
  for (const o of observers) leave(o);
  leave(author);

  emit({
    suite: "synthetic",
    network: "in-process loopback (string transport; no network, no Postgres)",
    participants,
    workload: {
      tier,
      floors: opts.floors,
      zonesPerFloor: opts.zonesPerFloor,
      totalElements,
      interest: authorZone,
      commands: commands.map(([n]) => n),
      samplesPerRun,
      editTargets: {
        slide_branch: tapId,
        resize_run: trunkId,
        place_part: `${diffuser.id} on ${levelName} Z${lastZone}`,
        move_elements: "perf-part-0",
        route_run: "perf-part-<i> neck, rise to 11 ft, north 6 ft, east 4 ft",
        resize_routed: "perf-run-0-s2 (10\"/12\" round)",
        swap_fitting: "perf-run-<i>-f2 to a smooth round elbow",
        offset_run: "perf-run-<i>-s3 up 6\" at 2.5 ft, 45° elbows, to the open end",
        move_connected: "perf-part-0 with perf-run-0 connected",
        delete_connected: "perf-jog-<i>-s1 (the open end leg after the offset), cascade",
        split_run: "perf-run-<i>-s2 at 3 ft",
        resize_stretch: "perf-split-<i>-s1 to 16\" round (a transition where it meets the head)",
        drag_run: "perf-split-<i>-s1 north 3\"",
        move_group: "perf-split-<i>-s1 north 3\" (move_elements with a run piece)",
        resize_batch: "every perf-run-<i>-s2 and perf-split-<i>-s1 in one resize_stretch, 14\"/18\" round",
        route_pipe: "2\" PVC sanitary drain, sloped 1/4\" per ft, north 10 ft then east 2 ft",
        swap_pipe_fitting: "perf-drain-<i>-f1 to a 1/4 bend",
      },
      observers: ["same zone", "other zone, same level", "other level"],
    },
    samples,
    invariants,
    info: {
      generateMs: round(generateMs, 1),
      loadMs: round(loadMs, 1),
      memoryAfterLoad: memAfterLoad,
      warmModel: { indexMs: round(warm.indexMs, 1), partitionsMs: round(warm.partitionsMs, 1), derivedMs: round(warm.derivedMs, 1), validateMs: round(warm.validateMs, 1) },
      hubJoins: hub.metrics.joins.slice(0, 3),
    },
  });
  process.exit(0);
}

main().catch((err) => {
  console.error("[perf] synthetic run failed", err);
  process.exit(1);
});
