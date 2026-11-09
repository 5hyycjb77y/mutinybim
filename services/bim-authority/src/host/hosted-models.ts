import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { toJson, type Sql } from "../pg-store";
import type { ModelProjectResolver, ModelProvisioner } from "./contract";

/** Creates the empty model for a host project (bim.provision_hosted_model; races settle on bim.models' primary key). */
export function hostedModelProvisioner(sql: Sql): ModelProvisioner {
  return {
    async provision({ modelId, hostProjectId, projectNumber }) {
      const [row] = await sql<{ host_project_id: string | null }[]>`
        select bim.provision_hosted_model(${modelId}, ${hostProjectId}::uuid, ${projectNumber}, ${sql.json(toJson(DEFAULT_SETTINGS))}::jsonb)::text as host_project_id`;
      return row?.host_project_id ?? null;
    },
  };
}

/** Which host project a model on this server belongs to (bim.models.host_project_id). */
export function hostProjectResolver(sql: Sql): ModelProjectResolver {
  return {
    async hostProjectOf(modelId) {
      const [row] = await sql<{ host_project_id: string | null }[]>`
        select host_project_id::text as host_project_id from bim.models where id = ${modelId}`;
      return row?.host_project_id ?? null;
    },
  };
}
