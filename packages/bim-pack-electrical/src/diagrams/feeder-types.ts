import { type BimElement } from "@permitzip/bim-kernel";
import { feederTypeOf, racewayText } from "../catalog/feeder-types";
import { printedConductors } from "../fields/electrical-resolver";

/**
 * The feeder type catalog, as diagrams read it. A feeder's design names a
 * type by mark ("F225", "F100T"); the project's electrical catalog
 * (`connections/catalog`, CONNECTIONS.md "Electrical catalog") says what that
 * mark is. A mark the catalog doesn't have prints as the mark alone, nothing
 * invented. (The catalog's own lookup, `feederTypeOf`, returns the whole
 * record; this is the printed shape diagrams use.)
 */

export interface FeederTypeInfo {
  readonly mark: string;
  /** As the one-line prints it ("4#4/0 CU, 1#4 G"); null when the catalog doesn't say. */
  readonly conductors: string | null;
  readonly conduitAboveGrade: string | null;
  readonly conduitBelowGrade: string | null;
}

type Elements = Readonly<Record<string, BimElement>>;

/** What a feeder type mark stands for, printed: the catalog's conductors and conduit, or only the mark when the catalog lacks it. */
export function feederTypeInfoOf(elements: Elements, mark: string): FeederTypeInfo {
  const entry = feederTypeOf(elements, mark);
  if (!entry) return { mark: mark.trim().toUpperCase(), conductors: null, conduitAboveGrade: null, conduitBelowGrade: null };
  return {
    mark: entry.mark,
    conductors: printedConductors(entry.conductors, entry.poles),
    conduitAboveGrade: entry.conduit ? racewayText(entry.conduit) : null,
    conduitBelowGrade: entry.conduitBelowGrade ? racewayText(entry.conduitBelowGrade) : null,
  };
}
