/**
 * @jest-environment node
 *
 * Full-BIM test buildings: valid in every slice, edits ripple to what depends
 * on them, changes carry every partition they touch, and the incremental
 * kernel decides exactly like a full recompute on a cold copy.
 */
import {
  DISCIPLINES,
  canonicalJson,
  changesetPartitions,
  executeCommand,
  firstIssueAfter,
  planCommit,
  sliceChangeset,
  sliceModel,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type Interest,
  type ModelState,
  type Profile,
  plainElements,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel, describeModel } from "@permitzip/bim-first-party/seed";

const FT = 304.8;
const NOW = () => "2026-10-17T00:00:00.000Z";
const actor = { id: "priya", name: "Priya", kind: "human" as const };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(items: readonly T[], r: () => number): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function request(head: ModelState, command: Command, key: string, baseRevision: number = head.revision): CommandRequest {
  return { idempotencyKey: key, baseRevision, actor, command };
}

function commit(head: ModelState, command: Command, key: string): { model: ModelState; changeset: Changeset } {
  const d = planCommit(head, [], request(head, command, key), NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return { model: d.model, changeset: d.changeset };
}

const PROFILES: readonly Profile[] = [
  { shape: "rect", width: 30 * 25.4, height: 20 * 25.4 },
  { shape: "round", diameter: 5 * 25.4 },
];

/** Every command category, aimed at random elements anywhere in the building. */
function randomCommand(model: ModelState, r: () => number): Command {
  const all = Object.values(model.elements);
  const of = <K extends string>(kind: K) => all.filter((el) => el.kind === kind);
  const roll = r();
  if (roll < 0.2) return { type: "move_wall", wallId: pick(of("wall"), r).id, delta: r() < 0.5 ? { x: 0, y: Math.round((r() - 0.5) * 2 * FT) } : { x: Math.round((r() - 0.5) * 2 * FT), y: 0 } };
  if (roll < 0.4) {
    const tap = pick(all.filter((el) => el.kind === "tap"), r);
    return { type: "slide_branch", tapId: tap.id, s: Math.round((3 + r() * 4) * FT * 10) / 10 };
  }
  if (roll < 0.55) return { type: "set_terminal_cfm", terminalId: pick(of("terminal"), r).id, cfm: Math.round(r() * 50000) / 100 };
  if (roll < 0.7) {
    const riser = pick(all.filter((el) => el.kind === "riser_segment"), r);
    return { type: "resize_riser", riserId: riser.kind === "riser_segment" ? riser.riserId : "none", profile: pick(PROFILES, r) };
  }
  if (roll < 0.85) return { type: "set_tag_text", tagId: pick(of("tag"), r).id, text: `T${Math.floor(r() * 1000)}` };
  return { type: "move_tag", tagId: pick(of("tag"), r).id, offset: { x: Math.round(r() * 600), y: Math.round(r() * 600) } };
}

const XS = createFullBimModel(FULL_BIM_TIERS.XS);

describe("full-BIM test building", () => {
  it("is valid, every element carries a partition, and every slice is a valid model", () => {
    expect(validateModel(XS)).toEqual([]);
    for (const el of Object.values(XS.elements)) expect(el.partition).toBeDefined();
    const slices: Interest[] = [
      { areas: [{ level: "L01", zone: "Z1" }] },
      { areas: [{ level: "L02" }] },
      ...DISCIPLINES.map((d) => ({ areas: [{ level: "L01", zone: "Z2" }], disciplines: [d] })),
    ];
    for (const interest of slices) {
      const slice = sliceModel(XS, interest);
      expect(Object.keys(slice.elements).length).toBeGreaterThan(0);
      expect(validateModel(slice)).toEqual([]);
    }
  });

  it("one zone at default density has the documented mix", () => {
    const zone = describeModel(createFullBimModel({ floors: 1, zonesPerFloor: 1 }));
    expect(zone.total).toBe(5086);
    expect(zone.byDiscipline).toEqual({ architecture: 684, structure: 110, mechanical: 1191, plumbing: 1191, fire_protection: 479, electrical: 1431 });
  });

  it("moving a wall carries its door, the door's tag and the room dimension with it", () => {
    const wallId = "L01-Z1-wh1-0";
    const { model, changeset } = commit(XS, { type: "move_wall", wallId, delta: { x: 0, y: 2 * FT } }, "wall-move-key");
    const ids = changeset.elements.map((el) => el.id);
    expect(ids).toEqual(expect.arrayContaining([wallId, "L01-Z1-door-201", "L01-Z1-door-201-tag"]));
    const dim = Object.values(model.elements).find((el) => el.kind === "dimension" && (el.aId === wallId || el.bId === wallId));
    const before = dim ? XS.elements[dim.id] : undefined;
    expect(dim?.kind === "dimension" && before?.kind === "dimension" ? Math.abs(before.valueMm - dim.valueMm) : null).toBeCloseTo(2 * FT, 0);
    expect(validateModel(model)).toEqual([]);
  });

  it("incremental validation re-checks what points at a changed element: a door no longer fitting its shortened wall", () => {
    validateModel(XS); // establishes the base as known valid, so the check below is the incremental one
    const wall = XS.elements["L01-Z1-wh1-0"];
    if (!wall || wall.kind !== "wall") throw new Error("fixture wall missing");
    const shorter = { ...wall, end: { x: wall.start.x + 2 * FT, y: wall.end.y } };
    const after: ModelState = { ...XS, elements: { ...XS.elements, [wall.id]: shorter } };
    expect(firstIssueAfter(XS, after, [wall.id])).toEqual(validateModel(after)[0]);
    expect(firstIssueAfter(XS, after, [wall.id])?.code).toBe("outside_host");
  });

  it("a riser edit touches its piece on every level, and the change names every partition", () => {
    const { changeset } = commit(XS, { type: "resize_riser", riserId: "riser-Z1-water", profile: { shape: "round", diameter: 6 * 25.4 } }, "riser-key-01");
    expect(changeset.elements.map((el) => el.id)).toEqual(["L01-Z1-riser-water", "L02-Z1-riser-water"]);
    expect(changesetPartitions(changeset)).toEqual(["L01|Z1|plumbing", "L02|Z1|plumbing"]);
    expect(sliceChangeset(changeset, { areas: [{ level: "L02" }] }).elements.map((el) => el.id)).toEqual(["L02-Z1-riser-water"]);
  });

  it("predicting a local edit on your zone's slice gives exactly the server's result for that zone", () => {
    const zone: Interest = { areas: [{ level: "L02", zone: "Z2" }] };
    const slice = sliceModel(XS, zone);
    const commands: Command[] = [
      { type: "move_wall", wallId: "L02-Z2-wv1-0", delta: { x: FT, y: 0 } },
      { type: "slide_branch", tapId: "L02-Z2-air-t2-s3-b2-tap", s: 6.5 * FT },
      { type: "set_terminal_cfm", terminalId: "L02-Z2-el-t1-s2-b1-dev", cfm: 500 },
      { type: "move_tag", tagId: "L02-Z2-room-101-tag", offset: { x: 600, y: 0 } },
    ];
    for (const command of commands) {
      const server = executeCommand(XS, command);
      const local = executeCommand(slice, command);
      if (!server.ok || !local.ok) throw new Error(`${command.type} refused`);
      expect(canonicalJson(sliceModel(server.model, zone).elements)).toBe(canonicalJson(local.model.elements));
    }
  });

  it("property: the incremental kernel decides every category exactly like a cold full recompute", () => {
    const r = rng(23);
    let head = XS;
    const log: Changeset[] = [];
    let committed = 0;
    for (let i = 0; i < 120; i++) {
      const command = randomCommand(head, r);
      const stale = log.length > 2 && r() < 0.3;
      const req = request(head, command, `prop-${i}-key`, stale ? head.revision - 2 : head.revision);
      const since = log.filter((cs) => cs.revision > req.baseRevision);
      const cold = structuredClone({ ...head, elements: plainElements(head.elements) });
      expect(canonicalJson(executeCommand(head, command))).toBe(canonicalJson(executeCommand(cold, command)));
      const warm = planCommit(head, since, req, NOW);
      expect(canonicalJson(warm)).toBe(canonicalJson(planCommit(cold, since, req, NOW)));
      if (warm.ok) {
        head = warm.model;
        log.push(warm.changeset);
        committed += 1;
      }
    }
    expect(committed).toBeGreaterThan(30);
    expect(validateModel(head)).toEqual([]);
  });
});
