import { asElementId } from "../types";
import { GLOBAL_PARTITION } from "../partition";
import type { Beam, Column, Component, ElementId, Level, MepSystem, Opening, PartInstance, PartTypeElement, Room, RunDomain, RunSegment, RunSize, Slab, Wall } from "../types";
import { RUN_DOMAINS } from "../routing/types";
import { connectorDomainOf, sizeFitsDomain } from "../routing/rules";
import { activeServiceRegistry } from "../services/registry";
import { PART_CATEGORIES, type PartCategory, type PartTypeDefinition } from "../parts";
import type { ImportRuleContext, ImportRuleDef } from "./rule-point";
import { axisAligned, outlineArea, outlineCentre, rectangleAxis, roundPlan, straightSweep, verticalPrism } from "./shape";
import type { ImportProduct, ImportRuleResult } from "./types";

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
const round = (n: number): number => Math.round(n * 10) / 10;

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

/**
 * A placed part from the product's box, of a part type made once per type in
 * the file. Its connectors aren't read from the file this round: the report
 * says so, and the part joins nothing until someone joins it.
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
    const size = { x: round(b.max.x - b.min.x), y: round(b.max.y - b.min.y), z: round(b.max.z - b.min.z) };
    if (size.x < 1 || size.y < 1 || size.z < 1) return fail("it has no size");
    const typeName = typeNameOf(p, nameOf(p));
    const typeKey = p.typeId ?? `${category}:${typeName}:${size.x}x${size.y}x${size.z}`;
    const type = ctx.shared<PartTypeElement>(`part_type:${typeKey}`, () => {
      const definition: PartTypeDefinition = {
        familyName: typeName,
        typeName,
        category,
        typeParams: [],
        typeValues: {},
        instanceParams: [],
        connectors: [],
        geometry: [{ kind: "box", center: [0, 0, size.z / 2], size: [size.x, size.y, size.z] }],
        symbol: [{ kind: "rect", center: [0, 0], size: [size.x, size.y] }],
        tagFields: ["mark"],
        source: { kind: "ifc", entity: p.entity, typeName, boundingBoxGeometry: true },
      };
      return { id: ctx.idFor(p.typeId ?? `${p.sourceId}`, "type"), kind: "part_type", version: 0, authoredRev: {}, definition };
    });
    if (typeof type === "string") return fail(type);
    if (p.ports.length > 0) ctx.note(`${typeName}: its ${p.ports.length === 1 ? "connection point wasn't" : `${p.ports.length} connection points weren't`} brought in; join it by hand`);
    const record: PartInstance = {
      ...base(ctx, p, level),
      kind: "part",
      typeId: type.id,
      levelId: level.id,
      position: roundPlan({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }),
      offsetMm: round(b.min.z - level.elevationMm),
      rotationDeg: 0,
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

export const KERNEL_IMPORT_RULES: readonly ImportRuleDef[] = [wall, slab, room, column, beam, opening, runSegment, part, component];

/** An element id for imported records: `imp.<source>.<GlobalId>[.<suffix>]`, GlobalId's `$` as `-` (outside its alphabet, so ids stay distinct). */
export function importElementId(sourceKey: string, sourceId: string, suffix?: string): ElementId {
  return asElementId(`imp.${sourceKey}.${sourceId.replace(/\$/g, "-")}${suffix ? `.${suffix}` : ""}`);
}
