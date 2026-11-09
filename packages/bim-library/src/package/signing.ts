import { canonicalBytes, payloadDigest, readSignatureEnvelope, writeSignatureEnvelope, type SignatureEnvelope } from "@permitzip/bim-kernel";
import { PackageFormatError, fileHash, fileText, type PackageFiles } from "./files";
import { PACKAGE_MANIFEST_PATH, PACKAGE_SIGNATURES_DIR, packageManifestSchema, type PackageManifestInput } from "./manifest";

/**
 * What a package signature covers (8b, unchanged): the canonical JSON bytes
 * (RFC 8785) of `mutinybim.json` exactly as written, unknown fields included,
 * so a newer publisher's field is signed too and a reader never re-shapes
 * what it checks. The manifest lists every content file's hash, so this
 * covers every byte of content. Signed shape: forever.
 */
export function packageSigningPayload(manifestJson: unknown): Uint8Array {
  return canonicalBytes(manifestJson);
}

/** The package's digest: `sha256:` of its signing payload. What a pin names (A11's `PackPin.digest`) and the registry index lists. */
export function packageDigest(manifestJson: unknown): `sha256:${string}` {
  const digest = payloadDigest(packageSigningPayload(manifestJson));
  if (!digest.startsWith("sha256:")) throw new PackageFormatError(`Unexpected digest ${digest}.`);
  return digest as `sha256:${string}`;
}

/** The parsed JSON of `mutinybim.json`, or a refusal in words. */
export function readManifestJson(files: PackageFiles): { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly reason: string } {
  let text: string | null;
  try {
    text = fileText(files, PACKAGE_MANIFEST_PATH);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (text === null) return { ok: false, reason: `The package has no ${PACKAGE_MANIFEST_PATH}.` };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: `${PACKAGE_MANIFEST_PATH} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Signature files in path order (`signatures/1.json`, `signatures/2.json`, …). */
export function signaturePaths(files: PackageFiles): string[] {
  return [...files.keys()].filter((p) => p.startsWith(PACKAGE_SIGNATURES_DIR) && p.endsWith(".json")).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export type ReadSignature = { readonly path: string; readonly ok: true; readonly envelope: SignatureEnvelope } | { readonly path: string; readonly ok: false; readonly reason: string };

export function readSignatures(files: PackageFiles): ReadSignature[] {
  return signaturePaths(files).map((path): ReadSignature => {
    try {
      const read = readSignatureEnvelope(JSON.parse(fileText(files, path) ?? "null"));
      return read.ok ? { path, ok: true, envelope: read.value } : { path, ok: false, reason: read.reason };
    } catch (err) {
      return { path, ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** The files with one more signature (`signatures/<n>.json`, the next number). The envelope must be over this package's payload. */
export function withPackageSignature(files: PackageFiles, envelope: SignatureEnvelope): Map<string, Uint8Array> {
  const manifest = readManifestJson(files);
  if (!manifest.ok) throw new PackageFormatError(manifest.reason);
  if (envelope.payloadDigest !== packageDigest(manifest.json)) throw new PackageFormatError("This signature is over something other than this package's manifest.");
  const out = new Map(files);
  out.set(`${PACKAGE_SIGNATURES_DIR}${signaturePaths(files).length + 1}.json`, new TextEncoder().encode(`${JSON.stringify(writeSignatureEnvelope(envelope), null, 2)}\n`));
  return out;
}

/**
 * Writes `mutinybim.json` for these files: each content entry's hash is
 * computed from its file (the `pack` step). Strict: the manifest must parse.
 * Any old signatures are dropped, since they no longer cover the new manifest.
 */
export function assemblePackage(manifest: Omit<PackageManifestInput, "contents"> & { readonly contents: readonly { readonly type: string; readonly id: string; readonly path: string }[] }, files: PackageFiles): Map<string, Uint8Array> {
  const contents = manifest.contents.map((c) => {
    const bytes = files.get(c.path);
    if (!bytes) throw new PackageFormatError(`The manifest lists ${c.path}, which isn't in the package.`);
    return { type: c.type, id: c.id, path: c.path, hash: fileHash(bytes) };
  });
  const full = { ...manifest, contents };
  const parsed = packageManifestSchema.safeParse(full);
  if (!parsed.success) throw new PackageFormatError(`The manifest isn't valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  const out = new Map<string, Uint8Array>();
  for (const [p, b] of files) if (!p.startsWith(PACKAGE_SIGNATURES_DIR) && p !== PACKAGE_MANIFEST_PATH) out.set(p, b);
  out.set(PACKAGE_MANIFEST_PATH, new TextEncoder().encode(`${JSON.stringify(full, null, 2)}\n`));
  return out;
}
