import { canonicalJson, type Command } from "@permitzip/bim-kernel";

const OFFSET = BigInt("0xcbf29ce484222325");
const PRIME = BigInt("0x100000001b3");

/**
 * A short fingerprint of a command exactly as the client sent it (FNV-1a,
 * 64 bits, over its canonical JSON). Stored beside the answer to an
 * idempotency key so a retry of the same change replays and a different
 * change under a reused key is refused instead of being told "saved".
 */
export function commandDigest(command: Command): string {
  const text = canonicalJson(command);
  let h = OFFSET;
  for (let i = 0; i < text.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(text.charCodeAt(i))) * PRIME);
  return h.toString(16).padStart(16, "0");
}
