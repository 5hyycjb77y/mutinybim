/**
 * @jest-environment node
 *
 * Putting a part on a run (round 14, P13 deferral 8): `insertPartOnRun` cuts
 * a run at a point and joins a part's two in-line connectors there, as one
 * undo step, on a bare kernel. Refusals are in words: not on this run, no
 * in-line pair, the wrong size, too close to an end, a branch in the way.
 * Fails on round 13: the function was a stub that refused everything.
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  canonicalJson,
  insertPartOnRun,
  planCommit,
  runNeighbours,
  partNode,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type ModelState,
  type PartTypeDefinition,
  type RunSegment,
} from "../src";
import { isPackRefusal } from "../src/packs";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-11-04T00:00:00.000Z";
/** The kernel's own service: no add-on is loaded here. */
const SYS = { id: "sys-1", kind: "other" as const, name: "Loop 1" };
const ROUND = { shape: "pipe" as const, nominalMm: 4 * IN, material: "pvc" as const };

const roundConnector = (id: string, x: number, dx: number) => ({
  id,
  label: id,
  domain: "pipe" as const,
  systemKind: "other" as const,
  position: [x, 0, 0] as [number, number, number],
  direction: [dx, 0, 0] as [number, number, number],
  shape: "round" as const,
  diameter: 4 * IN,
});

/** A 12 in long in-line part with a 4 in connector at each end. */
const INLINE: PartTypeDefinition = {
  familyName: "In-line body",
  typeName: "4 in",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 0], size: [12 * IN, 11 * IN, 11 * IN] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [12 * IN, 11 * IN] }],
  connectors: [roundConnector("a", -6 * IN, -1), roundConnector("b", 6 * IN, 1)],
  source: { kind: "builtin", libraryVersion: "test" },
};

/** Same body with one connector only (a cap-like end piece). */
const ONE_END: PartTypeDefinition = { ...INLINE, typeName: "one end", connectors: [roundConnector("a", -6 * IN, -1)] };
const SMALL: PartTypeDefinition = { ...INLINE, typeName: "2 in", connectors: INLINE.connectors.map((c) => ({ ...c, diameter: 2 * IN })) };

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor() {
    this.head = { modelId: "insert-part", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  }
  submit(command: Command) {
    counter += 1;
    const base = this.head.revision;
    const req: CommandRequest = { idempotencyKey: `ip-${counter}-key`, baseRevision: base, actor: { id: "priya", name: "Priya", kind: "human" }, command, clientSessionId: "tab" };
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command): Changeset {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
    return el;
  }
}

function plan(m: Model, request: Parameters<typeof insertPartOnRun>[1]): Command[] {
  const out = insertPartOnRun(m.head, request);
  if (isPackRefusal(out)) throw new Error(`refused: ${out.refused}`);
  return [...out];
}

function refusal(m: Model, request: Parameters<typeof insertPartOnRun>[1]): string {
  const out = insertPartOnRun(m.head, request);
  if (!isPackRefusal(out)) throw new Error("expected a refusal");
  return out.refused;
}

/** A straight 20 ft pipe along +x (or at 45° in plan) on Level 1. */
function straight(angled = false): { m: Model; segId: string } {
  const m = new Model();
  const end = angled ? { x: 20 * FT * Math.SQRT1_2, y: 20 * FT * Math.SQRT1_2 } : { x: 20 * FT, y: 0 };
  m.ok({ type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "pipe", size: ROUND, elevationMm: 9 * FT, system: SYS, points: [{ x: 0, y: 0 }, end] });
  const segs = Object.values(m.head.elements).filter((e): e is RunSegment => e.kind === "run_segment");
  expect(segs).toHaveLength(1);
  const only = segs[0];
  if (!only) throw new Error("no run");
  return { m, segId: only.id };
}

describe("p14 insert part on run", () => {
  test("splits the run at the point and joins the part's two connectors, as one undo step", () => {
    const { m, segId } = straight();
    const before = m.head;
    const commands = plan(m, { runId: segId as RunSegment["id"], atMm: 8 * FT, partDefinitionId: "type-inline", partType: INLINE, idPrefix: "ins" });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe("batch_edits");
    const cs = m.ok(commands[0] as Command);
    expect(validateModel(m.head).filter((i) => i.elementIds.some((id) => [segId, "ins-part", "ins-cut-s1"].includes(id)))).toEqual([]);

    const head = m.seg(segId);
    const tail = m.seg("ins-cut-s1");
    const part = m.head.elements["ins-part"];
    expect(part?.kind).toBe("part");
    // The part's middle is at 8 ft: the near piece ends 6 in before it, the far piece starts 6 in after.
    expect(head.end.x).toBeCloseTo(8 * FT - 6 * IN, 2);
    expect(tail.start.x).toBeCloseTo(8 * FT + 6 * IN, 2);
    expect(tail.end.x).toBeCloseTo(20 * FT, 2);
    expect(head.links.end).toEqual({ elementId: "ins-part", port: "a" });
    expect(tail.links.start).toEqual({ elementId: "ins-part", port: "b" });
    expect(head.size).toEqual(ROUND);
    expect(tail.size).toEqual(ROUND);
    expect(tail.systemId).toBe(head.systemId);
    // The run reaches the part's connectors on both sides.
    expect(runNeighbours(m.head.elements, head.id)).toContain(partNode("ins-part", "a"));
    expect(runNeighbours(m.head.elements, tail.id)).toContain(partNode("ins-part", "b"));

    // One undo step puts the run back exactly (only the record versions move on).
    m.ok({ type: "undo", revision: cs.revision });
    const unversioned = (s: ModelState) => canonicalJson(Object.fromEntries(Object.entries(s.elements).map(([id, el]) => [id, { ...el, version: 0 }])));
    expect(unversioned(m.head)).toBe(unversioned(before));
  });

  test("a run at 45° in plan turns the part to match", () => {
    const { m, segId } = straight(true);
    const [cmd] = plan(m, { runId: segId as RunSegment["id"], atMm: 10 * FT, partDefinitionId: "type-inline", partType: INLINE, idPrefix: "ins" });
    m.ok(cmd as Command);
    const part = m.head.elements["ins-part"];
    if (part?.kind !== "part") throw new Error("no part");
    expect(part.rotationDeg).toBeCloseTo(45, 4);
    expect(m.seg(segId).links.end?.elementId).toBe("ins-part");
    expect(m.seg("ins-cut-s1").links.start?.elementId).toBe("ins-part");
  });

  test("a type already in the model is not pinned again", () => {
    const { m, segId } = straight();
    m.ok({ type: "place_part", partId: "elsewhere", typeId: "type-inline", partType: INLINE, levelId: "lvl-1", position: { x: 0, y: 10 * FT } });
    const [cmd] = plan(m, { runId: segId as RunSegment["id"], atMm: 5 * FT, partDefinitionId: "type-inline", idPrefix: "ins" });
    if (cmd?.type !== "batch_edits") throw new Error("expected a batch");
    const place = cmd.commands.find((c) => c.type === "place_part");
    expect(place && "partType" in place ? place.partType : undefined).toBeUndefined();
    m.ok(cmd);
  });

  test("refuses in words", () => {
    const { m, segId } = straight();
    const runId = segId as RunSegment["id"];
    expect(refusal(m, { runId, atMm: 30 * FT, partDefinitionId: "t", partType: INLINE })).toMatch(/isn't on the .*20 ft long/);
    expect(refusal(m, { runId, atMm: 5 * FT, partDefinitionId: "t", partType: ONE_END })).toMatch(/has no pair of connectors a run passes straight through/);
    expect(refusal(m, { runId, atMm: 5 * FT, partDefinitionId: "t", partType: SMALL })).toMatch(/doesn't take a 4" .*run; pick a 4"/);
    expect(refusal(m, { runId, atMm: 8 * IN, partDefinitionId: "t", partType: INLINE })).toMatch(/too short there.*Move it at least/);
    expect(refusal(m, { runId, atMm: 20 * FT - 8 * IN, partDefinitionId: "t", partType: INLINE })).toMatch(/too short there/);
    expect(refusal(m, { runId: "nope" as RunSegment["id"], atMm: 5 * FT, partDefinitionId: "t", partType: INLINE })).toMatch(/There is no run nope/);
    expect(refusal(m, { runId, atMm: 5 * FT, partDefinitionId: "missing" })).toMatch(/There is no part type missing/);
  });
});
