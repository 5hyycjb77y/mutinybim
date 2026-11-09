/**
 * What the install gate reads from a package (D5). The package format
 * (`mutinybim.json`, signing payload, `verifyPackage`) is X11's, in
 * `packages/bim-library/src/package/**`; the gate calls that verifier and
 * reads its checks in the shape a review stores (`InstallChecks`).
 *
 * Binding line: the relative import below becomes
 * `import { verifyPackage, ... } from "@permitzip/bim-library"` once the
 * coordinator exports `./package` from bim-library's index.
 */
import type { AuthorRef, IdentityProviderRegistry } from "@permitzip/bim-kernel";
import { PACKAGE_MANIFEST_PATH, verifyPackage, type PackageCheck, type PackageFiles, type PackageManifest } from "../../../bim-library/src/package";
import type { PackDigest, CheckResult } from "@permitzip/bim-kernel/packs";

export { PACKAGE_MANIFEST_PATH, type PackageFiles, type PackageManifest };

/** A package as read into memory: `mutinybim.json`, `LICENSE`, `signatures/*.json` and every content file, by path. */
export type OutsidePackage = PackageFiles;

/** What verifying a package (offline) found, in the shape the gate and a review read. */
export interface PackageVerification {
  readonly manifest: PackageManifest | null;
  /** What the signatures cover and what a pin stores. */
  readonly digest: PackDigest | null;
  /** The manifest, every content hash and at least one author's valid signature. */
  readonly signature: CheckResult;
  /** The licence file and the firm's allowlist. */
  readonly licence: CheckResult;
  /** Part types and scripts as library items, and the contract range and add-ons the package requires. */
  readonly contents: CheckResult;
  readonly signers: readonly AuthorRef[];
}

export interface PackageVerifyContext {
  /** The identity providers the package's source accepts, key logs loaded. */
  readonly identity: IdentityProviderRegistry;
  readonly licences: readonly string[];
  /** Add-ons installed here, id → version, for `requires.packs`. */
  readonly installedPacks?: ReadonlyMap<string, string>;
}

export type PackageVerifier = (pkg: OutsidePackage, context: PackageVerifyContext) => Promise<PackageVerification>;

function merged(checks: readonly PackageCheck[]): CheckResult {
  const problems = checks.flatMap((c) => (c.status === "fail" ? c.problems : []));
  return problems.length > 0 ? { status: "fail", problems } : { status: "pass", problems: [] };
}

/** X11's `verifyPackage`, read as the review's three checks. */
export const libraryPackageVerifier: PackageVerifier = async (pkg, context) => {
  const v = await verifyPackage(pkg, { identity: context.identity, licenceAllowlist: context.licences, ...(context.installedPacks ? { installedPacks: context.installedPacks } : {}) });
  return {
    manifest: v.manifest,
    digest: v.digest,
    signature: merged([v.checks.manifest, v.checks.hashes, v.checks.signature]),
    licence: merged([v.checks.licence]),
    contents: merged([v.checks.conformance, v.checks.requires]),
    signers: v.signers,
  };
};
