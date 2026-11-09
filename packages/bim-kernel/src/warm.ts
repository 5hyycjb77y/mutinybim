import { isFullyDerived } from "./derived";
import { knownConsistent, knownValid, networkOf } from "./network";
import { warmPartitionIndex } from "./partition";
import type { ModelState } from "./types";
import { buildPointReads, validateModel } from "./validate";

export interface WarmTimings {
  readonly indexMs: number;
  readonly partitionsMs: number;
  readonly derivedMs: number;
  readonly validateMs: number;
  /** Which add-on contributions each check reads (what an add-on switch re-checks from), built after the check. */
  readonly pointReadsMs: number;
}

/**
 * Do the one-time work a freshly loaded head needs before its first commit or
 * join: the topology and area indexes, and the full derive/validate check that
 * lets later commits re-check only what they touch. Same facts the first commit
 * would establish lazily, just paid before anyone is waiting, and the point
 * index a save would otherwise build after itself.
 */
export function warmModel(model: ModelState): WarmTimings {
  const t0 = performance.now();
  networkOf(model);
  const t1 = performance.now();
  warmPartitionIndex(model);
  const t2 = performance.now();
  knownConsistent(model, () => isFullyDerived(model));
  const t3 = performance.now();
  knownValid(model, () => validateModel(model).length === 0);
  const t4 = performance.now();
  buildPointReads(model);
  const t5 = performance.now();
  return { indexMs: t1 - t0, partitionsMs: t2 - t1, derivedMs: t3 - t2, validateMs: t4 - t3, pointReadsMs: t5 - t4 };
}
