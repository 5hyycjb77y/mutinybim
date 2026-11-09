import { z } from "zod";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult, TrackedReader, GLOBAL_PARTITION, draftElements, asElementId, type BimElement, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { chainAt } from "./chains";
import { isNamedVerticalRun, isVerticalRunRecord, namedVerticalRuns, putVerticalRun, VERTICAL_RUN_FIELD, verticalRunFingerprint, verticalRunSettings } from "./element";
import { nextStackNumber, stackFilter } from "./stacks";
import { VERTICAL_RUN_SETTINGS_ID, type NamedVerticalRun, type VerticalRunElement, type VerticalRunSettings } from "./types";

/**
 * Stack edits: name the drawn vertical runs, renumber them, override the codes
 * their tags print, and turn the base-of-stack check on or off. The Stacks
 * panel, Properties and the agent tools all send these. Every edit undoes as
 * one step; refusals say what to do instead.
 */

const id = z.string().trim().min(1).max(200);
const number = z.string().trim().min(1).max(12);
const code = z.string().trim().min(1).max(24);

const stackInput = z
  .object({
    /** Chosen by the sender so a retried request names the same stack, not a second one. */
    stackId: id,
    /** Any vertical piece of the run. */
    pipeId: id,
    /** Absent: the next free number. */
    number: number.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    systemCode: code.optional(),
    serves: code.optional(),
  })
  .strict();

export const verticalRunCommandSchemas = [
  z.object({ type: z.literal("name_stacks"), stacks: z.array(stackInput).min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("edit_stack"),
      stackId: id,
      number: number.optional(),
      /** `null` clears it. */
      name: z.string().trim().min(1).max(60).nullable().optional(),
      /** `null`: back to the letter from the pipe system. */
      systemCode: code.nullable().optional(),
      /** `null`: back to the rooms its branches reach. */
      serves: code.nullable().optional(),
      /** Point the name at the run through this pipe (the old pipe was redrawn). */
      pipeId: id.optional(),
    })
    .strict(),
  z.object({ type: z.literal("delete_stacks"), stackIds: z.array(id).min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("set_stack_checks"),
      /** Pipe diameters a branch must stay from a stack's base bend or an offset bend; null turns the check off. */
      baseClearanceDiameters: z.number().finite().min(1).max(20).nullable(),
    })
    .strict(),
] as const;

export const verticalRunCommandSchema = z.discriminatedUnion("type", [...verticalRunCommandSchemas]);
export type VerticalRunCommand = z.infer<typeof verticalRunCommandSchema>;

// Callers build the stack commands with their fields typed, as a `Command`; the kernel names no pack command itself.
declare module "@permitzip/bim-kernel/commands" {
  interface PackCommandTypes {
    name_stacks: Extract<VerticalRunCommand, { type: "name_stacks" }>;
    edit_stack: Extract<VerticalRunCommand, { type: "edit_stack" }>;
    delete_stacks: Extract<VerticalRunCommand, { type: "delete_stacks" }>;
    set_stack_checks: Extract<VerticalRunCommand, { type: "set_stack_checks" }>;
  }
}

const COMMANDS: ReadonlySet<string> = new Set(verticalRunCommandSchemas.map((s) => s.shape.type.value));

export function isVerticalRunCommand(command: { readonly type: string }): command is VerticalRunCommand {
  return COMMANDS.has(command.type);
}

// ---------------------------------------------------------------- edit plumbing

interface Edit {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[];
  readonly authored: AuthoredWrite[];
  readonly removed: ElementId[];
  readonly summary: string[];
}

function begin(model: ModelState): Edit {
  return { reader: new TrackedReader(model), working: draftElements(model.elements), touched: [], authored: [], removed: [], summary: [] };
}

function done(e: Edit): ExecuteResult {
  return finish(e.reader, e.working, e.touched, e.authored, () => [], { removedIds: e.removed, summary: e.summary });
}

function put(e: Edit, r: VerticalRunElement): void {
  putVerticalRun(e.working, r);
  e.touched.push(r.id);
  e.authored.push({ elementId: r.id, field: VERTICAL_RUN_FIELD, value: verticalRunFingerprint(r) });
}

function currentStack(e: Edit, sid: string): NamedVerticalRun {
  const key = asElementId(sid);
  const el: { readonly kind: string } | undefined = e.working[key] ?? e.reader.find(key);
  if (!el) refuse("element_not_found", `There is no stack ${sid}`, [key]);
  if (!isNamedVerticalRun(el)) refuse("wrong_kind", `${sid} is a ${el.kind.replace(/_/g, " ")}, not a stack`, [key]);
  return el;
}

/** The pipe must be a vertical piece of sanitary, vent or storm pipe; returns the run's members for the duplicate check. */
function requireStackPipe(e: Edit, model: ModelState, pipeId: string): ReadonlySet<string> {
  const key = asElementId(pipeId);
  const el = e.reader.find(key);
  if (!el) refuse("element_not_found", `There is no pipe ${pipeId}. Pick the stack's pipe on the plan again`, [key]);
  if (el.kind !== "run_segment" || el.domain !== "pipe") refuse("invalid_value", `${pipeId} is a ${el.kind.replace(/_/g, " ")}; pick a vertical sanitary, vent or storm pipe`, [key]);
  const chain = chainAt(model.elements, key, stackFilter);
  if (!chain || !chain.pieces.includes(key)) refuse("invalid_value", `${pipeId} isn't a vertical sanitary, vent or storm pipe; pick a piece of the stack that runs up and down`, [key]);
  return new Set([...chain.pieces, ...chain.offsets]);
}

function refuseNumberTaken(model: ModelState, num: string, self: ElementId, made: ReadonlyMap<string, ElementId>): void {
  const k = num.trim().toLowerCase();
  const inBatch = made.get(k);
  if (inBatch && inBatch !== self) refuse("already_exists", `Two stacks in this request are both number ${num}. Number them apart`, [self, inBatch]);
  const other = namedVerticalRuns(model.elements).find((r) => r.number.trim().toLowerCase() === k && r.id !== self);
  if (other) refuse("already_exists", `Stack ${num} already exists. Give this one another number, or renumber stack ${num} first`, [self, other.id]);
}

function refuseRunNamed(model: ModelState, members: ReadonlySet<string>, self: ElementId, runsInBatch: ReadonlyMap<ElementId, ReadonlySet<string>>): void {
  const other = namedVerticalRuns(model.elements).find((r) => r.id !== self && members.has(r.pipeId));
  if (other) refuse("already_exists", `That pipe is already stack ${other.number}. Rename stack ${other.number} instead`, [self, other.id]);
  for (const [sid, m] of runsInBatch) if (sid !== self && [...members].some((x) => m.has(x))) refuse("already_exists", "Two stacks in this request name the same pipe run. Name it once", [self, sid]);
}

function stackLabel(r: Pick<NamedVerticalRun, "number" | "name">): string {
  return `stack ${r.number}${r.name ? ` (${r.name})` : ""}`;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// ---------------------------------------------------------------- commands

function nameStacks(model: ModelState, command: Extract<VerticalRunCommand, { type: "name_stacks" }>): ExecuteResult {
  const e = begin(model);
  const madeNumbers = new Map<string, ElementId>();
  const madeRuns = new Map<ElementId, ReadonlySet<string>>();
  const out: NamedVerticalRun[] = [];
  for (const input of command.stacks) {
    const sid = asElementId(input.stackId);
    if (e.working[sid] ?? e.reader.find(sid)) refuse("already_exists", `${input.stackId} already exists; choose a new id for the stack`, [sid]);
    const members = requireStackPipe(e, model, input.pipeId);
    refuseRunNamed(model, members, sid, madeRuns);
    const num = input.number ?? nextStackNumber(model.elements, madeNumbers.keys());
    refuseNumberTaken(model, num, sid, madeNumbers);
    madeNumbers.set(num.trim().toLowerCase(), sid);
    madeRuns.set(sid, members);
    const r: NamedVerticalRun = {
      id: sid,
      kind: "vertical_run",
      version: 0,
      authoredRev: {},
      partition: GLOBAL_PARTITION,
      role: "stack",
      number: num,
      pipeId: asElementId(input.pipeId),
      ...(input.name ? { name: input.name } : {}),
      ...(input.systemCode ? { systemCode: input.systemCode } : {}),
      ...(input.serves ? { serves: input.serves } : {}),
    };
    put(e, r);
    out.push(r);
  }
  const first = out[0];
  e.summary.push(out.length === 1 && first ? `Named ${stackLabel(first)}` : `Named ${plural(out.length, "stack")}`);
  return done(e);
}

function editStack(model: ModelState, command: Extract<VerticalRunCommand, { type: "edit_stack" }>): ExecuteResult {
  const e = begin(model);
  const r = currentStack(e, command.stackId);
  const { name: priorName, systemCode: priorSystem, serves: priorServes, ...base } = r;
  const name = command.name === null ? undefined : (command.name ?? priorName);
  const systemCode = command.systemCode === null ? undefined : (command.systemCode ?? priorSystem);
  const serves = command.serves === null ? undefined : (command.serves ?? priorServes);
  if (command.pipeId) refuseRunNamed(model, requireStackPipe(e, model, command.pipeId), r.id, new Map());
  const next: NamedVerticalRun = {
    ...base,
    ...(command.number ? { number: command.number } : {}),
    ...(command.pipeId ? { pipeId: asElementId(command.pipeId) } : {}),
    ...(name ? { name } : {}),
    ...(systemCode ? { systemCode } : {}),
    ...(serves ? { serves } : {}),
  };
  if (verticalRunFingerprint(next) === verticalRunFingerprint(r)) refuse("invalid_value", `Nothing to change: ${stackLabel(r)} already reads that way`, [r.id]);
  if (command.number) refuseNumberTaken(model, command.number, r.id, new Map());
  put(e, next);
  e.summary.push(command.number && command.number !== r.number ? `Renumbered stack ${r.number} to ${command.number}` : `Changed ${stackLabel(next)}`);
  return done(e);
}

function deleteStacks(model: ModelState, command: Extract<VerticalRunCommand, { type: "delete_stacks" }>): ExecuteResult {
  const e = begin(model);
  const labels: string[] = [];
  for (const sid of new Set(command.stackIds)) {
    const r = currentStack(e, sid);
    labels.push(stackLabel(r));
    delete e.working[r.id];
    e.removed.push(r.id);
  }
  e.summary.push(labels.length === 1 ? `Removed the name ${labels[0]}; the pipe stays` : `Removed ${plural(labels.length, "stack name")}; the pipes stay`);
  return done(e);
}

function setChecks(model: ModelState, command: Extract<VerticalRunCommand, { type: "set_stack_checks" }>): ExecuteResult {
  const e = begin(model);
  const prior = verticalRunSettings(model.elements);
  const priorValue = prior?.baseClearanceDiameters ?? null;
  if (priorValue === command.baseClearanceDiameters) refuse("invalid_value", command.baseClearanceDiameters === null ? "Nothing to change: the base-of-stack check is already off" : `Nothing to change: the base-of-stack check is already ${command.baseClearanceDiameters} pipe diameters`);
  const existing: { readonly kind: string } | undefined = model.elements[VERTICAL_RUN_SETTINGS_ID];
  if (existing && !isVerticalRunRecord(existing)) refuse("already_exists", `${VERTICAL_RUN_SETTINGS_ID} is taken by a ${existing.kind}`, [VERTICAL_RUN_SETTINGS_ID]);
  const next: VerticalRunSettings = prior
    ? { ...prior, baseClearanceDiameters: command.baseClearanceDiameters }
    : { id: VERTICAL_RUN_SETTINGS_ID, kind: "vertical_run", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, role: "settings", baseClearanceDiameters: command.baseClearanceDiameters };
  put(e, next);
  e.summary.push(command.baseClearanceDiameters === null ? "Turned the base-of-stack check off" : `Branches must join at least ${command.baseClearanceDiameters} pipe diameters from a stack's base or offset bend`);
  return done(e);
}

export function executeVerticalRunCommand(model: ModelState, command: VerticalRunCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "name_stacks":
        return nameStacks(model, command);
      case "edit_stack":
        return editStack(model, command);
      case "delete_stacks":
        return deleteStacks(model, command);
      case "set_stack_checks":
        return setChecks(model, command);
    }
  });
}
