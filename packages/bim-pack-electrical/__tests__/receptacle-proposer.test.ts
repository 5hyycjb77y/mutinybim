import { builtinPartTypes, DEFAULT_SETTINGS, asRevision, executeCommand, normalizeRoomOutline, restaurantDiningArchitecture, unit001Architecture, type Command, type ModelState, type RoomGeometry, type Vec2 } from "@permitzip/bim-kernel";
import { checkReceptacleCoverage, proposeReceptacles, receptacleRoomGeometries, type ReceptacleRequest } from "@permitzip/bim-pack-electrical";
import { necEdition, receptaclePlacementRules } from "@permitzip/bim-calc";

const FT = 304.8;
const IN = 25.4;

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function emptyModel(): ModelState {
  return { modelId: "propose-test", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function starter(id: string) {
  const t = builtinPartTypes().find((x) => x.id === id);
  if (!t) throw new Error(`starter type ${id} missing`);
  return t;
}
const duplex = starter("builtin:duplex-receptacle@1");
const counterType = starter("builtin:countertop-receptacle@1");
const gfci = starter("builtin:gfci-receptacle@1");

function unit001(withFridgeReceptacle = true): ModelState {
  let m = run(emptyModel(), { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, unit001Architecture("lvl-1"));
  // The refrigerator's receptacle on the kitchen's right wall (an appliance receptacle: never counts).
  if (withFridgeReceptacle) m = run(m, { type: "place_part", partId: "rf-1", typeId: duplex.id, partType: duplex.definition, levelId: "lvl-1", position: { x: 27.3 * FT, y: 5 * FT }, offsetMm: 18 * IN, mark: "R.F" });
  return m;
}

const rules2023 = receptaclePlacementRules(necEdition("2023"));
const rules2020 = receptaclePlacementRules(necEdition("2020"));
const request = (rules = rules2023): ReceptacleRequest => ({ mode: "dwelling", rules, devices: { wall: duplex.id, countertop: counterType.id, bathroom: gfci.id } });

function rooms(m: ModelState, ids: readonly string[], rules = rules2023): RoomGeometry[] {
  return ids.map((id) => {
    const g = receptacleRoomGeometries(m, [id], rules)[0] ?? null;
    if (!g) throw new Error(`no room ${id}`);
    return g;
  });
}

/** Perimeter distance of `p` on a closed outline (nearest edge), and the outline's length. Independent of the proposer's own code. */
function along(outline: readonly Vec2[], p: Vec2): { s: number; total: number } {
  let best = { d: Infinity, s: 0 };
  let acc = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] as Vec2;
    const b = outline[(i + 1) % outline.length] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Math.max(0, Math.min(len, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len));
    const d = Math.hypot(a.x + ((b.x - a.x) * t) / len - p.x, a.y + ((b.y - a.y) * t) / len - p.y);
    if (d < best.d) best = { d, s: acc + t };
    acc += len;
  }
  return { s: best.s, total: acc };
}

/** Sample every 25 mm of each run and find the nearest receptacle on the same run, by walking the floor line. */
function sampledWorst(room: RoomGeometry, run: { from: number; to: number; closed: boolean }, positions: readonly Vec2[]): number {
  const outline = normalizeRoomOutline(room.outline);
  const total = along(outline, outline[0] as Vec2).total;
  const on = positions.map((p) => along(outline, p).s).flatMap((s) => [s, s + total, s - total]).filter((s) => s >= run.from - 1 && s <= run.to + 1);
  let worst = 0;
  for (let t = run.from; t <= run.to; t += 25) {
    let near = Infinity;
    for (const s of on) near = Math.min(near, Math.abs(s - t), run.closed ? Math.abs(s + (run.to - run.from) - t) : Infinity, run.closed ? Math.abs(s - (run.to - run.from) - t) : Infinity);
    worst = Math.max(worst, near);
  }
  return worst;
}

describe("NEC 210.52 receptacle proposer: unit 001", () => {
  const m = unit001();
  const ids = ["u001-living", "u001-kitchen", "u001-entry", "u001-hall", "u001-bed", "u001-bath", "u001-closet", "u001-laundry"];
  const geo = rooms(m, ids);
  const proposal = proposeReceptacles(geo, request());

  it("treats each room by its name: kitchen, bathroom, laundry, hall, closets get nothing", () => {
    expect(Object.fromEntries(proposal.rooms.map((r) => [r.roomId, r.rule]))).toEqual({
      "u001-living": "general",
      "u001-kitchen": "kitchen",
      "u001-entry": "none",
      "u001-hall": "hallway",
      "u001-bed": "general",
      "u001-bath": "bathroom",
      "u001-closet": "none",
      "u001-laundry": "laundry",
    });
  });

  it("every point along eligible wall space is within 6 ft of a receptacle (coverage check passes)", () => {
    expect(proposal.passes).toBe(true);
    for (const room of proposal.rooms) {
      const g = geo.find((x) => x.id === room.roomId) as RoomGeometry;
      const positions = [...g.existing.filter((e) => !e.appliance).map((e) => e.position), ...room.devices.map((d) => d.position)];
      for (const r of room.runs.filter((x) => x.kind === "wall")) {
        expect(r.worstMm).toBeLessThanOrEqual(6 * FT + 1);
        // Independent of the proposer's arithmetic: walk the floor line.
        expect(sampledWorst(g, r, positions)).toBeLessThanOrEqual(6 * FT + 60);
      }
    }
  });

  it("countertop receptacles: none more than 2 ft from either end of a countertop space, never more than 4 ft apart", () => {
    const kitchen = proposal.rooms.find((r) => r.roomId === "u001-kitchen");
    const g = geo.find((x) => x.id === "u001-kitchen") as RoomGeometry;
    const counterRuns = kitchen?.runs.filter((r) => r.kind === "countertop") ?? [];
    expect(counterRuns.length).toBeGreaterThanOrEqual(2); // the sink and the range split the counter
    const counter = kitchen?.devices.filter((d) => d.kind === "countertop") ?? [];
    expect(counter.length).toBeGreaterThan(0);
    const outline = normalizeRoomOutline(g.outline);
    for (const r of counterRuns) {
      expect(r.passes).toBe(true);
      const on = counter
        .map((d) => along(outline, d.position))
        .flatMap(({ s, total }) => [s, s + total])
        .filter((s) => s >= r.from - 1 && s <= r.to + 1)
        .sort((a, b) => a - b);
      expect(on.length).toBeGreaterThan(0);
      expect((on[0] as number) - r.from).toBeLessThanOrEqual(24 * IN + 1);
      expect(r.to - (on[on.length - 1] as number)).toBeLessThanOrEqual(24 * IN + 1);
      for (let i = 1; i < on.length; i++) expect((on[i] as number) - (on[i - 1] as number)).toBeLessThanOrEqual(48 * IN + 1);
    }
    expect(counter.every((d) => d.typeId === counterType.id && d.cite === "NEC 2023 210.52(C)(1)")).toBe(true);
  });

  it("the island gets receptacles by area under NEC 2023 (18 sq ft: 2) and one under NEC 2020", () => {
    const islands = (p: typeof proposal) => p.rooms.find((r) => r.roomId === "u001-kitchen")?.devices.filter((d) => d.kind === "island") ?? [];
    expect(islands(proposal)).toHaveLength(2);
    expect(islands(proposeReceptacles(rooms(m, ["u001-kitchen"], rules2020), request(rules2020)))).toHaveLength(1);
  });

  it("the refrigerator's receptacle (an appliance receptacle) does not count toward wall space", () => {
    const kitchen = geo.find((x) => x.id === "u001-kitchen") as RoomGeometry;
    expect(kitchen.existing.find((e) => e.id === "rf-1")?.appliance).toBe(true);
    const withoutFridge = rooms(unit001(false), ["u001-kitchen"])[0] as RoomGeometry;
    const a = proposeReceptacles([kitchen], request()).devices.filter((d) => d.kind === "wall").map((d) => d.position);
    const b = proposeReceptacles([withoutFridge], request()).devices.filter((d) => d.kind === "wall").map((d) => d.position);
    expect(a).toEqual(b);
    // Kept alone, the appliance receptacle leaves the kitchen walls uncovered.
    expect(checkReceptacleCoverage(kitchen, request(), []).filter((r) => r.kind === "wall").every((r) => r.passes)).toBe(false);
  });

  it("bathroom: a GFCI receptacle within 3 ft of the lavatory; laundry and hall: one each", () => {
    const by = (id: string) => proposal.rooms.find((r) => r.roomId === id)?.devices ?? [];
    const bath = by("u001-bath");
    expect(bath).toHaveLength(1);
    expect(bath[0]?.typeId).toBe(gfci.id);
    const lav = geo.find((x) => x.id === "u001-bath")?.fixtures.find((f) => f.kind === "basin");
    const p = bath[0]?.position as Vec2;
    const lavEdge = Math.min(...(lav?.outline ?? []).map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
    expect(lavEdge).toBeLessThanOrEqual(3 * FT + 300);
    expect(by("u001-laundry")).toHaveLength(1);
    expect(by("u001-hall")).toHaveLength(1);
  });

  it("is deterministic: the same rooms give the same proposal (golden)", () => {
    expect(proposeReceptacles(rooms(unit001(), ids), request())).toEqual(proposal);
    expect(proposal.devices.map((d) => `${d.key} ${d.kind} (${Math.round(d.position.x)}, ${Math.round(d.position.y)}) ${d.rotationDeg}°`)).toMatchSnapshot();
  });

  it("accept all places every device as one edit; accept some leaves the rest and the check says what is uncovered", () => {
    const devices = proposal.devices;
    const all: Command = { type: "place_devices", label: "Receptacles in unit 001", levelId: "lvl-1", partTypes: [duplex, counterType, gfci].map((t) => ({ typeId: t.id, definition: t.definition })), devices: devices.map((d, i) => ({ partId: `rp-${i}`, typeId: d.typeId, position: d.position, rotationDeg: d.rotationDeg, offsetMm: d.heightMm })) };
    const placed = executeCommand(m, all);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.changedIds.filter((id) => String(id).startsWith("rp-"))).toHaveLength(devices.length);
    // After accepting all, a new proposal for the same rooms proposes nothing on the walls.
    const again = proposeReceptacles(rooms(placed.model, ["u001-living", "u001-bed"]), request());
    expect(again.devices).toHaveLength(0);

    const living = proposal.rooms.find((r) => r.roomId === "u001-living");
    const keep = (living?.devices ?? []).slice(1).map((d) => d.position);
    const runs = checkReceptacleCoverage(geo.find((x) => x.id === "u001-living") as RoomGeometry, request(), keep);
    expect(runs.some((r) => !r.passes)).toBe(true);
  });

  it("a retried accept places nothing twice; a bad step refuses the whole edit", () => {
    const one: Command = { type: "place_devices", label: "One", levelId: "lvl-1", partTypes: [{ typeId: duplex.id, definition: duplex.definition }], devices: [{ partId: "x-1", typeId: duplex.id, position: { x: 1000, y: 1000 } }] };
    const first = run(m, one);
    const second = executeCommand(first, one);
    expect(second.ok).toBe(false);
    const bad = executeCommand(m, { type: "place_devices", label: "Bad", levelId: "lvl-1", partTypes: [{ typeId: duplex.id, definition: duplex.definition }], devices: [{ partId: "y-1", typeId: duplex.id, position: { x: 0, y: 0 } }, { partId: "y-2", typeId: "builtin:nope@1", position: { x: 0, y: 0 } }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/^Step 2 of 2/);
  });
});

describe("commercial density presets", () => {
  let m = run(emptyModel(), { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = run(m, restaurantDiningArchitecture("lvl-1"));
  const dining = rooms(m, ["rest-dining"]);
  const req = (preset: "light" | "medium" | "heavy"): ReceptacleRequest => ({ mode: "density", preset, rules: rules2023, devices: { wall: duplex.id } });

  it('restaurant dining "medium" places receptacles about 15 ft apart on the perimeter walls', () => {
    const p = proposeReceptacles(dining, req("medium"));
    const g = dining[0] as RoomGeometry;
    const outline = normalizeRoomOutline(g.outline);
    for (const r of p.rooms[0]?.runs ?? []) {
      const on = p.devices.map((d) => along(outline, d.position).s).flatMap((s) => [s, s + r.to]).filter((s) => s >= r.from && s <= r.to).sort((a, b) => a - b);
      for (let i = 1; i < on.length; i++) {
        const gap = ((on[i] as number) - (on[i - 1] as number)) / FT;
        expect(gap).toBeGreaterThan(11);
        expect(gap).toBeLessThanOrEqual(15.05);
      }
    }
    expect(p.devices[0]?.cite).toBe('Firm preset "medium" (15\' apart): not a code minimum');
    const expected = (p.rooms[0]?.runs ?? []).reduce((acc, r) => acc + Math.ceil(r.lengthMm / (15 * FT)), 0);
    expect(p.devices.length).toBe(expected);
    expect(p.devices.length).toBeGreaterThanOrEqual(8);
  });

  it("light places fewer and heavy more, all from the same rule pack numbers", () => {
    const light = proposeReceptacles(dining, req("light")).devices.length;
    const medium = proposeReceptacles(dining, req("medium")).devices.length;
    const heavy = proposeReceptacles(dining, req("heavy")).devices.length;
    expect(light).toBeLessThan(medium);
    expect(heavy).toBeGreaterThan(medium * 2);
  });
});

/** Seeded PRNG (mulberry32) so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("coverage property: any wall polygon", () => {
  it("for 300 random rooms (rectangles, L shapes, convex polygons) with random doors, no point of eligible wall space is out of reach", () => {
    const rand = rng(0x210_52);
    for (let n = 0; n < 300; n++) {
      const shape = n % 3;
      let outline: Vec2[];
      const w = (6 + rand() * 40) * FT;
      const h = (6 + rand() * 30) * FT;
      if (shape === 0) outline = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
      else if (shape === 1) {
        const cx = w * (0.3 + rand() * 0.4);
        const cy = h * (0.3 + rand() * 0.4);
        outline = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: cy }, { x: cx, y: cy }, { x: cx, y: h }, { x: 0, y: h }];
      } else {
        const k = 5 + Math.floor(rand() * 5);
        outline = Array.from({ length: k }, (_, i) => {
          const a = (i / k) * 2 * Math.PI + rand() * 0.3;
          return { x: (w / 2) * Math.cos(a), y: (h / 2) * Math.sin(a) };
        });
      }
      const total = outline.reduce((acc, p, i) => {
        const q = outline[(i + 1) % outline.length] as Vec2;
        return acc + Math.hypot(q.x - p.x, q.y - p.y);
      }, 0);
      const doorCount = Math.floor(rand() * 4);
      const openings = Array.from({ length: doorCount }, (_, i) => {
        const at = rand() * total;
        const width = (2.5 + rand() * 4) * FT;
        return { kind: "door" as const, label: `D${i}`, from: at, to: at + width };
      });
      const room: RoomGeometry = { id: `r${n}`, number: `${n}`, name: n % 2 ? "Bedroom" : "Living room", source: "outline", outline, openings, counters: [], fixtures: [], existing: [] };
      const p = proposeReceptacles([room], request());
      const rp = p.rooms[0];
      expect(rp?.passes).toBe(true);
      for (const r of rp?.runs ?? []) {
        expect(r.worstMm).toBeLessThanOrEqual(6 * FT + 1);
        expect(sampledWorst(room, r, rp?.devices.map((d) => d.position) ?? [])).toBeLessThanOrEqual(6 * FT + 80);
      }
    }
  });
});
