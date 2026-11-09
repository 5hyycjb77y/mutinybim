/** Pixels along each canvas edge covered by panels drawn over the canvas (the properties panel). */
export interface FrameInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const NO_INSETS: FrameInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/** A plan rectangle in scene metres (x east, z south). */
export interface PlanBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Margin around a framed plan rectangle (a share of its size, plus pixels for the crop box grips to be grabbed). */
const MARGIN = 1.04;
const GRIP_PAD_PX = 16;

/**
 * Frame a plan rectangle in the part of the canvas nobody covers: the
 * top-down camera's centre (scene x, z) and the orthographic half-height
 * (metres) at zoom 1. `upDeg` is the plan's screen-up turn (true north).
 * Without insets this is the plain fit; with the properties panel open over
 * the right side, the rectangle shrinks and slides left so all four sides
 * and their grips stay reachable.
 */
export function planFit(box: PlanBox, upDeg: number, canvas: { readonly width: number; readonly height: number }, insets: FrameInsets = NO_INSETS): { center: { x: number; z: number }; half: number } {
  const a = (upDeg * Math.PI) / 180;
  const up = { x: Math.sin(a), z: -Math.cos(a) };
  const right = { x: -up.z, z: up.x };
  const corners = [
    { x: box.minX, z: box.minZ },
    { x: box.maxX, z: box.minZ },
    { x: box.minX, z: box.maxZ },
    { x: box.maxX, z: box.maxZ },
  ];
  const along = (d: { x: number; z: number }) => corners.map((c) => c.x * d.x + c.z * d.z);
  const rs = along(right);
  const us = along(up);
  const w = Math.max(...rs) - Math.min(...rs);
  const h = Math.max(...us) - Math.min(...us);
  const midR = (Math.max(...rs) + Math.min(...rs)) / 2;
  const midU = (Math.max(...us) + Math.min(...us)) / 2;
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const visW = Math.max(1, width - insets.left - insets.right - 2 * GRIP_PAD_PX);
  const visH = Math.max(1, height - insets.top - insets.bottom - 2 * GRIP_PAD_PX);
  const perPixel = Math.max(w / visW, h / visH, 1e-6) * MARGIN;
  // The uncovered area's centre, in pixels right of and below the canvas centre.
  const ox = (insets.left - insets.right) / 2;
  const oy = (insets.top - insets.bottom) / 2;
  const camR = midR - ox * perPixel;
  const camU = midU + oy * perPixel;
  return { center: { x: right.x * camR + up.x * camU, z: right.z * camR + up.z * camU }, half: (perPixel * height) / 2 };
}
