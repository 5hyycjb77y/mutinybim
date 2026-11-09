import { sha256HexOf, toHex } from "@permitzip/bim-kernel";
import { PACKAGE_PATH_PATTERN } from "./manifest";

/**
 * A package's files in memory, by path inside the package. Hosts read a
 * directory or unpack a `.tgz` into this; the verifier reads nothing else.
 */
export type PackageFiles = ReadonlyMap<string, Uint8Array>;

/** Largest package this reader unpacks (a part library, not a model). */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 10_000;

/** `sha256:` of a file's bytes, as the manifest lists it. */
export function fileHash(bytes: Uint8Array): string {
  return `sha256:${sha256HexOf(bytes)}`;
}

/** Which SHA-256 hashed a package's files: the host's (Web Crypto) or the kernel's portable one. Same answers. */
export type PackageHasher = "native" | "portable";

/**
 * `fileHash` of each file, in order. Uses the host's native SHA-256 when it
 * has one (`subtle`, else `globalThis.crypto.subtle`); `subtle: null`, or a
 * runtime without Web Crypto (an insecure browser origin), uses the kernel's.
 */
export async function fileHashes(files: readonly Uint8Array[], subtle?: SubtleCrypto | null): Promise<{ readonly hashes: string[]; readonly hasher: PackageHasher }> {
  const s = subtle === null ? undefined : (subtle ?? globalThis.crypto?.subtle);
  if (!s) return { hashes: files.map(fileHash), hasher: "portable" };
  const digests = await Promise.all(files.map((bytes) => s.digest("SHA-256", bytes.slice().buffer)));
  return { hashes: digests.map((d) => `sha256:${toHex(new Uint8Array(d))}`), hasher: "native" };
}

export class PackageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageFormatError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A file's text, or a refusal in words when it isn't UTF-8. */
export function fileText(files: PackageFiles, path: string): string | null {
  const bytes = files.get(path);
  if (!bytes) return null;
  try {
    return decoder.decode(bytes);
  } catch (err) {
    throw new PackageFormatError(`${path} isn't UTF-8 text (${err instanceof Error ? err.message : String(err)}).`);
  }
}

// ── tar (POSIX ustar), so a package travels as one `.tgz` with no dependency ──

const BLOCK = 512;

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/**
 * The files of an uncompressed ustar archive. A package's archive holds one
 * top folder (`package/`, npm's habit) or none; it is stripped. Refuses
 * links, absolute or `..` paths, duplicates and anything over the caps.
 */
export function readPackageTar(archive: Uint8Array): Map<string, Uint8Array> {
  if (archive.length > MAX_PACKAGE_BYTES) throw new PackageFormatError(`The package is ${archive.length} bytes; at most ${MAX_PACKAGE_BYTES} are read.`);
  const raw: [string, Uint8Array][] = [];
  let pos = 0;
  while (pos + BLOCK <= archive.length) {
    const header = archive.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    if (readString(header, 257, 5) !== "ustar") throw new PackageFormatError("This isn't a package archive (not a ustar tar).");
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const path = prefix ? `${prefix}/${name}` : name;
    pos += BLOCK;
    if (type === "0" || type === "\0") {
      if (pos + size > archive.length) throw new PackageFormatError(`${path} runs past the end of the archive.`);
      raw.push([path, archive.slice(pos, pos + size)]);
    } else if (type !== "5" && type !== "x" && type !== "g") {
      throw new PackageFormatError(`${path} is a link or device (tar type "${type}"); a package holds plain files only.`);
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
    if (raw.length > MAX_PACKAGE_FILES) throw new PackageFormatError(`The package holds more than ${MAX_PACKAGE_FILES} files.`);
  }
  if (raw.length === 0) throw new PackageFormatError("The package archive holds no files.");
  const tops = new Set(raw.map(([p]) => p.split("/")[0]));
  const strip = tops.size === 1 && raw.every(([p]) => p.includes("/")) ? `${[...tops][0]}/` : "";
  const out = new Map<string, Uint8Array>();
  for (const [p, bytes] of raw) {
    const path = strip && p.startsWith(strip) ? p.slice(strip.length) : p;
    if (!PACKAGE_PATH_PATTERN.test(path)) throw new PackageFormatError(`"${path}" isn't a plain relative path inside the package.`);
    if (out.has(path)) throw new PackageFormatError(`${path} is in the archive twice.`);
    out.set(path, bytes);
  }
  return out;
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new PackageFormatError(`"${value}" is too long for a tar header field (${length} bytes).`);
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/**
 * A deterministic ustar archive of the files under `package/`: sorted paths,
 * time 0, owner 0, mode 644. The same files make the same bytes everywhere.
 */
export function writePackageTar(files: PackageFiles): Uint8Array {
  const paths = [...files.keys()].sort();
  const chunks: Uint8Array[] = [];
  for (const path of paths) {
    if (!PACKAGE_PATH_PATTERN.test(path)) throw new PackageFormatError(`"${path}" isn't a plain relative path inside the package.`);
    const bytes = files.get(path) ?? new Uint8Array();
    const full = `package/${path}`;
    const header = new Uint8Array(BLOCK);
    let name = full;
    let prefix = "";
    if (new TextEncoder().encode(full).length > 100) {
      const cut = full.lastIndexOf("/", 155);
      prefix = full.slice(0, cut);
      name = full.slice(cut + 1);
    }
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    writeString(header, 345, 155, prefix);
    let sum = 0;
    for (const b of header) sum += b;
    writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, bytes, new Uint8Array((BLOCK - (bytes.length % BLOCK)) % BLOCK));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** gzip / gunzip as a host gives them (the web streams in a browser and Node; `node:zlib` in a CLI). */
export interface PackageCodec {
  gzip(bytes: Uint8Array): Promise<Uint8Array>;
  gunzip(bytes: Uint8Array): Promise<Uint8Array>;
}

async function throughStream(bytes: Uint8Array, stream: { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(bytes)).then(() => writer.close()).catch((err: unknown) => console.error("[bim-library/package] stream write failed", err));
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** The web streams' gzip, where the runtime has them; null where it doesn't (pass a codec instead). */
export function webStreamsCodec(): PackageCodec | null {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined" || typeof Response === "undefined") return null;
  return {
    gzip: (bytes) => throughStream(bytes, new CompressionStream("gzip")),
    gunzip: (bytes) => throughStream(bytes, new DecompressionStream("gzip")),
  };
}

function codecOrThrow(codec: PackageCodec | undefined): PackageCodec {
  const c = codec ?? webStreamsCodec();
  if (!c) throw new PackageFormatError("This runtime has no gzip; pass a codec to read or write a .tgz package.");
  return c;
}

/** A `.tgz` package's files. */
export async function unpackPackageTgz(archive: Uint8Array, codec?: PackageCodec): Promise<Map<string, Uint8Array>> {
  if (archive.length > MAX_PACKAGE_BYTES) throw new PackageFormatError(`The package is ${archive.length} bytes; at most ${MAX_PACKAGE_BYTES} are read.`);
  return readPackageTar(await codecOrThrow(codec).gunzip(archive));
}

/** A `.tgz` of a package's files (deterministic tar; gzip as the codec writes it). */
export async function packPackageTgz(files: PackageFiles, codec?: PackageCodec): Promise<Uint8Array> {
  return codecOrThrow(codec).gzip(writePackageTar(files));
}
