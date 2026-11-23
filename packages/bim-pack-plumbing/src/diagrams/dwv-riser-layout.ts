import { drainSystemKinds, oneLineItemsExtent, oneLineTextHeight } from "@permitzip/bim-kernel";
import type { DiagramEdge, DiagramNode, ElementId, OneLineItem, OneLineTextLine, RiserLevel, Vec2 } from "@permitzip/bim-kernel";
import type { PipeRef, PipingLayout, PipingLayoutOptions } from "./piping-layout";

/**
 * ASPE / NCS-standard Sanitary Drainage & Vent (DWV) Riser Diagram layout:
 * - Draws every physical fixture ONCE on its floor (never duplicating fixtures for the vent system)
 *   with bold mark + DFU cleanly inside the fixture box so bottom sanitary drains and top vent risers never collide with text.
 * - SOLID sanitary gravity drains drop from the bottom of each fixture through the floor slab into sloped
 *   horizontal branches (with ASPE 45° wye-and-1/8-bend sweeps) → vertical soil stack → under-slab building drain
 *   with ASPE cleanouts (CO), flow arrow, size, cumulative DFU, slope, and TO SEWER outfall.
 * - DASHED vents rise vertically from the top of each vented fixture above flood-level rim into horizontal
 *   branch vents → dedicated vertical vent stack → ASPE roof flashing cap (VTR / THRU ROOF).
 * - Includes an ASPE line-type legend (SAN solid / V dashed) and keeps full two-way selection & DiagramLayer dragging.
 */

const ROW = 78;
const LEFT = 34;
const COL = 24;
const STACK_LANE = 22;
const BOX_W = 16;
const BOX_H = 9.5;
const WYE_MM = 2.8;
const TOLERANCE_MM = 1219;

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

function bandOf(levels: readonly RiserLevel[], z: number | undefined, levelId: string | null): number {
  if (z === undefined) {
    const i = levels.findIndex((l) => l.id === levelId);
    return i >= 0 ? i : levels.length;
  }
  for (let i = 0; i < levels.length; i++) if ((levels[i] as RiserLevel).elevationMm <= z + TOLERANCE_MM) return i;
  return Math.max(0, levels.length - 1);
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  const m = s.replace(/,/g, "").match(/[\d.]+/);
  return m ? Number(m[0]) : 0;
}

function formatDfu(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${r.toLocaleString("en-US")} DFU`;
}

function isCapOrOpen(n: DiagramNode): boolean {
  const u = n.name.toUpperCase();
  return u === "CAP" || u === "OPEN END";
}

function collectTermIds(n: DiagramNode, out: Set<string>): void {
  if (n.role === "terminal" && n.elementId && !isCapOrOpen(n)) out.add(n.elementId);
  for (const c of n.children) collectTermIds(c, out);
}

/** True when `roots` contains a drainage tree and a vent tree that share at least one physical fixture (`elementId`). */
export function hasMergedDwvRoots(roots: readonly DiagramNode[]): boolean {
  const drains = roots.filter((r) => drainSystemKinds().has(r.service));
  const vents = roots.filter((r) => r.service === "vent");
  if (drains.length === 0 || vents.length === 0) return false;
  const drainIds = new Set<string>();
  for (const d of drains) collectTermIds(d, drainIds);
  for (const v of vents) {
    const vIds = new Set<string>();
    collectTermIds(v, vIds);
    for (const id of Array.from(vIds)) {
      if (drainIds.has(id)) return true;
    }
  }
  return false;
}

interface DwvFixture {
  readonly key: string;
  readonly elementId: ElementId | null;
  readonly band: number;
  readonly node: DiagramNode;
  readonly sanEdge: DiagramEdge | undefined;
  ventNode?: DiagramNode;
  ventEdge?: DiagramEdge;
  readonly order: number;
}

interface FloorSanInfo {
  size?: string;
  slope?: string;
  loadNum: number;
  edge?: DiagramEdge;
  hasCap: boolean;
}

interface FloorVentInfo {
  size?: string;
  edge?: DiagramEdge;
}

function drawWyeSweep(items: OneLineItem[], x: number, y: number, dirX: 1 | -1, nodeId: string): void {
  items.push({
    shape: "line",
    points: [round({ x, y: y + WYE_MM }), round({ x: x + dirX * WYE_MM, y })],
    weight: "thin",
    nodeId,
  });
}

function drawCleanout(items: OneLineItem[], c: Vec2, nodeId: string, label = "CO"): void {
  // ASPE cleanout bar/tee mark on drain line
  items.push(
    { shape: "line", points: [round({ x: c.x, y: c.y }), round({ x: c.x, y: c.y + 3.2 })], weight: "medium", nodeId },
    { shape: "line", points: [round({ x: c.x - 1.8, y: c.y + 3.2 }), round({ x: c.x + 1.8, y: c.y + 3.2 })], weight: "heavy", nodeId },
    { shape: "text", at: round({ x: c.x - 5, y: c.y + 7.2 }), widthMm: 10, lines: [{ text: label, bold: true }], nodeId, role: "note", align: "center" },
  );
}

function drawFlowArrow(items: OneLineItem[], tip: Vec2, dir: 1 | -1, nodeId: string): void {
  const len = 3.0;
  const half = 1.4;
  items.push({
    shape: "polyline",
    points: [round({ x: tip.x - dir * len, y: tip.y + half }), round(tip), round({ x: tip.x - dir * len, y: tip.y - half })],
    weight: "medium",
    nodeId,
  });
}

function drawVtrCap(items: OneLineItem[], at: Vec2, vtrNode: DiagramNode, sizeText: string): void {
  // ASPE Vent Thru Roof (VTR) flashing cap & pipe termination above roof line
  items.push(
    {
      shape: "polyline",
      points: [round({ x: at.x - 5.5, y: at.y - 1.2 }), round({ x: at.x, y: at.y + 2.8 }), round({ x: at.x + 5.5, y: at.y - 1.2 })],
      weight: "medium",
      nodeId: vtrNode.id,
    },
    { shape: "line", points: [round({ x: at.x, y: at.y - 1.2 }), round({ x: at.x, y: at.y + 5.2 })], weight: "medium", dashed: true, nodeId: vtrNode.id },
  );
  const title = `${sizeText ? `${sizeText} ` : ""}${vtrNode.name.toUpperCase()}`;
  const sub = vtrNode.name.toUpperCase().includes("ROOF") ? "" : "THRU ROOF (VTR)";
  const lines: OneLineTextLine[] = [{ text: title, bold: true }, ...(sub ? [{ text: sub }] : [])];
  // Place VTR label cleanly to the LEFT of the roof flashing cap so it never crowds the top-right legend.
  items.push({
    shape: "text",
    at: round({ x: at.x - 42, y: at.y + 5.6 }),
    widthMm: 35,
    lines,
    nodeId: vtrNode.id,
    role: "equipment",
    align: "center",
  });
}

export function layoutDwvRiser(roots: readonly DiagramNode[], levels: readonly RiserLevel[], opts: PipingLayoutOptions = {}): PipingLayout {
  const items: OneLineItem[] = [];
  const pipes: Record<string, PipeRef> = {};
  const ranges: Record<string, readonly [number, number]> = {};
  const entries: Record<string, Vec2> = {};
  const nodes: Array<{ id: string; kind: DiagramNode["kind"]; name: string; center: Vec2; depth: number }> = [];
  let usedUnknown = false;
  let pieceNo = 0;

  const band = (n: DiagramNode): number => {
    const b = bandOf(levels, n.at?.z, n.levelId);
    if (b >= levels.length) usedUnknown = true;
    return b;
  };

  const floorY = (b: number) => -(b + 1) * ROW;
  const fixtureBotY = (b: number) => floorY(b) + 12;
  const sanBranchY = (b: number) => floorY(b) - 14; // cleanly below floor slab
  const ventHeaderY = (b: number) => floorY(b) + 46; // >= 6" above flood-level rim, well below next floor's drain!

  const pipeSeg = (ownerId: string, ownerName: string, edge: DiagramEdge | undefined, a: Vec2, b: Vec2, dashed: boolean): { pa: Vec2; pb: Vec2 } | null => {
    const pa = round(a);
    const pb = round(b);
    if (Math.abs(pa.x - pb.x) < 0.01 && Math.abs(pa.y - pb.y) < 0.01) return null;
    const id = `pipe:${ownerId}:${pieceNo++}`;
    const ids = edge?.elementIds ?? (edge?.linkId ? [edge.linkId] : []);
    if (ids[0]) pipes[id] = { elementId: ids[0], elementIds: ids, name: `${edge?.label ? `${edge.label} ` : ""}${dashed ? "Vent" : "Sanitary"} pipe${ownerName ? ` to ${ownerName}` : ""}` };
    items.push({ shape: "line", points: [pa, pb], weight: "medium", nodeId: id, ...(dashed ? { dashed: true } : {}) });
    return { pa, pb };
  };

  const labelText = (ownerId: string, lines: readonly string[], at: Vec2, widthMm: number, align?: "center") => {
    const clean = lines.filter(Boolean);
    if (clean.length === 0) return;
    items.push({
      shape: "text",
      at: round(at),
      widthMm,
      lines: clean.map((text) => ({ text })),
      nodeId: `pipe:${ownerId}:lbl:${pieceNo++}`,
      role: "device",
      ...(align ? { align } : {}),
    });
  };

  const labels = opts.labels ?? ["size", "load", "slope"];
  const showSize = labels.includes("size");
  const showLoad = labels.includes("load");
  const showSlope = labels.includes("slope");

  // Extract sanitary drainage tree(s) + vent tree(s)
  const drainRoot = roots.find((r) => drainSystemKinds().has(r.service))!;
  const ventRoot = roots.find((r) => r.service === "vent");

  const fixturesByKey = new Map<string, DwvFixture>();
  const sanFloorInfo = new Map<number, FloorSanInfo>();
  const ventFloorInfo = new Map<number, FloorVentInfo>();
  const cleanouts: DiagramNode[] = [];
  let mainDrainEdge: DiagramEdge | undefined;
  let mainDrainSize: string | undefined;
  let mainDrainSlope: string | undefined;
  let totalDfuNum = 0;
  let orderSeq = 0;
  let outfallNode: DiagramNode | null = null;

  const ensureSanFloor = (b: number): FloorSanInfo => {
    let info = sanFloorInfo.get(b);
    if (!info) {
      info = { loadNum: 0, hasCap: false };
      sanFloorInfo.set(b, info);
    }
    return info;
  };

  const walkDrain = (list: readonly DiagramNode[], topLevel: boolean) => {
    let lastEdge: DiagramEdge | undefined;
    for (const s of list) {
      const b = band(s);
      if (s.feed) {
        const dfu = parseNum(s.feed.load);
        if (topLevel) {
          if (!mainDrainEdge) mainDrainEdge = s.feed;
          if (!mainDrainSize && s.feed.label) mainDrainSize = s.feed.label;
          if (!mainDrainSlope && s.feed.slope) mainDrainSlope = s.feed.slope;
          if (dfu > totalDfuNum) {
            totalDfuNum = dfu;
            mainDrainEdge = s.feed;
            if (s.feed.label) mainDrainSize = s.feed.label;
            if (s.feed.slope) mainDrainSlope = s.feed.slope;
          }
        }
      }
      if (s.role === "device") {
        if (s.lines.length === 0) {
          if (s.feed?.label) lastEdge = s.feed;
          continue;
        }
        const low = s.name.toLowerCase();
        if (low.includes("cleanout") || low.includes("co")) {
          cleanouts.push(s);
        }
        continue;
      }
      const eff = s.feed?.label ? s.feed : (lastEdge ?? s.feed);
      lastEdge = undefined;
      if (s.role === "terminal") {
        if (isCapOrOpen(s)) {
          if (s.name.toUpperCase() === "CAP") ensureSanFloor(b).hasCap = true;
          continue;
        }
        // Check if this terminal is an exterior manhole / cleanout (not a floor plumbing fixture)
        const low = s.name.toLowerCase();
        if (low.includes("mh-") || low.includes("manhole") || low.includes("sewer")) {
          outfallNode = s;
          continue;
        }
        if (low.includes("fco") || low.includes("cleanout")) {
          cleanouts.push(s);
          continue;
        }
        const key = `${b}:${s.elementId ?? s.id}`;
        if (!fixturesByKey.has(key)) {
          fixturesByKey.set(key, { key, elementId: s.elementId, band: b, node: s, sanEdge: eff, order: orderSeq++ });
        }
        continue;
      }
      // Branch node
      if (s.children.length > 0) {
        const firstKid = s.children[0]!;
        const tb = band(firstKid);
        if (firstKid.feed) {
          const info = ensureSanFloor(tb);
          if (!info.edge) info.edge = firstKid.feed;
          if (!info.size && firstKid.feed.label) info.size = firstKid.feed.label;
          if (!info.slope && firstKid.feed.slope) info.slope = firstKid.feed.slope;
        }
        walkDrain(s.children, false);
      }
    }
  };
  walkDrain(drainRoot.children, true);

  // Extract vent stack size & attach vent branches directly onto the EXISTING physical fixtures!
  let ventStackSize: string | undefined;
  let ventStackEdge: DiagramEdge | undefined;
  const walkVent = (list: readonly DiagramNode[]) => {
    let lastEdge: DiagramEdge | undefined;
    for (const s of list) {
      if (s.feed?.label && !ventStackSize) {
        ventStackSize = s.feed.label;
        ventStackEdge = s.feed;
      }
      if (s.role === "device") {
        if (s.lines.length === 0 && s.feed?.label) lastEdge = s.feed;
        continue;
      }
      const eff = s.feed?.label ? s.feed : (lastEdge ?? s.feed);
      lastEdge = undefined;
      if (s.role === "terminal") {
        if (isCapOrOpen(s)) continue;
        const b = band(s);
        const byId = `${b}:${s.elementId ?? s.id}`;
        let match = fixturesByKey.get(byId);
        if (!match) {
          match = Array.from(fixturesByKey.values()).find(
            (f) => f.elementId !== null && f.elementId === s.elementId,
          ) ?? Array.from(fixturesByKey.values()).find(
            (f) => f.band === b && f.node.name.trim().toUpperCase() === s.name.trim().toUpperCase(),
          );
        }
        if (match) {
          match.ventNode = s;
          match.ventEdge = eff;
          const vInfo = ventFloorInfo.get(match.band) ?? {};
          if (!vInfo.edge && eff) vInfo.edge = eff;
          if (!vInfo.size && eff?.label) vInfo.size = eff.label;
          ventFloorInfo.set(match.band, vInfo);
        }
        continue;
      }
      if (s.children.length > 0) {
        const firstKid = s.children[0]!;
        const tb = band(firstKid);
        if (firstKid.feed) {
          const vInfo = ventFloorInfo.get(tb) ?? {};
          if (!vInfo.edge) vInfo.edge = firstKid.feed;
          if (!vInfo.size && firstKid.feed.label) vInfo.size = firstKid.feed.label;
          ventFloorInfo.set(tb, vInfo);
        }
        walkVent(s.children);
      }
    }
  };
  if (ventRoot) walkVent(ventRoot.children);

  // Group fixtures per floor band and sort cleanly (WCs on left, Lavatories & Sinks on right — matching real architectural wet wall!)
  const fixturesByBand = new Map<number, DwvFixture[]>();
  Array.from(fixturesByKey.values()).forEach((f) => {
    const arr = fixturesByBand.get(f.band) ?? [];
    arr.push(f);
    fixturesByBand.set(f.band, arr);
  });

  Array.from(fixturesByBand.entries()).forEach(([b, list]) => {
    list.sort((a, bFix) => {
      const rank = (name: string) => (/^WC/i.test(name) ? 0 : /^UR/i.test(name) ? 1 : /^L-|^LAV/i.test(name) ? 2 : 3);
      return rank(a.node.name) - rank(bFix.node.name) || a.node.name.localeCompare(bFix.node.name, "en-US", { numeric: true });
    });
    const sum = list.reduce((acc, f) => acc + parseNum(f.node.lines[1]?.text), 0);
    const info = ensureSanFloor(b);
    info.loadNum = sum;
  });

  const drainBand = band(drainRoot);
  const activeBands = new Set<number>([drainBand]);
  Array.from(fixturesByBand.keys()).forEach((b) => activeBands.add(b));
  const sortedBands = Array.from(activeBands).sort((a, b) => b - a); // lowest floor first
  const bottomBand = sortedBands[0] ?? drainBand;
  const upperBands = sortedBands.filter((b) => b !== bottomBand);

  // Compute clean horizontal column grid:
  // [LEFT margin] [CO head] [Fixture cols 0..N-1] [Vertical Soil Stack lane (if multi-story)] [Vertical Vent Stack lane (if vent)] [CO exit] [TO SEWER]
  let maxFixturesOnFloor = 1;
  Array.from(fixturesByBand.values()).forEach((list) => {
    maxFixturesOnFloor = Math.max(maxFixturesOnFloor, list.length);
  });

  // Split fixtures cleanly: left group (WCs) and right group (Lavs/Sinks) with the vertical Vent Stack rising cleanly between them or on the right!
  let cursorX = LEFT + 14;
  const coHeadX = cursorX;
  cursorX += 14;

  const firstFixX = cursorX + COL / 2;
  cursorX += maxFixturesOnFloor * COL;

  const sanStackX = upperBands.length > 0 ? cursorX + 8 : null;
  if (sanStackX !== null) cursorX += STACK_LANE;

  const ventStackX = ventRoot ? cursorX + 8 : null;
  if (ventStackX !== null) cursorX += STACK_LANE + 4;

  const coExitX = cursorX + 4;
  const sewerExitX = coExitX + 18;
  const extentX = sewerExitX + 42;

  // Compute fixture X positions (aligning L2 WCs directly above L1 WCs and L2 Lavs directly above L1 Lavs!)
  const fixPos = new Map<DwvFixture, number>();
  for (const b of sortedBands) {
    const list = fixturesByBand.get(b) ?? [];
    list.forEach((f, i) => fixPos.set(f, firstFixX + i * COL));
  }

  // 1. Draw Building Drain under bottomBand (solid horizontal line flowing RIGHT to TO SEWER!)
  const mainY = sanBranchY(bottomBand);
  const mainStartX = coHeadX;
  const mainEndX = sewerExitX;
  const totalDfu = totalDfuNum > 0 ? totalDfuNum : sortedBands.reduce((acc, b) => acc + (sanFloorInfo.get(b)?.loadNum ?? 0), 0);
  pipeSeg("san-main", "Building Drain", mainDrainEdge, { x: mainStartX, y: mainY }, { x: mainEndX, y: mainY }, false);

  // Head & Exit Cleanouts (CO)
  const co1 = cleanouts[0];
  const co2 = cleanouts[1];
  drawCleanout(items, { x: coHeadX, y: mainY }, co1?.id ?? "co:head", "CO");
  if (cleanouts.length > 1) {
    drawCleanout(items, { x: coExitX, y: mainY }, co2?.id ?? "co:exit", "CO");
  }
  drawFlowArrow(items, { x: mainEndX - 2, y: mainY }, 1, drainRoot.id);

  // Main building drain size + DFU + slope cleanly BELOW the drain line
  const mainLbl = [
    showSize && mainDrainSize ? `${mainDrainSize} SAN` : "",
    showLoad && totalDfu > 0 ? formatDfu(totalDfu) : "",
    showSlope && mainDrainSlope ? mainDrainSlope : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (mainLbl) {
    labelText("san-main", [mainLbl], { x: firstFixX, y: mainY - 2.2 }, Math.max(58, (sanStackX ?? coExitX) - firstFixX));
  }

  // Outfall label at right end (`SANITARY / TO SEWER (MH-1)`)
  const outStart = items.length;
  items.push({
    shape: "polyline",
    points: [
      round({ x: mainEndX - 1.5, y: mainY - 1.5 }),
      round({ x: mainEndX + 1.5, y: mainY - 1.5 }),
      round({ x: mainEndX + 1.5, y: mainY + 1.5 }),
      round({ x: mainEndX - 1.5, y: mainY + 1.5 }),
    ],
    closed: true,
    weight: "medium",
    nodeId: drainRoot.id,
  });
  const outTitle = drainRoot.lines[0]?.text ?? "SANITARY";
  const outSub = outfallNode ? `TO SEWER (${(outfallNode as DiagramNode).name.toUpperCase()})` : (drainRoot.lines[1]?.text ?? "TO SEWER");
  items.push({
    shape: "text",
    at: round({ x: mainEndX + 3.5, y: mainY + 3.2 }),
    widthMm: 36,
    lines: [{ text: outTitle, bold: true }, { text: outSub }],
    nodeId: drainRoot.id,
    role: "equipment",
  });
  nodes.push({ id: drainRoot.id, kind: drainRoot.kind, name: drainRoot.name, center: round({ x: mainEndX, y: mainY }), depth: 0 });
  ranges[drainRoot.id] = [outStart, items.length];

  // 2. Draw each floor band's sanitary branch, vent header (dashed), and unique physical fixtures!
  const ventBandsConnected: number[] = [];
  for (const b of sortedBands) {
    const list = fixturesByBand.get(b) ?? [];
    if (list.length === 0) continue;
    const fBotY = fixtureBotY(b);
    const fTopY = fBotY + BOX_H;
    const sY = sanBranchY(b);
    const vY = ventHeaderY(b);
    const sInfo = sanFloorInfo.get(b);
    const vInfo = ventFloorInfo.get(b);

    // Upper floor horizontal sanitary branch flowing right into vertical soil stack
    if (b !== bottomBand && sanStackX !== null) {
      const leftX = fixPos.get(list[0]!)!;
      pipeSeg(`san-br:${b}`, `L${b} Sanitary Branch`, sInfo?.edge, { x: leftX, y: sY }, { x: sanStackX, y: sY }, false);
      const brLbl = [
        showSize && sInfo?.size ? `${sInfo.size} SAN` : "",
        showLoad && sInfo && sInfo.loadNum > 0 ? formatDfu(sInfo.loadNum) : "",
        showSlope && sInfo?.slope ? sInfo.slope : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (brLbl) {
        labelText(`san-br:${b}`, [brLbl], { x: leftX + 2, y: sY - 2.0 }, Math.max(46, sanStackX - leftX - 4));
      }
      // Subtle end cap tick if capped
      if (sInfo?.hasCap) {
        items.push({ shape: "line", points: [round({ x: leftX - 3, y: sY }), round({ x: leftX, y: sY })], weight: "medium", nodeId: `san-br:${b}` });
        items.push({ shape: "line", points: [round({ x: leftX - 3, y: sY - 1.8 }), round({ x: leftX - 3, y: sY + 1.8 })], weight: "heavy", nodeId: `san-br:${b}` });
      }
    }

    // Horizontal dashed branch vent header (>= 6" above flood rim) running right into vertical Vent Stack!
    const ventedOnFloor = list.filter((f) => f.ventNode !== undefined);
    if (ventedOnFloor.length > 0 && ventStackX !== null) {
      ventBandsConnected.push(b);
      const vLeftX = fixPos.get(ventedOnFloor[0]!)!;
      pipeSeg(`vent-hdr:${b}`, `L${b} Branch Vent`, vInfo?.edge, { x: vLeftX, y: vY }, { x: ventStackX, y: vY }, true);
      const vSize = vInfo?.size ?? '2"';
      labelText(`vent-hdr:${b}`, [`${vSize} V`], { x: vLeftX + 2, y: vY + 4.4 }, 24);
    }

    // Draw each unique physical fixture on floor `b` ONCE (mark + DFU cleanly INSIDE the box!)
    for (const f of list) {
      const cx = fixPos.get(f)!;
      const t0 = items.length;
      entries[f.node.id] = round({ x: cx, y: sY });

      // SOLID sanitary drop DOWN from fixture bottom through floor slab into horizontal drain with 45° wye sweep!
      pipeSeg(f.node.id, f.node.name, f.sanEdge, { x: cx, y: fBotY }, { x: cx, y: sY }, false);
      drawWyeSweep(items, cx, sY, 1, f.node.id);
      if (showSize && f.sanEdge?.label) {
        // Place fixture drain size cleanly below the floor slab line (halfway between floorY and sY)
        labelText(f.node.id, [f.sanEdge.label], { x: cx + 1.6, y: (floorY(b) + sY) / 2 + 1.4 }, 10);
      }

      // DASHED vertical vent rising UP from fixture top to horizontal branch vent header!
      if (f.ventNode) {
        pipeSeg(f.ventNode.id, `${f.node.name} vent`, f.ventEdge, { x: cx, y: fTopY }, { x: cx, y: vY }, true);
        if (showSize && f.ventEdge?.label) {
          labelText(f.ventNode.id, [f.ventEdge.label], { x: cx + 1.6, y: (fTopY + vY) / 2 + 1.4 }, 10);
        }
      }

      // Crisp fixture box with bold mark + DFU cleanly INSIDE (zero collision with bottom drain or top vent!)
      items.push({
        shape: "polyline",
        points: [
          round({ x: cx - BOX_W / 2, y: fBotY }),
          round({ x: cx + BOX_W / 2, y: fBotY }),
          round({ x: cx + BOX_W / 2, y: fTopY }),
          round({ x: cx - BOX_W / 2, y: fTopY }),
        ],
        closed: true,
        weight: "medium",
        nodeId: f.node.id,
      });
      const boxLines = f.node.lines.slice(0, 2);
      const textH = oneLineTextHeight(boxLines, BOX_W - 1.2);
      items.push({
        shape: "text",
        at: round({ x: cx - (BOX_W - 1.2) / 2, y: fBotY + (BOX_H + textH) / 2 - 0.5 }),
        widthMm: BOX_W - 1.2,
        lines: boxLines,
        nodeId: f.node.id,
        role: "equipment",
        align: "center",
      });
      nodes.push({ id: f.node.id, kind: f.node.kind, name: f.node.name, center: round({ x: cx, y: fBotY + BOX_H / 2 }), depth: 0 });
      ranges[f.node.id] = [t0, items.length];
    }
  }

  // 3. Vertical Sanitary Soil Stack connecting upper floor(s) down into Building Drain (with 45° wye sweep at base!)
  if (sanStackX !== null && upperBands.length > 0) {
    const topSanBand = upperBands[upperBands.length - 1]!;
    const yTop = sanBranchY(topSanBand);
    const stackInfo = sanFloorInfo.get(topSanBand);
    const stackDfu = upperBands.reduce((acc, b) => acc + (sanFloorInfo.get(b)?.loadNum ?? 0), 0);
    pipeSeg("san-stack", "Soil Stack", stackInfo?.edge, { x: sanStackX, y: yTop }, { x: sanStackX, y: mainY }, false);
    drawWyeSweep(items, sanStackX, mainY, 1, "san-stack");
    const stackLbl = [showSize && stackInfo?.size ? `${stackInfo.size} SAN` : "", showLoad && stackDfu > 0 ? formatDfu(stackDfu) : ""].filter(Boolean);
    if (stackLbl.length > 0) {
      labelText("san-stack", stackLbl, { x: sanStackX + 1.8, y: floorY(bottomBand) + 26 }, STACK_LANE - 2);
    }
  }

  // 4. Vertical Dashed Vent Stack rising cleanly from lowest branch vent straight UP through ROOF to VTR!
  if (ventStackX !== null && ventRoot && ventBandsConnected.length > 0) {
    const lowVentBand = Math.max(...ventBandsConnected);
    const yLow = ventHeaderY(lowVentBand);
    const roofBand = Math.max(0, levels.length > 0 ? 0 : Math.min(...ventBandsConnected));
    const roofY = floorY(roofBand);
    const vtrY = roofY + 2;
    const vStart = items.length;
    pipeSeg("vent-stack", "Main Vent Stack", ventStackEdge, { x: ventStackX, y: yLow }, { x: ventStackX, y: vtrY }, true);
    drawVtrCap(items, { x: ventStackX, y: vtrY }, ventRoot, ventStackSize ?? '3"');
    const vStackLbl = [ventStackSize ? `${ventStackSize} V` : '3" V', "STACK"];
    const vLblY = ventBandsConnected.length > 1 ? (yLow + vtrY) / 2 : (yLow + vtrY) / 2;
    labelText("vent-stack", vStackLbl, { x: ventStackX + 2.0, y: vLblY + 2 }, STACK_LANE);
    nodes.push({ id: ventRoot.id, kind: ventRoot.kind, name: ventRoot.name, center: round({ x: ventStackX, y: vtrY }), depth: 0 });
    ranges[ventRoot.id] = [vStart, items.length];
  }

  // 5. Crisp ASPE Line-Type Legend in top-right (above ROOF line)
  const legX = extentX - 58;
  const legY = floorY(0) + 14;
  items.push(
    { shape: "line", points: [round({ x: legX, y: legY }), round({ x: legX + 12, y: legY })], weight: "medium", nodeId: "legend:san" },
    { shape: "text", at: round({ x: legX + 14, y: legY + 1.5 }), widthMm: 44, lines: [{ text: "SANITARY DRAIN (SAN)" }], nodeId: "legend:san", role: "note" },
    { shape: "line", points: [round({ x: legX, y: legY - 6 }), round({ x: legX + 12, y: legY - 6 })], weight: "medium", dashed: true, nodeId: "legend:vent" },
    { shape: "text", at: round({ x: legX + 14, y: legY - 4.5 }), widthMm: 44, lines: [{ text: "SANITARY VENT (V)" }], nodeId: "legend:vent", role: "note" },
  );

  // 5b. Add IPC 912 horizontal wet-vent engineering note whenever unvented bathroom-group fixtures share a floor branch with vented lavatories.
  const wetVentedFixtures: string[] = [];
  for (const b of sortedBands) {
    const list = fixturesByBand.get(b) ?? [];
    const hasDryVentedLav = list.some((f) => f.ventNode !== undefined && /^L-|^LAV/i.test(f.node.name));
    if (!hasDryVentedLav) continue;
    for (const f of list) {
      if (!f.ventNode && /^WC/i.test(f.node.name)) wetVentedFixtures.push(f.node.name.toUpperCase());
    }
  }
  if (wetVentedFixtures.length > 0) {
    items.push({
      shape: "text",
      at: round({ x: LEFT, y: mainY - 11.5 }),
      widthMm: Math.max(120, extentX - LEFT - 10),
      lines: [{ text: `NOTE: ${wetVentedFixtures.join(", ")} HORIZONTALLY WET-VENTED VIA LAVATORY DRAINS PER IPC 912.` }],
      nodeId: "note:wet-vent",
      role: "note",
    });
  }

  // 6. Floor datum lines & bold level names
  const rows = [...levels.map((l) => l.name), ...(usedUnknown ? ["No level"] : [])];
  rows.forEach((name, i) => {
    const y = floorY(i);
    items.push({ shape: "line", points: [round({ x: 0, y }), round({ x: extentX, y })], weight: "thin", nodeId: "levels" });
    items.push({ shape: "text", at: round({ x: 0, y: y + oneLineTextHeight([{ text: name }], LEFT - 4) + 1 }), widthMm: LEFT - 4, lines: [{ text: name.toUpperCase(), bold: true }], nodeId: "levels", role: "note" });
  });

  return { items, extent: oneLineItemsExtent(items), nodes, ranges, entries, pipes };
}
