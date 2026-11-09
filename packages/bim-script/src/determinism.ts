import { canonicalJson, sha256, sha256HexOf, utf8Bytes } from "@permitzip/bim-kernel";
import type { ScriptValue } from "@permitzip/bim-library";

/**
 * Deterministic ids and randomness (SCRIPTING-PROPOSAL §5.1). The same
 * script, values and slice revision give the same ids and the same random
 * draws, byte for byte, on a laptop, in a sandbox and in CI: what makes
 * "regenerate" and install-time reproduction possible.
 */

export interface RunSeed {
  /** The script's content hash (`sha256:`). */
  readonly scriptHash: string;
  readonly values: Readonly<Record<string, ScriptValue>>;
  /** The slice's revision. */
  readonly revision: number;
}

/** `<prefix>-<16 hex>` from (script hash, values, revision, call counter). Ids differ across scripts, values and revisions. */
export function deterministicId(seed: RunSeed, counter: number, prefix = "s"): string {
  return `${prefix}-${sha256HexOf(canonicalJson([seed.scriptHash, seed.values, seed.revision, counter])).slice(0, 16)}`;
}

/** A seeded generator (sfc32 over a SHA-256 of the seed): `next()` in [0, 1). */
export function seededRandom(seed: RunSeed, stream = "random"): () => number {
  const h = sha256(utf8Bytes(canonicalJson([seed.scriptHash, seed.values, seed.revision, stream])));
  const word = (i: number) => (((h[i] ?? 0) << 24) | ((h[i + 1] ?? 0) << 16) | ((h[i + 2] ?? 0) << 8) | (h[i + 3] ?? 0)) >>> 0;
  let a = word(0);
  let b = word(4);
  let c = word(8);
  let d = word(12);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
