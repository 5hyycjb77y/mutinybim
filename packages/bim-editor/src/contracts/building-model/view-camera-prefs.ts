import { z } from "zod";

/**
 * Where each person last left each 3D view (and the model's own 3D), per
 * project: `public.bim_view_camera_prefs`, never browser storage. The camera
 * is the viewer's, as a saved 3D view stores it (kernel mm). Client-safe: the
 * table's rows are read and written in `view-camera-rows`.
 */

/** The model's own 3D, when no 3D view is open. */
export const FREE_3D_KEY = "free-3d";

const point = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });

export const viewCameraSchema = z.object({
  eye: point,
  target: point,
  up: point,
  fovDeg: z.number().finite().min(1).max(179),
  orthoHeightMm: z.number().finite().positive().max(10_000_000),
});

export const viewKeySchema = z.string().trim().min(1).max(200);
