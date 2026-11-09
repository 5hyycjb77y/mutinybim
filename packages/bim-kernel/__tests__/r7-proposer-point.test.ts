/**
 * @jest-environment node
 *
 * r7-proposer-point: `kernel.proposer` v1. A pack's proposer is found only on
 * models whose add-on set has it; a missing one, or one that throws, is a
 * refusal in plain words; ghosts become one place_devices edit. Plus the
 * similar-rooms query: same use and area within 25%, typicals counted once,
 * and its cost at 250,000 elements (propose.similar_query.250k, 20 ms).
 *
 * Fails on the code before step 7b: there is no proposer point and no
 * similar-rooms query.
 */
import { performance } from "node:perf_hooks";
import { acceptGhostsCommand, carryRevision, DEFAULT_SETTINGS, PROPOSER_POINT, proposersFor, runProposer, similarRooms, type BimElement, type ModelState, type ProposerDef } from "../src";
import { bindModelPacks, contribute, definePack, PackSet } from "../src/packs";

const ECHO: ProposerDef = {
  id: "zp.echo",
  label: "Echo",
  hosts: "rooms",
  propose: (_model, request) => ({ ghosts: request.roomIds.map((roomId, i) => ({ key: `${roomId}#${i}`, roomId, typeId: request.typeId, position: { x: i * 1000, y: 0 }, heightMm: 300, rotationDeg: 0, reason: "test" })), summary: "echo", passes: true, notes: [] }),
};
const BROKEN: ProposerDef = { id: "zp.broken", label: "Broken proposer", hosts: "rooms", propose: () => { throw new Error("test failure"); } };
const ZP = definePack({ id: "zp", name: "Proposer test", version: "1.0.0", kernel: "^1.4.0" }, [contribute(PROPOSER_POINT, [ECHO, BROKEN])]);

const room = (id: string, name: string, w: number, h: number, extra: Partial<BimElement> = {}): BimElement =>
  ({ id, version: 1, authoredRev: {}, kind: "room", number: id, name, outline: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], areaSqM: (w * h) / 1e6, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" }, ...extra }) as unknown as BimElement;

function model(id: string, els: readonly BimElement[]): ModelState {
  return { modelId: id, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

describe("r7-proposer-point", () => {
  it("a pack's proposer is there only on models that use the pack", () => {
    bindModelPacks("with-zp", PackSet.create([ZP]));
    expect(proposersFor(model("with-zp", [])).map((p) => p.id)).toEqual(expect.arrayContaining(["zp.echo", "zp.broken"]));
    expect(proposersFor(model("without-zp", [])).map((p) => p.id)).not.toContain("zp.echo");
    expect(runProposer(model("without-zp", []), "zp.echo", { typeId: "t", roomIds: [] })).toEqual({ refused: 'Nothing on this model proposes "zp.echo". Its add-on isn\'t loaded here.' });
  });

  it("a proposer that throws is a refusal that names it", () => {
    bindModelPacks("with-zp", PackSet.create([ZP]));
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runProposer(model("with-zp", []), "zp.broken", { typeId: "t", roomIds: ["R1"] })).toEqual({ refused: "Broken proposer couldn't propose: test failure" });
    expect(spy).toHaveBeenCalled();
  });

  it("ghosts become one edit, or a plain refusal", () => {
    bindModelPacks("with-zp", PackSet.create([ZP]));
    const m = model("with-zp", [room("R1", "Office 101", 4000, 4000)]);
    const answer = runProposer(m, "zp.echo", { typeId: "builtin:duplex-receptacle@1", roomIds: ["R1"] });
    if ("refused" in answer) throw new Error(answer.refused);
    expect(acceptGhostsCommand(m, [], { label: "x" })).toBe("Nothing to place: no proposed device was kept.");
    expect(acceptGhostsCommand(m, answer.ghosts, { label: "x" })).toBe("Choose the level to place them on.");
  });
});

describe("similar rooms", () => {
  it("same use and area within 25%, typical copies counted once", () => {
    const groupRecord = { id: "G1", version: 1, authoredRev: {}, kind: "organization", entry: { type: "group", name: "Typical unit", typical: { copies: [{ id: "c1", dx: 0, dy: 0 }], mode: "count" } } } as unknown as BimElement;
    const els = [
      room("A", "Office 101", 4000, 4000),
      room("B", "OFFICE-102", 4000, 4500),
      room("C", "Office 103", 8000, 8000),
      room("D", "Storage 104", 4000, 4000),
      room("E", "Office 201", 4000, 4000, { groupId: "G1" }),
      room("F", "Office 202", 4000, 4000, { groupId: "G1" }),
      groupRecord,
    ];
    const m = model("similar", els);
    const found = similarRooms(m.elements, "A");
    expect(found).toContain("B");
    expect(found).not.toContain("C");
    expect(found).not.toContain("D");
    expect(found.filter((id) => id === "E" || id === "F")).toHaveLength(1);
  });

  it("propose.similar_query.250k: indexed, then each ask is a lookup", () => {
    const els: BimElement[] = [];
    for (let i = 0; i < 250_000; i += 1) {
      const kind = i % 10 === 0 ? "room" : "wall";
      if (kind === "room") els.push(room(`R${i}`, ["Office", "Storage", "Kitchen", "Corridor"][i % 4] ?? "Office", 4000 + (i % 7) * 100, 4000));
      else els.push({ id: `W${i}`, version: 1, authoredRev: {}, kind: "wall", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thickness: 100, height: 3000, wallType: "x" } as unknown as BimElement);
    }
    const m = model("similar-250k", els);
    const t0 = performance.now();
    similarRooms(m.elements, "R0");
    const first = performance.now() - t0;
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = performance.now();
      similarRooms(m.elements, `R${(i * 10) % 250_000}`);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    process.stderr.write(`[r7 propose.similar_query.250k] index build ${first.toFixed(1)} ms; ask p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
    // A guard against a scan per ask; the budget row is the perf gate's.
    expect(p95).toBeLessThan(200);

    // An edit carries the index: renaming one office to a kitchen re-reads only it.
    const renamed = { ...(m.elements.R40 as BimElement), name: "Kitchen 40" } as BimElement;
    const next: Record<string, BimElement> = { ...m.elements, R40: renamed };
    carryRevision(m.elements, next, ["R40"]);
    const t1 = performance.now();
    const kitchens = similarRooms(next, "R40");
    const afterEdit = performance.now() - t1;
    process.stderr.write(`[r7 propose.similar_query.250k] first ask after an edit ${afterEdit.toFixed(2)} ms\n`);
    expect(kitchens.length).toBeGreaterThan(0);
    expect(similarRooms(next, "R0")).not.toContain("R40");
    expect(afterEdit).toBeLessThan(first);
  });
});
