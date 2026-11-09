import {
  PART_VIEWS,
  PartGeometryUnavailableError,
  PartModelError,
  executeCommand,
  partImportReport,
  partTypeIssues,
  partViewLinework,
  partViewSvg,
  previewEdit,
  withUpgradePolicy,
  resolveConnectors,
  type ModelState,
  type PartTypeDefinition,
  type PartView,
} from "@permitzip/bim-kernel";
import { parseScriptOutput, type ScriptOutput } from "./output";

/**
 * The kit's checks (SCRIPTING-PROPOSAL §5.1), the same on a laptop, in a
 * sandbox, in CI and on the server: each batch through round 8's preflight
 * (`previewEdit`: refused-at, what it re-opens, quantity changes) in order,
 * optional lint on what each batch touched, and for part types the kernel's
 * part checks, the connector import report and a picture per view. Runs no
 * script code.
 */

export interface LintFinding {
  readonly severity: string;
  readonly message: string;
  readonly elementIds: readonly string[];
}

/** The host's lint over one batch (bim-lint's engine, scoped to the changed ids). */
export type OutputLint = (before: ModelState, after: ModelState, changedIds: readonly string[]) => readonly LintFinding[];

export interface CheckOptions {
  readonly lint?: OutputLint;
  /** Features the model server advertises (the slice's `features`): batches are decided under them, as the server will. */
  readonly features?: readonly string[];
  /** Part types: draw a picture of each view (needs the geometry engine; absent pictures are noted). Default true. */
  readonly pictures?: boolean;
}

export interface BatchCheck {
  readonly label: string;
  readonly steps: number;
  readonly status: "checked" | "refused";
  readonly message?: string;
  readonly reopens: readonly { readonly what: string; readonly because: string }[];
  readonly quantityChanges: readonly string[];
  readonly lint: readonly LintFinding[];
  /** Round 8's preflight fingerprint: an Approve card re-asks when the head no longer gives it. */
  readonly fingerprint: string;
}

export interface PartCheck {
  readonly typeId: string;
  readonly problems: readonly string[];
  readonly pictures: Readonly<Partial<Record<PartView, string>>>;
  readonly notes: readonly string[];
}

export type OutputCheck =
  | { readonly kind: "edits"; readonly ok: boolean; readonly steps: number; readonly batches: readonly BatchCheck[] }
  | { readonly kind: "part_types"; readonly ok: boolean; readonly types: readonly PartCheck[] };

/** Checks a script's output (raw JSON from a runner, or the kit's own) against `model`. Never commits. */
export function checkScriptOutput(model: ModelState, raw: unknown, options: CheckOptions = {}): OutputCheck {
  const features = new Set(options.features ?? []);
  return withUpgradePolicy((f) => features.has(f), () => checkIn(model, raw, options));
}

function checkIn(model: ModelState, raw: unknown, options: CheckOptions): OutputCheck {
  const output: ScriptOutput = parseScriptOutput(raw);
  if (output.kind === "part_types") {
    const types = output.types.map((t) => checkPart(t.typeId, t.definition, options.pictures ?? true));
    return { kind: "part_types", ok: types.every((t) => t.problems.length === 0), types };
  }
  const batches: BatchCheck[] = [];
  let head = model;
  for (const [index, batch] of output.batches.entries()) {
    const preview = previewEdit(head, batch, { label: batch.label });
    if (preview.status === "refused") {
      batches.push({ label: batch.label, steps: batch.commands.length, status: "refused", message: preview.message, reopens: [], quantityChanges: [], lint: [], fingerprint: preview.fingerprint });
      return { kind: "edits", ok: false, steps: output.steps, batches };
    }
    // The next batch (or lint) needs the head after this one; the last batch without lint doesn't.
    if (!options.lint && index === output.batches.length - 1) {
      batches.push({ label: batch.label, steps: batch.commands.length, status: "checked", reopens: preview.reopens, quantityChanges: preview.quantityChanges, lint: [], fingerprint: preview.fingerprint });
      break;
    }
    const applied = executeCommand(head, batch);
    if (!applied.ok) {
      batches.push({ label: batch.label, steps: batch.commands.length, status: "refused", message: applied.error.message, reopens: [], quantityChanges: [], lint: [], fingerprint: preview.fingerprint });
      return { kind: "edits", ok: false, steps: output.steps, batches };
    }
    const lint = options.lint ? options.lint(head, applied.model, applied.changedIds) : [];
    batches.push({ label: batch.label, steps: batch.commands.length, status: "checked", reopens: preview.reopens, quantityChanges: preview.quantityChanges, lint, fingerprint: preview.fingerprint });
    head = applied.model;
  }
  return { kind: "edits", ok: true, steps: output.steps, batches };
}

function checkPart(typeId: string, def: PartTypeDefinition, pictures: boolean): PartCheck {
  const problems = partTypeIssues(def).map((i) => `${i.field}: ${i.message}`);
  const report = partImportReport(def, resolveConnectors(def, def.typeValues));
  for (const p of report.problems) problems.push(`${p.connectorLabel}: ${p.message} (${p.nextStep}).`);
  const drawn: Partial<Record<PartView, string>> = {};
  const notes: string[] = [];
  // The view pictures draw the part's solid (kit bodies are all solid features); a hand-written definition of primitives only has none.
  if (pictures && problems.length === 0 && !def.model) notes.push("No pictures: this part is made of simple shapes with no 3D model to draw views from.");
  else if (pictures && problems.length === 0) {
    for (const view of PART_VIEWS) {
      try {
        drawn[view] = partViewSvg(partViewLinework(def, view, def.typeValues));
      } catch (err) {
        if (err instanceof PartModelError) {
          // A valid part whose drawing needs something this host doesn't have (an imported body file not loaded here).
          notes.push(`No pictures: ${err.message}.`);
          break;
        }
        if (!(err instanceof PartGeometryUnavailableError)) throw err;
        notes.push(`No ${view} picture: the geometry engine isn't loaded here.`);
        break;
      }
    }
  }
  return { typeId, problems, pictures: drawn, notes };
}
