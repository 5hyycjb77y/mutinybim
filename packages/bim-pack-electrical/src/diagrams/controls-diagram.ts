import {
  ONE_LINE_TEXT_MM,
  oneLineItemsExtent,
  oneLineTextHeight,
  oneLineTextWidth,
  type BimElement,
  type DiagramGraph,
  type DiagramGraphDef,
  type DiagramGraphLayoutInput,
  type DiagramGraphLayoutResult,
  type DiagramHints,
  type DiagramLayoutNode,
  type DiagramLayoutRow,
  type DiagramNode,
  type ElementId,
  type OneLineItem,
  type OneLineTextLine,
  type PartInstance,
  type PartTypeElement,
  type ServiceLink,
  fieldText,
  roomOf,
  roomText,
} from "@permitzip/bim-kernel";
import { distributionOf } from "../connections/systems";

/**
 * Live Lighting Controls Diagram (`kind: "electrical.controls_diagram"`):
 * derived directly from the model's lighting/control circuits, switch-leg zones
 * (`switch_leg`), control protocols (`control_type`), controllers (switches,
 * dimmers, occupancy/daylight sensors), and controlled luminaires / receptacles
 * (including normal, unswitched EM, and UL 924 switched EM modes).
 *
 * Plugs into the kernel's open-ended `DIAGRAM_GRAPH_POINT` and
 * `DIAGRAM_LAYOUT_POINT` extension points (`diagrams:open_kinds`): zero
 * hardcoding in `bim-kernel`, live at every revision, clickable nodes,
 * draggable text blocks, and placeable on any sheet.
 */

export const CONTROLS_DIAGRAM_KIND = "controls_diagram" as const;

type Elements = Readonly<Record<string, BimElement>>;

const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  line_voltage: "LINE VOLT",
  "0-10v": "0-10V DIM",
  dali: "DALI",
  low_voltage: "LOW VOLT",
  wireless: "WIRELESS",
};

const PROTOCOL_WIRE_LABELS: Readonly<Record<string, string>> = {
  line_voltage: "LINE-VOLT SWITCH LEG",
  "0-10v": "0-10V (2#18) + LINE",
  dali: "DALI BUS (2#16)",
  low_voltage: "LOW-VOLT CAT5 / 24V",
  wireless: "RF WIRELESS LINK",
};

function partTypeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

function isControllerPart(type: PartTypeElement | null): boolean {
  if (!type) return false;
  return (
    type.definition.category === "electrical_device" &&
    /(switch|dimmer|sensor|photocell|time clock|relay pack)/i.test(type.definition.familyName)
  );
}

function partMark(part: PartInstance): string {
  const m = part.mark?.trim();
  if (m) return m;
  const v = part.values.mark ?? part.values.type_mark;
  return typeof v === "string" && v.trim() ? v.trim() : part.id;
}

function normalizedLeg(part: PartInstance): string {
  const raw = part.values.switch_leg;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function emergencyModeOf(part: PartInstance, type: PartTypeElement | null): "none" | "unswitched" | "switched" {
  const m = part.values.emergency_mode ?? type?.definition.typeValues.emergency_mode;
  if (m === "unswitched" || m === "switched" || m === "none") return m;
  const em = part.values.emergency ?? type?.definition.typeValues.emergency;
  return em === true ? "unswitched" : "none";
}

function protocolOf(part: PartInstance, type: PartTypeElement | null): string {
  const raw = part.values.control_type ?? type?.definition.typeValues.control_type;
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : "";
}

interface ZoneEntry {
  readonly key: string;
  readonly label: string;
  readonly isEmergencyOnly: boolean;
  readonly room: string;
  readonly protocol: string;
  readonly circuits: readonly string[];
  readonly panels: readonly { readonly id: ElementId; readonly name: string; readonly ratings: string }[];
  readonly controllers: readonly PartInstance[];
  readonly loads: readonly PartInstance[];
  readonly emSummary: string;
  readonly totalWatts: number;
}

function collectControlZones(elements: Elements): {
  readonly zones: readonly ZoneEntry[];
  readonly panels: readonly { readonly id: ElementId; readonly name: string; readonly ratings: string }[];
  readonly reads: readonly ElementId[];
} {
  const reads = new Set<ElementId>();
  const linkByMember = new Map<string, ServiceLink>();
  for (const el of Object.values(elements)) {
    if (el.kind !== "service_link" || el.trade !== "electrical" || ("deleted" in el && el.deleted)) continue;
    for (const m of el.members) linkByMember.set(m.elementId, el);
  }

  const byLeg = new Map<string, { controllers: PartInstance[]; loads: PartInstance[] }>();
  const unswitchedEmLoads: PartInstance[] = [];

  for (const el of Object.values(elements)) {
    if (el.kind !== "part" || el.planned !== undefined || ("deleted" in el && el.deleted)) continue;
    const type = partTypeOf(elements, el);
    if (!type) continue;
    const cat = type.definition.category;
    if (cat !== "lighting_fixture" && cat !== "electrical_device") continue;
    const leg = normalizedLeg(el);
    if (leg) {
      reads.add(el.id);
      reads.add(el.typeId);
      const bucket = byLeg.get(leg) ?? { controllers: [], loads: [] };
      if (isControllerPart(type)) bucket.controllers.push(el);
      else bucket.loads.push(el);
      byLeg.set(leg, bucket);
    } else if (cat === "lighting_fixture" && emergencyModeOf(el, type) === "unswitched") {
      reads.add(el.id);
      reads.add(el.typeId);
      unswitchedEmLoads.push(el);
    }
  }

  const panelMap = new Map<ElementId, { id: ElementId; name: string; ratings: string }>();
  const registerPanel = (link: ServiceLink | undefined) => {
    if (!link) return null;
    reads.add(link.id);
    const src = elements[link.source.elementId];
    if (src?.kind !== "part") return null;
    reads.add(src.id);
    reads.add(src.typeId);
    let rec = panelMap.get(src.id);
    if (!rec) {
      const dist = distributionOf(elements, src);
      const name = dist?.name || src.mark || src.id;
      const volts = dist ? `${dist.system.lineToLine}V` : "";
      const bus = dist?.busA ? `${dist.busA}A` : "";
      rec = { id: src.id, name, ratings: [bus, volts].filter(Boolean).join(" ") };
      panelMap.set(src.id, rec);
    }
    return rec;
  };

  const buildZone = (key: string, label: string, controllers: PartInstance[], loads: PartInstance[], isEmergencyOnly: boolean): ZoneEntry => {
    controllers.sort((a, b) => partMark(a).localeCompare(partMark(b)));
    loads.sort((a, b) => partMark(a).localeCompare(partMark(b)));
    const allParts = [...controllers, ...loads];
    const rooms = new Set<string>();
    const circuits = new Set<string>();
    const zonePanels = new Map<ElementId, { id: ElementId; name: string; ratings: string }>();
    let protocol = "";
    let hasUnswitchedEm = false;
    let hasSwitchedEm = false;
    let totalWatts = 0;

    for (const p of allParts) {
      const t = partTypeOf(elements, p);
      const rmObj = roomOf(elements, p);
      const rm = rmObj ? (roomText(rmObj) ?? "").trim() : "";
      if (rm) rooms.add(rm);
      const ckt = fieldText(elements, p.id, "circuit").trim();
      if (ckt) circuits.add(ckt);
      const link = linkByMember.get(p.id);
      const pnl = registerPanel(link);
      if (pnl) zonePanels.set(pnl.id, pnl);
      if (!protocol) {
        const pr = protocolOf(p, t);
        if (pr && pr !== "line_voltage") protocol = pr;
      }
      const em = emergencyModeOf(p, t);
      if (em === "unswitched") hasUnswitchedEm = true;
      else if (em === "switched") hasSwitchedEm = true;
      if (!isControllerPart(t)) {
        const w = p.values.watts ?? t?.definition.typeValues.watts ?? p.values.load ?? t?.definition.typeValues.load;
        if (typeof w === "number" && Number.isFinite(w)) totalWatts += w;
      }
    }
    if (!protocol) {
      for (const p of allParts) {
        const pr = protocolOf(p, partTypeOf(elements, p));
        if (pr) {
          protocol = pr;
          break;
        }
      }
    }
    const emSummary = hasSwitchedEm
      ? "UL 924 SWITCHED EM"
      : hasUnswitchedEm
        ? "CONSTANT-HOT EM"
        : "NORMAL";
    return {
      key,
      label,
      isEmergencyOnly,
      room: [...rooms].slice(0, 2).join(" / ") || "GENERAL",
      protocol: protocol || "line_voltage",
      circuits: [...circuits].sort(),
      panels: [...zonePanels.values()],
      controllers,
      loads,
      emSummary,
      totalWatts: Math.round(totalWatts),
    };
  };

  const zones: ZoneEntry[] = [];
  for (const leg of [...byLeg.keys()].sort()) {
    const bucket = byLeg.get(leg)!;
    zones.push(buildZone(leg, `ZONE ${leg.toUpperCase()}`, bucket.controllers, bucket.loads, false));
  }
  if (unswitchedEmLoads.length > 0) {
    zones.push(buildZone("em_unswitched", "EM (UNSWITCHED)", [], unswitchedEmLoads, true));
  }
  const panels = [...panelMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { zones, panels, reads: [...reads] };
}

/** Graph builder for `DIAGRAM_GRAPH_POINT` (`kind: "electrical.controls_diagram"`). */
export function lightingControlsDiagramGraph(elements: Elements, _hints: DiagramHints): DiagramGraph {
  const { zones, panels, reads } = collectControlZones(elements);
  if (zones.length === 0) return { roots: [], warnings: [], reads };

  const zoneNodes: DiagramNode[] = zones.map((z) => {
    const leadPart = z.controllers[0] ?? z.loads[0] ?? null;
    const ctrlText = z.controllers.map(partMark).join(", ") || "UNSWITCHED";
    const loadText = z.loads.map(partMark).join(", ") || "NO LOADS";
    return {
      id: `zone:${z.key}`,
      elementId: leadPart?.id ?? null,
      kind: "equipment",
      labelKind: "equipment",
      name: z.label,
      lines: [
        { text: `${z.label} — ${z.room.toUpperCase()}`, bold: true },
        { text: PROTOCOL_LABELS[z.protocol] ?? z.protocol.toUpperCase() },
        { text: `CTRL: ${ctrlText}` },
        { text: `LOAD: ${loadText}` },
      ],
      levelId: leadPart?.levelId ?? null,
      service: z.isEmergencyOnly ? "emergency" : "lighting_controls",
      children: [],
    };
  });

  const roots: DiagramNode[] =
    panels.length > 0
      ? panels.map((p, idx) => ({
          id: p.id,
          elementId: p.id,
          kind: "panelboard",
          labelKind: "bus",
          name: p.name,
          lines: [{ text: `PANEL ${p.name}`, bold: true }, ...(p.ratings ? [{ text: p.ratings }] : [])],
          levelId: null,
          service: "lighting_controls",
          children: idx === 0 ? zoneNodes : [],
        }))
      : zoneNodes;

  return { roots, warnings: [], reads };
}

function rectPoly(nodeId: string, x: number, y: number, w: number, h: number, weight: "thin" | "medium" | "heavy" = "medium", dashed = false): OneLineItem {
  return {
    nodeId,
    shape: "polyline",
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    closed: true,
    weight,
    ...(dashed ? { dashed: true } : {}),
  };
}

function textBox(nodeId: string, x: number, yTop: number, widthMm: number, lines: readonly OneLineTextLine[], align: "left" | "center" = "center"): OneLineItem {
  return { nodeId, shape: "text", at: { x, y: yTop }, widthMm, lines, align };
}

/** Lay out the live lighting controls schematic diagram in drawing mm (y up). */
export function layoutLightingControlsDiagram(input: DiagramGraphLayoutInput): DiagramGraphLayoutResult {
  const { elements, hints } = input;
  const { zones, panels } = collectControlZones(elements);
  const items: OneLineItem[] = [];
  const nodes: DiagramLayoutNode[] = [];
  const ranges: Record<string, readonly [number, number]> = {};
  const entries: Record<string, { x: number; y: number }> = {};

  if (zones.length === 0) {
    return { items, extent: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, nodes, ranges, entries };
  }

  const COL_W = 54;
  const COL_GAP = 10;
  const totalW = zones.length * COL_W + Math.max(0, zones.length - 1) * COL_GAP;
  const originX = 0;

  // Vertical tiers (y up, drawing mm):
  //   Loads box:      y = 0 .. 28
  //   Control wire:   y = 28 .. 46
  //   Controller box: y = 46 .. 74
  //   Feed wire:      y = 74 .. 92
  //   Panel bus bar:  y = 92 .. 110
  //   Title:          y = 124
  const LOAD_Y = 0;
  const LOAD_H = 26;
  const CTRL_Y = 46;
  const CTRL_H = 26;
  const BUS_Y = 92;
  const BUS_H = 16;

  // Title banner
  const titleText = (hints.title ?? "LIGHTING CONTROLS & SWITCHING DIAGRAM").toUpperCase();
  const titleW = Math.max(totalW, oneLineTextWidth([{ text: titleText, bold: true }]) + 12);
  items.push(textBox("title", originX + totalW / 2 - titleW / 2, BUS_Y + BUS_H + 14, titleW, [{ text: titleText, bold: true }], "center"));

  // Top tier: feeding panel bus bar(s)
  const panelList = panels.length > 0 ? panels : [{ id: "bus:lighting" as ElementId, name: "LIGHTING PANEL", ratings: "277/480V" }];
  const busSpan = Math.max(COL_W, (totalW - (panelList.length - 1) * 10) / panelList.length);
  const panelCenterX = new Map<string, number>();

  panelList.forEach((p, idx) => {
    const px = originX + idx * (busSpan + 10);
    const cx = px + busSpan / 2;
    panelCenterX.set(p.id, cx);
    const startIdx = items.length;
    items.push(rectPoly(p.id, px, BUS_Y, busSpan, BUS_H, "heavy"));
    // Bold horizontal bus bar stroke inside the panel header.
    items.push({ nodeId: p.id, shape: "line", points: [{ x: px + 3, y: BUS_Y + 3.5 }, { x: px + busSpan - 3, y: BUS_Y + 3.5 }], weight: "heavy" });
    const lines: OneLineTextLine[] = [{ text: `PANEL ${p.name}`, bold: true }];
    if (p.ratings) lines.push({ text: p.ratings });
    items.push(textBox(p.id, px + 2, BUS_Y + BUS_H - 2.5, busSpan - 4, lines, "center"));
    ranges[p.id] = [startIdx, items.length];
    entries[p.id] = { x: cx, y: BUS_Y };
    nodes.push({ id: p.id, name: p.name, center: { x: cx, y: BUS_Y + BUS_H / 2 }, depth: 0, kind: "panelboard" });
  });

  // Main horizontal distribution feeder rail below the panels
  const RAIL_Y = BUS_Y - 8;
  if (zones.length > 1) {
    const firstColCx = originX + COL_W / 2;
    const lastColCx = originX + (zones.length - 1) * (COL_W + COL_GAP) + COL_W / 2;
    items.push({ nodeId: "rail:power", shape: "line", points: [{ x: firstColCx, y: RAIL_Y }, { x: lastColCx, y: RAIL_Y }], weight: "medium" });
  }
  panelList.forEach((p) => {
    const cx = panelCenterX.get(p.id) ?? originX + totalW / 2;
    items.push({ nodeId: p.id, shape: "line", points: [{ x: cx, y: BUS_Y }, { x: cx, y: RAIL_Y }], weight: "medium" });
  });

  // Per-zone columns
  zones.forEach((z, idx) => {
    const x = originX + idx * (COL_W + COL_GAP);
    const cx = x + COL_W / 2;
    const nodeId = `zone:${z.key}`;
    const startIdx = items.length;
    const dashedCtrl = z.protocol !== "line_voltage" || z.controllers.length > 0;

    // Drop from power rail to controller/zone block
    items.push({ nodeId, shape: "line", points: [{ x: cx, y: RAIL_Y }, { x: cx, y: CTRL_Y + CTRL_H }], weight: "thin" });
    const cktTag = z.circuits.slice(0, 2).join(", ") || "CKT TBD";
    items.push(textBox(nodeId, x + 2, RAIL_Y - 1.2, COL_W - 4, [{ text: cktTag }], "center"));

    // Tier 2: Control Zone / Controller card
    items.push(rectPoly(nodeId, x, CTRL_Y, COL_W, CTRL_H, z.isEmergencyOnly ? "heavy" : "medium", z.isEmergencyOnly));
    // Header divider
    items.push({ nodeId, shape: "line", points: [{ x, y: CTRL_Y + CTRL_H - 7.5 }, { x: x + COL_W, y: CTRL_Y + CTRL_H - 7.5 }], weight: "thin" });
    items.push(
      textBox(
        nodeId,
        x + 2,
        CTRL_Y + CTRL_H - 1.5,
        COL_W - 4,
        [{ text: `${z.label} · ${z.room.toUpperCase()}`, bold: true }],
        "center",
      ),
    );
    const ctrlMarks = z.controllers.map((c) => {
      const t = partTypeOf(elements, c);
      const fam = t?.definition.familyName ?? "";
      const tag = /dimmer/i.test(fam) ? "DIM" : /three-way/i.test(fam) ? "3W" : /four-way/i.test(fam) ? "4W" : /occupancy/i.test(fam) ? "OCC" : /daylight/i.test(fam) ? "DL" : "SW";
      return `${partMark(c)} (${tag})`;
    });
    const ctrlLines: OneLineTextLine[] =
      ctrlMarks.length > 0
        ? [
            { text: ctrlMarks.slice(0, 2).join(" + ") },
            ...(ctrlMarks.length > 2 ? [{ text: `+${ctrlMarks.length - 2} MORE` }] : []),
            { text: PROTOCOL_LABELS[z.protocol] ?? z.protocol.toUpperCase() },
          ]
        : [{ text: "UNSWITCHED FEED" }, { text: "CONSTANT HOT / EM" }];
    items.push(textBox(nodeId, x + 2, CTRL_Y + CTRL_H - 9.2, COL_W - 4, ctrlLines, "center"));

    // Control wiring drop between controller block and controlled loads block
    items.push({ nodeId, shape: "line", points: [{ x: cx, y: CTRL_Y }, { x: cx, y: LOAD_Y + LOAD_H }], weight: "thin", dashed: dashedCtrl });
    // Protocol badge oval centered on the control drop
    const badgeY = (CTRL_Y + LOAD_Y + LOAD_H) / 2;
    const badgeText = z.isEmergencyOnly ? "EM FEED" : (PROTOCOL_LABELS[z.protocol] ?? "CTRL");
    items.push({ nodeId, shape: "oval", center: { x: cx, y: badgeY }, widthMm: Math.max(18, oneLineTextWidth([{ text: badgeText }]) + 6), heightMm: 6.2, text: badgeText });

    // Tier 3: Controlled loads block
    items.push(rectPoly(nodeId, x, LOAD_Y, COL_W, LOAD_H, "medium"));
    const loadMarks = z.loads.map(partMark);
    const loadSummary =
      loadMarks.length <= 3
        ? loadMarks.join(", ") || "NO LOADS ASSIGNED"
        : `${loadMarks.slice(0, 3).join(", ")} (+${loadMarks.length - 3})`;
    const loadLines: OneLineTextLine[] = [
      { text: `${z.loads.length} ${z.loads.length === 1 ? "FIXTURE" : "FIXTURES"}`, bold: true },
      { text: loadSummary },
      { text: z.totalWatts > 0 ? `${z.totalWatts} W · ${z.emSummary}` : z.emSummary },
    ];
    items.push(textBox(nodeId, x + 2, LOAD_Y + LOAD_H - 2.5, COL_W - 4, loadLines, "center"));

    ranges[nodeId] = [startIdx, items.length];
    entries[nodeId] = { x: cx, y: CTRL_Y + CTRL_H };
    nodes.push({ id: nodeId, name: z.label, center: { x: cx, y: CTRL_Y + CTRL_H / 2 }, depth: 1, kind: "control_zone" });
  });

  // Compact wiring legend at the bottom
  const legendY = LOAD_Y - 9;
  const legendLines: OneLineTextLine[] = [
    { text: "LEGEND: SOLID = BRANCH POWER FEED" },
    { text: "DASHED = SWITCH LEG / CONTROL WIRING" },
    { text: `PROTOCOLS: ${[...new Set(zones.map((z) => PROTOCOL_WIRE_LABELS[z.protocol] ?? z.protocol.toUpperCase()))].join("  |  ")}` },
  ];
  const legendW = Math.max(totalW, oneLineTextWidth(legendLines) + 8);
  items.push(textBox("legend", originX, legendY, legendW, legendLines, "left"));

  // Notes from hints if provided
  if (hints.notes && hints.notes.length > 0) {
    const notesY = legendY - oneLineTextHeight(legendLines) - 4;
    const notesLines: OneLineTextLine[] = [{ text: "NOTES:", bold: true }, ...hints.notes.map((n, i) => ({ text: `${i + 1}. ${n.toUpperCase()}` }))];
    const notesW = Math.max(totalW, oneLineTextWidth(notesLines) + 6);
    items.push(textBox("notes", originX, notesY, notesW, notesLines, "left"));
  }

  const extent = oneLineItemsExtent(items);
  // Small margin around the diagram border so text never clips on sheet placement.
  const pad = ONE_LINE_TEXT_MM * 2;
  return {
    items,
    extent: { min: { x: extent.min.x - pad, y: extent.min.y - pad }, max: { x: extent.max.x + pad, y: extent.max.y + pad } },
    nodes,
    ranges,
    entries,
  };
}

export const CONTROLS_DIAGRAM_GRAPH: DiagramGraphDef = {
  kind: CONTROLS_DIAGRAM_KIND,
  build: (elements, hints) => lightingControlsDiagramGraph(elements, hints),
};

export const CONTROLS_DIAGRAM_LAYOUT_ROW: DiagramLayoutRow = {
  kind: CONTROLS_DIAGRAM_KIND,
  label: "Lighting controls diagram",
  serviceSections: false,
  check: () => "Lighting controls diagrams are live from the model (no static spec).",
  layout: () => ({ refused: "Lighting controls diagrams are live from the model." }),
  layoutGraph: (input) => layoutLightingControlsDiagram(input),
};
