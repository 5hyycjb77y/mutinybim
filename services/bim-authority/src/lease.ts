import type { PostgresCommitStore } from "./pg-store";

export type LeaseLossReason = "renewal_refused" | "renewal_deadline_passed";

export interface LeaseStats {
  renewals: number;
  renewErrors: number;
  /** Longest gap between successful renewals (ms); close to the TTL means the model nearly moved. */
  maxRenewGapMs: number;
}

/**
 * Keeps one model's lease alive. Renews every `renewMs`; the database answers
 * by its own clock. The moment a renewal is refused, or no renewal has
 * succeeded for long enough that the lease may already have run out, the
 * model is given up through `onLost` (stop commits, tell clients, release).
 *
 * The database fence is what actually stops a stale write; this keeper only
 * stops this process from trying, and hands the model on quickly.
 */
export class LeaseKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOk: number;
  private renewing = false;
  private stopped = false;
  readonly stats: LeaseStats = { renewals: 0, renewErrors: 0, maxRenewGapMs: 0 };

  constructor(
    private readonly modelId: string,
    private readonly store: Pick<PostgresCommitStore, "renewLease">,
    private readonly ttlMs: number,
    private readonly renewMs: number,
    private readonly onLost: (reason: LeaseLossReason) => void,
    private readonly clock: () => number = () => performance.now(),
    /**
     * Drills only: false stops renewing and stops the local deadline, so the lease
     * lapses while this process still believes it owns the model and only the
     * database's write fence stands in the way.
     */
    private readonly processChecks: () => boolean = () => true,
  ) {
    this.lastOk = clock();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.renewMs);
  }

  /**
   * True while a renewal succeeded recently enough that the lease cannot have
   * expired yet on the database clock (one renewal interval of margin).
   */
  fresh(): boolean {
    if (!this.processChecks()) return !this.stopped;
    return !this.stopped && this.clock() - this.lastOk < this.ttlMs - this.renewMs;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.renewing || !this.processChecks()) return;
    // Checked before renewing: after a pause the first thing this process knows is how long it was gone.
    if (!this.fresh()) {
      this.lose("renewal_deadline_passed");
      return;
    }
    this.renewing = true;
    try {
      const ok = await this.store.renewLease();
      if (this.stopped) return;
      if (!ok) {
        this.lose("renewal_refused");
        return;
      }
      const now = this.clock();
      this.stats.renewals += 1;
      this.stats.maxRenewGapMs = Math.max(this.stats.maxRenewGapMs, Math.round(now - this.lastOk));
      this.lastOk = now;
    } catch (err) {
      this.stats.renewErrors += 1;
      console.error("[bim-authority] lease renewal failed; will retry until the deadline", { modelId: this.modelId, err });
      if (!this.fresh()) this.lose("renewal_deadline_passed");
    } finally {
      this.renewing = false;
    }
  }

  private lose(reason: LeaseLossReason): void {
    if (this.stopped) return;
    this.stop();
    this.onLost(reason);
  }
}
