import { builtinCalcRegistry, type CalcDomain, type RunRequest, type RunResult } from "@permitzip/bim-calc";
import { acceptGhostsCommand, commandIssueMessage, commandSchema, executeCommand, isEditBatchCommand, proposersFor, runProposer, withUpgradePolicy, type Command, type GhostPlacement, type ModelState, type PackCommand, type PartTypeDefinition, type ProposerAnswer, type ProposerRequest } from "@permitzip/bim-kernel";
import { FIRST_PARTY_PACK_IDS, PACK_READ_POINT, activePackSet, firstPartyPackName, withPackSet, type PackSet } from "@permitzip/bim-kernel/packs";
import { scriptSourceIssues, type ScriptKind, type ScriptValue } from "@permitzip/bim-library";
import type { ScriptDefinition } from "./define";
import { deterministicId, seededRandom, type RunSeed } from "./determinism";
import { chunkEdits, stepRefusal, type EditStep, type ScriptOutput } from "./output";
import { sliceAsModel, sliceReader, type ModelSlice, type SliceReader } from "./slice";
import { bindWorking } from "./working";

/** A calculation a script can run (`ctx.calcs()`). */
export interface ScriptCalcInfo {
  readonly id: string;
  readonly title: string;
  readonly domain: CalcDomain;
  readonly summary: string;
  /** It reads the model (it is run on the script's working copy). */
  readonly readsModel: boolean;
}

/** One calculation run from a script: the calc and its inputs, and an edition when the job names one. The model is the script's working copy. */
export type ScriptCalcRequest = Omit<RunRequest, "model" | "projectAdoption" | "projectAdoptions">;

/** An add-on's read a script can run (`ctx.reads()`): a panel's loads, a rebalance plan, a duct size, a catalogue. */
export interface ScriptReadInfo {
  readonly id: string;
  readonly label: string;
}

/** An add-on's proposer (`ctx.proposers()`): devices placed by a code's spacing or coverage, as ghosts. */
export interface ScriptProposerInfo {
  readonly id: string;
  readonly label: string;
  /** What it places on, in words ("walls", "typed ceilings"). */
  readonly hosts: string;
}

/** What a script's `run` works through. */
export interface ScriptContext {
  readonly kind: ScriptKind;
  /** The model, as far as the script's reads go. Edits it made are visible to later reads. */
  readonly model: SliceReader;
  /** A new id, the same on every run with the same script, values and slice revision. */
  id(prefix?: string): string;
  /** Seeded randomness in [0, 1): use this, never Math.random. */
  random(): number;
  /** Layout and route scripts: one edit, applied to the working copy at once (later steps see it), recorded for the output. */
  edit(command: Command | PackCommand): void;
  /**
   * Sends a plan's edit as it came from an add-on read or proposer (one edit,
   * or a batch such as a rebalance's or a room template's), step by step.
   * The output batches the steps again; one approval covers them.
   */
  editSteps(command: unknown): void;
  /** What the edits do, in words, for the approval card ("Receptacles every 12 ft, Level 2"). */
  label(text: string): void;
  /** The engineering calculations a script can run (code calcs, duct and pipe reports, service size). */
  calcs(): readonly ScriptCalcInfo[];
  /**
   * Runs one calculation, on the model as this script has it so far (earlier
   * edits included). Use the answer to decide edits (sizes, slopes, breakers).
   * Without an edition, a code calc uses its default edition: the host's
   * adopted codes are not read from a script.
   */
  calc(request: ScriptCalcRequest): RunResult;
  /** The reads the model's add-ons offer (computed answers: loads, plans, sizes, catalogues). */
  reads(): readonly ScriptReadInfo[];
  /**
   * Runs one add-on read on the model as this script has it so far. Reads
   * never edit: a plan's `command` is sent with `ctx.edit` when the script
   * keeps it. A refusal fails the run with the add-on's words.
   */
  read<T = unknown>(id: string, input?: unknown): T;
  /** The proposers the model's add-ons offer (receptacles by code spacing, cleanouts…). */
  proposers(): readonly ScriptProposerInfo[];
  /** Runs one proposer on the script's model: ghost placements with the reason and code clause for each, nothing placed. */
  propose(proposerId: string, request: ProposerRequest): ProposerAnswer;
  /** Places the ghosts kept (all of them, or a filtered list) as one edit, on their level; nothing is connected. */
  acceptGhosts(ghosts: readonly GhostPlacement[], label: string): void;
  /** Part scripts: one part type (one size of the part, usually), saved under `typeId`. */
  readonly parts: { define(typeId: string, definition: PartTypeDefinition): void };
}

/** The calculation registry scripts run (pure: no files, no network). */
const scriptCalcs = builtinCalcRegistry();

export class ScriptRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRunError";
  }
}

export interface RunScriptInput {
  readonly slice: ModelSlice;
  /** Stored values (`resolveValues`). */
  readonly values: Readonly<Record<string, ScriptValue>>;
  /** The script item's content hash: part of every id's seed. */
  readonly scriptHash: string;
  /**
   * The model's own add-ons beyond the installed first-party ones, in force
   * while each edit is decided (a sealed runner builds it from `slice.addOns`).
   * Absent: whatever is in force in this process.
   */
  readonly packs?: PackSet;
}

/** Words for the first-party trades a slice's add-ons leave out ("" when it names them all, or names none). */
function missingTradesWords(slice: ModelSlice): string {
  if (!slice.addOns) return "";
  const missing = FIRST_PARTY_PACK_IDS.filter((id) => !slice.addOns?.some((a) => a.id === id)).map((id) => firstPartyPackName(id) ?? id);
  if (missing.length === 0) return "";
  return `. This model's add-ons don't include ${missing.join(", ")}`;
}

/**
 * Runs a defined script against a slice, in this process: the runner calls
 * this inside its sandbox, the CLI on a laptop, tests in Jest. Each edit is
 * parsed with the kernel's schema and applied with `executeCommand` to a
 * working copy, so a refused step fails the run with the step and the
 * kernel's reason, and later steps see earlier ones.
 */
export async function runScript(definition: ScriptDefinition, input: RunScriptInput): Promise<ScriptOutput> {
  const kind = definition.manifest.kind;
  const seed: RunSeed = { scriptHash: input.scriptHash, values: input.values, revision: input.slice.revision };
  const random = seededRandom(seed);
  let counter = 0;
  let working: ModelState = sliceAsModel(input.slice);
  const steps: EditStep[] = [];
  const types: { typeId: string; definition: PartTypeDefinition }[] = [];
  const typeIds = new Set<string>();
  let label = "";
  const features = new Set(input.slice.features);
  const serverReads = (feature: string) => features.has(feature);
  const ctx: ScriptContext = {
    kind,
    model: sliceReader(input.slice, () => working),
    id: (prefix) => deterministicId(seed, counter++, prefix),
    random,
    label(text) {
      label = text.trim().slice(0, 160);
    },
    calcs() {
      return withPackSet(input.packs, () => scriptCalcs.list()).map((c) => ({ id: c.id, title: c.title, domain: c.domain, summary: c.summary, readsModel: c.needsModel }));
    },
    calc(request) {
      return withPackSet(input.packs, () => scriptCalcs.run({ ...request, model: working }));
    },
    editSteps(command) {
      if (typeof command !== "object" || command === null || !("type" in command) || typeof command.type !== "string") throw new ScriptRunError("editSteps takes an edit (an object with a type), e.g. a plan's command from ctx.read.");
      const steps: unknown = "commands" in command && NESTED_BATCHES.has(command.type) ? command.commands : null;
      if (Array.isArray(steps)) for (const step of steps) ctx.editSteps(step);
      else ctx.edit(command as Command);
    },
    reads() {
      return withPackSet(input.packs, () => activePackSet().items(PACK_READ_POINT)).map((r) => ({ id: r.id, label: r.label }));
    },
    read<T>(id: string, readInput?: unknown): T {
      const def = withPackSet(input.packs, () => activePackSet().items(PACK_READ_POINT).find((r) => r.id === id));
      if (!def) throw new ScriptRunError(`No add-on read "${id}" on this model. ctx.reads() lists them${missingTradesWords(input.slice)}.`);
      const out: unknown = withPackSet(input.packs, () => def.run(working, readInput ?? {}));
      if (isRefusal(out)) throw new ScriptRunError(`${def.label}: ${out.refused}`);
      return out as T;
    },
    proposers() {
      return withPackSet(input.packs, () => proposersFor(working)).map((p) => ({ id: p.id, label: p.label, hosts: p.hosts }));
    },
    propose(proposerId, request) {
      const answer = withPackSet(input.packs, () => runProposer(working, proposerId, request));
      if ("refused" in answer) throw new ScriptRunError(answer.refused);
      return answer;
    },
    acceptGhosts(ghosts, words) {
      const command = acceptGhostsCommand(working, ghosts, { label: words, partIdPrefix: deterministicId(seed, counter++, "ghost") });
      if (typeof command === "string") throw new ScriptRunError(command);
      ctx.edit(command);
    },
    edit(command) {
      if (kind === "part") throw new ScriptRunError("A part script makes part types (ctx.parts.define), not edits.");
      const n = steps.length + 1;
      const why = stepRefusal(command);
      if (why) throw new ScriptRunError(`Step ${n}: ${why}`);
      // Parsed as a one-step batch: the kernel's own check that it is a single edit a batch may hold.
      const one = { type: "batch_edits", commands: [command] };
      const parsed = withPackSet(input.packs, () => commandSchema.safeParse(one));
      if (!parsed.success) throw new ScriptRunError(`Step ${n} (${command.type}) isn't a valid edit: ${commandIssueMessage(parsed.error, one)}${missingTradesWords(input.slice)}`);
      const step = isEditBatchCommand(parsed.data) ? parsed.data.commands[0] : undefined;
      if (!step) throw new ScriptRunError(`Step ${n} (${command.type}) isn't a single edit.`);
      const result = withPackSet(input.packs, () => withUpgradePolicy(serverReads, () => executeCommand(working, step)));
      if (!result.ok) throw new ScriptRunError(`Step ${n} (${command.type}) was refused: ${result.error.message}${missingTradesWords(input.slice)}`);
      working = result.model;
      steps.push(step);
    },
    parts: {
      define(typeId, def) {
        if (kind !== "part") throw new ScriptRunError("Only a part script defines part types.");
        if (typeIds.has(typeId)) throw new ScriptRunError(`Part type ${typeId} is defined twice.`);
        typeIds.add(typeId);
        types.push({ typeId, definition: def });
      },
    },
  };
  bindWorking(ctx, { model: () => working, packs: input.packs });
  await definition.runWith(ctx, input.values);
  if (kind === "part") {
    if (types.length === 0) throw new ScriptRunError("The part script defined no part types.");
    return { kind: "part_types", types };
  }
  if (steps.length === 0) throw new ScriptRunError("The script made no edits.");
  const words = label || `${steps.length} edit${steps.length === 1 ? "" : "s"} by script`;
  return { kind: "edits", label: words, steps: steps.length, batches: chunkEdits(words, steps) };
}

/** The batches a plan may come as; each holds single edits (or, for batch_edits, more batches). */
const NESTED_BATCHES: ReadonlySet<string> = new Set(["batch_edits", "batch_documents", "batch_service_links"]);

function isRefusal(value: unknown): value is { readonly refused: string } {
  return typeof value === "object" && value !== null && "refused" in value && typeof value.refused === "string";
}

/** The kit's static check of a script's source before anything runs (library rule; same words at install). */
export function checkScriptSource(source: string): string[] {
  return scriptSourceIssues(source);
}
