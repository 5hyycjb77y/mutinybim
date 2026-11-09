import type { AuthoredValue, AuthoredWrite } from "./command-core";
import { KernelError, type TrackedReader } from "./model";
import { draftElements } from "./store";
import type { TranslateAuthoredWrite, TranslateContext } from "./connections/faces";
import type { BimElement, ElementId } from "./types";

/**
 * The working copy one move writes into (`TranslateContext`, contract
 * 1.10.0). The kernel's move command makes one, moves what it moves itself,
 * and hands it to each network's `translate` face for the rest; an add-on's
 * own command can make one too. Reads go through the command's reader, so
 * every element a move looks at is recorded; `touched` is what the command
 * finishes with, `authored` what a later edit keeps.
 *
 * Which network carries what along (a run that stretches, a fitting that
 * passes the move on, a fixed end that refuses) is the network's, never this
 * file's: before contract 1.10.0 one trade's propagation lived here.
 */
export class TranslateWorkingCopy implements TranslateContext {
  readonly working: Record<string, BimElement>;
  readonly touched = new Set<ElementId>();

  constructor(
    private readonly reader: TrackedReader,
    readonly authored: AuthoredWrite[] = [],
  ) {
    this.working = draftElements(reader.model.elements);
  }

  get model() {
    return this.reader.model;
  }

  current(id: ElementId): BimElement {
    this.reader.get(id);
    const el = this.working[id];
    if (!el) throw new KernelError("element_not_found", `Element ${id} does not exist`, [id]);
    return el;
  }

  set(el: BimElement): void {
    this.working[el.id] = el;
    this.touched.add(el.id);
  }

  author(write: TranslateAuthoredWrite): void {
    this.authored.push({ elementId: write.elementId, field: write.field, value: authoredValue(write) });
  }
}

function authoredValue(write: TranslateAuthoredWrite): AuthoredValue {
  if (isAuthoredValue(write.value)) return write.value;
  throw new KernelError("invalid_value", `A move set ${write.field} on ${write.elementId} to a value the model can't keep`, [write.elementId]);
}

/** A number, text, a flag, or a plain record of them (a point, a size): what an authored write carries. */
function isAuthoredValue(value: unknown): value is AuthoredValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return value !== null && !Array.isArray(value) && Object.values(value).every((v) => v === undefined || isAuthoredValue(v));
    default:
      return false;
  }
}
