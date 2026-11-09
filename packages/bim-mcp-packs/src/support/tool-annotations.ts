/**
 * MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`)
 * for every MutinyBIM tool, worked out from the tool-name lists the approval
 * policy already reads, so a client (and a host's permission map) learns
 * which tools change a model from the tool list itself.
 *
 * - Read-only: the tools in BIM_READ_TOOL_NAMES. Everything else changes
 *   something, confirm-gated tools included (their confirmed call saves).
 * - Destructive: the MCP default for a changing tool, except the tools in
 *   BIM_ADDITIVE_TOOL_NAMES, which only add.
 * - Open world: only the Autodesk Docs tools reach outside the model server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { BIM_CONFIRM_GATED_TOOL_NAMES, BIM_EDIT_TOOL_NAMES, BIM_READ_TOOL_NAMES } from "./tool-names";

/** Changing tools that only add elements, views, sheets or annotations: nothing existing is removed or overwritten. */
export const BIM_ADDITIVE_TOOL_NAMES = [
  "bim_place_part",
  "bim_copy_elements",
  "bim_add_dimension",
  "bim_add_tag",
  "bim_add_note",
  "bim_draw_detail",
  "bim_copy_detail_items",
  "bim_route_run",
  "bim_route_flex",
  "bim_place_pipe_accessory",
  "bim_create_circuit",
  "bim_add_to_circuit",
  "bim_place_service_layout",
  "bim_place_load_points",
  "bim_create_view",
  "bim_duplicate_view",
  "bim_create_sheet",
  "bim_place_viewport",
  "bim_add_sheet_note",
  "bim_create_3d_view",
  "bim_create_level",
  "bim_create_group",
  "bim_create_phase",
] as const;

/** Tools that reach a service outside the model server (Autodesk Docs). */
export const BIM_OPEN_WORLD_TOOL_NAMES = ["bim_browse_autodesk_docs", "bim_link_from_autodesk_docs", "bim_update_linked_model"] as const;

const READ: ReadonlySet<string> = new Set(BIM_READ_TOOL_NAMES);
const CHANGES: ReadonlySet<string> = new Set<string>([...BIM_EDIT_TOOL_NAMES, ...BIM_CONFIRM_GATED_TOOL_NAMES]);
const ADDITIVE: ReadonlySet<string> = new Set(BIM_ADDITIVE_TOOL_NAMES);
const OPEN_WORLD: ReadonlySet<string> = new Set(BIM_OPEN_WORLD_TOOL_NAMES);

/** A MutinyBIM tool's annotations, or null for a name the lists don't classify (an add-on's own tool). */
export function bimToolAnnotations(tool: string): ToolAnnotations | null {
  const openWorldHint = OPEN_WORLD.has(tool);
  if (READ.has(tool)) return { readOnlyHint: true, openWorldHint };
  if (CHANGES.has(tool)) return { readOnlyHint: false, destructiveHint: !ADDITIVE.has(tool), openWorldHint };
  return null;
}

type RegisterTool = (name: string, config: Record<string, unknown>, ...rest: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The server with every MutinyBIM tool it registers annotated. Annotations a
 * registration already gives win over the worked-out ones.
 */
export function withBimToolAnnotations(server: McpServer): McpServer {
  const register = server.registerTool.bind(server) as RegisterTool;
  const registerTool: RegisterTool = (name, config, ...rest) => {
    const derived = bimToolAnnotations(name);
    if (!derived) return register(name, config, ...rest);
    const own = isRecord(config.annotations) ? config.annotations : {};
    return register(name, { ...config, annotations: { ...derived, ...own } }, ...rest);
  };
  return new Proxy(server, {
    get: (target, prop) => {
      if (prop === "registerTool") return registerTool;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
