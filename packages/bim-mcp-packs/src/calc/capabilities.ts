import type { ProjectCodeAdoption, ProjectElectricalAdoption } from "@permitzip/bim-calc";
import type { Extra } from "../runtime";

/**
 * The host services the calc tools need beyond the caller: which code
 * editions the project has adopted (electrical, plumbing, fuel gas), as the
 * calling person may read them. A host without a record of adopted codes
 * answers null, and a run then asks for the edition or the state.
 */

/** The project's adopted electrical code (its NEC edition), or null when it names none. */
export type ProjectAdoptionLookup = (extra: Extra, projectId: string) => Promise<ProjectElectricalAdoption | null>;

/** The project's adopted fuel gas code, or null when it names none. */
export type ProjectFuelGasLookup = (extra: Extra, projectId: string) => Promise<ProjectCodeAdoption | null>;

/** The project's adopted plumbing code, or null when it names none. */
export type ProjectPlumbingLookup = (extra: Extra, projectId: string) => Promise<ProjectCodeAdoption | null>;

/** Every adopted-code lookup the calc tools take, one per trade. */
export interface ProjectCodeAdoptions {
  readonly projectAdoption: ProjectAdoptionLookup;
  readonly fuelGas: ProjectFuelGasLookup;
  readonly plumbing: ProjectPlumbingLookup;
}

/**
 * Where a pack-declared tool's permission is recorded on a host with a
 * per-tool permission map (read: the model read permission, write: the model
 * edit permission). A host whose callers carry their own permission check
 * needs none.
 */
export type PackToolPermissionSink = (toolName: string, permission: "read" | "write") => void;
