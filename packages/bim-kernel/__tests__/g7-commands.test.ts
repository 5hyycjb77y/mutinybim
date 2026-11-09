/**
 * @jest-environment node
 *
 * Round 7 lane G: the graph commands through the commit path every host
 * uses. A determination is recorded and superseded (the old one kept,
 * marked superseded); a requirement is verified, overridden and withdrawn,
 * override and withdraw refuse without a reason, in plain words; each edit
 * is one undo step.
 *
 * Fails on the code before round 7: none of these commands existed.
 */
import { applyChangeset, canonicalJson, commandSchema, planCommit, requirementById, requirementsAt, unbindRequirementsSnapshot, withUpgradePolicy, type Changeset, type ModelState } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, ZT_PACK } from "./g7-fixtures";

const ID = "g7-commands";
const NOW = () => "2026-10-30T18:00:00.000Z";

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

function session(start: ModelState) {
  let head = start;
  const log: Changeset[] = [];
  let seq = 0;
  const submit = (command: unknown): { ok: true } | { ok: false; message: string } => {
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "unparsed" };
    const d = withUpgradePolicy(
      () => true,
      () => planCommit(head, [], { idempotencyKey: `g7c-${++seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: parsed.data }, NOW, log),
    );
    if (!d.ok) return { ok: false, message: d.error.message };
    expect(canonicalJson(applyChangeset(head, d.changeset))).toBe(canonicalJson(d.model));
    head = d.model;
    log.push(d.changeset);
    return { ok: true };
  };
  return { submit, head: () => head, lastRevision: () => log[log.length - 1]?.revision ?? 0 };
}

const decide = { reasoning: "Synthetic test decision.", decidedBy: "K. Example", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high" as const };
const EXITS_101 = "zt.code_study:exits:arch.exit_count:S101";

describe("g7 graph commands", () => {
  it("records and supersedes a determination as one undo step each; the old decision is kept", () => {
    const s = session(floor(ID));
    // Labels compared for equality evaluate as text, not as a number in unit "1".
    expect(requirementsAt(s.head(), { kind: "space", id: "S104" }).find((r) => r.key === "arch.finish_class")).toMatchObject({ value: "A" });
    expect(s.submit({ type: "record_determination", determinationId: "D-occ-S100", subject: { kind: "space", id: "S100" }, key: "occupancy", value: "B", ...decide })).toEqual({ ok: true });
    expect(s.head().elements["D-occ-S100"]).toMatchObject({ kind: "determination", determination: { key: "occupancy", value: "B", status: "recorded" } });

    expect(s.submit({ type: "supersede_determination", determinationId: "D-haz-S104", newDeterminationId: "D-haz-S104-b", value: "light", ...decide })).toEqual({ ok: true });
    expect(s.head().elements["D-haz-S104"]).toMatchObject({ determination: { status: "superseded", value: "ordinary_1" } });
    expect(s.head().elements["D-haz-S104-b"]).toMatchObject({ determination: { status: "recorded", value: "light", supersedes: "D-haz-S104" } });
    const hazard = requirementsAt(s.head(), { kind: "space", id: "S104" }).find((r) => r.key === "fp.hazard_class");
    expect({ value: hazard?.value, problem: hazard?.problem }).toEqual({ value: "light", problem: undefined });

    expect(s.submit({ type: "undo", revision: s.lastRevision() })).toEqual({ ok: true });
    expect(s.head().elements["D-haz-S104-b"]).toBeUndefined();
    expect(s.head().elements["D-haz-S104"]).toMatchObject({ determination: { status: "recorded" } });
    expect(requirementsAt(s.head(), { kind: "space", id: "S104" }).find((r) => r.key === "fp.hazard_class")?.value).toBe("ordinary_1");
  });

  it("refuses in plain words: a subject that isn't there, a decision already replaced", () => {
    const s = session(floor(ID));
    const missing = s.submit({ type: "record_determination", determinationId: "D-x", subject: { kind: "space", id: "S999" }, key: "occupancy", value: "B", ...decide });
    expect(missing).toEqual({ ok: false, message: "There is no space S999 to record a determination on" });
    s.submit({ type: "supersede_determination", determinationId: "D-occ-S101", newDeterminationId: "D-occ-S101-b", value: "A-3", ...decide });
    const again = s.submit({ type: "supersede_determination", determinationId: "D-occ-S101", newDeterminationId: "D-occ-S101-c", value: "B", ...decide });
    expect(again).toEqual({ ok: false, message: "D-occ-S101 was already replaced; supersede the one in force instead" });
  });

  it("verifies, overrides with a reason and withdraws with a reason; each undoes; no reason is refused", () => {
    const s = session(floor(ID));
    expect(requirementById(s.head(), EXITS_101)).toMatchObject({ value: 1, status: "proposed" });

    expect(s.submit({ type: "set_requirement_state", requirementId: EXITS_101, status: "verified", by: "K. Example" })).toEqual({ ok: true });
    expect(requirementById(s.head(), EXITS_101)).toMatchObject({ status: "verified", value: 1 });

    const noReason = s.submit({ type: "set_requirement_state", requirementId: EXITS_101, status: "overridden", value: 2, by: "K. Example" });
    expect(noReason).toEqual({ ok: false, message: "Say why you override Exit count: a reason is required" });
    const blank = s.submit({ type: "set_requirement_state", requirementId: EXITS_101, status: "withdrawn", reason: "  ", by: "K. Example" });
    expect(blank).toEqual({ ok: false, message: "Say why you withdraw Exit count: a reason is required" });

    expect(s.submit({ type: "set_requirement_state", requirementId: EXITS_101, status: "overridden", value: 2, reason: "Owner wants a second door.", by: "K. Example" })).toEqual({ ok: true });
    expect(requirementById(s.head(), EXITS_101)).toMatchObject({ status: "overridden", value: 2, derivedValue: 1, stateReason: "Owner wants a second door." });

    expect(s.submit({ type: "set_requirement_state", requirementId: EXITS_101, status: "withdrawn", reason: "Room becomes part of the corridor.", by: "K. Example" })).toEqual({ ok: true });
    expect(requirementById(s.head(), EXITS_101)).toMatchObject({ status: "withdrawn", stateReason: "Room becomes part of the corridor." });

    expect(s.submit({ type: "undo", revision: s.lastRevision() })).toEqual({ ok: true });
    expect(requirementById(s.head(), EXITS_101)).toMatchObject({ status: "overridden", value: 2 });

    expect(s.submit({ type: "set_requirement_state", requirementId: EXITS_101, status: "proposed", by: "K. Example" })).toEqual({ ok: true });
    expect(requirementById(s.head(), EXITS_101)).toMatchObject({ status: "proposed", value: 1 });
  });
});
