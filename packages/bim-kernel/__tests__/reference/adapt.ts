import type { BimElement, ModelState } from "../../src/types";
import type { BimElement as RefElement, Connection as RefConnection, ConnectorEnd as RefConnectorEnd, ModelState as RefModelState } from "./types";

const REFERENCE_ENDS: ReadonlySet<string> = new Set(["start", "end", "in", "out", "host", "branch"]);

function isReferenceEnd(end: string): end is RefConnectorEnd {
  return REFERENCE_ENDS.has(end);
}

const REFERENCE_KINDS: ReadonlySet<string> = new Set(["equipment", "duct_segment", "tap", "elbow", "terminal"]);

function isReferenceElement(el: BimElement): el is RefElement {
  return REFERENCE_KINDS.has(el.kind);
}

/** The frozen kernel only knows duct-network kinds; refuse any model containing others. */
export function asReference(model: ModelState): RefModelState {
  const elements: Record<string, RefElement> = {};
  for (const [id, el] of Object.entries(model.elements)) {
    if (!isReferenceElement(el)) throw new Error(`${id} is a ${el.kind}; the reference kernel predates that kind`);
    elements[id] = el;
  }
  const connections: RefConnection[] = model.connections.map((c) => {
    const a = c.a.end;
    const b = c.b.end;
    if (!isReferenceEnd(a) || !isReferenceEnd(b)) throw new Error(`connection ${c.id} joins an end the reference kernel predates (${a}, ${b})`);
    return { id: c.id, a: { elementId: c.a.elementId, end: a }, b: { elementId: c.b.elementId, end: b } };
  });
  return { ...model, elements, connections };
}
