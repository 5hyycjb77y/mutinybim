/**
 * The install gate (D5): one path for every outside package. In order: the
 * package's manifest, hashes and signatures (offline, X11's `verifyPackage`
 * over 8b envelopes against the identity providers its source accepts), its
 * licence against the firm's allowlist, each add-on's trust tier against the
 * host's one setting, the add-on's namespace against the package's scope, and
 * the conformance suite every first-party pack passes. A package that passes
 * waits `pending` until a person approves that exact version and build;
 * nothing here makes it usable.
 */
import type { AuthorRef, IdentityProviderRegistry } from "@permitzip/bim-kernel";
import { type Pack, type OutsidePackPin, type PackTier, CHECK_PASSED, DATA_ONLY_POLICY, checkFailed, tierProblem, type CheckResult, type HostTrustPolicy, type InstallChecks, type InstallReview } from "@permitzip/bim-kernel/packs";
import { runPackConformance } from "../conformance";
import { buildDataAddon, readDataAddonDocument } from "./data-addon";
import { libraryPackageVerifier, type OutsidePackage, type PackageVerifier } from "./package";

export interface InstallGateOptions {
  /** The identity providers the package's source accepts (its publishers' key logs). */
  readonly registry: IdentityProviderRegistry;
  /** SPDX licence ids the firm accepts. */
  readonly licences: readonly string[];
  /** The one host setting for code add-ons. Default: data only. */
  readonly policy?: HostTrustPolicy;
  /** How the host names itself in a refusal ("Acme Hub"). */
  readonly hostName?: string;
  /** Hashes and signatures. Default: X11's `verifyPackage`. */
  readonly verifier?: PackageVerifier;
  /** Packs an add-on may `require` (the host's own add-ons, other approved ones). */
  readonly with?: readonly Pack[];
}

/** One add-on the package carries, built and checked. `pack` is null for a code add-on a trusted operator loads as software. */
export interface GatedAddon {
  readonly pack: Pack | null;
  readonly pin: OutsidePackPin;
  readonly tier: PackTier;
}

export type InstallOutcome =
  | {
      readonly ok: true;
      /** `pending`: waits for a person. */
      readonly review: InstallReview;
      readonly addons: readonly GatedAddon[];
      readonly signers: readonly AuthorRef[];
    }
  | {
      readonly ok: false;
      /** One sentence a person reads first. */
      readonly refused: string;
      /** Every check as far as it ran, each failed one with its problems. */
      readonly checks: InstallChecks;
      readonly packageName: string | null;
      readonly version: string | null;
    };

/** `acme` for `@acme/doors` or `acme/doors`; null when the name has no scope. */
export function packageScope(name: string): string | null {
  const m = /^@?([a-z0-9][a-z0-9-]*)\/[a-z0-9][a-z0-9._-]*$/.exec(name);
  return m?.[1] ?? null;
}

/** An add-on's namespace must be its package's scope (hyphens as underscores), alone or followed by `_<more>`. */
export function namespaceProblem(addonId: string, packageName: string): string | null {
  const scope = packageScope(packageName);
  if (!scope) return `The package name "${packageName}" must be "@<publisher>/<name>", so its add-ons' namespace can be checked.`;
  const ns = scope.replace(/-/g, "_");
  if (addonId === ns || addonId.startsWith(`${ns}_`)) return null;
  return `The add-on "${addonId}" must be named after its publisher's scope: "${ns}" or "${ns}_<name>". A publisher can only add rows under its own name.`;
}

function mergeChecks(...checks: readonly CheckResult[]): CheckResult {
  const problems = [...new Set(checks.flatMap((c) => (c.status === "pass" ? [] : c.problems)))];
  return problems.length > 0 ? checkFailed(problems) : CHECK_PASSED;
}

/** Run every check on one package. Never throws for a broken package; refuses it with every problem. */
export async function checkOutsidePackage(pkg: OutsidePackage, options: InstallGateOptions): Promise<InstallOutcome> {
  const policy = options.policy ?? DATA_ONLY_POLICY;
  const hostName = options.hostName ?? "This host";
  const installedPacks = new Map((options.with ?? []).map((p) => [p.manifest.id, p.manifest.version] as const));
  const verification = await (options.verifier ?? libraryPackageVerifier)(pkg, { identity: options.registry, licences: options.licences, installedPacks });
  const { manifest, digest, signature, licence } = verification;
  if (!manifest || !digest) {
    const notRun: CheckResult = { status: "not_run", problems: ["Not checked: the package can't be read."] };
    return { ok: false, refused: "This package can't be read.", checks: { signature, licence: notRun, conformance: notRun }, packageName: null, version: null };
  }

  const problems: string[] = [];
  const addons: GatedAddon[] = [];
  let tierRefusal: string | null = null;
  for (const content of manifest.contents) {
    if (content.type !== "addon") continue;
    const bytes = pkg.get(content.path);
    if (!bytes) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (err) {
      console.error("[bim-pack/install] an add-on file isn't JSON", { package: manifest.name, path: content.path, err });
      problems.push(`${content.path} isn't a JSON add-on file.`);
      continue;
    }
    const read = readDataAddonDocument(parsed);
    if (!read.ok) {
      problems.push(...read.problems.map((p) => `${content.path}: ${p}`));
      continue;
    }
    const refusal = tierProblem(read.tier, policy, read.manifest.name, hostName);
    if (refusal) {
      tierRefusal = refusal;
      continue;
    }
    const ns = namespaceProblem(read.manifest.id, manifest.name);
    if (ns) problems.push(ns);
    if (read.manifest.id !== content.id) problems.push(`${content.path} is the add-on "${read.manifest.id}", but the manifest lists it as "${content.id}".`);
    if (read.manifest.version !== manifest.version) problems.push(`${read.manifest.name} says it is version ${read.manifest.version}, but the package is ${manifest.version}. They must match so a model's pin names one build.`);
    const pin: OutsidePackPin = { id: read.manifest.id, version: read.manifest.version, digest, tier: read.tier };
    if (read.tier !== "data") {
      // The trusted-operator path: the operator loads the code as software; the gate records its checks only.
      addons.push({ pack: null, pin, tier: read.tier });
      continue;
    }
    const built = buildDataAddon(read.document);
    if (!built.ok) {
      problems.push(...built.problems);
      continue;
    }
    problems.push(...runPackConformance(built.pack, { with: options.with ?? [] }).problems);
    addons.push({ pack: built.pack, pin, tier: read.tier });
  }
  const conformance = mergeChecks(verification.contents, problems.length > 0 ? checkFailed(problems) : CHECK_PASSED);
  const checks: InstallChecks = { signature, licence, conformance };
  if (tierRefusal) return { ok: false, refused: tierRefusal, checks, packageName: manifest.name, version: manifest.version };
  if (signature.status !== "pass" || licence.status !== "pass" || conformance.status !== "pass") {
    const first = signature.status !== "pass" ? "Its signature or contents didn't check." : licence.status !== "pass" ? "Its licence isn't one this firm accepts." : "It didn't pass the add-on checks.";
    return { ok: false, refused: `${manifest.name} ${manifest.version} wasn't installed. ${first}`, checks, packageName: manifest.name, version: manifest.version };
  }
  return { ok: true, review: { packageName: manifest.name, version: manifest.version, digest, checks, state: "pending" }, addons, signers: verification.signers };
}
