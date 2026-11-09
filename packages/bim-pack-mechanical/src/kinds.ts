import { z } from "zod";
import {
  TrackedReader,
  asElementId,
  draftElements,
  finish,
  guard,
  readKindValue,
  refuse,
  registerKindLiftSteps,
  requireKind,
  writeKindValue,
  type AuthoredWrite,
  type BimElement,
  type ElementId,
  type ElementKindIssue,
  type ElementKindItem,
  type ElementKindShapeFace,
  type ElementKindValue,
  type ExecuteResult,
  type IntentPredicate,
  type ModelState,
  type PackCommand,
  type PackCommandDef,
} from "@permitzip/bim-kernel";
import { MECHANICAL_PLAN_GRAPHICS } from "./drawing/plan-graphics";
import { MECHANICAL_PICK_SHAPES } from "./drawing/pick-shapes";
import { MECHANICAL_SOLIDS } from "./drawing/solids";
import { MECHANICAL_TAG_TEXT } from "./drawing/tags";
import { MECHANICAL_KIND_FACES } from "./kind-shapes";
import { segmentLength } from "./types";

/**
 * The kinds the Mechanical add-on owns (`ELEMENT_KIND_POINT`): the original
 * duct network's unit, duct, tap, elbow and air terminal. Their stored shape,
 * connector ends and placement (`kind-shapes.ts`), their airflow, its words,
 * the duct checks and the airflow command are this add-on's.
 *
 * Airflow is the parameter `mechanical.airflow`. Records stored before
 * contract 1.7.0 keep it in the flat fields `cfm` (a terminal's design value),
 * `flowCfm` (a duct's total) and `totalCfm` (a unit's total); the kernel's
 * reader reads either form, and an edit lifts a record into the parameter
 * only once every peer reads it (`kinds:addon_owned`).
 */
export const AIRFLOW_KEY = "mechanical.airflow";

const MAX_TERMINAL_CFM = 20000;

/** A terminal's design airflow (a person sets it). */
export const TERMINAL_AIRFLOW: ElementKindValue = { key: AIRFLOW_KEY, stored: "cfm", label: "Airflow", unit: "CFM", authored: true, min: 0, max: MAX_TERMINAL_CFM };
/** A duct's airflow (the tree keeps it). */
export const DUCT_AIRFLOW: ElementKindValue = { key: AIRFLOW_KEY, stored: "flowCfm", label: "Airflow", unit: "CFM", authored: false };
/** A unit's total airflow served (the tree keeps it). */
export const UNIT_AIRFLOW: ElementKindValue = { key: AIRFLOW_KEY, stored: "totalCfm", aliases: ["cfm"], label: "Airflow", unit: "CFM", authored: false };

/** Air is what these kinds carry unless a record names another service (pipes, conduit and sprinklers reused them); no other kind carries it. */
export function carriesAir(el: BimElement): boolean {
  switch (el.kind) {
    case "equipment":
    case "duct_segment":
    case "tap":
    case "elbow":
    case "terminal":
      return el.service === undefined || el.service === "air";
    default:
      return false;
  }
}

function airflowSpec(el: BimElement): ElementKindValue | null {
  switch (el.kind) {
    case "terminal":
      return TERMINAL_AIRFLOW;
    case "duct_segment":
      return DUCT_AIRFLOW;
    case "equipment":
      return UNIT_AIRFLOW;
    default:
      return null;
  }
}

/** An element's stored airflow value, whatever service it carries (a terminal's design value, a duct's or a unit's total); null when its kind keeps none. */
export function storedAirflowOf(el: BimElement): number | null {
  const spec = airflowSpec(el);
  return spec ? readKindValue(el, spec) : null;
}

/** An element's airflow: a terminal's design value, a duct's or a unit's total. Null for anything that carries no air, and for kinds that keep none. */
export function airflowOf(el: BimElement): number | null {
  return carriesAir(el) ? storedAirflowOf(el) : null;
}

/** `el` keeping `cfm` as its airflow, in the form the record is in. Throws for a kind that keeps none. */
export function withAirflow<T extends BimElement>(el: T, cfm: number): T {
  const spec = airflowSpec(el);
  if (!spec) {
    const message = `[bim-pack-mechanical] a ${el.kind} keeps no airflow`;
    console.error(message, { id: el.id });
    throw new Error(message);
  }
  return writeKindValue(el, spec, cfm);
}

/** The duct checks: long enough to be a straight run, and orthogonal (moved out of the kernel's validation with the kinds). */
function checkDuct(el: BimElement, settings: ModelState["settings"], issues: ElementKindIssue[]): void {
  if (el.kind !== "duct_segment") return;
  const len = segmentLength(el);
  if (len < settings.minStraightMm) {
    issues.push({
      code: "min_straight_length",
      message: `${el.id} would be ${len.toFixed(1)} mm, shorter than the ${settings.minStraightMm} mm minimum straight length`,
      elementIds: [el.id],
    });
  }
  const tol = settings.connectorToleranceMm / 10;
  const orthogonal = Math.abs(el.start.x - el.end.x) < tol || Math.abs(el.start.y - el.end.y) < tol;
  if (!orthogonal) {
    issues.push({
      code: "unsupported_geometry",
      message: `${el.id} is not orthogonal; v1 supports orthogonal routing only`,
      elementIds: [el.id],
    });
  }
}

/** `shape` with the fields a person sets marked authored: an edit's intent on them is checked and competing writes conflict. */
function authoredFields(shape: ElementKindShapeFace | undefined, names: readonly string[]): { readonly shape?: ElementKindShapeFace } {
  if (shape === undefined) return {};
  return { shape: { ...shape, fields: shape.fields.map((f) => (names.includes(f.name) ? { ...f, authored: true } : f)) } };
}

export const MECHANICAL_KINDS: readonly ElementKindItem[] = [
  { kind: "equipment", label: "Unit", classId: "mep.mechanical_equipment", viewCategory: "equipment", scheduleListing: "stored_order", scheduleCategory: "mechanical_equipment", scheduleFamily: "Equipment", ...MECHANICAL_KIND_FACES.equipment, ...authoredFields(MECHANICAL_KIND_FACES.equipment.shape, ["mark", "position"]), ...MECHANICAL_PLAN_GRAPHICS.equipment, ...MECHANICAL_SOLIDS.equipment, values: [UNIT_AIRFLOW] },
  { kind: "duct_segment", label: "Duct", viewCategory: "duct", ...MECHANICAL_KIND_FACES.duct_segment, ...MECHANICAL_PLAN_GRAPHICS.duct_segment, ...MECHANICAL_SOLIDS.duct_segment, ...MECHANICAL_TAG_TEXT.duct_segment, values: [DUCT_AIRFLOW], check: checkDuct },
  { kind: "tap", label: "Tap", viewCategory: "duct_fitting", ...MECHANICAL_KIND_FACES.tap, ...MECHANICAL_PICK_SHAPES.tap },
  { kind: "elbow", label: "Elbow", viewCategory: "duct_fitting", ...MECHANICAL_KIND_FACES.elbow, ...MECHANICAL_PLAN_GRAPHICS.elbow, ...MECHANICAL_PICK_SHAPES.elbow },
  { kind: "terminal", label: "Air terminal", classId: "mep.air_terminal", viewCategory: "air_terminal", scheduleListing: "by_mark", scheduleCategory: "air_terminal", ...MECHANICAL_KIND_FACES.terminal, ...authoredFields(MECHANICAL_KIND_FACES.terminal.shape, ["mark"]), ...MECHANICAL_PLAN_GRAPHICS.terminal, ...MECHANICAL_PICK_SHAPES.terminal, values: [TERMINAL_AIRFLOW] },
];

// Lifting `cfm` / `flowCfm` / `totalCfm` into the parameter on edit, once every peer reads it.
registerKindLiftSteps(MECHANICAL_KINDS);

// ---------------------------------------------------------------- set_terminal_cfm

export const terminalAirflowCommandSchema = z.object({ type: z.literal("set_terminal_cfm"), terminalId: z.string().min(1), cfm: z.number().min(0).max(MAX_TERMINAL_CFM) }).strict();
export type SetTerminalAirflowCommand = z.infer<typeof terminalAirflowCommandSchema>;

// Callers build it with its fields typed, as a `Command`; stored changesets keep its type and its `cfm` intent unchanged.
declare module "@permitzip/bim-kernel/commands" {
  interface PackCommandTypes {
    set_terminal_cfm: SetTerminalAirflowCommand;
  }
}

function asSetTerminalAirflow(command: PackCommand): SetTerminalAirflowCommand {
  const parsed = terminalAirflowCommandSchema.safeParse(command);
  if (!parsed.success) refuse("invalid_value", `set_terminal_cfm: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

/**
 * Consecutive terminal airflow edits (a pasted column) derive and validate
 * once for the run: one pass over the union of the paths to the units, one
 * check of what changed. Same model and same accept / refuse outcome as one
 * by one, because a terminal's airflow feeds only the tree's totals and no
 * validation rule reads airflow; a rule that does must drop this run.
 */
function setTerminalAirflow(model: ModelState, steps: readonly SetTerminalAirflowCommand[]): ExecuteResult {
  return guard(() => {
    const reader = new TrackedReader(model);
    const working = draftElements(model.elements);
    const touched: ElementId[] = [];
    const authored: AuthoredWrite[] = [];
    const intents: IntentPredicate[] = [];
    for (const step of steps) {
      const read = requireKind(reader.get(asElementId(step.terminalId)), "terminal");
      const terminal = requireKind(working[read.id] ?? read, "terminal");
      working[read.id] = writeKindValue(terminal, TERMINAL_AIRFLOW, step.cfm);
      touched.push(read.id);
      // The stored field name stays `cfm`: old changesets and their intents name it.
      authored.push({ elementId: read.id, field: "cfm", value: step.cfm });
      intents.push({ kind: "field_equals", elementId: read.id, field: "cfm", value: step.cfm });
    }
    return finish(reader, working, touched, authored, () => intents);
  });
}

export const TERMINAL_AIRFLOW_COMMAND: PackCommandDef = {
  type: "set_terminal_cfm",
  schema: terminalAirflowCommandSchema,
  execute: (model, command) => setTerminalAirflow(model, [asSetTerminalAirflow(command)]),
  runs: (model, steps) => setTerminalAirflow(model, steps.map(asSetTerminalAirflow)),
};
