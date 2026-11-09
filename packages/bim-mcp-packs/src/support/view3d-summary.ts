import { viewCamera3d, viewCropBox3d, type ModelState, type ViewElement } from "@permitzip/bim-kernel";

const FT = 304.8;
const round = (v: number) => Math.round(v * 100) / 100;
const ft3 = (q: { x: number; y: number; z: number }) => ({ x: round(q.x / FT), y: round(q.y / FT), z: round(q.z / FT) });

/** A 3D view's camera and box in feet, as the read tools report them. */
export function view3dSummary(model: ModelState, view: ViewElement) {
  const box = viewCropBox3d(model, view);
  const camera = viewCamera3d(model, view);
  return {
    projection: view.props?.projection ?? "perspective",
    crop_on: view.props?.cropView !== false,
    show_crop_box: view.props?.showCropBox !== false,
    crop_box_ft: box ? { center: ft3(box.center), size: ft3({ x: box.halfSize.x * 2, y: box.halfSize.y * 2, z: box.halfSize.z * 2 }), turn_deg: round(box.rotationDeg) } : null,
    camera_ft: camera ? { eye: ft3(camera.eye), target: ft3(camera.target) } : null,
    ...(view.props?.workingFor ? { working_view_of: view.props.workingFor } : {}),
    prints: "Vector hidden-line from this camera (orthographic from the same direction when the view is perspective), cropped to the whole 3D box. Linked models do not print in 3D views.",
  };
}
