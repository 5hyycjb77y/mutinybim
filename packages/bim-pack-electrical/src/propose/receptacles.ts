import { add, distance, dot, scale, sub, builtinPartType, localBounds, resolveGeometry, type PartTypeDefinition, type ModelState, type Vec2, type PerimeterSpan, type RoomCounter, type RoomGeometry, type Perimeter, outlineGeometry } from "@permitzip/bim-kernel";
import type { CoverageRun, DensityPreset, ProposedDevice, ProposedKind, ReceptacleProposal, ReceptacleRules, RoomProposal, RoomRule } from "./types";

const { MM_PER_FT, centroid, clearCorners, distanceToOutline, feetInches, fillRun, inRun, inward, mergeSpans, normalizeOutline, openRuns, perimeterOf, pointAt, pointInOutline, project, rectSides, shadowOn, worstDistance, wrap } = outlineGeometry;

/**
 * NEC 210.52 dwelling receptacle proposer and the commercial density presets.
 *
 * Deterministic spacing only (US 11,087,054 design rules): the engineer picks
 * the rooms and the device type for each kind of location; the rule pack
 * gives the distances; this walks the floor line and fills each uncovered
 * stretch with the fewest evenly spaced receptacles. It never chooses a
 * device type, never chooses equipment and never makes a circuit.
 */

export interface ReceptacleRequest {
  readonly mode: "dwelling" | "density";
  /** Density mode: which spacing the engineer picked. */
  readonly preset?: DensityPreset;
  readonly rules: ReceptacleRules;
  /** The part types the engineer chose. Countertop and bathroom fall back to the wall type with a note. */
  readonly devices: { readonly wall: string; readonly countertop?: string; readonly bathroom?: string };
  /** Per-room override of how a room is treated. */
  readonly roomRules?: Readonly<Record<string, RoomRule>>;
  /** How each device type sits on its wall, by type id (wallMountsFor). A type not listed is read from the starter library. */
  readonly mounts?: Readonly<Record<string, WallMount>>;
  /** Gap between a wall device's back and the wall face (default 0: the back is flush with the face). */
  readonly insetMm?: number;
}

/**
 * How a wall-mounted device sits on its wall, from its type's geometry: how
 * far its body reaches behind the insertion point (toward the wall, local
 * -y) and to either side of it. A proposed device stands that far off the
 * wall face, and that far from each end of the wall it is on, so its body
 * never enters its own wall or the wall at the corner.
 */
export interface WallMount {
  readonly backMm: number;
  readonly halfWidthMm: number;
}

const POINT_MOUNT: WallMount = { backMm: 0, halfWidthMm: 0 };

export function wallMountOf(def: PartTypeDefinition): WallMount {
  const b = localBounds(resolveGeometry(def));
  return { backMm: Math.max(0, -b.min[1]), halfWidthMm: Math.max(0, -b.min[0], b.max[0]) };
}

/** Wall mounts for these type ids: the model's own types, else the starter library; ids that are neither are left out. */
export function wallMountsFor(model: Pick<ModelState, "elements">, typeIds: readonly (string | undefined)[]): Record<string, WallMount> {
  const out: Record<string, WallMount> = {};
  for (const id of typeIds) {
    if (!id || out[id]) continue;
    const el = model.elements[id];
    const def = el?.kind === "part_type" ? el.definition : builtinPartType(id)?.definition;
    if (def) out[id] = wallMountOf(def);
  }
  return out;
}

function mountsOf(req: ReceptacleRequest): (typeId: string) => WallMount {
  const known = new Map<string, WallMount>(Object.entries(req.mounts ?? {}));
  return (typeId) => {
    let m = known.get(typeId);
    if (!m) {
      const def = builtinPartType(typeId)?.definition;
      m = def ? wallMountOf(def) : POINT_MOUNT;
      known.set(typeId, m);
    }
    return m;
  };
}

const CORNER_CLEAR_MM = 300;
/** A receptacle this close to an island or peninsula's edge is on it. */
const ISLAND_NEAR_MM = 300;
const WALL_TOL_MM = 200;
const EXISTING_NEAR_WALL_MM = 450;
const SQFT_PER_SQMM = 1 / (MM_PER_FT * MM_PER_FT);

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** How a room is treated, and why: first rule whose word is in the name. */
export function roomRuleFor(rules: ReceptacleRules, name: string, override?: RoomRule): { rule: RoomRule; basis: string } {
  if (override) return { rule: override, basis: "you chose it" };
  const have = new Set(words(name));
  for (const r of rules.roomWords) {
    const hit = r.words.find((w) => words(w).every((x) => have.has(x)));
    if (hit) return { rule: r.rule, basis: `the name has "${hit}"` };
  }
  return { rule: "general", basis: "no rule word in the name; treated as a room that needs wall receptacles (210.52(A))" };
}

function polygonArea(outline: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

function edgesOf(outline: readonly Vec2[]): Array<[Vec2, Vec2]> {
  const out: Array<[Vec2, Vec2]> = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (a && b) out.push([a, b]);
  }
  return out;
}

interface CounterInfo {
  readonly counter: RoomCounter;
  readonly role: "wall" | "island" | "peninsula";
  /** Its back edge on the floor line (wall counters). */
  readonly wallLine: readonly PerimeterSpan[];
}

/** A wall counter has a long side on the wall; a peninsula touches a wall or counter only at a short end; an island touches neither. */
function classifyCounters(per: Perimeter, counters: readonly RoomCounter[]): CounterInfo[] {
  return counters.map((counter) => {
    const outline = normalizeOutline(counter.outline);
    const sides = rectSides(outline);
    const onWall: PerimeterSpan[] = [];
    let longOnWall = false;
    let shortTouch = false;
    for (const [a, b] of edgesOf(outline)) {
      const shadow = shadowOn(per, a, b, WALL_TOL_MM);
      if (shadow.length === 0) continue;
      onWall.push(...shadow);
      if (distance(a, b) > sides.short + 1 || sides.long - sides.short < 1) longOnWall = true;
      else shortTouch = true;
    }
    // A wall counter's every side against a wall is countertop wall line (around a corner too); a peninsula's connecting end is not.
    const wallLine = longOnWall ? onWall : [];
    if (!longOnWall && !shortTouch) {
      // A short end against another counter's long side is a peninsula too.
      for (const other of counters) {
        if (other === counter) continue;
        const otherPer = perimeterOf(normalizeOutline(other.outline));
        for (const [a, b] of edgesOf(outline)) if (distance(a, b) <= sides.short + 1 && shadowOn(otherPer, a, b, 50).length > 0) shortTouch = true;
      }
    }
    return { counter, role: longOnWall ? "wall" : shortTouch ? "peninsula" : "island", wallLine };
  });
}

interface Placement {
  /** Perimeter distance of a device on the floor line; null when `at` places it (islands). */
  readonly s: number | null;
  readonly at?: { readonly position: Vec2; readonly rotationDeg: number };
  readonly kind: ProposedKind;
  readonly reason: string;
  readonly cite: string;
  readonly heightMm: number;
  readonly typeId: string;
}

/** `s` moved along its wall so a device `halfWidthMm` to each side stays on that wall, clear of the corners at its ends. */
function onFace(per: Perimeter, s: number, halfWidthMm: number): number {
  if (halfWidthMm <= 0) return s;
  const t = wrap(s, per.length);
  const { edge } = pointAt(per, t);
  const along = t - edge.start;
  const lo = Math.min(halfWidthMm, edge.length / 2);
  const clamped = Math.min(Math.max(along, lo), edge.length - lo);
  return s + (clamped - along);
}

/**
 * New points kept on their wall faces (onFace) where the run stays covered.
 * An evenly spaced loop with nothing in it turns as a whole, which keeps
 * its spacing; otherwise each point moves only if coverage still holds.
 */
function keepOnFace(per: Perimeter, run: PerimeterSpan, existing: readonly number[], fresh: readonly number[], reach: number, closed: boolean, halfWidthMm: number): number[] {
  if (halfWidthMm <= 0 || fresh.length === 0) return [...fresh];
  const covered = (pts: readonly number[]) => worstDistance(run, [...existing, ...pts], closed) <= reach + 1;
  const moved = fresh.map((s) => onFace(per, s, halfWidthMm));
  if (covered(moved)) return moved;
  const len = run.to - run.from;
  if (closed && existing.length === 0) {
    for (const [i, f] of fresh.entries()) {
      const d = (moved[i] ?? f) - f;
      if (Math.abs(d) < 1e-6) continue;
      const turned = fresh.map((x) => run.from + wrap(x + d - run.from, len));
      if (turned.every((x) => Math.abs(onFace(per, x, halfWidthMm) - x) < 1e-6) && covered(turned)) return turned;
    }
  }
  const out = [...fresh];
  for (let i = 0; i < out.length; i++) {
    const trial = [...out];
    trial[i] = moved[i] ?? out[i] ?? 0;
    if (covered(trial)) out[i] = trial[i] ?? out[i] ?? 0;
  }
  return out;
}

function onWall(per: Perimeter, s: number, mount: WallMount, gapMm: number): { position: Vec2; rotationDeg: number } {
  const { edge, point } = pointAt(per, onFace(per, s, mount.halfWidthMm));
  const pos = add(point, scale(inward(edge), mount.backMm + gapMm));
  const deg = (Math.atan2(edge.dir.y, edge.dir.x) * 180) / Math.PI;
  return { position: { x: Math.round(pos.x), y: Math.round(pos.y) }, rotationDeg: Math.round(((deg % 360) + 360) % 360) };
}

/** Existing, non-appliance receptacles on the floor line, as perimeter distances. */
function existingOnLine(per: Perimeter, room: RoomGeometry, exclude: readonly PerimeterSpan[]): number[] {
  const out: number[] = [];
  for (const r of room.existing) {
    if (r.appliance) continue;
    const pr = project(per, r.position);
    if (pr.offset > EXISTING_NEAR_WALL_MM) continue;
    if (exclude.some((x) => inRun(x, pr.s, per.length) !== null)) continue;
    out.push(pr.s);
  }
  return out;
}

interface RunFill {
  readonly runs: CoverageRun[];
  readonly fresh: Array<{ s: number; runLength: number; count: number }>;
}

/** Fill every open stretch between `blocked` so no point is more than `reach` from a receptacle. */
function fillStretches(per: Perimeter, blocked: readonly PerimeterSpan[], existing: readonly number[], reach: number, minSpace: number, kind: CoverageRun["kind"], halfWidthMm: number, only?: readonly PerimeterSpan[]): RunFill {
  const total = per.length;
  const { runs, closed } = only ? { runs: [...only], closed: false } : openRuns(blocked, total);
  const out: CoverageRun[] = [];
  const fresh: RunFill["fresh"] = [];
  for (const run of runs) {
    const len = run.to - run.from;
    if (len < minSpace - 1) continue;
    const have = existing.map((s) => inRun(run, s, total)).filter((s): s is number => s !== null);
    let made = fillRun(run, have, reach, closed);
    made = clearCorners(run, have, made, reach, closed, per.corners, total, Math.min(CORNER_CLEAR_MM, reach / 4));
    made = keepOnFace(per, run, have, made, reach, closed, halfWidthMm);
    for (const s of made) fresh.push({ s, runLength: len, count: made.length });
    const before = worstDistance(run, have, closed);
    const worst = worstDistance(run, [...have, ...made], closed);
    out.push({ kind, from: Math.round(run.from), to: Math.round(run.to), closed, lengthMm: Math.round(len), worstBeforeMm: Math.round(before), worstMm: Math.round(worst), limitMm: reach, passes: worst <= reach + 1 });
  }
  return { runs: out, fresh };
}

function roomLabel(room: RoomGeometry): string {
  return [room.name, room.number].filter((x) => x.trim() !== "").join(" ") || room.id;
}

function proposeRoom(room: RoomGeometry, req: ReceptacleRequest): RoomProposal {
  const rules = req.rules;
  const mount = mountsOf(req);
  const gap = req.insetMm ?? 0;
  const half = (typeId: string) => mount(typeId).halfWidthMm;
  const outline = normalizeOutline(room.outline);
  const label = roomLabel(room);
  const notes: string[] = [];
  if (outline.length < 3) return { roomId: room.id, label, rule: "none", ruleBasis: "no outline", devices: [], runs: [], passes: false, notes: ["This room has no outline, so nothing can be measured."] };
  const per = perimeterOf(outline);
  const doors: PerimeterSpan[] = room.openings.filter((o) => o.kind !== "window").map((o) => ({ from: o.from, to: o.to }));
  const placements: Placement[] = [];
  const runs: CoverageRun[] = [];

  if (req.mode === "density") {
    const preset = req.preset ?? "medium";
    const p = rules.presets[preset];
    const reach = p.spacingMm / 2;
    const fill = fillStretches(per, doors, existingOnLine(per, room, []), reach, rules.wall.minSpaceMm, "density", half(req.devices.wall));
    runs.push(...fill.runs);
    for (const f of fill.fresh) placements.push({ s: f.s, kind: "density", reason: `${p.label}: ${f.count} on ${feetInches(f.runLength)} of wall, about ${feetInches(f.runLength / f.count)} apart`, cite: `Firm preset "${preset}" (${feetInches(p.spacingMm)} apart): not a code minimum`, heightMm: rules.heights.wallMm, typeId: req.devices.wall });
    return finishRoom(room, label, "general", `density preset "${preset}"`, per, placements, runs, notes, mount, gap);
  }

  const { rule, basis } = roomRuleFor(rules, room.name, req.roomRules?.[room.id]);
  if (rule === "none") return { roomId: room.id, label, rule, ruleBasis: basis, devices: [], runs: [], passes: true, notes: ["No receptacles are required here by 210.52; nothing proposed."] };

  const counters = classifyCounters(per, room.counters);
  const wallCounterLine = mergeSpans(counters.flatMap((c) => c.wallLine), per.length);

  if (rule === "general" || rule === "kitchen") {
    const blocked = [...doors, ...(rules.wall.countersBreak ? [...wallCounterLine, ...appliancesOnWall(per, room)] : [])];
    const fill = fillStretches(per, blocked, existingOnLine(per, room, wallCounterLine), rules.wall.maxDistanceMm, rules.wall.minSpaceMm, "wall", half(req.devices.wall));
    runs.push(...fill.runs);
    for (const f of fill.fresh) placements.push({ s: f.s, kind: "wall", reason: `Wall space ${feetInches(f.runLength)}: ${f.count} receptacle${f.count === 1 ? "" : "s"}, no point on the wall more than ${feetInches(rules.wall.maxDistanceMm)} from one`, cite: rules.wall.cite, heightMm: rules.heights.wallMm, typeId: req.devices.wall });
  }

  if (rule === "kitchen" || (rule === "general" && counters.length > 0)) {
    const counterType = req.devices.countertop ?? req.devices.wall;
    if (!req.devices.countertop && counters.length > 0) notes.push("No countertop receptacle type was chosen, so counters use the wall receptacle type; choose a GFCI countertop type.");
    const breaks = room.fixtures.filter((f) => f.kind === "sink" || f.kind === "range").flatMap((f) => backedOn(per, normalizeOutline(f.outline)));
    const spaces = joinAtStart(subtract(wallCounterLine, breaks, per.length), per.length).filter((sp) => sp.to - sp.from >= rules.countertop.minSpaceMm - 1);
    if (breaks.length > 0 && wallCounterLine.length > 0) notes.push("Sinks and ranges split the countertop into separate spaces (210.52(C)(1)); check the space behind each.");
    const existingCounter = room.existing.filter((r) => !r.appliance).map((r) => project(per, r.position)).filter((p) => p.offset <= EXISTING_NEAR_WALL_MM).map((p) => p.s);
    const fill = fillStretches(per, [], existingCounter, rules.countertop.maxDistanceMm, rules.countertop.minSpaceMm, "countertop", half(counterType), spaces);
    runs.push(...fill.runs);
    for (const f of fill.fresh) placements.push({ s: f.s, kind: "countertop", reason: `Countertop ${feetInches(f.runLength)}: ${f.count}, no point on the wall line more than ${feetInches(rules.countertop.maxDistanceMm)} from one`, cite: rules.countertop.cite, heightMm: rules.heights.countertopMm, typeId: counterType });
    for (const c of counters) if (c.role !== "wall") placements.push(...islandPlacements(c, rules, counterType, notes, room.existing));
  }

  if (rule === "bathroom") {
    const type = req.devices.bathroom ?? req.devices.countertop ?? req.devices.wall;
    if (!req.devices.bathroom) notes.push("No bathroom receptacle type was chosen; it uses the nearest choice. Bathroom receptacles need GFCI protection.");
    const basins = room.fixtures.filter((f) => f.kind === "basin" || f.kind === "sink");
    if (basins.length === 0) {
      notes.push("No basin found in this room: one receptacle is proposed on the longest wall; move it beside the basin.");
      const s = longestRunMiddle(per, doors);
      if (s !== null) placements.push({ s, kind: "bathroom", reason: "Bathroom: at least one receptacle (no basin found to put it beside)", cite: rules.bathroom.cite, heightMm: rules.heights.countertopMm, typeId: type });
    }
    for (const b of basins) {
      const o = normalizeOutline(b.outline);
      const has = room.existing.some((r) => !r.appliance && distanceToOutline(r.position, o) <= rules.bathroom.maxFromBasinMm);
      if (has) continue;
      const s = besideFixture(per, o, doors, rules.bathroom.maxFromBasinMm);
      if (s === null) notes.push(`${b.label}: no wall within ${feetInches(rules.bathroom.maxFromBasinMm)} of the basin; place one by hand.`);
      else placements.push({ s, kind: "bathroom", reason: `Within ${feetInches(rules.bathroom.maxFromBasinMm)} of the outside edge of ${b.label}`, cite: rules.bathroom.cite, heightMm: rules.heights.countertopMm, typeId: type });
    }
  }

  if (rule === "laundry") {
    if (room.existing.some((r) => !r.appliance)) notes.push("A receptacle is already in the laundry area.");
    else {
      const washer = room.fixtures.find((f) => f.kind === "washer" || f.kind === "dryer");
      const s = washer ? besideFixture(per, normalizeOutline(washer.outline), doors, 1800) : longestRunMiddle(per, doors);
      if (s !== null) placements.push({ s, kind: "laundry", reason: washer ? `Laundry: at least one receptacle, beside ${washer.label}` : "Laundry: at least one receptacle", cite: rules.laundry.cite, heightMm: rules.heights.countertopMm, typeId: req.devices.wall });
    }
  }

  if (rule === "hallway") {
    const longSide = rectSides(outline).long;
    if (longSide < rules.hallway.minLengthMm) notes.push(`This hallway is ${feetInches(longSide)} long, under ${feetInches(rules.hallway.minLengthMm)}, so it needs none (210.52(H)).`);
    else if (room.existing.some((r) => !r.appliance)) notes.push("A receptacle is already in this hallway.");
    else {
      const s = longestRunMiddle(per, doors);
      if (s !== null) placements.push({ s, kind: "hallway", reason: `Hallway ${feetInches(longSide)} long: at least one receptacle`, cite: rules.hallway.cite, heightMm: rules.heights.wallMm, typeId: req.devices.wall });
    }
  }

  return finishRoom(room, label, rule, basis, per, placements, runs, notes, mount, gap);
}

/** Islands and peninsulas: on the long side away from any wall, evenly spaced. */
function islandPlacements(c: CounterInfo, rules: ReceptacleRules, typeId: string, notes: string[], existing: RoomGeometry["existing"]): Placement[] {
  const outline = normalizeOutline(c.counter.outline);
  const sides = rectSides(outline);
  const cite = c.role === "island" ? rules.island.islandCite : rules.island.peninsulaCite;
  if (sides.long < rules.island.minLongMm - 1 || sides.short < rules.island.minShortMm - 1) {
    notes.push(`${c.counter.label} is under ${feetInches(rules.island.minLongMm)} × ${feetInches(rules.island.minShortMm)}, so it needs none.`);
    return [];
  }
  const sqft = polygonArea(outline) * SQFT_PER_SQMM;
  const required = rules.island.count === "one" ? 1 : 1 + Math.max(0, Math.ceil((sqft - rules.island.firstAreaSqFt) / rules.island.eachSqFt - 1e-9));
  const there = existing.filter((r) => !r.appliance && (pointInOutline(r.position, outline) || distanceToOutline(r.position, outline) <= ISLAND_NEAR_MM)).length;
  if (there >= required) return [];
  const n = required - there;
  const [a, b] = sides.longEdge;
  const len = distance(a, b);
  const dir = sides.dir;
  const out: Placement[] = [];
  for (let i = 0; i < n; i++) {
    const p = add(a, scale(dir, ((i + 0.5) * len) / n));
    out.push({
      s: null,
      at: { position: { x: Math.round(p.x), y: Math.round(p.y) }, rotationDeg: Math.round(((Math.atan2(dir.y, dir.x) * 180) / Math.PI + 360) % 360) },
      kind: c.role,
      reason: `${c.role === "island" ? "Island" : "Peninsula"} ${c.counter.label} (${Math.round(sqft)} sq ft): ${required} receptacle${required === 1 ? "" : "s"}${there > 0 ? `, ${there} there already` : ""}`,
      cite,
      heightMm: rules.heights.islandMm,
      typeId,
    });
  }
  return out;
}

const COUNTER_DEPTH_MM = 1000;

/** A fixture's extent along each wall it backs onto (every corner within counter depth in front of that wall). */
function backedOn(per: Perimeter, outline: readonly Vec2[]): PerimeterSpan[] {
  const out: PerimeterSpan[] = [];
  for (const e of per.edges) {
    const n = inward(e);
    const depth = outline.map((q) => dot(sub(q, e.a), n));
    if (depth.some((d) => d < -50 || d > COUNTER_DEPTH_MM)) continue;
    const t = outline.map((q) => dot(sub(q, e.a), e.dir));
    const lo = Math.max(Math.min(...t), 0);
    const hi = Math.min(Math.max(...t), e.length);
    if (hi - lo > 1) out.push({ from: e.start + lo, to: e.start + hi });
  }
  return out;
}

const FIXED_APPLIANCES = new Set(["range", "refrigerator", "washer", "dryer"]);

/** Where a range, refrigerator, washer or dryer stands against a wall: no floor line there to plug into. */
function appliancesOnWall(per: Perimeter, room: RoomGeometry): PerimeterSpan[] {
  return room.fixtures.filter((f) => FIXED_APPLIANCES.has(f.kind)).flatMap((f) => edgesOf(normalizeOutline(f.outline)).flatMap(([a, b]) => shadowOn(per, a, b, WALL_TOL_MM)));
}

/** Spans that meet at the outline's first corner are one span (unwrapped: `to` past the perimeter length). */
function joinAtStart(spans: readonly PerimeterSpan[], total: number): PerimeterSpan[] {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (spans.length < 2 || !first || !last || first.from > 1 || last.to < total - 1) return [...spans];
  return [...spans.slice(1, -1), { from: last.from, to: total + first.to }];
}

function subtract(spans: readonly PerimeterSpan[], cuts: readonly PerimeterSpan[], total: number): PerimeterSpan[] {
  let out = mergeSpans(spans, total);
  for (const c of mergeSpans(cuts, total)) {
    const next: PerimeterSpan[] = [];
    for (const s of out) {
      if (c.to <= s.from || c.from >= s.to) next.push(s);
      else {
        if (c.from > s.from) next.push({ from: s.from, to: c.from });
        if (c.to < s.to) next.push({ from: c.to, to: s.to });
      }
    }
    out = next;
  }
  return out;
}

function longestRunMiddle(per: Perimeter, doors: readonly PerimeterSpan[]): number | null {
  const { runs } = openRuns(doors, per.length);
  let best: PerimeterSpan | null = null;
  for (const r of runs) if (!best || r.to - r.from > best.to - best.from + 1) best = r;
  if (!best) return null;
  return (best.from + best.to) / 2;
}

/** On the wall beside a fixture: just past its edge along the nearest wall, within `maxMm` of it, not in a doorway. */
function besideFixture(per: Perimeter, outline: readonly Vec2[], doors: readonly PerimeterSpan[], maxMm: number): number | null {
  const c = centroid(outline);
  const pr = project(per, c);
  const along = outline.map((q) => dot(sub(q, pr.edge.a), pr.edge.dir));
  const half = (Math.max(...along) - Math.min(...along)) / 2;
  const centre = pr.s;
  for (const s of [centre + half + 150, centre - half - 150, centre]) {
    const at = pointAt(per, s).point;
    if (doors.some((d) => inRun(d, s, per.length) !== null)) continue;
    if (distanceToOutline(at, outline) <= maxMm) return s;
  }
  return null;
}

function finishRoom(room: RoomGeometry, label: string, rule: RoomRule, basis: string, per: Perimeter, placements: readonly Placement[], runs: readonly CoverageRun[], notes: readonly string[], mount: (typeId: string) => WallMount, gap: number): RoomProposal {
  const counts = new Map<string, number>();
  const devices: ProposedDevice[] = placements.map((p) => {
    const n = (counts.get(p.kind) ?? 0) + 1;
    counts.set(p.kind, n);
    const at = p.at ?? onWall(per, p.s ?? 0, mount(p.typeId), gap);
    return { key: `${room.id}#${p.kind}-${n}`, roomId: room.id, kind: p.kind, typeId: p.typeId, position: at.position, rotationDeg: at.rotationDeg, heightMm: p.heightMm, reason: p.reason, cite: p.cite };
  });
  const passes = runs.every((r) => r.passes);
  const outside = devices.filter((d) => d.kind !== "island" && d.kind !== "peninsula" && !pointInOutline(d.position, normalizeOutline(room.outline)));
  const extra = outside.length > 0 ? [`${outside.length} proposed position${outside.length === 1 ? " is" : "s are"} outside the room outline; check the outline.`] : [];
  return { roomId: room.id, label, rule, ruleBasis: basis, devices, runs, passes, notes: [...notes, ...extra] };
}

/** Propose receptacles for the rooms the engineer picked. Pure: same rooms and rules, same answer. */
export function proposeReceptacles(rooms: readonly RoomGeometry[], req: ReceptacleRequest): ReceptacleProposal {
  const out = rooms.map((r) => proposeRoom(r, req));
  const devices = out.flatMap((r) => r.devices);
  const passes = out.every((r) => r.passes);
  const roomsWord = `${out.length} room${out.length === 1 ? "" : "s"}`;
  const check =
    req.mode === "density"
      ? `about ${feetInches(req.rules.presets[req.preset ?? "medium"].spacingMm)} apart on the walls`
      : `every point of wall space within ${feetInches(req.rules.wall.maxDistanceMm)}, counters within ${feetInches(req.rules.countertop.maxDistanceMm)}: ${passes ? "passes" : "does not pass"}`;
  return {
    mode: req.mode,
    preset: req.mode === "density" ? (req.preset ?? "medium") : null,
    code: req.rules.code,
    rooms: out,
    devices,
    passes,
    summary: `${devices.length} receptacle${devices.length === 1 ? "" : "s"} in ${roomsWord}; ${check}`,
  };
}

/**
 * Coverage with only the receptacles that are there (the room's existing ones
 * plus `kept`): what the engineer has after accepting some of a proposal. A run
 * passes when no point of it is further than the rule allows.
 */
export function checkReceptacleCoverage(room: RoomGeometry, req: ReceptacleRequest, kept: readonly Vec2[]): readonly CoverageRun[] {
  const withKept: RoomGeometry = { ...room, existing: [...room.existing, ...kept.map((position, i) => ({ id: `kept-${i}`, position, appliance: false, label: "kept" }))] };
  return proposeRoom(withKept, req).runs.map((r) => ({ ...r, worstMm: r.worstBeforeMm, passes: r.worstBeforeMm <= r.limitMm + 1 }));
}
