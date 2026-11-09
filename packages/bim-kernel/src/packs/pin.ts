/**
 * What a model stores to say which add-on it uses (D5, round 11 A11): the
 * add-on's id and exact version, and for an outside add-on the digest of the
 * package that was reviewed and the trust tier it was installed at. A project
 * stays on what it used: a newer version is offered through update review,
 * never applied by itself, and a build with another digest is not the add-on
 * the model pinned.
 *
 * Stored shape, forever after the release: readers are tolerant (a pin from
 * before digests reads as id and version only; fields a newer writer added are
 * kept), writers are strict. Imports nothing but `ids.ts`-level data.
 */

/** Peers that read and store `digest` / `tier` on pins. A writer emits them only to a peer that lists it. */
export const PACKS_OUTSIDE_PINS_FEATURE = "packs:outside_pins";

/** `sha256:<64 lowercase hex>`. */
export type PackDigest = `sha256:${string}`;

/**
 * How much an add-on is trusted to do. `data`: rows only (classes, parameter
 * sets, tables, zone purposes …), no code runs. `code`: it runs code, which a
 * host loads only as trusted software its operator installed. Open: a newer
 * tier reads as one this release doesn't load.
 */
export type PackTier = "data" | "code" | (string & {});

export const PACK_TIERS = ["data", "code"] as const;

/** What a model stores to say which packs it uses (`ModelSettings.packs`). */
export interface PackPin {
  readonly id: string;
  readonly version: string;
  /** The reviewed package's digest. Absent on pins written before round 11 and on add-ons the host ships itself. */
  readonly digest?: PackDigest;
  /** The tier it was installed at. Absent where `digest` is. */
  readonly tier?: PackTier;
  /** Fields a newer writer added, kept as written. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** An outside add-on's pin: always with its digest and tier. */
export interface OutsidePackPin extends PackPin {
  readonly digest: PackDigest;
  readonly tier: PackTier;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KNOWN_FIELDS = new Set(["id", "version", "digest", "tier"]);

export function isPackDigest(value: unknown): value is PackDigest {
  return typeof value === "string" && DIGEST.test(value);
}

export function isOutsidePin(pin: PackPin): pin is OutsidePackPin {
  return pin.digest !== undefined && pin.tier !== undefined;
}

/** A pin's text for keys and logs: `id@version` plus the digest's first 12 characters when it has one. */
export function pinKey(pin: PackPin): string {
  return pin.digest ? `${pin.id}@${pin.version}#${pin.digest.slice(7, 19)}` : `${pin.id}@${pin.version}`;
}

/** Same add-on, same version, and the same build when both say which. */
export function samePin(a: PackPin, b: PackPin): boolean {
  return a.id === b.id && a.version === b.version && (a.digest === undefined || b.digest === undefined || a.digest === b.digest);
}

export type PinRead = { readonly ok: true; readonly pin: PackPin; readonly notes: readonly string[] } | { readonly ok: false; readonly reason: string };

/**
 * Tolerant reader for one stored pin. Keeps a digest of another algorithm or
 * an unknown tier (said in a note, and such a pin opens nothing it can't
 * check), and any extra field. Refuses only what can't be a pin.
 */
export function readStoredPackPin(value: unknown): PinRead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "An add-on pin must be an object." };
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") return { ok: false, reason: "An add-on pin has no add-on id." };
  if (typeof raw.version !== "string" || raw.version === "") return { ok: false, reason: `The pin for ${raw.id} has no version.` };
  const notes: string[] = [];
  let digest: PackDigest | undefined;
  if (raw.digest !== undefined) {
    if (isPackDigest(raw.digest)) digest = raw.digest;
    else notes.push(`The pin for ${raw.id} ${raw.version} names its build as "${String(raw.digest)}", which this release can't check; it is kept and the add-on isn't loaded.`);
  }
  let tier: PackTier | undefined;
  if (raw.tier !== undefined) {
    if (typeof raw.tier === "string" && raw.tier !== "") tier = raw.tier;
    else notes.push(`The pin for ${raw.id} ${raw.version} has an unreadable trust tier; it is kept as written.`);
  }
  const extensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!KNOWN_FIELDS.has(k)) extensions[k] = v;
  if (digest === undefined && raw.digest !== undefined) extensions.digest = raw.digest;
  if (tier === undefined && raw.tier !== undefined) extensions.tier = raw.tier;
  if (tier !== undefined && !(PACK_TIERS as readonly string[]).includes(tier)) notes.push(`${raw.id} ${raw.version} was installed at trust tier "${tier}", which this release doesn't load.`);
  return {
    ok: true,
    notes,
    pin: { id: raw.id, version: raw.version, ...(digest ? { digest } : {}), ...(tier ? { tier } : {}), ...(Object.keys(extensions).length > 0 ? { extensions } : {}) },
  };
}

/**
 * A stored pin list, each pin read tolerantly. A list that isn't a list is
 * reported and dropped (`undefined`); a single unreadable pin is reported and
 * left out, never half-read.
 */
export function readStoredPackPins(raw: unknown): readonly PackPin[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.error("[bim-kernel/packs] model settings `packs` is not a list of pins; ignoring it", { packs: raw });
    return undefined;
  }
  const out: PackPin[] = [];
  for (const value of raw) {
    const read = readStoredPackPin(value);
    if (!read.ok) {
      console.error("[bim-kernel/packs] an add-on pin can't be read; leaving it out", { reason: read.reason, pin: value });
      continue;
    }
    out.push(read.pin);
  }
  return out;
}

export class PackPinWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackPinWriteError";
  }
}

/** Strict writer: a digest is `sha256:` hex and comes with a tier; kept extensions go back unchanged. */
export function writePackPin(pin: PackPin): Record<string, unknown> {
  if (pin.id === "" || pin.version === "") throw new PackPinWriteError("An add-on pin needs an id and a version.");
  if (pin.digest !== undefined && !isPackDigest(pin.digest)) throw new PackPinWriteError(`The pin for ${pin.id} ${pin.version} must name its build as sha256:<64 lowercase hex>.`);
  if ((pin.digest === undefined) !== (pin.tier === undefined)) throw new PackPinWriteError(`The pin for ${pin.id} ${pin.version} must carry its digest and its trust tier together.`);
  const out: Record<string, unknown> = { id: pin.id, version: pin.version };
  if (pin.digest !== undefined) out.digest = pin.digest;
  if (pin.tier !== undefined) out.tier = pin.tier;
  for (const [k, v] of Object.entries(pin.extensions ?? {})) {
    if (KNOWN_FIELDS.has(k)) throw new PackPinWriteError(`A kept pin field can't be named "${k}".`);
    out[k] = v;
  }
  return out;
}

/** "This model needs add-on Door library 1.2.0" (by display name when the host knows it). */
export function needsAddonWords(pin: PackPin, name?: string): string {
  return `This model needs add-on ${name ?? pin.id} ${pin.version}`;
}
