/**
 * The Agent Plugins 1.0 package files, rendered from the catalogue: root
 * `plugin.json`, root `mcp.json` (one server: the core, families opt-in) and
 * `skills/<pack>/SKILL.md` (one Agent Skill per pack, same name). The files
 * in this package are these renderings; a test fails when they drift.
 *
 * Validation follows the specifications' text (agent-plugins.org §5–§8,
 * agentskills.io/specification) because neither schema may be fetched at
 * load time and no validator is installed here.
 */
import { BIM_TOOL_PACKS, CORE_PACK_ID, bimPackEndpointPath, bimPackOfTool, type BimToolPack } from "./catalogue";
import { SKILL_FILES } from "./skill-files";

export const PLUGIN_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const PLUGIN_NAME = "mutinybim";
export const PLUGIN_VERSION = "1.0.0";
/**
 * The free hosted MutinyBIM app (`apps/mutinybim-web`, its
 * `MUTINYBIM_WEB_ORIGIN`): the address every outside user's plugin connects
 * to. Its tool server answers at `/mcp` (the core; `bim_enable_pack` turns a
 * family on) and at `/packs/<slug>/mcp` (the core plus that family), over
 * Streamable HTTP, and asks the person to sign in through MCP authorization
 * (OAuth), so no key is in this package. A self-hosted server renders
 * `mcp.json` with its own base.
 */
export const DEFAULT_BIM_BASE_URL = "https://app.mutinybim.com";
/** The public source repository. */
export const PLUGIN_REPOSITORY = "https://github.com/permitzip/mutinybim";
export const PLUGIN_HOMEPAGE = `${PLUGIN_REPOSITORY}/tree/main/packages/bim-plugin`;

/** What each pack's skill says it is for, and the words that should make an agent reach for it (≤ 1,024 characters). */
export const SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  core:
    "MutinyBIM core: read and change a MutinyBIM building model by writing scripts with the open-source kit. The kit's reference (organised by task, each with a worked example), checking a script, a preview run that saves nothing, landing the result after the person approves, saving a part script's parts; and four reads (model summary, element queries, networks, validation issues) to look before writing. Every change pauses for the person's approval and is decided by the model server. Activate it first; it names the opt-in tool family for each job that has no script yet (model, drafting, ducts and pipes, electrical, plumbing, views and sheets, coordination, groups and phases, parts, calculations, schedules). Trigger on: building model, MutinyBIM, BIM model, script, place a part, route a duct, what's in the model, validation issues, make sheets.",
  model:
    "MutinyBIM family for model reads and everyday edits: schedule rows, part types, levels, views and sheets, linked models, surfaces at a point; previews of part, route and views/sheets edits; placing, moving, rotating, copying and deleting parts, parameters, moving walls; pictures of views and sheets; printing and issuing a set; coordination lint and status snapshots. Use with the mutinybim core. Trigger on: list levels, list views, list sheets, schedule rows, preview an edit, place a part, move equipment, delete elements, render a view, print the set, issue the set, lint.",
  drafting:
    "MutinyBIM pack for drafting and annotation: dimensions and automatic dimension strings, tags, tag styles and automatic tagging, notes with leaders, editing annotations, detail linework, hatched and masking regions, detail components, batt insulation and the modify tools (trim, extend, split, fillet, offset, mirror, array) on drawn items. Use with the mutinybim core. Trigger on: dimension, tag, annotate, leader, note, detail, hatch, detail component, linework, trim, fillet, offset, mirror, array, drafting view.",
  ducts_pipes:
    "MutinyBIM pack for duct and pipe runs: route and connect runs, flex, resize runs and stretches, slide branches, terminal airflow, move equipment, risers, fittings and offsets, elevation changes, splitting and dragging runs, system design, duct insulation, drain slope and inline pipe accessories. Duct size advice and the pressure and pipe reports are in the calculations pack. Use with the mutinybim core. Trigger on: route duct, route pipe, connect, resize, fitting, offset, elevation, slope, insulation, system design.",
  electrical:
    "MutinyBIM pack for electrical design: panels and their schedules, circuits and feeders, rebalancing, connection and feeder types, room circuit templates, receptacle proposals by code spacing, service layout, and live one-line, electrical riser and plumbing riser diagrams. Use with the mutinybim core. Trigger on: panel, circuit, feeder, breaker, load, receptacle, service size, one-line diagram, riser diagram, plumbing riser.",
  plumbing:
    "MutinyBIM pack for plumbing loads and design: fixture load points on open pipe ends and taps, connection types, the plumbing catalogue (pipe types), each pipe system's look and sizing, the project's sizing and demand curve. Use with the mutinybim core; riser diagrams are in the electrical pack. Trigger on: fixture units, load point, DFU, WFU, pipe type, pipe system sizing, demand curve.",
  views_sheets:
    "MutinyBIM pack for views and sheets: create, rename, duplicate and delete views, view properties and crops, 3D views with camera and crop box, sheets, title block properties, viewports and their layout, sheet notes and text notes, issue status. Use with the mutinybim core, which previews and saves view and sheet batches and prints and issues the set. Trigger on: create a view, crop, 3D view, create sheet, viewport, title block, sheet layout, sheet note.",
  coordination:
    "MutinyBIM pack for coordination: browse Autodesk Docs and link, update or unlink models, match levels to a linked model, create and update levels, read and set coordinates (project base point, survey point, true north, working angle), accept or retract a lint finding, and trace rooms. Use with the mutinybim core. Trigger on: linked model, architect's model, Autodesk Docs, levels from the link, coordinates, true north, survey point, accept finding, rooms.",
  groups_phases:
    "MutinyBIM pack for groups, phases and typed elements: create, update, lock and delete groups, assign elements, the active group and phase, phases and phase filters, a view's phase and groups, and the class, type and values of typed elements (walls, slabs, beams, rooms). Use with the mutinybim core. Trigger on: group, lock, phase, existing, demolition, new construction, phase filter, element type, element values.",
  parts:
    "MutinyBIM pack for part definitions: draft a part from a cut sheet, a complete example definition, check and save definitions, read a saved part, the firm's part library, clearance zones, the slab or roof a part stands on, and mounting planes. Use with the mutinybim core. Trigger on: new part, cut sheet, part definition, firm library, clearance, working space, host, curb, mounting plane.",
  calcs:
    "MutinyBIM pack for calculations: list and run code calculations against the model, duct size advice from airflow, a duct system's pressure report, a pipe system's hydraulics report, fitting coefficient overrides, a pipe system's code sizing proposal, and service size from an equipment list. Use with the mutinybim core. Trigger on: calculation, calc, duct size, pressure drop, static pressure, external static, hydraulics, fixture pressure, size pipes, gas sizing, coefficient, service size.",
  schedules:
    "MutinyBIM pack for schedules: the classes and fields a schedule can show, define and change schedules, edit cell values, and the schedule library. The core reads schedule rows. Use with the mutinybim core. Trigger on: schedule, create a schedule, schedule fields, edit schedule values, schedule template, library.",
};

/** The pack's server key in `mcp.json`: the skill name, so a client shows the same name for both. */
export function mcpServerKey(pack: Pick<BimToolPack, "skill">): string {
  return pack.skill;
}

export interface PluginJson {
  readonly $schema: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: { readonly name: string; readonly url: string };
  readonly homepage: string;
  readonly repository: string;
  readonly license: string;
  readonly keywords: readonly string[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function renderPluginJson(): PluginJson {
  return {
    $schema: PLUGIN_SCHEMA_ID,
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: "MutinyBIM agent tools as packs: connect the core plus only the packs a job needs (drafting, ducts and pipes, electrical, plumbing, views and sheets, coordination, groups and phases, parts, calculations, schedules). Each pack is one MCP server and one Agent Skill of the same name.",
    author: { name: "PermitZIP", url: "https://permitzip.com" },
    homepage: PLUGIN_HOMEPAGE,
    repository: PLUGIN_REPOSITORY,
    license: "Apache-2.0",
    keywords: ["bim", "aec", "mep", "mutinybim", "building-model", "mcp"],
    extensions: {
      "com.permitzip.mutinybim": {
        packs: BIM_TOOL_PACKS.map((p) => ({ id: p.id, label: p.label, purpose: p.purpose, skill: p.skill, server: mcpServerKey(p), token_cap: p.tokenCap, ...(p.readOnly ? { read_only: true } : {}), tools: p.tools.length })),
      },
    },
  };
}

export interface McpJson {
  readonly $schema: string;
  readonly mcpServers: Readonly<Record<string, { readonly type: "streamable-http"; readonly url: string }>>;
}

/** The one server the bundle ships: `<base>/mcp`, the core only (script tools, a few reads, the family switch). */
export const DEFAULT_MCP_SERVER_KEY = PLUGIN_NAME;

/**
 * `mcp.json` under `baseUrl`. By default one Streamable HTTP server, `/mcp`:
 * the core only; every other family is opt-in (`bim_enable_pack` in the
 * session, or that family's own endpoint). `perPack` lists one server per
 * pack (`/packs/<slug>/mcp`) for a host whose people asked for every
 * connection at once; never the bundle's default.
 */
export function renderMcpJson(baseUrl: string = DEFAULT_BIM_BASE_URL, options: { readonly perPack?: boolean } = {}): McpJson {
  const base = baseUrl.replace(/\/+$/, "");
  if (!options.perPack) return { $schema: MCP_SCHEMA_ID, mcpServers: { [DEFAULT_MCP_SERVER_KEY]: { type: "streamable-http", url: `${base}/mcp` } } };
  return {
    $schema: MCP_SCHEMA_ID,
    mcpServers: Object.fromEntries(BIM_TOOL_PACKS.map((p) => [mcpServerKey(p), { type: "streamable-http" as const, url: `${base}${bimPackEndpointPath(p)}` }])),
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * A skill file is three parts: the frontmatter and the tools block, both
 * rendered from the catalogue, and between them the guidance, written by hand.
 * `npm run build:files` rewrites the two rendered parts and keeps the guidance.
 */
export const SKILL_TOOLS_BEGIN = "<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->";
export const SKILL_TOOLS_END = "<!-- end tools -->";

/** The pack's frontmatter: what the Agent Skills specification reads, with the pack's tools in `metadata`. */
export function renderSkillFrontmatter(pack: BimToolPack): string {
  const description = SKILL_DESCRIPTIONS[pack.id] ?? pack.purpose;
  const core = pack.id === CORE_PACK_ID;
  return [
    "---",
    `name: ${pack.skill}`,
    `description: ${yamlString(description)}`,
    "license: Apache-2.0",
    `compatibility: ${yamlString(core ? "Needs the mutinybim MCP server from this package (/mcp under the MutinyBIM base)." : `Needs the mutinybim MCP server with the ${pack.slug} family turned on (bim_enable_pack, --packs ${pack.slug}, or ${bimPackEndpointPath(pack)} under the MutinyBIM base).`)}`,
    "metadata:",
    `  pack: ${yamlString(pack.id)}`,
    `  mcp-server: ${yamlString(DEFAULT_MCP_SERVER_KEY)}`,
    `  family: ${yamlString(pack.slug)}`,
    `  token-cap: ${yamlString(String(pack.tokenCap))}`,
    `  tools: ${yamlString(pack.tools.join(" "))}`,
    "---",
  ].join("\n");
}

/** The pack's tools block, last in the file: the catalogue's members in list order. */
export function renderSkillToolsBlock(pack: BimToolPack): string {
  const lines = [SKILL_TOOLS_BEGIN, "", `## Tools in this ${pack.id === CORE_PACK_ID ? "core" : "family"}`, "", "| Tool |", "| --- |", ...pack.tools.map((t) => `| \`${t}\` |`), "", SKILL_TOOLS_END];
  return lines.join("\n");
}

/** The hand-written guidance in a skill file: everything between the frontmatter and the tools block. Null when the file has neither. */
export function skillGuidance(text: string): string | null {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const rest = match[1] ?? "";
  const at = rest.indexOf(SKILL_TOOLS_BEGIN);
  return (at < 0 ? rest : rest.slice(0, at)).trim();
}

/** The pack's Agent Skill: rendered frontmatter, the hand-written guidance, the rendered tools block. */
export function renderSkill(pack: BimToolPack, guidance: string): string {
  return `${renderSkillFrontmatter(pack)}\n\n${guidance.trim()}\n\n${renderSkillToolsBlock(pack)}\n`;
}

/** A skill file with its rendered parts brought up to date from the catalogue and its guidance kept. */
export function syncSkill(pack: BimToolPack, current: string | undefined): string {
  const guidance = (current === undefined ? null : skillGuidance(current)) ?? `# ${pack.label}\n\n${pack.purpose}.`;
  return renderSkill(pack, guidance);
}

/**
 * Every file the package ships, by path from the package root, with each
 * skill's guidance taken from `current` (skill name → file text; by default
 * the files as shipped).
 */
export function renderPackageFiles(baseUrl: string = DEFAULT_BIM_BASE_URL, current: Readonly<Record<string, string>> = SKILL_FILES): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  files.set("plugin.json", `${JSON.stringify(renderPluginJson(), null, 2)}\n`);
  files.set("mcp.json", `${JSON.stringify(renderMcpJson(baseUrl), null, 2)}\n`);
  for (const pack of BIM_TOOL_PACKS) files.set(`skills/${pack.skill}/SKILL.md`, syncSkill(pack, current[pack.skill]));
  return files;
}

/** `src/skill-files.ts`: the shipped SKILL.md texts as a module, so a bundled host reads them without the file system. */
export function renderSkillFilesModule(files: ReadonlyMap<string, string>): string {
  const entries = BIM_TOOL_PACKS.map((pack) => `  ${JSON.stringify(pack.skill)}: ${JSON.stringify(files.get(`skills/${pack.skill}/SKILL.md`) ?? "")},`);
  return [
    "// Rendered by `npm run build:files` from skills/*/SKILL.md. Do not edit: edit the SKILL.md files.",
    "/** Each shipped skill's SKILL.md, by skill name. */",
    "export const SKILL_FILES: Readonly<Record<string, string>> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

/** One shipped skill, parsed: what a host's agent loads. */
export interface BimPluginSkill {
  readonly name: string;
  readonly description: string;
  readonly pack: BimToolPack;
  /** Everything below the frontmatter: the guidance and the tools block. */
  readonly instructions: string;
  readonly text: string;
}

/** Every shipped skill, in catalogue order. A skill whose file is missing or does not parse is left out and logged. */
export function bimPluginSkills(files: Readonly<Record<string, string>> = SKILL_FILES): readonly BimPluginSkill[] {
  const out: BimPluginSkill[] = [];
  for (const pack of BIM_TOOL_PACKS) {
    const text = files[pack.skill];
    const parsed = text === undefined ? null : parseSkill(text);
    if (!text || !parsed) {
      console.error("[bim-plugin] skill file missing or does not parse; left out", { skill: pack.skill });
      continue;
    }
    out.push({ name: parsed.fields.name ?? pack.skill, description: parsed.fields.description ?? pack.purpose, pack, instructions: parsed.body.trim(), text });
  }
  return out;
}

/**
 * Words that name a host's agent harness or its own tools; a host adds those
 * notes in its own overlay (and checks its own name there).
 */
const HOST_WORDS: readonly RegExp[] = [/Cmd\+J/, /\bPermitZIP\b/, /\bget_project_context\b/, /\b(report|list)_run_findings?\b/, /\b(de)?activate_skill\b/, /\bexpand_skill_tools\b/, /\blist_skill_tools\b/];
/** Shapes of client data: project numbers and the model ids made from them. */
const CLIENT_DATA: readonly RegExp[] = [/\bsite-\d{3,}\b/, /\bproject \d{4}\b/i, /\(\d{4}\)/];
/** Tools the tool server lists itself, beside the catalogue's. */
const SERVER_TOOLS: ReadonlySet<string> = new Set(["bim_enable_pack"]);

/**
 * A skill's guidance against the catalogue and the package's rules: every
 * `bim_` tool it names exists; a table row that describes a tool describes
 * one of this pack's; nothing names a host app or a client.
 */
export function skillGuidanceProblems(pack: BimToolPack, text: string): string[] {
  const guidance = skillGuidance(text);
  if (guidance === null) return [`skills/${pack.skill}: no guidance`];
  const out: string[] = [];
  for (const name of new Set(guidance.match(/\bbim_[a-z0-9_]+/g) ?? [])) {
    if (!bimPackOfTool(name) && !SERVER_TOOLS.has(name)) out.push(`skills/${pack.skill}: names ${name}, which no pack has`);
  }
  for (const row of guidance.split("\n").filter((line) => line.startsWith("| `bim_"))) {
    const described = /^\| `(bim_[a-z0-9_]+)`/.exec(row)?.[1] ?? "";
    if (!pack.tools.includes(described)) out.push(`skills/${pack.skill}: describes ${described} (${bimPackOfTool(described)?.id ?? "no pack"}) in a tool table; describe it in its own family's skill`);
  }
  for (const word of HOST_WORDS) if (word.test(guidance)) out.push(`skills/${pack.skill}: names a host (${word.source}); put host notes in the host's overlay`);
  for (const shape of CLIENT_DATA) if (shape.test(guidance)) out.push(`skills/${pack.skill}: looks like client data (${shape.source}); use a synthetic example`);
  if (!text.includes(SKILL_TOOLS_BEGIN) || !text.includes(SKILL_TOOLS_END)) out.push(`skills/${pack.skill}: has no rendered tools block`);
  return out;
}

const PLUGIN_FIELDS: ReadonlySet<string> = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const AUTHOR_FIELDS: ReadonlySet<string> = new Set(["name", "email", "url"]);
const PLUGIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const REVERSE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Agent Plugins 1.0 §5 and §8 on a parsed `plugin.json`. */
export function pluginJsonProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["plugin.json must be a JSON object"];
  const out: string[] = [];
  for (const key of Object.keys(value)) if (!PLUGIN_FIELDS.has(key)) out.push(`plugin.json: "${key}" is not a permitted top-level field`);
  if (value.$schema !== PLUGIN_SCHEMA_ID) out.push(`plugin.json: $schema must be ${PLUGIN_SCHEMA_ID}`);
  const name = value.name;
  if (typeof name !== "string" || !PLUGIN_NAME_PATTERN.test(name) || name.includes("--") || name.includes("..")) out.push("plugin.json: name must be 1-64 lower case letters, digits, hyphens and periods");
  for (const key of ["version", "description", "homepage", "repository", "license"] as const) if (key in value && typeof value[key] !== "string") out.push(`plugin.json: ${key} must be a string`);
  if ("author" in value) {
    const author = value.author;
    if (!isRecord(author)) out.push("plugin.json: author must be an object");
    else for (const [k, v] of Object.entries(author)) if (!AUTHOR_FIELDS.has(k) || typeof v !== "string") out.push(`plugin.json: author.${k} is not permitted`);
  }
  if ("keywords" in value && !(Array.isArray(value.keywords) && value.keywords.every((k) => typeof k === "string"))) out.push("plugin.json: keywords must be strings");
  if ("extensions" in value) {
    if (!isRecord(value.extensions)) out.push("plugin.json: extensions must be an object");
    else for (const key of Object.keys(value.extensions)) if (!REVERSE_DOMAIN.test(key)) out.push(`plugin.json: extension "${key}" must be a reverse-domain namespace`);
  }
  for (const inline of ["mcpServers", "mcp", "skills"]) if (inline in value) out.push(`plugin.json: ${inline} must not be declared inline`);
  return out;
}

/** Agent Plugins 1.0 §7.2 on a parsed `mcp.json` (remote servers only: this package ships no local process). */
export function mcpJsonProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["mcp.json must be a JSON object"];
  const out: string[] = [];
  for (const key of Object.keys(value)) if (key !== "$schema" && key !== "mcpServers") out.push(`mcp.json: "${key}" is not a permitted top-level field`);
  if (value.$schema !== MCP_SCHEMA_ID) out.push(`mcp.json: $schema must be ${MCP_SCHEMA_ID}`);
  if (!isRecord(value.mcpServers)) return [...out, "mcp.json: mcpServers must be an object"];
  for (const [key, server] of Object.entries(value.mcpServers)) {
    if (!isRecord(server)) {
      out.push(`mcp.json: server ${key} must be an object`);
      continue;
    }
    for (const field of Object.keys(server)) if (!["type", "url", "headers"].includes(field)) out.push(`mcp.json: server ${key} has "${field}", which a remote server may not`);
    if (server.type !== "streamable-http" && server.type !== "sse") out.push(`mcp.json: server ${key} must be streamable-http`);
    const url = typeof server.url === "string" ? safeUrl(server.url) : null;
    if (!url) out.push(`mcp.json: server ${key} needs an absolute url`);
    else {
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) out.push(`mcp.json: server ${key} must use https`);
      if (url.username || url.password || url.hash) out.push(`mcp.json: server ${key} url may not carry user information or a fragment`);
    }
  }
  return out;
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch (err) {
    console.error("[bim-plugin] mcp.json url does not parse", { raw, err });
    return null;
  }
}

/** The frontmatter fields Agent Skills defines. */
const SKILL_FIELDS: ReadonlySet<string> = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface ParsedSkill {
  readonly fields: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Reads the frontmatter this package writes (flat keys, one `metadata` map of strings). */
export function parseSkill(text: string): ParsedSkill | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  for (const line of (match[1] ?? "").split("\n")) {
    const nested = /^ {2}([a-z0-9-]+): (.*)$/.exec(line);
    if (inMetadata && nested) {
      metadata[nested[1] ?? ""] = unquote(nested[2] ?? "");
      continue;
    }
    const top = /^([a-z-]+):(?: (.*))?$/.exec(line);
    if (!top) return null;
    inMetadata = top[1] === "metadata";
    fields[top[1] ?? ""] = inMetadata ? "" : unquote(top[2] ?? "");
  }
  return { fields, metadata, body: match[2] ?? "" };
}

function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "string" ? parsed : raw;
}

/** Agent Skills on one `skills/<folder>/SKILL.md`. */
export function skillProblems(folder: string, text: string): string[] {
  const parsed = parseSkill(text);
  if (!parsed) return [`skills/${folder}/SKILL.md: frontmatter does not parse`];
  const out: string[] = [];
  const { fields, body } = parsed;
  for (const key of Object.keys(fields)) if (!SKILL_FIELDS.has(key)) out.push(`skills/${folder}: "${key}" is not an Agent Skills field`);
  const name = fields.name ?? "";
  if (!SKILL_NAME_PATTERN.test(name) || name.includes("--")) out.push(`skills/${folder}: name "${name}" must be 1-64 lower case letters, digits and single hyphens`);
  if (name !== folder) out.push(`skills/${folder}: name "${name}" must match its folder`);
  const description = fields.description ?? "";
  if (description.length === 0 || description.length > 1024) out.push(`skills/${folder}: description must be 1-1,024 characters (it is ${description.length})`);
  if ((fields.compatibility ?? "").length > 500) out.push(`skills/${folder}: compatibility is over 500 characters`);
  if (body.split("\n").length >= 500) out.push(`skills/${folder}: SKILL.md body should stay under 500 lines`);
  return out;
}
