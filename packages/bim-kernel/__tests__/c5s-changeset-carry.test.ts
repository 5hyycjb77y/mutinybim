/**
 * @jest-environment node
 *
 * Round 5c f-scale (round 3): a confirmed changeset that becomes the new head
 * (committed on the model server, or applied by a browser from the feed)
 * carries the class index, the topology index and a level's members instead
 * of rebuilding them. Over random sequences of commands committed by one
 * session and applied by another, every carried index answers exactly as one
 * built fresh on the same head, and the class index and level members are
 * read with no pass over the model.
 *
 * Fails on the old code: `applyChangeset` / `planCommit` carried neither, so
 * the first read after a remote edit walked every element.
 */
import * as store from "../src/store";
import {
  applyChangeset,
  builtinPartType,
  builtinRegistry,
  buildClassIndex,
  planCommit,
  recognizes,
  type Command,
  type CommandRequest,
  type ElementId,
  type ModelState,
} from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { levelOf, SPATIAL_FIELD_PROVIDER } from "../src/fields/providers/spatial";
import { NetworkIndex, networkOf } from "../src/network";

jest.mock("../src/store", () => {
  const actual: typeof import("../src/store") = jest.requireActual("../src/store");
  return { ...actual, elementValues: jest.fn(actual.elementValues) };
});
const elementValuesSpy = store.elementValues as jest.MockedFunction<typeof store.elementValues>;

const NOW = () => "2026-10-29T00:00:00.000Z";
let seq = 0;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T | undefined {
  return xs[Math.floor(r() * xs.length)];
}

function commit(head: ModelState, command: Command) {
  seq += 1;
  const req: CommandRequest = { idempotencyKey: `c5s-carry-${seq}`, baseRevision: head.revision, actor: { id: "server", name: "Server", kind: "human" }, command };
  return planCommit(head, [], req, NOW);
}

function start(): ModelState {
  let m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-carry" });
  m = { ...m, elements: store.freezeElements(m.elements) };
  for (const c of [{ type: "create_level", levelId: "lvl-1", name: "L01", elevationMm: 0 }, { type: "create_level", levelId: "lvl-2", name: "L02", elevationMm: 4000 }] as const) {
    const d = commit(m, c);
    if (!d.ok) throw new Error(d.error.message);
    m = d.model;
  }
  return m;
}

function randomCommand(r: () => number, m: ModelState, step: number): Command | null {
  const rtu = builtinPartType("builtin:rtu-5-ton@1");
  if (!rtu) throw new Error("starter library is missing the RTU");
  const parts = store.elementsOfKind(m.elements, "part").map((p) => p.id);
  const terminals = store.elementsOfKind(m.elements, "terminal").map((t) => t.id);
  const roll = r();
  if (roll < 0.3 || parts.length === 0) return { type: "place_part", partId: `c5s-p-${step}`, typeId: rtu.id, partType: rtu.definition, levelId: r() < 0.5 ? "lvl-1" : "lvl-2", position: { x: step * 1500, y: 3000 }, offsetMm: 0, mark: `P-${step}` };
  if (roll < 0.6) return { type: "move_elements", ids: [pick(r, parts) ?? ""], delta: { x: 250, y: 0 } };
  if (roll < 0.8) return { type: "delete_elements", ids: [pick(r, terminals) ?? ""], policy: "disconnect" };
  return { type: "delete_elements", ids: [pick(r, parts) ?? ""], policy: "cascade" };
}

function expectSameNetwork(got: NetworkIndex, m: ModelState): void {
  const fresh = new NetworkIndex(m.connections, m.elements);
  expect(got.isTree).toBe(fresh.isTree);
  expect(got.disconnected()).toEqual(fresh.disconnected());
  for (const el of store.elementsOfKind(m.elements, "duct_segment", "tap", "terminal", "equipment")) {
    expect([el.id, got.children(el.id), got.parent(el.id), got.airflowRank(el.id)]).toEqual([el.id, fresh.children(el.id), fresh.parent(el.id), fresh.airflowRank(el.id)]);
  }
}

describe("c5s indexes carried onto a confirmed changeset's head", () => {
  it("random commands committed by the server and applied by a browser: carried indexes equal fresh ones", () => {
    const levelMembers = SPATIAL_FIELD_PROVIDER.resolvers?.level_members;
    if (!levelMembers) throw new Error("level_members resolver missing");
    for (const seed of [4, 31]) {
      const r = rng(seed);
      let server = start();
      let browser = server;
      const registry = builtinRegistry();
      const classes = registry.listClasses().filter((c) => c.recognize).map((c) => c.id);
      const readAll = (m: ModelState) => {
        const index = buildClassIndex(registry, m);
        for (const c of classes) index.elementsOf(c);
        const level = m.elements["lvl-1"];
        if (level) levelMembers(level, { elements: m.elements });
        networkOf(m);
      };
      readAll(server);
      let applied = 0;
      for (let step = 0; step < 16; step++) {
        const command = randomCommand(r, server, step);
        if (!command) continue;
        const d = commit(server, command);
        if (!d.ok) continue;
        server = d.model;
        browser = applyChangeset(browser, d.changeset);
        applied += 1;
        for (const m of [server, browser]) {
          elementValuesSpy.mockClear();
          const index = buildClassIndex(registry, m);
          const lists = classes.map((c) => index.elementsOf(c).map((e) => e.id));
          const level = m.elements["lvl-1"];
          const members = level ? levelMembers(level, { elements: m.elements }) : [];
          // Only a level-shaping edit (none here) or a cold record would need a pass.
          expect(elementValuesSpy).not.toHaveBeenCalled();
          const all = store.elementValues(m.elements);
          classes.forEach((c, i) => {
            const kinds = registry.descendants(c).flatMap((d) => registry.getClass(d) ?? []);
            const expected = all.filter((e) => kinds.some((k) => recognizes(k, e, m.elements))).map((e) => e.id);
            expect({ c, ids: lists[i] }).toEqual({ c, ids: expected });
          });
          expect(members).toEqual(all.filter((e) => levelOf(m.elements, e)?.id === "lvl-1").map((e) => e.id as ElementId));
          expectSameNetwork(networkOf(m), m);
        }
      }
      expect(applied).toBeGreaterThan(8);
    }
  });
});
