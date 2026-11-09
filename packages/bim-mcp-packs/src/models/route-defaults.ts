import type { RouteDefaults } from "@permitzip/bim-editor/contracts/building-model/route-defaults";

/**
 * bim_route_run's `use_my_defaults`: the person's own saved Route defaults
 * (the Route panel's "Save as my default", read through the host's
 * `RouteDefaultsStore`) fill in whatever the agent didn't say: size and
 * shape, insulation, elbow and takeoff types, how rises are made. What the
 * agent gives always wins.
 */

/** The route arguments the defaults can fill (a subset of bim_route_run's). */
export interface RouteDefaultableArgs {
  readonly kind: "duct" | "pipe";
  readonly width_in?: number;
  readonly height_in?: number;
  readonly oval?: boolean;
  readonly diameter_in?: number;
  readonly nominal_in?: number;
  readonly material?: RouteDefaults["material"];
  readonly airflow_cfm?: number;
  readonly duct_shape?: "rect" | "round";
  readonly insulation?: { readonly kind: "none" | "wrap" | "liner"; readonly thickness_in?: number; readonly surface?: "faced" | "spray_coated" };
  readonly elbow_family?: string;
  readonly takeoff_family?: string;
  readonly rise_style?: "vertical" | "45";
}

export function withRouteDefaults<A extends RouteDefaultableArgs>(a: A, d: RouteDefaults | null): A {
  if (!d) return a;
  const sized = a.width_in !== undefined || a.diameter_in !== undefined || a.nominal_in !== undefined;
  // The agent's route tool rises straight or at 45°; a saved 60° or 22½° slope (the Route panel's) is left to the panel.
  const savedRise = d.riseStyle === "vertical" || d.riseStyle === "45" ? d.riseStyle : undefined;
  let next: A = { ...a, ...(a.rise_style === undefined && savedRise ? { rise_style: savedRise } : {}) };
  if (a.kind === "pipe") {
    if (!sized && d.nominalIn !== undefined && d.material) next = { ...next, nominal_in: d.nominalIn, material: d.material };
    return next;
  }
  const shape = a.diameter_in !== undefined ? "round" : a.width_in !== undefined ? "rect" : (a.duct_shape ?? d.shape ?? "rect");
  if (!sized && a.airflow_cfm === undefined) {
    if (shape === "round" && d.diameterIn !== undefined) next = { ...next, diameter_in: d.diameterIn };
    if (shape === "rect" && d.widthIn !== undefined && d.heightIn !== undefined) next = { ...next, width_in: d.widthIn, height_in: d.heightIn };
  }
  if (a.airflow_cfm !== undefined && a.duct_shape === undefined && d.shape) next = { ...next, duct_shape: d.shape };
  if (a.insulation === undefined && d.insulation && d.insulation !== "default") {
    next = d.insulation === "none" ? { ...next, insulation: { kind: "none" } } : { ...next, insulation: { kind: d.insulation, ...(d.insulationIn !== undefined ? { thickness_in: d.insulationIn } : {}), ...(d.insulation === "liner" && d.linerSurface ? { surface: d.linerSurface } : {}) } };
  }
  // A saved elbow or takeoff is for the saved shape; on another shape the system's default applies.
  if (shape === (d.shape ?? "rect")) {
    if (a.elbow_family === undefined && d.elbowFamily) next = { ...next, elbow_family: d.elbowFamily };
    if (a.takeoff_family === undefined && d.takeoffFamily) next = { ...next, takeoff_family: d.takeoffFamily };
  }
  return next;
}
