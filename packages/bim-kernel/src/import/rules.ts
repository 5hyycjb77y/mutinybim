import { asElementId } from "../types";
import { GLOBAL_PARTITION } from "../partition";
import type { Beam, Column, Component, ElementId, Level, MepSystem, Opening, PartInstance, PartTypeElement, Room, RunDomain, RunFitting, RunSegment, RunSize, Slab, Vec2, Wall } from "../types";
import { checkCeilingHole, checkCeilingOutline, type HoleFault } from "../ceilings/outline";
import { CEILING_HEIGHT_MAX_MM, CEILING_HOLES_MAX, CEILING_OUTLINE_MAX_POINTS, type Ceiling } from "../ceilings/types";
import { FITTING_TYPES, RUN_DOMAINS, type FittingType, type HostedOn, type RunPoint, type RunPort } from "../routing/types";
import { angleBetween, dir3, dist3, dot3, hostedPoints, segmentAxis, segmentLength3, sub3 } from "../routing/geometry";
import { hasSides, onItsSide } from "../routing/orientation";
import { connectorDomainOf, fittingLabel, sameSize, sizeFitsDomain, sizeWidth, systemRules, transitionReason } from "../routing/rules";
import { pipeTurnAngles } from "../routing/pipe/turn-angles";
import { PIPE_TURN_TOLERANCE_DEG } from "../routing/validate";
import { activeServiceRegistry } from "../services/registry";
import { BUILTIN_CONNECTOR_IDS } from "../services/builtin";
import { PART_CATEGORIES, connectorSchema, type PartCategory, type PartConnector, type PartTypeDefinition } from "../parts";
import type { ImportRuleContext, ImportRuleDef } from "./rule-point";
import { axisAligned, holedPrism, outlineArea, outlineCentre, rectangleAxis, roundPlan, straightSweep, verticalPrism } from "./shape";
import { OUTLINE_WITH_HOLES, type ImportGroup, type ImportJoin, type ImportPoint, type ImportPort, type ImportProduct, type ImportRuleResult } from "./types";

/**
 * The kernel's import rules: one per generic kind, reading only geometry and
 * the class's own recognition fields. What a product is (a fire-rated wall, a
 * supply run, a terminal) is the class's; the rule only knows the shape
 * of the kind it writes. Anything that isn't that shape is refused with the
 * reason, and stays on the linked model.
 */

const fail = (reason: string): ImportRuleResult => ({ ok: false, reason });

const nameOf = (p: ImportProduct): string => p.name?.trim() || p.tag?.trim() || p.sourceId;
const typeNameOf = (p: ImportProduct, fallback: string): string => (p.typeName?.trim() || p.objectType?.trim() || fallback).slice(0, 200);
/** To 0.1 mm; a rounded-away negative reads 0, never -0. */
const round = (n: number): number => Math.round(n * 10) / 10 + 0;

/**
 * To 0.1 mm, steadily: float noise is taken out first (to a millionth of a millimetre), so one length read through
 * differently turned frames rounds the same way every time. Plain `round` tips either side of a half on that noise:
 * 300.05 read as 300.04999999999995 gives 300, and as 300.05000000000007 gives 300.1.
 */
const steady = (n: number): number => (Math.sign(n) * Math.round(Math.round(Math.abs(n) * 1e6) / 1e5)) / 10 + 0;

function base(ctx: ImportRuleContext, p: ImportProduct, level: Level, suffix?: string) {
  const values = ctx.values(p);
  return {
    id: ctx.idFor(p.sourceId, suffix),
    version: 0,
    authoredRev: {},
    partition: ctx.partition(level),
    provenance: ctx.provenance(p),
    ...(ctx.cls.source === "builtin" ? {} : { classId: ctx.cls.id }),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
}

function needLevel(ctx: ImportRuleContext, p: ImportProduct): Level | string {
  return ctx.level(p) ?? "it isn't on a storey this model has a level for";
}

const wall: ImportRuleDef = {
  id: "kernel.wall",
  label: "Straight walls",
  forKinds: ["wall"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const prism = verticalPrism(p.geometry);
    if (!prism) return fail(p.geometry.unread ? `its shape is ${p.geometry.unread}` : "it isn't one straight, upright piece");
    const axis = rectangleAxis(prism.outline);
    if (!axis) return fail("its footprint isn't a rectangle (curved, tapered or angled ends)");
    const record: Wall = {
      ...base(ctx, p, level),
      kind: "wall",
      start: roundPlan(axis.start),
      end: roundPlan(axis.end),
      thickness: round(axis.thickness),
      height: round(prism.top - prism.bottom),
      wallType: typeNameOf(p, "Imported wall"),
    };
    return { ok: true, records: [record] };
  },
};

const slab: ImportRuleDef = {
  id: "kernel.slab",
  label: "Flat slabs",
  forKinds: ["slab"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const prism = verticalPrism(p.geometry);
    if (!prism) return fail(p.geometry.unread ? `its shape is ${p.geometry.unread}` : "it isn't flat (sloped or shaped)");
    const record: Slab = { ...base(ctx, p, level), kind: "slab", outline: prism.outline.map(roundPlan), thickness: round(prism.top - prism.bottom) };
    return { ok: true, records: [record] };
  },
};

/** What is wrong with an outline or a hole the commands refuse, to follow "its outline" or "one of its holes". */
const OUTLINE_FAULTS: Readonly<Record<HoleFault, string>> = {
  too_few_corners: "has fewer than 3 corners",
  not_a_number: "has a corner that isn't a number",
  crosses_itself: "crosses itself",
  too_small: "covers almost nothing (under 1 sq ft)",
  outside: "isn't inside its outline",
};

const NOT_FLAT = "it isn't flat (sloped or shaped)";

/**
 * A flat ceiling from one footprint pushed straight up, less the holes cut through it: its underside is the ceiling,
 * at its height above the level. The footprint has to be the ceiling's true outline, in straight edges, and the
 * ceiling one the ceiling commands would make; anything else stays on the linked model with the reason.
 */
const ceiling: ImportRuleDef = {
  id: "kernel.ceiling",
  label: "Flat ceilings",
  forKinds: ["ceiling"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const prism = holedPrism(p.geometry);
    if (!prism) {
      const { unread } = p.geometry;
      if (unread !== OUTLINE_WITH_HOLES) return fail(unread ? `its shape is ${unread}` : NOT_FLAT);
      // Holes are read for a ceiling, so having them is no reason: say what is wrong with the shape, or with a hole.
      return fail(verticalPrism({ ...p.geometry, unread: null }) ? "one of its holes couldn't be read (curved, or not a closed line)" : NOT_FLAT);
    }
    const [shape] = p.geometry.extrusions;
    // A ceiling is its plan outline, so a footprint read only as a size or as a sampled circle isn't one to take.
    if (shape?.circle) return fail("its outline is a circle, and a ceiling here has straight edges");
    if (shape?.outerBound) return fail("its shape is a hollow or rolled section, and only the outside edge of those is read from the file");
    // An opening cut as its own element leaves the outline whole, so the outline alone would bring the ceiling in filled.
    if ((p.openings ?? 0) > 0) return fail("it has openings cut through it, and those aren't read from the file yet");
    const drawn = prism.outline.map(roundPlan);
    if (drawn.length > CEILING_OUTLINE_MAX_POINTS) return fail(`its outline has ${drawn.length} corners, and a ceiling here takes ${CEILING_OUTLINE_MAX_POINTS} at most`);
    // The same checks the ceiling commands run, so what comes in is a ceiling they would make.
    const { outline, fault } = checkCeilingOutline(drawn);
    if (fault) return fail(`its outline ${OUTLINE_FAULTS[fault]}`);
    if (prism.holes.length > CEILING_HOLES_MAX) return fail(`it has ${prism.holes.length} holes, and a ceiling here takes ${CEILING_HOLES_MAX} at most`);
    const most = prism.holes.reduce((n, hole) => Math.max(n, hole.length), 0);
    if (most > CEILING_OUTLINE_MAX_POINTS) return fail(`one of its holes has ${most} corners, and a hole here takes ${CEILING_OUTLINE_MAX_POINTS} at most`);
    const holes: Vec2[][] = [];
    for (const cut of prism.holes) {
      const hole = checkCeilingHole(cut.map(roundPlan), outline);
      if (hole.fault) return fail(`one of its holes ${OUTLINE_FAULTS[hole.fault]}`);
      holes.push(hole.outline);
    }
    const heightMm = round(prism.bottom - level.elevationMm);
    if (!(heightMm > 0)) return fail("it sits at or below the floor of its level, and a ceiling here is above it");
    if (heightMm > CEILING_HEIGHT_MAX_MM) return fail(`it is more than ${CEILING_HEIGHT_MAX_MM / 1000} m above its level, higher than a ceiling here can be`);
    const record: Ceiling = { ...base(ctx, p, level), kind: "ceiling", levelId: level.id, outline, ...(holes.length > 0 ? { holes } : {}), form: "flat", heightMm };
    return { ok: true, records: [record] };
  },
};

const room: ImportRuleDef = {
  id: "kernel.room",
  label: "Rooms",
  forKinds: ["room"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const prism = verticalPrism(p.geometry);
    if (!prism) return fail(p.geometry.unread ? `its outline is ${p.geometry.unread}` : "its outline couldn't be read as a floor plan");
    const outline = prism.outline.map(roundPlan);
    const record: Room = {
      ...base(ctx, p, level),
      kind: "room",
      number: (p.name?.trim() || p.sourceId).slice(0, 40),
      name: (p.longName?.trim() || p.name?.trim() || "Room").slice(0, 120),
      outline,
      areaSqM: Math.round((outlineArea(outline) / 1e6) * 100) / 100,
    };
    return { ok: true, records: [record] };
  },
};

const column: ImportRuleDef = {
  id: "kernel.column",
  label: "Straight columns",
  forKinds: ["column"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const prism = verticalPrism(p.geometry);
    if (!prism) return fail(p.geometry.unread ? `its shape is ${p.geometry.unread}` : "it isn't one straight, upright piece");
    if (prism.outline.length !== 4 || !rectangleAxis(prism.outline)) return fail("its section isn't a rectangle");
    if (!axisAligned(prism.outline)) return fail("it is turned off the plan's axes, which a column here can't be");
    const xs = prism.outline.map((q) => q.x);
    const ys = prism.outline.map((q) => q.y);
    const material = (p.material ?? "").trim().toLowerCase();
    const record: Column = {
      ...base(ctx, p, level),
      kind: "column",
      material: material ? (material.match(/[a-z]+/)?.[0] ?? material).slice(0, 40) : "unspecified",
      position: roundPlan(outlineCentre(prism.outline)),
      size: { x: round(Math.max(...xs) - Math.min(...xs)), y: round(Math.max(...ys) - Math.min(...ys)) },
    };
    return { ok: true, records: [record] };
  },
};

const beam: ImportRuleDef = {
  id: "kernel.beam",
  label: "Straight beams",
  forKinds: ["beam"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const sweep = straightSweep(p.geometry);
    if (!sweep) return fail(p.geometry.unread ? `its shape is ${p.geometry.unread}` : "it isn't one straight piece with a constant section");
    if (Math.abs(sweep.end.z - sweep.start.z) > 1) return fail("it slopes");
    const record: Beam = {
      ...base(ctx, p, level),
      kind: "beam",
      sectionName: typeNameOf(p, sweep.section.shape === "round" ? `Ø${Math.round(sweep.section.diameter)}` : `${Math.round(sweep.section.width)}×${Math.round(sweep.section.height)}`),
      start: roundPlan(sweep.start),
      end: roundPlan(sweep.end),
    };
    return { ok: true, records: [record] };
  },
};

/** A door or window: where it sits along the wall whose opening it fills. That wall must have come in too. */
const opening: ImportRuleDef = {
  id: "kernel.opening",
  label: "Doors and windows in converted walls",
  forKinds: ["opening"],
  order: 20,
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    if (!p.hostId) return fail("the file doesn't say which wall it is in");
    const host = ctx.converted(p.hostId);
    if (!host || host.kind !== "wall") return fail("the wall it is in stays on the linked model");
    const openingType = ctx.fields.openingType;
    if (typeof openingType !== "string") return fail(`${ctx.cls.label} doesn't say what kind of opening it is`);
    const b = p.geometry.bounds;
    if (!b) return fail("its position couldn't be read");
    const dx = host.end.x - host.start.x;
    const dy = host.end.y - host.start.y;
    const length = Math.hypot(dx, dy);
    const centre = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
    const offset = ((centre.x - host.start.x) * dx + (centre.y - host.start.y) * dy) / length;
    const across = Math.abs(((b.max.x - b.min.x) * dx + (b.max.y - b.min.y) * dy) / length);
    const width = p.overall.width ?? across;
    const height = p.overall.height ?? b.max.z - b.min.z;
    if (!(width > 0) || !(height > 0)) return fail("its size couldn't be read");
    if (offset - width / 2 < -1 || offset + width / 2 > length + 1) return fail("it doesn't fit on the wall it is in");
    const record: Opening = {
      ...base(ctx, p, level),
      kind: "opening",
      openingType,
      mark: (p.tag?.trim() || p.name?.trim() || "").slice(0, 40),
      hostId: host.id,
      offset: round(offset),
      width: round(width),
      height: round(height),
      // Derived from the host and offset on the edit.
      position: roundPlan({ x: host.start.x + (dx / length) * offset, y: host.start.y + (dy / length) * offset }),
    };
    ctx.note(`${record.mark || nameOf(p)}: its swing and leaf style weren't brought in`);
    return { ok: true, records: [record] };
  },
};

function isRunDomain(v: unknown): v is RunDomain {
  return typeof v === "string" && (RUN_DOMAINS as readonly string[]).includes(v);
}

type ServiceRow = ReturnType<typeof activeServiceRegistry>["rows"][number];

/** The registered system kind a file group reads as: the one whose IFC home and words match it best. `connector`: only among the kinds that connector carries. */
function systemRowOf(group: ImportGroup, connector: string | null): ServiceRow | null {
  const words = `${group.name ?? ""} ${group.objectType ?? ""}`.toLowerCase();
  let best: { row: ServiceRow; score: number } | null = null;
  for (const row of activeServiceRegistry().rows) {
    if (!row.asSystem || (connector !== null && row.connector !== connector)) continue;
    let score = 0;
    if (group.predefinedType && row.ifc.predefinedType === group.predefinedType) score += 2;
    if (group.objectType && row.ifc.objectType && row.ifc.objectType.toLowerCase() === group.objectType.toLowerCase()) score += 2;
    if (row.label.toLowerCase().split(/\s+/).every((w) => words.includes(w))) score += 3;
    if (score > 0 && (!best || score > best.score)) best = { row, score };
  }
  return best?.row ?? null;
}

/** The system a run's file group becomes: the registered system kind whose IFC home and words match it. */
function systemFor(ctx: ImportRuleContext, p: ImportProduct, domain: RunDomain): MepSystem | string {
  const groupId = p.groupIds.find((id) => ctx.group(id) !== null);
  const group = groupId ? ctx.group(groupId) : null;
  if (!group || !groupId) return "the file doesn't put it in a system";
  return ctx.shared<MepSystem>(`system:${groupId}`, () => {
    const best = systemRowOf(group, connectorDomainOf(domain));
    if (!best) return `no registered system kind matches its system "${group.name ?? groupId}"`;
    const record: MepSystem = {
      id: ctx.idFor(groupId),
      kind: "mep_system",
      version: 0,
      authoredRev: {},
      partition: { ...GLOBAL_PARTITION, discipline: ctx.cls.discipline },
      name: (group.name?.trim() || "Imported system").slice(0, 120),
      systemKind: best.id,
      domain,
      provenance: { ifcGlobalId: groupId, source: ctx.provenance(p).source },
    };
    return record;
  });
}

/** A straight run segment of the class's run domain, in the system the file puts it in. */
const runSegment: ImportRuleDef = {
  id: "kernel.run_segment",
  label: "Straight run segments",
  forKinds: ["run_segment"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const domain = ctx.fields.domain;
    if (!isRunDomain(domain)) return fail(`${ctx.cls.label} doesn't say what kind of run it is`);
    const sweep = straightSweep(p.geometry);
    if (!sweep) return fail(p.geometry.unread ? `its shape is ${p.geometry.unread}` : "it isn't one straight piece with a constant section");
    const size: RunSize = sweep.section.shape === "round" ? { shape: "round", diameter: round(sweep.section.diameter) } : { shape: "rect", width: round(sweep.section.width), height: round(sweep.section.height) };
    if (!sizeFitsDomain(size, domain)) return fail("its size needs the add-on that owns these runs' sizes (nominal size and material) to come in");
    const system = systemFor(ctx, p, domain);
    if (typeof system === "string") return fail(system);
    const z = level.elevationMm;
    const record: RunSegment = {
      ...base(ctx, p, level),
      kind: "run_segment",
      domain,
      systemId: system.id,
      levelId: level.id,
      start: { x: round(sweep.start.x), y: round(sweep.start.y), z: round(sweep.start.z - z) },
      end: { x: round(sweep.end.x), y: round(sweep.end.y), z: round(sweep.end.z - z) },
      size,
      links: {},
      branches: [],
      flow: 0,
    };
    return { ok: true, records: [record] };
  },
};

/** How near two points the file states must be to count as one, mm (records are rounded to 0.1 mm on the way in). */
const MEET_MM = 1;

// The fitting shapes by their place in `FITTING_TYPES`, so this file spells none of them out.
const [BEND_SHAPE, TRANSITION_SHAPE, SIDE_BRANCH, THROUGH_BRANCH, ANGLED_BRANCH, CAP_SHAPE] = FITTING_TYPES;
/** The file's fitting types for a fitting that sits between runs at one point. */
const POINT_FITTINGS: Readonly<Record<string, FittingType>> = { BEND: BEND_SHAPE, TRANSITION: TRANSITION_SHAPE, OBSTRUCTION: CAP_SHAPE };
/** The file's fitting type for a fitting where a branch leaves the side of a run. */
const BRANCH_FITTING = "JUNCTION";
const BRANCH_SHAPES: readonly FittingType[] = [SIDE_BRANCH, THROUGH_BRANCH, ANGLED_BRANCH];

const NO_PLACE_ON_RUN = "it branches off the side of a run, and the file doesn't say where on that run";
const RUN_SPLIT_AT_IT = "the run it branches from is cut in two at it in the file, and a branch here sits on one unbroken run";

/** A converted straight piece that the file joins one opening of a fitting to. */
interface RunMeeting {
  readonly product: ImportProduct;
  readonly segment: RunSegment;
  /** The floor the piece's heights are from, mm from the model's zero. */
  readonly floor: number;
  /** Where the file says they meet, from the model's zero. */
  readonly here: ImportPoint;
  /** The way the piece's own connection point there faces, when the file says. */
  readonly facing: ImportPoint | null;
}

function runMeeting(ctx: ImportRuleContext, level: Level, port: ImportPort, far: ImportJoin): RunMeeting | string {
  const record = ctx.converted(far.product.sourceId);
  if (!record) return "something it joins stays on the linked model";
  if (record.kind === "part") return "its branch joins a part directly, which isn't read from the file yet";
  if (record.kind !== "run_segment") return "it joins something other than a straight run, which isn't read from the file yet";
  const here = far.port.position ?? port.position;
  if (!here) return "the file doesn't say where its openings are";
  return { product: far.product, segment: record, floor: (ctx.level(far.product) ?? level).elevationMm, here, facing: far.port.direction ?? null };
}

/** The end of a converted straight piece that one opening of a fitting joins. */
interface JoinedEnd {
  readonly product: ImportProduct;
  readonly segment: RunSegment;
  readonly end: "start" | "end";
  /** That end, with its height from the floor asked for. */
  readonly at: RunPoint;
  /** Unit vector from that end along the piece: out of the fitting through the opening. */
  readonly away: RunPoint;
}

/** The end of the piece at the point the file joins it, heights from `floorMm`; null when that point isn't one of its ends. */
function endAt(m: RunMeeting, floorMm: number): JoinedEnd | null {
  const gap = (q: RunPoint) => Math.hypot(q.x - m.here.x, q.y - m.here.y, q.z + m.floor - m.here.z);
  const end = gap(m.segment.start) <= gap(m.segment.end) ? "start" : "end";
  const [from, to] = end === "start" ? [m.segment.start, m.segment.end] : [m.segment.end, m.segment.start];
  if (gap(from) > MEET_MM) return null;
  return { product: m.product, segment: m.segment, end, at: { x: from.x, y: from.y, z: round(from.z + m.floor - floorMm) }, away: dir3(sub3(to, from)) };
}

/** Half the size of a piece's section, corner to corner: how far off its centre line a point on its faces can be. */
function sectionReach(size: RunSize): number {
  if (size.shape === "rect" || size.shape === "oval") return Math.hypot(size.width, size.height) / 2;
  return size.shape === "round" ? size.diameter / 2 : 0;
}

/** How far along the piece, from its start, the file joins it, when that is between its ends; null when it is at an end or off the piece. */
function alongSide(m: RunMeeting): number | null {
  const axis = segmentAxis(m.segment);
  const from = sub3({ x: m.here.x, y: m.here.y, z: m.here.z - m.floor }, m.segment.start);
  const s = dot3(from, axis);
  if (s <= MEET_MM || s >= segmentLength3(m.segment) - MEET_MM) return null;
  const off = Math.hypot(from.x - axis.x * s, from.y - axis.y * s, from.z - axis.z * s);
  return off <= sectionReach(m.segment.size) + MEET_MM ? s : null;
}

/** The system a converted run piece is in (made when the piece came in). */
function systemOfRun(ctx: ImportRuleContext, joined: { readonly product: ImportProduct; readonly segment: RunSegment }): MepSystem | string {
  const system = systemFor(ctx, joined.product, joined.segment.domain);
  if (typeof system === "string") return system;
  return system.id === joined.segment.systemId ? system : "the system of the run it joins couldn't be read from the file";
}

const ID_WORD = /^[A-Za-z0-9_-]{1,40}$/;

/** Ids for a fitting's openings: the file's names for them when they can be ids (`a`, `b`), else letters in the file's order. */
function openingIds(ports: readonly ImportPort[]): string[] {
  const names = ports.map((port) => port.name?.trim() ?? "");
  const usable = names.every((n) => ID_WORD.test(n)) && new Set(names).size === names.length;
  return usable ? names : ports.map((_, i) => String.fromCharCode(97 + i));
}

/** The fields every imported fitting carries; it is filed with the run it joins (its class is every discipline's, so it has none of its own). */
function fittingBase(ctx: ImportRuleContext, p: ImportProduct, level: Level, run: RunSegment, system: MepSystem) {
  return {
    id: ctx.idFor(p.sourceId),
    version: 0,
    authoredRev: {},
    partition: { ...ctx.partition(level), ...(run.partition ? { discipline: run.partition.discipline } : {}) },
    provenance: ctx.provenance(p),
    kind: "run_fitting" as const,
    domain: run.domain,
    systemId: system.id,
    levelId: level.id,
  };
}

/** One opening of a fitting that sits between runs: where it is, which way out, its size and what it joins. */
interface FittingOpening {
  /** Heights from the fitting's own level floor. */
  readonly at: RunPoint;
  /** Unit vector out of the fitting through the opening. */
  readonly away: RunPoint;
  readonly size: RunSize;
  readonly link: { readonly elementId: ElementId; readonly port: string };
  /** The straight piece it joins; null when it joins a part's connector. */
  readonly run: JoinedEnd | null;
}

/**
 * An opening on a part's connector, read from the part's own connection point in the file: it sits there, faces the
 * other way, and is that size. The plan checks the connector takes it when it writes the link back (`joins.ts`).
 */
function partOpening(level: Level, port: ImportPort, far: ImportJoin, part: PartInstance): FittingOpening | string {
  if (!far.connector) return "it joins a part at a point that wasn't brought in as one of the part's connection points";
  const here = far.port.position ?? port.position;
  if (!here) return "the file doesn't say where its openings are";
  const facing = far.port.direction ?? null;
  if (!facing) return "the file doesn't say which way the part's connection point it joins faces";
  const opening = far.port.size ?? null;
  if (!opening) return "the file doesn't give the size of the part's connection point it joins";
  const size: RunSize = opening.shape === "rect" ? { shape: "rect", width: round(opening.width), height: round(opening.height) } : { shape: "round", diameter: round(opening.diameter) };
  return { at: { x: round(here.x), y: round(here.y), z: round(here.z - level.elevationMm) }, away: dir3({ x: -facing.x, y: -facing.y, z: -facing.z }), size, link: { elementId: part.id, port: far.connector }, run: null };
}

/** A bend, a transition or an end cap, read from what its openings join: the ends, directions and sizes of straight pieces, and a part's connection points. */
function pointFitting(p: ImportProduct, ctx: ImportRuleContext, level: Level, shape: FittingType): ImportRuleResult {
  const ends: FittingOpening[] = [];
  for (const port of p.ports) {
    const joins = ctx.joinedTo(port);
    const [far] = joins;
    if (!far) return fail("the file doesn't say what one of its openings joins");
    if (joins.length > 1) return fail("one of its openings joins more than one thing");
    const record = ctx.converted(far.product.sourceId);
    if (record?.kind === "part") {
      const opening = partOpening(level, port, far, record);
      if (typeof opening === "string") return fail(opening);
      ends.push(opening);
      continue;
    }
    const meeting = runMeeting(ctx, level, port, far);
    if (typeof meeting === "string") return fail(meeting);
    const end = endAt(meeting, level.elevationMm);
    if (!end) return fail("it doesn't meet the end of a run it joins");
    ends.push({ at: end.at, away: end.away, size: end.segment.size, link: { elementId: end.segment.id, port: end.end }, run: end });
  }
  const [a, b] = ends;
  if (!a) return fail("the file doesn't say what its openings join");
  const what = shape === BEND_SHAPE ? "a bend" : shape === TRANSITION_SHAPE ? "a transition" : "an end cap";
  const openings = shape === CAP_SHAPE ? 1 : 2;
  if (ends.length !== openings) return fail(`it is written as ${what}, which has ${openings === 1 ? "one opening" : "two openings"}, but the file gives it ${ends.length}`);
  // What it is (the kind of run, its system) comes from a run it joins; a part alone doesn't say.
  const run = ends.find((e) => e.run !== null)?.run;
  if (!run) return fail("it joins no run, only parts, so nothing says which system it is in");
  if (ends.some((e) => e.run !== null && e.run.segment.systemId !== run.segment.systemId)) return fail("it joins runs of different systems");
  const { domain } = run.segment;
  if (ctx.fields.domain !== undefined && ctx.fields.domain !== domain) return fail(`${ctx.cls.label} doesn't take the kind of run it joins`);
  if (ends.some((e) => !sizeFitsDomain(e.size, domain))) return fail("the part's connection point it joins isn't a size these runs have");
  const system = systemOfRun(ctx, run);
  if (typeof system === "string") return fail(system);
  let angleDeg: number | undefined;
  if (b) {
    if (dist3(a.at, b.at) > MEET_MM) return fail("its openings aren't at one point, the way a fitting here meets its runs");
    const between = angleBetween(a.away, b.away);
    const same = sameSize(a.size, b.size);
    if (shape === BEND_SHAPE) {
      if (180 - between < 0.5) return fail("it is written as a bend, but the runs it joins run straight through");
      if (!same && !sameSize(onItsSide(a.size), b.size)) return fail("it is written as a bend, but the runs it joins differ in size");
      const turn = 180 - between;
      // A fitting made for set angles (a quarter or an eighth bend) keeps the angle it is made for; laid to a pitch it turns a little off that.
      const made = a.size.shape === "pipe" ? pipeTurnAngles(system.systemKind, a.size).filter((deg) => Math.abs(deg - turn) <= PIPE_TURN_TOLERANCE_DEG).sort((x, y) => Math.abs(x - turn) - Math.abs(y - turn))[0] : undefined;
      angleDeg = made ?? round(turn);
    } else {
      if (between < 179.5) return fail("it is written as a transition, but the runs it joins turn there");
      if (same) return fail("it is written as a transition, but the runs it joins are the same size");
      if (transitionReason(a.size, b.size)) return fail("one transition here can't join the two sizes it is between");
    }
  }
  const ids = openingIds(p.ports);
  const ports: RunPort[] = ends.map((e, i) => ({ id: ids[i] ?? String(i), position: e.at, direction: e.away, size: e.size, link: e.link }));
  const record: RunFitting = {
    ...fittingBase(ctx, p, level, run.segment, system),
    fittingType: shape,
    label: (p.name?.trim() || fittingLabel(shape, systemRules(system.systemKind), null, angleDeg)).slice(0, 120),
    position: a.at,
    ...(angleDeg !== undefined ? { angleDeg } : {}),
    ports,
  };
  return { ok: true, records: [record] };
}

/**
 * Where a branch sits on the run it leaves: how far along, which way out (a side, the top or bottom, or a level
 * direction off a riser) and how far across that face. `out` is the way the branch leaves; `off` is the run's
 * connection point for it, from the point of the run's centre line that far along.
 */
function hostedOn(host: RunSegment, s: number, out: RunPoint, off: RunPoint): HostedOn | string {
  const axis = segmentAxis(host);
  const along = Math.round(s * 1000) / 1000;
  const plan = Math.hypot(axis.x, axis.y);
  const level = Math.hypot(out.x, out.y);
  if (plan < 1e-6) {
    if (level < 1e-6) return "its branch leaves a riser straight up or down, and a branch here leaves a riser level";
    return { segmentId: host.id, s: along, side: 1, dir: { x: Math.round((out.x / level) * 1e6) / 1e6, y: Math.round((out.y / level) * 1e6) / 1e6 } };
  }
  const left = { x: -axis.y / plan, y: axis.x / plan, z: 0 };
  if (Math.abs(out.z) > level) {
    const up = out.z > 0 ? 1 : -1;
    const t = round(dot3(off, left) * up);
    return { segmentId: host.id, s: along, side: 1, face: up > 0 ? "top" : "bottom", ...(t !== 0 ? { t } : {}) };
  }
  const leftward = dot3(out, left);
  if (Math.abs(leftward) < 1e-6) return "its branch runs along the run it leaves, not out of its side";
  const side = leftward > 0 ? 1 : -1;
  const t = round(-side * off.z);
  return { segmentId: host.id, s: along, side, ...(t !== 0 ? { t } : {}) };
}

/**
 * A fitting where a branch leaves the side of a run. The file says which run and where by a connection point on that
 * run between its ends, joined to the fitting: the run it is on is the host, and the point's place along it is the
 * distance. The fitting has one opening, the branch.
 */
function branchFitting(p: ImportProduct, ctx: ImportRuleContext, level: Level): ImportRuleResult {
  const sides: Array<{ readonly meeting: RunMeeting; readonly s: number }> = [];
  const ends: Array<{ readonly port: ImportPort; readonly meeting: RunMeeting }> = [];
  for (const port of p.ports) {
    for (const far of ctx.joinedTo(port)) {
      const meeting = runMeeting(ctx, level, port, far);
      if (typeof meeting === "string") return fail(meeting);
      const s = alongSide(meeting);
      if (s !== null) sides.push({ meeting, s });
      else ends.push({ port, meeting });
    }
  }
  const [on] = sides;
  if (!on) return fail(ends.length > 1 ? RUN_SPLIT_AT_IT : NO_PLACE_ON_RUN);
  if (sides.length > 1) return fail("the file puts it on the side of more than one run");
  const [out] = ends;
  if (!out) return fail("the file joins nothing to its branch");
  if (ends.length > 1) return fail("it has more than one branch, and a branch fitting here has one");
  const host = on.meeting.segment;
  // A branch fitting's place follows its host, so it is on the host's level and its heights are from that floor.
  const hostLevel = ctx.level(on.meeting.product) ?? level;
  const branch = endAt(out.meeting, hostLevel.elevationMm);
  if (!branch) return fail("its branch doesn't meet the end of the run joined to it");
  if (branch.segment.id === host.id) return fail("the file joins its branch to the run it sits on");
  if (branch.segment.systemId !== host.systemId) return fail("it joins runs of different systems");
  if (ctx.fields.domain !== undefined && ctx.fields.domain !== host.domain) return fail(`${ctx.cls.label} doesn't take the kind of run it joins`);
  const system = systemOfRun(ctx, on.meeting);
  if (typeof system === "string") return fail(system);
  const rules = systemRules(system.systemKind);
  const lie = sub3(host.end, host.start);
  const level0 = Math.abs(lie.z) < 0.01;
  const plumb = Math.hypot(lie.x, lie.y) < 0.01;
  // The same limit the model checks: off a level run or a round riser (pipe has its own checks, and takes them pitched too).
  if (host.domain !== "pipe" && !level0 && !(plumb && !hasSides(host.size))) return fail(plumb ? "it leaves a riser with flat sides, and a branch here leaves a level run or a round riser" : "it leaves a sloped run, and a branch here leaves a level run or a round riser");
  const wide = sizeWidth(branch.segment.size) - sizeWidth(host.size);
  if (rules.branchMayEqualTrunk ? wide > 0.5 : wide > -0.5) return fail(rules.branchMayEqualTrunk ? "its branch is larger than the run it leaves" : "its branch is as wide as the run it leaves, and a branch here is narrower");
  // Which way out: the way the run's own connection point for the branch faces when the file says, else the way the branch's first piece runs.
  const axis = segmentAxis(host);
  const { here, floor, facing } = on.meeting;
  const off = sub3({ x: here.x, y: here.y, z: here.z - floor }, { x: host.start.x + axis.x * on.s, y: host.start.y + axis.y * on.s, z: host.start.z + axis.z * on.s });
  const hosted = hostedOn(host, on.s, facing ? dir3(facing) : branch.away, off);
  if (typeof hosted === "string") return fail(hosted);
  const at = hostedPoints(host, hosted.s, hosted.side, hosted.dir, hosted.face, hosted.t);
  if (dist3(at.branch, branch.at) > MEET_MM) return fail("its branch doesn't start on the face of the run it leaves");
  const name = p.name?.trim() ?? "";
  // The file has one type for every branch fitting: its name says which when it is one of this system's own words, else the system's usual one.
  const shape = BRANCH_SHAPES.find((type) => fittingLabel(type, rules, branch.segment.size).toLowerCase() === name.toLowerCase()) ?? rules.branch;
  const portName = out.port.name?.trim() ?? "";
  const record: RunFitting = {
    ...fittingBase(ctx, p, hostLevel, host, system),
    fittingType: shape,
    label: (name || fittingLabel(shape, rules, branch.segment.size)).slice(0, 120),
    position: at.onAxis,
    ports: [{ id: ID_WORD.test(portName) ? portName : "branch", position: at.branch, direction: at.outward, size: branch.segment.size, link: { elementId: branch.segment.id, port: branch.end } }],
    host: hosted,
  };
  return { ok: true, records: [record] };
}

/**
 * A fitting on converted runs, read from what the file joins its openings to. Between runs at a point: a bend, a
 * transition or an end cap. On the side of a run: a branch fitting. It links to the straight pieces; the plan writes
 * the links back on them (`joins.ts`). Its make (the library family) isn't in the file, so the system's default applies.
 */
const runFitting: ImportRuleDef = {
  id: "kernel.run_fitting",
  label: "Fittings on converted runs",
  forKinds: ["run_fitting"],
  order: 20,
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const type = p.predefinedType ?? "";
    const shape = POINT_FITTINGS[type];
    if (!shape && type !== BRANCH_FITTING) return fail("it is a kind of fitting that isn't read from the file yet");
    if (p.ports.every((port) => ctx.joinedTo(port).length === 0)) return fail("the file doesn't say what its openings join");
    return shape ? pointFitting(p, ctx, level, shape) : branchFitting(p, ctx, level);
  },
};

function isPartCategory(v: unknown): v is PartCategory {
  return typeof v === "string" && (PART_CATEGORIES as readonly string[]).includes(v);
}

interface PartSeat {
  /** The part's insertion point in the host frame, and its turn about the vertical. */
  readonly origin: ImportPoint;
  readonly rotationDeg: number;
  /** Its shape's box from that point, along the part's own axes. */
  readonly box: { readonly min: ImportPoint; readonly max: ImportPoint };
  /** The part's own axes in the host frame (unit vectors): what is at that point is measured along these. */
  readonly axes: { readonly x: ImportPoint; readonly y: ImportPoint; readonly z: ImportPoint };
  /** Whether that is the file's own placement, and why not when the file had one, for the report. */
  readonly own: boolean;
  readonly why: string | null;
}

/** How near the vertical a product's own z axis must be to count as upright (cosine; about 0.03°). */
const UPRIGHT_COS = 1 - 1e-7;
/** How far outside its shape's plan box an insertion point may be and still be the part's point, mm. */
const SEAT_REACH_MM = 1;

/**
 * Where a part sits and how its box hangs off that point. The file's own
 * placement when it is one a part can have: upright (a part turns about the
 * vertical only) and within its shape in plan (a part is found, picked and
 * roomed by its point). Otherwise the middle of the world box, not turned,
 * as the box around the product.
 */
function partSeat(p: ImportProduct, world: { readonly min: ImportPoint; readonly max: ImportPoint }): PartSeat {
  const boxed = (why: string | null): PartSeat => {
    const origin = { x: (world.min.x + world.max.x) / 2, y: (world.min.y + world.max.y) / 2, z: world.min.z };
    return { origin, rotationDeg: 0, own: false, why, axes: HOST_AXES, box: { min: { x: world.min.x - origin.x, y: world.min.y - origin.y, z: 0 }, max: { x: world.max.x - origin.x, y: world.max.y - origin.y, z: world.max.z - origin.z } } };
  };
  const own = p.placement;
  if (!own?.bounds) return boxed(null);
  if (own.zAxis.z < UPRIGHT_COS) return boxed("it is tilted in the file, so it came in upright, as the box around it");
  const { min, max } = own.bounds;
  if (min.x > SEAT_REACH_MM || max.x < -SEAT_REACH_MM || min.y > SEAT_REACH_MM || max.y < -SEAT_REACH_MM) return boxed("its insertion point is away from its shape in the file, so it sits at the middle of its box, not turned");
  const deg = Math.round(((Math.atan2(own.xAxis.y, own.xAxis.x) * 180) / Math.PI) * 1000) / 1000;
  const { xAxis: x, zAxis: z } = own;
  const y = { x: z.y * x.z - z.z * x.y, y: z.z * x.x - z.x * x.z, z: z.x * x.y - z.y * x.x };
  return { origin: own.origin, rotationDeg: ((deg % 360) + 360) % 360, box: own.bounds, own: true, why: null, axes: { x, y, z } };
}

const HOST_AXES: PartSeat["axes"] = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };

/** Whether a part type made here is this box with these connectors: the same centre and size from its own point, the same connection points. */
function hasShape(type: PartTypeElement, centre: ImportPoint, size: ImportPoint, connectors: readonly PartConnector[]): boolean {
  const box = type.definition.geometry[0];
  if (box?.kind !== "box") return false;
  const want = [centre.x, centre.y, centre.z, size.x, size.y, size.z];
  return [...box.center, ...box.size].every((v, i) => v === want[i]) && connectorsKey(type.definition.connectors) === connectorsKey(connectors);
}

/** A part type's connectors as one text, whatever order they are in: two products of one file type share a part type only while theirs match. */
function connectorsKey(connectors: readonly PartConnector[]): string {
  return connectors.map((c) => JSON.stringify(c)).sort().join("|");
}

/** The most connectors a part type holds (`partTypeDefinitionSchema`). */
const CONNECTORS_MAX = 24;
/** The system kind a connector takes when nothing says what it carries (the registry's own row). */
const UNKNOWN_SYSTEM_KIND = "other";
/** Which way the file says a port's system flows through it, seen from the part. */
const FLOW_DIRECTIONS: Readonly<Record<string, NonNullable<PartConnector["flowDirection"]>>> = { SINK: "in", SOURCE: "out", SOURCEANDSINK: "bidirectional" };

const NO_POSITION = "no position in the file";
const NO_KIND = "nothing in the file says what it connects to";

const along = (v: ImportPoint, axis: ImportPoint): number => v.x * axis.x + v.y * axis.y + v.z * axis.z;
/** A host-frame vector along the part's own axes. */
const inSeat = (seat: PartSeat, v: ImportPoint): ImportPoint => ({ x: along(v, seat.axes.x), y: along(v, seat.axes.y), z: along(v, seat.axes.z) });
/** A number to a millionth, never -0: a unit vector read through a turned frame, or a size through a unit conversion, comes out the same every time. */
const unitPart = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;

/** A host-frame direction along the part's own axes, as a unit vector; null when it isn't a direction (no length, not a number). */
function seatDirection(seat: PartSeat, v: ImportPoint | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const d = inSeat(seat, v);
  const length = Math.hypot(d.x, d.y, d.z);
  if (!(length > 1e-9) || !Number.isFinite(length)) return null;
  return [unitPart(d.x / length), unitPart(d.y / length), unitPart(d.z / length)];
}

/**
 * Out of the nearest side of the part's box, for a connection point the file gives no facing: the side it is on, or
 * nearest to (the underside, then the top, then the sides, when it is as near to two).
 */
function nearestSide(box: PartSeat["box"], at: ImportPoint): [number, number, number] {
  const sides: readonly (readonly [number, [number, number, number]])[] = [
    [box.min.z - at.z, [0, 0, -1]],
    [at.z - box.max.z, [0, 0, 1]],
    [box.min.y - at.y, [0, -1, 0]],
    [at.y - box.max.y, [0, 1, 0]],
    [box.min.x - at.x, [-1, 0, 0]],
    [at.x - box.max.x, [1, 0, 0]],
  ];
  // How far outside each side it is (negative: inside, by how far): the greatest is the side it is beyond, or nearest.
  let best = sides[0] ?? [0, [0, 0, -1]];
  for (const side of sides) if (side[0] > best[0] + 1e-6) best = side;
  return best[1];
}

/**
 * The registered system kind among `rows` that a port's name names, when just one fits best: the most of the name's
 * words in its label, then the fewest other words there ("Return" picks the return of a supply and return pair).
 */
function rowNamed(rows: readonly ServiceRow[], name: string): ServiceRow | null {
  const words = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const scored = rows
    .map((row) => {
      const label = row.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const said = label.filter((w) => words.has(w)).length;
      return { row, said, score: said * 100 - (label.length - said) };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  return first && first.said > 0 && first.score !== second?.score ? first.row : null;
}

interface PortKind {
  readonly domain: string;
  readonly systemKind: string;
  /** Set when the file's word fits several kinds and nothing picked one: the kinds it could be, the one taken first. */
  readonly among?: readonly ServiceRow[];
}

/**
 * What a port connects to and what it carries. The file's own words first (its connector and system type); a port
 * that says neither takes them from the system the file puts its product in. A reason when nothing says, or when no
 * add-on here draws that kind of connection.
 */
function portKind(ctx: ImportRuleContext, p: ImportProduct, port: ImportPort): PortKind | string {
  const registry = activeServiceRegistry();
  const stated = port.domain ?? null;
  const fits = (row: ServiceRow): boolean => row.asSystem && row.connector !== "none" && (stated === null || row.connector === stated);
  // The system type the file gives the port; failing that, the systems the file puts the product in.
  let rows = port.systemType ? registry.rows.filter((row) => fits(row) && row.ifc.system === "IfcDistributionSystem" && row.ifc.predefinedType === port.systemType) : [];
  const exact = rows.length > 0;
  const fromGroups = (): ServiceRow[] => {
    const found = new Set<ServiceRow>();
    for (const id of p.groupIds) {
      const group = ctx.group(id);
      const row = group ? systemRowOf(group, stated) : null;
      if (row && fits(row)) found.add(row);
    }
    return [...found];
  };
  if (!exact) rows = fromGroups();
  const connectors = [...new Set(rows.map((row) => row.connector))];
  const domain = stated ?? (connectors.length === 1 ? (connectors[0] ?? null) : null);
  if (domain === null) return NO_KIND;
  if (!([...BUILTIN_CONNECTOR_IDS, ...registry.connectorIds] as readonly string[]).includes(domain)) return `no add-on here draws that kind of connection ("${domain}")`;
  const [only, ...more] = rows;
  let picked = only && more.length === 0 ? only : rowNamed(rows, port.name ?? "");
  if (!picked && exact && more.length > 0) {
    const narrowed = fromGroups().filter((row) => rows.includes(row));
    if (narrowed.length === 1) picked = narrowed[0] ?? null;
  }
  if (picked) return { domain, systemKind: picked.id };
  // The file's own word fits several kinds: the first is taken, and the report says so. Kinds guessed from a system fit none surely enough to take.
  return exact && only ? { domain, systemKind: only.id, among: rows } : { domain, systemKind: UNKNOWN_SYSTEM_KIND };
}

interface PortsRead {
  readonly connectors: PartConnector[];
  /** Source port id -> imported connector id on the part type, for resolving co-located ports during join planning. */
  readonly byPort: ReadonlyMap<string, string>;
  /** Why ports weren't brought in, each with how many. */
  readonly left: ReadonlyMap<string, number>;
  /** How many face out of the nearest side of the box, the file not saying which way they face. */
  readonly facedBySide: number;
  /** Notes about what a connector carries, where the file's word fits several kinds. */
  readonly unsure: readonly string[];
}

/**
 * A product's ports as its part type's connectors: each at its point and facing its way along the part's own axes,
 * with what it connects to and carries, its opening's size and which way its system flows, where the file says.
 * A port with no position, or that nothing says the kind of, isn't brought in; the reason is counted.
 */
function partConnectors(ctx: ImportRuleContext, p: ImportProduct, seat: PartSeat): PortsRead {
  const left = new Map<string, number>();
  const leave = (reason: string) => left.set(reason, (left.get(reason) ?? 0) + 1);
  const read: Array<{ port: ImportPort; kind: PortKind; at: ImportPoint }> = [];
  for (const port of p.ports) {
    const { position } = port;
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
      leave(NO_POSITION);
      continue;
    }
    const kind = portKind(ctx, p, port);
    if (typeof kind === "string") {
      leave(kind);
      continue;
    }
    const local = inSeat(seat, { x: position.x - seat.origin.x, y: position.y - seat.origin.y, z: position.z - seat.origin.z });
    read.push({ port, kind, at: { x: steady(local.x), y: steady(local.y), z: steady(local.z) } });
  }
  // A port's name is its connector's id where it is a name of its own; one with none, or with another's, is numbered in order of place, so the file's order doesn't matter.
  const slug = (port: ImportPort): string => (port.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const names = new Map<string, number>();
  for (const { port } of read) names.set(slug(port), (names.get(slug(port)) ?? 0) + 1);
  const byPlace = [...read].sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y || a.at.z - b.at.z || (a.port.id < b.port.id ? -1 : 1));
  const used = new Set([...names].filter(([name, count]) => name !== "" && count === 1).map(([name]) => name));
  const ids = new Map<ImportPort, string>();
  byPlace.forEach(({ port }, i) => {
    let id = slug(port);
    if (id === "" || names.get(id) !== 1) {
      id = `port_${i + 1}`;
      while (used.has(id)) id = `${id}_`.slice(-40);
      used.add(id);
    }
    ids.set(port, id);
  });

  const connectors: PartConnector[] = [];
  const byPort = new Map<string, string>();
  const unsure = new Map<string, { kinds: string[]; labels: string[] }>();
  let facedBySide = 0;
  for (const { port, kind, at } of read) {
    if (connectors.length >= CONNECTORS_MAX) {
      leave(`a part here takes ${CONNECTORS_MAX} at most`);
      continue;
    }
    const stated = seatDirection(seat, port.direction);
    const direction = stated ?? nearestSide(seat.box, at);
    const size = port.size;
    const across = size?.shape === "rect" ? seatDirection(seat, port.across) : null;
    const flowDirection = FLOW_DIRECTIONS[port.flow ?? ""];
    const own = {
      id: ids.get(port),
      label: port.name?.trim().slice(0, 80) || `Connection ${byPlace.findIndex((r) => r.port === port) + 1}`,
      domain: kind.domain,
      systemKind: kind.systemKind,
      position: [at.x, at.y, at.z],
      direction,
      shape: size?.shape ?? "none",
      // An opening keeps the size the file gives it (31.75 mm is a size of its own, not 31.8): only the noise of a unit conversion is taken off.
      ...(size?.shape === "rect" ? { width: unitPart(size.width), height: unitPart(size.height) } : size?.shape === "round" ? { diameter: unitPart(size.diameter) } : {}),
      ...(flowDirection ? { flowDirection } : {}),
      // The width's direction completes a rectangular opening's frame; one not square to the way it faces says nothing.
      ...(across && Math.abs(across[0] * direction[0] + across[1] * direction[1] + across[2] * direction[2]) < 0.01 ? { widthAxis: across } : {}),
    };
    // The numbers the file rates it at go on the connector's own fields; where the connector can't take them, it comes in without.
    const rated = connectorSchema.safeParse({ ...port.rated, ...own });
    const made = rated.success ? rated : connectorSchema.safeParse(own);
    if (!made.success) {
      leave("it couldn't be read");
      continue;
    }
    connectors.push(made.data);
    byPort.set(port.id, made.data.id);
    if (!stated) facedBySide += 1;
    if (kind.among) {
      const kinds = kind.among.map((row) => row.label.toLowerCase());
      const key = kinds.join("|");
      unsure.set(key, { kinds, labels: [...(unsure.get(key)?.labels ?? []), made.data.label] });
    }
  }
  const notes = [...unsure.values()].map(({ kinds, labels }) => {
    const one = labels.length === 1;
    const named = labels.slice(0, UNSURE_NAMES_SHOWN).map((label) => `"${label}"`);
    if (labels.length > UNSURE_NAMES_SHOWN) named.push(`${labels.length - UNSURE_NAMES_SHOWN} more`);
    const which = named.length === 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
    return `the file doesn't say whether ${which} ${one ? "carries" : "carry"} ${kinds.slice(0, -1).join(", ")} or ${kinds[kinds.length - 1]}, so ${one ? "it was" : "they were"} brought in as ${kinds[0]}; change ${one ? "it" : "them"} on the type if that is wrong`;
  });
  return { connectors, byPort, left, facedBySide, unsure: notes };
}

/** Per-plan map of source product id -> (source port id -> imported connector id), keyed on the plan's `joinedTo` closure. */
const partPortMaps = new WeakMap<object, Map<string, ReadonlyMap<string, string>>>();

function rememberPartPorts(scope: object, productSourceId: string, byPort: ReadonlyMap<string, string>): void {
  let perProduct = partPortMaps.get(scope);
  if (!perProduct) {
    perProduct = new Map();
    partPortMaps.set(scope, perProduct);
  }
  perProduct.set(productSourceId, byPort);
}

/**
 * Look up the connector id built by `kernel.part` for a source port in the current plan.
 * Returns `undefined` when the part was converted by another rule (caller falls back to position matching).
 */
export function importedPartPortId(scope: object, productSourceId: string, portId: string): string | null | undefined {
  const byPort = partPortMaps.get(scope)?.get(productSourceId);
  return byPort ? (byPort.get(portId) ?? null) : undefined;
}

/** Connector names a note about what they carry spells out before "and N more". */
const UNSURE_NAMES_SHOWN = 5;

/** What the report says of a part type's ports: the ones not brought in, with the reason, and the ones whose facing or kind had to be taken. Nothing when all came in as the file has them. */
function portNotes(ports: number, read: PortsRead): string[] {
  const out: string[] = [];
  const missing = [...read.left.values()].reduce((sum, n) => sum + n, 0);
  if (missing > 0) {
    const one = missing === 1;
    const which = missing < ports ? `${missing} of its ${ports} connection points ${one ? "wasn't" : "weren't"}` : one ? "its connection point wasn't" : `its ${ports} connection points weren't`;
    const why = read.left.size === 1 ? [...read.left.keys()].join("") : [...read.left].map(([reason, n]) => `${n}: ${reason}`).join("; ");
    out.push(`${which} brought in (${why}); add ${one ? "it" : "them"} to the type by hand`);
  }
  const { length: brought } = read.connectors;
  if (read.facedBySide > 0) {
    const one = read.facedBySide === 1;
    const which = read.facedBySide < brought ? `${read.facedBySide} of its connection points ${one ? "faces" : "face"}` : one ? "its connection point faces" : "its connection points face";
    out.push(`the file doesn't say which way ${which}, so ${one ? "it was" : "they were"} brought in facing out of the nearest side of its box; check ${one ? "it" : "them"} before you route from ${one ? "it" : "them"}`);
  }
  out.push(...read.unsure);
  return out;
}

/** A short, stable id part from a text (FNV-1a, base 36): the same box gives the same id on every import. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * A placed part at the product's own insertion point and turn, as the box of
 * its shape, of a part type made once per type in the file. The file's ports
 * on it are the type's connectors; the report says which ports weren't
 * brought in. The rule joins it to nothing: the plan links its connectors to
 * the runs and fittings the file joins them to (`joins.ts`).
 */
const part: ImportRuleDef = {
  id: "kernel.part",
  label: "Parts as boxes of their type",
  forKinds: ["part"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const category = ctx.cls.recognize?.partCategories?.[0] ?? ctx.options.category;
    if (!isPartCategory(category)) return fail(`${ctx.cls.label} doesn't say which part category it is`);
    const b = p.geometry.bounds;
    if (!b) return fail(p.geometry.unread ? `its shape is ${p.geometry.unread}` : "its size couldn't be read");
    const seat = partSeat(p, b);
    // The box is what products of one file type are matched on, so it is rounded steadily: the same box must give the same numbers at any turn.
    const size = { x: steady(seat.box.max.x - seat.box.min.x), y: steady(seat.box.max.y - seat.box.min.y), z: steady(seat.box.max.z - seat.box.min.z) };
    if (size.x < 1 || size.y < 1 || size.z < 1) return fail("it has no size");
    const centre = { x: steady((seat.box.min.x + seat.box.max.x) / 2), y: steady((seat.box.min.y + seat.box.max.y) / 2), z: steady((seat.box.min.z + seat.box.max.z) / 2) };
    const typeName = typeNameOf(p, nameOf(p));
    const ports = partConnectors(ctx, p, seat);
    const { connectors } = ports;
    // A part type's box and connectors hang off its own point, so products share one only while theirs sit the same way from theirs.
    const boxKey = `${size.x}x${size.y}x${size.z}@${centre.x},${centre.y},${centre.z}${connectors.length > 0 ? `#${connectorsKey(connectors)}` : ""}`;
    const typeOf = (source: string, suffix: string) => (): PartTypeElement => {
      const definition: PartTypeDefinition = {
        familyName: typeName,
        typeName,
        category,
        typeParams: [],
        typeValues: {},
        instanceParams: [],
        connectors,
        geometry: [{ kind: "box", center: [centre.x, centre.y, centre.z], size: [size.x, size.y, size.z] }],
        symbol: [{ kind: "rect", center: [centre.x, centre.y], size: [size.x, size.y] }],
        tagFields: ["mark"],
        source: { kind: "ifc", entity: p.entity, typeName, boundingBoxGeometry: true },
      };
      return { id: ctx.idFor(source, suffix), kind: "part_type", version: 0, authoredRev: {}, definition };
    };
    let type: PartTypeElement | string;
    if (p.typeId) {
      // The first met of a file type keeps the type's plain id; a product of that type whose box or connectors sit differently gets a variant of its own.
      type = ctx.shared<PartTypeElement>(`part_type:${p.typeId}`, typeOf(p.typeId, "type"));
      if (typeof type !== "string" && !hasShape(type, centre, size, connectors)) type = ctx.shared<PartTypeElement>(`part_type:${p.typeId}:${boxKey}`, typeOf(p.typeId, `type-${shortHash(boxKey)}`));
    } else type = ctx.shared<PartTypeElement>(`part_type:${category}:${typeName}:${boxKey}`, typeOf(p.sourceId, "type"));
    if (typeof type === "string") return fail(type);
    if (seat.why) ctx.note(`${typeName}: ${seat.why}`);
    for (const note of portNotes(p.ports.length, ports)) ctx.note(`${typeName}: ${note}`);
    rememberPartPorts(ctx.joinedTo, p.sourceId, ports.byPort);
    const record: PartInstance = {
      ...base(ctx, p, level),
      kind: "part",
      typeId: type.id,
      levelId: level.id,
      position: roundPlan(seat.origin),
      offsetMm: round(seat.origin.z - level.elevationMm),
      rotationDeg: seat.rotationDeg,
      mark: (p.tag?.trim() || p.name?.trim() || "").slice(0, 40),
      values: ctx.values(p),
    };
    return { ok: true, records: [record] };
  },
};

/** A component from the product's plan box; the class says which category. */
const component: ImportRuleDef = {
  id: "kernel.component",
  label: "Components as plan boxes",
  forKinds: ["component"],
  convert(p, ctx) {
    const level = needLevel(ctx, p);
    if (typeof level === "string") return fail(level);
    const category = ctx.fields.category ?? ctx.options.category;
    if (typeof category !== "string") return fail(`${ctx.cls.label} doesn't say which kind of component it is`);
    const b = p.geometry.bounds;
    if (!b) return fail("its size couldn't be read");
    const record: Component = {
      ...base(ctx, p, level),
      kind: "component",
      category,
      typeName: typeNameOf(p, nameOf(p)),
      position: roundPlan({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }),
      size: { x: round(b.max.x - b.min.x), y: round(b.max.y - b.min.y) },
      rotationDeg: 0,
    };
    return { ok: true, records: [record] };
  },
};

export const KERNEL_IMPORT_RULES: readonly ImportRuleDef[] = [wall, slab, ceiling, room, column, beam, opening, runSegment, runFitting, part, component];

/** An element id for imported records: `imp.<source>.<GlobalId>[.<suffix>]`, GlobalId's `$` as `-` (outside its alphabet, so ids stay distinct). */
export function importElementId(sourceKey: string, sourceId: string, suffix?: string): ElementId {
  return asElementId(`imp.${sourceKey}.${sourceId.replace(/\$/g, "-")}${suffix ? `.${suffix}` : ""}`);
}
