import { z } from "zod";

/**
 * The where-arguments of the core tools. A host with projects (each model
 * lives in a project named by a uuid) uses `PROJECT_SCHEMAS`; one person's
 * local server has one workspace and uses `LOCAL_SCHEMAS`, where project_id
 * may be left out. The words are short: they are re-sent on every agent step.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project id as a host parses it (it may fill one in when the agent leaves it out). */
export type ProjectIdSchema = z.ZodType<string, string | undefined>;

export interface CoreSchemas {
  /** The read tools' target. */
  readonly reads: { readonly project_id: ProjectIdSchema; readonly model_id: z.ZodString };
  /** The script tools' project. */
  readonly scripts: { readonly project_id: ProjectIdSchema };
}

const MODEL_ID = z.string().min(1).max(200);

/** The target every tool of a host with projects carries. */
export const PROJECT_TARGET = {
  // A refine, not .uuid(): the uuid regex is ~40 schema tokens on every MutinyBIM tool a turn loads.
  project_id: z.string().refine((v) => UUID.test(v), "project_id must be a project uuid").describe("Project id (uuid)."),
  model_id: MODEL_ID.describe("Model id in that project."),
};

export const PROJECT_SCHEMAS: CoreSchemas = {
  reads: PROJECT_TARGET,
  scripts: { project_id: z.string().uuid() },
};

/** The one workspace a local server has. */
export const LOCAL_PROJECT_ID = "local";

const localProject = z.string().min(1).max(200).default(LOCAL_PROJECT_ID).describe("Workspace (this server has one: local).");

export const LOCAL_SCHEMAS: CoreSchemas = {
  reads: { project_id: localProject, model_id: MODEL_ID.describe("Model id.") },
  scripts: { project_id: localProject },
};

export const area = {
  level: z.string().min(1).max(40).optional().describe("Load only this level (name or id)."),
  zone: z.string().min(1).max(40).optional().describe("Load only this zone of it."),
};

export const BASE_REVISION = {
  base_revision: z.number().int().min(0).optional().describe("The revision you read; a newer overlapping change answers conflict."),
};

/**
 * The same arguments with the words the trade tools (one-line, pipe sizing
 * and the rest of the trade packs) were frozen with on Oct 30: those tools
 * keep them byte for byte.
 */
export const TRADE_TARGET = {
  project_id: z.string().refine((v) => UUID.test(v), "project_id must be a project uuid").describe("PermitZIP project id (uuid) the model belongs to."),
  model_id: z.string().min(1).max(200).describe("MutinyBIM model id within that project."),
};

export const TRADE_BASE_REVISION = {
  base_revision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("The model revision you read before planning this edit. If someone changed the same thing since, you get a conflict to re-plan from."),
};
