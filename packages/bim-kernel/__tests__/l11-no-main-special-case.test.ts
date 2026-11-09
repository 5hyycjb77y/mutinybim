/**
 * @jest-environment node
 *
 * Round 11 L11 (product owner answer 2): copies of copies with no special cases. No
 * lineage or branch-history code compares an id with the first lineage's
 * ("main"), and the sync service no longer refuses a branch on a branch
 * session with "Branches start from Main". Behaviour is checked in
 * l11-copy-of-copy (same answers whatever the first lineage is called).
 * Fails on round 10's code: `service.ts` throws START_BRANCH_FROM_MAIN.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function sources(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs).flatMap((name) => {
    const full = path.join(abs, name);
    if (statSync(full).isDirectory()) return sources(path.join(dir, name));
    return /\.ts$/.test(name) ? [path.join(dir, name)] : [];
  });
}

const CHAIN_CODE = [...sources("packages/bim-kernel/src/lineages"), ...sources("packages/bim-sync/src/lineages"), "packages/bim-sync/src/branches/history.ts"];

/** A comparison with the first lineage's id, by literal or constant, either way round. */
const SPECIAL_CASE = /(===|!==|==|!=)\s*(["']main["']|ROOT_LINEAGE_ID|MAIN_LINEAGE)|(["']main["']|ROOT_LINEAGE_ID|MAIN_LINEAGE)\s*(===|!==|==|!=)|case\s+["']main["']/;

describe("l11-no-main-special-case", () => {
  it("finds the chain code", () => {
    expect(CHAIN_CODE.length).toBeGreaterThan(8);
  });

  it.each(CHAIN_CODE)("%s compares no id with the first lineage's", (file) => {
    const offending = readFileSync(path.join(ROOT, file), "utf8")
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//") && SPECIAL_CASE.test(line));
    expect(offending).toEqual([]);
  });

  it("the branch service no longer refuses a branch on a branch session with Branches start from Main", () => {
    const service = readFileSync(path.join(ROOT, "packages/bim-sync/src/branches/service.ts"), "utf8");
    expect(service).not.toMatch(/throw new BranchRefusal\(START_BRANCH_FROM_MAIN\)/);
  });
});
