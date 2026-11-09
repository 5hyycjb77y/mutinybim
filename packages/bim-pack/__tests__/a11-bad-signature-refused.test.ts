/**
 * @jest-environment node
 *
 * Round 11 A11 (D5): the install gate refuses a package whose signature
 * doesn't check: unsigned, signed only by someone who isn't an author, a byte
 * changed after signing, or "signed" by an agent (8b: agents can't sign).
 * Nothing is recorded, so there is nothing to approve. Fails on round 10's
 * code: there was no gate.
 */
import { packageSigningPayload, readManifestJson, withPackageSignature } from "../../bim-library/src/package";
import { checkOutsidePackage } from "../src/install";
import { AGENT, LICENCES, OTHER, identity, registry, signedPackage } from "./fixtures/a11-outside";

const options = () => ({ registry: registry(), licences: LICENCES });

describe("a11 bad signature refused", () => {
  it("an unsigned package is refused", async () => {
    const outcome = await checkOutsidePackage(signedPackage({ signer: null }), options());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refused).toBe("@acme/doors 1.2.0 wasn't installed. Its signature or contents didn't check.");
    expect(outcome.checks.signature.status).toBe("fail");
  });

  it("a package signed only by someone who isn't its author is refused", async () => {
    const outcome = await checkOutsidePackage(signedPackage({ signer: OTHER }), options());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.checks.signature.problems).toContain("No author of this package signed it; only other people did.");
  });

  it("one byte changed after signing is refused", async () => {
    const pkg = signedPackage();
    const path = "addons/acme.json";
    const bytes = pkg.get(path);
    if (!bytes) throw new Error("fixture has no add-on file");
    const changed = new Uint8Array(bytes);
    changed[changed.length - 2] = changed[changed.length - 2] === 0x7d ? 0x5d : 0x7d;
    pkg.set(path, changed);
    const outcome = await checkOutsidePackage(pkg, options());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.checks.signature.problems.join(" ")).toContain("addons/acme.json has changed since the package was made");
  });

  it("an agent's signature is refused", async () => {
    const pkg = signedPackage({ signer: null });
    const manifest = readManifestJson(pkg);
    if (!manifest.ok) throw new Error(manifest.reason);
    const env = identity.sign("acme-publisher", packageSigningPayload(manifest.json));
    // An envelope that claims an agent signed it; the writer refuses to write one, so it goes in as raw JSON.
    const forged = new Map(pkg);
    forged.set("signatures/1.json", new TextEncoder().encode(JSON.stringify({ ...env, signer: AGENT })));
    const outcome = await checkOutsidePackage(forged, options());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.checks.signature.problems.join(" ")).toMatch(/Only people sign|agent/i);
    expect(() => withPackageSignature(pkg, { ...env, signer: AGENT })).toThrow();
  });

  it("a licence the firm doesn't accept is refused with what to do", async () => {
    const outcome = await checkOutsidePackage(signedPackage({ license: "GPL-3.0-only" }), options());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refused).toBe("@acme/doors 1.2.0 wasn't installed. Its licence isn't one this firm accepts.");
      expect(outcome.checks.signature.status).toBe("pass");
      expect(outcome.checks.licence.status).toBe("fail");
    }
  });
});
