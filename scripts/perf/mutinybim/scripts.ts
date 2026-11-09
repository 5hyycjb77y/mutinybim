/**
 * Scripting kit and packages (round 11 X11).
 *
 * - script.snapshot.slice.<tier>: a script's slice cut from the head (levels,
 *   walls and rooms) and serialised as a host would send it, p50 / p95 ms.
 * - script.check.500_steps.<tier>: one 500-step `batch_edits` from a script
 *   (500 walls nudged 1 mm) through the kit's check (the server's re-parse, then round 8's preflight
 *   on the head), p50 / p95 ms. Target ≤ 300 ms at 250k.
 * - library.install.verify.one_package: a signed 50-part-type package
 *   verified offline (hashes, signature, conformance), p50 / p95 ms. Budget
 *   ≤ 200 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/scripts.ts [250k|1M]
 *
 * 1M only through the shared stack's heavy lock.
 */
import { createTestIdentityProvider, exampleRooftopUnit, freezeElements, IdentityProviderRegistry, type AuthorRef, type ModelState } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { assemblePackage, packageSigningPayload, partDefinitionHash, readManifestJson, verifyPackage, withPackageSignature } from "../../../packages/bim-library/src";
import { chunkEdits, checkScriptOutput, sliceModel, type EditStep } from "../../../packages/bim-script/src";
import { installFirstPartyAddOns } from "../../../packages/bim-first-party/src";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const SAMPLES = 7;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 2), p95: round(percentile(ms, 0.95) ?? 0, 2) };
}

const tier = process.argv[2] ?? "250k";
if (!isTier(tier)) {
  console.error(`[perf/scripts] ${tier} isn't a full-BIM tier (${Object.keys(FULL_BIM_TIERS).join(", ")})`);
  process.exit(1);
}
installFirstPartyAddOns();
const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `scripts-${tier}` });
const head: ModelState = { ...built, elements: freezeElements(built.elements) };
const walls = Object.values(head.elements).filter((e) => e.kind === "wall");
if (walls.length < 500) {
  console.error(`[perf/scripts] the ${tier} model has ${walls.length} walls; the check row needs 500`);
  process.exit(1);
}

const slice: number[] = [];
let sliceBytes = 0;
for (let i = 0; i < SAMPLES; i++) {
  gc();
  slice.push(timeSync(() => (sliceBytes = JSON.stringify(sliceModel(head, { levels: true, kinds: ["wall", "room"] })).length)).ms);
}

// 500 walls nudged 1 mm: a layout script's worth of ordinary edits across the model.
const steps: EditStep[] = walls.slice(0, 500).map((w) => ({ type: "move_wall", wallId: w.id, delta: { x: 1, y: 0 } }));
const output = JSON.parse(JSON.stringify({ kind: "edits", label: "Walls by script", steps: 500, batches: chunkEdits("Walls by script", steps) })) as unknown;
const check: number[] = [];
const warm = checkScriptOutput(head, output);
if (!warm.ok) {
  console.error("[perf/scripts] the 500-step batch was refused", warm.kind === "edits" ? warm.batches.map((b) => b.message) : []);
  process.exit(1);
}
for (let i = 0; i < SAMPLES; i++) {
  gc();
  check.push(
    timeSync(() => {
      const r = checkScriptOutput(head, output);
      if (!r.ok) throw new Error("[perf/scripts] the 500-step batch was refused");
    }).ms,
  );
}

const tester = createTestIdentityProvider([{ subject: "pub", displayName: "Publisher", keyId: "k-pub", secret: "perf" }]);
const author: AuthorRef = { provider: "test.identity", subject: "pub", kind: "person", displayName: "Publisher", keyId: "k-pub" };
const files = new Map<string, Uint8Array>();
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
for (let i = 0; i < 50; i++) {
  const definition = { ...exampleRooftopUnit(), typeName: `RTU-${i}` };
  files.set(`parts/p${i}.json`, enc({ id: `p${i}`, revision: 1, key: `p${i}`, name: `Part ${i}`, definition, provenance: { script: { id: "s", key: "perf.s", version: "1.0.0", hash: `sha256:${"a".repeat(64)}` }, values: {}, kitVersion: "0.1.0", kernelContract: "1.9.0", packs: [], generatedAt: "2026-11-02T00:00:00Z", generatedBy: author, outputHash: partDefinitionHash(definition) } }));
}
files.set("LICENSE", new TextEncoder().encode("Apache-2.0"));
const assembled = assemblePackage(
  { format: "mutinybim-package", formatVersion: 1, name: "@perf/parts", version: "1.0.0", license: "Apache-2.0", authors: [author], requires: { kernelContract: ">=1.9.0" }, contents: [...files.keys()].filter((p) => p.startsWith("parts/")).map((p) => ({ type: "part_type", id: p.slice(6, -5), path: p })), rightsDeclaration: { basis: "own_work", statement: "Synthetic.", declaredBy: author, declaredAt: "2026-11-02T00:00:00Z" } },
  files,
);
const manifest = readManifestJson(assembled);
if (!manifest.ok) throw new Error(manifest.reason);
const pkg = withPackageSignature(assembled, tester.sign("pub", packageSigningPayload(manifest.json)));
const identity = new IdentityProviderRegistry([tester.provider]);

async function main(): Promise<void> {
  const verify: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    gc();
    const t = performance.now();
    const v = await verifyPackage(pkg, { identity });
    verify.push(performance.now() - t);
    if (!v.ok) throw new Error(`[perf/scripts] the package didn't verify: ${v.problems.join("; ")}`);
  }
  console.log(
    JSON.stringify({
      [`script.snapshot.slice.${tier}`]: { ...stats(slice), elements: Object.keys(head.elements).length, bytes: sliceBytes },
      [`script.check.500_steps.${tier}`]: stats(check),
      "library.install.verify.one_package": { ...stats(verify), types: 50 },
    }),
  );
}

main().catch((err: unknown) => {
  console.error("[perf/scripts] failed", err);
  process.exit(1);
});
