/**
 * @jest-environment node
 *
 * g8-fire-alarm-click: the test fire-alarm add-on (which the kernel knows
 * nothing about) accepts by plan click with zero kernel edits: a click inside
 * Room 104, a previewed space, takes its four detectors and places them as one
 * edit; a click in Room 101 takes nothing.
 *
 * Fails on round 7: there was no `ghostsAt`; and before this lane closed the
 * gap, `ghostsAt` read only room outlines, so a click on a previewed space
 * (the shape fire alarm and sprinklers propose for) took nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { acceptGhostsCommand, executeCommand, ghostsAt, runProposer, withUpgradePolicy } from "@permitzip/bim-kernel";
import { bindModelPacks, isPackRefusal, PackSet, withModelPacks } from "@permitzip/bim-kernel/packs";
import { floor } from "../../bim-kernel/__tests__/g7-fixtures";
import { FA_DETECTOR_TYPE, FA_PROPOSER_ID, FIRE_ALARM_TEST_PACK } from "./fixtures/fire-alarm";

const ID = "g8-fire-alarm";

beforeAll(() => bindModelPacks(ID, PackSet.create([FIRE_ALARM_TEST_PACK])));

describe("g8-fire-alarm-click", () => {
  it("a click inside a previewed space places its detectors as one edit", () => {
    const model = floor(ID);
    const answer = runProposer(model, FA_PROPOSER_ID, { typeId: FA_DETECTOR_TYPE, roomIds: ["S104"] });
    if (isPackRefusal(answer)) throw new Error(answer.refused);
    const taken = ghostsAt(model, FA_PROPOSER_ID, answer, { x: 14000, y: 4000 });
    expect(taken).toHaveLength(4);
    const command = withModelPacks(ID, () => acceptGhostsCommand(model, taken ?? [], { label: "Smoke detectors in Room 104", fallbackLevelId: "L1" }));
    if (typeof command === "string") throw new Error(command);
    const result = withUpgradePolicy(() => true, () => executeCommand(model, command));
    if (!result.ok) throw new Error(result.error.message);
    expect(Object.values(result.model.elements).filter((e) => e.kind === "part" && e.typeId === FA_DETECTOR_TYPE)).toHaveLength(4);
  });

  it("a click on a space that isn't previewed takes nothing", () => {
    const model = floor(ID);
    const answer = runProposer(model, FA_PROPOSER_ID, { typeId: FA_DETECTOR_TYPE, roomIds: ["S104"] });
    if (isPackRefusal(answer)) throw new Error(answer.refused);
    expect(ghostsAt(model, FA_PROPOSER_ID, answer, { x: 2000, y: 4000 })).toBeNull();
  });

  it("the add-on still imports only the kernel's public entry points", () => {
    const text = readFileSync(path.join(__dirname, "fixtures/fire-alarm/index.ts"), "utf8");
    const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(["@permitzip/bim-kernel", "@permitzip/bim-kernel/packs"]));
  });
});
