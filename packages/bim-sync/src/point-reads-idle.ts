import { buildPointReads, pointReadsPending, type ModelState } from "@permitzip/bim-kernel";
import { withModelPacks } from "@permitzip/bim-kernel/packs";

/** Longest slice of checks run in one go while nothing else is waiting: an edit arriving meanwhile waits at most this long. */
export const POINT_READS_SLICE_MS = 6;
/** Quiet time after a save before the first slice. */
export const POINT_READS_DELAY_MS = 30;

interface IdleDeadline {
  timeRemaining(): number;
}
type IdleScheduler = (callback: (deadline: IdleDeadline) => void, options: { timeout: number }) => unknown;

function idleScheduler(): IdleScheduler | null {
  const g = globalThis as { requestIdleCallback?: IdleScheduler };
  return typeof g.requestIdleCallback === "function" ? g.requestIdleCallback.bind(globalThis) : null;
}

/**
 * Builds the head's point index after a save that skipped it (kernel
 * `buildPointReads`), a slice at a time while the process is idle: an idle
 * callback in a browser, short timer slices elsewhere. Until it is built an
 * add-on switch re-checks the whole model, so a slow build costs time, never
 * a finding.
 */
export class PointReadsBuilder {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleQueued = false;
  private running = false;
  private stopped = false;

  constructor(private readonly head: () => ModelState | null | Promise<ModelState | null>) {}

  /** After a save: build when idle (does nothing when the head keeps its index). */
  schedule(delayMs = POINT_READS_DELAY_MS): void {
    if (this.stopped || this.timer || this.idleQueued || this.running) return;
    const idle = idleScheduler();
    if (idle) {
      this.idleQueued = true;
      idle((deadline) => {
        this.idleQueued = false;
        void this.step(Math.max(1, Math.min(deadline.timeRemaining(), 3 * POINT_READS_SLICE_MS)));
      }, { timeout: 2_000 });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step(POINT_READS_SLICE_MS);
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop any pending slice (the owner is closing). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async step(budgetMs: number): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    let more = false;
    try {
      const head = await this.head();
      if (head && pointReadsPending(head)) more = !withModelPacks(head.modelId, () => buildPointReads(head, budgetMs));
    } catch (err) {
      console.error("[bim-sync] building the point index after a save failed; an add-on switch re-checks the whole model", err);
    } finally {
      this.running = false;
    }
    if (more) this.schedule(0);
  }
}
