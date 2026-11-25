import { asElementId } from "../types";
import { GLOBAL_PARTITION } from "../partition";
import type { Beam, Column, Component, ElementId, Level, MepSystem, Opening, PartInstance, PartTypeElement, Room, RunDomain, RunSegment, RunSize, Slab, Vec2, Wall } from "../types";
import { checkCeilingHole, checkCeilingOutline, type HoleFault } from "../ceilings/outline";
import { CEILING_HEIGHT_MAX_MM, CEILING_HOLES_MAX, CEILING_OUTLINE_MAX_POINTS, type Ceiling } from "../ceilings/types";
import { RUN_DOMAINS } from "../routing/types";
import { connectorDomainOf, sizeFitsDomain } from "../routing/rules";
import { activeServiceRegistry } from "../services/registry";
import { PART_CATEGORIES, type PartCategory, type PartTypeDefinition } from "../parts";
import type { ImportRuleContext, ImportRuleDef } from "./rule-point";
import { axisAligned, holedPrism, outlineArea, outlineCentre, rectangleAxis, roundPlan, straightSweep, verticalPrism } from "./shape";
import { OUTLINE_WITH_HOLES, type ImportPoint, type ImportProduct, type ImportRuleResult } from "./types";

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

/** The system a run's file group becomes: the registered system kind whose IFC home and words match it. */
function systemFor(ctx: ImportRuleContext, p: ImportProduct, domain: RunDomain): MepSystem | string {
  const groupId = p.groupIds.find((id) => ctx.group(id) !== null);
  const group = groupId ? ctx.group(groupId) : null;
  if (!group || !groupId) return "the file doesn't put it in a system";
  return ctx.shared<MepSystem>(`system:${groupId}`, () => {
    const connector = connectorDomainOf(domain);
    const words = `${group.name ?? ""} ${group.objectType ?? ""}`.toLowerCase();
    let best: { id: string; score: number } | null = null;
    for (const row of activeServiceRegistry().rows) {
      if (!row.asSystem || row.connector !== connector) continue;
      let score = 0;
      if (group.predefinedType && row.ifc.predefinedType === group.predefinedType) score += 2;
      if (group.objectType && row.ifc.objectType && row.ifc.objectType.toLowerCase() === group.objectType.toLowerCase()) score += 2;
      if (row.label.toLowerCase().split(/\s+/).every((w) => words.includes(w))) score += 3;
      if (score > 0 && (!best || score > best.score)) best = { id: row.id, score };
    }
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

function isPartCategory(v: unknown): v is PartCategory {
  return typeof v === "string" && (PART_CATEGORIES as readonly string[]).includes(v);
}

interface PartSeat {
  /** The part's insertion point in the host frame, and its turn about the vertical. */
  readonly origin: ImportPoint;
  readonly rotationDeg: number;
  /** Its shape's box from that point, along the part's own axes. */
  readonly box: { readonly min: ImportPoint; readonly max: ImportPoint };
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
    return { origin, rotationDeg: 0, own: false, why, box: { min: { x: world.min.x - origin.x, y: world.min.y - origin.y, z: 0 }, max: { x: world.max.x - origin.x, y: world.max.y - origin.y, z: world.max.z - origin.z } } };
  };
  const own = p.placement;
  if (!own?.bounds) return boxed(null);
  if (own.zAxis.z < UPRIGHT_COS) return boxed("it is tilted in the file, so it came in upright, as the box around it");
  const { min, max } = own.bounds;
  if (min.x > SEAT_REACH_MM || max.x < -SEAT_REACH_MM || min.y > SEAT_REACH_MM || max.y < -SEAT_REACH_MM) return boxed("its insertion point is away from its shape in the file, so it sits at the middle of its box, not turned");
  const deg = Math.round(((Math.atan2(own.xAxis.y, own.xAxis.x) * 180) / Math.PI) * 1000) / 1000;
  return { origin: own.origin, rotationDeg: ((deg % 360) + 360) % 360, box: own.bounds, own: true, why: null };
}

/** Whether a part type made here is this box: the same centre and size from its own point. */
function hasBox(type: PartTypeElement, centre: ImportPoint, size: ImportPoint): boolean {
  const box = type.definition.geometry[0];
  if (box?.kind !== "box") return false;
  const want = [centre.x, centre.y, centre.z, size.x, size.y, size.z];
  return [...box.center, ...box.size].every((v, i) => v === want[i]);
}

/** A short, stable id part from a text (FNV-1a, base 36): the same box gives the same id on every import. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * A placed part at the product's own insertion point and turn, as the box of
 * its shape, of a part type made once per type in the file. Its connectors
 * aren't read from the file this round: the report says so, and the part
 * joins nothing until someone joins it.
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
    // A part type's box hangs off its own point, so products share one only while their boxes sit the same way from theirs.
    const boxKey = `${size.x}x${size.y}x${size.z}@${centre.x},${centre.y},${centre.z}`;
    const typeOf = (source: string, suffix: string) => (): PartTypeElement => {
      const definition: PartTypeDefinition = {
        familyName: typeName,
        typeName,
        category,
        typeParams: [],
        typeValues: {},
        instanceParams: [],
        connectors: [],
        geometry: [{ kind: "box", center: [centre.x, centre.y, centre.z], size: [size.x, size.y, size.z] }],
        symbol: [{ kind: "rect", center: [centre.x, centre.y], size: [size.x, size.y] }],
        tagFields: ["mark"],
        source: { kind: "ifc", entity: p.entity, typeName, boundingBoxGeometry: true },
      };
      return { id: ctx.idFor(source, suffix), kind: "part_type", version: 0, authoredRev: {}, definition };
    };
    let type: PartTypeElement | string;
    if (p.typeId) {
      // The first box met of a file type keeps the type's plain id; a product of that type whose box sits differently gets a variant of its own.
      type = ctx.shared<PartTypeElement>(`part_type:${p.typeId}`, typeOf(p.typeId, "type"));
      if (typeof type !== "string" && !hasBox(type, centre, size)) type = ctx.shared<PartTypeElement>(`part_type:${p.typeId}:${boxKey}`, typeOf(p.typeId, `type-${shortHash(boxKey)}`));
    } else type = ctx.shared<PartTypeElement>(`part_type:${category}:${typeName}:${boxKey}`, typeOf(p.sourceId, "type"));
    if (typeof type === "string") return fail(type);
    if (seat.why) ctx.note(`${typeName}: ${seat.why}`);
    if (p.ports.length > 0) ctx.note(`${typeName}: its ${p.ports.length === 1 ? "connection point wasn't" : `${p.ports.length} connection points weren't`} brought in; join it by hand`);
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

export const KERNEL_IMPORT_RULES: readonly ImportRuleDef[] = [wall, slab, ceiling, room, column, beam, opening, runSegment, part, component];

/** An element id for imported records: `imp.<source>.<GlobalId>[.<suffix>]`, GlobalId's `$` as `-` (outside its alphabet, so ids stay distinct). */
export function importElementId(sourceKey: string, sourceId: string, suffix?: string): ElementId {
  return asElementId(`imp.${sourceKey}.${sourceId.replace(/\$/g, "-")}${suffix ? `.${suffix}` : ""}`);
}
