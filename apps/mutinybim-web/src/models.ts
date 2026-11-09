/**
 * The models this app serves. Each model runs in this process behind the
 * same sync protocol the model server speaks (bim-sync's in-memory host:
 * sequencer, hub, branches and versions), opened on first use. After every
 * change (debounced) the whole model is written to one file: Main and its
 * history, every branch with its own edits, and every saved version. It is
 * read back when the model is next opened, so all of it survives a restart.
 *
 * This is the single-machine store. A deployment that outgrows it points the
 * editor at a model server with a Postgres commit store instead.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, DEFAULT_SETTINGS, executeCommand, parseBranchModelId, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryBranchHost, type InMemoryHostSnapshot, type SyncHub } from "@permitzip/bim-sync";

export type StarterKind = "blank" | "sample";

/** A model with one level, the same start the tool server gives a new model. */
export function blankModel(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const made = executeCommand(empty, { type: "create_level", levelId: "level-1", name: "Level 1", elevationMm: 0 });
  if (!made.ok) throw new Error(`[mutinybim-web] the blank model couldn't be made: ${made.error.message}`);
  return { ...made.model, revision: 0 as ModelState["revision"] };
}

export function starterModel(modelId: string, kind: StarterKind): ModelState {
  return kind === "sample" ? { ...createDemoModel(modelId), modelId } : blankModel(modelId);
}

/** The file's shape. A bare model (the first files this app wrote) still opens, with no branches or history. */
const FILE_FORMAT = "mutinybim-web/model@2";
interface ModelFile {
  readonly format: typeof FILE_FORMAT;
  readonly host: InMemoryHostSnapshot;
}

function isModelFile(value: unknown): value is ModelFile {
  if (typeof value !== "object" || value === null || !("format" in value) || value.format !== FILE_FORMAT || !("host" in value)) return false;
  const host = value.host;
  return typeof host === "object" && host !== null && "main" in host && "registry" in host && "copies" in host && typeof host.main === "object" && host.main !== null && "head" in host.main && isModelState(host.main.head);
}

function isModelState(value: unknown): value is ModelState {
  return typeof value === "object" && value !== null && "modelId" in value && typeof value.modelId === "string" && "elements" in value && typeof value.elements === "object" && "revision" in value && typeof value.revision === "number";
}

export interface ModelSummary {
  readonly revision: number;
  readonly elements: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly levels: readonly string[];
  readonly connections: number;
}

export function summarize(model: ModelState): ModelSummary {
  const byKind: Record<string, number> = {};
  const levels: string[] = [];
  for (const element of Object.values(model.elements)) {
    byKind[element.kind] = (byKind[element.kind] ?? 0) + 1;
    if (element.kind === "level" && "name" in element && typeof element.name === "string") levels.push(element.name);
  }
  return { revision: model.revision, elements: Object.keys(model.elements).length, byKind, levels, connections: model.connections.length };
}

interface Open {
  readonly host: InMemoryBranchHost;
  readonly stopSaving: () => void;
  saveTimer: NodeJS.Timeout | null;
  saving: Promise<void>;
}

export class ModelStore {
  private readonly open = new Map<string, Promise<Open>>();

  constructor(
    private readonly dir: string,
    private readonly onSaved: (modelId: string) => void = () => {},
  ) {}

  private file(modelId: string): string {
    if (!/^[a-z0-9-]{8,64}$/.test(modelId)) throw new Error(`[mutinybim-web] "${modelId}" is not a model id this app made`);
    return path.join(this.dir, `${modelId}.json`);
  }

  /** Writes a new model's first snapshot. */
  async create(modelId: string, kind: StarterKind): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(modelId), canonicalJson(starterModel(modelId, kind)), { flag: "wx" });
  }

  private async load(modelId: string): Promise<{ readonly head: ModelState; readonly host: InMemoryHostSnapshot | null }> {
    const raw = await readFile(this.file(modelId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isModelFile(parsed)) return { head: parsed.host.main.head, host: parsed.host };
    if (isModelState(parsed)) return { head: parsed, host: null };
    throw new Error(`[mutinybim-web] the saved file for model ${modelId} is not a model`);
  }

  private async persist(modelId: string, opened: Open): Promise<void> {
    await opened.host.main.sequencer.exportSnapshot();
    const file: ModelFile = { format: FILE_FORMAT, host: await opened.host.snapshot() };
    const target = this.file(modelId);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(file));
    await rename(temp, target);
    this.onSaved(modelId);
  }

  private scheduleSave(modelId: string, opened: Open): void {
    if (opened.saveTimer) return;
    opened.saveTimer = setTimeout(() => {
      opened.saveTimer = null;
      opened.saving = opened.saving
        .then(() => this.persist(modelId, opened))
        .catch((err: unknown) => console.error("[mutinybim-web] saving a model failed; it stays in memory and is retried on the next change", { modelId, err }));
    }, 750);
  }

  private async openModel(modelId: string): Promise<Open> {
    const saved = await this.load(modelId);
    const host = await InMemoryBranchHost.start(saved.head, {}, null, {}, saved.host ?? undefined);
    const opened: Open = { host, stopSaving: () => {}, saveTimer: null, saving: Promise.resolve() };
    const stop = host.onChange(() => this.scheduleSave(modelId, opened));
    return Object.assign(opened, { stopSaving: stop });
  }

  private served(modelId: string): Promise<Open> {
    let opened = this.open.get(modelId);
    if (!opened) {
      opened = this.openModel(modelId);
      this.open.set(modelId, opened);
      opened.catch((err: unknown) => {
        console.error("[mutinybim-web] a model couldn't be opened", { modelId, err });
        this.open.delete(modelId);
      });
    }
    return opened;
  }

  /** The hub for Main or one of its branches (`<model>~<branch>`); null for a branch this process doesn't have. */
  async hubFor(baseModelId: string, requested: string | null): Promise<SyncHub | null> {
    const opened = await this.served(baseModelId);
    if (requested === null || requested === baseModelId) return opened.host.main.hub;
    const branch = await opened.host.open(requested);
    if (branch) return branch.hub;
    return parseBranchModelId(requested) ? null : opened.host.main.hub;
  }

  /** Main, its branches and saved versions for one model, opened if it isn't already. */
  async host(modelId: string): Promise<InMemoryBranchHost> {
    return (await this.served(modelId)).host;
  }

  async head(modelId: string): Promise<ModelState> {
    const opened = this.open.get(modelId);
    if (opened) return (await opened).host.main.sequencer.head();
    return (await this.load(modelId)).head;
  }

  /** Stops serving a deleted model and sets its file aside (renamed, not erased, so a mistake can be undone by hand). */
  async remove(modelId: string): Promise<void> {
    const pending = this.open.get(modelId);
    this.open.delete(modelId);
    if (pending) {
      const opened = await pending;
      if (opened.saveTimer) clearTimeout(opened.saveTimer);
      opened.stopSaving();
      await opened.saving;
    }
    await rename(this.file(modelId), `${this.file(modelId)}.deleted-${Date.now()}`);
  }

  /** Saves every open model now (shutdown). */
  async flush(): Promise<void> {
    for (const [modelId, pending] of this.open) {
      const opened = await pending;
      if (opened.saveTimer) {
        clearTimeout(opened.saveTimer);
        opened.saveTimer = null;
        await opened.saving;
        await this.persist(modelId, opened);
      } else {
        await opened.saving;
      }
    }
  }
}
