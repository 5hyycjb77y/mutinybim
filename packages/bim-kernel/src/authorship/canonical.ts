/**
 * Canonical bytes and digests shared by authorship envelopes and the
 * hash-chained sign-off log (lane M's `responsibility/signoff-chain.ts`), so a
 * browser, the model server, the host app and an outside verifier hash the same
 * value to the same bytes. Synchronous and dependency-free.
 *
 * Canonical JSON follows RFC 8785 (JSON Canonicalization Scheme): object
 * members sorted by UTF-16 code units, no whitespace, strings and numbers in
 * ECMAScript `JSON.stringify` form. Values JSON can't carry exactly are
 * refused rather than guessed: non-finite numbers, lone surrogates, bigint,
 * functions, symbols, `undefined` inside arrays and non-plain objects
 * (`Date`, `Map`; pass an ISO string). An object member whose value is
 * `undefined` is left out, as `JSON.stringify` does.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ANY_SURROGATE = /[\uD800-\uDFFF]/;

/** A lone surrogate; the cheap test first, since almost no text holds a surrogate at all. */
function hasLoneSurrogate(text: string): boolean {
  return ANY_SURROGATE.test(text) && LONE_SURROGATE.test(text);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Where a refused value sits ("value.payload[2].x"), built only when something is refused. */
function pathOf(stack: readonly (string | number)[]): string {
  let out = "value";
  for (const part of stack) out += typeof part === "number" ? `[${part}]` : `.${part}`;
  return out;
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function write(value: unknown, stack: (string | number)[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${pathOf(stack)} is ${String(value)}; canonical JSON holds finite numbers only`);
      return JSON.stringify(value);
    case "string":
      if (hasLoneSurrogate(value)) throw new CanonicalJsonError(`${pathOf(stack)} has a broken character (a lone surrogate)`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        let out = "[";
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          if (i > 0) out += ",";
          stack.push(i);
          if (item === undefined) throw new CanonicalJsonError(`${pathOf(stack)} is undefined; canonical JSON has no undefined`);
          out += write(item, stack);
          stack.pop();
        }
        return `${out}]`;
      }
      if (!isPlainObject(value)) throw new CanonicalJsonError(`${pathOf(stack)} is a ${value.constructor?.name ?? "non-plain object"}; pass plain data (an ISO string for a time)`);
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(byKey);
      let out = "{";
      let first = true;
      for (const k of keys) {
        const v = record[k];
        if (v === undefined) continue;
        if (hasLoneSurrogate(k)) throw new CanonicalJsonError(`${pathOf(stack)} has a key with a broken character (a lone surrogate)`);
        stack.push(k);
        out += `${first ? "" : ","}${JSON.stringify(k)}:${write(v, stack)}`;
        stack.pop();
        first = false;
      }
      return `${out}}`;
    }
    default:
      throw new CanonicalJsonError(`${pathOf(stack)} is a ${typeof value}; canonical JSON holds null, booleans, numbers, strings, arrays and plain objects`);
  }
}

/** RFC 8785 canonical JSON text of a value. */
export function canonicalize(value: unknown): string {
  return write(value, []);
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The canonical JSON of a value as UTF-8 bytes: what a signature and a chain hash cover. */
export function canonicalBytes(value: unknown): Uint8Array {
  return utf8Bytes(canonicalize(value));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const W = new Uint32Array(64);

/** SHA-256 (FIPS 180-4) of bytes. One shared schedule buffer; no allocation per block. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = W;
  const k = K;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  outView.setUint32(20, h5);
  outView.setUint32(24, h6);
  outView.setUint32(28, h7);
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Lowercase hex of bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

/** SHA-256 of bytes, or of a string's UTF-8 bytes, as lowercase hex. */
export function sha256HexOf(input: Uint8Array | string): string {
  return toHex(sha256(typeof input === "string" ? utf8Bytes(input) : input));
}

/** The digest an envelope names for a payload: `sha256:<hex>` of its canonical bytes (bytes are taken as given). */
export function payloadDigest(payload: Uint8Array): string {
  return `sha256:${sha256HexOf(payload)}`;
}

/** `{ alg, hex }` of a `<alg>:<hex>` digest, or null when it isn't one. Any algorithm name is read; only `sha256` is computed here. */
export function parseDigest(digest: string): { readonly alg: string; readonly hex: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,31}):([0-9a-f]{16,256})$/.exec(digest);
  return m?.[1] && m[2] ? { alg: m[1], hex: m[2] } : null;
}
