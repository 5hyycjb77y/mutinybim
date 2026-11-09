import { payloadDigest, sameAuthor, type AuthorRef, type IdentityProviderRegistry } from "@permitzip/bim-kernel";
import { PACK_CONTRACT_VERSION, satisfies } from "@permitzip/bim-kernel/packs";
import { libraryItemIssues } from "../items/checks";
import { parseItem, type LibraryItem, type LibraryItemType } from "../schema";
import { fileHashes, fileText, type PackageFiles, type PackageHasher } from "./files";
import { PACKAGE_CONTENT_TYPES, PACKAGE_LICENSE_PATH, PACKAGE_MANIFEST_PATH, packageManifestSchema, type PackageContent, type PackageManifest } from "./manifest";
import { packageSigningPayload, readManifestJson, readSignatures } from "./signing";

/**
 * Offline package verification (round 11 X11; D5 "the checks run"). No
 * network, no clock, no file system: the host reads the package into
 * memory and hands over its identity providers (with their key logs
 * already loaded). A11's install gate calls this and stores the checks on
 * the review; IN11 shows each check with its fix.
 *
 * Signatures say who; conformance says well-formed; review says the firm
 * accepts it. None of them certify engineering.
 */

export type PackageCheckStatus = "pass" | "fail" | "skipped";

/** One check's answer, in words a reviewer can act on. */
export interface PackageCheck {
  readonly status: PackageCheckStatus;
  readonly problems: readonly string[];
  /** Facts beside a pass ("Also counter-signed by …", "Keeps a content type this reader doesn't know"). */
  readonly notes: readonly string[];
}

export interface PackageChecks {
  /** `mutinybim.json` is there and is a v1 manifest. */
  readonly manifest: PackageCheck;
  /** Every listed file is there and matches its hash; nothing unlisted besides the manifest, licence, readme and signatures. */
  readonly hashes: PackageCheck;
  /** At least one person among the manifest's authors signed it, and every signature present checks. Agents can't sign (8b). */
  readonly signature: PackageCheck;
  /** The LICENSE file is there; the manifest's licence is on the allowlist when one is given. */
  readonly licence: PackageCheck;
  /** Part types and scripts parse as library items and pass their checks. */
  readonly conformance: PackageCheck;
  /** The kernel contract range and the add-ons it names are satisfied, when the host says what it has. */
  readonly requires: PackageCheck;
}

export interface VerifyPackageOptions {
  /** The host's providers, key logs loaded. Unknown providers read "can't check", never valid. */
  readonly identity: IdentityProviderRegistry;
  /** The add-on contract version here. Absent: this kernel's. */
  readonly kernelContract?: string;
  /** Add-ons installed here, by id → version. Absent: `requires.packs` is skipped (noted). */
  readonly installedPacks?: ReadonlyMap<string, string>;
  /** SPDX ids the firm accepts. Absent: any licence (noted). */
  readonly licenceAllowlist?: readonly string[];
  /** SHA-256 for the file hashes. Absent: the host's Web Crypto when it has one; null: the kernel's portable one. */
  readonly subtle?: SubtleCrypto | null;
}

/** What one verification did. Each listed file present is hashed once; each part type and script is parsed once and checked once. */
export interface PackageVerifyWork {
  readonly filesHashed: number;
  readonly bytesHashed: number;
  readonly hasher: PackageHasher | null;
  readonly itemsParsed: number;
  readonly itemsChecked: number;
}

export interface PackageVerification {
  /** Every check passed or was skipped. */
  readonly ok: boolean;
  readonly manifest: PackageManifest | null;
  /** `sha256:` of the signing payload: what a pin names. */
  readonly digest: `sha256:${string}` | null;
  /** People whose signatures checked. */
  readonly signers: readonly AuthorRef[];
  /** Parsed part-type and script items, in manifest order. */
  readonly items: readonly LibraryItem[];
  /** Content entries of other types (an add-on; a newer type), for the installer that knows them. */
  readonly otherContents: readonly PackageContent[];
  readonly checks: PackageChecks;
  /** Every check's problems in one list, for a log line or a refusal. */
  readonly problems: readonly string[];
  readonly work: PackageVerifyWork;
}

const NO_WORK: PackageVerifyWork = { filesHashed: 0, bytesHashed: 0, hasher: null, itemsParsed: 0, itemsChecked: 0 };

const pass = (notes: readonly string[] = []): PackageCheck => ({ status: "pass", problems: [], notes });
const skipped = (note: string): PackageCheck => ({ status: "skipped", problems: [], notes: [note] });
const failed = (problems: readonly string[], notes: readonly string[] = []): PackageCheck => ({ status: problems.length > 0 ? "fail" : "pass", problems, notes });

const ALLOWED_EXTRA = new Set([PACKAGE_MANIFEST_PATH, PACKAGE_LICENSE_PATH, "README.md"]);
const ITEM_CONTENT: Readonly<Record<string, LibraryItemType>> = { part_type: "part_type", script: "script" };

function refusedEarly(reason: string): PackageVerification {
  const manifest = failed([reason]);
  const notChecked = skipped("Not checked: the manifest couldn't be read.");
  const checks: PackageChecks = { manifest, hashes: notChecked, signature: notChecked, licence: notChecked, conformance: notChecked, requires: notChecked };
  return { ok: false, manifest: null, digest: null, signers: [], items: [], otherContents: [], checks, problems: [reason], work: NO_WORK };
}

/** Checks a package as read into memory. Resolves with every check's answer; never throws for a bad package. */
export async function verifyPackage(files: PackageFiles, options: VerifyPackageOptions): Promise<PackageVerification> {
  const json = readManifestJson(files);
  if (!json.ok) return refusedEarly(json.reason);
  const parsed = packageManifestSchema.safeParse(json.json);
  if (!parsed.success) return refusedEarly(`${PACKAGE_MANIFEST_PATH} isn't a v1 package manifest: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
  const manifest = parsed.data;
  let payload: Uint8Array;
  try {
    payload = packageSigningPayload(json.json);
  } catch (err) {
    return refusedEarly(`${PACKAGE_MANIFEST_PATH} can't be signed as written: ${err instanceof Error ? err.message : String(err)}`);
  }
  const digest = payloadDigest(payload) as `sha256:${string}`;

  const { check: hashes, work: hashWork } = await checkHashes(manifest, files, options.subtle);
  const { check: signature, signers } = await checkSignatures(manifest, files, payload, options.identity);
  const licence = checkLicence(manifest, files, options.licenceAllowlist);
  const { check: conformance, items, other, parsed: itemsParsed, checked: itemsChecked } = checkContents(manifest, files, hashes.status === "pass");
  const requires = checkRequires(manifest, options);
  const checks: PackageChecks = { manifest: pass(), hashes, signature, licence, conformance, requires };
  const all: readonly PackageCheck[] = [checks.manifest, hashes, signature, licence, conformance, requires];
  return {
    ok: all.every((c) => c.status !== "fail"),
    manifest,
    digest,
    signers,
    items,
    otherContents: other,
    checks,
    problems: all.flatMap((c) => c.problems),
    work: { ...hashWork, itemsParsed, itemsChecked },
  };
}

async function checkHashes(manifest: PackageManifest, files: PackageFiles, subtle: SubtleCrypto | null | undefined): Promise<{ check: PackageCheck; work: Pick<PackageVerifyWork, "filesHashed" | "bytesHashed" | "hasher"> }> {
  const problems: string[] = [];
  const listed = new Set<string>();
  const present: { path: string; hash: string; bytes: Uint8Array }[] = [];
  for (const c of manifest.contents) {
    if (listed.has(c.path)) problems.push(`${c.path} is listed twice.`);
    listed.add(c.path);
    const bytes = files.get(c.path);
    if (!bytes) problems.push(`${c.path} is listed but isn't in the package.`);
    else present.push({ path: c.path, hash: c.hash, bytes });
  }
  const { hashes, hasher } = await fileHashes(present.map((p) => p.bytes), subtle);
  present.forEach((p, i) => {
    if (hashes[i] !== p.hash) problems.push(`${p.path} has changed since the package was made (its hash doesn't match the manifest).`);
  });
  for (const path of files.keys()) {
    if (listed.has(path) || ALLOWED_EXTRA.has(path) || path.startsWith("signatures/")) continue;
    problems.push(`${path} is in the package but not in the manifest, so no signature covers it.`);
  }
  return { check: failed(problems), work: { filesHashed: present.length, bytesHashed: present.reduce((n, p) => n + p.bytes.length, 0), hasher } };
}

async function checkSignatures(manifest: PackageManifest, files: PackageFiles, payload: Uint8Array, identity: IdentityProviderRegistry): Promise<{ check: PackageCheck; signers: AuthorRef[] }> {
  const read = readSignatures(files);
  if (read.length === 0) return { check: failed(["Nobody signed this package. A person among its authors signs it to publish it."]), signers: [] };
  const problems: string[] = [];
  const notes: string[] = [];
  const signers: AuthorRef[] = [];
  let byAuthor = false;
  for (const sig of read) {
    if (!sig.ok) {
      problems.push(`${sig.path} isn't a signature this app can read: ${sig.reason}`);
      continue;
    }
    const outcome = await identity.verifyEnvelope(sig.envelope, payload);
    if (outcome.status !== "valid") {
      problems.push(`${sig.path}: ${outcome.reason}`);
      continue;
    }
    signers.push(outcome.signer);
    if (outcome.note) notes.push(`${sig.path}: ${outcome.note}`);
    if (manifest.authors.some((a) => sameAuthor(a, outcome.signer))) byAuthor = true;
    else notes.push(`Also signed by ${outcome.signer.displayName ?? outcome.signer.subject} (${outcome.signer.provider}), who isn't one of its authors (a catalogue's counter-signature).`);
  }
  if (!byAuthor && problems.length === 0) problems.push("No author of this package signed it; only other people did.");
  return { check: failed(problems, notes), signers };
}

function checkLicence(manifest: PackageManifest, files: PackageFiles, allowlist: readonly string[] | undefined): PackageCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const text = files.get(PACKAGE_LICENSE_PATH);
  if (!text || text.length === 0) problems.push(`The package has no ${PACKAGE_LICENSE_PATH} file for ${manifest.license}.`);
  if (allowlist === undefined) notes.push("No licence list was given, so any licence passes.");
  else {
    const ids = manifest.license.split(/ (?:AND|OR|WITH) /);
    const anyOr = manifest.license.includes(" OR ");
    const ok = anyOr ? ids.some((id) => allowlist.includes(id)) : ids.every((id) => allowlist.includes(id));
    if (!ok) problems.push(`Its licence ${manifest.license} isn't on this firm's list (${allowlist.join(", ") || "empty"}).`);
  }
  return failed(problems, notes);
}

function checkContents(manifest: PackageManifest, files: PackageFiles, hashesPass: boolean): { check: PackageCheck; items: LibraryItem[]; other: PackageContent[]; parsed: number; checked: number } {
  const problems: string[] = [];
  let parsed = 0;
  let checked = 0;
  const notes: string[] = [];
  const items: LibraryItem[] = [];
  const other: PackageContent[] = [];
  const ids = new Set<string>();
  for (const c of manifest.contents) {
    if (ids.has(`${c.type}\u0000${c.id}`)) problems.push(`${c.type} ${c.id} is listed twice.`);
    ids.add(`${c.type}\u0000${c.id}`);
    const type = ITEM_CONTENT[c.type];
    if (!type) {
      other.push(c);
      if (!(PACKAGE_CONTENT_TYPES as readonly string[]).includes(c.type)) notes.push(`Keeps ${c.path}, a "${c.type}" this reader doesn't know; its hash and signature still checked.`);
      continue;
    }
    if (!files.has(c.path)) continue;
    let body: unknown;
    try {
      body = JSON.parse(fileText(files, c.path) ?? "null");
    } catch (err) {
      problems.push(`${c.path} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const item = parseItem({ type, body });
    parsed++;
    if (!item.ok) {
      problems.push(`${c.path} isn't a ${type.replace("_", " ")}: ${item.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
      continue;
    }
    if (item.item.body.id !== c.id) problems.push(`${c.path} holds item ${item.item.body.id}, but the manifest lists it as ${c.id}.`);
    for (const m of libraryItemIssues(item.item)) problems.push(`${c.path}: ${m}`);
    checked++;
    items.push(item.item);
  }
  if (!hashesPass) notes.push("Contents were read even though some hashes failed; fix the hashes first.");
  return { check: failed(problems, notes), items, other, parsed, checked };
}

function checkRequires(manifest: PackageManifest, options: VerifyPackageOptions): PackageCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const contract = options.kernelContract ?? PACK_CONTRACT_VERSION;
  if (!satisfies(contract, manifest.requires.kernelContract)) problems.push(`It needs add-on contract ${manifest.requires.kernelContract}; this is ${contract}.`);
  const packs = manifest.requires.packs ?? [];
  if (packs.length > 0 && options.installedPacks === undefined) notes.push(`Needs ${packs.join(", ")}; which add-ons are installed wasn't given, so that wasn't checked.`);
  else if (options.installedPacks) {
    for (const need of packs) {
      const at = need.indexOf("@");
      const id = at < 0 ? need : need.slice(0, at);
      const range = at < 0 ? null : need.slice(at + 1);
      const have = options.installedPacks.get(id);
      if (have === undefined) problems.push(`It needs the ${id} add-on, which isn't installed here.`);
      else if (range !== null && !satisfies(have, range)) problems.push(`It needs ${id} ${range}; ${have} is installed.`);
    }
  }
  return failed(problems, notes);
}
