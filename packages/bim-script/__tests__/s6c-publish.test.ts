/**
 * @jest-environment node
 *
 * Publishing scripts (round 16): `mutinybim-script publish` puts a signed
 * package into a static registry folder (plain files anyone can serve), and
 * `yank` / `unyank` pull a version back or offer it again. What it writes
 * reads back through the registry client an installer uses, hashes and
 * digest included.
 *
 * Fails on the previous code: the kit could run, check and pack a script
 * but not publish it. A registry could only be read, so sharing a script
 * meant writing its index by hand.
 */
import { IdentityProviderRegistry, createTestIdentityProvider } from "@permitzip/bim-kernel";
import { RegistryClient, packageSigningPayload, readManifestJson, readPackageTar, registryPaths, withPackageSignature, writePackageTar, type PackageCodec, type RegistryTransport } from "@permitzip/bim-library";
import { gunzipSync, gzipSync } from "node:zlib";
import { runCli, type CliIo } from "../src/cli";

const NODE: PackageCodec = { gzip: async (b) => new Uint8Array(gzipSync(b)), gunzip: async (b) => new Uint8Array(gunzipSync(b)) };
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b ?? new Uint8Array());
const tester = createTestIdentityProvider([{ subject: "jlee", displayName: "J. Lee", keyId: "k-jlee", secret: "s1" }]);
const PERSON = { provider: "test.identity", subject: "jlee", kind: "person", displayName: "J. Lee", keyId: "k-jlee" };
const NAME = "@acme/drains";

function host(files: Map<string, Uint8Array>): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    codec: NODE,
    now: () => "2026-11-07T20:00:00.000Z",
    readFile: async (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`no file ${p}`);
      return b;
    },
    readFileIfExists: async (p) => files.get(p) ?? null,
    writeFile: async (p, b) => void files.set(p, b),
    listFiles: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    loadScript: async () => {
      throw new Error("no script runs in a publish");
    },
  };
}

function scriptPackageFolder(files: Map<string, Uint8Array>, version: string, source = 'import { defineScript } from "@permitzip/bim-script";\n') {
  const script = { id: "acme.drains", revision: 1, key: "acme.drains", name: "Drains", version, language: "typescript", kit: ">=0.1.0", manifest: { kind: "layout", parameters: {}, presets: [], reads: {} }, source, license: "Apache-2.0", authors: [PERSON] }
  files.set("pkg/mutinybim.json", enc({ format: "mutinybim-package", formatVersion: 1, name: NAME, version, license: "Apache-2.0", authors: [PERSON], requires: { kernelContract: ">=1.9.0" }, contents: [{ type: "script", id: "acme.drains", path: "scripts/acme.drains.json" }], rightsDeclaration: { basis: "own_work", statement: "Ours.", declaredBy: PERSON, declaredAt: "2026-11-07T00:00:00Z" } }))
  files.set("pkg/scripts/acme.drains.json", enc(script))
  files.set("pkg/LICENSE", enc("Apache-2.0"))
}

/** Packs the folder with the CLI, then signs it as J. Lee (the step a person does before publishing). */
async function packAndSign(io: CliIo, files: Map<string, Uint8Array>, out: string, sign = true): Promise<void> {
  expect(await runCli(["pack", "pkg", "--out", out], io)).toBe(0)
  if (!sign) return
  const unpacked = readPackageTar(new Uint8Array(gunzipSync(files.get(out) ?? new Uint8Array())))
  const m = readManifestJson(unpacked)
  if (!m.ok) throw new Error(m.reason)
  const signed = withPackageSignature(unpacked, tester.sign("jlee", packageSigningPayload(m.json)))
  files.set(out, new Uint8Array(gzipSync(writePackageTar(signed))))
}

function reader(files: Map<string, Uint8Array>): RegistryClient {
  const at = (p: string) => `site/${p}`
  const transport: RegistryTransport = { getText: async (p) => (files.has(at(p)) ? dec(files.get(at(p))) : null), getBytes: async (p) => files.get(at(p)) ?? null }
  return new RegistryClient(transport, "Acme scripts")
}

describe("s6c: publishing scripts to a static registry", () => {
  it("a signed package publishes into an empty folder and reads back as an installer reads it", async () => {
    const files = new Map<string, Uint8Array>()
    const io = host(files)
    scriptPackageFolder(files, "1.0.0")
    await packAndSign(io, files, "drains-1.0.0.tgz")
    expect(await runCli(["publish", "drains-1.0.0.tgz", "--registry", "site", "--name", "Acme scripts"], io)).toBe(0)
    expect(io.out.at(-1)).toMatch(/^Published @acme\/drains 1\.0\.0 to site \(1 signature, sha256:/)
    const client = reader(files)
    expect((await client.info()).name).toBe("Acme scripts")
    expect((await client.latest(NAME))?.version).toBe("1.0.0")
    const got = await client.fetchVersion(NAME, "1.0.0", { identity: new IdentityProviderRegistry([tester.provider]) }, NODE)
    expect(got.status).toBe("available")
    expect(got.verification.ok).toBe(true)
    expect(got.verification.signers.map((s) => s.subject)).toEqual(["jlee"])
    expect(got.entry).toMatchObject({ publishedAt: "2026-11-07T20:00:00.000Z", signatures: 1 })
  })

  it("the same bytes again change nothing; other bytes under the same version are refused", async () => {
    const files = new Map<string, Uint8Array>()
    const io = host(files)
    scriptPackageFolder(files, "1.0.0")
    await packAndSign(io, files, "a.tgz")
    expect(await runCli(["publish", "a.tgz", "--registry", "site"], io)).toBe(0)
    const index = dec(files.get(`site/${registryPaths.index(NAME)}`))
    expect(await runCli(["publish", "a.tgz", "--registry", "site"], io)).toBe(0)
    expect(io.out.at(-1)).toMatch(/already in site with these exact contents; nothing changed/)
    expect(dec(files.get(`site/${registryPaths.index(NAME)}`))).toBe(index)
    scriptPackageFolder(files, "1.0.0", 'import { defineScript } from "@permitzip/bim-script";\n// changed\n')
    await packAndSign(io, files, "b.tgz")
    expect(await runCli(["publish", "b.tgz", "--registry", "site"], io)).toBe(1)
    expect(io.err.at(-1)).toMatch(/already in MutinyBIM scripts with other contents\. A published version never changes: bump the version/)
  })

  it("an unsigned package is refused, and nothing is written", async () => {
    const files = new Map<string, Uint8Array>()
    const io = host(files)
    scriptPackageFolder(files, "1.0.0")
    await packAndSign(io, files, "u.tgz", false)
    expect(await runCli(["publish", "u.tgz", "--registry", "site"], io)).toBe(1)
    expect(io.err.at(-1)).toMatch(/nobody signed this package\. A person among its authors signs it to publish it/)
    expect([...files.keys()].some((p) => p.startsWith("site/"))).toBe(false)
  })

  it("yank pulls a version from new installs (pinned projects keep it, warned); unyank offers it again", async () => {
    const files = new Map<string, Uint8Array>()
    const io = host(files)
    for (const v of ["1.0.0", "1.1.0"]) {
      scriptPackageFolder(files, v)
      await packAndSign(io, files, `${v}.tgz`)
      expect(await runCli(["publish", `${v}.tgz`, "--registry", "site"], io)).toBe(0)
    }
    expect(await runCli(["yank", NAME, "1.1.0", "--registry", "site", "--reason", "Places drains off the grid"], io)).toBe(0)
    const client = reader(files)
    expect((await client.latest(NAME))?.version).toBe("1.0.0")
    const pinned = await client.fetchVersion(NAME, "1.1.0", { identity: new IdentityProviderRegistry([tester.provider]) }, NODE)
    expect(pinned.status).toBe("yanked")
    expect(pinned.entry.yanked).toEqual({ at: "2026-11-07T20:00:00.000Z", reason: "Places drains off the grid" })
    expect(await runCli(["unyank", NAME, "1.1.0", "--registry", "site"], io)).toBe(0)
    expect((await reader(files).latest(NAME))?.version).toBe("1.1.0")
    expect(await runCli(["yank", NAME, "9.9.9", "--registry", "site"], io)).toBe(1)
    expect(io.err.at(-1)).toMatch(/has no @acme\/drains 9\.9\.9/)
  })

  it("a host that can't tell a missing file from an unreadable one says so instead of guessing", async () => {
    const files = new Map<string, Uint8Array>()
    const { readFileIfExists: _drop, ...io } = host(files)
    scriptPackageFolder(files, "1.0.0")
    await packAndSign(io, files, "a.tgz")
    expect(await runCli(["publish", "a.tgz", "--registry", "site"], io)).toBe(1)
    expect(io.err.at(-1)).toMatch(/can't tell a missing registry file from an unreadable one/)
  })
})
