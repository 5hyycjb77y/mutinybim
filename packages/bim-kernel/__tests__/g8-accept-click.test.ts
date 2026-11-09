/**
 * @jest-environment node
 *
 * Lane G, kernel side of "click a previewed room to accept its ghosts".
 *
 * - g8-kernel-has-no-receptacle-types: receptacle shapes and their accept
 *   command live in the electrical add-on, not the kernel. Fails on round 7:
 *   `ReceptacleRules`, `ReceptacleProposal` and `acceptProposalCommand` were
 *   in `propose/types.ts` / `propose/commands.ts`.
 * - g8-ghosts-at: a click inside a previewed room takes that room's ghosts,
 *   a click anywhere else takes none (the host selects as before), and a
 *   proposer's own `acceptAt` wins. Fails on round 7: no `ghostsAt`.
 * - propose.accept_click.250k: `ghostsAt` + `acceptGhostsCommand` on a
 *   250,000-element model, ≤ 50 ms.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as kernel from "../src";
import { acceptGhostsCommand, DEFAULT_SETTINGS, ghostsAt, PROPOSER_POINT, runProposer, type BimElement, type GhostPlacement, type ModelState, type ProposerAnswer, type ProposerDef, type Vec2 } from "../src";
import { bindModelPacks, contribute, definePack, PackSet } from "../src/packs";

const TYPE = "builtin:duplex-receptacle@1";

const room = (id: string, x0: number, w: number): BimElement =>
  ({ id, version: 1, authoredRev: {}, kind: "room", number: id, name: `Office ${id}`, outline: [{ x: x0, y: 0 }, { x: x0 + w, y: 0 }, { x: x0 + w, y: 4000 }, { x: x0, y: 4000 }], areaSqM: (w * 4000) / 1e6, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" } }) as unknown as BimElement;
const level = { id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement;

/** Two ghosts in the middle of each asked-for room. */
const CORNERS: ProposerDef = {
  id: "zg.corners",
  label: "Corner devices",
  hosts: "rooms",
  propose: (model, request) => {
    const ghosts: GhostPlacement[] = [];
    for (const roomId of request.roomIds) {
      const el = model.elements[roomId];
      if (el?.kind !== "room") continue;
      const x = el.outline[0]?.x ?? 0;
      ghosts.push({ key: `${roomId}#1`, roomId, typeId: request.typeId, position: { x: x + 500, y: 500 }, heightMm: 450, rotationDeg: 0, reason: "Device 1 of 2" });
      ghosts.push({ key: `${roomId}#2`, roomId, typeId: request.typeId, position: { x: x + 1500, y: 500 }, heightMm: 450, rotationDeg: 0, reason: "Device 2 of 2" });
    }
    return { ghosts, summary: `${ghosts.length} devices`, passes: true, notes: [] };
  },
};
/** Accepts only the ghost nearest the click. */
const NEAREST: ProposerDef = {
  ...CORNERS,
  id: "zg.nearest",
  acceptAt: (_model, answer, point) => {
    const near = [...answer.ghosts].sort((a, b) => Math.hypot(a.position.x - point.x, a.position.y - point.y) - Math.hypot(b.position.x - point.x, b.position.y - point.y))[0];
    return near ? [near] : null;
  },
};
const ZG = definePack({ id: "zg", name: "Click test", version: "1.0.0", kernel: "^1.4.0" }, [contribute(PROPOSER_POINT, [CORNERS, NEAREST])]);

function model(id: string, els: readonly BimElement[]): ModelState {
  return { modelId: id, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

function answerOf(m: ModelState, proposerId: string, roomIds: readonly string[]): ProposerAnswer {
  const a = runProposer(m, proposerId, { typeId: TYPE, roomIds });
  if ("refused" in a) throw new Error(a.refused);
  return a;
}

describe("g8-kernel-has-no-receptacle-types", () => {
  it("the kernel exports no receptacle shapes or receptacle accept command", () => {
    for (const name of ["acceptProposalCommand", "isReceptacleType", "receptacleRoomGeometries", "ROOM_RULES", "DENSITY_PRESETS"]) expect(Object.keys(kernel)).not.toContain(name);
  });

  it("no receptacle word under the kernel's propose folder", () => {
    const dir = path.join(__dirname, "../src/propose");
    const hits = readdirSync(dir).filter((f) => /receptacle/i.test(readFileSync(path.join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("g8-ghosts-at", () => {
  const ID = "g8-click";
  beforeAll(() => bindModelPacks(ID, PackSet.create([ZG])));
  const m = model(ID, [level, room("R1", 0, 4000), room("R2", 4000, 4000), room("R3", 8000, 4000)]);

  it("a click inside a previewed room takes that room's ghosts, as one edit", () => {
    const answer = answerOf(m, "zg.corners", ["R1", "R2"]);
    const taken = ghostsAt(m, "zg.corners", answer, { x: 6000, y: 2000 });
    expect(taken?.map((g) => g.key)).toEqual(["R2#1", "R2#2"]);
    const command = acceptGhostsCommand(m, taken ?? [], { label: "Devices in R2" });
    if (typeof command === "string") throw new Error(command);
    expect(command.type).toBe("place_devices");
    expect(command.devices).toHaveLength(2);
    expect(command.levelId).toBe("L1");
  });

  it("a click on a room that isn't previewed, or outside every room, takes nothing", () => {
    const answer = answerOf(m, "zg.corners", ["R1", "R2"]);
    expect(ghostsAt(m, "zg.corners", answer, { x: 10000, y: 2000 })).toBeNull();
    expect(ghostsAt(m, "zg.corners", answer, { x: 2000, y: 9000 })).toBeNull();
  });

  it("a proposer's own acceptAt decides what a click takes", () => {
    const answer = answerOf(m, "zg.nearest", ["R1"]);
    expect(ghostsAt(m, "zg.nearest", answer, { x: 1400, y: 600 })?.map((g) => g.key)).toEqual(["R1#2"]);
  });
});

describe("propose.accept_click.250k", () => {
  it("ghostsAt + acceptGhostsCommand on a 250,000-element model stays under 50 ms", () => {
    const ID = "g8-click-250k";
    bindModelPacks(ID, PackSet.create([ZG]));
    const els: BimElement[] = [level];
    for (let i = 0; i < 250_000; i += 1) {
      if (i % 10 === 0) els.push(room(`R${i}`, i * 500, 4000));
      else els.push({ id: `W${i}`, version: 1, authoredRev: {}, kind: "wall", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thickness: 100, height: 3000, wallType: "x" } as unknown as BimElement);
    }
    const big = model(ID, els);
    const roomIds = ["R0", "R10", "R20", "R30"];
    const answer = answerOf(big, "zg.corners", roomIds);
    // The level lookup reads the store's per-chunk kind index, built once for a plain record and reused by later revisions; the row is warm.
    const t0 = performance.now();
    acceptGhostsCommand(big, answer.ghosts.slice(0, 2), { label: "warm" });
    const indexBuild = performance.now() - t0;
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const roomId = roomIds[i % roomIds.length] ?? "R0";
      const x0 = Number(roomId.slice(1)) * 500;
      const at: Vec2 = { x: x0 + 2000, y: 2000 };
      const t = performance.now();
      const taken = ghostsAt(big, "zg.corners", answer, at);
      const command = acceptGhostsCommand(big, taken ?? [], { label: "Devices" });
      samples.push(performance.now() - t);
      if (typeof command === "string") throw new Error(command);
      expect(command.devices).toHaveLength(2);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    process.stderr.write(`[g8 propose.accept_click.250k] index build ${indexBuild.toFixed(1)} ms once; worst ${samples.at(-1)?.toFixed(2)} ms; p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
    expect(p95).toBeLessThan(50);
  });
});
