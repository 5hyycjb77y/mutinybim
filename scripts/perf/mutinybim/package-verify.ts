/**
 * Offline verification of one signed 50-part-type package (round 11 X11):
 * manifest parse, file hashes, the signature, the licence, every item's parse
 * and kernel checks, the contract range. The same package shape as
 * packages/bim-library/src/__tests__/x11-package-verify.test.ts (50 rooftop
 * units plus one script). Each sample is one `verifyPackage` call after a
 * warm-up.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/package-verify.ts --samples=21
 *
 * Metric:
 *   library.install.verify.one_package   ms per verify
 *
 * Moved from the unit test's wall-clock assertion, which measured the Unit
 * Tests job's CPU contention: unchanged code read 85.5 / 89.9 / 151.7 / 238.7 ms
 * across CI runs against 41.5 ms on an M-series laptop. The test keeps the
 * work-count assertions (one parse and one kernel check per item, one hash
 * per file). Prints one `@@perf-result` JSON line.
 */
import { createTestIdentityProvider, exampleRooftopUnit, IdentityProviderRegistry, type AuthorRef } from "../../../packages/bim-kernel/src";
import { assemblePackage, packageSigningPayload, partDefinitionHash, readManifestJson, verifyPackage, withPackageSignature } from "../../../packages/bim-library/src";
import { emit, gc } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 21);
const TYPES = 50;
const WARMUP = 3;

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(`${JSON.stringify(v, null, 2)}\n`);
const tester = createTestIdentityProvider([{ subject: "pub", displayName: "Publisher", keyId: "k-pub", secret: "perf" }]);
const author: AuthorRef = { provider: "test.identity", subject: "pub", kind: "person", displayName: "Publisher", keyId: "k-pub" };

const files = new Map<string, Uint8Array>();
const contents: { type: string; id: string; path: string }[] = [];
for (let i = 0; i < TYPES; i++) {
  const definition = { ...exampleRooftopUnit(), typeName: `RTU-${i}` };
  const item = {
    id: `perf.rtu-${i}`,
    revision: 1,
    key: `perf-rtu-${i}`,
    name: `Rooftop unit ${i}`,
    definition,
    provenance: {
      script: { id: "perf.rtu-script", key: "perf.rtu", version: "1.0.0", hash: `sha256:${"a".repeat(64)}` },
      values: { width: 2.4 },
      kitVersion: "0.1.0",
      kernelContract: "1.9.0",
      packs: [],
      generatedAt: "2026-11-02T12:00:00.000Z",
      generatedBy: author,
      outputHash: partDefinitionHash(definition),
    },
  };
  files.set(`parts/${item.id}.json`, json(item));
  contents.push({ type: "part_type", id: item.id, path: `parts/${item.id}.json` });
}
const script = {
  id: "perf.rtu-script",
  revision: 1,
  key: "perf.rtu",
  name: "Rooftop unit from cut sheet",
  version: "1.0.0",
  language: "typescript",
  kit: ">=0.1.0",
  manifest: { kind: "part", parameters: { width: { type: "quantity", kind: "length", unit: "ft", label: "Width", default: 2.4 } }, presets: [], reads: {} },
  source: 'import { defineScript } from "@permitzip/bim-script";\nexport default defineScript({ kind: "part", reads: {}, parameters: {}, run: (ctx) => ctx.parts.define("x", {}) });\n',
  license: "Apache-2.0",
  authors: [author],
};
files.set("scripts/perf.rtu-script.json", json(script));
contents.push({ type: "script", id: script.id, path: "scripts/perf.rtu-script.json" });
files.set("LICENSE", enc("Apache License 2.0\n"));
const assembled = assemblePackage(
  {
    format: "mutinybim-package",
    formatVersion: 1,
    name: "@perf/rooftop-units",
    version: "1.0.0",
    license: "Apache-2.0",
    authors: [author],
    requires: { kernelContract: ">=1.9.0" },
    contents,
    rightsDeclaration: { basis: "own_work", statement: "Synthetic.", declaredBy: author, declaredAt: "2026-11-02T00:00:00Z" },
  },
  files,
);
const manifest = readManifestJson(assembled);
if (!manifest.ok) throw new Error(manifest.reason);
const pkg = withPackageSignature(assembled, tester.sign("pub", packageSigningPayload(manifest.json)));
const identity = new IdentityProviderRegistry([tester.provider]);

async function once(): Promise<number> {
  const t0 = performance.now();
  const v = await verifyPackage(pkg, { identity });
  const ms = performance.now() - t0;
  if (!v.ok) throw new Error(`[perf/package-verify] the package didn't verify: ${v.problems.join("; ")}`);
  if (v.items.length !== TYPES + 1) throw new Error(`[perf/package-verify] read ${v.items.length} items, expected ${TYPES + 1}`);
  return ms;
}

async function main(): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await once();
  const values: number[] = [];
  for (let i = 0; i < samples; i++) {
    gc();
    values.push(await once());
  }
  emit({
    suite: "batch",
    workload: { types: TYPES, scripts: 1, samples },
    network: "in-process",
    participants: 1,
    samples: [{ metric: "library.install.verify.one_package", values, note: `${TYPES} part types + 1 script, signed, verified offline; ms per verifyPackage.` }],
  });
}

main().catch((err: unknown) => {
  console.error("[perf/package-verify] failed", err);
  process.exit(1);
});
