/**
 * Which project workspace files can be traced over in the Building Model, and
 * why the others can't. Pure, so the picker, the routes and the tests agree.
 *
 * Source units (what an underlay's calibration maps to model millimetres):
 * - PDF: page points (1/72"), origin at the rendered page's bottom-left, y up,
 *   with the page's own rotation applied (what a person sees).
 * - Image: pixels, origin at the bottom-left, y up.
 */

export type UnderlayFormat = "pdf" | "image" | "dxf" | "dwg";

export interface UnderlayFileKind {
  readonly format: UnderlayFormat | null;
  /** Null when it can be traced over now. */
  readonly unsupportedReason: string | null;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export const CAD_CONVERT_MESSAGE =
  "CAD files can't be placed yet. Print or export the sheet to PDF from the CAD program (vector, not scanned) and add that PDF: its linework still snaps.";

export function underlayFileKind(name: string, mime: string | null): UnderlayFileKind {
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf" || /\.pdf$/i.test(name)) return { format: "pdf", unsupportedReason: null };
  if (IMAGE_MIMES.has(m) || IMAGE_EXT.test(name)) return { format: "image", unsupportedReason: null };
  if (/\.dxf$/i.test(name) || m === "image/vnd.dxf" || m === "application/dxf") return { format: "dxf", unsupportedReason: CAD_CONVERT_MESSAGE };
  if (/\.dwg$/i.test(name) || m === "image/vnd.dwg" || m === "application/acad") return { format: "dwg", unsupportedReason: CAD_CONVERT_MESSAGE };
  return { format: null, unsupportedReason: "Only PDFs, images (PNG, JPEG, WebP) and CAD files can be placed under a plan." };
}

/** One underlay candidate as the picker lists it. */
export interface UnderlayCandidate {
  readonly fileId: string;
  readonly name: string;
  readonly format: UnderlayFormat;
  readonly sizeBytes: number | null;
  readonly updatedAt: string;
  readonly unsupportedReason: string | null;
}

/** A page ready for the canvas: its picture and its size in source units. */
export interface UnderlayPageInfo {
  readonly fileId: string;
  readonly name: string;
  readonly format: UnderlayFormat;
  readonly page: number;
  readonly pageCount: number;
  /** Source units (points or pixels). */
  readonly width: number;
  readonly height: number;
  /** Where the picture is served (the person's access is checked again there). */
  readonly imageUrl: string;
  /** PDF linework for snapping, in source units; null for images. */
  readonly lineworkUrl: string | null;
}

/** PDF linework segments in source units, y up: [x1, y1, x2, y2]. */
export type UnderlaySegment = readonly [number, number, number, number];

/** Normalized (0–1, top-left origin) page point to source units (points, bottom-left origin, y up). */
export function normalizedToSource(p: { readonly x: number; readonly y: number }, width: number, height: number): { x: number; y: number } {
  return { x: p.x * width, y: (1 - p.y) * height };
}

export function underlayRoutes(projectId: string, fileId: string, page: number): { readonly info: string; readonly image: string; readonly linework: string } {
  const base = `/api/projects/${encodeURIComponent(projectId)}/building-model/underlays/${encodeURIComponent(fileId)}`;
  return { info: `${base}?page=${page}`, image: `${base}/image?page=${page}`, linework: `${base}/linework?page=${page}` };
}
