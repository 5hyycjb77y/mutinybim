import { z } from "zod";
import { fittingFamilies, PIPE_MATERIALS } from "@permitzip/bim-kernel";

/**
 * A person's Route tool defaults: what the Route panel starts with, for every
 * project or for one project. Saved in `public.bim_route_defaults` (one row
 * per person, project or none, and domain); the project row wins. The Route
 * panel ("Save as my default"), the API route and the agent's
 * bim_get_route_defaults / bim_set_route_defaults all go through this schema.
 * Client-safe: no server imports.
 */

export const ROUTE_DEFAULT_DOMAINS = ["duct", "pipe"] as const;
export type RouteDefaultDomain = (typeof ROUTE_DEFAULT_DOMAINS)[number];

const inches = z.number().finite().positive().max(400);

export const routeDefaultsSchema = z
  .object({
    /** Duct: rectangular or round, and its size in inches. */
    shape: z.enum(["rect", "round"]).optional(),
    widthIn: inches.optional(),
    heightIn: inches.optional(),
    diameterIn: inches.optional(),
    /** Duct: follow the system's insulation, bare duct, an external wrap or an internal liner. */
    insulation: z.enum(["default", "none", "wrap", "liner"]).optional(),
    insulationIn: z.number().finite().positive().max(12).optional(),
    linerSurface: z.enum(["faced", "spray_coated"]).optional(),
    /** Duct: elbow and takeoff families (fitting library ids); absent: the system's default. */
    elbowFamily: z.string().min(1).max(80).optional(),
    takeoffFamily: z.string().min(1).max(80).optional(),
    /** Pipe: nominal size and material. */
    nominalIn: inches.optional(),
    material: z.enum(PIPE_MATERIALS).optional(),
    riseStyle: z.enum(["vertical", "45", "60", "22.5"]).optional(),
  })
  .strict();
export type RouteDefaults = z.infer<typeof routeDefaultsSchema>;

/** Why a set of defaults can't be saved for `domain`, in the operator's words, or null. */
export function routeDefaultsIssue(domain: RouteDefaultDomain, d: RouteDefaults): string | null {
  if (domain === "pipe") {
    const ductOnly = (["shape", "widthIn", "heightIn", "diameterIn", "insulation", "insulationIn", "linerSurface", "elbowFamily", "takeoffFamily"] as const).find((k) => d[k] !== undefined);
    if (ductOnly) return `${ductOnly} is a duct default; pipe defaults are its size, material and how it rises`;
    return null;
  }
  if (d.nominalIn !== undefined || d.material !== undefined) return "Pipe size and material are pipe defaults; save them for pipe";
  const shape = d.shape ?? "rect";
  const family = (id: string | undefined, what: "elbow" | "takeoff"): string | null => {
    if (!id) return null;
    const f = fittingFamilies().find((x) => x.id === id);
    if (!f || f.domain !== "duct") return `${id} isn't a duct fitting in the library`;
    const fits = what === "elbow" ? f.fittingTypes.includes("elbow") : f.fittingTypes.some((t) => t === "tap" || t === "tee" || t === "wye");
    if (!fits) return `${f.name} isn't ${what === "elbow" ? "an elbow" : "a branch takeoff"}`;
    if (!f.shapes.includes(shape)) return `${f.name} isn't made in ${shape === "rect" ? "rectangular" : "round"} duct`;
    return null;
  };
  return family(d.elbowFamily, "elbow") ?? family(d.takeoffFamily, "takeoff");
}

/** A person's Route defaults for one domain on one project, as the route answers and the editor reads them. */
export interface RouteDefaultsRead {
  readonly domain: RouteDefaultDomain;
  /** Saved for every project. */
  readonly allProjects: RouteDefaults | null;
  /** Saved for this project; wins over allProjects. */
  readonly thisProject: RouteDefaults | null;
  readonly effective: RouteDefaults | null;
}

/** The defaults that apply: this project's row over the all-projects row, field by field. */
export function effectiveRouteDefaults(all: RouteDefaults | null, project: RouteDefaults | null): RouteDefaults | null {
  if (!all && !project) return null;
  return { ...(all ?? {}), ...(project ?? {}) };
}

/** Parse a stored row's settings; a row that no longer fits the schema reads as none, and the reason is logged. */
export function parseStoredRouteDefaults(raw: unknown, where: string): RouteDefaults | null {
  const parsed = routeDefaultsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.error("[route-defaults] a saved row doesn't fit the schema; ignoring it", { where, issues: parsed.error.issues });
  return null;
}
