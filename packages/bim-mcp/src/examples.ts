import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_SETTINGS, elementValues, type ModelState } from "@permitzip/bim-kernel";
import { scriptReadsSchema } from "@permitzip/bim-library";
import { createLocalHost, LOCAL_RUNS_WHERE, startInMemoryModelServer } from "./local";
import { LOCAL_SCHEMAS } from "./schemas";
import { createBimToolServer } from "./server";

/**
 * Runs one script the way an agent does, through the core tools only:
 * bim_check_output → bim_run_script (preview) → bim_apply_output, against a
 * fresh empty model on an in-memory model server, with the local runner.
 * `npm run example -- <name>` and the examples test both use it.
 */

export interface ExampleRun {
  /** What the script says it did (its approval line). */
  readonly label: string;
  readonly steps: number;
  /** The model after the edits landed. */
  readonly model: ModelState;
  /** Elements by kind, for a summary. */
  readonly kinds: Readonly<Record<string, number>>;
}

export class ExampleRunError extends Error {
  constructor(stage: string, body: unknown) {
    super(`${stage}: ${typeof body === "string" ? body : JSON.stringify(body).slice(0, 1500)}`);
    this.name = "ExampleRunError";
  }
}

type Body = Record<string, unknown>;

function bodyOf(result: unknown): Body {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
  return text.trimStart().startsWith("{") ? (JSON.parse(text) as Body) : { message: text };
}

/** The reads a script declares in its defineScript call (the runner runs a script only with its own reads). */
export function declaredReads(source: string): unknown {
  const m = /reads:\s*(\{[^}]*\})/.exec(source);
  if (!m?.[1]) throw new ExampleRunError("reads", "The script declares no reads ({ levels: true } at least).");
  const parsed = scriptReadsSchema.safeParse(JSON.parse(m[1].replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')));
  if (!parsed.success) throw new ExampleRunError("reads", "Its reads aren't a script's reads; write them as plain values, e.g. { levels: true }.");
  return parsed.data;
}

export async function runExample(source: string, options: { readonly repoRoot: string; readonly modelId?: string }): Promise<ExampleRun> {
  const modelId = options.modelId ?? "example";
  // The kernel carries no trade: duct, pipe and wire are first-party add-ons, installed before any model is decided.
  installFirstPartyAddOns();
  const models = startInMemoryModelServer();
  const client = new Client({ name: "mutinybim-example", version: "1.0.0" });
  try {
    await models.seed({ modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    const host = createLocalHost({ server: models, repoRoot: options.repoRoot, approve: "auto" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const call = async (name: string, args: Body) => bodyOf(await client.callTool({ name, arguments: args }));
    const script = { source, reads: declaredReads(source) };

    const checked = await call("bim_check_output", { script });
    const findings = Array.isArray(checked.findings) ? checked.findings : [];
    if (findings.length > 0) throw new ExampleRunError("bim_check_output", findings);
    const preview = await call("bim_run_script", { model_id: modelId, script });
    if (preview.status !== "previewed") throw new ExampleRunError("bim_run_script", preview);
    const applied = await call("bim_apply_output", (preview.apply_with as { args: Body }).args);
    if (applied.status !== "saved") throw new ExampleRunError("bim_apply_output", applied);

    const model = await models.head(modelId);
    if (!model) throw new ExampleRunError("model", "The model server has no model after the apply.");
    const kinds: Record<string, number> = {};
    for (const el of elementValues(model.elements)) kinds[el.kind] = (kinds[el.kind] ?? 0) + 1;
    return { label: String(preview.label ?? ""), steps: Number(preview.steps ?? 0), model, kinds };
  } finally {
    await client.close();
    await models.close();
  }
}
