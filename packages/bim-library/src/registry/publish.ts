import { IdentityProviderRegistry } from "@permitzip/bim-kernel";
import { fileHash, type PackageCodec, unpackPackageTgz } from "../package/files";
import { readSignatures } from "../package/signing";
import { verifyPackage } from "../package/verify";
import { REGISTRY_FORMAT, REGISTRY_PROTOCOL_VERSION, RegistryClient, RegistryError, compareSemver, registryIndexSchema, registryInfoSchema, registryPaths, type RegistryIndex, type RegistryInfo, type RegistryTransport, type RegistryVersion } from "./index";

/**
 * The write side of a static registry (SCRIPTING-PROPOSAL §5.6): publish a
 * signed package, yank or unyank a version, as plain files a bucket, GitHub
 * Pages or a company file server serves. What it writes reads back through
 * `RegistryClient` unchanged.
 *
 * Publishing checks the package offline (manifest, file hashes, contents)
 * and that a person signed it. It can't check whose signature it is: that
 * needs the signer's key log, which the installer has (install verifies
 * signatures against the providers it trusts). A version never changes:
 * publishing it again with the same bytes does nothing; with other bytes it
 * is refused. Removing a version (a moderator's tombstone) is a hosted
 * registry's, not this writer's.
 */

/** Where the registry's files are written. `put` creates folders as needed. */
export interface RegistryStore extends RegistryTransport {
  put(path: string, bytes: Uint8Array): Promise<void>;
}

export interface RegistryPublishOptions {
  readonly now: () => string;
  /** The name `registry.json` gets when this is its first package ("Acme scripts"). */
  readonly registryName: string;
  readonly codec?: PackageCodec;
  readonly subtle?: SubtleCrypto | null;
}

export interface RegistryPublishResult {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  /** `already_published`: the same bytes were there; nothing was written. */
  readonly status: "published" | "already_published";
  readonly signatures: number;
}

const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

async function readInfo(store: RegistryStore, client: RegistryClient, registryName: string): Promise<RegistryInfo | null> {
  if ((await store.getText(registryPaths.info())) === null) return null;
  const info = await client.info();
  if (info.protocolVersion > REGISTRY_PROTOCOL_VERSION) throw new RegistryError("invalid", `${registryName} uses registry protocol ${info.protocolVersion}; this kit writes protocol ${REGISTRY_PROTOCOL_VERSION}. Update the kit to publish here.`);
  return info;
}

async function readIndex(client: RegistryClient, name: string): Promise<RegistryIndex> {
  try {
    return await client.index(name);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "not_found") return { name, versions: [] };
    throw err;
  }
}

async function writeIndex(store: RegistryStore, index: RegistryIndex): Promise<void> {
  const sorted = { name: index.name, versions: [...index.versions].sort((a, b) => compareSemver(a.version, b.version)) };
  registryIndexSchema.parse(sorted);
  await store.put(registryPaths.index(index.name), json(sorted));
}

/** Publishes one signed package (`.tgz` bytes) to the registry. Refusals are `RegistryError`s in words. */
export async function publishToRegistry(store: RegistryStore, tgz: Uint8Array, opts: RegistryPublishOptions): Promise<RegistryPublishResult> {
  const files = await unpackPackageTgz(tgz, opts.codec);
  // Signatures are counted here and checked by whoever installs (they hold the key logs).
  const verification = await verifyPackage(files, { identity: new IdentityProviderRegistry(), ...(opts.subtle !== undefined ? { subtle: opts.subtle } : {}) });
  const { manifest, digest } = verification;
  const c = verification.checks;
  const problems = [c.manifest, c.hashes, c.conformance].flatMap((check) => (check.status === "fail" ? check.problems : []));
  if (!manifest || !digest || problems.length > 0) throw new RegistryError("invalid", `Not published: ${problems.join(" ") || "the package can't be read."}`);
  const signatures = readSignatures(files);
  if (signatures.length === 0) throw new RegistryError("invalid", "Not published: nobody signed this package. A person among its authors signs it to publish it.");
  const unreadable = signatures.find((s) => !s.ok);
  if (unreadable && !unreadable.ok) throw new RegistryError("invalid", `Not published: ${unreadable.path} isn't a signature this kit can read (${unreadable.reason}).`);

  const client = new RegistryClient(store, opts.registryName);
  const info = await readInfo(store, client, opts.registryName);
  const index = await readIndex(client, manifest.name);
  const archive = { hash: fileHash(tgz), size: tgz.length };
  const existing = index.versions.find((v) => v.version === manifest.version);
  if (existing) {
    if (existing.digest === digest && existing.archive.hash === archive.hash) return { name: manifest.name, version: manifest.version, digest, status: "already_published", signatures: signatures.length };
    throw new RegistryError("mismatch", `${manifest.name} ${manifest.version} is already in ${info?.name ?? opts.registryName} with other contents. A published version never changes: bump the version and publish again.`);
  }
  if (!info) await store.put(registryPaths.info(), json(registryInfoSchema.parse({ format: REGISTRY_FORMAT, protocolVersion: REGISTRY_PROTOCOL_VERSION, name: opts.registryName, identityProviders: [] })));
  // The archive first: an index never lists a file that isn't there.
  await store.put(registryPaths.archive(manifest.name, manifest.version), tgz);
  const entry: RegistryVersion = { version: manifest.version, digest, archive, publishedAt: opts.now(), signatures: signatures.length };
  await writeIndex(store, { name: manifest.name, versions: [...index.versions, entry] });
  return { name: manifest.name, version: manifest.version, digest, status: "published", signatures: signatures.length };
}

/**
 * Yank (the publisher pulls a version: still usable where pinned, with a
 * warning) or unyank one. A version a moderator removed stays removed.
 */
export async function markRegistryVersion(store: RegistryStore, name: string, version: string, mark: "yank" | "unyank", opts: { readonly now: () => string; readonly reason?: string; readonly registryName: string }): Promise<RegistryVersion> {
  const client = new RegistryClient(store, opts.registryName);
  const index = await client.index(name);
  const entry = index.versions.find((v) => v.version === version);
  if (!entry) throw new RegistryError("not_found", `${opts.registryName} has no ${name} ${version}.`);
  if (entry.removed) throw new RegistryError("removed", `${name} ${version} was removed from ${opts.registryName} (${entry.removed.reason}); only its moderator can change that.`);
  const reason = opts.reason?.trim();
  const { yanked: _was, ...rest } = entry;
  const next: RegistryVersion = mark === "yank" ? { ...rest, yanked: { at: opts.now(), ...(reason ? { reason } : {}) } } : rest;
  await writeIndex(store, { name, versions: index.versions.map((v) => (v.version === version ? next : v)) });
  return next;
}
