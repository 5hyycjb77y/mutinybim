import {
  DEFAULT_SETTINGS,
  asElementId,
  asRevision,
  elementValues,
  openingPosition,
  pushTo,
  recomputeDerived,
  roundVec,
  type Discipline,
  type ElementId,
  type ModelState,
  type NetworkService,
  type Partition,
  type Profile,
  type Vec2,
  type Wall,
} from "@permitzip/bim-kernel";
import { seedTreeNetwork, type NetworkSize, type SeedBuilder, type TreeNetworkSeed } from "@permitzip/bim-pack-mechanical/seed";

export type { NetworkSize } from "@permitzip/bim-pack-mechanical/seed";

/**
 * The all-discipline load-test building (moved out of the kernel's
 * `fullbim.ts` in round 12, byte for byte): it composes the first-party
 * add-ons' seeders with architecture, structure and documentation, so it
 * lives with the add-ons PermitZIP ships, not in the kernel.
 */

const FT = 304.8;
const IN = 25.4;
/** Every zone is a 100 ft x 100 ft block (10,000 sq ft). */
const ZONE_FT = 100;
export const ZONE_SQ_FT = ZONE_FT * ZONE_FT;

export interface FullBimOptions {
  readonly floors: number;
  readonly zonesPerFloor: number;
  readonly modelId?: string;
  /** Per-zone system sizes. Defaults are the realistic densities in AREA_LOADING.md. */
  readonly air?: NetworkSize;
  readonly water?: NetworkSize;
  readonly sprinkler?: NetworkSize;
  readonly power?: NetworkSize;
  readonly lighting?: NetworkSize;
  /** Room grid per zone: columns x rows of rooms. */
  readonly rooms?: { readonly cols: number; readonly rows: number };
}

const DEFAULT_ZONE = {
  air: { trunks: 9, segments: 10 },
  water: { trunks: 9, segments: 10 },
  sprinkler: { trunks: 4, segments: 9 },
  power: { trunks: 8, segments: 9 },
  lighting: { trunks: 4, segments: 9 },
  rooms: { cols: 5, rows: 8 },
} as const;

/** Furniture and casework placed in every room (ceiling and floor finish come on top). */
const ROOM_CONTENTS: ReadonlyArray<{ category: "furniture" | "casework"; typeName: string; at: Vec2; size: Vec2 }> = [
  { category: "furniture", typeName: "Patient bed", at: { x: 0.3, y: 0.5 }, size: { x: 3 * FT, y: 7 * FT } },
  { category: "furniture", typeName: "Visitor chair", at: { x: 0.7, y: 0.3 }, size: { x: 2 * FT, y: 2 * FT } },
  { category: "furniture", typeName: "Overbed table", at: { x: 0.5, y: 0.6 }, size: { x: 3 * FT, y: 1.5 * FT } },
  { category: "casework", typeName: "Base cabinet 36 in", at: { x: 0.85, y: 0.8 }, size: { x: 3 * FT, y: 2 * FT } },
  { category: "casework", typeName: "Wall cabinet 30 in", at: { x: 0.85, y: 0.9 }, size: { x: 2.5 * FT, y: 1 * FT } },
  { category: "furniture", typeName: "Headwall unit", at: { x: 0.1, y: 0.5 }, size: { x: 1 * FT, y: 6 * FT } },
];

/**
 * Presets. A zone at default density holds 5,086 elements (~510 per 1,000
 * sq ft across all disciplines and annotation), so the named tiers are
 * buildings of roughly 0.49M, 0.98M and 1.96M sq ft.
 */
export const FULL_BIM_TIERS = {
  XS: {
    floors: 2,
    zonesPerFloor: 2,
    air: { trunks: 2, segments: 3 },
    water: { trunks: 2, segments: 3 },
    sprinkler: { trunks: 1, segments: 3 },
    power: { trunks: 1, segments: 3 },
    lighting: { trunks: 1, segments: 3 },
    rooms: { cols: 2, rows: 2 },
  },
  "250k": { floors: 7, zonesPerFloor: 7 },
  "500k": { floors: 14, zonesPerFloor: 7 },
  "1M": { floors: 14, zonesPerFloor: 14 },
} as const satisfies Record<string, FullBimOptions>;

const base = { version: 1, authoredRev: {} };

interface ZoneContext {
  readonly level: string;
  readonly zone: string;
  readonly origin: Vec2;
  readonly prefix: string;
  part(discipline: Discipline): Partition;
}

function rect(o: Vec2, w: number, h: number): Vec2[] {
  return [o, { x: o.x + w, y: o.y }, { x: o.x + w, y: o.y + h }, { x: o.x, y: o.y + h }];
}

/** Rooms on a grid with walls between them, a door per room and windows on the outside. */
function addArchitecture(b: SeedBuilder, z: ZoneContext, rooms: { cols: number; rows: number }): { doors: ElementId[]; rooms: ElementId[]; wallPairs: Array<[ElementId, ElementId]> } {
  const part = z.part("architecture");
  const zone = ZONE_FT * FT;
  const roomW = zone / rooms.cols;
  const roomH = zone / rooms.rows;
  b.elements.push({ ...base, partition: part, id: asElementId(`${z.prefix}-slab`), kind: "slab", outline: rect(z.origin, zone, zone), thickness: 8 * IN });

  const hWall = (r: number, c: number): string => `${z.prefix}-wh${r}-${c}`;
  const vWall = (c: number, r: number): string => `${z.prefix}-wv${c}-${r}`;
  const wall = (id: string, start: Vec2, end: Vec2, exterior: boolean): Wall => ({
    ...base,
    partition: part,
    id: asElementId(id),
    kind: "wall",
    start,
    end,
    thickness: exterior ? 12 * IN : 5 * IN,
    height: 10 * FT,
    wallType: exterior ? "Exterior - CMU w/ insulation" : "Interior partition - 3 5/8 in stud",
  });
  const walls = new Map<string, Wall>();
  for (let r = 0; r <= rooms.rows; r++) {
    for (let c = 0; c < rooms.cols; c++) {
      const y = z.origin.y + r * roomH;
      const w = wall(hWall(r, c), { x: z.origin.x + c * roomW, y }, { x: z.origin.x + (c + 1) * roomW, y }, r === 0 || r === rooms.rows);
      walls.set(w.id, w);
    }
  }
  for (let c = 0; c <= rooms.cols; c++) {
    for (let r = 0; r < rooms.rows; r++) {
      const x = z.origin.x + c * roomW;
      const w = wall(vWall(c, r), { x, y: z.origin.y + r * roomH }, { x, y: z.origin.y + (r + 1) * roomH }, c === 0 || c === rooms.cols);
      walls.set(w.id, w);
    }
  }
  b.elements.push(...walls.values());

  const doors: ElementId[] = [];
  const roomIds: ElementId[] = [];
  const wallPairs: Array<[ElementId, ElementId]> = [];
  const opening = (id: string, hostId: string, openingType: "door" | "window", offset: number, width: number, mark: string): void => {
    const host = walls.get(hostId);
    if (!host) throw new Error(`generator: wall ${hostId} missing`);
    b.elements.push({
      ...base,
      partition: part,
      id: asElementId(id),
      kind: "opening",
      openingType,
      mark,
      hostId: host.id,
      offset,
      width,
      height: openingType === "door" ? 7 * FT : 4 * FT,
      position: roundVec(openingPosition(host, offset)),
    });
  };
  for (let r = 0; r < rooms.rows; r++) {
    for (let c = 0; c < rooms.cols; c++) {
      const n = `${r + 1}${String(c + 1).padStart(2, "0")}`;
      const roomId = `${z.prefix}-room-${n}`;
      roomIds.push(asElementId(roomId));
      const outline = rect({ x: z.origin.x + c * roomW, y: z.origin.y + r * roomH }, roomW, roomH);
      b.elements.push({
        ...base,
        partition: part,
        id: asElementId(roomId),
        kind: "room",
        number: `${z.level}-${z.zone}-${n}`,
        name: (r + c) % 5 === 0 ? "Patient room" : (r + c) % 5 === 1 ? "Exam" : (r + c) % 5 === 2 ? "Office" : (r + c) % 5 === 3 ? "Clean utility" : "Corridor",
        outline,
        areaSqM: Math.round(((roomW * roomH) / 1e6) * 100) / 100,
      });
      const roomOrigin = { x: z.origin.x + c * roomW, y: z.origin.y + r * roomH };
      const centre = { x: roomOrigin.x + roomW / 2, y: roomOrigin.y + roomH / 2 };
      const component = (key: string, category: "furniture" | "casework" | "ceiling" | "floor_finish", typeName: string, position: Vec2, size: Vec2): void => {
        b.elements.push({ ...base, partition: part, id: asElementId(`${roomId}-${key}`), kind: "component", category, typeName, position: roundVec(position), size, rotationDeg: 0 });
      };
      component("clg", "ceiling", "ACT 2x2 ceiling", centre, { x: roomW, y: roomH });
      component("flr", "floor_finish", "Sheet vinyl flooring", centre, { x: roomW, y: roomH });
      ROOM_CONTENTS.forEach((item, i) =>
        component(`fx${i + 1}`, item.category, item.typeName, { x: roomOrigin.x + item.at.x * roomW, y: roomOrigin.y + item.at.y * roomH }, item.size),
      );
      const doorId = `${z.prefix}-door-${n}`;
      doors.push(asElementId(doorId));
      opening(doorId, hWall(r, c), "door", roomW / 2, 3 * FT, `D${n}`);
      wallPairs.push([asElementId(hWall(r, c)), asElementId(hWall(r + 1, c))]);
    }
  }
  for (let c = 0; c < rooms.cols; c++) {
    opening(`${z.prefix}-win-n${c + 1}a`, hWall(rooms.rows, c), "window", roomW / 4, 4 * FT, `W-N${c + 1}A`);
    opening(`${z.prefix}-win-n${c + 1}b`, hWall(rooms.rows, c), "window", (3 * roomW) / 4, 4 * FT, `W-N${c + 1}B`);
  }
  // South face is curtain wall: a panel and a mullion every 5 ft.
  for (let k = 0; k < ZONE_FT / 5; k++) {
    const x = z.origin.x + k * 5 * FT;
    b.elements.push(
      { ...base, partition: part, id: asElementId(`${z.prefix}-cw-${k + 1}-pnl`), kind: "component", category: "curtain_panel", typeName: "Insulated glazing unit 5 ft", position: { x: x + 2.5 * FT, y: z.origin.y - 6 * IN }, size: { x: 5 * FT, y: 1 * IN }, rotationDeg: 0 },
      { ...base, partition: part, id: asElementId(`${z.prefix}-cw-${k + 1}-mul`), kind: "component", category: "mullion", typeName: "Aluminum mullion 2.5x6", position: { x, y: z.origin.y - 6 * IN }, size: { x: 2.5 * IN, y: 6 * IN }, rotationDeg: 0 },
    );
  }
  for (let r = 0; r < rooms.rows; r++) {
    opening(`${z.prefix}-win-w${r + 1}`, vWall(0, r), "window", roomH / 2, 4 * FT, `W-W${r + 1}`);
    opening(`${z.prefix}-win-e${r + 1}`, vWall(rooms.cols, r), "window", roomH / 2, 4 * FT, `W-E${r + 1}`);
  }
  return { doors, rooms: roomIds, wallPairs };
}

/** 25 ft column grid with beams between neighbours and grid lines through it. */
function addStructure(b: SeedBuilder, z: ZoneContext): { columns: ElementId[][] } {
  const part = z.part("structure");
  const bay = 25 * FT;
  const n = Math.round((ZONE_FT * FT) / bay) + 1;
  const columns: ElementId[][] = [];
  for (let i = 0; i < n; i++) {
    b.elements.push(
      { ...base, partition: part, id: asElementId(`${z.prefix}-grid-x${i + 1}`), kind: "grid", label: String.fromCharCode(65 + i), start: { x: z.origin.x + i * bay, y: z.origin.y - 5 * FT }, end: { x: z.origin.x + i * bay, y: z.origin.y + (n - 1) * bay + 5 * FT } },
      { ...base, partition: part, id: asElementId(`${z.prefix}-grid-y${i + 1}`), kind: "grid", label: String(i + 1), start: { x: z.origin.x - 5 * FT, y: z.origin.y + i * bay }, end: { x: z.origin.x + (n - 1) * bay + 5 * FT, y: z.origin.y + i * bay } },
    );
  }
  for (let i = 0; i < n; i++) {
    const row: ElementId[] = [];
    for (let j = 0; j < n; j++) {
      const id = asElementId(`${z.prefix}-col-${i + 1}-${j + 1}`);
      row.push(id);
      const position = { x: z.origin.x + i * bay, y: z.origin.y + j * bay };
      b.elements.push({ ...base, partition: part, id, kind: "column", material: "concrete", position, size: { x: 24 * IN, y: 24 * IN } });
      b.elements.push({ ...base, partition: part, id: asElementId(`${id}-ftg`), kind: "component", category: "footing", typeName: "Spread footing 6x6", position, size: { x: 6 * FT, y: 6 * FT }, rotationDeg: 0 });
    }
    columns.push(row);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const at = (a: number, c: number): Vec2 => ({ x: z.origin.x + a * bay, y: z.origin.y + c * bay });
      if (i + 1 < n) b.elements.push({ ...base, partition: part, id: asElementId(`${z.prefix}-beam-x${i + 1}-${j + 1}`), kind: "beam", sectionName: "W18x35", start: at(i, j), end: at(i + 1, j) });
      if (j + 1 < n) b.elements.push({ ...base, partition: part, id: asElementId(`${z.prefix}-beam-y${i + 1}-${j + 1}`), kind: "beam", sectionName: "W16x26", start: at(i, j), end: at(i, j + 1) });
    }
  }
  return { columns };
}

const RISERS: ReadonlyArray<{ service: NetworkService; discipline: Discipline; profile: Profile; at: Vec2 }> = [
  { service: "air", discipline: "mechanical", profile: { shape: "rect", width: 36 * IN, height: 24 * IN }, at: { x: 95 * FT, y: 95 * FT } },
  { service: "water", discipline: "plumbing", profile: { shape: "round", diameter: 4 * IN }, at: { x: 92 * FT, y: 95 * FT } },
  { service: "sprinkler", discipline: "fire_protection", profile: { shape: "round", diameter: 6 * IN }, at: { x: 89 * FT, y: 95 * FT } },
  { service: "power", discipline: "electrical", profile: { shape: "rect", width: 24 * IN, height: 4 * IN }, at: { x: 86 * FT, y: 95 * FT } },
];

/**
 * A deterministic all-discipline building for backend load tests: per level
 * and zone, architecture (slab, walls, doors, windows, rooms), structure
 * (grids, columns, beams), four MEP systems (air, water, sprinkler, power),
 * one riser per system running through every level, and the documentation
 * that references them (views, sheets, tags, dimensions). Every element
 * carries its level / zone / discipline partition, and every system,
 * reference and sheet stays inside one partition so any slice is valid.
 */
export function createFullBimModel(opts: FullBimOptions): ModelState {
  const air = opts.air ?? DEFAULT_ZONE.air;
  const water = opts.water ?? DEFAULT_ZONE.water;
  const sprinkler = opts.sprinkler ?? DEFAULT_ZONE.sprinkler;
  const power = opts.power ?? DEFAULT_ZONE.power;
  const lighting = opts.lighting ?? DEFAULT_ZONE.lighting;
  const rooms = opts.rooms ?? DEFAULT_ZONE.rooms;
  const b: SeedBuilder = { elements: [], connections: [] };
  const zone = ZONE_FT * FT;

  for (let f = 0; f < opts.floors; f++) {
    const level = `L${String(f + 1).padStart(2, "0")}`;
    for (let zi = 0; zi < opts.zonesPerFloor; zi++) {
      const zoneName = `Z${zi + 1}`;
      const z: ZoneContext = {
        level,
        zone: zoneName,
        origin: { x: zi * (zone + 10 * FT), y: 0 },
        prefix: `${level}-${zoneName}`,
        part: (discipline) => ({ level, zone: zoneName, discipline }),
      };
      const arch = addArchitecture(b, z, rooms);
      const structure = addStructure(b, z);
      const mep = (key: string, discipline: Discipline, service: NetworkService, size: NetworkSize, spec: Omit<TreeNetworkSeed, "prefix" | "partition" | "service" | "origin" | "size">) =>
        seedTreeNetwork(b, { ...spec, prefix: `${z.prefix}-${key}`, partition: z.part(discipline), service, origin: { x: z.origin.x + 2 * FT, y: z.origin.y + 2 * FT }, size });
      const nets = [
        {
          discipline: "mechanical" as const,
          ...mep("air", "mechanical", "air", air, {
            trunkProfile: { shape: "rect", width: 24 * IN, height: 12 * IN },
            branchProfile: { shape: "rect", width: 10 * IN, height: 8 * IN },
            sourceName: "VAV terminal unit",
            sourceMark: `VAV-${z.prefix}`,
            endName: "Supply diffuser 24x24",
            endMark: "SD",
            load: (i) => 150 + (i % 7) * 50,
          }),
        },
        {
          discipline: "plumbing" as const,
          ...mep("dw", "plumbing", "water", water, {
            trunkProfile: { shape: "round", diameter: 3 * IN },
            branchProfile: { shape: "round", diameter: 1 * IN },
            sourceName: "Domestic water branch valve",
            sourceMark: `DWV-${z.prefix}`,
            endName: "Lavatory, wall hung",
            endMark: "P",
            load: (i) => 1 + (i % 3),
          }),
        },
        {
          discipline: "fire_protection" as const,
          ...mep("fp", "fire_protection", "sprinkler", sprinkler, {
            trunkProfile: { shape: "round", diameter: 2 * IN },
            branchProfile: { shape: "round", diameter: 1 * IN },
            sourceName: "Floor control valve assembly",
            sourceMark: `FCV-${z.prefix}`,
            endName: "Pendent sprinkler, quick response",
            endMark: "SPK",
            load: () => 1,
          }),
        },
        {
          discipline: "electrical" as const,
          ...mep("el", "electrical", "power", power, {
            trunkProfile: { shape: "rect", width: 12 * IN, height: 4 * IN },
            branchProfile: { shape: "round", diameter: 1 * IN },
            sourceName: "Branch panelboard 208Y/120",
            sourceMark: `LP-${z.prefix}`,
            endName: "Duplex receptacle",
            endMark: "R",
            load: (i) => 180 * (1 + (i % 2)),
          }),
        },
        {
          discipline: "electrical" as const,
          ...mep("lt", "electrical", "power", lighting, {
            trunkProfile: { shape: "rect", width: 6 * IN, height: 4 * IN },
            branchProfile: { shape: "round", diameter: 0.75 * IN },
            sourceName: "Lighting panelboard 277/480",
            sourceMark: `LTP-${z.prefix}`,
            endName: "LED troffer 2x4",
            endMark: "LT",
            load: () => 40,
          }),
        },
      ];
      for (const r of RISERS) {
        b.elements.push({
          ...base,
          partition: z.part(r.discipline),
          id: asElementId(`${z.prefix}-riser-${r.service}`),
          kind: "riser_segment",
          riserId: `riser-${zoneName}-${r.service}`,
          service: r.service,
          position: { x: z.origin.x + r.at.x, y: z.origin.y + r.at.y },
          profile: r.profile,
        });
      }

      addDocumentation(b, z, arch, structure, nets);
    }
  }

  const model: ModelState = {
    modelId: opts.modelId ?? "full-bim",
    revision: asRevision(0),
    elements: Object.fromEntries(b.elements.map((el) => [el.id, el])),
    connections: b.connections,
    settings: DEFAULT_SETTINGS,
  };
  return recomputeDerived(model).model;
}

/** Plans, a section and a sheet per discipline; a tag on every device, door, room and source; room and bay dimensions. */
function addDocumentation(
  b: SeedBuilder,
  z: ZoneContext,
  arch: { doors: ElementId[]; rooms: ElementId[]; wallPairs: Array<[ElementId, ElementId]> },
  structure: { columns: ElementId[][] },
  nets: ReadonlyArray<{ discipline: Discipline; sources: ElementId[]; ends: ElementId[] }>,
): void {
  const zone = ZONE_FT * FT;
  const cropMin = z.origin;
  const cropMax = { x: z.origin.x + zone, y: z.origin.y + zone };
  const views = new Map<Discipline, ElementId[]>();
  const view = (discipline: Discipline, key: string, name: string, viewType: "floor_plan" | "ceiling_plan" | "section"): void => {
    const id = asElementId(`${z.prefix}-view-${key}`);
    pushTo(views, discipline, id);
    b.elements.push({ ...base, partition: z.part(discipline), id, kind: "view", name: `${z.level} ${z.zone} ${name}`, viewType, cropMin, cropMax });
  };
  view("architecture", "a-plan", "Floor plan", "floor_plan");
  view("architecture", "a-rcp", "Reflected ceiling plan", "ceiling_plan");
  view("architecture", "a-sect", "Building section", "section");
  view("structure", "s-plan", "Framing plan", "floor_plan");
  view("mechanical", "m-plan", "Mechanical plan", "floor_plan");
  view("plumbing", "p-plan", "Plumbing plan", "floor_plan");
  view("electrical", "e-plan", "Power plan", "floor_plan");
  view("fire_protection", "fp-plan", "Fire protection plan", "floor_plan");
  const letters: Record<Discipline, string> = { architecture: "A", structure: "S", mechanical: "M", plumbing: "P", electrical: "E", fire_protection: "FP", civil: "C", general_contracting: "G", documentation: "D", general: "X" };
  for (const [discipline, ids] of views) {
    b.elements.push({
      ...base,
      partition: z.part(discipline),
      id: asElementId(`${z.prefix}-sheet-${letters[discipline]}`),
      kind: "sheet",
      number: `${letters[discipline]}-${z.level.slice(1)}${z.zone.slice(1)}`,
      title: `${z.level} ${z.zone} ${discipline.replace("_", " ")}`,
      viewIds: ids,
    });
  }

  const tag = (discipline: Discipline, targetId: ElementId, text: string): void => {
    b.elements.push({
      ...base,
      partition: z.part(discipline),
      id: asElementId(`${targetId}-tag`),
      kind: "tag",
      targetId,
      offset: { x: 12 * IN, y: 12 * IN },
      text,
      position: { x: 0, y: 0 },
    });
  };
  for (const id of arch.doors) tag("architecture", id, String(id).split("-door-")[1] ?? String(id));
  for (const id of arch.rooms) tag("architecture", id, String(id).split("-room-")[1] ?? String(id));
  for (const net of nets) {
    for (const id of net.sources) tag(net.discipline, id, String(id));
    for (const id of net.ends) tag(net.discipline, id, String(id).split("-").slice(-3).join("-"));
  }

  const dimension = (discipline: Discipline, id: string, a: ElementId, bId: ElementId): void => {
    b.elements.push({ ...base, partition: z.part(discipline), id: asElementId(id), kind: "dimension", aId: a, bId, offset: 3 * FT, valueMm: 0 });
  };
  arch.wallPairs.forEach(([a, bId], i) => dimension("architecture", `${z.prefix}-dim-room-${i + 1}`, a, bId));
  const cols = structure.columns;
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i]?.[0];
    const next = cols[i + 1]?.[0];
    const up = cols[0]?.[i];
    const upNext = cols[0]?.[i + 1];
    if (a && next) dimension("structure", `${z.prefix}-dim-bay-x${i + 1}`, a, next);
    if (up && upNext) dimension("structure", `${z.prefix}-dim-bay-y${i + 1}`, up, upNext);
  }
}

/** Element count per discipline and per kind. */
export function describeModel(model: ModelState): { total: number; byDiscipline: Record<string, number>; byKind: Record<string, number> } {
  const byDiscipline: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const el of elementValues(model.elements)) {
    total += 1;
    const d = el.partition?.discipline ?? "mechanical";
    byDiscipline[d] = (byDiscipline[d] ?? 0) + 1;
    byKind[el.kind] = (byKind[el.kind] ?? 0) + 1;
  }
  return { total, byDiscipline, byKind };
}
