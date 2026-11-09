import { z } from "zod";
import { round, roundVec } from "./geometry";
import { KernelError, TrackedReader, requireKind } from "./model";
import { networkOf } from "./network";
import { draftElements } from "./store";
import { carryJoinedEndsOfMove } from "./joins/carry";
import { translatedFlatLine } from "./placement/line-face";
import { isKernelElementKind } from "./registry/element-kinds";
import { connectorEndsTable } from "./kinds/ends";
import { hostedAt } from "./kinds/hosted";
import { asElementId, type ModelState } from "./types";
import { finish, guard, registerCommandParser, type AuthoredWrite, type ExecuteResult, type SlideLimit } from "./command-core";
import { executePartCommand, partCommandSchemas, type CommandContext, type PartCommand } from "./part-commands";
import { executeViewCommand, isViewCommand, viewCommandSchemas } from "./commands/views";
import { executeRoutingCommand, isRoutingCommand, resizeRoutedRun, routingCommandSchemas, slideRoutedBranch } from "./routing/commands";
import { connectCommandSchemas, executeConnectCommand, executeSplitDrag, isConnectCommand, splitDragRun } from "./routing/connect-commands";
import { executePipeSizeCommand, isPipeSizeCommand, pipeSizeCommandSchemas } from "./routing/pipe/size-commands";
import { executeFittingCommand, fittingCommandSchemas, isFittingCommand } from "./routing/fitting-commands";
import { executeStretchCommand, isStretchCommand, stretchCommandSchemas } from "./routing/stretch-commands";
import type { RunInsulationCommand } from "./routing/run-insulation";
import { runSizeSchema } from "./routing/types";
import { executeOrganizationCommand, isOrganizationCommand, organizationCommandSchemas } from "./organization/commands";
import { executeSiteCommand, isSiteCommand, siteCommandSchemas } from "./commands/site";
import { storedViewportOverhangs } from "./layout/sheet-layout";
import { batchCommandSchemas, executeBatchCommand, executeSteps, isBatchCommand, type StepRuns } from "./commands/batch";
import { executePartModelCommand, isPartModelCommand, partModelCommandSchemas } from "./part-model/commands";
import { executeLevelCommand, isLevelCommand, levelCommandSchemas } from "./commands/levels";
import { executeServiceLinkCommand, isServiceLinkCommand, serviceLinkCommandSchemas } from "./connections/commands";
import { catalogCommandSchemas, executeCatalogCommand, isCatalogCommand } from "./connections/catalog/commands";
import { executeServiceBatchCommand, isServiceBatchCommand, serviceBatchCommandSchemas } from "./connections/batch";
import { executeProposeCommand, isProposeCommand, proposeCommandSchemas } from "./propose/commands";
import { architectureCommandSchemas, executeArchitectureCommand, isArchitectureCommand } from "./commands/architecture";
import { elementCommandSchemas, executeElementCommand, isElementCommand } from "./elements/commands";
import { executeSystemGraphicsCommand, isSystemGraphicsCommand, systemGraphicsCommandSchemas } from "./routing/system-graphics";
import { executeLoadPointCommand, isLoadPointCommand, loadPointCommandSchemas } from "./load-points/commands";
import { executeSpatialCommand, isSpatialCommand, spatialCommandSchemas } from "./commands/spatial";
import { executeSpaceCommand, isSpaceCommand, spaceCommandSchemas } from "./spaces/commands";
import { blockCommandSchemas, executeBlockCommand, isBlockCommand } from "./blocks/commands";
import { executeQuestionCommand, isQuestionCommand, questionCommandSchemas } from "./questions/commands";
import { executeSubmittalCommand, isSubmittalCommand, submittalCommandSchemas } from "./submittals/commands";
import { executeGraphCommand, graphCommandSchemas, isGraphCommand } from "./graph/commands";
import { executeLifecycleCommand, isLifecycleCommand, lifecycleCommandSchemas } from "./lifecycle/commands";
import { executeRecordFindingDisposition, recordFindingDispositionSchema } from "./findings/record";
import { ceilingCommandSchemas, executeCeilingCommand, isCeilingCommand } from "./ceilings/commands";
import { classificationCommandSchemas, executeClassificationCommand, isClassificationCommand } from "./classification/commands";
import { constructionCommandSchemas, executeConstructionCommand, isConstructionCommand } from "./construction/commands";

import { describeCommandIssue, strictCommands } from "./strict-commands";
import { executeMountingPlaneCommand, isMountingPlaneCommand, mountingPlaneCommandSchemas } from "./mounting-plane";
import { executeFlexCommand, flexCommandSchemas, isFlexCommand } from "./routing/flex";
import { connectIntoCommandSchemas, executeConnectIntoCommand, isConnectIntoCommand, registerConnectIntoExecutor } from "./routing/connect-into";
import { executeSheetSetCommand, isSheetSetCommand, sheetSetCommandSchemas } from "./commands/sheet-sets";
import { documentStepCommandSchemas, executeDocumentStepCommand, isDocumentStepCommand } from "./commands/document-steps";
import { landMergePart } from "./branches/merge";
import { IMPORT_SERVER_ONLY_REFUSAL, landImportChunk } from "./import/apply";
import { defineExtensionPoint } from "./packs/contract";
import { activePackSet, withModelStatePacks } from "./packs/scope";
import { firstPartyBaseRevision, packNotLoadedMessage, packSetReadsRecorded, type PackSet } from "./packs/set";
import { firstPartyCommandOwner, firstPartyStoredOwner } from "./packs/first-party/manifests";
import "./schema-version/edit-hook";
import "./kinds/edit-hook";
import "./kinds/records";
import "./services/write-gate";

export * from "./command-core";

const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });
const profileSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("rect"), width: z.number().positive(), height: z.number().positive() }),
  z.object({ shape: z.literal("round"), diameter: z.number().positive() }),
]);

/** Every intent command that is one edit on its own (no batches): what a `batch_edits` step may be. */
const editStepOptions = strictCommands([
  z.object({ type: z.literal("slide_branch"), tapId: z.string().min(1), s: z.number().finite() }),
  /** Any run: a legacy run's add-on says which sizes it takes (its claimed case); routed runs take any size of their kind. */
  z.object({ type: z.literal("resize_run"), segmentId: z.string().min(1), profile: runSizeSchema }),
  z.object({ type: z.literal("move_equipment"), equipmentId: z.string().min(1), delta: vec2Schema }),
  z.object({
    type: z.literal("move_wall"),
    wallId: z.string().min(1),
    delta: vec2Schema,
    /** Leave the walls joined to it where they are (Revit's Disjoin); absent: their joined ends follow. */
    disjoin: z.boolean().optional(),
  }),
  z.object({ type: z.literal("resize_riser"), riserId: z.string().min(1).max(200), profile: profileSchema }),
  z.object({ type: z.literal("set_tag_text"), tagId: z.string().min(1), text: z.string().min(1).max(200) }),
  z.object({ type: z.literal("move_tag"), tagId: z.string().min(1), offset: vec2Schema }),
  ...partCommandSchemas,
  ...viewCommandSchemas,
  ...routingCommandSchemas,
  ...connectCommandSchemas,
  ...pipeSizeCommandSchemas,
  ...fittingCommandSchemas,
  ...stretchCommandSchemas,
  ...organizationCommandSchemas,
  ...siteCommandSchemas,
  ...partModelCommandSchemas,
  ...levelCommandSchemas,
  ...serviceLinkCommandSchemas,
  ...catalogCommandSchemas,
  ...proposeCommandSchemas,
  ...architectureCommandSchemas,
  ...elementCommandSchemas,
  ...systemGraphicsCommandSchemas,
  ...loadPointCommandSchemas,
  ...spatialCommandSchemas,
  ...spaceCommandSchemas,
  ...blockCommandSchemas,
  ...questionCommandSchemas,
  ...submittalCommandSchemas,
  ...graphCommandSchemas,
  ...lifecycleCommandSchemas,
  recordFindingDispositionSchema,
  ...ceilingCommandSchemas,
  ...classificationCommandSchemas,
  ...constructionCommandSchemas,
  ...mountingPlaneCommandSchemas,
  ...flexCommandSchemas,
  ...connectIntoCommandSchemas,
  ...sheetSetCommandSchemas,
  ...documentStepCommandSchemas,
]);

export const MAX_EDIT_BATCH_STEPS = 500;

/** A pack command as the dispatcher carries it: its `type` and the fields its own schema checked. */
export interface PackCommand {
  readonly type: string;
  readonly [field: string]: unknown;
}

/**
 * Pack commands typed by field, by declaration merging: an add-on names each
 * of its command types with its typed shape, and `Command` includes them in
 * every compile that includes the add-on. The kernel names none.
 *
 * ```ts
 * declare module "@permitzip/bim-kernel/commands" {
 *   interface PackCommandTypes { zz_place_widget: PlaceWidgetCommand }
 * }
 * ```
 */
export interface PackCommandTypes {
  /** Not a command type: keeps the interface non-empty; `TypedPackCommand` skips it. */
  readonly kernel?: never;
}

/** Every command type an add-on in this compile names in `PackCommandTypes`. */
export type TypedPackCommand = Exclude<PackCommandTypes[keyof PackCommandTypes], undefined>;

/**
 * One command a pack adds (v1): a `type` no kernel command uses, a strict
 * zod object whose `type` is `z.literal(type)`, and what it does. It parses
 * and runs like a kernel command (alone, or as a `batch_edits` step) only
 * while its pack is in the model's set.
 */
export interface PackCommandDef {
  readonly type: string;
  readonly schema: z.ZodObject;
  execute(model: ModelState, command: PackCommand, context: CommandContext): ExecuteResult;
  /**
   * Consecutive steps of this type in one `batch_edits`, run as one edit: the
   * same model and the same accept / refuse outcome as running them one by
   * one, derived and validated once. A refusal is re-run step by step to name
   * its step. Absent: each step runs alone.
   */
  runs?(model: ModelState, steps: readonly PackCommand[]): ExecuteResult;
  /**
   * A kernel command's case for kinds this add-on owns (round 11): the
   * kernel parses and stores `command` under its own name and intents, and
   * runs this def's `execute` with it when its target is one of `kinds`. A
   * def that claims is never parsed as a command of its own `type`. Without
   * the add-on the case is refused in words, naming the add-on
   * (`packNotLoadedMessage`).
   */
  readonly claims?: PackCommandClaim;
}

/** Which kernel command's case a pack command def runs (`PackCommandDef.claims`). */
export interface PackCommandClaim {
  /** A kernel command type whose target is one element (`slide_branch`, `resize_run`, `move_equipment`). */
  readonly command: string;
  /** The stored kinds of that target this def handles. */
  readonly kinds: readonly string[];
}

/** Kernel commands whose case for a kind the kernel doesn't own an add-on may claim, and the field naming the target element. */
const CLAIMABLE_TARGETS: Readonly<Record<string, string>> = { slide_branch: "tapId", resize_run: "segmentId", move_equipment: "equipmentId" };

/** Commands packs add, by `type`. Ids are the stored command types, so they stay bare for first-party packs. */
export const COMMAND_POINT = defineExtensionPoint<PackCommandDef>({ id: "kernel.command", version: 1, label: "Commands", idOf: (c) => c.type, namespaced: false });

const KERNEL_STEP_TYPES: ReadonlySet<string> = new Set(editStepOptions.flatMap((s) => (s.shape.type instanceof z.ZodLiteral && typeof s.shape.type.value === "string" ? [s.shape.type.value] : [])));

interface PackCommandTables {
  /** Commands parsed by their own type. */
  readonly byType: ReadonlyMap<string, PackCommandDef>;
  /** Claimed kernel command cases, by `command` and target kind. */
  readonly claims: ReadonlyMap<string, PackCommandDef>;
}

let lastCommands: { readonly set: PackSet; readonly base: number; readonly table: PackCommandTables } | null = null;

function claimKey(command: string, kind: string): string {
  return `${command}\u0000${kind}`;
}

function refuseTable(message: string): never {
  const full = `[bim-kernel/commands] ${message}`;
  console.error(full);
  throw new Error(full);
}

/** The set in force's pack commands by type and the kernel cases they claim, built once per set. A pack row that reuses a kernel command type, or claims a case another row claims, is refused. */
function packCommandTable(): PackCommandTables {
  const set = activePackSet();
  const base = firstPartyBaseRevision();
  if (lastCommands !== null && lastCommands.set === set && lastCommands.base === base && !packSetReadsRecorded()) return lastCommands.table;
  const table = set.memo("kernel.command#table", (): PackCommandTables => {
    const byType = new Map<string, PackCommandDef>();
    const claims = new Map<string, PackCommandDef>();
    for (const def of set.items(COMMAND_POINT)) {
      if (KERNEL_STEP_TYPES.has(def.type) || KERNEL_ONLY_TYPES.has(def.type)) refuseTable(`a pack command reuses the kernel command type "${def.type}"`);
      const claim = def.claims;
      if (claim === undefined) {
        byType.set(def.type, def);
        continue;
      }
      if (CLAIMABLE_TARGETS[claim.command] === undefined) refuseTable(`pack command ${def.type} claims "${claim.command}", which isn't a kernel command an add-on may claim (${Object.keys(CLAIMABLE_TARGETS).join(", ")})`);
      if (claim.kinds.length === 0) refuseTable(`pack command ${def.type} claims ${claim.command} for no kind`);
      for (const kind of claim.kinds) {
        if (isKernelElementKind(kind)) refuseTable(`pack command ${def.type} claims ${claim.command} for ${kind}, one of the kernel's own kinds`);
        const had = claims.get(claimKey(claim.command, kind));
        if (had !== undefined) refuseTable(`pack commands ${had.type} and ${def.type} both claim ${claim.command} for ${kind}`);
        claims.set(claimKey(claim.command, kind), def);
      }
    }
    return { byType, claims };
  });
  lastCommands = { set, base, table };
  return table;
}

/** The pack command of this type in the set in force, or null. A def that claims a kernel case is not a command of its own type. */
export function packCommand(type: string): PackCommandDef | null {
  return packCommandTable().byType.get(type) ?? null;
}

/** The pack command def that runs `command`'s case for a target of `kind` in the set in force (`PackCommandDef.claims`), or null. */
export function claimedCommandCase(command: string, kind: string): PackCommandDef | null {
  return packCommandTable().claims.get(claimKey(command, kind)) ?? null;
}

/**
 * Run a claimable kernel command whose target isn't a kernel kind: the
 * add-on that claims the case runs it; without one, the case is refused in
 * words (naming the first-party add-on that owns it when one does). Null
 * when the target is missing or a kernel kind (the kernel's own case).
 */
function runClaimedCase(model: ModelState, command: KernelCommand, context: CommandContext): ExecuteResult | null {
  const field = CLAIMABLE_TARGETS[command.type];
  if (field === undefined) return null;
  const targetId: unknown = Reflect.get(command, field);
  const target = typeof targetId === "string" ? model.elements[targetId] : undefined;
  if (target === undefined || isKernelElementKind(target.kind)) return null;
  const def = claimedCommandCase(command.type, target.kind);
  if (def) return def.execute(model, command, context);
  const owner = firstPartyStoredOwner("claim", command.type);
  if (owner !== null && !activePackSet().has(owner)) return { ok: false, error: { code: "invalid_value", message: packNotLoadedMessage(owner), elementIds: [target.id] } };
  return { ok: false, error: { code: "wrong_kind", message: unclaimedCase(command.type, target.id, target.kind), elementIds: [target.id] } };
}

/** The refusal for a claimable command on an element no add-on (and not the kernel) handles it for. */
function unclaimedCase(command: string, id: string, kind: string): string {
  return `${id} is a ${kind}, and no add-on on this model handles ${command.replace(/_/g, " ")} for one`;
}

function typeOf(raw: unknown): string | null {
  return typeof raw === "object" && raw !== null && "type" in raw && typeof raw.type === "string" ? raw.type : null;
}

/**
 * Wave-1 typing (round 6): a parsed pack command, checked by its own strict
 * schema, travels in the `Command` type so the many callers that narrow on
 * `command.type` keep compiling. Only `executeCommand` reads it, and it
 * dispatches any type it doesn't know to the pack (`PackCommand`). A pack
 * that names its command in `PackCommandTypes` is typed exactly; another
 * pack's is typed by type only.
 */
/** A checked schema's issue, re-raised as it was (same code, path, message). */
function rawIssue(issue: z.core.$ZodIssue): z.core.$ZodRawIssue {
  switch (issue.code) {
    case "unrecognized_keys":
      return { ...issue, input: isRecord(issue.input) ? issue.input : undefined };
    case "invalid_format":
      return { ...issue, input: issue.input };
    case "not_multiple_of":
      return { ...issue, input: issue.input };
    default:
      return { ...issue, input: issue.input };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackCommandShape(value: unknown): value is TypedPackCommand | RunInsulationCommand {
  return typeOf(value) !== null;
}

/**
 * Check `raw` against the kernel's schema for its type, or the pack command
 * of that type in the set in force. Issues are the chosen schema's own, so a
 * refusal reads exactly as before packs. A first-party command whose pack
 * isn't loaded is refused in words, naming the add-on (`packNotLoadedMessage`).
 */
function routed<K extends z.ZodType>(kernel: K, kernelTypes: ReadonlySet<string>) {
  return z.unknown().transform((raw, ctx): z.output<K> | TypedPackCommand | RunInsulationCommand => {
    const type = typeOf(raw);
    const pack = type !== null && !kernelTypes.has(type) ? packCommand(type) : null;
    if (pack) {
      const r = pack.schema.safeParse(raw);
      if (r.success && isPackCommandShape(r.data)) return r.data;
      if (r.success) {
        ctx.issues.push({ code: "custom", message: `${type}: the pack's schema dropped its type`, input: raw, path: ["type"] });
        return z.NEVER;
      }
      for (const issue of r.error.issues) ctx.issues.push(rawIssue(issue));
      return z.NEVER;
    }
    const owner = type !== null && !kernelTypes.has(type) ? firstPartyCommandOwner(type) : null;
    if (owner) {
      ctx.issues.push({ code: "custom", message: packNotLoadedMessage(owner), input: raw, path: ["type"] });
      return z.NEVER;
    }
    const r = kernel.safeParse(raw);
    if (r.success) return r.data;
    for (const issue of r.error.issues) ctx.issues.push(rawIssue(issue));
    return z.NEVER;
  });
}

const kernelStepSchema = z.discriminatedUnion("type", editStepOptions);
const editStepSchema = routed(kernelStepSchema, KERNEL_STEP_TYPES);

/**
 * Many model edits as one: one revision, one changeset, one undo step, all or
 * nothing (a 500-cell schedule paste). Each step runs on the result of the
 * steps before it under the same rules as when sent alone; the commit checks
 * the union of what they read against the head, as for one command. Undo is
 * not a step: undo the batch's revision instead.
 */
export const editBatchCommandSchemas = [
  z.object({
    type: z.literal("batch_edits"),
    /** What the batch does, in words, for the approval card and history ("Paste 500 CFM values"). */
    label: z.string().trim().min(1).max(160).optional(),
    commands: z.array(editStepSchema).min(1).max(MAX_EDIT_BATCH_STEPS),
  }),
] as const;

/**
 * Server-only commands: the model server builds them, a client never sends
 * them (the sync hub refuses one in a client's `command` message, and each
 * refuses here without what only the server supplies). `merge_branch_part`
 * lands one approved part of a branch on Main as one ordinary revision; the
 * records come in `CommandContext.mergeLanding` from the server's own
 * recomputed merge, never from the wire.
 */
export const serverCommandSchemas = strictCommands([
  z.object({
    type: z.literal("merge_branch_part"),
    branchModelId: z.string().min(1).max(300),
    discipline: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(160),
  }),
  /** One chunk of a linked model's import on a new branch (import/apply.ts); the records come in `CommandContext.importLanding`. */
  z.object({
    type: z.literal("import_elements"),
    sourceId: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(160),
    chunk: z.number().int().min(1),
    of: z.number().int().min(1),
  }),
]);

export type ServerCommand = z.infer<(typeof serverCommandSchemas)[number]>;

export const SERVER_ONLY_COMMAND_TYPES: ReadonlySet<string> = new Set(serverCommandSchemas.map((s) => s.shape.type.value));

/** A command only the model server may build (refuse it when a client sends it). */
export function isServerOnlyCommand(command: { readonly type: string }): boolean {
  return SERVER_ONLY_COMMAND_TYPES.has(command.type);
}

export const SERVER_ONLY_COMMAND_REFUSAL = "Merges land only through Merge approved parts on a branch. Nothing changed.";

/** The words a client hears for a server-only command it sent itself. */
export function serverOnlyCommandRefusal(type: string): string {
  return type === "import_elements" ? IMPORT_SERVER_ONLY_REFUSAL : SERVER_ONLY_COMMAND_REFUSAL;
}

/** Intent commands, each strict. Humans and agents send exactly these, or a command of a pack in the model's set; nothing else. */
export const commandSchemaOptions = strictCommands([...editStepOptions, ...batchCommandSchemas, ...serviceBatchCommandSchemas, ...editBatchCommandSchemas, ...serverCommandSchemas]);
const kernelCommandSchema = z.discriminatedUnion("type", commandSchemaOptions);
const KERNEL_TYPES: ReadonlySet<string> = new Set(commandSchemaOptions.flatMap((s) => (s.shape.type instanceof z.ZodLiteral && typeof s.shape.type.value === "string" ? [s.shape.type.value] : [])));
const KERNEL_ONLY_TYPES: ReadonlySet<string> = new Set([...KERNEL_TYPES].filter((t) => !KERNEL_STEP_TYPES.has(t)));
/** The kernel's own commands. */
export type KernelCommand = z.infer<typeof kernelCommandSchema>;
/**
 * Every command a caller may build with its fields typed: the kernel's, plus
 * (wave 1) the first-party packs' typed commands. `commandSchema` also passes
 * any pack command of the set in force, as a `PackCommand` envelope.
 */
export type Command = KernelCommand | TypedPackCommand | RunInsulationCommand;
/** `options`: the kernel's own command schemas (a pack's are rows of `COMMAND_POINT`). */
export const commandSchema = Object.assign(routed(kernelCommandSchema, KERNEL_TYPES), { options: commandSchemaOptions });

registerCommandParser((raw) => commandSchema.safeParse(raw));

/** Why `input` isn't a command, in words: an unknown key is named with what the command takes instead. */
export function commandIssueMessage(error: z.ZodError, input: unknown): string {
  const type = typeOf(input);
  const pack = type !== null && !KERNEL_TYPES.has(type) ? packCommand(type) : null;
  return describeCommandIssue(pack ? [...commandSchemaOptions, pack.schema] : commandSchemaOptions, error, input);
}

export type EditBatchCommand = z.infer<(typeof editBatchCommandSchemas)[number]>;

export function isEditBatchCommand(command: { readonly type: string }): command is EditBatchCommand {
  return command.type === "batch_edits";
}

type EditStep = EditBatchCommand["commands"][number];

/** Consecutive steps of one pack command that runs them together (`PackCommandDef.runs`). */
const packCommandRuns: StepRuns<EditStep> = {
  lengthAt(steps, at) {
    const type = steps[at]?.type;
    if (type === undefined || KERNEL_STEP_TYPES.has(type) || !packCommand(type)?.runs) return 1;
    let end = at;
    while (steps[end]?.type === type) end += 1;
    return end - at;
  },
  run(model, steps) {
    const type = steps[0]?.type;
    const def = type === undefined ? null : packCommand(type);
    if (!def?.runs) throw new KernelError("invalid_value", `A ${type ?? "missing"} step can't run with others of its kind`, []);
    const run = def.runs;
    return withModelStatePacks(model, () => run(model, steps));
  },
};

function executeEditBatch(model: ModelState, command: EditBatchCommand, context: CommandContext = {}): ExecuteResult {
  const steps = command.commands;
  const undoAt = steps.findIndex((step) => step.type === "undo");
  if (undoAt >= 0) return { ok: false, error: { code: "invalid_value", message: `Step ${undoAt + 1} of ${steps.length} is an undo; undo the batch's revision on its own instead`, elementIds: [] } };
  // Each step is decided as the same person at the same time (questions record who replied).
  const who: CommandContext = { actorId: context.actorId, actor: context.actor, at: context.at };
  return executeSteps(model, steps, (m, step) => executeCommand(m, step, who), command.label ?? "Batch of edits", packCommandRuns);
}

function isPartCommand(command: Command): command is PartCommand {
  if (isEditBatchCommand(command) || isBatchCommand(command) || isViewCommand(command) || isRoutingCommand(command) || isConnectCommand(command) || isPipeSizeCommand(command) || isFittingCommand(command) || isStretchCommand(command) || isOrganizationCommand(command) || isSiteCommand(command) || isPartModelCommand(command) || isLevelCommand(command) || isServiceLinkCommand(command) || isCatalogCommand(command) || isServiceBatchCommand(command) || isMountingPlaneCommand(command) || isFlexCommand(command) || isConnectIntoCommand(command) || isSheetSetCommand(command) || isDocumentStepCommand(command) || isSpatialCommand(command) || isSpaceCommand(command) || isBlockCommand(command) || isQuestionCommand(command) || isSubmittalCommand(command) || isGraphCommand(command) || isLifecycleCommand(command) || command.type === "record_finding_disposition" || isCeilingCommand(command) || isClassificationCommand(command) || isConstructionCommand(command) || isLoadPointCommand(command) || isSystemGraphicsCommand(command) || isProposeCommand(command) || !KERNEL_TYPES.has(command.type) || isArchitectureCommand(command) || isElementCommand(command)) return false;
  switch (command.type) {
    case "slide_branch":
    case "resize_run":
    case "move_equipment":
    case "move_wall":
    case "resize_riser":
    case "set_tag_text":
    case "move_tag":
      return false;
    default:
      return true;
  }
}

/** A views and sheets edit that leaves a viewport running past its sheet's drawing area says so (it still saves: a frame can be fixed after). */
function withViewportWarnings(result: ExecuteResult): ExecuteResult {
  if (!result.ok) return result;
  const found = storedViewportOverhangs(result.model, result.changedIds);
  if (found.length === 0) return result;
  return { ...result, summary: [...(result.summary ?? []), ...found.map((o) => o.message)] };
}

registerConnectIntoExecutor((model, command) => executeCommand(model, command));

/**
 * Run one intent command against a model. `context.history` (committed
 * changesets from the undo target onward) is needed only by `undo`. Runs
 * with the model's bound pack set in force (`packs/scope.ts`); built-ins
 * when the host bound none.
 */
export function executeCommand(model: ModelState, command: Command | PackCommand, context: CommandContext = {}): ExecuteResult {
  return withModelStatePacks(model, () => (isKernelCommand(command) ? executeCommandInScope(model, command, context) : executePackCommand(model, command, context)));
}

function isKernelCommand(command: Command | PackCommand): command is KernelCommand {
  return KERNEL_TYPES.has(command.type);
}

/** A pack command, dispatched by `type` to the set in force; refused in words when its pack isn't in that set. */
function executePackCommand(model: ModelState, command: PackCommand, context: CommandContext): ExecuteResult {
  const def = packCommand(command.type);
  if (def) return def.execute(model, command, context);
  const owner = firstPartyCommandOwner(command.type);
  return { ok: false, error: { code: "invalid_value", message: owner ? packNotLoadedMessage(owner) : `"${command.type}" isn't a command this model's add-ons know`, elementIds: [] } };
}

function executeCommandInScope(model: ModelState, command: KernelCommand, context: CommandContext): ExecuteResult {
  if (command.type === "merge_branch_part") {
    const landing = context.mergeLanding;
    if (!landing) return { ok: false, error: { code: "forbidden", message: SERVER_ONLY_COMMAND_REFUSAL, elementIds: [] } };
    return guard(() => landMergePart(model, landing.writes, { add: landing.add, remove: landing.remove }));
  }
  if (command.type === "import_elements") {
    const landing = context.importLanding;
    if (!landing) return { ok: false, error: { code: "forbidden", message: IMPORT_SERVER_ONLY_REFUSAL, elementIds: [] } };
    return guard(() => landImportChunk(model, landing.records));
  }
  if (isEditBatchCommand(command)) return executeEditBatch(model, command, context);
  if (isBatchCommand(command)) return withViewportWarnings(executeBatchCommand(model, command));
  if (isViewCommand(command)) return withViewportWarnings(executeViewCommand(model, command));
  if (isRoutingCommand(command)) return guard(() => executeRoutingCommand(model, command));
  if (isConnectCommand(command)) return guard(() => executeConnectCommand(model, command, executeCommand));
  if (isPipeSizeCommand(command)) return guard(() => executePipeSizeCommand(model, command, executeCommand));
  if (command.type === "drag_run") {
    // Along a piece and square to it at once is two drags; they save as one.
    const split = splitDragRun(model, command);
    if (split) return guard(() => executeSplitDrag(model, split, executeCommand));
  }
  if (isFittingCommand(command)) return guard(() => executeFittingCommand(model, command));
  if (isStretchCommand(command)) return guard(() => executeStretchCommand(model, command));
  if (isOrganizationCommand(command)) return executeOrganizationCommand(model, command);
  if (isSiteCommand(command)) return executeSiteCommand(model, command);
  if (isPartModelCommand(command)) return guard(() => executePartModelCommand(model, command));
  if (isLevelCommand(command)) return executeLevelCommand(model, command);
  if (isServiceLinkCommand(command)) return executeServiceLinkCommand(model, command);
  if (isCatalogCommand(command)) return executeCatalogCommand(model, command);
  if (isServiceBatchCommand(command)) return executeServiceBatchCommand(model, command);
  if (isProposeCommand(command)) return executeProposeCommand(model, command);
  if (isArchitectureCommand(command)) return executeArchitectureCommand(model, command);
  if (isElementCommand(command)) return executeElementCommand(model, command, { actorId: context.actorId });
  if (isSystemGraphicsCommand(command)) return guard(() => executeSystemGraphicsCommand(model, command));
  if (isLoadPointCommand(command)) return executeLoadPointCommand(model, command);
  if (isSpatialCommand(command)) return executeSpatialCommand(model, command);
  if (isSpaceCommand(command)) return executeSpaceCommand(model, command);
  if (isBlockCommand(command)) return executeBlockCommand(model, command);
  if (isQuestionCommand(command)) return executeQuestionCommand(model, command, { actorId: context.actorId, actor: context.actor, at: context.at });
  if (isSubmittalCommand(command)) return executeSubmittalCommand(model, command, { actorId: context.actorId, actor: context.actor, at: context.at });
  if (isGraphCommand(command)) return executeGraphCommand(model, command);
  if (isLifecycleCommand(command)) return executeLifecycleCommand(model, command);
  if (command.type === "record_finding_disposition") return executeRecordFindingDisposition(model, command, context);
  if (isCeilingCommand(command)) return executeCeilingCommand(model, command);
  if (isClassificationCommand(command)) return executeClassificationCommand(model, command);
  if (isConstructionCommand(command)) return executeConstructionCommand(model, command);
  if (isMountingPlaneCommand(command)) return guard(() => executeMountingPlaneCommand(model, command, executeCommand));
  if (isFlexCommand(command)) return guard(() => executeFlexCommand(model, command));
  if (isConnectIntoCommand(command)) return guard(() => executeConnectIntoCommand(model, command, executeCommand));
  if (isSheetSetCommand(command)) return executeSheetSetCommand(model, command);
  if (isDocumentStepCommand(command)) return executeDocumentStepCommand(model, command);
  if (isPartCommand(command)) return guard(() => executePartCommand(model, command, context));
  // A legacy command's case for an add-on's kind runs in the add-on that claims it.
  const claimed = runClaimedCase(model, command, context);
  if (claimed !== null) return claimed;
  return guard(() => {
    const reader = new TrackedReader(model);
    switch (command.type) {
      case "slide_branch": {
        const target = reader.get(asElementId(command.tapId));
        if (target.kind === "run_fitting") return slideRoutedBranch(model, target.id, command.s);
        throw new KernelError("wrong_kind", unclaimedCase(command.type, target.id, target.kind), [target.id]);
      }
      case "resize_run": {
        const target = reader.get(asElementId(command.segmentId));
        if (target.kind === "run_segment") return resizeRoutedRun(model, target.id, command.profile);
        throw new KernelError("wrong_kind", unclaimedCase(command.type, target.id, target.kind), [target.id]);
      }
      case "move_equipment": {
        const target = reader.get(asElementId(command.equipmentId));
        throw new KernelError("wrong_kind", unclaimedCase(command.type, target.id, target.kind), [target.id]);
      }
      case "move_wall": {
        const wall = requireKind(reader.get(asElementId(command.wallId)), "wall");
        const d = roundVec(command.delta);
        const moved = translatedFlatLine(wall, d, wall.thickness);
        const working = draftElements(model.elements);
        working[wall.id] = moved;
        // Hosted doors and windows, and annotations on all of them, re-derive in `finish`.
        for (const dep of networkOf(model).dependents(wall.id)) reader.get(dep);
        const authored: AuthoredWrite[] = [
          { elementId: wall.id, field: "start", value: moved.start },
          { elementId: wall.id, field: "end", value: moved.end },
        ];
        const touched = new Set([wall.id]);
        // The walls joined to it follow, so its corners and tees stay closed.
        if ((d.x !== 0 || d.y !== 0) && command.disjoin !== true) carryJoinedEndsOfMove(model, reader, working, touched, authored, new Map([[wall.id as string, d]]));
        return finish(reader, working, touched, authored, () =>
          authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })),
        );
      }
      case "resize_riser": {
        const segments = networkOf(model).riserSegments(command.riserId);
        if (segments.length === 0) {
          throw new KernelError("element_not_found", `Riser ${command.riserId} does not exist`, []);
        }
        const working = draftElements(model.elements);
        const authored: AuthoredWrite[] = [];
        for (const id of segments) {
          const seg = requireKind(reader.get(id), "riser_segment");
          working[id] = { ...seg, profile: command.profile };
          authored.push({ elementId: id, field: "profile", value: command.profile });
        }
        return finish(reader, working, segments, authored, () =>
          authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })),
        );
      }
      case "set_tag_text": {
        const tag = requireKind(reader.get(asElementId(command.tagId)), "tag");
        const working = draftElements(model.elements);
        working[tag.id] = { ...tag, text: command.text };
        return finish(reader, working, [tag.id], [{ elementId: tag.id, field: "text", value: command.text }], () => [
          { kind: "field_equals", elementId: tag.id, field: "text", value: command.text },
        ]);
      }
      case "move_tag": {
        const tag = requireKind(reader.get(asElementId(command.tagId)), "tag");
        reader.get(tag.targetId);
        const offset = roundVec(command.offset);
        const working = draftElements(model.elements);
        working[tag.id] = { ...tag, offset };
        return finish(reader, working, [tag.id], [{ elementId: tag.id, field: "offset", value: offset }], () => [
          { kind: "field_equals", elementId: tag.id, field: "offset", value: offset },
        ]);
      }
    }
  });
}

/**
 * The furthest valid position toward a requested slide, and the constraint
 * that stops it. Used for the drag preview: we never silently clamp; the UI
 * shows the binding constraint and commits the accepted position.
 */
export function slideLimit(model: ModelState, tapId: string, requested: number): SlideLimit {
  const tap = model.elements[tapId];
  // A placed hosted record (its row's `hostedBy.placement`) slides from where it sits along its host; a routed branch from its host station.
  const placement = tap ? connectorEndsTable().placement(tap.kind) : null;
  const startS = tap && placement ? hostedAt(tap, placement)?.s : tap?.kind === "run_fitting" ? tap.host?.s : undefined;
  if (startS === undefined) {
    return { requested, accepted: requested, binding: { code: "element_not_found", message: `${tapId} not found` } };
  }
  // Walk the drag path: a slide may not pass *through* an invalid stretch
  // (e.g. a run shorter than its minimum) even if the far side is valid.
  const dir = Math.sign(requested - startS);
  let lastValid = startS;
  let binding: SlideLimit["binding"] = null;
  for (const step of [100, 10, 1]) {
    let s = lastValid;
    while (dir !== 0 && (dir > 0 ? s + step * dir <= requested : s + step * dir >= requested)) {
      const candidate = s + step * dir;
      const res = executeCommand(model, { type: "slide_branch", tapId, s: candidate });
      if (!res.ok) {
        binding = { code: res.error.code, message: res.error.message };
        break;
      }
      s = candidate;
    }
    lastValid = s;
  }
  if (!binding) {
    const final = executeCommand(model, { type: "slide_branch", tapId, s: requested });
    if (final.ok) return { requested, accepted: requested, binding: null };
    binding = { code: final.error.code, message: final.error.message };
  }
  return { requested, accepted: round(lastValid), binding };
}
