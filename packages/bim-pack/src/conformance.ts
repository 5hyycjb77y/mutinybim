import {
  PACK_CONTRACT_VERSION,
  PackSet,
  PackSetError,
  contributionProblems,
  isFirstPartyPackId,
  keepsBareIds,
  manifestProblems,
  installedFirstPartyPacks,
  satisfies,
  type Pack,
} from "@permitzip/bim-kernel/packs";
import { KNOWN_POINTS, knownPoint, type KnownPoint } from "./points";

export interface ConformanceResult {
  readonly ok: boolean;
  /** Every problem, in plain words; empty when the pack conforms. */
  readonly problems: readonly string[];
}

export interface ConformanceOptions {
  /** Packs this one `requires`, to build the set with. */
  readonly with?: readonly Pack[];
  /** The contract version to check against. Default: this release's. */
  readonly contractVersion?: string;
  /** Extension points the pack itself, or a pack it builds on, declares (`declaredPoint`). */
  readonly points?: readonly KnownPoint[];
}

/**
 * The pack conformance suite: what a pack must pass before a host loads it.
 * Runs every check and lists every problem (a manifest, ids outside the
 * namespace, a contract range this release doesn't satisfy, a point this
 * release doesn't read or reads at another major, a set with the first-party
 * packs and this one that doesn't build, items missing what their point
 * calls). Never throws for a broken pack.
 */
export function runPackConformance(pack: Pack, options: ConformanceOptions = {}): ConformanceResult {
  const contract = options.contractVersion ?? PACK_CONTRACT_VERSION;
  const { manifest } = pack;
  const problems: string[] = [...manifestProblems(manifest)];
  if (!satisfies(contract, manifest.kernel)) problems.push(`pack ${manifest.id} ${manifest.version} was written for contract ${manifest.kernel}; this release is ${contract}`);
  if (!manifest.firstParty && isFirstPartyPackId(manifest.id)) problems.push(`pack id "${manifest.id}" is a first-party pack's`);
  const bare = keepsBareIds(manifest);
  for (const c of pack.contributions) {
    problems.push(...contributionProblems(manifest.id, c, bare));
    const point = knownPoint(c.pointId, options.points);
    if (!point) problems.push(`pack ${manifest.id} contributes to "${c.pointId}" (${c.pointLabel}), which this release doesn't read`);
    else if (point.version !== c.pointVersion) problems.push(`pack ${manifest.id} was written for ${point.label} v${c.pointVersion}; this release reads v${point.version}`);
  }
  let set: PackSet | null = null;
  try {
    set = PackSet.create([...installedFirstPartyPacks().filter((p) => p.manifest.id !== manifest.id), ...(options.with ?? []), pack], { contractVersion: contract });
  } catch (err) {
    if (err instanceof PackSetError) problems.push(...err.problems);
    else {
      console.error("[bim-pack] building a pack set for conformance threw", err);
      problems.push(`a set with this pack didn't build: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (set) {
    const ready = set;
    for (const point of [...KNOWN_POINTS, ...(options.points ?? [])]) {
      try {
        problems.push(...point.check(ready, manifest.id));
      } catch (err) {
        console.error(`[bim-pack] conformance check for ${point.id} threw`, err);
        problems.push(`${point.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique };
}
