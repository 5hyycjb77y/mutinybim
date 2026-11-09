import { z } from "zod";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { TrackedReader } from "../model";
import { activePackSet } from "../packs/scope";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { freezeGate } from "./freeze";
import { GATE_KIND, STAGE_PLAN_ID, STAGE_PLAN_KIND, gatesWritable, stagePlanOf, type GateElement, type StagePlanElement } from "./records";
import { resolveStageSet, stageIn } from "./stages";

/**
 * Lifecycle edits (round 11 D3): pin the model's stage list and current
 * stage, and freeze a stage (write its gate and move to the next stage). Each
 * is one undo step. Gated on `gates:records`: an older model server is
 * refused in the "older server" words. Who may freeze (a person whose scope
 * covers the stage) is the host's check before it sends the command.
 *
 * No command accepts money (`cost/price.ts`): a gate stores quantities by
 * basis; a party prices them in its own process (`gateCostByBasis`).
 *
 * Freezing never forks (question 6): the command writes the gate and the plan
 * only; a stage's offered copy is returned by `freezeGate` for the host.
 */

const id = z.string().trim().min(1).max(200);
const words = (max: number) => z.string().trim().min(1).max(max);

const authorRef = z
  .object({
    provider: words(120),
    subject: words(200),
    kind: words(40),
    displayName: words(200).optional(),
    keyId: words(200).optional(),
  })
  .strict();

const loadLine = z.object({ key: words(120), unit: words(40), total: z.number().finite(), byBasis: z.record(z.string(), z.number().finite()).optional() }).strict();

export const lifecycleCommandSchemas = [
  z
    .object({
      type: z.literal("set_stage_plan"),
      /** `default`, a firm's `firm:<name>` or an add-on's list. */
      stageSetId: id,
      stageSetVersion: words(40),
      /** Absent: the list's first stage. */
      currentStageId: id.optional(),
      setBy: words(200).optional(),
      setAt: words(40).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("freeze_stage"),
      /** Chosen by the sender so a retried request makes the same gate. */
      gateId: id,
      stageId: id,
      lineageId: id.optional(),
      purpose: words(80).optional(),
      label: words(200).optional(),
      issuedSetRefs: z.array(words(400)).max(500).optional(),
      signoffSeqs: z.array(z.number().int().min(1)).max(5000).optional(),
      dispositionIds: z.array(id).max(5000).optional(),
      frozenBy: authorRef,
      frozenAt: words(40),
      stateDigest: words(200).optional(),
      loads: z.object({ lines: z.array(loadLine).max(500) }).strict().optional(),
      openFindings: z.array(z.object({ id, severity: words(40), sourceKind: words(80).optional() }).strict()).max(20_000).optional(),
    })
    .strict(),
] as const;

export const lifecycleCommandSchema = z.discriminatedUnion("type", [...lifecycleCommandSchemas]);
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;

const LIFECYCLE_COMMANDS: ReadonlySet<string> = new Set(lifecycleCommandSchemas.map((s) => s.shape.type.value));

export function isLifecycleCommand(command: { readonly type: string }): command is LifecycleCommand {
  return LIFECYCLE_COMMANDS.has(command.type);
}

const SERVER_OLD = "can't be saved yet: the model server this model is open on is an older version that doesn't store stages and gates. Try again once the server is updated";

function fingerprint(el: BimElement | GateElement | StagePlanElement): string {
  const { id: _id, version: _version, authoredRev: _rev, ...rest } = el;
  return canonicalJson(rest);
}

/** The edit's records: lifecycle records sit outside the element union until K11's `UnknownRecord` lands (as submittals do). */
type Working = Record<string, BimElement | GateElement | StagePlanElement>;

function planElement(prior: BimElement | undefined, plan: StagePlanElement["plan"]): StagePlanElement {
  return { id: asElementId(STAGE_PLAN_ID), kind: STAGE_PLAN_KIND, version: (prior?.version ?? 0) + 1, authoredRev: prior?.authoredRev ?? {}, plan };
}

function setStagePlan(model: ModelState, c: Extract<LifecycleCommand, { type: "set_stage_plan" }>): ExecuteResult {
  if (!gatesWritable()) refuse("invalid_value", `The stage plan ${SERVER_OLD}`);
  const list = resolveStageSet({ id: c.stageSetId, version: c.stageSetVersion }, activePackSet());
  if (list.problem) refuse("invalid_value", list.problem);
  if (c.currentStageId !== undefined && !stageIn(list, c.currentStageId)) refuse("invalid_value", `"${c.currentStageId}" isn't a stage in ${list.label}`);
  const reader = new TrackedReader(model);
  const working: Working = draftElements(model.elements);
  const key = asElementId(STAGE_PLAN_ID);
  const prior = reader.find(key);
  const el = planElement(prior, { stageSet: { id: list.id, version: list.version }, ...(c.currentStageId !== undefined ? { currentStageId: c.currentStageId } : {}), ...(c.setBy ? { setBy: c.setBy } : {}), ...(c.setAt ? { setAt: c.setAt } : {}) });
  working[key] = el;
  const authored: AuthoredWrite[] = [{ elementId: key, field: "plan", value: fingerprint(el) }];
  return finish(reader, working as Record<string, BimElement>, [key], authored, () => [], { summary: [`Stage list set to ${list.label}${c.currentStageId ? `, at ${stageIn(list, c.currentStageId)?.label ?? c.currentStageId}` : ""}`] });
}

function freezeStage(model: ModelState, c: Extract<LifecycleCommand, { type: "freeze_stage" }>): ExecuteResult {
  if (!gatesWritable()) refuse("invalid_value", `A frozen stage ${SERVER_OLD}`);
  const reader = new TrackedReader(model);
  const gateKey = asElementId(c.gateId);
  if (reader.find(gateKey)) refuse("invalid_value", `There is already a record ${c.gateId}; a gate is never rewritten`, [gateKey]);
  const out = freezeGate(model, {
    stageId: c.stageId,
    ...(c.lineageId !== undefined ? { lineageId: c.lineageId } : {}),
    ...(c.purpose !== undefined ? { purpose: c.purpose } : {}),
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.issuedSetRefs ? { issuedSetRefs: c.issuedSetRefs } : {}),
    ...(c.signoffSeqs ? { signoffSeqs: c.signoffSeqs } : {}),
    ...(c.dispositionIds ? { dispositionIds: c.dispositionIds } : {}),
    frozenBy: c.frozenBy,
    frozenAt: c.frozenAt,
    ...(c.stateDigest !== undefined ? { stateDigest: c.stateDigest } : {}),
    ...(c.loads ? { loads: c.loads } : {}),
    ...(c.openFindings ? { openFindings: c.openFindings } : {}),
  });
  if (!out.ok) refuse("invalid_value", out.message, (out.blockers ?? []).map((b) => asElementId(b.id)));
  const working: Working = draftElements(model.elements);
  const gate: GateElement = { id: gateKey, kind: GATE_KIND, version: 1, authoredRev: {}, gate: out.body, digest: out.digest };
  working[gateKey] = gate;
  const touched: ElementId[] = [gateKey];
  const authored: AuthoredWrite[] = [{ elementId: gateKey, field: "gate", value: out.digest }];
  const planKey = asElementId(STAGE_PLAN_ID);
  const plan = stagePlanOf(model.elements);
  const priorPlan = reader.find(planKey);
  if (out.next) {
    const el = planElement(priorPlan, { ...(plan ?? {}), stageSet: out.body.stageSet, currentStageId: out.next.id, setBy: c.frozenBy.displayName ?? c.frozenBy.subject, setAt: c.frozenAt });
    working[planKey] = el;
    touched.push(planKey);
    authored.push({ elementId: planKey, field: "plan", value: fingerprint(el) });
  }
  return finish(reader, working as Record<string, BimElement>, touched, authored, () => [], { summary: [`${out.body.label} frozen at revision ${out.body.revision}${out.next ? `; now in ${out.next.label}` : ""}`] });
}

export function executeLifecycleCommand(model: ModelState, command: LifecycleCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "set_stage_plan":
        return setStagePlan(model, command);
      case "freeze_stage":
        return freezeStage(model, command);
    }
  });
}
