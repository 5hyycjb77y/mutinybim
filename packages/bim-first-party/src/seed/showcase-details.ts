import {
  DEFAULT_NOTE_SIZE_MM,
  detailContentBounds,
  executeCommand,
  layoutNote,
  lineStyleFor,
  rectangleLines,
  type Command,
  type DetailLineStyleId,
  type HatchPattern,
  type ModelState,
  type NoteAlign,
  type NoteLeaderArrow,
  type RegionTone,
  type Revision,
  type Vec2,
} from "@permitzip/bim-kernel";

const IN = 25.4;
const pt = (xIn: number, yIn: number): Vec2 => ({
  x: Math.round(xIn * IN * 1000) / 1000,
  y: Math.round(yIn * IN * 1000) / 1000,
});

function run(model: ModelState, commands: readonly Command[]): ModelState {
  let cur = model;
  for (const command of commands) {
    const res = executeCommand(cur, command);
    if (!res.ok) {
      throw new Error(`showcase-details command ${command.type} failed: ${res.error.code} — ${res.error.message}`);
    }
    cur = { ...res.model, revision: (cur.revision + 1) as Revision };
  }
  return cur;
}

class DetailBuilder {
  private seq = 0;
  readonly commands: Command[] = [];
  constructor(
    readonly viewId: string,
    readonly scale: number,
    readonly prefix: string,
  ) {}

  private nextId(tag: string): string {
    this.seq += 1;
    return `${this.prefix}-${tag}-${this.seq}`;
  }

  line(from: Vec2, to: Vec2, style: DetailLineStyleId): void {
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("ln"),
      ownerId: this.viewId,
      shape: "line",
      points: [from, to],
      lineStyle: lineStyleFor(style),
    });
  }

  chain(points: readonly Vec2[], style: DetailLineStyleId): void {
    for (let i = 0; i + 1 < points.length; i += 1) {
      this.line(points[i]!, points[i + 1]!, style);
    }
  }

  rect(xIn: number, yIn: number, wIn: number, hIn: number, style: DetailLineStyleId): void {
    const segs = rectangleLines(pt(xIn, yIn), pt(xIn + wIn, yIn + hIn));
    for (const [a, b] of segs) {
      this.line(a, b, style);
    }
  }

  circle(center: Vec2, radiusIn: number, style: DetailLineStyleId): void {
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("cir"),
      ownerId: this.viewId,
      shape: "circle",
      points: [center, { x: center.x + radiusIn * IN, y: center.y }],
      lineStyle: lineStyleFor(style),
    });
  }

  regionRect(
    xIn: number,
    yIn: number,
    wIn: number,
    hIn: number,
    opts: { hatch?: HatchPattern; tone?: RegionTone; boundary?: boolean; masking?: boolean; lineStyle?: DetailLineStyleId },
  ): void {
    const a = pt(xIn, yIn);
    const b = pt(xIn + wIn, yIn + hIn);
    this.regionPoints(
      [
        { x: a.x, y: a.y },
        { x: b.x, y: a.y },
        { x: b.x, y: b.y },
        { x: a.x, y: b.y },
      ],
      opts,
    );
  }

  regionPoints(
    points: readonly Vec2[],
    opts: { hatch?: HatchPattern; tone?: RegionTone; boundary?: boolean; masking?: boolean; lineStyle?: DetailLineStyleId },
  ): void {
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("reg"),
      ownerId: this.viewId,
      shape: "region",
      points: [...points],
      fill: {
        pattern: opts.masking ? "solid" : (opts.hatch ?? "diagonal"),
        ...(opts.masking ? { masking: true } : {}),
        ...(opts.tone ? { tone: opts.tone } : {}),
        ...(opts.boundary !== undefined ? { boundary: opts.boundary } : {}),
      },
      ...(opts.lineStyle ? { lineStyle: lineStyleFor(opts.lineStyle) } : {}),
    });
  }

  component(
    symbolId: string,
    at: Vec2,
    opts: { widthIn: number; heightIn: number; rotationDeg?: number; mirror?: boolean },
  ): void {
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("cmp"),
      ownerId: this.viewId,
      shape: "component",
      points: [at],
      component: {
        symbolId,
        widthMm: opts.widthIn * IN,
        heightMm: opts.heightIn * IN,
        ...(opts.rotationDeg !== undefined ? { rotationDeg: opts.rotationDeg } : {}),
        ...(opts.mirror ? { mirror: true } : {}),
      },
    });
  }

  breakLine(from: Vec2, to: Vec2, maskSide: "left" | "right", maskDepthIn: number): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const heightMm = Math.max(40, Math.min(len * 0.22, 0.22 * IN * this.scale));
    const depth = maskDepthIn * IN;
    const sideSign = maskSide === "left" ? 1 : -1;
    const nx = -uy * sideSign;
    const ny = ux * sideSign;
    const lx = -uy;
    const ly = ux;
    const zigAt = (u: number, vOffset: number): Vec2 => ({
      x: from.x + ux * (u * len) + lx * (vOffset * heightMm),
      y: from.y + uy * (u * len) + ly * (vOffset * heightMm),
    });
    const zig: Vec2[] = [
      zigAt(0, 0),
      zigAt(0.42, 0),
      zigAt(0.46, 0.45),
      zigAt(0.54, -0.45),
      zigAt(0.58, 0),
      zigAt(1, 0),
    ];
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("brkm"),
      ownerId: this.viewId,
      shape: "region",
      points: [
        ...zig,
        { x: to.x + nx * depth, y: to.y + ny * depth },
        { x: from.x + nx * depth, y: from.y + ny * depth },
      ],
      fill: { pattern: "solid", masking: true, boundary: false },
    });
    const flip = maskSide === "right";
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("brk"),
      ownerId: this.viewId,
      shape: "component",
      points: [flip ? to : from],
      component: {
        symbolId: "break_line",
        widthMm: len,
        heightMm,
        rotationDeg: flip ? rotationDeg + 180 : rotationDeg,
      },
    });
  }

  dimension(from: Vec2, to: Vec2, offsetIn: number, suffix?: string): void {
    this.commands.push({
      type: "add_drawing_item",
      itemId: this.nextId("dim"),
      ownerId: this.viewId,
      shape: "dimension",
      points: [from, to],
      dim: {
        kind: "aligned",
        offsetMm: offsetIn * IN,
        ...(suffix ? { suffix } : {}),
      },
    });
  }

  note(at: Vec2, widthIn: number, text: string, opts: { align?: NoteAlign; bold?: boolean; textHeightIn?: number } = {}): void {
    const textSize = (opts.textHeightIn ?? DEFAULT_NOTE_SIZE_MM / IN) * IN;
    const paragraphs = text.split("\n").map((line) => ({
      ...(opts.align ? { align: opts.align } : {}),
      runs: [{ text: line, ...(opts.bold ? { bold: true } : {}) }],
    }));
    this.commands.push({
      type: "create_text_note",
      itemId: this.nextId("note"),
      ownerId: this.viewId,
      at,
      width: widthIn * IN,
      textSize,
      paragraphs,
      mask: true,
    });
  }

  calloutStack(
    side: "left" | "right",
    xIn: number,
    topYIn: number,
    widthIn: number,
    entries: readonly { readonly text: string; readonly to: Vec2 }[],
  ): void {
    const widthMm = widthIn * IN;
    const textSizeMm = DEFAULT_NOTE_SIZE_MM;
    const gapPaperMm = 0.11 * IN;
    const marginXMm = xIn * IN;
    const widthModelMm = widthMm * this.scale;
    const noteX = side === "left" ? marginXMm - widthModelMm : marginXMm;
    const align: NoteAlign = side === "left" ? "right" : "left";
    const arrow: NoteLeaderArrow = "filled_arrow";
    const shoulderModel = 0.18 * IN * this.scale;

    let cursorY = topYIn * IN;
    for (const entry of entries) {
      const paragraphs = entry.text.split("\n").map((line) => ({
        align,
        runs: [{ text: line }],
      }));
      const measured = layoutNote(paragraphs, { width: widthMm, height: null, size: textSizeMm });
      const firstMidPaperMm = measured.lines[0] ? measured.lines[0].top + measured.lines[0].height / 2 : measured.height / 2;
      const at: Vec2 = { x: Math.round(noteX * 1000) / 1000, y: Math.round(cursorY * 1000) / 1000 };
      const attachY = at.y - firstMidPaperMm * this.scale;
      const elbowX = side === "left" ? marginXMm + shoulderModel : marginXMm - shoulderModel;
      this.commands.push({
        type: "create_text_note",
        itemId: this.nextId("call"),
        ownerId: this.viewId,
        at,
        width: widthMm,
        textSize: textSizeMm,
        paragraphs,
        mask: true,
        leaders: [
          {
            to: entry.to,
            elbow: { x: Math.round(elbowX * 1000) / 1000, y: Math.round(attachY * 1000) / 1000 },
            arrow,
          },
        ],
      });
      cursorY -= (measured.height + gapPaperMm) * this.scale;
    }
  }
}

/**
 * Appends Sheet M-501 (Mechanical Details) with two CAD-standard 2D drafting details
 * tailored to the Showcase building's RTU-1 (Carrier 50FC-A06) and restroom exhaust
 * assembly: lineweight hierarchy, hatched assemblies, detail components, break lines
 * with cut masks, real CAD dimensions, and opaque-masked aligned callout stacks.
 */
export function appendShowcaseDetails(model: ModelState): ModelState {
  const scale = 16; // 3/4" = 1'-0"
  const rtu = new DetailBuilder("view-detail-rtu-curb", scale, "dtl-rtu");
  rtu.commands.push({
    type: "create_view",
    viewId: rtu.viewId,
    name: 'RTU-1 on 14" Insulated Roof Curb Detail',
    viewType: "detail",
    props: { scale, discipline: "mechanical" },
  });

  // Service & condenser clearance envelopes
  rtu.rect(-48, 15.5, 48, 34, "hidden");
  rtu.rect(64, 15.5, 36, 34, "hidden");

  // East flat roof assembly (metal deck + rigid insulation + roofing membrane)
  for (const [rx, rw] of [
    [-46, 50],
    [60, 38],
  ] as const) {
    rtu.regionRect(rx, -5.5, rw, 3.5, { hatch: "metal_deck", tone: "halftone", lineStyle: "medium" });
    rtu.regionRect(rx, -2, rw, 3.5, { hatch: "insulation_rigid", tone: "screened", lineStyle: "thin" });
    rtu.line(pt(rx, 1.5), pt(rx + rw, 1.5), "wide");
  }
  rtu.breakLine(pt(-44, -7.5), pt(-44, 4), "left", 5);
  rtu.breakLine(pt(96, -7.5), pt(96, 4), "right", 5);

  // 14" insulated roof curb rails (left & right mirrored)
  rtu.component("mechanical.roof_curb_rail", pt(-2, 1.5), { widthIn: 8, heightIn: 14 });
  rtu.component("mechanical.roof_curb_rail", pt(58, 1.5), { widthIn: 8, heightIn: 14, mirror: true });

  // Carrier 50FC-A06 RTU-1 cabinet + condenser discharge shroud + OA intake hood
  rtu.regionRect(0, 15.5, 64, 34, { hatch: "solid", tone: "screened", boundary: false });
  rtu.rect(0, 15.5, 64, 34, "wide");
  rtu.line(pt(24, 15.5), pt(24, 49.5), "thin");
  rtu.line(pt(48, 15.5), pt(48, 49.5), "thin");
  rtu.rect(8, 49.5, 22, 4, "medium");
  rtu.chain([pt(64, 39.5), pt(74, 31.5), pt(74, 23.5), pt(64, 23.5)], "medium");
  rtu.note(pt(8, 37.5), 2.9, "CARRIER 50FC-A06 PACKAGED RTU\nRTU-1 (5-TON, 480V/3PH)\nEAST PARAPET ROOF DECK", {
    align: "center",
    bold: true,
    textHeightIn: 0.1,
  });

  // Supply & Return vertical curb drops with 1" NFPA 90A acoustic liner
  rtu.line(pt(10, 15.5), pt(10, -40), "wide");
  rtu.line(pt(24, 15.5), pt(24, -40), "wide");
  rtu.regionRect(10, -35, 1.5, 28, { hatch: "acoustic", tone: "halftone", lineStyle: "thin" });
  rtu.regionRect(22.5, -35, 1.5, 28, { hatch: "acoustic", tone: "halftone", lineStyle: "thin" });
  rtu.line(pt(11.5, -14), pt(22.5, -18), "medium");
  rtu.circle(pt(17, -16), 0.75, "thin");
  rtu.component("flow_arrow", pt(15.5, -24), { widthIn: 5, heightIn: 3, rotationDeg: -90 });

  rtu.line(pt(40, 15.5), pt(40, -40), "wide");
  rtu.line(pt(54, 15.5), pt(54, -40), "wide");
  rtu.regionRect(40, -35, 1.5, 28, { hatch: "acoustic", tone: "halftone", lineStyle: "thin" });
  rtu.regionRect(52.5, -35, 1.5, 28, { hatch: "acoustic", tone: "halftone", lineStyle: "thin" });
  rtu.component("flow_arrow", pt(48.5, -18), { widthIn: 5, heightIn: 3, rotationDeg: 90 });

  // Ceiling plane & concentric plenum transition box
  rtu.line(pt(-12, -52), pt(8, -52), "medium");
  rtu.line(pt(56, -52), pt(76, -52), "medium");
  rtu.component("mechanical.concentric_diffuser", pt(8, -53), { widthIn: 48, heightIn: 13 });

  // Real CAD dimensions
  rtu.dimension(pt(-48, 49.5), pt(0, 49.5), -0.45, " SERVICE CLR.");
  rtu.dimension(pt(64, 49.5), pt(100, 49.5), -0.45, " COND. / OA CLR.");
  rtu.dimension(pt(0, 1.5), pt(0, 15.5), -0.55, " CURB");

  // Aligned margin callouts (zero overlaps)
  rtu.calloutStack("left", -54, 20, 2.85, [
    { text: '14" INSULATED ROOF CURB\n(CRRFCURB) W/ CANT & FLASHING', to: pt(0.5, 11.5) },
  ]);
  rtu.calloutStack("left", -54, 3.5, 2.85, [
    { text: "FLAT ROOF METAL DECK\nW/ RIGID INSULATION & MEMBRANE", to: pt(-28, -0.5) },
  ]);
  rtu.calloutStack("left", -54, -16, 2.85, [
    { text: "SUPPLY DROP DUCT W/ BAL. DAMPER\nSEAL ALL JOINTS (SMACNA CLASS A)", to: pt(10, -20) },
    { text: 'FINISHED CEILING PLANE (9\'-6" AFF)', to: pt(-6, -52) },
  ]);
  rtu.calloutStack("right", 106, 35, 2.95, [
    { text: "OUTDOOR AIR INTAKE HOOD\nW/ BIRD SCREEN & MOTORIZED DAMPER", to: pt(74, 29) },
  ]);
  rtu.calloutStack("right", 106, -16, 2.95, [
    { text: 'RETURN DROP DUCT W/ 1" INTERNAL\nACOUSTIC DUCT LINER (NFPA 90A)', to: pt(54, -20) },
    { text: "PLENUM TRANSITION & CONCENTRIC BOX\nCONNECT TO 10'-8\" PLENUM TRUNKS", to: pt(56, -46) },
  ]);

  // ── DETAIL 2: RESTROOM EXHAUST FAN & EXTERIOR WALL CAP ──
  const fan = new DetailBuilder("view-detail-ef-wall", scale, "dtl-ef");
  fan.commands.push({
    type: "create_view",
    viewId: fan.viewId,
    name: "Restroom Exhaust & Exterior Wall Cap Detail",
    viewType: "detail",
    props: { scale, discipline: "mechanical" },
  });

  // Exterior CMU backup + interior gypsum board
  fan.regionRect(42, -14, 8, 42, { hatch: "masonry", tone: "halftone", lineStyle: "wide" });
  fan.regionRect(40, -14, 2, 42, { hatch: "gypsum", tone: "screened", lineStyle: "thin" });
  fan.breakLine(pt(37.5, 25.5), pt(52.5, 25.5), "left", 5);
  fan.breakLine(pt(52.5, -11.5), pt(37.5, -11.5), "left", 5);

  // Restroom ceiling plane
  fan.regionRect(-10, -2, 50, 2, { hatch: "gypsum", tone: "screened", lineStyle: "medium" });
  fan.line(pt(-10, 0), pt(40, 0), "wide");
  fan.breakLine(pt(-8.5, -4), pt(-8.5, 4), "left", 4);

  // Ceiling cabinet exhaust assembly
  fan.component("mechanical.exhaust_fan_ceiling", pt(2, -1), { widthIn: 14, heightIn: 13 });

  // 6" Ø rigid galvanized exhaust duct sloped toward exterior with opaque cut mask through wall
  fan.regionPoints([pt(16, 9), pt(50, 7.5), pt(50, 1.5), pt(16, 3)], { masking: true, boundary: false });
  fan.chain([pt(16, 9), pt(50, 7.5)], "wide");
  fan.chain([pt(16, 3), pt(50, 1.5)], "wide");
  fan.line(pt(16, 6), pt(50, 4.5), "center");
  fan.component("flow_arrow", pt(26, 4), { widthIn: 8, heightIn: 3.5, rotationDeg: -2.5 });

  // 6" Ø exterior hooded wall cap w/ integral BDD & 1/4" bird screen
  fan.component("mechanical.hooded_louver", pt(50, -0.5), { widthIn: 10, heightIn: 10 });

  // CAD dimensions
  fan.dimension(pt(0, -4), pt(16, -4), 0.45, " FAN HSG.");
  fan.dimension(pt(40, -14), pt(50, -14), 0.45);

  // Aligned margin callouts
  fan.calloutStack("left", -16, 24, 3.15, [
    { text: "RESTROOM EXHAUST ASSEMBLY (EF-1)\nINTEGRAL BACKDRAFT DAMPER\nWIRED TO LIGHTING CIRCUIT", to: pt(6, 11) },
    { text: '6" Ø RIGID GALV. EXHAUST DUCT\nSLOPE 1/4" PER FT TO EXTERIOR\nINSULATE W/ R-6 WRAP IN PLENUM', to: pt(20, 8.8) },
    { text: 'RESTROOM CEILING (9\'-6" AFF)', to: pt(-2, 0) },
  ]);
  fan.calloutStack("right", 66, 24, 2.85, [
    { text: "2-HR CMU EXTERIOR WALL\nSEAL PENETRATION WEATHERTIGHT", to: pt(48, 18) },
    { text: '6" Ø HOODED WALL CAP\nW/ INTEGRAL BDD & 1/4" BIRD SCREEN\nCAULK FLANGE PERIMETER', to: pt(57, 6) },
  ]);

  let m = run(model, [...rtu.commands, ...fan.commands]);

  // Fit tight CAD crops around all drawn items, notes, leaders, and dimensions
  const padMm = 0.35 * IN * scale;
  const cropCmds: Command[] = [];
  for (const vid of [rtu.viewId, fan.viewId]) {
    const b = detailContentBounds(m, vid);
    if (!b) throw new Error(`showcase-details: empty bounds for ${vid}`);
    cropCmds.push({
      type: "set_view_crop",
      viewId: vid,
      crop: {
        min: { x: Math.round((b.min.x - padMm) * 1000) / 1000, y: Math.round((b.min.y - padMm) * 1000) / 1000 },
        max: { x: Math.round((b.max.x + padMm) * 1000) / 1000, y: Math.round((b.max.y + padMm) * 1000) / 1000 },
      },
    });
  }

  // Place both drafted details cleanly on Arch D Sheet M-501
  m = run(m, [
    ...cropCmds,
    {
      type: "create_sheet",
      sheetId: "sheet-m501",
      number: "M-501",
      name: "MECHANICAL DETAILS",
      discipline: "mechanical",
      group: "Mechanical",
      sortOrder: 403,
    },
    {
      type: "place_viewport",
      viewportId: "vp-detail-rtu-curb",
      sheetId: "sheet-m501",
      viewId: rtu.viewId,
      center: { x: Math.round(14.5 * IN), y: Math.round(15.8 * IN) },
    },
    {
      type: "place_viewport",
      viewportId: "vp-detail-ef-wall",
      sheetId: "sheet-m501",
      viewId: fan.viewId,
      center: { x: Math.round(14.5 * IN), y: Math.round(6.2 * IN) },
    },
  ]);

  return m;
}
