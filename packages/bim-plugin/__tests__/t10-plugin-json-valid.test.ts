/**
 * @jest-environment node
 *
 * The package is an Agent Plugins 1.0 plugin: root plugin.json (closed
 * schema, no inline MCP), root mcp.json (one Streamable HTTP server: the
 * core, at the hosted app's /mcp) and one Agent Skill per pack, named as
 * the pack's skill. Each skill's guidance is written by hand; its
 * frontmatter and tools block, plugin.json, mcp.json and src/skill-files.ts
 * are rendered (run `npm run build:files` in this package after changing a
 * SKILL.md or the catalogue).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BIM_TOOL_PACKS,
  CORE_PACK_ID,
  PACK_LIST_TTL_MS,
  bimPack,
  bimPackEndpointPath,
  bimPackOfTool,
  catalogueProblems,
  mcpJsonProblems,
  mcpServerKey,
  parseSkill,
  pluginJsonProblems,
  renderMcpJson,
  SKILL_TOOLS_BEGIN,
  bimPluginSkills,
  renderPackageFiles,
  renderSkill,
  renderSkillFilesModule,
  skillGuidance,
  skillGuidanceProblems,
  skillProblems,
  syncSkill,
} from "../src";
import { SKILL_FILES } from "../src/skill-files";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("t10-plugin-json-valid: an Agent Plugins 1.0 package", () => {
  it("plugin.json satisfies §5 and §8: closed fields, canonical $schema, valid name, client data under extensions", () => {
    expect(pluginJsonProblems(JSON.parse(read("plugin.json")))).toEqual([]);
  });

  it("the plugin.json check catches what the specification forbids", () => {
    expect(pluginJsonProblems({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Bad--Name" })).not.toEqual([]);
    expect(pluginJsonProblems({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "ok", mcpServers: {} })).toEqual(expect.arrayContaining([expect.stringContaining("mcpServers")]));
    expect(pluginJsonProblems({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "ok", extensions: { examplehost: {} } })).not.toEqual([]);
  });

  it("mcp.json satisfies §7.2: canonical $schema, only mcpServers, each a Streamable HTTP server over https", () => {
    expect(mcpJsonProblems(JSON.parse(read("mcp.json")))).toEqual([]);
    expect(mcpJsonProblems({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { a: { type: "streamable-http", url: "http://example.com/mcp" } } })).not.toEqual([]);
  });

  it("mcp.json ships one server, /mcp, the core only: every other family is opt-in, never on by default", () => {
    const servers = JSON.parse(read("mcp.json")).mcpServers as Record<string, { url: string }>;
    expect(Object.keys(servers)).toEqual(["mutinybim"]);
    expect(servers.mutinybim?.url).toBe("https://app.mutinybim.com/mcp");
  });

  it("a host that asks for every connection at once gets one server per pack, each at its own endpoint, keyed by its skill name", () => {
    const servers = renderMcpJson("https://host.example/bim", { perPack: true }).mcpServers;
    expect(Object.keys(servers)).toEqual(BIM_TOOL_PACKS.map((p) => mcpServerKey(p)));
    for (const pack of BIM_TOOL_PACKS) expect(servers[pack.skill]?.url.endsWith(bimPackEndpointPath(pack))).toBe(true);
    expect(mcpJsonProblems(renderMcpJson("https://host.example/bim", { perPack: true }))).toEqual([]);
  });

  it("by default the server is the hosted app's tool server over https, and the links are the public repository", () => {
    const servers = JSON.parse(read("mcp.json")).mcpServers as Record<string, { type: string; url: string }>;
    expect(servers.mutinybim).toEqual({ type: "streamable-http", url: "https://app.mutinybim.com/mcp" });
    const plugin = JSON.parse(read("plugin.json")) as { homepage: string; repository: string };
    expect(plugin.repository).toBe("https://github.com/permitzip/mutinybim");
    expect(plugin.homepage).toBe("https://github.com/permitzip/mutinybim/tree/main/packages/bim-plugin");
  });

  it("a self-hosted server renders mcp.json under its own base", () => {
    expect(renderMcpJson("http://localhost:4100/bim/").mcpServers.mutinybim?.url).toBe("http://localhost:4100/bim/mcp");
    expect(renderMcpJson("http://localhost:4100/bim/", { perPack: true }).mcpServers.mutinybim?.url).toBe("http://localhost:4100/bim/mcp");
    expect(renderMcpJson("http://localhost:4100/bim/", { perPack: true }).mcpServers["mutinybim-drafting"]?.url).toBe("http://localhost:4100/bim/packs/drafting/mcp");
  });

  it("the core pack is the tool server's core: the script tools and four reads, nothing a family also lists", () => {
    expect(bimPack(CORE_PACK_ID)?.tools).toEqual(["bim_script_reference", "bim_check_output", "bim_run_script", "bim_apply_output", "bim_save_part_type", "bim_model_summary", "bim_query_elements", "bim_inspect_network", "bim_validation_issues"]);
    expect(bimPack("scripts")).toBeNull();
    expect(bimPackOfTool("bim_place_part")?.id).toBe("model");
    expect(bimPackEndpointPath({ slug: "core" })).toBe("/mcp");
  });

  it("ships exactly one skill per pack, each valid Agent Skills (name = folder, description ≤ 1,024, body < 500 lines)", () => {
    const folders = readdirSync(join(ROOT, "skills")).sort();
    expect(folders).toEqual(BIM_TOOL_PACKS.map((p) => p.skill).sort());
    for (const folder of folders) expect(skillProblems(folder, read(`skills/${folder}/SKILL.md`))).toEqual([]);
  });

  it("each skill names its pack, the one server, its family and exactly its pack's tools", () => {
    for (const pack of BIM_TOOL_PACKS) {
      const parsed = parseSkill(read(`skills/${pack.skill}/SKILL.md`));
      expect(parsed?.metadata.pack).toBe(pack.id);
      expect(parsed?.metadata["mcp-server"]).toBe("mutinybim");
      expect(parsed?.metadata.family).toBe(pack.slug);
      expect(parsed?.metadata.tools?.split(" ")).toEqual([...pack.tools]);
      if (pack.id !== CORE_PACK_ID) expect(parsed?.body).toContain("Activate `mutinybim` first");
    }
  });

  it("the files on disk are the catalogue's renderings: plugin.json, mcp.json, each skill's frontmatter and tools block", () => {
    const onDisk = Object.fromEntries(BIM_TOOL_PACKS.map((p) => [p.skill, read(`skills/${p.skill}/SKILL.md`)]));
    for (const [path, contents] of renderPackageFiles(undefined, onDisk)) expect({ path, contents: read(path) }).toEqual({ path, contents });
  });

  it("src/skill-files.ts holds exactly the shipped SKILL.md texts, so a bundled host reads what is on disk", () => {
    expect(read("src/skill-files.ts")).toBe(renderSkillFilesModule(renderPackageFiles()));
    for (const pack of BIM_TOOL_PACKS) expect(SKILL_FILES[pack.skill]).toBe(read(`skills/${pack.skill}/SKILL.md`));
  });

  it("each skill's hand-written guidance names only catalogue tools, describes only its own tools, and names no host or client", () => {
    for (const pack of BIM_TOOL_PACKS) expect(skillGuidanceProblems(pack, read(`skills/${pack.skill}/SKILL.md`))).toEqual([]);
  });

  it("the guidance check catches a stray tool, another pack's tool in a table, a host's words and a project number", () => {
    const pack = bimPack("drafting");
    if (!pack) throw new Error("no drafting pack");
    const file = (guidance: string) => renderSkill(pack, guidance);
    expect(skillGuidanceProblems(pack, file("Call `bim_not_a_tool`."))).toEqual([expect.stringContaining("no pack has")]);
    expect(skillGuidanceProblems(pack, file("| Tool | Use |\n| --- | --- |\n| `bim_route_run` | route |"))).toEqual([expect.stringContaining("ducts_pipes")]);
    expect(skillGuidanceProblems(pack, file("Approve it in Cmd+J, then call report_run_finding."))).toHaveLength(2);
    expect(skillGuidanceProblems(pack, file("The model id is site-0000 for project 0000."))).toHaveLength(2);
    expect(skillGuidanceProblems(pack, file("Use `bim_add_tag`, then `bim_enable_pack`."))).toEqual([]);
  });

  it("a build keeps the hand-written guidance and rewrites only the rendered parts", () => {
    const pack = bimPack("schedules");
    if (!pack) throw new Error("no schedules pack");
    const stale = renderSkill(pack, "# Schedules\n\nWrite a script first.").replace("bim_library", "bim_old_name");
    const synced = syncSkill(pack, stale);
    expect(skillGuidance(synced)).toBe("# Schedules\n\nWrite a script first.");
    expect(synced).toContain("| `bim_library` |");
    expect(synced).not.toContain("bim_old_name");
  });

  it("the core skill is script first: reference, write, check, preview, approve", () => {
    const core = read("skills/mutinybim/SKILL.md");
    const order = ["`bim_script_reference`", "`bim_check_output`", "`bim_run_script`", "`bim_apply_output`"].map((t) => core.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const pack of BIM_TOOL_PACKS.filter((p) => p.id !== CORE_PACK_ID)) expect(core).toContain(`\`${pack.skill}\``);
  });

  it("bimPluginSkills returns every shipped skill parsed, one per pack, with the tools block in its instructions", () => {
    const skills = bimPluginSkills();
    expect(skills.map((s) => s.name)).toEqual(BIM_TOOL_PACKS.map((p) => p.skill));
    for (const skill of skills) {
      expect(skill.pack.skill).toBe(skill.name);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.instructions.startsWith("# ")).toBe(true);
      expect(skill.instructions).toContain(SKILL_TOOLS_BEGIN);
    }
  });

  it("the skill check catches a misnamed skill and an overlong description", () => {
    expect(skillProblems("mutinybim-x", "---\nname: mutinybim-y\ndescription: ok\n---\nbody\n")).toEqual([expect.stringContaining("must match its folder")]);
    expect(skillProblems("a", `---\nname: a\ndescription: ${JSON.stringify("x".repeat(1025))}\n---\n`)).toEqual([expect.stringContaining("1-1,024")]);
  });
});

describe("t10-every-tool-one-pack: the catalogue", () => {
  it("has a core, unique ids, slugs and skills, and no tool in two packs", () => {
    expect(catalogueProblems()).toEqual([]);
    for (const key of ["id", "slug", "skill"] as const) expect(new Set(BIM_TOOL_PACKS.map((p) => p[key])).size).toBe(BIM_TOOL_PACKS.length);
  });

  it("finds a tool's pack and a pack by id, slug or skill", () => {
    expect(bimPackOfTool("bim_draw_detail")?.skill).toBe("mutinybim-drafting");
    expect(bimPackOfTool("bim_preview_one_line")?.skill).toBe("mutinybim-electrical");
    expect(bimPackOfTool("not_a_tool")).toBeNull();
    expect(bimPack("views-sheets")?.id).toBe("views_sheets");
    expect(bimPack("mutinybim-views-sheets")?.id).toBe("views_sheets");
  });

  it("catches a tool listed in two packs", () => {
    const [a, b] = BIM_TOOL_PACKS;
    if (!a || !b) throw new Error("the catalogue has fewer than two packs");
    expect(catalogueProblems([a, { ...b, tools: [...b.tools, a.tools[0] ?? "bim_x"] }])).toEqual([expect.stringContaining("is in two packs")]);
  });

  it("lists cache for five minutes", () => {
    expect(PACK_LIST_TTL_MS).toBe(300_000);
  });
});
