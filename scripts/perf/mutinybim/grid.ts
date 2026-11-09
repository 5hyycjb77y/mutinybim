/**
 * One run of `grid.scroll.10k` (SCHEDULES-PLAN §11), in one process: a 10,000
 * row, 24 column schedule grid in jsdom with React's development build (the
 * same conditions the grid's unit tests render in, so slower than a browser
 * and conservative), one unscored warm-up flick, then a scored flick of 220
 * frames at 7 rows per frame. Each frame is one synchronous React commit; its
 * wall time is the frame cost the grid adds.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/grid.ts
 *   node --expose-gc --import tsx scripts/perf/mutinybim/grid.ts --trace-gc   # adds GC time per frame to the result
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts.
 */
import { performance as nodePerformance, PerformanceObserver } from "node:perf_hooks";
import { emit, gc, memoryMB, type Sample } from "./lib";

// Before React loads: the development build is what this budget was set against.
Object.assign(process.env, { NODE_ENV: "development" });

const traceGc = process.argv.includes("--trace-gc");
const FRAMES = 240;
const WARM_FROM = 20;
const STEP_PX = 28 * 7;

interface GcEntry {
  readonly start: number;
  readonly end: number;
  readonly kind: number;
}

async function main(): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DataGrid } = await import("@permitzip/bim-grid");
  type GridColumn = import("@permitzip/bim-grid").GridColumn;
  type GridRows = import("@permitzip/bim-grid").GridRows;

  const columns: GridColumn[] = Array.from({ length: 24 }, (_, i) => ({
    id: `c${i}`,
    heading: `Field ${i}`,
    width: 110,
    editor: i === 3 ? "none" : "text",
    align: i % 2 ? "end" : "start",
  }));
  const rows: GridRows = {
    count: 10_000,
    rowAt: (i) => ({ key: `r${i}`, depth: 0, expandable: false, expanded: false }),
    cellAt: (i, c) => (c === "c3" ? { display: String(i * 3), state: "locked", lockedReason: "Calculated." } : { display: `${c}-${i}`, state: "editable" }),
  };

  const gcEntries: GcEntry[] = [];
  const observer = traceGc
    ? new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const detail = (e as unknown as { detail?: { kind?: number } }).detail;
          gcEntries.push({ start: e.startTime, end: e.startTime + e.duration, kind: detail?.kind ?? 0 });
        }
      })
    : null;
  observer?.observe({ entryTypes: ["gc"] });

  function flick(): { frames: number[]; windows: Array<[number, number]> } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    React.act(() => {
      root.render(React.createElement(DataGrid, { ariaLabel: "Perf", rows, columns, height: 900, width: 1600, frozenColumns: 1 }));
    });
    const scroller = host.querySelector(".mutiny-grid-scroller");
    if (!(scroller instanceof dom.window.HTMLElement)) throw new Error("[perf/grid] scroller missing");
    const frames: number[] = [];
    const windows: Array<[number, number]> = [];
    for (let f = 0; f < FRAMES; f++) {
      const t0 = nodePerformance.now();
      React.act(() => {
        scroller.scrollTop = (f * STEP_PX) % (28 * 9_900);
        scroller.scrollLeft = f % 60 === 59 ? 110 * 6 : scroller.scrollLeft;
        scroller.dispatchEvent(new dom.window.Event("scroll"));
      });
      const t1 = nodePerformance.now();
      frames.push(t1 - t0);
      windows.push([t0, t1]);
    }
    // A flick that never re-rendered would time nothing: the last frame's top row must be mounted.
    const lastTop = Math.floor((((FRAMES - 1) * STEP_PX) % (28 * 9_900)) / 28);
    if (!host.querySelector(`[role="row"][aria-rowindex="${lastTop + 2}"]`)) throw new Error(`[perf/grid] row ${lastTop} not mounted after the flick`);
    React.act(() => root.unmount());
    host.remove();
    return { frames: frames.slice(WARM_FROM), windows: windows.slice(WARM_FROM) };
  }

  flick(); // warm-up, not scored: the process is still compiling React, jsdom and the grid
  gc();
  gcEntries.length = 0;
  const scored = flick();
  // GC entries are delivered asynchronously; let the observer flush.
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer?.disconnect();

  const frames = scored.frames;
  const mean = frames.reduce((s, v) => s + v, 0) / frames.length;
  const samples: Sample[] = [
    { metric: "grid.scroll.10k.frame", values: frames, counts: { totalElements: 10_000 }, note: "frame time per scroll step (7 rows), 24 columns, 1 frozen, jsdom + React development build" },
    { metric: "grid.scroll.10k.mean", values: [mean], counts: { totalElements: 10_000 }, note: "mean frame time of this run's flick" },
  ];

  let gcInfo: Record<string, unknown> | undefined;
  if (traceGc) {
    const perFrameGc = scored.windows.map(([a, b]) => gcEntries.reduce((s, e) => s + Math.max(0, Math.min(b, e.end) - Math.max(a, e.start)), 0));
    const sortedIdx = frames.map((_, i) => i).sort((a, b) => (frames[a] ?? 0) - (frames[b] ?? 0));
    const slowest = sortedIdx.slice(-Math.ceil(frames.length * 0.05)).map((i) => ({ frameMs: Number((frames[i] ?? 0).toFixed(2)), gcMs: Number((perFrameGc[i] ?? 0).toFixed(2)) }));
    const kinds: Record<string, number> = {};
    for (const e of gcEntries) kinds[String(e.kind)] = (kinds[String(e.kind)] ?? 0) + 1;
    gcInfo = {
      gcEvents: gcEntries.length,
      gcEventsByKind: kinds,
      gcTotalMs: Number(perFrameGc.reduce((s, v) => s + v, 0).toFixed(2)),
      framesTotalMs: Number(frames.reduce((s, v) => s + v, 0).toFixed(2)),
      slowest5pct: slowest,
    };
  }

  emit({
    suite: "grid",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { rows: 10_000, columns: 24, frozenColumns: 1, framesScored: frames.length, rowsPerFrame: 7, react: "development", dom: "jsdom" },
    samples,
    info: { memory: memoryMB(), ...(gcInfo ? { gc: gcInfo } : {}) },
  });
}

main().catch((err: unknown) => {
  console.error("[perf/grid] failed", err);
  process.exit(1);
});
