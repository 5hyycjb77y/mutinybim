import { oneLineItemsExtent, oneLineTextHeight } from "@permitzip/bim-kernel";
import type { DiagramEdge, DiagramNode, ElementId, OneLineItem, OneLineTextLine, RiserLevel, Vec2 } from "@permitzip/bim-kernel";
import type { PipeRef, PipingLayout, PipingLayoutOptions } from "./piping-layout";

/**
 * ASPE-standard Domestic Water Riser Diagram layout (Cold Water + Hot Water + HWR):
 * - Merges shared fixtures by `elementId` per floor so every lavatory/sink is drawn ONCE
 *   with its SOLID cold-water drop on the left and its DASHED hot-water drop on the right.
 * - Separates CW-only fixtures (left) from CW+HW fixtures (right) and gives multi-story
 *   CW and HW risers dedicated vertical shaft lanes — eliminating line tangles and text collisions.
 * - Uses unmistakable ASPE symbols: circular Water Meter (M), double-check Backflow/RPZ bowtie,
 *   domed cylindrical Water Heater tank, inline shut-off valve bowtie (SOV), and end caps (CAP) —
 *   never mystery diamonds for pipe reducers.
 * - Keeps every pipe piece clickable via `pipes` and every node/label draggable via `ranges`/`entries`.
 */

const ROW = 76;
const LEFT = 38;
const COL = 23;
const DEVICE_STEP = 22;
const SHAFT_W = 24;
const SYMBOL_W = 10;
const SYMBOL_H = 5.5;
const TANK_W = 12;
const TANK_H = 13;
/** A pipe up to 4 ft under a floor belongs to that floor. */
const TOLERANCE_MM = 1219;

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

export function isDomesticWaterKind(kind: string): boolean {
  return kind === "domestic_cold_water" || kind === "domestic_hot_water" || kind === "domestic_hot_water_return";
}

function bandOf(levels: readonly RiserLevel[], z: number | undefined, levelId: string | null): number {
  if (z === undefined) {
    const i = levels.findIndex((l) => l.id === levelId);
    return i >= 0 ? i : levels.length;
  }
  for (let i = 0; i < levels.length; i++) if ((levels[i] as RiserLevel).elevationMm <= z + TOLERANCE_MM) return i;
  return Math.max(0, levels.length - 1);
}

function parseLoadNumber(load: string | undefined): number {
  if (!load) return 0;
  const m = load.replace(/,/g, "").match(/[\d.]+/);
  return m ? Number(m[0]) : 0;
}

function formatWfu(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${r.toLocaleString("en-US")} WFU`;
}

function isCapOrOpen(n: DiagramNode): boolean {
  const u = n.name.toUpperCase();
  return u === "CAP" || u === "OPEN END";
}

function isHeaterNode(n: DiagramNode): boolean {
  if (n.children.some((c) => c.service === "domestic_hot_water" || c.service === "domestic_hot_water_return")) return true;
  const u = n.name.toUpperCase();
  return /^G?WH\b|^WH-|^EWH\b|^DWH\b/.test(u) || u.includes("WATER HEATER");
}

function deviceKindOf(name: string): "meter" | "rpz" | "valve" | "generic" {
  const n = name.toLowerCase();
  if (n.includes("mtr") || n.includes("meter") || /^wm\b|^wm-/.test(n)) return "meter";
  if (n.includes("rpz") || n.includes("backflow") || n.includes("bfp")) return "rpz";
  if (n.includes("valve") || n.includes("sov") || n.includes("prv") || n.includes("regulator") || n.includes("cock")) return "valve";
  return "generic";
}

function deviceLabelText(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("regulator") || n === "prv" || n.includes("pressure reducing")) return "PRV";
  if ((n.includes("valve") || n.includes("cock")) && !n.includes("rpz") && !n.includes("backflow")) return "SOV";
  return name.toUpperCase().slice(0, 12);
}

interface FixtureDrop {
  readonly node: DiagramNode;
  readonly edge: DiagramEdge | undefined;
  readonly devices: readonly DiagramNode[];
  readonly service: string;
}

interface MergedFixture {
  readonly key: string;
  readonly elementId: ElementId | null;
  readonly band: number;
  cw?: FixtureDrop;
  hw?: FixtureDrop;
  readonly order: number;
}

interface FloorBranchInfo {
  size?: string;
  load?: string;
  loadNum: number;
  edge?: DiagramEdge;
  hasCap: boolean;
  capNode?: DiagramNode;
}

interface ExtractedWaterNetwork {
  readonly root: DiagramNode;
  readonly rootBand: number;
  readonly entryDevices: DiagramNode[];
  readonly entryEdge: DiagramEdge | undefined;
  readonly serviceSize: string | undefined;
  readonly mainSizeAfterEntry: string | undefined;
  readonly cwTotalLoad: string | undefined;
  readonly hwTotalLoad: string | undefined;
  readonly hwTotalSize: string | undefined;
  readonly heaters: Array<{ readonly node: DiagramNode; readonly band: number; readonly cwEdge: DiagramEdge | undefined; readonly hwRootEdge: DiagramEdge | undefined; readonly cwDevices: readonly DiagramNode[] }>;
  readonly fixturesByBand: Map<number, MergedFixture[]>;
  readonly cwFloorInfo: Map<number, FloorBranchInfo>;
  readonly hwFloorInfo: Map<number, FloorBranchInfo>;
  readonly hasHot: boolean;
  readonly usedUnknown: boolean;
}

function extractWaterNetwork(root: DiagramNode, levels: readonly RiserLevel[]): ExtractedWaterNetwork {
  let usedUnknown = false;
  const band = (n: DiagramNode): number => {
    const b = bandOf(levels, n.at?.z, n.levelId);
    if (b >= levels.length) usedUnknown = true;
    return b;
  };
  const rootBand = band(root);
  const entryDevices: DiagramNode[] = [];
  let entryEdge: DiagramEdge | undefined;
  let serviceSize: string | undefined;
  let mainSizeAfterEntry: string | undefined;
  let cwTotalLoad: string | undefined;
  let cwTotalNum = 0;
  let hwTotalLoad: string | undefined;
  let hwTotalSize: string | undefined;
  let hwTotalNum = 0;
  const heaters: ExtractedWaterNetwork["heaters"] = [];
  const mergedMap = new Map<string, MergedFixture>();
  const cwFloorInfo = new Map<number, FloorBranchInfo>();
  const hwFloorInfo = new Map<number, FloorBranchInfo>();
  let orderSeq = 0;
  let hasHot = root.service === "domestic_hot_water" || root.service === "domestic_hot_water_return";

  const ensureFloor = (map: Map<number, FloorBranchInfo>, b: number): FloorBranchInfo => {
    let info = map.get(b);
    if (!info) {
      info = { loadNum: 0, hasCap: false };
      map.set(b, info);
    }
    return info;
  };

  /** Record a pipe actually serving floor `b` (never overwriting with an upstream trunk from a lower floor). */
  const recordFloorPipe = (map: Map<number, FloorBranchInfo>, b: number, edge: DiagramEdge | undefined) => {
    if (!edge) return;
    const info = ensureFloor(map, b);
    const n = parseLoadNumber(edge.load);
    if (!info.edge || n > info.loadNum) {
      if (n > info.loadNum) {
        info.loadNum = n;
        if (edge.load) info.load = edge.load;
      }
      if (edge.label) info.size = edge.label;
      info.edge = edge;
    } else if (!info.size && edge.label) {
      info.size = edge.label;
      info.edge = edge;
    }
  };

  const addFixture = (n: DiagramNode, edge: DiagramEdge | undefined, dropDevices: readonly DiagramNode[], isHot: boolean) => {
    const b = band(n);
    const floorMap = isHot ? hwFloorInfo : cwFloorInfo;
    if (isCapOrOpen(n)) {
      const info = ensureFloor(floorMap, b);
      if (n.name.toUpperCase() === "CAP") {
        info.hasCap = true;
        info.capNode = n;
      }
      return;
    }
    // Merge by elementId first, or by matching fixture mark on the same floor band when a model uses separate CW/HW load-point parts for one fixture.
    const byIdKey = `${b}:${n.elementId ?? n.id}`;
    const byNameKey = n.name.trim() ? `${b}:mark:${n.name.trim().toUpperCase()}` : null;
    let entry = mergedMap.get(byIdKey);
    if (!entry && byNameKey) {
      const candidate = Array.from(mergedMap.values()).find(
        (m) => m.band === b && (m.cw?.node.name ?? m.hw?.node.name ?? "").trim().toUpperCase() === n.name.trim().toUpperCase() && (isHot ? !m.hw : !m.cw),
      );
      if (candidate) entry = candidate;
    }
    if (!entry) {
      entry = { key: byIdKey, elementId: n.elementId, band: b, order: orderSeq++ };
      mergedMap.set(byIdKey, entry);
    }
    const drop: FixtureDrop = { node: n, edge, devices: dropDevices, service: isHot ? "domestic_hot_water" : "domestic_cold_water" };
    if (isHot) {
      hasHot = true;
      entry.hw = drop;
    } else {
      entry.cw = drop;
    }
    if (edge?.label) {
      const info = ensureFloor(floorMap, b);
      if (!info.edge) info.edge = edge;
    }
  };

  const walkSubtree = (nodes: readonly DiagramNode[], isHot: boolean, topLevel: boolean, inheritedDevices: readonly DiagramNode[] = []) => {
    let seenNonDevice = !topLevel;
    let pendingDropDevices: DiagramNode[] = [...inheritedDevices];
    let lastTransitionEdge: DiagramEdge | undefined;

    for (const s of nodes) {
      const b = band(s);
      const nodeIsHot = isHot || s.service === "domestic_hot_water" || s.service === "domestic_hot_water_return";
      if (nodeIsHot) hasHot = true;

      // Capture service size/load at entry, and main interior header size right after entry devices!
      if (s.feed) {
        const loadN = parseLoadNumber(s.feed.load);
        if (!nodeIsHot) {
          if (!entryEdge && topLevel) entryEdge = s.feed;
          if (!serviceSize && topLevel && s.feed.label) serviceSize = s.feed.label;
          if (seenNonDevice && topLevel && !mainSizeAfterEntry && s.feed.label) mainSizeAfterEntry = s.feed.label;
          if (loadN > cwTotalNum) {
            cwTotalNum = loadN;
            cwTotalLoad = s.feed.load;
          }
        } else {
          if (loadN > hwTotalNum) {
            hwTotalNum = loadN;
            hwTotalLoad = s.feed.load;
            if (s.feed.label) hwTotalSize = s.feed.label;
          } else if (!hwTotalSize && s.feed.label) {
            hwTotalSize = s.feed.label;
          }
        }
      }

      if (s.role === "device") {
        // Anonymous pipe reducer/transition fitting: remember its upstream edge (size/elementIds) so the terminal after it doesn't lose its label!
        if (s.lines.length === 0) {
          if (s.feed?.label) {
            lastTransitionEdge = s.feed;
            if (topLevel && seenNonDevice && !nodeIsHot && !mainSizeAfterEntry) mainSizeAfterEntry = s.feed.label;
          }
          continue;
        }
        if (!seenNonDevice && topLevel && !nodeIsHot) {
          entryDevices.push(s);
        } else {
          pendingDropDevices.push(s);
        }
        continue;
      }

      seenNonDevice = true;
      const effectiveFeed = s.feed?.label ? s.feed : (lastTransitionEdge ?? s.feed);
      lastTransitionEdge = undefined;

      if (s.role === "terminal") {
        if (!nodeIsHot && isHeaterNode(s)) {
          const hwKids = s.children.filter((c) => c.service === "domestic_hot_water" || c.service === "domestic_hot_water_return");
          const hwFirstEdge = hwKids[0]?.feed;
          heaters.push({ node: s, band: b, cwEdge: effectiveFeed, hwRootEdge: hwFirstEdge, cwDevices: pendingDropDevices });
          pendingDropDevices = [];
          if (hwKids.length > 0) {
            hasHot = true;
            walkSubtree(hwKids, true, false);
          }
        } else {
          addFixture(s, effectiveFeed, pendingDropDevices, nodeIsHot);
          pendingDropDevices = [];
          if (s.children.length > 0) walkSubtree(s.children, nodeIsHot, false);
        }
        continue;
      }

      // Branch node: notice `s.feed` is the UPSTREAM trunk leading to the tee, while `s.children[0].feed` is the ACTUAL branch/riser pipe leaving the tee!
      const branchDevices = pendingDropDevices;
      pendingDropDevices = [];
      if (s.children.length > 0) {
        const last = s.children[s.children.length - 1];
        const isPureDrop =
          s.children.length > 1 &&
          last?.role === "terminal" &&
          last.children.length === 0 &&
          s.children.slice(0, -1).every((k) => k.role === "device");
        if (isPureDrop && last) {
          const devs = [...branchDevices, ...s.children.slice(0, -1).filter((k) => k.lines.length > 0)];
          const dropEdge = s.children[0]?.feed?.label ? s.children[0].feed : (last.feed?.label ? last.feed : effectiveFeed);
          addFixture(last, dropEdge, devs, nodeIsHot);
        } else {
          // Record the ACTUAL riser/header pipe size & load entering the child floor (from `s.children[0].feed`, NOT the parent trunk `s.feed`!)
          const firstKid = s.children[0]!;
          const targetBand = band(firstKid);
          if (firstKid.feed) {
            recordFloorPipe(nodeIsHot ? hwFloorInfo : cwFloorInfo, targetBand, firstKid.feed);
          }
          walkSubtree(s.children, nodeIsHot, false, branchDevices);
        }
      }
    }
  };

  walkSubtree(root.children, root.service === "domestic_hot_water" || root.service === "domestic_hot_water_return", true);

  // Organize unique fixtures by floor band and compute EXACT cumulative floor/riser WFU loads from bottom to top!
  const fixturesByBand = new Map<number, MergedFixture[]>();
  Array.from(mergedMap.values()).forEach((f) => {
    const arr = fixturesByBand.get(f.band) ?? [];
    arr.push(f);
    fixturesByBand.set(f.band, arr);
  });

  // Sort each floor: CW-only fixtures (left), CW+HW shared fixtures (right)
  Array.from(fixturesByBand.entries()).forEach(([b, list]) => {
    list.sort((a, bFix) => {
      const group = (x: MergedFixture) => (x.cw && !x.hw ? 0 : x.cw && x.hw ? 1 : 2);
      return group(a) - group(bFix) || a.order - bFix.order;
    });
    const cwSum = list.reduce((s, f) => s + (f.cw ? parseLoadNumber(f.cw.node.lines[1]?.text) : 0), 0);
    const hwSum = list.reduce((s, f) => s + (f.hw ? parseLoadNumber(f.hw.node.lines[1]?.text) : 0), 0);
    if (cwSum > 0) {
      const info = ensureFloor(cwFloorInfo, b);
      // On upper floors, always display the exact floor/riser WFU load (never leaked L1 total!)
      if (b !== rootBand) {
        info.loadNum = cwSum;
        info.load = formatWfu(cwSum);
      } else if (cwSum > info.loadNum) {
        info.loadNum = cwSum;
        info.load = formatWfu(cwSum);
      }
    }
    if (hwSum > 0) {
      const info = ensureFloor(hwFloorInfo, b);
      if (b !== rootBand) {
        info.loadNum = hwSum;
        info.load = formatWfu(hwSum);
      } else if (hwSum > info.loadNum) {
        info.loadNum = hwSum;
        info.load = formatWfu(hwSum);
      }
    }
  });

  // On rootBand, ensure the main header carries the true building CW & HW total WFU and post-entry pipe size
  const rootCwInfo = ensureFloor(cwFloorInfo, rootBand);
  if (mainSizeAfterEntry) rootCwInfo.size = mainSizeAfterEntry;
  else if (!rootCwInfo.size && serviceSize) rootCwInfo.size = serviceSize;
  if (cwTotalLoad) {
    rootCwInfo.load = cwTotalLoad;
    rootCwInfo.loadNum = cwTotalNum;
  }
  if (hasHot) {
    const rootHwInfo = ensureFloor(hwFloorInfo, rootBand);
    if (hwTotalSize) rootHwInfo.size = hwTotalSize;
    if (hwTotalLoad) {
      rootHwInfo.load = hwTotalLoad;
      rootHwInfo.loadNum = hwTotalNum;
    }
  }

  return {
    root,
    rootBand,
    entryDevices,
    entryEdge,
    serviceSize,
    mainSizeAfterEntry: mainSizeAfterEntry ?? serviceSize,
    cwTotalLoad,
    hwTotalLoad,
    hwTotalSize,
    heaters,
    fixturesByBand,
    cwFloorInfo,
    hwFloorInfo,
    hasHot,
    usedUnknown,
  };
}

/** Draws a crisp ASPE inline device symbol (Water Meter circle 'M', RPZ double-check bowtie, Valve bowtie) at `c`. */
function drawInlineDevice(items: OneLineItem[], s: DiagramNode, c: Vec2, below = true): void {
  const dk = deviceKindOf(s.name);
  const label = deviceLabelText(s.name);
  if (dk === "meter") {
    const r = 3.2;
    const steps = 16;
    const pts: Vec2[] = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pts.push(round({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }));
    }
    items.push({ shape: "polyline", points: pts, closed: true, weight: "medium", nodeId: s.id });
    items.push({ shape: "text", at: round({ x: c.x - 2.6, y: c.y + 1.55 }), widthMm: 5.2, lines: [{ text: "M", bold: true }], nodeId: s.id, role: "note", align: "center" });
    const h = oneLineTextHeight([{ text: label }], 18);
    items.push({ shape: "text", at: round({ x: c.x - 9, y: below ? c.y - r - 1.2 : c.y + r + 1.0 + h }), widthMm: 18, lines: [{ text: label, bold: true }], nodeId: s.id, role: "note", align: "center" });
    return;
  }
  if (dk === "rpz") {
    const hw = 4.2;
    const hh = 2.4;
    items.push(
      { shape: "polyline", points: [round({ x: c.x - hw, y: c.y + hh }), round({ x: c.x - hw, y: c.y - hh }), round({ x: c.x, y: c.y })], closed: true, weight: "medium", nodeId: s.id },
      { shape: "polyline", points: [round({ x: c.x + hw, y: c.y + hh }), round({ x: c.x + hw, y: c.y - hh }), round({ x: c.x, y: c.y })], closed: true, weight: "medium", nodeId: s.id },
      { shape: "line", points: [round({ x: c.x, y: c.y }), round({ x: c.x, y: c.y - hh - 1.4 })], weight: "thin", nodeId: s.id },
    );
    const h = oneLineTextHeight([{ text: label }], 18);
    items.push({ shape: "text", at: round({ x: c.x - 9, y: below ? c.y - hh - 2.2 : c.y + hh + 1.2 + h }), widthMm: 18, lines: [{ text: label, bold: true }], nodeId: s.id, role: "note", align: "center" });
    return;
  }
  const hw = 2.6;
  const hh = 1.8;
  items.push({
    shape: "polyline",
    points: [round({ x: c.x - hw, y: c.y + hh }), round({ x: c.x - hw, y: c.y - hh }), round({ x: c.x + hw, y: c.y + hh }), round({ x: c.x + hw, y: c.y - hh })],
    closed: true,
    weight: "medium",
    nodeId: s.id,
  });
  const h = oneLineTextHeight([{ text: label }], 14);
  items.push({ shape: "text", at: round({ x: c.x - 7, y: below ? c.y - hh - 1.2 : c.y + hh + 1.0 + h }), widthMm: 14, lines: [{ text: label }], nodeId: s.id, role: "note", align: "center" });
}

/** Draws an unmistakable ASPE cylindrical water heater tank (`WH-1` / `GWH`) with domed top/bottom caps. */
function drawWaterHeaterTank(items: OneLineItem[], n: DiagramNode, cx: number, bottomY: number): void {
  const hw = TANK_W / 2;
  const dome = 1.8;
  const topY = bottomY + TANK_H;
  items.push(
    {
      shape: "polyline",
      points: [
        round({ x: cx - hw, y: bottomY + dome }),
        round({ x: cx - hw * 0.6, y: bottomY }),
        round({ x: cx + hw * 0.6, y: bottomY }),
        round({ x: cx + hw, y: bottomY + dome }),
        round({ x: cx + hw, y: topY - dome }),
        round({ x: cx + hw * 0.6, y: topY }),
        round({ x: cx - hw * 0.6, y: topY }),
        round({ x: cx - hw, y: topY - dome }),
      ],
      closed: true,
      weight: "medium",
      nodeId: n.id,
    },
    { shape: "line", points: [round({ x: cx - hw, y: topY - dome }), round({ x: cx + hw, y: topY - dome })], weight: "thin", nodeId: n.id },
    { shape: "line", points: [round({ x: cx - hw, y: bottomY + dome }), round({ x: cx + hw, y: bottomY + dome })], weight: "thin", nodeId: n.id },
  );
  const mark = n.lines[0]?.text ?? n.name.toUpperCase();
  items.push({
    shape: "text",
    at: round({ x: cx - hw + 0.5, y: bottomY + TANK_H / 2 + 1.5 }),
    widthMm: TANK_W - 1,
    lines: [{ text: mark, bold: true }],
    nodeId: n.id,
    role: "equipment",
    align: "center",
  });
  if (n.lines.length > 1) {
    items.push({
      shape: "text",
      at: round({ x: cx - 10, y: bottomY - 1.4 }),
      widthMm: 20,
      lines: n.lines.slice(1, 2),
      nodeId: n.id,
      role: "equipment",
      align: "center",
    });
  }
}

/** Small solid tee junction dot on a water header. */
function teeDot(items: OneLineItem[], at: Vec2, nodeId: string): void {
  const r = 0.6;
  items.push({
    shape: "polyline",
    points: [round({ x: at.x - r, y: at.y - r }), round({ x: at.x + r, y: at.y - r }), round({ x: at.x + r, y: at.y + r }), round({ x: at.x - r, y: at.y + r })],
    closed: true,
    weight: "heavy",
    nodeId,
  });
}

export function layoutWaterRiser(roots: readonly DiagramNode[], levels: readonly RiserLevel[], opts: PipingLayoutOptions = {}): PipingLayout {
  const items: OneLineItem[] = [];
  const pipes: Record<string, PipeRef> = {};
  const ranges: Record<string, readonly [number, number]> = {};
  const entries: Record<string, Vec2> = {};
  const nodes: Array<{ id: string; kind: DiagramNode["kind"]; name: string; center: Vec2; depth: number }> = [];
  let usedUnknown = false;
  let pieceNo = 0;

  const floorY = (b: number) => -(b + 1) * ROW;
  const cwHeaderY = (b: number) => floorY(b) + 52; // 24 mm cleanly below next floor datum line!
  const hwHeaderY = (b: number) => floorY(b) + 37; // 15 mm cleanly below CW header!
  const fixtureY = (b: number) => floorY(b) + 14;

  const pipeSeg = (ownerId: string, ownerName: string, edge: DiagramEdge | undefined, a: Vec2, b: Vec2, dashed: boolean): { pa: Vec2; pb: Vec2 } | null => {
    const pa = round(a);
    const pb = round(b);
    if (Math.abs(pa.x - pb.x) < 0.01 && Math.abs(pa.y - pb.y) < 0.01) return null;
    const id = `pipe:${ownerId}:${pieceNo++}`;
    const ids = edge?.elementIds ?? (edge?.linkId ? [edge.linkId] : []);
    if (ids[0]) pipes[id] = { elementId: ids[0], elementIds: ids, name: `${edge?.label ? `${edge.label} ` : ""}${dashed ? "HW" : "CW"} pipe${ownerName ? ` to ${ownerName}` : ""}` };
    items.push({ shape: "line", points: [pa, pb], weight: "medium", nodeId: id, ...(dashed ? { dashed: true } : {}) });
    return { pa, pb };
  };

  const labelAbove = (ownerId: string, text: string, xLeft: number, lineY: number, widthMm: number, extraGap = 1.6) => {
    if (!text) return;
    const lines: OneLineTextLine[] = [{ text }];
    const h = oneLineTextHeight(lines, widthMm);
    items.push({ shape: "text", at: round({ x: xLeft, y: lineY + h + extraGap }), widthMm, lines, nodeId: `pipe:${ownerId}:lbl:${pieceNo++}`, role: "device" });
  };

  const labelSide = (ownerId: string, textLines: readonly string[], xLine: number, midY: number, side: "left" | "right", widthMm = 18) => {
    const clean = textLines.filter(Boolean);
    if (clean.length === 0) return;
    const lines: OneLineTextLine[] = clean.map((text) => ({ text }));
    const h = oneLineTextHeight(lines, widthMm);
    const atX = side === "right" ? xLine + 1.4 : xLine - widthMm - 1.4;
    items.push({
      shape: "text",
      at: round({ x: atX, y: midY + h / 2 }),
      widthMm,
      lines,
      nodeId: `pipe:${ownerId}:lbl:${pieceNo++}`,
      role: "device",
      ...(side === "left" ? { align: "center" as const } : {}),
    });
  };

  const labels = opts.labels ?? ["size", "load"];
  const showSize = labels.includes("size");
  const showLoad = labels.includes("load");

  let originX = LEFT + 6;
  let anyHot = false;

  for (const root of roots) {
    const net = extractWaterNetwork(root, levels);
    if (net.usedUnknown) usedUnknown = true;
    if (net.hasHot) anyHot = true;
    const rootIsHotOnly = root.service === "domestic_hot_water" || root.service === "domestic_hot_water_return";

    const activeBands = new Set<number>([net.rootBand]);
    Array.from(net.fixturesByBand.keys()).forEach((b) => activeBands.add(b));
    for (const h of net.heaters) activeBands.add(h.band);
    const sortedBands = Array.from(activeBands).sort((a, b) => b - a);
    const hasUpperCw = Array.from(net.fixturesByBand.entries()).some(([b, list]) => b !== net.rootBand && list.some((f) => f.cw));
    const hasUpperHw = Array.from(net.fixturesByBand.entries()).some(([b, list]) => b !== net.rootBand && list.some((f) => f.hw));

    let maxCwOnly = 0;
    let maxHotGroup = 0;
    Array.from(net.fixturesByBand.values()).forEach((list) => {
      const cwOnly = list.filter((f) => f.cw && !f.hw).length;
      const hotGrp = list.filter((f) => f.hw).length;
      maxCwOnly = Math.max(maxCwOnly, cwOnly);
      maxHotGroup = Math.max(maxHotGroup, hotGrp);
    });

    // Horizontal layout coordinates (zero overlaps!)
    let cursorX = originX;
    const serviceX = cursorX;
    cursorX += 14;

    const deviceXs: number[] = [];
    for (let i = 0; i < net.entryDevices.length; i++) {
      deviceXs.push(cursorX + 6);
      cursorX += DEVICE_STEP;
    }

    const heaterXs: number[] = [];
    for (let i = 0; i < net.heaters.length; i++) {
      heaterXs.push(cursorX + 10);
      cursorX += 26;
    }

    const cwRiserX = hasUpperCw ? cursorX + 4 : null;
    if (hasUpperCw) cursorX += SHAFT_W + 4;

    const cwOnlyStartX = cursorX + COL / 2;
    cursorX += maxCwOnly * COL;

    const hwRiserX = hasUpperHw ? cursorX + 4 : null;
    if (hasUpperHw) cursorX += SHAFT_W + 6;

    const hotGroupStartX = cursorX + COL / 2;
    cursorX += maxHotGroup * COL;
    const rightEndX = Math.max(cursorX + 12, originX + 54);

    // 1. Source entry node & label on rootBand
    const rootY = rootIsHotOnly ? hwHeaderY(net.rootBand) : cwHeaderY(net.rootBand);
    const rootStart = items.length;
    items.push({
      shape: "polyline",
      points: [round({ x: serviceX - 1.5, y: rootY - 1.5 }), round({ x: serviceX + 1.5, y: rootY - 1.5 }), round({ x: serviceX + 1.5, y: rootY + 1.5 }), round({ x: serviceX - 1.5, y: rootY + 1.5 })],
      closed: true,
      weight: "medium",
      nodeId: root.id,
    });
    const rootLines = root.lines.slice(0, 3);
    const rootH = oneLineTextHeight(rootLines, LEFT - 4);
    items.push({
      shape: "text",
      at: round({ x: serviceX - (LEFT - 2), y: rootY + rootH / 2 }),
      widthMm: LEFT - 4,
      lines: rootLines,
      nodeId: root.id,
      role: "equipment",
    });
    nodes.push({ id: root.id, kind: root.kind, name: root.name, center: round({ x: serviceX, y: rootY }), depth: 0 });
    ranges[root.id] = [rootStart, items.length];

    // 2. Entry pipe through inline service devices (MTR-1, RPZ-1, SOV...)
    let prevX = serviceX;
    const entryTag = [
      showSize && net.serviceSize ? `${net.serviceSize} ${rootIsHotOnly ? "HW" : "CW"}` : showSize && net.entryEdge?.label ? net.entryEdge.label : "",
      showLoad && net.cwTotalLoad ? net.cwTotalLoad : "",
    ]
      .filter(Boolean)
      .join(" · ");

    if (net.entryDevices.length > 0) {
      net.entryDevices.forEach((dev, i) => {
        const dx = deviceXs[i]!;
        const t0 = items.length;
        entries[dev.id] = round({ x: prevX, y: rootY });
        const gap = deviceKindOf(dev.name) === "rpz" ? 4.2 : deviceKindOf(dev.name) === "meter" ? 3.2 : 2.6;
        pipeSeg(dev.id, dev.name, dev.feed ?? net.entryEdge, { x: prevX, y: rootY }, { x: dx - gap, y: rootY }, rootIsHotOnly);
        if (i === 0 && entryTag) {
          // Lift cleanly above the circular Meter symbol (extraGap = 4.6 mm)
          labelAbove(root.id, entryTag, serviceX + 1, rootY, Math.max(40, (deviceXs[net.entryDevices.length - 1] ?? dx) - serviceX + 14), 4.6);
        }
        drawInlineDevice(items, dev, { x: dx, y: rootY }, true);
        nodes.push({ id: dev.id, kind: dev.kind, name: dev.name, center: round({ x: dx, y: rootY }), depth: 0 });
        ranges[dev.id] = [t0, items.length];
        prevX = dx + gap;
      });
    } else if (entryTag) {
      labelAbove(root.id, entryTag, serviceX + 2, rootY, 44, 1.8);
    }

    // 3. Draw Water Heater(s) (WH-1 / GWH)
    let hwStartPt: Vec2 | null = null;
    let hwMainEdge: DiagramEdge | undefined;
    for (let i = 0; i < net.heaters.length; i++) {
      const h = net.heaters[i]!;
      const hx = heaterXs[i]!;
      const hy = fixtureY(h.band) - 1;
      const cwY = cwHeaderY(h.band);
      const hwY = hwHeaderY(h.band);
      const t0 = items.length;
      entries[h.node.id] = round({ x: hx - 2.5, y: cwY });

      if (h.band === net.rootBand && hx - 2.5 > prevX) {
        pipeSeg(h.node.id, h.node.name, h.cwEdge ?? net.entryEdge, { x: prevX, y: cwY }, { x: hx - 2.5, y: cwY }, false);
        prevX = hx - 2.5;
      }
      teeDot(items, { x: hx - 2.5, y: cwY }, h.node.id);
      const cwInTop = { x: hx - 2.5, y: hy + TANK_H };
      pipeSeg(h.node.id, h.node.name, h.cwEdge, { x: hx - 2.5, y: cwY }, cwInTop, false);
      if (showSize && h.cwEdge?.label) {
        // Put CW drop label cleanly on the LEFT side of the tank drop so it NEVER touches the HW outlet line going right!
        labelSide(h.node.id, [`${h.cwEdge.label} CW`], hx - 2.5, (cwY + cwInTop.y) / 2, "left", 14);
      }
      drawWaterHeaterTank(items, h.node, hx, hy);
      nodes.push({ id: h.node.id, kind: h.node.kind, name: h.node.name, center: round({ x: hx, y: hy + TANK_H / 2 }), depth: 0 });

      if (net.hasHot) {
        const hwOutTop = { x: hx + 2.8, y: hy + TANK_H };
        const hwJoin = { x: hx + 2.8, y: hwY };
        pipeSeg(`${h.node.id}:hw`, `${h.node.name} HW`, h.hwRootEdge, hwOutTop, hwJoin, true);
        hwStartPt = hwJoin;
        hwMainEdge = h.hwRootEdge;
      }
      ranges[h.node.id] = [t0, items.length];
    }

    // 4. Draw each floor band's CW header, HW header (dashed), and merged unique fixtures
    const cwBandHeaderXs = new Map<number, { startX: number; endX: number; y: number }>();
    const hwBandHeaderXs = new Map<number, { startX: number; endX: number; y: number }>();

    for (const b of sortedBands) {
      const list = net.fixturesByBand.get(b) ?? [];
      const cwOnlyList = list.filter((f) => f.cw && !f.hw);
      const hotList = list.filter((f) => f.hw);
      const cwInfo = net.cwFloorInfo.get(b);
      const hwInfo = net.hwFloorInfo.get(b);
      const cy = cwHeaderY(b);
      const hy = hwHeaderY(b);
      const fy = fixtureY(b);

      const posOf = new Map<MergedFixture, number>();
      cwOnlyList.forEach((f, idx) => posOf.set(f, cwOnlyStartX + idx * COL));
      hotList.forEach((f, idx) => posOf.set(f, hotGroupStartX + idx * COL));

      const cwFixtures = list.filter((f) => f.cw);
      const hwFixtures = list.filter((f) => f.hw);

      // CW Horizontal Header on floor `b`
      if (!rootIsHotOnly && (cwFixtures.length > 0 || (b === net.rootBand && (cwRiserX !== null || cwInfo?.hasCap)))) {
        const startX = b === net.rootBand ? prevX : (cwRiserX ?? cwOnlyStartX - 10);
        const lastCwFix = cwFixtures[cwFixtures.length - 1];
        let endX = lastCwFix ? (posOf.get(lastCwFix)! - (lastCwFix.hw ? 2.4 : 0)) : startX;
        if (b === net.rootBand && cwRiserX !== null) endX = Math.max(endX, cwRiserX);
        if (cwInfo?.hasCap) endX += 10;
        if (endX > startX) {
          pipeSeg(`cw-hdr:${b}`, `L${b} CW header`, cwInfo?.edge ?? net.entryEdge, { x: startX, y: cy }, { x: endX, y: cy }, false);
          const hdrSize = b === net.rootBand ? net.mainSizeAfterEntry : cwInfo?.size;
          const hdrLoad = b === net.rootBand ? net.cwTotalLoad : cwInfo?.load;
          const hdrParts = [showSize && hdrSize ? `${hdrSize} CW` : "", showLoad && hdrLoad ? hdrLoad : ""].filter(Boolean);
          if (hdrParts.length > 0) {
            const lblX = b === net.rootBand && cwRiserX !== null ? cwRiserX + 3 : startX + 3;
            labelAbove(`cw-hdr:${b}`, hdrParts.join(" · "), lblX, cy, Math.max(40, endX - lblX), 1.8);
          }
          if (cwInfo?.hasCap && cwInfo.capNode) {
            const capX = endX;
            items.push({ shape: "line", points: [round({ x: capX, y: cy - 2 }), round({ x: capX, y: cy + 2 })], weight: "heavy", nodeId: cwInfo.capNode.id });
            items.push({ shape: "text", at: round({ x: capX + 2, y: cy + 1.4 }), widthMm: 12, lines: [{ text: "CAP" }], nodeId: cwInfo.capNode.id, role: "note" });
          }
          cwBandHeaderXs.set(b, { startX, endX, y: cy });
        }
      }

      // HW Horizontal Header (DASHED!) on floor `b`
      if (hwFixtures.length > 0 || (b === net.rootBand && hwStartPt && hwRiserX !== null)) {
        const startX =
          b === net.rootBand
            ? (hwStartPt?.x ?? (rootIsHotOnly ? prevX : hotGroupStartX - 10))
            : (hwRiserX ?? hotGroupStartX - 10);
        const lastHwFix = hwFixtures[hwFixtures.length - 1];
        let endX = lastHwFix ? (posOf.get(lastHwFix)! + (lastHwFix.cw ? 2.4 : 0)) : startX;
        if (b === net.rootBand && hwRiserX !== null) endX = Math.max(endX, hwRiserX);
        if (hwInfo?.hasCap) endX += 10;
        if (endX > startX) {
          pipeSeg(`hw-hdr:${b}`, `L${b} HW header`, hwInfo?.edge ?? hwMainEdge, { x: startX, y: hy }, { x: endX, y: hy }, true);
          const hwSz = b === net.rootBand ? (net.hwTotalSize ?? hwInfo?.size) : hwInfo?.size;
          const hwLd = b === net.rootBand ? (net.hwTotalLoad ?? hwInfo?.load) : hwInfo?.load;
          const hwParts = [showSize && hwSz ? `${hwSz} HW` : "", showLoad && hwLd ? hwLd : ""].filter(Boolean);
          if (hwParts.length > 0) {
            // Place HW header label cleanly in the open zone BEFORE the first CW+HW vertical CW drop (never colliding with L-1 or L-3's vertical pipe!)
            const lblX = hwRiserX !== null ? hwRiserX + 2.5 : startX + 3;
            labelAbove(`hw-hdr:${b}`, hwParts.join(" · "), lblX, hy, Math.max(26, (hotGroupStartX - 4) - lblX), 1.6);
          }
          if (hwInfo?.hasCap && hwInfo.capNode) {
            const capX = endX;
            items.push({ shape: "line", points: [round({ x: capX, y: hy - 2 }), round({ x: capX, y: hy + 2 })], weight: "heavy", nodeId: hwInfo.capNode.id });
            items.push({ shape: "text", at: round({ x: capX + 2, y: hy + 1.4 }), widthMm: 12, lines: [{ text: "CAP" }], nodeId: hwInfo.capNode.id, role: "note" });
          }
          hwBandHeaderXs.set(b, { startX, endX, y: hy });
        }
      }

      // Draw each unique physical fixture on floor `b` ONCE
      const hasHwLineAcrossCwOnly = b === net.rootBand && hwStartPt !== null && hwBandHeaderXs.has(b);
      for (const f of list) {
        const cx = posOf.get(f)!;
        const primary = (f.cw ?? f.hw)!.node;
        const t0 = items.length;
        entries[primary.id] = round({ x: cx, y: f.cw ? cy : hy });

        // Cold Water branch drop (SOLID)
        if (f.cw) {
          const dropX = f.hw ? cx - 2.4 : cx;
          teeDot(items, { x: dropX, y: cy }, primary.id);
          const topPt = { x: dropX, y: cy };
          const botPt = { x: dropX, y: fy + SYMBOL_H };
          const devs = f.cw.devices;
          if (devs.length > 0) {
            const step = (botPt.y - topPt.y) / (devs.length + 1);
            let curY = topPt.y;
            devs.forEach((d, di) => {
              const dy = topPt.y + step * (di + 1);
              pipeSeg(d.id, d.name, f.cw!.edge, { x: dropX, y: curY }, { x: dropX, y: dy + 1.8 }, false);
              drawInlineDevice(items, d, { x: dropX, y: dy }, false);
              curY = dy - 1.8;
            });
            pipeSeg(primary.id, primary.name, f.cw.edge, { x: dropX, y: curY }, botPt, false);
          } else {
            pipeSeg(primary.id, primary.name, f.cw.edge, topPt, botPt, false);
          }
          if (showSize && f.cw.edge?.label) {
            // Keep drop size label strictly clear of the horizontal HW line!
            const lblY = f.hw ? cy - 6.5 : hasHwLineAcrossCwOnly ? (hy + fy + SYMBOL_H) / 2 : (cy + fy + SYMBOL_H) / 2;
            labelSide(primary.id, [f.cw.edge.label], dropX, lblY, "right", 10);
          }
        }

        // Hot Water branch drop (DASHED) into the RIGHT side of the EXACT SAME fixture box!
        if (f.hw) {
          const dropX = f.cw ? cx + 2.4 : cx;
          teeDot(items, { x: dropX, y: hy }, f.hw.node.id);
          const topPt = { x: dropX, y: hy };
          const botPt = { x: dropX, y: fy + SYMBOL_H };
          const devs = f.hw.devices;
          if (devs.length > 0) {
            const step = (botPt.y - topPt.y) / (devs.length + 1);
            let curY = topPt.y;
            devs.forEach((d, di) => {
              const dy = topPt.y + step * (di + 1);
              pipeSeg(d.id, d.name, f.hw!.edge, { x: dropX, y: curY }, { x: dropX, y: dy + 1.8 }, true);
              drawInlineDevice(items, d, { x: dropX, y: dy }, false);
              curY = dy - 1.8;
            });
            pipeSeg(f.hw.node.id, primary.name, f.hw.edge, { x: dropX, y: curY }, botPt, true);
          } else {
            pipeSeg(f.hw.node.id, primary.name, f.hw.edge, topPt, botPt, true);
          }
          if (showSize && f.hw.edge?.label) {
            labelSide(f.hw.node.id, [f.hw.edge.label], dropX, (hy + fy + SYMBOL_H) / 2, "right", 10);
          }
        }

        // Single clean fixture box + bold mark + WFU cleanly below
        items.push({
          shape: "polyline",
          points: [
            round({ x: cx - SYMBOL_W / 2, y: fy }),
            round({ x: cx + SYMBOL_W / 2, y: fy }),
            round({ x: cx + SYMBOL_W / 2, y: fy + SYMBOL_H }),
            round({ x: cx - SYMBOL_W / 2, y: fy + SYMBOL_H }),
          ],
          closed: true,
          weight: "medium",
          nodeId: primary.id,
        });
        const fixLines = primary.lines.slice(0, 2);
        items.push({
          shape: "text",
          at: round({ x: cx - (COL - 2) / 2, y: fy - 1.4 }),
          widthMm: COL - 2,
          lines: fixLines,
          nodeId: primary.id,
          role: "equipment",
          align: "center",
        });
        nodes.push({ id: primary.id, kind: primary.kind, name: primary.name, center: round({ x: cx, y: fy + SYMBOL_H / 2 }), depth: 0 });
        ranges[primary.id] = [t0, items.length];
      }
    }

    // 5. Draw dedicated vertical CW Riser & HW Riser shafts cleanly between floors with exact cumulative loads!
    if (cwRiserX !== null && cwBandHeaderXs.size > 1) {
      const cwBands = Array.from(cwBandHeaderXs.keys()).sort((a, b) => b - a);
      const yBot = cwHeaderY(cwBands[0]!);
      const yTop = cwHeaderY(cwBands[cwBands.length - 1]!);
      const upperBands = cwBands.slice(1);
      const upperInfo = net.cwFloorInfo.get(upperBands[0]!);
      const riserLoadNum = upperBands.reduce((s, b) => s + (net.cwFloorInfo.get(b)?.loadNum ?? 0), 0);
      teeDot(items, { x: cwRiserX, y: yBot }, "cw-riser");
      pipeSeg("cw-riser", "CW Riser", upperInfo?.edge, { x: cwRiserX, y: yBot }, { x: cwRiserX, y: yTop }, false);
      for (const b of cwBands.slice(1, -1)) teeDot(items, { x: cwRiserX, y: cwHeaderY(b) }, "cw-riser");
      const riserLbl: string[] = [];
      if (showSize && upperInfo?.size) riserLbl.push(`${upperInfo.size} CW`);
      if (showLoad && riserLoadNum > 0) riserLbl.push(formatWfu(riserLoadNum));
      if (riserLbl.length > 0) {
        labelSide("cw-riser", riserLbl, cwRiserX, floorY(cwBands[cwBands.length - 1]!) + 26, "right", SHAFT_W);
      }
    }

    if (hwRiserX !== null && hwBandHeaderXs.size > 1) {
      const hwBands = Array.from(hwBandHeaderXs.keys()).sort((a, b) => b - a);
      const yBot = hwHeaderY(hwBands[0]!);
      const yTop = hwHeaderY(hwBands[hwBands.length - 1]!);
      const upperBands = hwBands.slice(1);
      const upperInfo = net.hwFloorInfo.get(upperBands[0]!);
      const riserLoadNum = upperBands.reduce((s, b) => s + (net.hwFloorInfo.get(b)?.loadNum ?? 0), 0);
      teeDot(items, { x: hwRiserX, y: yBot }, "hw-riser");
      pipeSeg("hw-riser", "HW Riser", upperInfo?.edge, { x: hwRiserX, y: yBot }, { x: hwRiserX, y: yTop }, true);
      for (const b of hwBands.slice(1, -1)) teeDot(items, { x: hwRiserX, y: hwHeaderY(b) }, "hw-riser");
      const riserLbl: string[] = [];
      if (showSize && upperInfo?.size) riserLbl.push(`${upperInfo.size} HW`);
      if (showLoad && riserLoadNum > 0) riserLbl.push(formatWfu(riserLoadNum));
      if (riserLbl.length > 0) {
        labelSide("hw-riser", riserLbl, hwRiserX, floorY(hwBands[hwBands.length - 1]!) + 22, "right", SHAFT_W);
      }
    }

    originX = rightEndX + COL;
  }

  const extentX = Math.max(originX, LEFT + 80);

  if (anyHot) {
    const legX = extentX - 58;
    const legY = floorY(0) + 12;
    items.push(
      { shape: "line", points: [round({ x: legX, y: legY }), round({ x: legX + 12, y: legY })], weight: "medium", nodeId: "legend:cw" },
      { shape: "text", at: round({ x: legX + 14, y: legY + 1.5 }), widthMm: 42, lines: [{ text: "COLD WATER (CW)" }], nodeId: "legend:cw", role: "note" },
      { shape: "line", points: [round({ x: legX, y: legY - 6 }), round({ x: legX + 12, y: legY - 6 })], weight: "medium", dashed: true, nodeId: "legend:hw" },
      { shape: "text", at: round({ x: legX + 14, y: legY - 4.5 }), widthMm: 42, lines: [{ text: "HOT WATER (HW)" }], nodeId: "legend:hw", role: "note" },
    );
  }

  const rows = [...levels.map((l) => l.name), ...(usedUnknown ? ["No level"] : [])];
  rows.forEach((name, i) => {
    const y = floorY(i);
    items.push({ shape: "line", points: [round({ x: 0, y }), round({ x: extentX, y })], weight: "thin", nodeId: "levels" });
    items.push({ shape: "text", at: round({ x: 0, y: y + oneLineTextHeight([{ text: name }], LEFT - 4) + 1 }), widthMm: LEFT - 4, lines: [{ text: name.toUpperCase(), bold: true }], nodeId: "levels", role: "note" });
  });

  return { items, extent: oneLineItemsExtent(items), nodes, ranges, entries, pipes };
}
