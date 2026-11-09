/**
 * @jest-environment node
 *
 * Split a run, resize or reshape a stretch with automatic transitions,
 * continue a route from an open end, and move a selected run whole. Fails on
 * the kernel before these commands existed (split_run / resize_stretch were
 * unknown command types; move_elements refused run pieces).
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  builtinPartType,
  canonicalJson,
  executeCommand,
  planCommit,
  portInfo,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type LibraryEntry,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from "../src";
import {
  runReadout,
} from "@permitzip/bim-pack-mechanical";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-19T00:00:00.000Z";

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
const ROUND12 = { shape: "round" as const, diameter: 12 * IN };

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(command: Command, base: number = this.head.revision) {
    counter += 1;
    const req: CommandRequest = { idempotencyKey: `k-${counter}`, baseRevision: base, actor: { id: "priya", name: "Priya", kind: "human" }, command, clientSessionId: "tab" };
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command, base?: number): Changeset {
    const d = this.submit(command, base);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(command: Command): string {
    const before = this.head;
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    expect(this.head).toBe(before);
    return d.error.message;
  }
  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is ${el?.kind ?? "missing"}`);
    return el;
  }
  fittings(type: RunFitting["fittingType"]): RunFitting[] {
    return Object.values(this.head.elements).filter((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === type);
  }
}

function expectSymmetricLinks(model: ModelState): void {
  for (const el of Object.values(model.elements)) {
    const ports: Array<[string, { elementId: string; port: string }]> =
      el.kind === "run_segment"
        ? (Object.entries(el.links) as Array<[string, { elementId: string; port: string }]>)
        : el.kind === "run_fitting"
          ? el.ports.flatMap((p) => (p.link ? [[p.id, p.link] as [string, { elementId: string; port: string }]] : []))
          : el.kind === "part"
            ? Object.entries(el.links ?? {})
            : [];
    for (const [port, link] of ports) {
      const back = portInfo(model.elements, { elementId: link.elementId as RunSegment["id"], port: link.port });
      expect(back?.link).toEqual({ elementId: el.id, port });
    }
  }
}

/** A level, and one long open duct run: 40 ft east at 10 ft, 14x10. */
function straightRun(): Model {
  const m = new Model({ modelId: "stretch", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0 }] });
  return m;
}

/** RTU -> trunk -> diffuser, with a branch to a second diffuser. */
function airSystem(): Model {
  const m = new Model({ modelId: "stretch-air", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  const place = (partId: string, entry: LibraryEntry, x: number, y: number, offsetMm: number) =>
    m.ok({ type: "place_part", partId, typeId: entry.id, ...(m.head.elements[entry.id] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y }, offsetMm });
  place("rtu", RTU, 0, 0, 12 * FT);
  place("sd-a", DIFFUSER, 20 * FT, 0, 8 * FT);
  place("sd-b", DIFFUSER, 10 * FT, 4 * FT, 8 * FT);
  m.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
  m.ok({ type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 4 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
  return m;
}

describe("split_run", () => {
  it("cuts a segment in two at a point, end to end, keeping size and connections", () => {
    const m = straightRun();
    const predicted = executeCommand(m.head, { type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 15 * FT });
    m.ok({ type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 15 * FT });
    const head = m.seg("main-s1");
    const tail = m.seg("cut-s1");
    expect(head.end).toEqual({ x: 15 * FT, y: 0, z: 10 * FT });
    expect(tail.start).toEqual(head.end);
    expect(tail.end).toEqual({ x: 40 * FT, y: 0, z: 10 * FT });
    expect(head.links.end).toEqual({ elementId: "cut-s1", port: "start" });
    expect(tail.links.start).toEqual({ elementId: "main-s1", port: "end" });
    expect(tail.size).toEqual(TRUNK);
    expect(predicted.ok ? predicted.summary?.[0] : "").toMatch(/Split the .* at 15 ft/);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("keeps branches on the piece they sit on and relinks what met the far end", () => {
    const m = airSystem();
    const tap = m.fittings("tap")[0];
    if (!tap?.host) throw new Error("no tap");
    const trunk = m.seg("trunk-s2");
    const length = Math.hypot(trunk.end.x - trunk.start.x, trunk.end.y - trunk.start.y);
    // Cut past the tap: it stays on the head; the far end's fitting now meets the tail.
    const at = tap.host.s + 3 * FT;
    expect(at).toBeLessThan(length - 2 * FT);
    m.ok({ type: "split_run", idPrefix: "cut", segmentId: "trunk-s2", atMm: at });
    expect(m.seg("trunk-s2").branches).toContain(tap.id);
    const tail = m.seg("cut-s1");
    if (trunk.links.end) expect(portInfo(m.head.elements, trunk.links.end)?.link).toEqual({ elementId: "cut-s1", port: "end" });
    expect(tail.flow).toBe(m.seg("trunk-s2").flow - m.seg("br-s1").flow);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a cut on a branch takeoff or too close to an end, and changes nothing", () => {
    const m = airSystem();
    const tap = m.fittings("tap")[0];
    if (!tap?.host) throw new Error("no tap");
    expect(m.refused({ type: "split_run", idPrefix: "cut", segmentId: "trunk-s2", atMm: tap.host.s })).toMatch(/is where the split goes/);
    expect(m.refused({ type: "split_run", idPrefix: "cut", segmentId: "trunk-s2", atMm: 10 })).toMatch(/shorter than/);
    expect(m.refused({ type: "split_run", idPrefix: "cut", segmentId: tap.id, atMm: 100 })).toMatch(/is a fitting/);
  });

  it("is undone and redone like any edit, and a concurrent edit to the same segment conflicts cleanly", () => {
    const m = straightRun();
    const base = m.head.revision;
    const split = m.ok({ type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 20 * FT });
    const undo = m.ok({ type: "undo", revision: split.revision });
    expect(m.head.elements["cut-s1"]).toBeUndefined();
    expect(m.seg("main-s1").end).toEqual({ x: 40 * FT, y: 0, z: 10 * FT });
    m.ok({ type: "undo", revision: undo.revision });
    expect(m.seg("cut-s1").start).toEqual({ x: 20 * FT, y: 0, z: 10 * FT });
    expectSymmetricLinks(m.head);
    // Two people split the same segment from the same revision: the second rebases or is refused, never half-applied.
    const n = straightRun();
    const b2 = n.head.revision;
    n.ok({ type: "split_run", idPrefix: "a", segmentId: "main-s1", atMm: 10 * FT }, b2);
    const second = n.submit({ type: "split_run", idPrefix: "b", segmentId: "main-s1", atMm: 30 * FT }, b2);
    if (second.ok) expect(validateModel(n.head)).toEqual([]);
    else expect(second.error.message.length).toBeGreaterThan(0);
    expectSymmetricLinks(n.head);
    expect(base).toBeLessThan(m.head.revision);
  });
});

describe("resize_stretch", () => {
  it("reshapes the stretch between two points to round, with a rect-to-round transition at each end", () => {
    const m = straightRun();
    const cmd: Command = { type: "resize_stretch", idPrefix: "rs", segmentIds: ["main-s1"], fromMm: 10 * FT, toMm: 30 * FT, size: ROUND12 };
    const predicted = executeCommand(m.head, cmd);
    m.ok(cmd);
    const mid = Object.values(m.head.elements).find((el): el is RunSegment => el.kind === "run_segment" && el.size.shape === "round");
    expect(mid).toBeDefined();
    const transitions = m.fittings("transition");
    expect(transitions).toHaveLength(2);
    for (const t of transitions) {
      expect(t.family).toBe("duct.transition.rect_round");
      expect(t.ports.map((p) => p.size.shape).sort()).toEqual(["rect", "round"]);
    }
    expect(predicted.ok ? predicted.summary?.join(" ") : "").toMatch(/One piece is now 12"Ø.*Added 2 transitions/);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("uses the transition asked for (eccentric, flat on top) for a same-shape size change", () => {
    const m = straightRun();
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["main-s1"], fromMm: 20 * FT, size: { shape: "rect", width: 10 * IN, height: 8 * IN }, transition: { family: "duct.transition.eccentric", params: { flat: "top" } } });
    const [t] = m.fittings("transition");
    expect(t?.family).toBe("duct.transition.eccentric");
    expect(t?.params?.flat).toBe("top");
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a transition that doesn't fit the duct beside it, like route_run, and changes nothing", () => {
    const m = straightRun();
    // A 1 ft stretch can't hold two rect-to-round transitions from 14x10 to 30" round.
    const why = m.refused({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["main-s1"], fromMm: 20 * FT, toMm: 21 * FT, size: { shape: "round", diameter: 30 * IN } });
    expect(why).toMatch(/doesn't fit/);
    expect(why).toMatch(/fittings at its ends need/);
  });

  it("takes out a transition once both sides match again", () => {
    const m = straightRun();
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["main-s1"], fromMm: 20 * FT, size: ROUND12 });
    expect(m.fittings("transition")).toHaveLength(1);
    const round = Object.values(m.head.elements).find((el): el is RunSegment => el.kind === "run_segment" && el.size.shape === "round");
    const back: Command = { type: "resize_stretch", idPrefix: "rs2", segmentIds: [round?.id ?? ""], size: TRUNK };
    const predicted = executeCommand(m.head, back);
    m.ok(back);
    expect(m.fittings("transition")).toHaveLength(0);
    expect(predicted.ok ? predicted.summary?.join(" ") : "").toMatch(/Removed 1 transition/);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("resizes a whole selection in one atomic edit: elbows between resized pieces follow, transitions only where a neighbour keeps its size", () => {
    const m = new Model({ modelId: "batch", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "L", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 20 * FT }, { x: 40 * FT, y: 20 * FT }] });
    const before = m.head.revision;
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["L-s1", "L-s2"], size: { shape: "rect", width: 18 * IN, height: 10 * IN } });
    expect(m.head.revision).toBe(before + 1);
    const elbow = Object.values(m.head.elements).find((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === "elbow" && el.ports.some((p) => p.link?.elementId === "L-s1"));
    expect(elbow?.ports.every((p) => p.size.shape === "rect" && p.size.width === 18 * IN)).toBe(true);
    expect(m.fittings("transition")).toHaveLength(1);
    expect(m.seg("L-s3").size).toEqual(TRUNK);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a branch that would be as wide as its trunk, with the reason", () => {
    const m = airSystem();
    expect(m.refused({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["br-s1"], size: { shape: "round", diameter: 14 * IN } })).toMatch(/as wide as its 14"x10" trunk|as wide as its/);
  });

  it("refuses a size of the wrong kind", () => {
    const m = straightRun();
    expect(m.refused({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["main-s1"], size: { shape: "pipe", nominalMm: 50.8, material: "copper" } })).toMatch(/isn't a duct size/);
  });
});

describe("continue a route from an open end", () => {
  it("adds a transition automatically when the new run is another size or shape", () => {
    const m = straightRun();
    m.ok({ type: "route_run", idPrefix: "more", levelId: "lvl-1", domain: "duct", size: ROUND12, elevationMm: 10 * FT, system: SA, points: [{ x: 60 * FT, y: 0 }], from: { kind: "run_end", elementId: "main-s1", port: "end" } });
    const [t] = m.fittings("transition");
    expect(t?.family).toBe("duct.transition.rect_round");
    expect(m.seg("main-s1").links.end?.elementId).toBe(t?.id);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses when the new leg is too short for that transition", () => {
    const m = straightRun();
    expect(m.refused({ type: "route_run", idPrefix: "more", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 30 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 40 * FT + 300, y: 0 }], from: { kind: "run_end", elementId: "main-s1", port: "end" } })).toMatch(/needs|shortest straight piece/);
  });
});

describe("move a selected run whole", () => {
  it("moves the selected pieces together; an open run follows freely", () => {
    const m = straightRun();
    m.ok({ type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 20 * FT });
    m.ok({ type: "move_elements", ids: ["main-s1", "cut-s1"], delta: { x: 0, y: 5 * FT } });
    expect(m.seg("main-s1").start).toEqual({ x: 0, y: 5 * FT, z: 10 * FT });
    expect(m.seg("cut-s1").end).toEqual({ x: 40 * FT, y: 5 * FT, z: 10 * FT });
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses when an unselected part connected to the selection would be dragged", () => {
    const m = airSystem();
    const ids = Object.keys(m.head.elements).filter((id) => id.startsWith("br-"));
    expect(m.refused({ type: "move_elements", ids, delta: { x: 0, y: 2 * FT } })).toMatch(/stays where it is|can only slide/);
  });

  it("moves a whole selected system with its parts", () => {
    const m = airSystem();
    const ids = Object.keys(m.head.elements).filter((id) => /^(trunk-|br-|rtu$|sd-a$|sd-b$)/.test(id));
    m.ok({ type: "move_elements", ids, delta: { x: 3 * FT, y: 0 } });
    const rtu = m.head.elements.rtu;
    expect(rtu?.kind === "part" ? rtu.position.x : null).toBeCloseTo(3 * FT, 3);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });
});

/** Avery's L: north 20 ft, an elbow, east 20 ft, both ends open. */
function lShape(): Model {
  const m = new Model({ modelId: "drag", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "route_run", idPrefix: "L", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 0, y: 20 * FT }, { x: 20 * FT, y: 20 * FT }] });
  return m;
}

describe("drag_run: direct manipulation of connected runs", () => {
  it("drags the vertical leg sideways: the elbow moves with it and the horizontal leg shortens", () => {
    const m = lShape();
    m.ok({ type: "drag_run", elementId: "L-s1", delta: { x: 3 * FT, y: 0, z: 0 } });
    expect(m.seg("L-s1").start.x).toBeCloseTo(3 * FT, 3);
    expect(m.seg("L-s1").start.y).toBe(0);
    expect(m.seg("L-s1").end.x).toBeCloseTo(3 * FT, 3);
    const elbow = m.fittings("elbow")[0];
    expect(elbow?.position.x).toBeCloseTo(3 * FT, 3);
    expect(m.seg("L-s2").start.x).toBeCloseTo(3 * FT, 3);
    expect(m.seg("L-s2").end).toEqual({ x: 20 * FT, y: 20 * FT, z: 10 * FT });
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("drags the elbow: the corner moves and both legs follow, keeping their directions", () => {
    const m = lShape();
    const elbow = m.fittings("elbow")[0];
    m.ok({ type: "drag_run", elementId: elbow?.id ?? "", delta: { x: 2 * FT, y: 4 * FT, z: 0 } });
    expect(m.fittings("elbow")[0]?.position.x).toBeCloseTo(2 * FT, 3);
    expect(m.fittings("elbow")[0]?.position.y).toBeCloseTo(24 * FT, 3);
    const a = m.seg("L-s1");
    const b = m.seg("L-s2");
    expect(a.start.x).toBeCloseTo(a.end.x, 3);
    expect(b.start.y).toBeCloseTo(b.end.y, 3);
    expect(b.end.x).toBeCloseTo(20 * FT, 3);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("slides a leg along itself", () => {
    const m = lShape();
    m.ok({ type: "drag_run", elementId: "L-s2", delta: { x: 2 * FT, y: 0, z: 0 } });
    expect(m.seg("L-s2").end.x).toBeCloseTo(22 * FT, 3);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a diagonal drag, a drag that would pull a fixed part, and one that leaves a leg too short", () => {
    const m = lShape();
    expect(m.refused({ type: "drag_run", elementId: "L-s1", delta: { x: 1 * FT, y: 1 * FT, z: 0 } })).toMatch(/square to it or along it/);
    expect(m.refused({ type: "drag_run", elementId: "L-s1", delta: { x: 19.9 * FT, y: 0, z: 0 } })).toMatch(/too short|shortest straight piece|shrink/);
    const a = airSystem();
    expect(a.refused({ type: "drag_run", elementId: "br-s1", delta: { x: 0, y: 2 * FT, z: 0 } })).toMatch(/stays where it is|can only slide/);
  });

  // Out of the riser the duct lies on its side for a short piece before its transition back. Dragging the
  // first leg pulled only that piece, so any drag past a few millimetres was refused.
  it("drags the leg before a rise at the corner: the riser and the short on-its-side piece go with it and the leg past the transition shortens", () => {
    const m = new Model({ modelId: "drag-rise", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "R", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 0, y: 20 * FT, elevationMm: 11 * FT }, { x: 20 * FT, y: 20 * FT }], fittings: { elbow_rect: { family: "duct.elbow.mitred_vanes" } } });
    const segs = () => Object.values(m.head.elements).filter((el): el is RunSegment => el.kind === "run_segment");
    const eastward = () => segs().filter((s) => Math.abs(s.start.y - 20 * FT) < 1 && Math.abs(s.end.y - 20 * FT) < 1 && s.end.x - s.start.x > 1).sort((a, b) => a.start.x - b.start.x);
    const [onSide, last] = eastward();
    if (!onSide || !last) throw new Error("expected an on-its-side piece and the leg past its transition");
    expect(m.fittings("transition")).toHaveLength(1);
    const sideLength = onSide.end.x - onSide.start.x;
    m.ok({ type: "drag_run", elementId: "R-s1", delta: { x: 3 * FT, y: 0, z: 0 } });
    const after = eastward();
    expect(after[0]?.start.x).toBeCloseTo(3 * FT, 3);
    expect((after[0]?.end.x ?? 0) - (after[0]?.start.x ?? 0)).toBeCloseTo(sideLength, 3);
    expect(after[1]?.start.x).toBeCloseTo(last.start.x + 3 * FT, 3);
    expect(after[1]?.end.x).toBeCloseTo(20 * FT, 3);
    expect(m.fittings("transition")[0]?.position.x).toBeCloseTo(last.start.x + 3 * FT, 3);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("is one atomic edit that undo takes back", () => {
    const m = lShape();
    const cs = m.ok({ type: "drag_run", elementId: "L-s1", delta: { x: 3 * FT, y: 0, z: 0 } });
    m.ok({ type: "undo", revision: cs.revision });
    expect(m.seg("L-s1").start).toEqual({ x: 0, y: 0, z: 10 * FT });
    expect(m.seg("L-s2").start.x).toBeCloseTo(0, 3);
  });
});

describe("route_run while drawing", () => {
  it("places the elbow type chosen for this route over the system default", () => {
    const m = new Model({ modelId: "fit", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT, y: 10 * FT }], fittings: { elbow_rect: { family: "duct.elbow.mitred_vanes" } } });
    expect(m.fittings("elbow")[0]?.family).toBe("duct.elbow.mitred_vanes");
    const sys = m.head.elements["sys-sa"];
    expect(sys?.kind === "mep_system" ? sys.fittingDefaults : "missing").toBeUndefined();
  });

  it("draws a vertical leg where the height changes at a point, with two 90° elbows", () => {
    const m = new Model({ modelId: "z", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "z", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 9 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 13 * FT }, { x: 20 * FT, y: 0 }] });
    const vertical = Object.values(m.head.elements).find((el): el is RunSegment => el.kind === "run_segment" && Math.abs(el.start.z - el.end.z) > 1);
    expect(vertical?.start).toMatchObject({ x: 10 * FT, y: 0 });
    expect(vertical?.end.z).toBeCloseTo(13 * FT, 3);
    expect(m.fittings("elbow").map((e) => e.angleDeg)).toEqual([90, 90]);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("draws a 45° rise as two 45° elbows and a sloped piece", () => {
    const m = new Model({ modelId: "z45", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "z", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 9 * FT, system: SA, riseStyle: "45", points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 11 * FT }, { x: 25 * FT, y: 0 }] });
    expect(m.fittings("elbow").map((e) => e.angleDeg)).toEqual([45, 45]);
  });
});

it("executeCommand predicts the same as the committed edit (local preview)", () => {
  const m = straightRun();
  const predicted = executeCommand(m.head, { type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 12 * FT });
  const cs = m.ok({ type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 12 * FT });
  const committed = m.head.elements["cut-s1"];
  const local = predicted.ok ? predicted.model.elements["cut-s1"] : undefined;
  expect(local?.kind === "run_segment" && committed?.kind === "run_segment" ? [local.start, local.end, local.links] : null).toEqual(committed?.kind === "run_segment" ? [committed.start, committed.end, committed.links] : undefined);
  expect(cs.revision).toBe(m.head.revision);
});

describe("runReadout: live numbers while routing", () => {
  it("gives the airflow, velocity and friction of the pieces drawn, and says plainly when there is none yet", () => {
    const a = airSystem();
    const trunk = Object.keys(a.head.elements).filter((id) => id.startsWith("trunk-s"));
    const r = runReadout(a.head, trunk);
    expect(r?.calculable).toBe(true);
    expect(r?.flowCfm).toBeGreaterThan(0);
    expect(r?.velocityFpm).toBeGreaterThan(0);
    expect(r?.frictionInPer100Ft).toBeGreaterThan(0);
    const open = straightRun();
    expect(runReadout(open.head, ["main-s1"])?.flowCfm).toBe(0);
    const pipe = new Model({ modelId: "p", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    pipe.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    pipe.ok({ type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, elevationMm: 1000, system: { id: "cw", kind: "domestic_cold_water" }, points: [{ x: 0, y: 0 }, { x: 3000, y: 0 }] });
    expect(runReadout(pipe.head, ["cw-s1"])).toMatchObject({ calculable: false });
  });
});
