/**
 * @jest-environment node
 *
 * Round 14 lane M14 step 1: Finish on a duct drawn across a 1-hour wall
 * places the model's fire damper type at the crossing (on the duct's
 * centreline, turned along it), after which the crossing is met. With no
 * damper type in the model, nothing is placed and the crossing is left for
 * the Checklist with what to add. An outside add-on's crossing rule places
 * its own part through the same point, with zero kernel edits.
 *
 * On a server that reads `routing:insert_part` the dampers are cut into the
 * run (`insertPartOnRun`), several on one leg, and the route plus its dampers
 * is one edit (`routeFinishBatch`); a type with no in-line connectors stays
 * on the centre line, saying why.
 *
 * Fails on round 13's code: crossing rules had no `place`, there was no
 * `routeFinishPlan` / `routeFinishBatch`, and `insertPartOnRun` refused
 * everything; Finish placed nothing.
 */
import { executeCommand, type Command, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { checkRouteLegs, routeFinishBatch, routeFinishPlan, routeFinishWords, ROUTE_CONSTRAINT_POINT, type CrossingRule } from "@permitzip/bim-kernel/rated-routes";
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import { ARCHITECTURE_PACK } from "@permitzip/bim-pack-architecture";
import { MECHANICAL_PACK } from "../src/pack";
import { M14_SET, inlineDamperType, ratedWalls, routeSupply, segmentIds, withDamperType } from "./m14-fixtures";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";

describe("m14 damper on Finish", () => {
  it("places the fire damper type at the 1-hour wall on the duct's centreline; the crossing is then met; the smoke barrier with no smoke damper type is left with its reason", () => {
    withPackSet(M14_SET, () => {
      const start = ratedWalls("m14-finish");
      const m = new Log(withDamperType(start.head, "t-fd", "fire"));
      const routed = m.ok(routeSupply("run-1"));
      const segs = segmentIds(m.head, routed.elements.map((e) => e.id));
      const plan = routeFinishPlan(m.head, segs, "run-1");
      expect(plan.commands).toEqual([{ type: "place_part", partId: "run-1-x1", typeId: "t-fd", levelId: "L1", position: { x: 3000, y: 0 }, offsetMm: 3048, rotationDeg: 0 }]);
      expect(plan.placed.map((h) => h.hostId)).toEqual(["corridor"]);
      expect(plan.left.map((l) => [l.hit.hostId, l.why])).toEqual([["smoke", "There's no smoke damper type in this model yet: add one from the firm library (Parts), then Fix places it here"]]);
      expect(routeFinishWords(m.head, plan)).toMatch(/^Placed a fire damper at the .*\. On the Checklist \(Select \/ Fix\): Smoke barrier wall .*: a smoke damper goes here \(There's no smoke damper type/);
      for (const c of plan.commands) m.ok(c);
      const after = checkRouteLegs(m.head, segs).flatMap((l) => l.hits.map((h) => h.hostId));
      expect(after).toEqual(["smoke"]);
      // A retried Finish places the same part, not a second one.
      expect(routeFinishPlan(m.head, segs, "run-1").commands).toEqual([]);
    });
  });

  it("with no damper type in the model nothing is placed: the crossing stays for the Checklist, saying what to add", () => {
    withPackSet(M14_SET, () => {
      const m = ratedWalls("m14-none");
      const routed = m.ok(routeSupply("run-2"));
      const plan = routeFinishPlan(m.head, segmentIds(m.head, routed.elements.map((e) => e.id)), "run-2");
      expect(plan.commands).toEqual([]);
      expect(plan.left.map((l) => l.why)).toEqual([expect.stringMatching(/^There's no fire damper type in this model yet/), expect.stringMatching(/^There's no smoke damper type in this model yet/)]);
    });
  });

  it("an outside add-on's crossing rule places its own part at the crossing (zero kernel edits)", () => {
    const firestop: CrossingRule = {
      id: "zz.firestop_at_rated_wall",
      label: "Firestop at rated walls",
      form: "crossing",
      routes: ["run_segment"],
      appliesTo: (span) => span.serviceId === "domestic_cold_water",
      ratingKind: "fire_resistance",
      atLeast: Number.EPSILON,
      requires: { id: "zz.firestop", label: "firestop sleeve" },
      place: (model: ModelState) => (model.elements["t-zz"] ? { typeId: "t-zz", values: { "zz.sleeve": "listed" } } : { refused: "add a firestop sleeve type" }),
    };
    const zz = definePack({ id: "zz", name: "Outside firestops", version: "1.0.0", kernel: "^1.0.0" }, [contribute(ROUTE_CONSTRAINT_POINT, [firestop])]);
    withPackSet(PackSet.create([ARCHITECTURE_PACK, MECHANICAL_PACK, zz]), () => {
      // The sleeve type is not a damper (its kind is none of Mechanical's), so only the outside rule places it.
      const head = withDamperType(ratedWalls("m14-zz").head, "t-zz", "sleeve");
      const res = executeCommand(head, { type: "route_run", idPrefix: "p-1", levelId: "L1", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, elevationMm: 3048, system: { id: "dcw-1", kind: "domestic_cold_water" }, points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }] });
      if (!res.ok) throw new Error(res.error.message);
      const plan = routeFinishPlan(res.model, segmentIds(res.model, res.changedIds), "p-1");
      expect(plan.commands.map((c) => (c.type === "place_part" ? [c.typeId, c.position.x, c.values] : c.type))).toEqual([["t-zz", 3000, { "zz.sleeve": "listed" }]]);
    });
  });
});

/** The host's decide, as the session's `decideLikeServer` (every feature read). */
const decide = (model: ModelState, command: Command): ModelState | { refused: string } => {
  const res = executeCommand(model, command);
  return res.ok ? res.model : { refused: res.error.message };
};

describe("m14 damper cut into the run on Finish (routing:insert_part)", () => {
  it("cuts both dampers into one leg (the second worked out after the first cut), joined in-line, and the route plus both dampers is one edit: one undo removes all of it", () => {
    withPackSet(M14_SET, () => {
      const head = withDamperType(withDamperType(ratedWalls("m14-inline").head, "t-fd", "fire", inlineDamperType("fire")), "t-sd", "smoke", inlineDamperType("smoke"));
      const m = new Log(head);
      const route = routeSupply("run-3");
      const routed = executeCommand(m.head, route);
      if (!routed.ok) throw new Error(routed.error.message);
      const segs = segmentIds(routed.model, routed.changedIds);
      expect(segs).toHaveLength(1);
      const plan = routeFinishPlan(routed.model, segs, "run-3", { inline: decide });
      // Far end first: the smoke barrier at 5 m, then the 1-hour wall at 3 m on the piece the first cut left.
      expect(plan.cut.map((h) => h.hostId)).toEqual(["smoke", "corridor"]);
      expect(plan.onCentreLine).toEqual([]);
      expect(plan.commands.map((c) => c.type)).toEqual(["batch_edits", "batch_edits"]);
      expect(routeFinishWords(routed.model, plan)).toMatch(/^Placed a smoke damper at the .*, cut into the run; a fire damper at the .*, cut into the run\.$/);

      const batch = routeFinishBatch(route, plan, "Route and dampers");
      if (!batch) throw new Error("no batch");
      expect(batch.commands[0]).toEqual(route);
      const before = m.head.revision;
      const cs = m.ok(batch);
      expect(m.head.revision).toBe(before + 1);

      const parts = Object.values(m.head.elements).filter((e) => e.kind === "part");
      expect(parts.map((p) => [p.id, p.kind === "part" ? p.typeId : null]).sort()).toEqual([["run-3-x1-part", "t-sd"], ["run-3-x2-part", "t-fd"]]);
      const pieces = Object.values(m.head.elements).filter((e): e is RunSegment => e.kind === "run_segment").sort((a, b) => a.start.x - b.start.x);
      expect(pieces.map((s) => [Math.round(s.start.x), Math.round(s.end.x)])).toEqual([[0, 2850], [3150, 4850], [5150, 8000]]);
      // Each damper's connectors join the pieces either side (in-line, not sitting on the duct).
      expect(pieces.map((s) => [s.links.start?.elementId ?? null, s.links.end?.elementId ?? null])).toEqual([
        [null, "run-3-x2-part"],
        ["run-3-x2-part", "run-3-x1-part"],
        ["run-3-x1-part", null],
      ]);
      expect(checkRouteLegs(m.head, pieces.map((s) => s.id)).flatMap((l) => l.hits)).toEqual([]);

      m.ok({ type: "undo", revision: cs.revision });
      expect(Object.values(m.head.elements).filter((e) => e.kind === "part" || e.kind === "run_segment")).toEqual([]);
    });
  });

  it("a damper type with no in-line connectors keeps the centre-line placement, and the words say it wasn't cut in and why", () => {
    withPackSet(M14_SET, () => {
      const head = withDamperType(withDamperType(ratedWalls("m14-centre").head, "t-fd", "fire"), "t-sd", "smoke", inlineDamperType("smoke"));
      const route = routeSupply("run-4");
      const routed = executeCommand(head, route);
      if (!routed.ok) throw new Error(routed.error.message);
      const plan = routeFinishPlan(routed.model, segmentIds(routed.model, routed.changedIds), "run-4", { inline: decide });
      expect(plan.cut.map((h) => h.hostId)).toEqual(["smoke"]);
      expect(plan.onCentreLine.map((c) => [c.hit.hostId, c.why])).toEqual([["corridor", expect.stringMatching(/has no pair of connectors a run passes straight through/)]]);
      expect(plan.commands.map((c) => c.type)).toEqual(["batch_edits", "place_part"]);
      expect(routeFinishWords(routed.model, plan)).toMatch(/a fire damper at the .* on the run's centre line, not cut in \(The Damper fire damper has no pair of connectors/);
      const m = new Log(head);
      const batch = routeFinishBatch(route, plan);
      if (!batch) throw new Error("no batch");
      m.ok(batch);
      expect(Object.values(m.head.elements).filter((e) => e.kind === "part")).toHaveLength(2);
    });
  });

  it("without `inline` (a server that doesn't read routing:insert_part) Finish still places on the centre line, as round 14's first pass", () => {
    withPackSet(M14_SET, () => {
      const head = withDamperType(ratedWalls("m14-old-peer").head, "t-fd", "fire", inlineDamperType("fire"));
      const routed = executeCommand(head, routeSupply("run-5"));
      if (!routed.ok) throw new Error(routed.error.message);
      const plan = routeFinishPlan(routed.model, segmentIds(routed.model, routed.changedIds), "run-5");
      expect(plan.commands.map((c) => c.type)).toEqual(["place_part"]);
      expect(plan.cut).toEqual([]);
      expect(routeFinishBatch(routeSupply("run-5"), { ...plan, commands: [] })).toBeNull();
    });
  });
});
