import { z } from "zod";
import { contentHash, isoTime, semver, text } from "../item-base";
import { fileHash, type PackageCodec, unpackPackageTgz } from "../package/files";
import { splitPackageName } from "../package/manifest";
import { verifyPackage, type PackageVerification, type VerifyPackageOptions } from "../package/verify";

/**
 * The registry protocol's static read side (round 11 X11; SCRIPTING-PROPOSAL
 * §5.6): plain files anyone can host (a bucket, GitHub Pages, a company
 * file server). Content addressing makes mirrors safe: a package is the
 * same wherever it comes from, or it fails its hash.
 *
 *   /registry.json                          who runs it, what it accepts
 *   /index/<scope>/<name>.json              every version: digest, archive hash and size, yanked / removed
 *   /packages/<scope>/<name>/<version>.tgz
 *
 * This reader opens no connection: the host passes a `RegistryTransport`
 * (fetch with its own egress rules, a file reader, a test map). Publish,
 * report, yank and remove are a hosted registry's dynamic endpoints (round 12).
 */

export const REGISTRY_FORMAT = "mutinybim-registry";
export const REGISTRY_PROTOCOL_VERSION = 1;

export const registryInfoSchema = z.object({
  format: z.literal(REGISTRY_FORMAT),
  protocolVersion: z.number().int().min(1),
  name: text(120),
  /** Where its moderation and takedown policy is written. */
  moderationPolicyUrl: z.url().max(500).optional(),
  /** Identity providers whose signatures it accepts, with where their key logs and checkpoints live. */
  identityProviders: z
    .array(z.object({ id: text(64), label: text(120).optional(), keyLogUrl: z.url().max(500), checkpointUrl: z.url().max(500).optional() }))
    .max(50),
});
export type RegistryInfo = z.infer<typeof registryInfoSchema>;

const notice = z.object({ at: isoTime, reason: text(500).optional() });

export const registryVersionSchema = z.object({
  version: semver,
  /** The package digest (`packageDigest` of its manifest): what pins name. */
  digest: contentHash,
  /** `sha256:` and size of the `.tgz` bytes, checked before unpacking. */
  archive: z.object({ hash: contentHash, size: z.number().int().positive() }),
  publishedAt: isoTime,
  /** How many signatures it carries (they live in the package). */
  signatures: z.number().int().min(0).optional(),
  /** The publisher pulled it: still usable where pinned, with a warning. */
  yanked: notice.optional(),
  /** A moderator removed it (malicious, licence): blocked, kept here as a tombstone. */
  removed: notice.extend({ reason: text(500) }).optional(),
});
export type RegistryVersion = z.infer<typeof registryVersionSchema>;

export const registryIndexSchema = z.object({
  name: z.string().refine((n) => splitPackageName(n) !== null, "a package name such as @acme-mech/fan-coils"),
  versions: z.array(registryVersionSchema).max(10_000),
});
export type RegistryIndex = z.infer<typeof registryIndexSchema>;

export const registryPaths = {
  info: () => "registry.json",
  index: (packageName: string) => {
    const n = splitPackageName(packageName);
    if (!n) throw new RegistryError("invalid", `"${packageName}" isn't a package name (@scope/name).`);
    return `index/${n.scope}/${n.name}.json`;
  },
  archive: (packageName: string, version: string) => {
    const n = splitPackageName(packageName);
    if (!n) throw new RegistryError("invalid", `"${packageName}" isn't a package name (@scope/name).`);
    return `packages/${n.scope}/${n.name}/${version}.tgz`;
  },
};

/** How the host reads the registry's files. Absent file: null. Anything else that fails: throw (it is reported as `unavailable`). */
export interface RegistryTransport {
  getText(path: string): Promise<string | null>;
  getBytes(path: string): Promise<Uint8Array | null>;
}

export type RegistryErrorCode = "not_found" | "invalid" | "unavailable" | "removed" | "mismatch";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

export type VersionStatus = "available" | "yanked" | "removed";

export function versionStatus(v: RegistryVersion): VersionStatus {
  return v.removed ? "removed" : v.yanked ? "yanked" : "available";
}

/** A registry read through its transport. */
export class RegistryClient {
  constructor(
    private readonly transport: RegistryTransport,
    /** What the registry is called in messages ("Acme parts catalogue"). */
    private readonly label: string,
  ) {}

  private async json<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> {
    let raw: string | null;
    try {
      raw = await this.transport.getText(path);
    } catch (err) {
      console.error("[bim-library/registry] read failed", { registry: this.label, path, err });
      throw new RegistryError("unavailable", `${this.label} couldn't be reached for ${what}. Try again.`);
    }
    if (raw === null) throw new RegistryError("not_found", `${this.label} has no ${what}.`);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new RegistryError("invalid", `${this.label}'s ${what} isn't valid JSON (${err instanceof Error ? err.message : String(err)}).`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RegistryError("invalid", `${this.label}'s ${what} isn't in the registry format: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
    return parsed.data;
  }

  async info(): Promise<RegistryInfo> {
    const info = await this.json(registryPaths.info(), registryInfoSchema, "registry.json");
    if (info.protocolVersion > REGISTRY_PROTOCOL_VERSION) console.warn("[bim-library/registry] newer protocol; reading the v1 fields", { registry: this.label, protocolVersion: info.protocolVersion });
    return info;
  }

  async index(packageName: string): Promise<RegistryIndex> {
    const index = await this.json(registryPaths.index(packageName), registryIndexSchema, `index for ${packageName}`);
    if (index.name !== packageName) throw new RegistryError("mismatch", `${this.label}'s index for ${packageName} names ${index.name}.`);
    return index;
  }

  /** The newest version that isn't yanked or removed (semver order), or null. */
  async latest(packageName: string): Promise<RegistryVersion | null> {
    const usable = (await this.index(packageName)).versions.filter((v) => versionStatus(v) === "available");
    return usable.sort((a, b) => compareSemver(b.version, a.version))[0] ?? null;
  }

  /**
   * Downloads one version, checks the archive's hash and size, unpacks it,
   * verifies it offline and checks its digest is the one the index lists.
   * A removed version is refused before download; a yanked one is read and
   * its status returned for the warning.
   */
  async fetchVersion(packageName: string, version: string, verify: VerifyPackageOptions, codec?: PackageCodec): Promise<{ readonly status: VersionStatus; readonly entry: RegistryVersion; readonly verification: PackageVerification }> {
    const entry = (await this.index(packageName)).versions.find((v) => v.version === version);
    if (!entry) throw new RegistryError("not_found", `${this.label} has no ${packageName} ${version}.`);
    if (entry.removed) throw new RegistryError("removed", `${packageName} ${version} was removed from ${this.label}: ${entry.removed.reason}`);
    let bytes: Uint8Array | null;
    try {
      bytes = await this.transport.getBytes(registryPaths.archive(packageName, version));
    } catch (err) {
      console.error("[bim-library/registry] download failed", { registry: this.label, packageName, version, err });
      throw new RegistryError("unavailable", `${this.label} couldn't send ${packageName} ${version}. Try again.`);
    }
    if (!bytes) throw new RegistryError("not_found", `${this.label} lists ${packageName} ${version} but has no file for it.`);
    if (bytes.length !== entry.archive.size || fileHash(bytes) !== entry.archive.hash) throw new RegistryError("mismatch", `${packageName} ${version} from ${this.label} isn't the file its index lists (hash or size differs).`);
    const files = await unpackPackageTgz(bytes, codec);
    const verification = await verifyPackage(files, verify);
    if (verification.digest !== null && verification.digest !== entry.digest) throw new RegistryError("mismatch", `${packageName} ${version} from ${this.label} has digest ${verification.digest}, not the ${entry.digest} its index lists.`);
    return { status: versionStatus(entry), entry, verification };
  }
}

/** Semver precedence (no build metadata): negative when a < b. */
export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.split("+")[0]?.split(/-([\s\S]*)/) ?? [];
    return { nums: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
