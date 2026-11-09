/**
 * @jest-environment node
 *
 * Round 8b lane A: tolerant readers, strict writers. An envelope from a
 * provider and algorithm this release doesn't know (another firm's
 * certificate signing, with its chain and a field of its own) reads, keeps
 * everything, and writes back unchanged. Malformed ones are refused in words,
 * not thrown. Fails on round 8's code: there is no authorship module.
 */
import { AuthorshipWriteError, readAuthorRef, readSignatureEnvelope, writeSignatureEnvelope } from "@permitzip/bim-kernel";

const FOREIGN = {
  v: 1,
  alg: "x509-cms",
  provider: "acme.pki",
  keyId: "cert-sha256:4f2a",
  signer: { provider: "acme.pki", subject: "CN=Jane Rao,O=Acme Engineering", kind: "person", displayName: "J. Rao" },
  payloadDigest: `sha256:${"ab".repeat(32)}`,
  signature: "MEUCIQDx_ZK-9y",
  certChain: ["MIIBszCCAVmgAwIBAgIU", "MIIBjTCCATOgAwIBAgIU"],
  signedAt: "2026-11-01T05:42:00Z",
  "x-acme-policy": { oid: "1.3.6.1.4.1.99999.1", level: 2 },
};

describe("a8b-envelope-round-trip", () => {
  it("reads an unknown provider and algorithm, keeps unknown fields, and writes back unchanged", () => {
    const read = readSignatureEnvelope(FOREIGN);
    if (!read.ok) throw new Error(read.reason);
    expect(read.value.provider).toBe("acme.pki");
    expect(read.value.certChain).toEqual(FOREIGN.certChain);
    expect(read.value.extensions).toEqual({ "x-acme-policy": FOREIGN["x-acme-policy"] });
    expect(read.notes.join(" ")).toMatch(/x-acme-policy/);
    expect(writeSignatureEnvelope(read.value)).toEqual(FOREIGN);
  });

  it("keeps a newer envelope version and an unknown author kind on read, and the strict writer refuses them", () => {
    const newer = readSignatureEnvelope({ ...FOREIGN, v: 2 });
    if (!newer.ok) throw new Error(newer.reason);
    expect(newer.notes.join(" ")).toMatch(/format 2/);
    expect(() => writeSignatureEnvelope(newer.value)).toThrow(AuthorshipWriteError);

    const org = readAuthorRef({ provider: "acme.pki", subject: "acme", kind: "organization" });
    if (!org.ok) throw new Error(org.reason);
    expect(org.value.kind).toBe("organization");
    expect(org.notes.join(" ")).toMatch(/can never sign/);
  });

  it("refuses in words what can't be a signature", () => {
    const { signature: _s, ...noSignature } = FOREIGN;
    expect(readSignatureEnvelope(noSignature)).toEqual({ ok: false, reason: "A signature has no signature value." });
    expect(readSignatureEnvelope("sig")).toEqual({ ok: false, reason: "A signature must be an object." });
    const noSigner = readSignatureEnvelope({ ...FOREIGN, signer: { provider: "acme.pki" } });
    expect(noSigner.ok).toBe(false);
    expect(readSignatureEnvelope({ ...FOREIGN, certChain: "one" }).ok).toBe(false);
  });

  it("the strict writer refuses malformed digests, signatures and kept fields that shadow a known one", () => {
    const read = readSignatureEnvelope(FOREIGN);
    if (!read.ok) throw new Error(read.reason);
    expect(() => writeSignatureEnvelope({ ...read.value, payloadDigest: "sha256:XYZ" })).toThrow(/sha256:<64 lowercase hex>/);
    expect(() => writeSignatureEnvelope({ ...read.value, signature: "not base64url!" })).toThrow(/base64url/);
    expect(() => writeSignatureEnvelope({ ...read.value, signedAt: "yesterday" })).toThrow(/ISO 8601/);
    expect(() => writeSignatureEnvelope({ ...read.value, extensions: { alg: "none" } })).toThrow(/signature field/);
  });
});
