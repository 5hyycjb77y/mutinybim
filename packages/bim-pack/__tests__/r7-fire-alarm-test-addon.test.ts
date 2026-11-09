/**
 * @jest-environment node
 *
 * r7-fire-alarm-test-addon: a fire-alarm add-on nobody built into the kernel
 * proposes smoke detectors on typed ceilings from its own requirement, with
 * zero kernel edits. Each ghost names the requirement it fulfils; a room with
 * no ceiling that takes devices gets none, with a note; accepting is one edit.
 *
 * Fails on the code before step 7b: there is no proposer point.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { acceptGhostsCommand, executeCommand, runProposer, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { bindModelPacks, isPackRefusal, PackSet, withModelPacks } from "@permitzip/bim-kernel/packs";
import { floor } from "../../bim-kernel/__tests__/g7-fixtures";
import { FA_DETECTOR_TYPE, FA_PROPOSER_ID, FA_REQUIREMENT_KEY, FIRE_ALARM_TEST_PACK } from "./fixtures/fire-alarm";

const ID = "r7-fire-alarm";
const FT = 304.8;

beforeAll(() => bindModelPacks(ID, PackSet.create([FIRE_ALARM_TEST_PACK])));

function propose(model: ModelState, roomIds: readonly string[]) {
  const answer = runProposer(model, FA_PROPOSER_ID, { typeId: FA_DETECTOR_TYPE, roomIds });
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

describe("r7 fire-alarm test add-on: detectors on typed ceilings, zero kernel edits", () => {
  it("places the required number of detectors on Room 104's ceiling, each naming its requirement", () => {
    const answer = propose(floor(ID), ["S104"]);
    // 16 m² at one per 5 m².
    expect(answer.ghosts).toHaveLength(4);
    for (const g of answer.ghosts) {
      expect(g.hostId).toBe("CLG-104");
      expect(g.requirementId).toContain(`:${FA_REQUIREMENT_KEY}:S104`);
      expect(g.heightMm).toBeCloseTo(10 * FT, 6);
      expect(g.reason).toMatch(/Smoke detector coverage, at least 4 here/);
      expect(g.position.x).toBeGreaterThan(12000);
      expect(g.position.x).toBeLessThan(16000);
    }
    expect(answer.passes).toBe(true);
  });

  it("a room the rule doesn't reach, or with no ceiling, gets nothing and says why", () => {
    const answer = propose(floor(ID), ["S101"]);
    expect(answer.ghosts).toHaveLength(0);
    expect(answer.notes).toEqual(["S101: no detector requirement here"]);
  });

  it("accepting the ghosts is one edit that places parts of the engineer's type, nothing wired", () => {
    const model = floor(ID);
    const answer = propose(model, ["S104"]);
    const command = withModelPacks(ID, () => acceptGhostsCommand(model, answer.ghosts, { label: "Smoke detectors in Room 104", fallbackLevelId: "L1" }));
    if (typeof command === "string") throw new Error(command);
    expect(command.devices).toHaveLength(4);
    const result = withUpgradePolicy(() => true, () => executeCommand(model, command));
    if (!result.ok) throw new Error(result.error.message);
    const placed = Object.values(result.model.elements).filter((e) => e.kind === "part" && e.typeId === FA_DETECTOR_TYPE);
    expect(placed).toHaveLength(4);
    expect(placed.every((p) => p.kind === "part" && !p.links && !p.served)).toBe(true);
  });

  it("the add-on imports only the kernel's public entry points", () => {
    const text = readFileSync(path.join(__dirname, "fixtures/fire-alarm/index.ts"), "utf8");
    const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(["@permitzip/bim-kernel", "@permitzip/bim-kernel/packs"]));
  });
});
