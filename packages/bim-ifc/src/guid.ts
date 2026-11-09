/**
 * IFC GlobalIds: 128 bits written as 22 characters of IFC's own base-64
 * alphabet (buildingSMART "IfcGloballyUniqueId"), most significant digit
 * first. The first character holds only the top two bits, so it is 0–3.
 *
 * Stable ids (KERNEL-FOUNDATION §4.3), in order of preference:
 * 1. a GlobalId the element was imported with, kept byte for byte;
 * 2. an element id that is a UUID, compressed losslessly;
 * 3. UUIDv5(project namespace, a name) for every other id: text element ids,
 *    derived and virtual ids (`lp:<host>:<port>`, typical copies), type
 *    objects, property sets and relationships (named by their sorted ends).
 *
 * Pure TypeScript (SHA-1 included), so the same bytes come out in a browser,
 * a worker and Node.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
const ALPHABET_INDEX: ReadonlyMap<string, number> = new Map([...ALPHABET].map((c, i) => [c, i]));

export const IFC_GUID_PATTERN = /^[0-3][0-9A-Za-z_$]{21}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The MutinyBIM namespace every project namespace is derived from (a fixed random UUID). */
export const MUTINYBIM_IFC_NAMESPACE = "6f1d3c2a-8b4e-5f7a-9c0d-1e2f3a4b5c6d";

export function isIfcGuid(value: unknown): value is string {
  return typeof value === "string" && IFC_GUID_PATTERN.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A UUID's 16 bytes. Throws on anything that is not a UUID. */
export function uuidBytes(uuid: string): Uint8Array {
  if (!isUuid(uuid)) throw new Error(`"${uuid}" is not a UUID`);
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(b: Uint8Array): string {
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A UUID as a 22-character IFC GlobalId. Lossless: `ifcGuidToUuid` gives it back. */
// BigInt(…) rather than literals: the app's root config targets ES2017.
const B0 = BigInt(0);
const B6 = BigInt(6);
const B8 = BigInt(8);
const B63 = BigInt(63);
const B255 = BigInt(255);

export function uuidToIfcGuid(uuid: string): string {
  let n = B0;
  for (const byte of uuidBytes(uuid)) n = (n << B8) | BigInt(byte);
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = ALPHABET.charAt(Number(n & B63)) + out;
    n >>= B6;
  }
  return out;
}

export function ifcGuidToUuid(guid: string): string {
  if (!isIfcGuid(guid)) throw new Error(`"${guid}" is not an IFC GlobalId`);
  let n = B0;
  for (const c of guid) n = (n << B6) | BigInt(ALPHABET_INDEX.get(c) ?? 0);
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & B255);
    n >>= B8;
  }
  return bytesToUuid(out);
}

/** RFC 9562 UUID version 5 (SHA-1, name-based). */
export function uuidV5(namespace: string, name: string): string {
  const ns = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  const hash = sha1(input).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(hash);
}

/** The namespace one project's derived ids live in: the project id itself when it is a UUID. */
export function projectNamespace(projectId: string): string {
  return isUuid(projectId) ? projectId.toLowerCase() : uuidV5(MUTINYBIM_IFC_NAMESPACE, `project:${projectId}`);
}

/** A derived GlobalId: UUIDv5 of the name in the project's namespace. */
export function derivedIfcGuid(namespace: string, name: string): string {
  return uuidToIfcGuid(uuidV5(namespace, name));
}

/** A relationship's GlobalId: the relationship type and its ends, sorted, so the order they were found in never matters. */
export function relationshipIfcGuid(namespace: string, relType: string, ends: readonly string[]): string {
  return derivedIfcGuid(namespace, `rel:${relType}:${[...ends].sort().join("|")}`);
}

/** SHA-1 (FIPS 180-4). Used only for UUIDv5 names, never for security. */
export function sha1(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = (w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0);
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h));
  return out;
}
