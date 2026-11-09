/**
 * @jest-environment node
 *
 * Round 9 lane J9 (Product decision, Nov 1): parts join directly end to end
 * (`join_parts`), any discipline. A mismatch (end type, shape, size, system)
 * is joined and reported as advice, never refused; only a join that can't
 * exist is refused, in plain words. Undoable; written only to peers that
 * read `parts:direct_joins`. Load points first: an unrouted load point is
 * not a connector problem, and a load point served by a part directly
 * carries the same requirement as one served by a run. Fails on round 8b's
 * code: two parts were refused ("Two parts connect through a run") and there
 * was no join to a load point.
 */
import {
  CONNECTOR_END_TYPES_FEATURE,
  DEFAULT_SETTINGS,
  JOIN_PARTS_FEATURE,
  asElementId,
  commandSchema,
  executeCommand,
  freezeElements,
  loadPointLoad,
  loadPointTotals,
  modelIntegrityIssues,
  planCommit,
  servesOf,
  validateModel,
  withUpgradePolicy,
  type BimElement,
  type Changeset,
  type LoadPointElement,
  type ModelState,
  type PartInstance,
  type PartTypeDefinition,
} from "@permitzip/bim-kernel";
import { straightPiece, IN, type End } from "./fixtures/j9-pieces";

const actor = { id: "u-j9", name: "J9", kind: "human" as const };
let seq = 0;
const NEW_PEERS = (f: string) => f === CONNECTOR_END_TYPES_FEATURE || f === JOIN_PARTS_FEATURE;

type Decision = ReturnType<typeof planCommit>;

function attempt(head: ModelState, command: unknown, policy: (f: string) => boolean = NEW_PEERS, history: readonly Changeset[] = []): Decision {
  seq += 1;
  return withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `j9-join-${seq}-xxxxxxxxxx`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-11-01T15:00:00.000Z", history));
}

function commit(head: ModelState, command: unknown, history: readonly Changeset[] = []): { model: ModelState; changeset: Changeset; summary: readonly string[] } {
  const d = attempt(head, command, NEW_PEERS, history);
  if (!d.ok) throw new Error(`refused: ${d.error.message}`);
  const parsed = commandSchema.parse(command);
  const run = parsed.type === "undo" ? null : withUpgradePolicy(NEW_PEERS, () => executeCommand(head, parsed));
  return { model: d.model, changeset: d.changeset, summary: run?.ok ? (run.summary ?? []) : [] };
}

function refusal(head: ModelState, command: unknown, policy: (f: string) => boolean = NEW_PEERS): string {
  const d = attempt(head, command, policy);
  if (d.ok) throw new Error("expected a refusal");
  return d.error.message;
}

function level(): ModelState {
  const head: ModelState = { modelId: "j9-join", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(head, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }).model;
}

function pieces(a: End, b: End, at = 300, rotationDeg = 0): ModelState {
  let m = level();
  m = commit(m, { type: "place_part", partId: "A", typeId: "j9-a", partType: straightPiece("A type", a), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "A" }).model;
  m = commit(m, { type: "place_part", partId: "B", typeId: "j9-b", partType: straightPiece("B type", b), levelId: "lvl-1", position: { x: at, y: 0 }, offsetMm: 1000, rotationDeg, mark: "B" }).model;
  return m;
}

const JOIN = { type: "join_parts", a: { elementId: "A", port: "b" }, b: { elementId: "B", port: "a" } };

describe("j9 join_parts: direct part joins", () => {
  it("joins two matching ends: both sides linked, no finding, no validation issue", () => {
    const { model, summary } = commit(pieces({ endType: "mechanical.slip" }, { endType: "mechanical.slip" }), JOIN);
    expect((model.elements.A as PartInstance).links).toEqual({ b: { elementId: "B", port: "a" } });
    expect((model.elements.B as PartInstance).links).toEqual({ a: { elementId: "A", port: "b" } });
    expect(modelIntegrityIssues(model.elements)).toEqual([]);
    expect(validateModel(model)).toEqual([]);
    expect(summary).toEqual(["Joined A and B end to end"]);
  });

  it("joins mismatched ends and reports each mismatch at the joint as advice", () => {
    const { model, summary } = commit(pieces({ endType: "mechanical.slip" }, { endType: "mechanical.flanged", shape: "rect", systemKind: "return_air" }), JOIN);
    expect(modelIntegrityIssues(model.elements).map((i) => i.check).sort()).toEqual(["end_type_mismatch", "service_mismatch", "shape_mismatch"]);
    expect(summary[0]).toBe("Joined A and B end to end");
    expect(summary.slice(1)).toEqual(
      expect.arrayContaining([
        "Check: A's out has a slip end where it meets B's in, a flanged end; they join only with a slip-to-flange adapter. Add a slip-to-flange adapter between them, or change one end type",
        "Check: A's out (12 in round) meets B's in (12×10 in rectangular). Put a transition between them, or change one connector's shape",
      ]),
    );
    expect(validateModel(model)).toEqual([]);
  });

  it("refuses only a join that can't exist, in plain words", () => {
    expect(refusal(pieces({}, {}, 310), JOIN)).toBe("A's out and B's in are 10 mm apart; move one onto the other, or route a run between them");
    expect(refusal(pieces({}, {}, 450, 90), { ...JOIN, b: { elementId: "B", port: "a" } })).toMatch(/apart|don't face each other/);
    const joined = commit(pieces({}, {}), JOIN).model;
    expect(refusal(joined, JOIN)).toBe("A's out is already joined; disconnect it first");
    expect(refusal(pieces({}, {}), { ...JOIN, b: { elementId: "B", port: "zz" } })).toBe("B has no connector zz");
  });

  it("an older peer gets the older-server words and nothing changes", () => {
    expect(refusal(pieces({}, {}), JOIN, (f) => f === CONNECTOR_END_TYPES_FEATURE)).toMatch(/^Parts can't be joined end to end yet: the model server this model is open on is an older version/);
  });

  it("undo takes the join back on both sides", () => {
    const prior = pieces({}, {});
    const joined = commit(prior, JOIN);
    const undone = commit(joined.model, { type: "undo", revision: joined.changeset.revision }, [joined.changeset]).model;
    expect((undone.elements.A as PartInstance).links).toBeUndefined();
    expect((undone.elements.B as PartInstance).links).toBeUndefined();
  });

  it("Connect runs on two parts makes the same join", () => {
    const { model } = commit(pieces({}, {}), { type: "connect_runs", a: { elementId: "A", port: "b" }, b: { elementId: "B", port: "a" } });
    expect((model.elements.A as PartInstance).links?.b).toEqual({ elementId: "B", port: "a" });
  });

  it("disconnecting one side frees both", () => {
    const joined = commit(pieces({}, {}), JOIN).model;
    const { model } = commit(joined, { type: "disconnect_run", elementId: "A", port: "b" });
    expect((model.elements.A as PartInstance).links).toBeUndefined();
    expect((model.elements.B as PartInstance).links).toBeUndefined();
    expect(modelIntegrityIssues(model.elements).map((i) => i.check)).toEqual(["touching_not_joined"]);
  });
});

// ── Load points first ─────────────────────────────────────────────────────────

/** A source with one water outlet on its east face. */
const SOURCE: PartTypeDefinition = {
  ...straightPiece("Source"),
  familyName: "J9 source",
  connectors: [{ id: "out", label: "Outlet", domain: "pipe", systemKind: "domestic_cold_water", position: [150, 0, 0], direction: [1, 0, 0], shape: "round", diameter: 1 * IN, flowDirection: "out" }],
};

function withSource(): ModelState {
  return commit(level(), { type: "place_part", partId: "U", typeId: "j9-src", partType: SOURCE, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "U-1" }).model;
}

function put(m: ModelState, ...els: BimElement[]): ModelState {
  const elements: Record<string, BimElement> = { ...m.elements };
  for (const el of els) elements[el.id] = el;
  return { ...m, elements: freezeElements(elements) };
}

function loadPoint(id: string, more: Partial<LoadPointElement>): LoadPointElement {
  return { id: asElementId(id), version: 1, authoredRev: {}, kind: "load_point", connectionType: "", values: { wsfu_cold: 4 }, mark: "P01-1", ...more };
}

/** The source serving a load point through a run: outlet → 1000 mm pipe → load point on the pipe's end. */
function servedByRun(): ModelState {
  const m = withSource();
  const system = { id: asElementId("SYS"), version: 1, authoredRev: {}, kind: "mep_system", name: "Cold water 1", systemKind: "domestic_cold_water", domain: "pipe" } as BimElement;
  const seg = {
    id: asElementId("S"),
    version: 1,
    authoredRev: {},
    kind: "run_segment",
    domain: "pipe",
    systemId: asElementId("SYS"),
    levelId: asElementId("lvl-1"),
    start: { x: 150, y: 0, z: 1000 },
    end: { x: 1150, y: 0, z: 1000 },
    size: { shape: "pipe", nominalMm: 25.4, material: "copper" },
    links: { start: { elementId: asElementId("U"), port: "out" } },
    branches: [],
    flow: 0,
  } as BimElement;
  const u = m.elements.U as PartInstance;
  return put(m, system, seg, { ...u, links: { out: { elementId: asElementId("S"), port: "start" } } }, loadPoint("LP", { host: { elementId: asElementId("S"), port: "end" } }));
}

describe("j9 load points first", () => {
  it("an unrouted load point is not connected yet: no connector finding, no validation issue", () => {
    const m = put(withSource(), loadPoint("LP", { anchor: { kind: "point", levelId: asElementId("lvl-1"), position: { x: 150, y: 0 } } }));
    expect(modelIntegrityIssues(m.elements)).toEqual([]);
    expect(validateModel(m)).toEqual([]);
  });

  it("a part joined straight to a load point carries its requirement, the same as a run serving it", () => {
    const byRun = servedByRun();
    const unrouted = put(withSource(), loadPoint("LP", { anchor: { kind: "none" } }));
    const { model: byJoin, summary } = commit(unrouted, { type: "join_parts", a: { elementId: "U", port: "out" }, b: { elementId: "LP", port: "load" } });
    expect(summary).toEqual(["Joined U-1 and Load point P01-1 end to end"]);
    expect((byJoin.elements.LP as LoadPointElement).joinedTo).toEqual({ elementId: "U", port: "out" });
    const lpRun = byRun.elements.LP as LoadPointElement;
    const lpJoin = byJoin.elements.LP as LoadPointElement;
    expect(servesOf(byJoin.elements, byJoin.elements.U as BimElement)).toEqual(servesOf(byRun.elements, byRun.elements.U as BimElement));
    expect(servesOf(byJoin.elements, byJoin.elements.U as BimElement)).toEqual(["LP"]);
    expect(loadPointLoad(byJoin.elements, lpJoin)).toBe(loadPointLoad(byRun.elements, lpRun));
    expect(loadPointLoad(byJoin.elements, lpJoin)).toBe(4);
    expect(loadPointTotals(byJoin.elements, lpJoin)).toEqual(loadPointTotals(byRun.elements, lpRun));
    expect(modelIntegrityIssues(byJoin.elements)).toEqual([]);
    expect(validateModel(byJoin)).toEqual([]);
  });

  it("a load point already on a run end isn't joined again, and deleting the load point frees the connector", () => {
    const byRun = servedByRun();
    const free = put(withSource(), loadPoint("LP2", { anchor: { kind: "none" } }));
    expect(refusal(put(free, loadPoint("LP3", { host: { elementId: asElementId("S"), port: "end" } })), { type: "join_parts", a: { elementId: "U", port: "out" }, b: { elementId: "LP3", port: "load" } })).toMatch(/is already on a run end/);
    expect(byRun.elements.LP).toBeDefined();
    const joined = commit(free, { type: "join_parts", a: { elementId: "U", port: "out" }, b: { elementId: "LP2", port: "load" } }).model;
    const { model } = commit(joined, { type: "delete_elements", ids: ["LP2"], policy: "disconnect" });
    expect((model.elements.U as PartInstance).links).toBeUndefined();
  });
});
