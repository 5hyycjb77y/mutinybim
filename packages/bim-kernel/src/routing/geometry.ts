import { partToWorld, resolveConnectors, type ResolvedConnector } from "../parts";
import { mountPoint } from "../part-mount";
import type { BimElement, ElementId, PartInstance, PartTypeElement } from "../types";
import type { PortRef, RunFitting, RunPoint, RunPort, RunSegment, RunSize } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

export const p3 = (x: number, y: number, z: number): RunPoint => ({ x, y, z });
export const add3 = (a: RunPoint, b: RunPoint): RunPoint => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: RunPoint, b: RunPoint): RunPoint => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: RunPoint, k: number): RunPoint => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot3 = (a: RunPoint, b: RunPoint): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: RunPoint): number => Math.hypot(a.x, a.y, a.z);
export const dist3 = (a: RunPoint, b: RunPoint): number => len3(sub3(a, b));

export function unit3(a: RunPoint): RunPoint {
  const l = len3(a);
  return l === 0 ? p3(0, 0, 0) : scale3(a, 1 / l);
}

function r(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function round3(a: RunPoint): RunPoint {
  return { x: r(a.x), y: r(a.y), z: r(a.z) };
}

/** Rounded unit direction, so 45° legs compare equal however they were computed. */
export function dir3(a: RunPoint): RunPoint {
  const u = unit3(a);
  return { x: Math.round(u.x * 1e6) / 1e6, y: Math.round(u.y * 1e6) / 1e6, z: Math.round(u.z * 1e6) / 1e6 };
}

export function samePoint(a: RunPoint, b: RunPoint, tol: number): boolean {
  return dist3(a, b) <= tol;
}

/** Degrees between two directions. */
export function angleBetween(a: RunPoint, b: RunPoint): number {
  const c = Math.max(-1, Math.min(1, dot3(unit3(a), unit3(b))));
  return (Math.acos(c) * 180) / Math.PI;
}

export const isVertical = (d: RunPoint): boolean => Math.abs(d.x) < 1e-6 && Math.abs(d.y) < 1e-6 && Math.abs(d.z) > 0;

export function segmentAxis(seg: Pick<RunSegment, "start" | "end">): RunPoint {
  return unit3(sub3(seg.end, seg.start));
}

export function segmentLength3(seg: Pick<RunSegment, "start" | "end">): number {
  return dist3(seg.start, seg.end);
}

/** A part connector in model coordinates: plan from the part's insertion point and rotation, height above the level. */
export interface WorldConnector {
  readonly connector: ResolvedConnector;
  readonly position: RunPoint;
  readonly direction: RunPoint;
}

export function partConnector(part: PartInstance, type: PartTypeElement, connectorId: string): WorldConnector | null {
  const c = resolveConnectors(type.definition, part.values).find((x) => x.id === connectorId);
  if (!c) return null;
  return worldConnector(part, c);
}

/** `c` as the type draws it (resolveConnectors); the part's mount is applied here. */
export function worldConnector(part: PartInstance, c: ResolvedConnector): WorldConnector {
  const position = mountPoint(part.mount, c.position);
  const plan = partToWorld(part, { x: position[0], y: position[1] });
  const a = (part.rotationDeg * Math.PI) / 180;
  const [dx, dy, dz] = mountPoint(part.mount, c.direction);
  const d = dir3(p3(dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a), dz));
  return { connector: c, position: round3(p3(plan.x, plan.y, part.offsetMm + position[2])), direction: d };
}

/** Does a part connector take a run of this size? Rectangular connectors take either orientation. */
export function connectorAccepts(c: ResolvedConnector, size: RunSize): boolean {
  const close = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.5;
  switch (c.shape) {
    case "none":
      return true;
    case "rect":
      return (size.shape === "rect" || size.shape === "oval") && ((close(c.width, size.width) && close(c.height, size.height)) || (close(c.width, size.height) && close(c.height, size.width)));
    case "round":
      if (size.shape === "round") return close(c.diameter, size.diameter);
      if (size.shape === "pipe") return close(c.diameter, size.nominalMm);
      if (size.shape === "conduit") return close(c.diameter, size.tradeSizeMm);
      return false;
  }
}

/** The run size a connector itself has, for a run of `like`'s domain and material (null: no size of its own). */
export function connectorSize(c: ResolvedConnector, like: RunSize): RunSize | null {
  if (c.shape === "rect" && c.width !== undefined && c.height !== undefined) return { shape: "rect", width: c.width, height: c.height };
  if (c.shape === "round" && c.diameter !== undefined) {
    if (like.shape === "pipe") return { shape: "pipe", nominalMm: c.diameter, material: like.material };
    if (like.shape === "conduit") return { shape: "conduit", tradeSizeMm: c.diameter, conduitType: like.conduitType };
    return { shape: "round", diameter: c.diameter };
  }
  return null;
}

/** Where a port is and which way it faces, for any element that has ports. */
export interface PortInfo {
  readonly position: RunPoint;
  readonly direction: RunPoint;
  /** Null for a part connector with no size of its own. */
  readonly size: RunSize | null;
  readonly link: PortRef | undefined;
}

export function segmentPort(seg: RunSegment, port: string): PortInfo | null {
  if (port === "start") return { position: seg.start, direction: dir3(sub3(seg.start, seg.end)), size: seg.size, link: seg.links.start };
  if (port === "end") return { position: seg.end, direction: dir3(sub3(seg.end, seg.start)), size: seg.size, link: seg.links.end };
  return null;
}

export function fittingPort(f: RunFitting, port: string): RunPort | null {
  return f.ports.find((p) => p.id === port) ?? null;
}

export function portInfo(elements: Elements, ref: PortRef): PortInfo | null {
  const el = elements[ref.elementId];
  if (!el) return null;
  switch (el.kind) {
    case "run_segment":
      return segmentPort(el, ref.port);
    case "run_fitting": {
      const p = fittingPort(el, ref.port);
      return p ? { position: p.position, direction: p.direction, size: p.size, link: p.link } : null;
    }
    case "part": {
      const type = elements[el.typeId];
      if (!type || type.kind !== "part_type") return null;
      const w = partConnector(el, type, ref.port);
      if (!w) return null;
      return { position: w.position, direction: w.direction, size: null, link: el.links?.[ref.port] };
    }
    default:
      return null;
  }
}

/** Every linked port of an element: [own port, what it meets]. */
export function linksOf(el: BimElement): Array<[string, PortRef]> {
  switch (el.kind) {
    case "run_segment": {
      const out: Array<[string, PortRef]> = [];
      if (el.links.start) out.push(["start", el.links.start]);
      if (el.links.end) out.push(["end", el.links.end]);
      return out;
    }
    case "run_fitting":
      return el.ports.filter((p): p is RunPort & { link: PortRef } => p.link !== undefined).map((p) => [p.id, p.link]);
    case "part":
      return Object.entries(el.links ?? {});
    case "load_point":
      return el.joinedTo ? [["load", el.joinedTo]] : [];
    default:
      return [];
  }
}

/** Write (or clear) the link on one port, returning the new element; null when it has no such port. */
export function withLink(el: BimElement, port: string, link: PortRef | null): BimElement | null {
  switch (el.kind) {
    case "run_segment": {
      if (port !== "start" && port !== "end") return null;
      const links = { ...el.links };
      if (link) links[port] = link;
      else delete links[port];
      return { ...el, links };
    }
    case "run_fitting": {
      if (!el.ports.some((p) => p.id === port)) return null;
      return { ...el, ports: el.ports.map((p) => (p.id !== port ? p : link ? { ...p, link } : withoutLink(p))) };
    }
    case "part": {
      const links: Record<string, PortRef> = { ...(el.links ?? {}) };
      if (link) links[port] = link;
      else delete links[port];
      const { links: _old, ...rest } = el;
      return Object.keys(links).length > 0 ? { ...rest, links } : rest;
    }
    case "load_point": {
      // A load point has one joint: the part connector serving it end to end (join_parts).
      if (port !== "load") return null;
      const { joinedTo: _was, ...rest } = el;
      return link ? { ...rest, joinedTo: link } : rest;
    }
    default:
      return null;
  }
}

function withoutLink(p: RunPort): RunPort {
  const { link: _cut, ...rest } = p;
  return rest;
}

/** Elements whose position depends on another element: a branch fitting on its host. */
export function hostOf(el: BimElement): ElementId | null {
  return el.kind === "run_fitting" && el.host ? el.host.segmentId : null;
}

/**
 * Point on a host at `s` from its start, and where a branch on `side` leaves
 * its face. A vertical host (a stack or riser) has no left or right: `dir` is
 * the level direction the branch leaves in. On a level host `face` `top` or
 * `bottom` leaves straight up or down instead of to the side.
 */
export function hostedPoints(host: RunSegment, s: number, side: 1 | -1, dir?: { readonly x: number; readonly y: number }, face?: string, t = 0): { onAxis: RunPoint; branch: RunPoint; outward: RunPoint } {
  const axis = segmentAxis(host);
  const onAxis = round3(add3(host.start, scale3(axis, s)));
  const left = p3(-axis.y, axis.x, 0);
  const vertical = Math.hypot(axis.x, axis.y) < 1e-6;
  const upDown = !vertical && (face === "top" || face === "bottom") ? (face === "top" ? 1 : -1) : 0;
  if (upDown !== 0) {
    const outward = p3(0, 0, upDown);
    // Across the face = outward × along: left of travel on the top, right on the bottom.
    const at = t === 0 ? onAxis : round3(add3(onAxis, scale3(left, t * upDown)));
    return { onAxis: at, branch: round3(add3(at, scale3(outward, hostHalfHeight(host.size)))), outward };
  }
  const outward = vertical ? dir3(p3(dir?.x ?? 1, dir?.y ?? 0, 0)) : dir3(scale3(left, side));
  const at = t === 0 || vertical ? onAxis : round3(add3(onAxis, p3(0, 0, -side * t)));
  const half = hostHalfWidth(host.size);
  return { onAxis: at, branch: round3(add3(at, scale3(outward, half))), outward };
}

/** Half the drawn height of a level run (its top or bottom face from the centreline); a single-line run's is 0. */
export function hostHalfHeight(size: RunSize): number {
  switch (size.shape) {
    case "rect":
    case "oval":
      return size.height / 2;
    case "round":
      return size.diameter / 2;
    default:
      return 0;
  }
}

export function hostHalfWidth(size: RunSize): number {
  switch (size.shape) {
    case "rect":
    case "oval":
      return size.width / 2;
    case "round":
      return size.diameter / 2;
    // A pipe tee's branch starts on the pipe's centreline; drawings show pipe single-line.
    case "pipe":
    case "conduit":
      return 0;
  }
}
