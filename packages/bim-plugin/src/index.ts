/**
 * `@permitzip/bim-plugin`: MutinyBIM as an Agent Plugins 1.0 package. The
 * pack catalogue is the only place agent tool pack membership lives; every
 * host (a host app, a standalone server) reads it.
 */
export {
  BIM_TOOL_PACKS,
  CORE_PACK_ID,
  CORE_PLUS_TWO_TOKEN_TARGET,
  PACK_LIST_TTL_MS,
  bimPack,
  bimPackCatalogue,
  bimPackEndpointPath,
  bimPackOfTool,
  catalogueProblems,
  type BimToolPack,
} from "./catalogue";
export {
  DEFAULT_BIM_BASE_URL,
  MCP_SCHEMA_ID,
  PLUGIN_NAME,
  PLUGIN_SCHEMA_ID,
  PLUGIN_VERSION,
  SKILL_DESCRIPTIONS,
  mcpJsonProblems,
  mcpServerKey,
  parseSkill,
  pluginJsonProblems,
  renderMcpJson,
  SKILL_TOOLS_BEGIN,
  SKILL_TOOLS_END,
  bimPluginSkills,
  renderPackageFiles,
  renderPluginJson,
  renderSkill,
  renderSkillFilesModule,
  renderSkillFrontmatter,
  renderSkillToolsBlock,
  skillGuidance,
  skillGuidanceProblems,
  skillProblems,
  syncSkill,
  type BimPluginSkill,
  type McpJson,
  type ParsedSkill,
  type PluginJson,
} from "./files";
