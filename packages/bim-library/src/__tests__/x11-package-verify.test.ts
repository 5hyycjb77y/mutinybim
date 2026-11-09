/**
 * @jest-environment node
 *
 * Round 11 lane X11: the `mutinybim-package` v1 format and its offline
 * verifier. A good package verifies; one changed byte fails; an agent's
 * signature is refused; an unknown provider can't be checked; no rights
 * declaration is no package. Fails on round 10's code (no package format).
 */
import { IdentityProviderRegistry, createTestIdentityProvider, exampleRooftopUnit, payloadDigest, type AuthorRef, type SignatureEnvelope } from "@permitzip/bim-kernel";
import { deflateSync, gunzipSync, gzipSync } from "node:zlib";
import {
  RegistryClient,
  assemblePackage,
  fileHash,
  packageDigest,
  packageSigningPayload,
  partDefinitionHash,
  readManifestJson,
  readPackageTar,
  registryPaths,
  verifyPackage,
  withPackageSignature,
  writePackageTar,
  packPackageTgz,
  type PackageCodec,
  type PackageFiles,
  type RegistryTransport,
} from "../index";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(`${JSON.stringify(v, null, 2)}\n`);
const NODE_CODEC: PackageCodec = { gzip: async (b) => new Uint8Array(gzipSync(b, { level: 9 })), gunzip: async (b) => new Uint8Array(gunzipSync(b)) };

const tester = createTestIdentityProvider([
  { subject: "jlee", displayName: "J. Lee", keyId: "k-jlee", secret: "s1" },
  { subject: "mod", displayName: "Catalogue moderator", keyId: "k-mod", secret: "s2" },
]);
const JLEE: AuthorRef = { provider: "test.identity", subject: "jlee", kind: "person", displayName: "J. Lee", keyId: "k-jlee" };
const identity = () => new IdentityProviderRegistry([tester.provider]);

function partItem(i: number) {
  const definition = { ...exampleRooftopUnit(), typeName: `RTU-${i}` };
  return {
    id: `acme.rtu-${i}`,
    revision: 1,
    key: `acme-rtu-${i}`,
    name: `Rooftop unit ${i}`,
    definition,
    provenance: {
      script: { id: "acme.rtu-script", key: "acme.rtu", version: "1.0.0", hash: `sha256:${"a".repeat(64)}` },
      values: { width: 2.4 },
      kitVersion: "0.1.0",
      kernelContract: "1.9.0",
      packs: [],
      generatedAt: "2026-11-02T12:00:00.000Z",
      generatedBy: JLEE,
      outputHash: partDefinitionHash(definition),
    },
  };
}

const scriptItem = {
  id: "acme.rtu-script",
  revision: 1,
  key: "acme.rtu",
  name: "Rooftop unit from cut sheet",
  version: "1.0.0",
  language: "typescript",
  kit: ">=0.1.0",
  manifest: { kind: "part", parameters: { width: { type: "quantity", kind: "length", unit: "ft", label: "Width", default: 2.4 } }, presets: [], reads: {} },
  source: 'import { defineScript } from "@permitzip/bim-script";\nexport default defineScript({ kind: "part", reads: {}, parameters: {}, run: (ctx) => ctx.parts.define("x", {}) });\n',
  license: "Apache-2.0",
  authors: [JLEE],
};

function unsignedPackage(parts = 1, extra: Record<string, unknown> = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const contents: { type: string; id: string; path: string }[] = [];
  for (let i = 0; i < parts; i++) {
    const item = partItem(i);
    files.set(`parts/${item.id}.json`, json(item));
    contents.push({ type: "part_type", id: item.id, path: `parts/${item.id}.json` });
  }
  files.set("scripts/acme.rtu-script.json", json(scriptItem));
  contents.push({ type: "script", id: scriptItem.id, path: "scripts/acme.rtu-script.json" });
  files.set("LICENSE", enc("Apache License 2.0 (text elided in the test)\n"));
  files.set("README.md", enc("# Rooftop units\n"));
  return assemblePackage(
    {
      format: "mutinybim-package",
      formatVersion: 1,
      name: "@acme-mech/rooftop-units",
      version: "1.3.0",
      license: "Apache-2.0",
      authors: [JLEE],
      requires: { kernelContract: ">=1.9.0" },
      contents,
      rightsDeclaration: { basis: "manufacturer", statement: "Acme publishes its own units' dimensional data.", declaredBy: JLEE, declaredAt: "2026-11-02T12:00:00.000Z" },
      ...extra,
    },
    files,
  );
}

function sign(files: PackageFiles, subject = "jlee"): Map<string, Uint8Array> {
  const m = readManifestJson(files);
  if (!m.ok) throw new Error(m.reason);
  return withPackageSignature(files, tester.sign(subject, packageSigningPayload(m.json)));
}

describe("x11 package format and verifyPackage", () => {
  it("x11-package-verify: a good package verifies offline", async () => {
    const files = sign(unsignedPackage());
    const v = await verifyPackage(files, { identity: identity(), licenceAllowlist: ["Apache-2.0", "MIT"] });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.signers.map((s) => s.subject)).toEqual(["jlee"]);
    expect(v.items.map((i) => i.type)).toEqual(["part_type", "script"]);
    expect(v.digest).toBe(packageDigest(JSON.parse(new TextDecoder().decode(files.get("mutinybim.json")))));
    expect(v.manifest?.rightsDeclaration.basis).toBe("manufacturer");
  });

  it("x11-package-verify: one changed byte fails, and its signature still names the original", async () => {
    const files = sign(unsignedPackage());
    const path = "parts/acme.rtu-0.json";
    const bytes = new Uint8Array(files.get(path) ?? new Uint8Array());
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 1;
    const tampered = new Map(files).set(path, bytes);
    const v = await verifyPackage(tampered, { identity: identity() });
    expect(v.ok).toBe(false);
    expect(v.checks.hashes.status).toBe("fail");
    expect(v.checks.hashes.problems[0]).toMatch(/has changed since the package was made/);

    // Re-hashing the manifest to match breaks the signature instead.
    const m = JSON.parse(new TextDecoder().decode(files.get("mutinybim.json"))) as { contents: { path: string; hash: string }[] };
    for (const c of m.contents) if (c.path === path) c.hash = fileHash(bytes);
    const rehashed = new Map(tampered).set("mutinybim.json", json(m));
    const w = await verifyPackage(rehashed, { identity: identity() });
    expect(w.checks.hashes.status).toBe("pass");
    expect(w.checks.signature.status).toBe("fail");
    expect(w.checks.signature.problems.join(" ")).toMatch(/has changed since it was signed/);
  });

  it("x11-package-verify: an agent's signature is refused (agents can't sign)", async () => {
    const files = unsignedPackage();
    const m = readManifestJson(files);
    if (!m.ok) throw new Error(m.reason);
    const human = tester.sign("jlee", packageSigningPayload(m.json));
    const agent: SignatureEnvelope = { ...human, signer: { provider: "test.identity", subject: "agent:run-1", kind: "agent", onBehalfOf: JLEE } };
    const signed = new Map(files).set("signatures/1.json", json(agent));
    const v = await verifyPackage(signed, { identity: identity() });
    expect(v.checks.signature.status).toBe("fail");
    expect(v.checks.signature.problems.join(" ")).toMatch(/Only people sign/);
  });

  it("refuses an unsigned package, a provider this host can't check, and a non-author's lone signature", async () => {
    const unsigned = await verifyPackage(unsignedPackage(), { identity: identity() });
    expect(unsigned.checks.signature.problems[0]).toMatch(/Nobody signed this package/);
    const unknown = await verifyPackage(sign(unsignedPackage()), { identity: new IdentityProviderRegistry() });
    expect(unknown.checks.signature.problems.join(" ")).toMatch(/can't check/);
    const moderatorOnly = await verifyPackage(sign(unsignedPackage(), "mod"), { identity: identity() });
    expect(moderatorOnly.checks.signature.problems.join(" ")).toMatch(/No author of this package signed it/);
    const counter = await verifyPackage(sign(sign(unsignedPackage()), "mod"), { identity: identity() });
    expect(counter.ok).toBe(true);
    expect(counter.checks.signature.notes.join(" ")).toMatch(/counter-signature/);
  });

  it("needs a rights declaration, a LICENSE, an allowed licence, the contract and the add-ons it names", async () => {
    const files = unsignedPackage();
    const m = JSON.parse(new TextDecoder().decode(files.get("mutinybim.json"))) as Record<string, unknown>;
    delete m.rightsDeclaration;
    const noRights = await verifyPackage(new Map(files).set("mutinybim.json", json(m)), { identity: identity() });
    expect(noRights.checks.manifest.problems[0]).toMatch(/rightsDeclaration/);

    const noLicence = new Map(sign(files));
    noLicence.delete("LICENSE");
    expect((await verifyPackage(noLicence, { identity: identity() })).checks.licence.problems[0]).toMatch(/no LICENSE/);
    expect((await verifyPackage(sign(files), { identity: identity(), licenceAllowlist: ["MIT"] })).checks.licence.problems[0]).toMatch(/isn't on this firm's list/);

    const needs = sign(unsignedPackage(1, { requires: { kernelContract: ">=2.0.0", packs: ["mutinybim.plumbing@>=1.0.0"] } }));
    const r = await verifyPackage(needs, { identity: identity(), installedPacks: new Map([["mutinybim.mechanical", "1.4.0"]]) });
    expect(r.checks.requires.problems).toEqual([expect.stringMatching(/add-on contract >=2.0.0/), expect.stringMatching(/needs the mutinybim.plumbing add-on/)]);
  });

  it("keeps a content type it doesn't know, still under the hash and the signature", async () => {
    const files = unsignedPackage();
    files.set("addons/acme.widget.json", json({ id: "acme.widget" }));
    const m = JSON.parse(new TextDecoder().decode(files.get("mutinybim.json"))) as { contents: object[] };
    m.contents.push({ type: "addon", id: "acme.widget", path: "addons/acme.widget.json", hash: fileHash(files.get("addons/acme.widget.json") ?? new Uint8Array()) });
    m.contents.push({ type: "future_thing", id: "x", path: "README.md", hash: fileHash(files.get("README.md") ?? new Uint8Array()) });
    const v = await verifyPackage(sign(new Map(files).set("mutinybim.json", json(m))), { identity: identity() });
    expect(v.ok).toBe(true);
    expect(v.otherContents.map((c) => c.type)).toEqual(["addon", "future_thing"]);
    expect(v.checks.conformance.notes.join(" ")).toMatch(/"future_thing" this reader doesn't know/);
  });

  it("refuses a script that reaches the network or the clock, and a part type that fails the kernel's checks", async () => {
    const files = unsignedPackage();
    const bad = { ...scriptItem, source: `import { defineScript } from "@permitzip/bim-script";\nimport fs from "node:fs";\nconst t = Date.now();\nfetch("https://x");\n` };
    files.set("scripts/acme.rtu-script.json", json(bad));
    const part = partItem(0);
    files.set("parts/acme.rtu-0.json", json({ ...part, definition: { ...part.definition, tagFields: ["no_such_param"] } }));
    const m = JSON.parse(new TextDecoder().decode(files.get("mutinybim.json"))) as { contents: { path: string; hash: string }[] };
    for (const c of m.contents) c.hash = fileHash(files.get(c.path) ?? new Uint8Array());
    const v = await verifyPackage(sign(new Map(files).set("mutinybim.json", json(m))), { identity: identity() });
    const words = v.checks.conformance.problems.join("\n");
    expect(words).toMatch(/imports "node:fs"/);
    expect(words).toMatch(/names the network/);
    expect(words).toMatch(/reads the clock/);
    expect(words).toMatch(/acme.rtu-0.json: no_such_param: Tag field no_such_param is not a parameter/);
  });

  it("travels as a deterministic .tgz and reads back the same", async () => {
    const files = sign(unsignedPackage());
    const tar = writePackageTar(files);
    expect(writePackageTar(new Map([...files].reverse()))).toEqual(tar);
    const back = readPackageTar(tar);
    expect([...back.keys()].sort()).toEqual([...files.keys()].sort());
    const tgz = await packPackageTgz(files, NODE_CODEC);
    const v = await verifyPackage(readPackageTar(new Uint8Array(gunzipSync(tgz))), { identity: identity() });
    expect(v.ok).toBe(true);
    expect(() => readPackageTar(deflateSync(enc("not a tar")))).toThrow();
  });

  it("reads a static registry and checks archive hash, size and digest", async () => {
    const files = sign(unsignedPackage());
    const tgz = await packPackageTgz(files, NODE_CODEC);
    const digest = packageDigest(JSON.parse(new TextDecoder().decode(files.get("mutinybim.json"))));
    const site = new Map<string, Uint8Array>([
      ["registry.json", json({ format: "mutinybim-registry", protocolVersion: 1, name: "Acme parts", identityProviders: [{ id: "test.identity", keyLogUrl: "https://acme.example/keys.json" }] })],
      [registryPaths.index("@acme-mech/rooftop-units"), json({
        name: "@acme-mech/rooftop-units",
        versions: [
          { version: "1.3.0", digest, archive: { hash: fileHash(tgz), size: tgz.length }, publishedAt: "2026-11-02T12:00:00Z" },
          { version: "1.4.0", digest, archive: { hash: fileHash(tgz), size: tgz.length }, publishedAt: "2026-11-02T13:00:00Z", yanked: { at: "2026-11-02T14:00:00Z" } },
          { version: "1.2.0", digest, archive: { hash: fileHash(tgz), size: tgz.length }, publishedAt: "2026-11-01T12:00:00Z", removed: { at: "2026-11-02T14:00:00Z", reason: "Malicious script." } },
        ],
      })],
      [registryPaths.archive("@acme-mech/rooftop-units", "1.3.0"), tgz],
      [registryPaths.archive("@acme-mech/rooftop-units", "1.4.0"), new Uint8Array([...tgz, 0])],
    ]);
    const transport: RegistryTransport = { getText: async (p) => (site.has(p) ? new TextDecoder().decode(site.get(p)) : null), getBytes: async (p) => site.get(p) ?? null };
    const client = new RegistryClient(transport, "Acme parts");
    expect((await client.info()).name).toBe("Acme parts");
    expect((await client.latest("@acme-mech/rooftop-units"))?.version).toBe("1.3.0");
    const got = await client.fetchVersion("@acme-mech/rooftop-units", "1.3.0", { identity: identity() }, NODE_CODEC);
    expect(got.status).toBe("available");
    expect(got.verification.ok).toBe(true);
    await expect(client.fetchVersion("@acme-mech/rooftop-units", "1.2.0", { identity: identity() }, NODE_CODEC)).rejects.toThrow(/was removed from Acme parts: Malicious script/);
    await expect(client.fetchVersion("@acme-mech/rooftop-units", "1.4.0", { identity: identity() }, NODE_CODEC)).rejects.toThrow(/isn't the file its index lists/);
    expect(payloadDigest(packageSigningPayload(JSON.parse(new TextDecoder().decode(files.get("mutinybim.json")))))).toBe(digest);
  });

  // The 200 ms wall clock for this package is library.install.verify.one_package in the BIM perf gate
  // (scripts/perf/mutinybim/package-verify.ts). Here: the work, which a shared runner can't make noisy.
  it("library.install.verify.one_package: a 50-type package hashes each file once with the host's SHA-256, and parses and checks each item once", async () => {
    const files = sign(unsignedPackage(50));
    const m = JSON.parse(new TextDecoder().decode(files.get("mutinybim.json"))) as { contents: { path: string }[] };
    const bytes = m.contents.reduce((n, c) => n + (files.get(c.path)?.length ?? 0), 0);
    const v = await verifyPackage(files, { identity: identity() });
    expect(v.ok).toBe(true);
    expect(v.work).toEqual({ filesHashed: 51, bytesHashed: bytes, hasher: "native", itemsParsed: 51, itemsChecked: 51 });
  });

  it("hashes the same with the kernel's portable SHA-256 when the host has no Web Crypto", async () => {
    const files = sign(unsignedPackage(3));
    const native = await verifyPackage(files, { identity: identity() });
    const portable = await verifyPackage(files, { identity: identity(), subtle: null });
    expect(portable.work.hasher).toBe("portable");
    expect(portable.ok).toBe(true);
    expect(portable.digest).toBe(native.digest);
    const path = "parts/acme.rtu-2.json";
    const bytes = new Uint8Array(files.get(path) ?? new Uint8Array());
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    const tampered = new Map(files).set(path, bytes);
    for (const subtle of [undefined, null]) {
      const t = await verifyPackage(tampered, { identity: identity(), subtle });
      expect(t.checks.hashes.problems).toEqual([`${path} has changed since the package was made (its hash doesn't match the manifest).`]);
    }
  });
});
