import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * The core tools' MCP annotations. The families' come from
 * `@permitzip/bim-mcp-packs/support/tool-annotations`; its test holds the
 * core to the same tool-name lists.
 */
export const READ_ONLY_TOOL: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const CHANGING_TOOL: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
