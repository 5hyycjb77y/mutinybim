/**
 * @jest-environment node
 *
 * g8-click-accepts (electrical): while receptacles preview for two bedrooms,
 * a plan click inside one places exactly that room's proposed receptacles as
 * one edit, and one undo takes them all out; a click in a room that isn't
 * previewed takes nothing, so the plan selects as before.
 *
 * Fails on round 7: there was no `ghostsAt`, and the accept command lived in
 * the kernel as `acceptProposalCommand`.
 */
import { acceptGhostsCommand, elementsOfKind, ghostsAt, runProposer, unit001Architecture, withUpgradePolicy, type GhostPlacement, type ModelState, type Vec2 } from "@permitzip/bim-kernel";
import { bindModelPacks, isPackRefusal, PackSet, withModelPacks } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_PACK, RECEPTACLE_PROPOSER_ID } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const OPTIONS = { mode: "dwelling", edition: "2023", countertopTypeId: "builtin:countertop-receptacle@1", bathroomTypeId: "builtin:gfci-receptacle@1" };
const DUPLEX = "builtin:duplex-receptacle@1";

function twoUnits(): Building {
  const b = new Building();
  bindModelPacks(b.head.modelId, PackSet.create([ELECTRICAL_PACK]));
  b.ok(unit001Architecture("lvl-1", "u0", { x: 0, y: 0 }));
  b.ok(unit001Architecture("lvl-1", "u1", { x: 30, y: 0 }));
  return b;
}

function centreOf(model: ModelState, roomId: string): Vec2 {
  const el = model.elements[roomId];
  if (el?.kind !== "room") throw new Error(`${roomId} is not a room`);
  const n = el.outline.length;
  return { x: el.outline.reduce((s, p) => s + p.x, 0) / n, y: el.outline.reduce((s, p) => s + p.y, 0) / n };
}

function preview(model: ModelState, roomIds: readonly string[]) {
  const answer = runProposer(model, RECEPTACLE_PROPOSER_ID, { typeId: DUPLEX, roomIds, options: OPTIONS });
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

const receptacles = (m: ModelState) => elementsOfKind(m.elements, "part").filter((p) => p.typeId.includes("receptacle"));

describe("g8-click-accepts (electrical)", () => {
  it("a click in a previewed bedroom places its receptacles as one edit; one undo removes them", () => {
    const b = twoUnits();
    const answer = preview(b.head, ["u0-bed", "u1-bed"]);
    const taken: readonly GhostPlacement[] | null = ghostsAt(b.head, RECEPTACLE_PROPOSER_ID, answer, centreOf(b.head, "u1-bed"));
    const mine = answer.ghosts.filter((g) => g.roomId === "u1-bed");
    expect(mine.length).toBeGreaterThan(0);
    expect(taken?.map((g) => g.key)).toEqual(mine.map((g) => g.key));

    const command = withModelPacks(b.head.modelId, () => acceptGhostsCommand(b.head, taken ?? [], { label: "Receptacles in Bedroom", fallbackLevelId: "lvl-1" }));
    if (typeof command === "string") throw new Error(command);
    const revisionBefore = b.head.revision;
    const cs = withUpgradePolicy(() => true, () => b.ok(command));
    expect(b.head.revision).toBe(revisionBefore + 1);
    expect(receptacles(b.head)).toHaveLength(mine.length);

    withUpgradePolicy(() => true, () => b.ok({ type: "undo", revision: cs.revision }));
    expect(receptacles(b.head)).toHaveLength(0);
  });

  it("a click in a room that isn't previewed takes nothing (the plan selects as before)", () => {
    const b = twoUnits();
    const answer = preview(b.head, ["u0-bed"]);
    expect(ghostsAt(b.head, RECEPTACLE_PROPOSER_ID, answer, centreOf(b.head, "u0-kitchen"))).toBeNull();
    expect(ghostsAt(b.head, RECEPTACLE_PROPOSER_ID, answer, centreOf(b.head, "u1-bed"))).toBeNull();
  });
});
