/**
 * @jest-environment node
 *
 * Workstream 1 & 2 regression tests:
 * - `bim_script_reference` dynamically surfaces active connector endType IDs
 *   (including `plumbing_gas.flare` and `mechanical.brazed`) on search.
 * - `checkPart` / `bim_run_script` / `bim_save_part_type` separate hard
 *   structural errors (`partTypeIssues`) from advisory connector warnings
 *   (`partTypeImportReport`), allowing saving with advisory warnings surfaced
 *   while still blocking on hard structural issues.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { checkScriptOutput, parts, units } from "@permitzip/bim-script";
import { LOCAL_SCHEMAS, createBimToolServer } from "@permitzip/bim-mcp";
import { LOCAL_RUNS_WHERE, createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";

const REPO_ROOT = resolve(__dirname, "../../..");

const CUSTOM_END_TYPE_PART_SCRIPT = `
import { defineScript, parts, units } from "@permitzip/bim-script";

export default defineScript({
  kind: "part",
  reads: {},
  parameters: {},
  run(ctx) {
    const unit = parts.part("Della mini-split", { type: "12k BTU", category: "mechanical_equipment" });
    unit.box({ length: units.in(32), width: units.in(10), height: units.in(12) });
    unit.connector("back", {
      id: "liquid",
      label: "Liquid line",
      domain: "pipe",
      systemKind: "hydronic_supply",
      shape: "round",
      diameter: units.in(0.25),
      endType: "custom.proprietary_flare",
    });
    ctx.parts.define("acme:della-12k", unit.build());
  },
});
`;

const BROKEN_PART_SCRIPT = `
import { defineScript, parts, units } from "@permitzip/bim-script";

export default defineScript({
  kind: "part",
  reads: {},
  parameters: {},
  run(ctx) {
    const unit = parts.part("Broken part", { type: "1", category: "mechanical_equipment" });
    unit.box({ length: units.in(12), width: units.in(12), height: units.in(12) });
    const def = unit.build();
    ctx.parts.define("acme:broken", {
      ...def,
      connectors: [
        { id: "dup", label: "First", domain: "pipe", systemKind: "domestic_cold_water", position: [0, -152.4, 152.4], direction: [0, -1, 0], shape: "round", diameter: 15, endType: "plumbing_gas.flare" },
        { id: "dup", label: "Duplicate", domain: "pipe", systemKind: "domestic_cold_water", position: [0, 152.4, 152.4], direction: [0, 1, 0], shape: "round", diameter: 15, endType: "plumbing_gas.flare" },
      ],
    });
  },
});
`;

describe("part-check-advisory-warnings & endType discoverability", () => {
  let models: LocalModelServer;
  let client: Client;
  const approvalSummaries: { summary: string; reasons?: readonly string[] }[] = [];

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    const baseHost = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    const host = {
      ...baseHost,
      approvals: {
        mode: baseHost.approvals.mode,
        async decide(_extra: unknown, req: { readonly summary: string; readonly reasons?: readonly string[] }) {
          approvalSummaries.push({ summary: req.summary, reasons: req.reasons });
          return { approved: true as const, by: "test" };
        },
      },
    };
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE });
    client = new Client({ name: "part-check-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });

  afterAll(async () => {
    await client.close();
    await models.close();
  });

  it("bim_script_reference surfaces plumbing_gas.flare and mechanical.brazed dynamically on endType / flare / pipe connector queries", async () => {
    for (const search of ["endType", "end type", "flare", "pipe connector"]) {
      const res = await client.callTool({ name: "bim_script_reference", arguments: { search } });
      const text = (res.content as { text: string }[])[0]?.text ?? "";
      expect(text).toContain("plumbing_gas.flare");
      expect(text).toContain("mechanical.brazed");
    }
  });

  it("checkScriptOutput puts connector-report findings in warnings (advisory) and keeps problems empty for valid geometry", () => {
    const b = parts.part("Mini-split", { type: "12k", category: "mechanical_equipment" });
    b.box({ length: units.in(32), width: units.in(10), height: units.in(12) });
    b.connector("back", {
      id: "liquid",
      label: "Liquid",
      domain: "pipe",
      systemKind: "hydronic_supply",
      shape: "round",
      diameter: units.in(0.25),
      endType: "custom.flare_v2",
    });
    const res = checkScriptOutput(
      starterModel("demo"),
      {
        kind: "part_types",
        types: [{ typeId: "acme:mini-split", definition: b.build() }],
      },
      { pictures: false },
    );
    expect(res.kind).toBe("part_types");
    expect(res.ok).toBe(true);
    if (res.kind === "part_types") {
      const first = res.types[0];
      expect(first?.problems).toEqual([]);
      expect(first?.warnings.length).toBeGreaterThan(0);
      expect(first?.warnings[0]).toContain("custom.flare_v2");
      expect(first?.warnings[0]).toContain("plumbing_gas.flare");
    }
  });

  it("advisory unknown_end_type warnings surface in preview, approval gate, and save response without blocking bim_save_part_type", async () => {
    approvalSummaries.length = 0;
    const preview = await client.callTool({
      name: "bim_run_script",
      arguments: {
        model_id: "demo",
        script: { source: CUSTOM_END_TYPE_PART_SCRIPT, reads: {} },
      },
    });
    const previewBody = JSON.parse((preview.content as { text: string }[])[0]?.text ?? "{}") as Record<string, unknown>;
    expect(previewBody.status).toBe("previewed");
    const checks = previewBody.checks as { type_id: string; problems: string[]; warnings?: string[] }[];
    expect(checks[0]?.problems).toEqual([]);
    expect((checks[0]?.warnings ?? []).some((w) => w.includes("custom.proprietary_flare"))).toBe(true);
    expect(Array.isArray(previewBody.notes)).toBe(true);
    expect((previewBody.notes as string[]).some((n) => n.includes("advisory connector warning"))).toBe(true);
    expect(previewBody.apply_with).toBeDefined();

    const applyWith = previewBody.apply_with as { tool: string; args: Record<string, unknown> };
    expect(applyWith.tool).toBe("bim_save_part_type");
    const saved = await client.callTool({
      name: applyWith.tool,
      arguments: {
        ...applyWith.args,
        save_as: { key: "acme.della_12k", name: "Della 12k mini-split", version: "1.0.0" },
      },
    });
    const savedBody = JSON.parse((saved.content as { text: string }[])[0]?.text ?? "{}") as Record<string, unknown>;
    expect(savedBody.status).toBe("saved");
    expect(Array.isArray(savedBody.warnings)).toBe(true);
    expect((savedBody.warnings as string[]).some((w) => w.includes("custom.proprietary_flare"))).toBe(true);

    expect(approvalSummaries).toHaveLength(1);
    expect(approvalSummaries[0]?.summary).toContain("advisory connector warning");
    expect((approvalSummaries[0]?.reasons ?? []).some((r) => r.includes("custom.proprietary_flare"))).toBe(true);
  });

  it("hard structural partTypeIssues still block preview and omit apply_with", async () => {
    const preview = await client.callTool({
      name: "bim_run_script",
      arguments: {
        model_id: "demo",
        script: { source: BROKEN_PART_SCRIPT, reads: {} },
      },
    });
    const previewBody = JSON.parse((preview.content as { text: string }[])[0]?.text ?? "{}") as Record<string, unknown>;
    expect(previewBody.status).toBe("has_issues");
    expect(previewBody.apply_with).toBeUndefined();
  });
});
