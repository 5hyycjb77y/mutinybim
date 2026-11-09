/**
 * @jest-environment node
 *
 * Round 8 step 8b, lane M (the product owner's answers, Nov 1): the model's sign-off log
 * is hash-chained. The test vector is shared with pgTAP
 * (supabase/tests/bim_signoff_chain.test.sql), so SQL and the kernel hash a
 * record to the same bytes. `verifySignoffChain` catches an edited payload,
 * a removed record and a reordered sequence. Fails on round 8's code: there
 * was no sign-off log.
 */
import { SIGNOFF_GENESIS, signoffFields, signoffRecordHash, verifySignoffChain, type SignoffRecord } from "../src/responsibility/signoff-chain";

const VECTOR_HASH = "187c2dd418b52aafb7dc0e6e6f1ff18666641874b1bc28ef0dc96330d195ddff";

const vectorFields = signoffFields({
  seq: 1,
  projectId: "00000000-0000-0000-0000-0000000b8d10",
  baseModelId: "site-VECTOR-1",
  recordKind: "merge_approved",
  subjectId: "00000000-0000-0000-0000-0000000b8d40",
  actorUserId: "00000000-0000-0000-0000-0000000b8d01",
  payload: {
    // oss-clean: legacy-host-id (pinned cross-language hash vector)
    author: { displayName: "Vector Person", kind: "person", provider: "polygnotos", subject: "00000000-0000-0000-0000-0000000b8d01" },
    branch_head: 14,
    delta_digest: "a".repeat(64),
    discipline: "mechanical",
    note: 'Looks "right" — ok',
    responsibility_ids: ["00000000-0000-0000-0000-0000000b8d30"],
  },
});

function chain(n: number): SignoffRecord[] {
  const out: SignoffRecord[] = [];
  let prev = SIGNOFF_GENESIS;
  for (let seq = 1; seq <= n; seq++) {
    const base = { seq, projectId: "p1", baseModelId: "site-1", recordKind: seq === 1 ? "responsibility_accepted" : "merge_approved", subjectId: `s${seq}`, actorUserId: "u1", payload: { branch_head: 10 + seq, author: { kind: "person", provider: "host", subject: "u1" } } };
    const recordHash = signoffRecordHash(prev, signoffFields(base));
    out.push({ ...base, prevHash: prev, recordHash });
    prev = recordHash;
  }
  return out;
}

describe("m8-signoff-chain", () => {
  it("hashes the shared test vector to the value SQL computes", () => {
    expect(signoffRecordHash(SIGNOFF_GENESIS, vectorFields)).toBe(VECTOR_HASH);
  });

  it("verifies a good chain and names its head", () => {
    const c = chain(4);
    expect(verifySignoffChain(c)).toEqual({ ok: true, count: 4, head: c[3]?.recordHash });
  });

  it("catches an edited payload", () => {
    const c = chain(3);
    const edited = c.map((r) => (r.seq === 2 ? { ...r, payload: { ...r.payload, branch_head: 99 } } : r));
    expect(verifySignoffChain(edited)).toEqual({ ok: false, seq: 2, problem: "Entry 2 was changed after it was recorded." });
  });

  it("catches a removed record and a reordered sequence", () => {
    const c = chain(4);
    expect(verifySignoffChain([c[0], c[2], c[3]].flatMap((r) => (r ? [r] : [])))).toEqual({ ok: false, seq: 3, problem: "Entry 2 is missing (the next one is 3)." });
    expect(verifySignoffChain([c[0], c[2], c[1], c[3]].flatMap((r) => (r ? [r] : []))).ok).toBe(false);
    // Renumbering after a removal doesn't help: the links no longer match.
    const renumbered = [c[0], c[2]].flatMap((r, i) => (r ? [{ ...r, seq: i + 1 }] : []));
    expect(verifySignoffChain(renumbered)).toEqual({ ok: false, seq: 2, problem: "Entry 2 doesn't follow entry 1: an entry before it was changed or removed." });
  });

  it("refuses payload numbers that aren't whole (every implementation must print them alike)", () => {
    expect(() => signoffRecordHash(SIGNOFF_GENESIS, { ...vectorFields, payload: { x: 1.5 } })).toThrow(/whole numbers/);
  });
});
