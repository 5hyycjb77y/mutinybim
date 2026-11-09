/**
 * Round 11 A11 fixtures: a signed outside package holding one data add-on
 * (Acme doors: door classes, a parameter set, a zone purpose), signed through
 * the deterministic test identity provider. Test-only: that provider's
 * "signature" is a shared-secret hash.
 */
import { IdentityProviderRegistry, createTestIdentityProvider, type AuthorRef } from "@permitzip/bim-kernel";
import { assemblePackage, packageSigningPayload, readManifestJson, withPackageSignature, type PackageFiles } from "../../../bim-library/src/package";
import { DATA_ADDON_FORMAT, type DataAddonDocument } from "../../src/install/data-addon";

export const PUBLISHER = { subject: "acme-publisher", displayName: "A. Publisher", keyId: "acme-key-1", secret: "acme-secret" };
export const OTHER = { subject: "mallory", displayName: "Mallory", keyId: "mallory-key", secret: "mallory-secret" };

export const identity = createTestIdentityProvider([PUBLISHER, OTHER], "test.publishers");

export function registry(): IdentityProviderRegistry {
  return new IdentityProviderRegistry([identity.provider]);
}

export const publisherRef: AuthorRef = { provider: "test.publishers", subject: PUBLISHER.subject, kind: "person", displayName: PUBLISHER.displayName, keyId: PUBLISHER.keyId };

export const REVIEWER: AuthorRef = { provider: "host", subject: "user-reviewer", kind: "person", displayName: "R. Reviewer" };
export const AGENT: AuthorRef = { provider: "host", subject: "agent:user-reviewer:run-1", kind: "agent", displayName: "Agent", onBehalfOf: REVIEWER };

export const LICENCES = ["Apache-2.0", "MIT"] as const;

export interface AddonOptions {
  readonly id?: string;
  readonly version?: string;
  readonly classes?: number;
  readonly tier?: string;
  readonly extraContributions?: DataAddonDocument["contributions"];
}

export function doorAddon(opts: AddonOptions = {}): DataAddonDocument {
  const id = opts.id ?? "acme";
  const count = opts.classes ?? 2;
  const classes = Array.from({ length: count }, (_, i) => ({ id: `${id}.door_${i + 1}`, label: `Acme door type ${i + 1}`, discipline: "architecture", parent: "arch.door", ifc: { entity: "IfcDoor" }, description: "An outside door class from a data add-on." }));
  return {
    format: DATA_ADDON_FORMAT,
    formatVersion: 1,
    tier: opts.tier ?? "data",
    manifest: { id, name: "Acme doors", version: opts.version ?? "1.2.0", kernel: "^1.9.0", description: "Door classes from Acme." },
    contributions: [
      { point: "kernel.class", version: 1, items: classes },
      { point: "kernel.parameter_set", version: 1, items: [{ id: `${id}.door_hardware`, label: "Door hardware", parameters: [{ key: `${id}.hardware_set`, label: "Hardware set", classes: [`${id}.door_1`], valueType: "text", group: "Doors" }] }] },
      { point: "kernel.zone_purpose", version: 1, items: [{ id: `${id}.egress`, label: "Egress path" }] },
      ...(opts.extraContributions ?? []),
    ],
  };
}

const enc = new TextEncoder();

export interface PackageOptions extends AddonOptions {
  readonly name?: string;
  readonly license?: string;
  readonly signer?: typeof PUBLISHER | null;
  readonly addon?: DataAddonDocument;
}

/** A signed package holding one add-on document. */
export function signedPackage(opts: PackageOptions = {}): Map<string, Uint8Array> {
  const addon = opts.addon ?? doorAddon(opts);
  const files: PackageFiles = new Map([
    [`addons/${addon.manifest.id}.json`, enc.encode(JSON.stringify(addon))],
    ["LICENSE", enc.encode("Apache License 2.0 (test fixture)\n")],
  ]);
  const assembled = assemblePackage(
    {
      format: "mutinybim-package",
      formatVersion: 1,
      name: opts.name ?? "@acme/doors",
      version: addon.manifest.version,
      license: opts.license ?? "Apache-2.0",
      authors: [publisherRef],
      requires: { kernelContract: "^1.9.0" },
      contents: [{ type: "addon", id: addon.manifest.id, path: `addons/${addon.manifest.id}.json` }],
      rightsDeclaration: { basis: "own_work", statement: "Drawn by Acme from its own door catalogue.", declaredBy: publisherRef, declaredAt: "2026-11-02T12:00:00Z" },
    },
    files,
  );
  const signer = opts.signer === undefined ? PUBLISHER : opts.signer;
  if (!signer) return assembled;
  const manifest = readManifestJson(assembled);
  if (!manifest.ok) throw new Error(manifest.reason);
  return withPackageSignature(assembled, identity.sign(signer.subject, packageSigningPayload(manifest.json), "2026-11-02T12:00:00Z"));
}
