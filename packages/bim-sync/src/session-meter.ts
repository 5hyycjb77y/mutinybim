import type { Percentiles, SessionReport } from "./protocol";

/** Samples kept per measure; a 15-minute session produces far fewer. */
const MAX_SAMPLES = 2000;

export function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { count: 0, p50: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)) };
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function push(list: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  list.push(value);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
}

export type SessionEnvironment = SessionReport["environment"];

/**
 * What one editing session measured, for the regional sessions: local preview,
 * durable commit, remote visibility and join, each as p50/p95. Remote visibility
 * compares the server's commit time with this browser's receive time, so it
 * needs the client-to-server clock offset; the heartbeat with the smallest
 * round trip gives the best estimate (its error is at most half that round trip).
 */
export class SessionMeter {
  private readonly preview: number[] = [];
  private readonly commit: number[] = [];
  private readonly remote: number[] = [];
  private readonly joins: number[] = [];
  private bestRtt: number | null = null;
  private offset: number | null = null;
  private reconnectCount = 0;

  constructor(
    readonly label: string | null,
    private readonly environment: () => SessionEnvironment = browserEnvironment,
  ) {}

  recordPreview(ms: number): void {
    push(this.preview, ms);
  }

  recordCommit(ms: number): void {
    push(this.commit, ms);
  }

  recordJoin(ms: number, reconnect: boolean): void {
    push(this.joins, ms);
    if (reconnect) this.reconnectCount += 1;
  }

  /** A heartbeat answer: client send/receive times and the server's clock when it answered. */
  recordClockSample(sentAt: number, receivedAt: number, serverTime: number): void {
    const rtt = receivedAt - sentAt;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    if (this.bestRtt !== null && rtt >= this.bestRtt) return;
    this.bestRtt = rtt;
    this.offset = serverTime - (sentAt + rtt / 2);
  }

  /** Someone else's commit arrived: server commit time (ISO) vs. now on this clock. */
  recordRemoteArrival(committedAtIso: string, receivedAt: number): void {
    if (this.offset === null) return; // no clock estimate yet: a number would be off by the whole skew
    const committedAt = Date.parse(committedAtIso);
    if (Number.isNaN(committedAt)) return;
    push(this.remote, receivedAt + this.offset - committedAt);
  }

  hasSamples(): boolean {
    return this.preview.length + this.commit.length + this.remote.length + this.joins.length > 0;
  }

  report(clientSessionId: string): SessionReport {
    return {
      label: this.label,
      clientSessionId,
      localPreview: percentiles(this.preview),
      commit: percentiles(this.commit),
      remoteVisibility: percentiles(this.remote),
      join: percentiles(this.joins),
      clockRttMs: this.bestRtt === null ? null : round(this.bestRtt),
      clockOffsetMs: this.offset === null ? null : round(this.offset),
      reconnects: this.reconnectCount,
      environment: this.environment(),
    };
  }
}

interface NetworkInformationLike {
  readonly effectiveType?: unknown;
  readonly downlink?: unknown;
  readonly rtt?: unknown;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What the browser says about itself; every field is null outside a browser. */
export function browserEnvironment(): SessionEnvironment {
  const nav: unknown = Reflect.get(globalThis, "navigator");
  const userAgent = typeof nav === "object" && nav !== null ? str(Reflect.get(nav, "userAgent"), 400) : null;
  const connection: unknown = typeof nav === "object" && nav !== null ? Reflect.get(nav, "connection") : undefined;
  const net: NetworkInformationLike = typeof connection === "object" && connection !== null ? connection : {};
  let timeZone: string | null = null;
  try {
    timeZone = str(Intl.DateTimeFormat().resolvedOptions().timeZone, 80);
  } catch (err) {
    console.error("[bim-sync] could not read the time zone for the session report", err);
  }
  return {
    userAgent,
    timeZone,
    effectiveType: str(net.effectiveType, 20),
    downlinkMbps: num(net.downlink),
    networkRttMs: num(net.rtt),
    pageCache: pageCacheState(),
  };
}

function pageCacheState(): "cold" | "warm" | null {
  const perf: unknown = Reflect.get(globalThis, "performance");
  if (typeof perf !== "object" || perf === null) return null;
  const getEntries: unknown = Reflect.get(perf, "getEntriesByType");
  if (typeof getEntries !== "function") return null;
  const entries: unknown = Reflect.apply(getEntries, perf, ["navigation"]);
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const transferSize: unknown = Reflect.get(entries[0], "transferSize");
  if (typeof transferSize !== "number") return null;
  return transferSize === 0 ? "warm" : "cold";
}

/** `?bimSession=<label>` on the page, so the facilitator can match reports to the script. */
export function sessionLabelFromPage(): string | null {
  const location: unknown = Reflect.get(globalThis, "location");
  if (typeof location !== "object" || location === null) return null;
  const search = Reflect.get(location, "search");
  if (typeof search !== "string") return null;
  const label = new URLSearchParams(search).get("bimSession");
  return label ? label.slice(0, 80) : null;
}
