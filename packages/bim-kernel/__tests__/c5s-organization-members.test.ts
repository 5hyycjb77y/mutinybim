/**
 * @jest-environment node
 *
 * Round 5c f-scale (round 3): the group and phase commands read who names a
 * group or phase from an index carried across revisions
 * (`organization/members.ts`), not from a pass over the model. Over random
 * sequences of group and phase edits, deleting a group without a target,
 * deleting a phase and reordering phases refuse with exactly the counts and
 * elements a brute-force read of the same head gives, and the index answer is
 * read with no pass over the model once carried.
 *
 * Fails on the old code by the pass count: each of those commands walked
 * every element (`elementValues`).
 */
import * as store from "../src/store";
import { planCommit, type BimElement, type Command, type CommandRequest, type ElementId, type ModelState } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { DEFAULT_PHASE_ID, isOrganized } from "../src/organization/model";
import { organizationMembersOf } from "../src/organization/members";

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

function commit(head: ModelState, command: Command) {
  seq += 1;
  const req: CommandRequest = { idempotencyKey: `c5s-org-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command };
  return planCommit(head, [], req, NOW);
}

function ok(head: ModelState, command: Command): ModelState {
  const d = commit(head, command);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const GROUPS = ["grp-a", "grp-b"];
const PHASES = ["ph-1", "ph-2"];

function start(): ModelState {
  let m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-org" });
  m = { ...m, elements: store.freezeElements(m.elements) };
  m = ok(m, { type: "create_group", groupId: "grp-a", name: "Group A" });
  m = ok(m, { type: "create_group", groupId: "grp-b", name: "Group B" });
  m = ok(m, { type: "create_phase", phaseId: "ph-1", name: "Phase 1" });
  m = ok(m, { type: "create_phase", phaseId: "ph-2", name: "Phase 2" });
  return m;
}

function organizedIds(m: ModelState): ElementId[] {
  return store.elementValues(m.elements).filter((e) => isOrganized(e) && !("deleted" in e && e.deleted)).map((e) => e.id);
}

const groupMembers = (m: ModelState, g: string): BimElement[] => store.elementValues(m.elements).filter((e) => isOrganized(e) && !("deleted" in e && e.deleted) && e.groupId === g);
const phaseUsers = (m: ModelState, p: string): number => store.elementValues(m.elements).filter((e) => isOrganized(e) && ((e.phaseCreated ?? DEFAULT_PHASE_ID) === p || e.phaseDemolished === p)).length;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

describe("c5s group and phase members carried", () => {
  it("delete group, delete phase and reorder refuse with brute-force counts over random edits", () => {
    for (const seed of [6, 60]) {
      const r = rng(seed);
      let m = start();
      organizationMembersOf(m.elements);
      let checks = 0;
      for (let step = 0; step < 24; step++) {
        const ids = organizedIds(m);
        const some = ids.filter(() => r() < 0.08).slice(0, 40);
        if (some.length === 0) continue;
        const roll = r();
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
        const command: Command =
          roll < 0.4
            ? { type: "assign_elements_to_group", ids: some, groupId: pick(GROUPS) }
            : roll < 0.7
              ? { type: "set_element_phases", ids: some, phaseCreated: pick([...PHASES, DEFAULT_PHASE_ID]) }
              : roll < 0.85
                ? { type: "demolish_elements", ids: some, phaseId: pick(PHASES) }
                : { type: "undemolish_elements", ids: some };
        const d = commit(m, command);
        if (!d.ok) continue;
        m = d.model;

        elementValuesSpy.mockClear();
        for (const g of GROUPS) {
          const res = commit(m, { type: "delete_group", groupId: g });
          const expected = groupMembers(m, g);
          if (expected.length === 0) expect(res.ok).toBe(true);
          else {
            if (res.ok) throw new Error(`delete_group ${g} should have refused`);
            expect(res.error.message).toContain(`${plural(expected.length, "element")} ${expected.length === 1 ? "is" : "are"} in`);
            expect(res.error.elementIds).toEqual(expected.slice(0, 50).map((e) => e.id));
          }
        }
        for (const p of PHASES) {
          const res = commit(m, { type: "delete_phase", phaseId: p });
          const used = phaseUsers(m, p);
          if (used > 0) {
            if (res.ok) throw new Error(`delete_phase ${p} should have refused`);
            expect(res.error.message).toContain(`${plural(used, "element")} ${used === 1 ? "is" : "are"} created or demolished in`);
          }
        }
        const reorder = commit(m, { type: "update_phase", phaseId: "ph-2", after: null });
        const demolishedBeforeCreated = store.elementValues(m.elements).filter((e) => isOrganized(e) && e.phaseDemolished === "ph-1" && e.phaseCreated === "ph-2");
        if (demolishedBeforeCreated.length > 0) {
          if (reorder.ok) throw new Error("the reorder should have refused");
          expect(reorder.error.message).toContain(plural(demolishedBeforeCreated.length, "element"));
          expect(reorder.error.elementIds).toEqual([demolishedBeforeCreated[0]?.id]);
        }
        checks += 1;
      }
      expect(checks).toBeGreaterThan(10);
    }
  });

  it("a carried head answers the group and phase commands with no pass over the model", () => {
    let m = start();
    organizationMembersOf(m.elements);
    const some = organizedIds(m).slice(0, 5);
    m = ok(m, { type: "assign_elements_to_group", ids: some, groupId: "grp-a" });
    m = ok(m, { type: "demolish_elements", ids: some.slice(0, 2), phaseId: "ph-1" });
    elementValuesSpy.mockClear();
    const members = organizationMembersOf(m.elements);
    expect([...(members.byGroup.get("grp-a") ?? [])].sort()).toEqual([...some].sort());
    expect(members.demolishedIn.get("ph-1")).toBe(2);
    expect(elementValuesSpy).not.toHaveBeenCalled();
  });
});
