/**
 * @jest-environment node
 *
 * Round 8 step 8b, lane M: the model server's merge preview and apply. It
 * recomputes the merge and who covers each part from the model it holds and
 * reads approvals from the host as the person, so a forged proposal or an
 * approval by the wrong person can't land a part. Fails on round 8's code:
 * there is no merge engine or merge message at all.
 */
import { type BimElement, type Changeset, type ModelState, type Responsibility } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { applyMerge, previewMerge, MERGE_WORDS, type ApprovalSnapshot, type HistoryReader, type MainLander, type MergeApprovalSource, type MergeSides, type ProposalSnapshot } from "../src";

function el(id: string, discipline: string, extra: Record<string, unknown> = {}, version = 1): BimElement {
  // Minimal records: merge reads id, kind, partition, references and content.
  return { id, kind: "part", version, authoredRev: {}, partition: { level: "L1", zone: "Z1", discipline }, typeId: "pt", values: {}, ...extra } as unknown as BimElement;
}

function cs(revision: number, elements: BimElement[]): Changeset {
  // Only the fields the merge engine reads.
  return { revision, elements, removedIds: [], addedConnections: [], removedConnections: [] } as unknown as Changeset;
}

/** A history from snapshots per revision (only the ids each test touches). */
function history(states: Record<number, Record<string, BimElement | null>>, changes: Changeset[]): HistoryReader {
  const revs = Object.keys(states).map(Number).sort((a, b) => a - b);
  return {
    headRevision: async () => revs[revs.length - 1] ?? 0,
    elementsAt: async (revision, ids) => {
      const at = [...revs].reverse().find((r) => r <= revision) ?? 0;
      const snap = states[at] ?? {};
      return Object.fromEntries(ids.map((id) => [id, snap[id] ?? null]));
    },
    changesBetween: async (from, to) => changes.filter((c) => c.revision > from && c.revision <= to),
  };
}

const ACCEPTED = "2026-11-01T05:00:00Z";
const rao: Responsibility = { id: "11111111-1111-4111-8111-111111111111", party: { kind: "person", ref: "u-rao", label: "J. Rao" }, discipline: "discipline_a", acceptedAt: ACCEPTED };
const example: Responsibility = { id: "22222222-2222-4222-8222-222222222222", party: { kind: "person", ref: "u-example", label: "K. Example" }, discipline: "discipline_b", acceptedAt: ACCEPTED };

function sides(): MergeSides {
  const base = { a1: el("a1", "discipline_a"), beam: el("beam", "discipline_b") };
  const onBranch = {
    a1: el("a1", "discipline_a", { mark: "A1 moved" }, 2),
    beam: el("beam", "discipline_b", { mark: "Beam deeper" }, 2),
    hanger: el("hanger", "discipline_a", { host: { kind: "element", elementId: "beam", stationMm: 100 } }),
  };
  const demo = createDemoModel("m8-branch");
  const head: ModelState = { ...demo, elements: onBranch, connections: [] };
  return {
    branch: { branchId: "lobby-b", name: "Lobby option B", baseRevision: 10, baseModelId: "site-1", state: "merge_proposed" },
    mainHistory: history({ 10: base }, []),
    branchHistory: history({ 10: base, 12: { ...base, a1: onBranch.a1 }, 13: onBranch }, [cs(12, [onBranch.a1]), cs(13, [onBranch.beam, onBranch.hanger])]),
    branchHead: head,
  };
}

function source(snapshot: Partial<ProposalSnapshot>): MergeApprovalSource {
  const base: ApprovalSnapshot = { responsibilities: [rao, example], approvals: [], leads: [], rules: {} };
  return {
    responsibilitiesFor: async () => base,
    proposalFor: async () => ({ ...base, proposal: { id: "p1", baseModelId: "site-1", branchId: "lobby-b", status: "open", proposedBy: "u-avery" }, ...snapshot }),
  };
}

function recordingLander(): MainLander & { readonly calls: string[][] } {
  const calls: string[][] = [];
  let rev = 20;
  return {
    calls,
    land: async ({ writes }) => {
      calls.push(writes.map((w) => w.elementId));
      return { ok: true, revision: ++rev };
    },
  };
}

const avery = { userId: "u-avery", token: "t", canEdit: true };

/** Each discipline's part digest, as the server previews it now. */
async function digests(): Promise<Record<string, string>> {
  const out = await previewMerge(sides(), source({}), avery);
  if (!out.ok) throw new Error(out.message);
  return Object.fromEntries(out.preview.parts.map((p) => [p.discipline, p.deltaDigest]));
}

function approval(r: Responsibility, ref: string, digest: string | undefined, seen = 13) {
  return { responsibilityId: r.id, approverRef: ref, approverLabel: r.party.label, decision: "approved" as const, seenBranchHead: seen, decidedAt: "2026-11-01T06:00:00Z", ...(digest ? { deltaDigest: digest } : {}) };
}

describe("m8 server merge", () => {
  it("previews parts by who approves them, with the newest branch revision per part", async () => {
    const out = await previewMerge(sides(), source({}), avery);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const byDiscipline = Object.fromEntries(out.preview.parts.map((p) => [p.discipline, p]));
    expect(byDiscipline.discipline_a?.approvers).toEqual(["J. Rao"]);
    expect(byDiscipline.discipline_a?.lastChangedRevision).toBe(13);
    expect(byDiscipline.discipline_b?.elementIds).toEqual(["beam"]);
    expect(out.preview.conflicts).toEqual([]);
  });

  it("m8-server-recomputes: an approval by someone who isn't the covering person, or a forged lead approval, lands nothing it covers", async () => {
    const lander = recordingLander();
    const d = await digests();
    const forged = source({
      approvals: [
        approval(rao, "u-rao", d.discipline_a),
        // The proposer approving discipline B's row themselves, and "as the lead" with no lead named.
        { ...approval(example, "u-avery", d.discipline_b), approverLabel: "R. Doe" },
        { ...approval(example, "u-avery", d.discipline_b), responsibilityId: null, approverLabel: "R. Doe" },
      ],
    });
    const out = await applyMerge(sides(), forged, lander, avery, "p1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A's part has a1 and the hanger; the hanger hangs on the beam (B), still waiting, so A can't land alone.
    expect(out.landed).toEqual([]);
    expect(lander.calls).toEqual([]);
    expect(out.waiting.map((w) => w.words)).toEqual(
      ["Discipline a can't land alone: part hanger depends on Beam deeper in Discipline b, which is still waiting.", "Discipline b is waiting for approval from K. Example."],
    );
  });

  it("m8-discipline-approval (server): both approve: parts land in dependency order, one revision each", async () => {
    const lander = recordingLander();
    const d = await digests();
    const approved = source({ approvals: [approval(rao, "u-rao", d.discipline_a), approval(example, "u-example", d.discipline_b)] });
    const out = await applyMerge(sides(), approved, lander, avery, "p1");
    expect(out.ok && out.allLanded).toBe(true);
    expect(lander.calls).toEqual([["beam"], ["a1", "hanger"]]);
  });

  it("m8-digest-reapproval (server): an approval naming an older digest of its part asks again; the other part's stands", async () => {
    const lander = recordingLander();
    const d = await digests();
    const stale = source({ approvals: [approval(rao, "u-rao", "0".repeat(64), 12), approval(example, "u-example", d.discipline_b)] });
    const out = await applyMerge(sides(), stale, lander, avery, "p1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(lander.calls).toEqual([["beam"]]);
    expect(out.waiting.map((w) => w.discipline)).toEqual(["discipline_a"]);
  });

  it("refuses a proposal for another branch, someone else's proposal, and a closed branch, in words", async () => {
    const lander = recordingLander();
    const other = await applyMerge(sides(), source({ proposal: { id: "p1", baseModelId: "site-1", branchId: "other", status: "open", proposedBy: "u-avery" } }), lander, avery, "p1");
    expect(other).toEqual({ ok: false, message: MERGE_WORDS.wrongProposal });
    const notMine = await applyMerge(sides(), source({ proposal: { id: "p1", baseModelId: "site-1", branchId: "lobby-b", status: "open", proposedBy: "u-rao" } }), lander, avery, "p1");
    expect(notMine).toEqual({ ok: false, message: MERGE_WORDS.notProposer });
    const closed = await applyMerge({ ...sides(), branch: { ...sides().branch, state: "merged" } }, source({}), lander, avery, "p1");
    expect(closed).toEqual({ ok: false, message: MERGE_WORDS.branchClosed });
    expect(lander.calls).toEqual([]);
  });
});
