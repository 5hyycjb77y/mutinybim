/**
 * @jest-environment node
 *
 * A script is sent once. On a host that keeps scripts, a preview no longer
 * sends the script back: apply_with.args names it by id, the id lands only
 * what that preview ran with, and a fix after an error is a replacement by
 * id. A host that keeps none answers as before. Answers are short: the
 * reference index, a search and a long error are capped.
 *
 * Each case fails on the code before: the preview echoed the whole script in
 * apply_with.args, the script argument took no id and no replacements, the
 * index carried a whole example, and a search returned every hit whole.
 *
 * The runner here answers every run with one fixed output (the real runner is
 * proved by oss-local-end-to-end), so the cases read what the tools sent it.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import type { ScriptRunRequest, ScriptRunResult } from "@permitzip/bim-script";
import { KEPT_SCRIPT_ID, KEPT_SCRIPT_KEEP_MS, LOCAL_SCHEMAS, SCRIPT_EXPIRED_WORDS, createBimToolServer, type BimToolHost } from "@permitzip/bim-mcp";
import { createLocalHost, startInMemoryModelServer, starterModel, type LocalHostOptions, type LocalModelServer } from "@permitzip/bim-mcp/local";

const REPO_ROOT = resolve(__dirname, "../../..");
const SOURCE = 'import { defineScript } from "@permitzip/bim-script";\nexport default defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run(ctx) {} });\n';
const READS = { levels: true };
const OUTPUT = { kind: "edits", label: "One new level", steps: 1, batches: [{ type: "batch_edits", label: "One new level", commands: [{ type: "create_level", levelId: "level-9", name: "Level 9", elevationMm: 9000 }] }] };

type Body = Record<string, unknown>;
type Answer = Body & { readonly isError?: boolean };

const fixedRunner = {
  id: "fixed",
  limits: { memoryMb: 1024, wallMs: 30_000, outputBytes: 2 * 1024 * 1024 },
  runs: [] as ScriptRunRequest[],
  answer: null as ScriptRunResult | null,
  async run(request: ScriptRunRequest): Promise<ScriptRunResult> {
    this.runs.push(request);
    return this.answer ?? { ok: true, output: OUTPUT, bytes: 100, ms: 1 };
  },
};

function answerOf(result: unknown): Answer {
  const r = result as { content?: { text?: string }[]; isError?: boolean };
  const t = r.content?.[0]?.text ?? "";
  const body = t.trimStart().startsWith("{") ? (JSON.parse(t) as Body) : { message: t };
  return r.isError ? { ...body, isError: true } : body;
}

describe("script-sent-once", () => {
  let models: LocalModelServer;
  beforeAll(() => installFirstPartyAddOns());
  beforeEach(async () => {
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    await models.seed(starterModel("other"));
    fixedRunner.runs.length = 0;
    fixedRunner.answer = null;
  });
  afterEach(() => models.close());

  const localHost = (options: Partial<LocalHostOptions> = {}) => createLocalHost({ server: models, repoRoot: REPO_ROOT, runner: fixedRunner, approve: "auto", ...options });

  async function connect(host: BimToolHost) {
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS });
    const c = new Client({ name: "sent-once", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), c.connect(a)]);
    return { call: async (name: string, args: Body) => answerOf(await c.callTool({ name, arguments: args })), close: () => c.close() };
  }

  const levelNine = async (modelId = "demo") => (await models.head(modelId))?.elements["level-9"];
  const argsOf = (preview: Body) => (preview.apply_with as { args: Body }).args;

  it("a preview doesn't send the script back; apply_with.args names it by id and lands with what the preview ran with", async () => {
    const c = await connect(localHost());
    const preview = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS }, values: { height: 3 } });
    expect(preview.status).toBe("previewed");
    expect(preview.script_id).toMatch(KEPT_SCRIPT_ID);
    expect(JSON.stringify(preview)).not.toContain("defineScript");
    const args = argsOf(preview);
    expect(args.script).toEqual({ id: preview.script_id });
    expect(args).not.toHaveProperty("values");
    expect(args).not.toHaveProperty("selection");

    expect(await c.call("bim_apply_output", args)).toMatchObject({ status: "saved" });
    expect(await levelNine()).toMatchObject({ name: "Level 9" });
    expect(fixedRunner.runs).toHaveLength(2);
    expect(fixedRunner.runs[1]?.source).toBe(SOURCE);
    expect(fixedRunner.runs[1]?.values).toEqual({ height: 3 });
    expect(fixedRunner.runs[1]?.scriptHash).toBe(fixedRunner.runs[0]?.scriptHash);
    await c.close();
  });

  it("a host that keeps no scripts answers as before: the script rides in apply_with.args, and that still lands", async () => {
    const legacy: BimToolHost = { ...localHost(), previews: undefined };
    const c = await connect(legacy);
    const preview = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS } });
    expect(preview.status).toBe("previewed");
    expect(preview).not.toHaveProperty("script_id");
    expect(argsOf(preview).script).toEqual({ source: SOURCE, reads: READS });
    expect(await c.call("bim_apply_output", argsOf(preview))).toMatchObject({ status: "saved" });
    const byId = await c.call("bim_run_script", { model_id: "other", script: { id: `scr_${"0".repeat(32)}` } });
    expect(byId).toMatchObject({ status: "refused", message: expect.stringContaining("keeps no scripts") });
    await c.close();
  });

  it("the whole script is still accepted on a host that keeps scripts (an older assistant, an older preview)", async () => {
    const c = await connect(localHost());
    const preview = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS } });
    const inline = { ...argsOf(preview), script: { source: SOURCE, reads: READS }, values: {} };
    expect(await c.call("bim_apply_output", inline)).toMatchObject({ status: "saved" });
    await c.close();
  });

  it("nothing can be swapped between the preview and the landing: other values, selection, area, model or output are refused before anything runs", async () => {
    const c = await connect(localHost());
    const preview = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS }, values: { height: 3 } });
    const args = argsOf(preview);
    const refusedFor = async (change: Body, words: string) => {
      expect(await c.call("bim_apply_output", { ...args, ...change })).toMatchObject({ status: "refused", message: expect.stringContaining(words), nothing_changed: true });
    };
    await refusedFor({ values: { height: 4 } }, "values in this call aren't the ones the preview ran with");
    await refusedFor({ selection: ["some-element"] }, "selection in this call isn't the one the preview ran with");
    await refusedFor({ level: "Level 1" }, "level or zone in this call isn't the one the preview ran on");
    await refusedFor({ model_id: "other" }, "No preview of this script on this model");
    await refusedFor({ output_hash: `sha256:${"f".repeat(64)}` }, "No preview of this script on this model");
    await refusedFor({ script: { id: preview.script_id, replace: [{ old: "run(ctx) {}", new: 'run(ctx) { ctx.label("Other"); }' }] } }, "changed after its preview");
    expect(fixedRunner.runs).toHaveLength(1);
    expect(await levelNine()).toBeUndefined();
    expect(await levelNine("other")).toBeUndefined();
    // The same values named again are the preview's own, so that call lands.
    expect(await c.call("bim_apply_output", { ...args, values: { height: 3 } })).toMatchObject({ status: "saved" });
    await c.close();
  });

  it("an id is the sender's alone, and expires: both answer that the preview has expired, and nothing lands", async () => {
    const sam = localHost({ person: "sam" });
    const c = await connect(sam);
    const args = argsOf(await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS } }));

    const pat: BimToolHost = { ...localHost({ person: "pat" }), previews: sam.previews };
    const other = await connect(pat);
    expect(await other.call("bim_apply_output", args)).toMatchObject({ status: "refused", message: SCRIPT_EXPIRED_WORDS, nothing_changed: true });
    expect(await other.call("bim_run_script", { model_id: "demo", script: args.script })).toMatchObject({ status: "refused", message: SCRIPT_EXPIRED_WORDS });

    const later: BimToolHost = { ...sam, now: () => new Date(Date.now() + KEPT_SCRIPT_KEEP_MS + 60_000) };
    const late = await connect(later);
    expect(await late.call("bim_apply_output", args)).toMatchObject({ status: "refused", message: SCRIPT_EXPIRED_WORDS, nothing_changed: true });
    expect(SCRIPT_EXPIRED_WORDS).toContain("That preview has expired; run the script again");
    expect(await levelNine()).toBeUndefined();

    expect(await c.call("bim_apply_output", args)).toMatchObject({ status: "saved" });
    await Promise.all([c.close(), other.close(), late.close()]);
  });

  it("a fix is a replacement by id: the changed script runs, gets its own id and lands by it", async () => {
    const c = await connect(localHost());
    const first = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS } });
    const fixed = await c.call("bim_run_script", { model_id: "demo", script: { id: first.script_id, replace: [{ old: "run(ctx) {}", new: 'run(ctx) { ctx.label("Fixed"); }' }] } });
    const changed = SOURCE.replace("run(ctx) {}", 'run(ctx) { ctx.label("Fixed"); }');
    expect(fixed.status).toBe("previewed");
    expect(fixedRunner.runs[1]?.source).toBe(changed);
    expect(fixedRunner.runs[1]?.slice.reads).toEqual(READS);
    expect(fixed.script_id).toMatch(KEPT_SCRIPT_ID);
    expect(fixed.script_id).not.toBe(first.script_id);
    expect(JSON.stringify(fixed)).not.toContain("defineScript");
    expect(await c.call("bim_apply_output", argsOf(fixed))).toMatchObject({ status: "saved" });
    expect(fixedRunner.runs[2]?.source).toBe(changed);
    await c.close();
  });

  it("a replacement that isn't found, or is found twice, says which one and runs nothing", async () => {
    const c = await connect(localHost());
    const first = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS } });
    const missing = await c.call("bim_run_script", { model_id: "demo", script: { id: first.script_id, replace: [{ old: "elevationMm: 400", new: "elevationMm: 4000" }] } });
    expect(missing).toMatchObject({ status: "refused", script_id: first.script_id, nothing_changed: true });
    expect(String(missing.message)).toContain('Replacement 1 ("elevationMm: 400")');
    expect(String(missing.message)).toContain("isn't in the script");
    expect(missing.fix_with).toEqual(expect.stringContaining("replace"));
    const twice = await c.call("bim_run_script", { model_id: "demo", script: { id: first.script_id, replace: [{ old: "defineScript", new: "define" }] } });
    expect(String(twice.message)).toContain("2 times (lines 1, 2)");
    expect(fixedRunner.runs).toHaveLength(1);
    await c.close();
  });

  it("a check keeps the script too: the preview after it names the id, and reads come from the script when they are plain values", async () => {
    const c = await connect(localHost());
    const checked = await c.call("bim_check_output", { script: { source: SOURCE } });
    expect(checked).toMatchObject({ status: "ok", findings: [] });
    expect(checked.script_id).toMatch(KEPT_SCRIPT_ID);
    expect(String(checked.next)).toContain(`script: { id: "${String(checked.script_id)}" }`);
    const preview = await c.call("bim_run_script", { model_id: "demo", script: { id: checked.script_id } });
    expect(preview).toMatchObject({ status: "previewed", script_id: checked.script_id });
    expect(fixedRunner.runs[0]?.source).toBe(SOURCE);
    expect(fixedRunner.runs[0]?.slice.reads).toEqual(READS);
    await c.close();
  });

  it("the check names kit functions and commands that don't exist, with their lines, before a preview is spent", async () => {
    const wrong = [
      'import { defineScript, building } from "@permitzip/bim-script";',
      'export default defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run(ctx) {',
      "  building.rooms(ctx, {});",
      '  ctx.edit({ type: "make_level", name: "Level 2" });',
      "} });",
      "",
    ].join("\n");
    const c = await connect(localHost());
    const checked = await c.call("bim_check_output", { script: { source: wrong, reads: READS } });
    expect(checked.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 3, rule: "kit", message: expect.stringContaining("building.room") }),
        expect.objectContaining({ line: 4, rule: "kit", message: expect.stringContaining('"make_level"') }),
      ]),
    );
    const mismatched = await c.call("bim_check_output", { script: { source: SOURCE, reads: { levels: true, kinds: ["wall"] } } });
    expect(mismatched.warnings).toEqual([expect.objectContaining({ line: 2, rule: "reads", message: expect.stringContaining("declares reads") })]);
    expect(fixedRunner.runs).toHaveLength(0);
    await c.close();
  });

  it("a machine fault is run again by id, not rewritten; a long script error is cut and says so", async () => {
    const c = await connect(localHost());
    fixedRunner.answer = { ok: false, code: "runner_error", message: "the script process exited 1 before answering", ms: 1 };
    const fault = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: READS } });
    expect(fault).toMatchObject({ status: "stopped", code: "runner_error", nothing_changed: true });
    expect(fault.retry_with).toBe(`script: { id: "${String(fault.script_id)}" }`);
    expect(fault).not.toHaveProperty("fix_with");
    expect(String(fault.message)).toContain("don't rewrite the script");

    fixedRunner.answer = { ok: false, code: "script_error", message: `Line 3: ${"x".repeat(5000)}`, ms: 1 };
    const long = await c.call("bim_run_script", { model_id: "demo", script: { id: fault.script_id } });
    expect(long).toMatchObject({ status: "stopped", code: "script_error", script_id: fault.script_id });
    expect(String(long.message).length).toBeLessThan(1700);
    expect(String(long.message)).toContain("more characters cut");
    expect(long.fix_with).toEqual(expect.stringContaining("replace"));
    await c.close();
  });

  it("the reference index is short and read once; the rest is fetched one piece at a time", async () => {
    const c = await connect(localHost());
    const index = await c.call("bim_script_reference", {});
    expect(JSON.stringify(index).length).toBeLessThan(10_000);
    expect(index).not.toHaveProperty("part_definition");
    expect(index).not.toHaveProperty("recipes");
    expect(JSON.stringify(index)).not.toContain("export default defineScript({\\n");
    expect(index.examples).toEqual(expect.arrayContaining([{ name: "rooftop-unit", title: "Rooftop unit" }]));
    expect(index.kit).toEqual(expect.arrayContaining([expect.stringMatching(/^routes: .*\balong\b/)]));
    expect(String(index.send_once)).toContain("script_id");

    const search = await c.call("bim_script_reference", { search: "walls" });
    const hits = search.hits as { kind: string; name: string; example?: string; read?: string }[];
    const heavy = hits.filter((h) => h.kind === "function" || h.kind === "recipe");
    expect(heavy.length).toBeGreaterThan(2);
    expect(heavy.filter((h) => h.example !== undefined)).toHaveLength(2);
    const brief = heavy.find((h) => h.example === undefined);
    expect(brief?.read).toBe(`bim_script_reference({ topic: "${brief?.name ?? ""}" })`);

    const whole = await c.call("bim_script_reference", { topic: brief?.name ?? "" });
    expect(whole).toMatchObject({ name: brief?.name, example: expect.stringContaining("defineScript") });
    const sending = await c.call("bim_script_reference", { topic: "sending scripts" });
    expect(sending).toMatchObject({ name: "Sending scripts", forms: expect.arrayContaining([expect.stringContaining("replace: [{ old, new }]")]) });
    expect(await c.call("bim_script_reference", { topic: "no such thing at all" })).toMatchObject({ isError: true, message: expect.stringContaining("No function or recipe named") });

    const command = await c.call("bim_script_reference", { command: "create_level" });
    const fields = command.fields as string[];
    expect(fields.length).toBeGreaterThan(0);
    if (!fields.some((f) => f.includes("{…}") || /: unknown\b/.test(f))) expect(command).not.toHaveProperty("schema");
    await c.close();

    const none = await connect({ ...localHost(), previews: undefined });
    expect(await none.call("bim_script_reference", {})).not.toHaveProperty("send_once");
    await none.close();
  });
});
