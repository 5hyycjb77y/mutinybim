import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { Vec3 } from "../parts";
import type { HostedOn } from "../routing/types";
import type { BimElement, ElementId } from "../types";
import { KERNEL_CONNECTOR_FACE_ROWS } from "./run-faces";

/**
 * Connector faces (contract 1.11.0, `kernel.connector_face` v1; feature
 * `routing:tap_faces`).
 *
 * Any connector-bearing shape (a run of any section, a fitting body, a piece
 * of equipment, a tray) lists its faces from its own geometry. A tap or
 * connection sits on one face at `s` along it and `t` across it, so a tap on
 * the top or bottom of a run is the same placement as one on its side. A
 * stored tap with `side: 1 | -1` reads as the two side faces; nothing stored
 * changes until a person places a tap on another face for a peer that reads
 * `routing:tap_faces`.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const ROUTING_TAP_FACES_FEATURE = "routing:tap_faces";

/**
 * Contract 1.12.0: a hosted connection may sit off the face's centre line
 * (`HostedOn.t`, across the face). Advertised by lane M14 once readers keep
 * it; a peer without it is never sent an off-centre tap.
 */
export const ROUTING_TAP_OFFSET_FEATURE = "routing:tap_offset";

/** The ids old left / right taps read as. */
export const SIDE_FACE_IDS = { left: "side_left", right: "side_right" } as const;

/** One face of a shape (model mm; the normal points out). */
export interface ConnectorFaceDef {
  /** Stable for the shape (`top`, `bottom`, `side_left`, `side_right`, `end_start`, a part's own face name). */
  readonly id: string;
  readonly label: string;
  readonly center: Vec3;
  readonly normal: Vec3;
  /** Direction `s` runs along the face. */
  readonly alongDir: Vec3;
  /** mm the face runs along (`s` from 0 to this) and across (`t` from -across / 2 to across / 2). */
  readonly alongMm: number;
  readonly acrossMm: number;
}

/** Where a tap sits: a face of its host, `s` mm along and `t` mm across from its centre line. */
export interface TapPlacement {
  readonly hostId: ElementId;
  readonly face: string;
  readonly s: number;
  readonly t: number;
}

export interface ConnectorFaceRow {
  /** The stored kind whose records it reads (`run_segment`, `part`, `zz.tray`). One row per kind. */
  readonly kind: string;
  readonly label: string;
  /** The faces of one record, or empty when it has none a connection can sit on. */
  faces(el: BimElement, elements: Elements): readonly ConnectorFaceDef[];
}

export const CONNECTOR_FACE_POINT = defineExtensionPoint<ConnectorFaceRow>({
  id: "kernel.connector_face",
  version: 1,
  label: "Connector faces",
  idOf: (row) => row.kind,
  builtins: () => KERNEL_CONNECTOR_FACE_ROWS,
});

/** Problems with connector face rows (pack conformance), in words. */
export function connectorFaceRowProblems(rows: readonly ConnectorFaceRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.kind)) out.push(`connector face ${row.kind} is declared twice`);
    seen.add(row.kind);
    if (row.label.trim().length === 0) out.push(`connector face ${row.kind} has no label`);
    if (typeof row.faces !== "function") out.push(`connector face ${row.kind}: faces must be a function`);
  }
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, ConnectorFaceRow> => new Map(set.items(CONNECTOR_FACE_POINT).map((r) => [r.kind, r] as const));

/** The faces of one record in the set in force; empty when its kind has no row. */
export function connectorFacesOf(el: BimElement, elements: Elements): readonly ConnectorFaceDef[] {
  return activePackSet().memo("kernel.connector_face#table", tableOf).get(el.kind)?.faces(el, elements) ?? [];
}

/** The face id an old `side: 1 | -1` tap reads as. */
export function faceOfSide(side: 1 | -1): string {
  return side === 1 ? SIDE_FACE_IDS.left : SIDE_FACE_IDS.right;
}

/** The face a hosted branch leaves through: its stored `face`, else the side its `side` names. */
export function hostedFaceOf(host: Pick<HostedOn, "side" | "face">): string {
  return host.face ?? faceOfSide(host.side);
}

/** Where a placement sits (model mm): on its host's face in the set in force. Null when the host, its face or the point is missing. */
export function placementPoint(placement: TapPlacement, elements: Elements): Vec3 | null {
  const host = elements[placement.hostId];
  const face = host ? connectorFacesOf(host, elements).find((f) => f.id === placement.face) : undefined;
  return face ? pointOnFace(face, placement.s, placement.t) : null;
}

/** A point on a face at `s` along and `t` across (model mm). Null when `s` or `t` falls off the face. */
export function pointOnFace(face: ConnectorFaceDef, s: number, t: number): Vec3 | null {
  if (!Number.isFinite(s) || !Number.isFinite(t) || s < 0 || s > face.alongMm || Math.abs(t) > face.acrossMm / 2) return null;
  const [ax, ay, az] = face.alongDir;
  const [nx, ny, nz] = face.normal;
  // across = normal × along
  const cx = ny * az - nz * ay;
  const cy = nz * ax - nx * az;
  const cz = nx * ay - ny * ax;
  const [ox, oy, oz] = face.center;
  const ds = s - face.alongMm / 2;
  return [ox + ax * ds + cx * t, oy + ay * ds + cy * t, oz + az * ds + cz * t];
}
