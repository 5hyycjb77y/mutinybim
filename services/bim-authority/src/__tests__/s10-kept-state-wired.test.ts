/**
 * @jest-environment node
 *
 * Round 10 S10: the model server keeps and adopts the validation state K9
 * wrote (`pg-store.ts` kept-state section). Without a build key nothing is
 * kept or adopted, so the store must be given one, and a shutdown while a
 * quiet-spell write is still pending must write it before the lease goes.
 *
 * Fails on round 9's code: retire() released the lease with the write timer
 * still pending (nothing flushed, the timer fired after the lease was gone),
 * and `flushValidationState` did not exist. The adoption itself is proven in
 * the kernel (`packages/bim-pack/__tests__/k9-adopted-state.test.ts`) and at
 * 1M in `k9-perf` / `scripts/perf/mutinybim/first-edit-kept.ts`; a restart
 * against a real model-server Postgres is the Testing stage's drill.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(SRC, "server.ts"), "utf8");
const store = fs.readFileSync(path.join(SRC, "pg-store.ts"), "utf8");

function body(source: string, signature: RegExp): string {
  const start = source.search(signature);
  if (start < 0) throw new Error(`no ${signature} in the source`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${signature}`);
}

describe("s10-kept-state-wired", () => {
  it("every served model's store is given the build key the kept state is written and adopted under", () => {
    const create = body(server, /async function createRuntime\(/);
    expect(create).toMatch(/new PostgresCommitStore\(sql, \{[\s\S]*validationCodeKey:/);
    // No build id (or the Dockerfile's "unknown") keeps nothing: a state from another build is never adopted.
    expect(create).toMatch(/validationCodeKey: config\.commit && config\.commit !== "unknown" \? config\.commit : null/);
  });

  it("shutdown writes a pending state before the lease is released; any other retirement only stops the timer", () => {
    const retire = body(server, /function retire\(/);
    const flush = retire.indexOf("flushValidationState()");
    const settle = retire.indexOf("settleValidationState()");
    const release = retire.indexOf("releaseLease()");
    expect(flush).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(flush);
    expect(release).toBeGreaterThan(settle);
    expect(retire).toMatch(/reason === "shutdown" \? runtime\.store\.flushValidationState\(\) : runtime\.store\.settleValidationState\(\)/);
    // The release waits for the state (it is chained after it), and a failed state write is logged, never thrown past the release.
    expect(retire).toMatch(/validationSettled\s*\.then\(\(\) => runtime\.store\.releaseLease\(\)\)/);
    expect(retire).toMatch(/\.catch\(\(stateErr\) =>\s*console\.error\(/);
  });

  it("the flush writes only when a quiet-spell write was pending, after stopping the timer", () => {
    const flush = body(store, /async flushValidationState\(\)/);
    expect(flush.indexOf("this.validationTimer !== null")).toBeLessThan(flush.indexOf("settleValidationState()"));
    expect(flush).toMatch(/pending \? this\.writeValidationState\(\) : false/);
  });
});
