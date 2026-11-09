/**
 * @jest-environment node
 *
 * Round 11 C11: a part that moves has named positions (the `positions` face).
 * A test door add-on registers a "swing" clearance purpose and a door type
 * with closed, open and travel positions; nothing in the kernel names a door.
 * In its open position the leaf's envelope clashes with a duct (the
 * clearance lint reports it, at the purpose row's severity, and the derived
 * zone exists); closed, it does not. A travel envelope is kept clear in any
 * position.
 *
 * Fails on round 10's code: a part type had no `positions` (the field was
 * stripped on place), purposes were a closed list (the swing purpose was
 * refused), and a placed part had no position.
 */
import { CLEARANCE_PURPOSE_POINT, builtinPartType, derivedZonesOfHost, type ClearancePurposeDef, type PartInstance, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "@permitzip/bim-kernel/packs";
import { config, engineFor, FT, IN, Model, SUPPLY } from "./fixtures";

const SWING: ClearancePurposeDef = { id: "c11door.swing", label: "Door swing", severity: "warning" };
const DOOR_PACK = definePack({ id: "c11door", name: "Doors (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(CLEARANCE_PURPOSE_POINT, [SWING])]);
const WITH_DOORS = PackSet.create([DOOR_PACK]);

/** A cabinet-sized box standing in for a door leaf in its frame (the starter panelboard), with three positions. */
function doorType(opts: { travel?: boolean } = {}): { id: string; definition: PartTypeDefinition } {
  const base = builtinPartType("builtin:panelboard-225@1");
  if (!base) throw new Error("starter library is missing the panelboard");
  const leaf = { purpose: "c11door.swing", face: "front" as const, depth: 3 * FT, height: 7 * FT };
  return {
    id: "c11door:single-3070",
    definition: {
      ...base.definition,
      typeName: "Single leaf 3'-0\" x 7'-0\"",
      positions: [
        { id: "closed", name: "Closed", role: "closed", envelopes: [] },
        { id: "open", name: "Open", role: "open", envelopes: [{ id: "leaf", name: "Leaf open", ...leaf }] },
        ...(opts.travel ? [{ id: "sweep", name: "Swing", role: "travel", envelopes: [{ id: "arc", name: "Swing arc", ...leaf, depth: 2 * FT }] }] : []),
      ],
    },
  };
}

function withDoor(position: "open" | "closed" | null, opts: { travel?: boolean } = {}): Model {
  const m = new Model();
  const t = doorType(opts);
  m.ok({ type: "place_part", partId: "door-1", typeId: t.id, partType: t.definition, levelId: "lvl-1", position: { x: 10 * FT, y: 10 * FT }, offsetMm: 0, mark: "D-1" });
  if (position !== null) {
    const placed = m.head.elements["door-1"];
    if (placed?.kind !== "part") throw new Error("door-1 was not placed");
    const next: PartInstance = { ...placed, positionId: position };
    m.put(next);
  }
  m.duct("sa", SUPPLY, [[11.5, 0], [11.5, 20]], 4, { shape: "rect", width: 12 * IN, height: 8 * IN });
  return m;
}

function swingFindings(m: Model) {
  return engineFor(m.head).check({ config: config({ ruleset: "issue" }) }).filter((f) => f.rule === "clearance-intrusion" && f.elementIds.includes("door-1"));
}

function swingRegions(m: Model) {
  const door = m.head.elements["door-1"];
  if (door?.kind !== "part") throw new Error("door-1 is not a part");
  return derivedZonesOfHost(m.head, door, "clearance:c11door.swing");
}

describe("c11 a door's swing clashes in its open position", () => {
  it("open: the duct is inside the leaf's envelope, reported at the swing purpose's severity", () => {
    withPackSet(WITH_DOORS, () => {
      const m = withDoor("open");
      const hits = swingFindings(m);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe("warning");
      expect(hits[0]?.message).toMatch(/into D-1's leaf open \(3'-0" front\)/);
      expect(swingRegions(m).map((r) => r.clearanceId)).toEqual(["open.leaf"]);
    });
  });

  it("closed: the same duct is clear, and no swing region is derived", () => {
    withPackSet(WITH_DOORS, () => {
      const m = withDoor("closed");
      expect(swingFindings(m)).toEqual([]);
      expect(swingRegions(m)).toEqual([]);
      // No position stored: the first listed (closed).
      expect(swingFindings(withDoor(null))).toEqual([]);
    });
  });

  it("a travel envelope is kept clear whatever position the door is in", () => {
    withPackSet(WITH_DOORS, () => {
      const m = withDoor("closed", { travel: true });
      expect(swingFindings(m).map((f) => f.message)).toEqual([expect.stringMatching(/into D-1's swing arc/)]);
      expect(swingRegions(m).map((r) => r.clearanceId)).toEqual(["sweep.arc"]);
    });
  });

  it("without the door add-on the type can't be written (its purpose is unknown)", () => {
    const m = new Model();
    const t = doorType();
    expect(m.try({ type: "place_part", partId: "door-1", typeId: t.id, partType: t.definition, levelId: "lvl-1", position: { x: 10 * FT, y: 10 * FT }, offsetMm: 0, mark: "D-1" })).toMatch(/c11door\.swing" comes from an add-on this model doesn't have/);
  });
});
