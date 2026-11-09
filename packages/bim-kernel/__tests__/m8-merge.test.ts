/**
 * @jest-environment node
 *
 * Round 8 step 8b, lane M: merging a branch back to Main with each
 * responsible professional's approval. Round 8 had no three-way merge, no
 * dependency check for partial merges and no approval evaluation, so every
 * case here fails on round 8's code (the modules don't exist there).
 */
import { asElementId, type BimElement, type Connection, type ElementId } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { coveringResponsibilities, type CoverageContext, type Responsibility } from "../src/responsibility/types";
import { approvalEvaluator, partsForApprover, type ApprovalInputs, type MergeApprovalRecord } from "../src/responsibility/approvals";
import { landMergePart, mergeParts, partDeltaDigest, threeWayMerge } from "../src/branches/merge";
import { mergeDependencies, planLanding, recordRefs } from "../src/branches/merge-deps";
import type { ElementAt, MergePart } from "../src/branches/merge-types";

const id = asElementId;

function el(eid: string, discipline: string, extra: Record<string, unknown> = {}, version = 1): BimElement {
  // Minimal records: merge reads id, kind, partition, references and content.
  return { id: eid, kind: "part", version, authoredRev: {}, partition: { level: "L1", zone: "Z1", discipline }, typeId: "pt", values: {}, ...extra } as unknown as BimElement;
}

function at(records: Record<string, BimElement | null>): ElementAt {
  return (eid) => (eid in records ? (records[eid] ?? null) : null);
}

const ctx: CoverageContext = {
  disciplineOf: (e) => e.partition?.discipline ?? "general",
  classOf: () => undefined,
  isA: (c, a) => c === a,
  systemsOf: (e) => {
    const s: unknown = Reflect.get(e, "system");
    return typeof s === "string" ? [s] : [];
  },
  groupsOf: () => [],
  sheetsOf: () => [],
  matches: () => true,
};

const ACCEPTED = "2026-11-01T05:00:00Z";
const person = (rid: string, ref: string, label: string, discipline: string, extra: Partial<Responsibility> = {}): Responsibility => ({
  id: rid,
  party: { kind: "person", ref, label },
  discipline,
  acceptedAt: ACCEPTED,
  ...extra,
});

const rao = person("r-a", "u-rao", "J. Rao", "discipline_a");
const example = person("r-b", "u-example", "K. Example", "discipline_b");

function approve(r: Responsibility | null, ref: string, seen: number, decision: "approved" | "declined" = "approved", decidedAt = "2026-11-01T06:00:00Z"): MergeApprovalRecord {
  return { responsibilityId: r?.id ?? null, approverRef: ref, approverLabel: ref, decision, seenBranchHead: seen, decidedAt };
}

function inputs(responsibilities: Responsibility[], approvals: MergeApprovalRecord[], extra: Partial<ApprovalInputs> = {}): ApprovalInputs {
  return { responsibilities, approvals, leads: [], ruleFor: () => "each", changedSince: () => new Set(), ...extra };
}

const label = (d: string) => (d === "discipline_a" ? "Discipline A" : d === "discipline_b" ? "Discipline B" : d);
const words = { label, name: (eid: ElementId) => eid };

function plan(changed: BimElement[], responsibilities: Responsibility[], approvals: MergeApprovalRecord[], extra: Partial<ApprovalInputs> = {}, connectionsOf: (eid: ElementId) => readonly Connection[] = () => []) {
  const parts = mergeParts(coveringResponsibilities(changed, responsibilities, ctx));
  const evaluator = approvalEvaluator(parts, inputs(responsibilities, approvals, extra));
  const deps = mergeDependencies(new Map(changed.map((c) => [c.id, c])), { connectionsOf });
  return { parts, evaluator, landing: planLanding(parts, evaluator.gate, deps, [], words) };
}

describe("m8 merge", () => {
  it("m8-three-way-merge: different elements merge, the same element changed differently is a listed conflict, the same change on both sides is none", () => {
    const base = at({ x: el("x", "discipline_a"), y: el("y", "discipline_a"), z: el("z", "discipline_a") });
    const main = at({ x: el("x", "discipline_a", { mark: "Main X" }, 2), y: el("y", "discipline_a", { mark: "Same" }, 2), z: el("z", "discipline_a") });
    const branch = at({ x: el("x", "discipline_a", { mark: "Branch X" }, 2), y: el("y", "discipline_a", { mark: "Same" }, 3), z: el("z", "discipline_a", { mark: "Only branch" }, 2) });
    const out = threeWayMerge(base, main, branch, [id("x"), id("y"), id("z")], [id("x"), id("y")]);
    expect(out.writes.map((w) => w.elementId)).toEqual(["z"]);
    expect(out.alreadyOnMain).toEqual(["y"]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.elementId).toBe("x");
    expect(out.conflicts[0]?.words).toMatch(/^Main and this branch both changed Branch X, differently/);

    // A removal on one side against a change on the other is a conflict too, in words.
    const removed = threeWayMerge(base, at({ x: null }), branch, [id("x")], [id("x")]);
    expect(removed.conflicts[0]?.words).toMatch(/was removed on Main after this branch started/);

    // Connections: both sides connecting the same end to different things conflicts.
    const ca: Connection = { id: "c1" as Connection["id"], a: { elementId: id("z"), end: "start" }, b: { elementId: id("y"), end: "end" } };
    const cb: Connection = { id: "c2" as Connection["id"], a: { elementId: id("z"), end: "start" }, b: { elementId: id("x"), end: "end" } };
    const conn = threeWayMerge(base, main, branch, [id("z")], [], { branch: { added: [ca], removed: [] }, main: { added: [cb], removed: [] } });
    expect(conn.addConnections).toEqual([]);
    expect(conn.conflicts.map((c) => c.elementId)).toEqual(["z"]);
  });

  it("m8-discipline-approval: A approved, B not: only A's part lands, and B's says who it waits for", () => {
    const changed = [el("a1", "discipline_a"), el("b1", "discipline_b")];
    const { landing } = plan(changed, [rao, example], [approve(rao, "u-rao", 5)]);
    expect(landing.landingElementIds).toEqual(["a1"]);
    const b = landing.verdicts.find((v) => v.part.discipline === "discipline_b");
    expect(b?.lands).toBe(false);
    expect(b?.words).toBe("Discipline B is waiting for approval from K. Example.");
  });

  it("m8-partial-blocked: an approved part hosted on an unapproved change can't land alone, and says why", () => {
    const host = el("beam-1", "discipline_b");
    const hosted = el("hanger-1", "discipline_a", { host: { kind: "element", elementId: "beam-1", stationMm: 100 } });
    expect(recordRefs(hosted)).toEqual(["beam-1"]);
    const { landing } = plan([host, hosted], [rao, example], [approve(rao, "u-rao", 5)]);
    expect(landing.landingElementIds).toEqual([]);
    const a = landing.verdicts.find((v) => v.part.discipline === "discipline_a");
    expect(a?.waits[0]).toEqual({ kind: "depends_on", discipline: "discipline_b", elementId: "hanger-1", on: "beam-1" });
    expect(a?.words).toBe("Discipline A can't land alone: hanger-1 depends on beam-1 in Discipline B, which is still waiting.");

    // Once B approves too, both land.
    const both = plan([host, hosted], [rao, example], [approve(rao, "u-rao", 5), approve(example, "u-example", 5)]);
    expect([...both.landing.landingElementIds].sort()).toEqual(["beam-1", "hanger-1"]);

    // A new connection between two parts binds both ways.
    const c: Connection = { id: "c9" as Connection["id"], a: { elementId: id("a1"), end: "start" }, b: { elementId: id("b1"), end: "end" } };
    const linked = plan([el("a1", "discipline_a"), el("b1", "discipline_b")], [rao, example], [approve(rao, "u-rao", 5)], {}, (eid) => (eid === "a1" || eid === "b1" ? [c] : []));
    expect(linked.landing.landingElementIds).toEqual([]);
  });

  it("m8-two-mechanical-pes (merge): two people on one discipline each approve only their systems; each part lands on its own approval", () => {
    const a = person("r-a1", "u1", "J. Rao", "discipline_a", { scope: { systems: ["sys-1"] } });
    const b = person("r-a2", "u2", "M. Lee", "discipline_a", { scope: { systems: ["sys-2"] } });
    const changed = [el("p1", "discipline_a", { system: "sys-1" }), el("p2", "discipline_a", { system: "sys-2" })];
    const { landing, parts } = plan(changed, [a, b], [approve(a, "u1", 3)]);
    expect(parts).toHaveLength(2);
    expect(landing.landingElementIds).toEqual(["p1"]);
  });

  it("m8-any-one-of (merge): under the firm's any-one rule one covering approval lands the part", () => {
    const a = person("r-a1", "u1", "J. Rao", "discipline_a");
    const b = person("r-a2", "u2", "M. Lee", "discipline_a");
    const each = plan([el("p1", "discipline_a")], [a, b], [approve(b, "u2", 3)]);
    expect(each.landing.landingElementIds).toEqual([]);
    expect(each.landing.verdicts[0]?.words).toBe("Discipline A is waiting for approval from J. Rao.");
    const anyOne = plan([el("p1", "discipline_a")], [a, b], [approve(b, "u2", 3)], { ruleFor: () => "any_one" });
    expect(anyOne.landing.landingElementIds).toEqual(["p1"]);
  });

  it("m8-uncovered-falls-to-default (merge): a change no scoped row covers is approved by the discipline's unscoped row", () => {
    const scoped = person("r-s", "u1", "J. Rao", "discipline_a", { scope: { systems: ["sys-1"] } });
    const fallback = person("r-d", "u9", "D. Default", "discipline_a");
    const { landing } = plan([el("p9", "discipline_a", { system: "sys-z" })], [scoped, fallback], [approve(fallback, "u9", 3)]);
    expect(landing.landingElementIds).toEqual(["p9"]);
  });

  it("m8-uncovered-falls-to-project-lead: no one named: the project lead approves the part", () => {
    const leads = [{ ref: "u-lead", label: "R. Doe" }];
    const waiting = plan([el("e1", "discipline_c")], [rao], [], { leads });
    expect(waiting.evaluator.approversOf(waiting.parts[0] as MergePart)).toEqual([{ responsibilityId: null, label: "R. Doe (project lead)", state: "waiting", group: "lead", rule: "any_one" }]);
    const landed = plan([el("e1", "discipline_c")], [rao], [approve(null, "u-lead", 3)], { leads });
    expect(landed.landing.landingElementIds).toEqual(["e1"]);
    // Someone who is not the lead approving "as the lead" counts for nothing.
    const forged = plan([el("e1", "discipline_c")], [rao], [approve(null, "u-rao", 3)], { leads });
    expect(forged.landing.landingElementIds).toEqual([]);
  });

  it("m8-no-lead-waits: uncovered parts with no project lead wait and say how to fix it; covered parts still land", () => {
    const { landing } = plan([el("a1", "discipline_a"), el("e1", "discipline_c")], [rao], [approve(rao, "u-rao", 3)]);
    expect(landing.landingElementIds).toEqual(["a1"]);
    const e = landing.verdicts.find((v) => v.part.discipline === "discipline_c");
    expect(e?.words).toBe("discipline_c waits: no one is named for it and no project lead is named. Name one in Manage › Responsibilities.");
  });

  it("m8-unaccepted-cannot-approve: a named person who hasn't accepted covers nothing, so their approval doesn't count", () => {
    const { acceptedAt: _a, ...notYet } = rao;
    const { landing } = plan([el("a1", "discipline_a")], [notYet], [approve(notYet, "u-rao", 3)]);
    expect(landing.landingElementIds).toEqual([]);
    // A firm row only suggests: it never approves.
    const firm: Responsibility = { id: "r-f", party: { kind: "firm", ref: "org-1", label: "Acme" }, discipline: "discipline_a", acceptedAt: ACCEPTED };
    const viaFirm = plan([el("a1", "discipline_a")], [firm], [approve(firm, "org-1", 3)]);
    expect(viaFirm.landing.landingElementIds).toEqual([]);
  });

  it("m8-reapproval-inside-scope-only: a later change inside A's part asks A again; B's approval stands", () => {
    const changed = [el("a1", "discipline_a"), el("b1", "discipline_b")];
    const approvals = [approve(rao, "u-rao", 5), approve(example, "u-example", 5)];
    const changedSince = (rev: number) => new Set<ElementId>(rev < 7 ? [id("a1")] : []);
    const { landing, evaluator, parts } = plan(changed, [rao, example], approvals, { changedSince });
    expect(landing.landingElementIds).toEqual(["b1"]);
    const a = parts.find((p) => p.discipline === "discipline_a") as MergePart;
    expect(evaluator.approversOf(a)[0]?.state).toBe("stale");
    // A declined part waits; the latest word wins.
    const declined = plan(changed, [rao, example], [approve(rao, "u-rao", 5), approve(rao, "u-rao", 5, "declined", "2026-11-01T07:00:00Z"), approve(example, "u-example", 5)]);
    expect(declined.landing.landingElementIds).toEqual(["b1"]);
  });

  it("m8-firm-several-approvers: a firm entry with three people: each needs all three, any one lands on the first", () => {
    const firmPeople = (rule: "each" | "any_one") =>
      ["u1", "u2", "u3"].map((ref, i) => person(`r-f${i}`, ref, `Firm person ${i + 1}`, "discipline_a", { approval: { group: "firm-entry-1", rule } }))
    const changed = [el("a1", "discipline_a")]
    const each = firmPeople("each")
    const one = plan(changed, each, [approve(each[0] ?? null, "u1", 3)])
    expect(one.landing.landingElementIds).toEqual([])
    expect(one.landing.verdicts[0]?.words).toBe("Discipline A is waiting for approval from Firm person 2, Firm person 3.")
    const all = plan(changed, each, each.map((r, i) => approve(r, `u${i + 1}`, 3)))
    expect(all.landing.landingElementIds).toEqual(["a1"])
    const anyOne = firmPeople("any_one")
    const first = plan(changed, anyOne, [approve(anyOne[0] ?? null, "u1", 3)])
    expect(first.landing.landingElementIds).toEqual(["a1"])
    const none = plan(changed, anyOne, [])
    expect(none.landing.verdicts[0]?.words).toBe("Discipline A is waiting for approval from any one of Firm person 1, Firm person 2, Firm person 3.")
  })

  it("m8-digest-reapproval: an edit inside the part changes its digest and voids that approval; an edit elsewhere keeps it", () => {
    const a1 = el("a1", "discipline_a")
    const b1 = el("b1", "discipline_b")
    const records = new Map<string, BimElement>([["a1", a1], ["b1", b1]])
    const recordOf = (eid: ElementId) => records.get(eid) ?? null
    const parts = mergeParts(coveringResponsibilities([a1, b1], [rao, example], ctx))
    const partA = parts.find((p) => p.discipline === "discipline_a") as MergePart
    const partB = parts.find((p) => p.discipline === "discipline_b") as MergePart
    const digestA = partDeltaDigest(partA, 10, recordOf)
    const digestB = partDeltaDigest(partB, 10, recordOf)
    const approvals: MergeApprovalRecord[] = [
      { ...approve(rao, "u-rao", 12), deltaDigest: digestA },
      { ...approve(example, "u-example", 12), deltaDigest: digestB },
    ]
    const run = () =>
      planLanding(parts, approvalEvaluator(parts, inputs([rao, example], approvals, { digestOf: (p) => partDeltaDigest(p, 10, recordOf) })).gate, new Map(), [], words).landingElementIds
    expect([...run()].sort()).toEqual(["a1", "b1"])
    // Someone edits b1 on the branch: B's digest changes, A's doesn't.
    records.set("b1", el("b1", "discipline_b", { mark: "moved" }, 2))
    expect(partDeltaDigest(partA, 10, recordOf)).toBe(digestA)
    expect(partDeltaDigest(partB, 10, recordOf)).not.toBe(digestB)
    expect(run()).toEqual(["a1"])
    const evaluator = approvalEvaluator(parts, inputs([rao, example], approvals, { digestOf: (p) => partDeltaDigest(p, 10, recordOf) }))
    expect(evaluator.approversOf(partB)[0]?.state).toBe("stale")
  })

  it("m8-merges-waiting-scope-first: an approver sees their own parts first", () => {
    const parts = mergeParts(coveringResponsibilities([el("a1", "discipline_a"), el("b1", "discipline_b")], [rao, example], ctx));
    const split = partsForApprover(parts, [rao, example], "u-example", false);
    expect(split.mine.map((p) => p.discipline)).toEqual(["discipline_b"]);
    expect(split.rest.map((p) => p.discipline)).toEqual(["discipline_a"]);
  });

  it("m8-merge-is-not-change-order: a landed part is one ordinary revision on Main with no cost and no change order", () => {
    const main = createDemoModel("m8-main");
    const target = Object.values(main.elements).find((e) => e.kind === "equipment");
    expect(target).toBeDefined();
    if (!target) return;
    const record = { ...target, mark: "RTU-1B" } as BimElement;
    const out = landMergePart(main, [{ elementId: target.id, record }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changedIds).toContain(target.id);
    expect(out.readSet[target.id]).toBe(target.version);
    const text = JSON.stringify(out).toLowerCase();
    expect(text).not.toMatch(/change_order|changeorder|"cost|price/);
  });

  it("m8-merge-perf (flag M8_PERF=1): 2,000 changed records merge and plan under the round's budgets", () => {
    if (process.env.M8_PERF !== "1") return;
    const n = 2000;
    const base: Record<string, BimElement | null> = {};
    const main: Record<string, BimElement | null> = {};
    const branch: Record<string, BimElement | null> = {};
    const ids: ElementId[] = [];
    for (let i = 0; i < n; i++) {
      const eid = `e${i}`;
      ids.push(id(eid));
      base[eid] = el(eid, i % 2 ? "discipline_a" : "discipline_b");
      main[eid] = i % 10 === 0 ? el(eid, i % 2 ? "discipline_a" : "discipline_b", { mark: `m${i}` }, 2) : base[eid] ?? null;
      branch[eid] = el(eid, i % 2 ? "discipline_a" : "discipline_b", { mark: `b${i}`, host: i > 0 ? { kind: "element", elementId: `e${i - 1}`, stationMm: 1 } : undefined }, 2);
    }
    const t0 = performance.now();
    const merged = threeWayMerge(at(base), at(main), at(branch), ids, ids.filter((_, i) => i % 10 === 0));
    const t1 = performance.now();
    const records = merged.writes.flatMap((w) => (w.record ? [w.record] : []));
    const cover = coveringResponsibilities(records, [rao, example], ctx);
    const t2 = performance.now();
    const parts = mergeParts(cover);
    const evaluator = approvalEvaluator(parts, inputs([rao, example], [approve(rao, "u-rao", 1)]));
    planLanding(parts, evaluator.gate, mergeDependencies(new Map(records.map((r) => [r.id, r])), { connectionsOf: () => [] }), merged.conflicts, words);
    const t3 = performance.now();
    process.stderr.write(`[m8 merge.three_way 2k] ${(t1 - t0).toFixed(1)} ms; [m8 responsibility.cover.2k_changed] ${(t2 - t1).toFixed(1)} ms; [m8 merge.partial_dependency] ${(t3 - t2).toFixed(1)} ms\n`);
    expect(t1 - t0).toBeLessThan(1000);
    expect(t2 - t1).toBeLessThan(40);
    expect(t3 - t2).toBeLessThan(100);
  });
});
