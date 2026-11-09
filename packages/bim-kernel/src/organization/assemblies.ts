import type { PackRefusal } from "../packs/points";
import { QUANTITIES, QUANTITY_KEYS, ZERO_TOTALS, addTotals, type QuantityTotals } from "../quantities";
import { loadValueOf } from "../requirements/allocation";
import type { SpaceLocator } from "../requirements/locator";
import { serviceLabel } from "../services/registry";
import { modelSpaceLocator } from "../spaces/space-index";
import { elementsOfKind } from "../store";
import type { BimElement, ConnectorEnd, ElementId, ModelState, Vec2 } from "../types";
import type { GroupEntry } from "./model";
import { copyPoint, typicalCount, typicalOfGroup } from "./typicals";

/**
 * Assembly stubs (contract 1.10.0; KERNEL-FOUNDATION §3.8). A group made into
 * an assembly (a typical unit, a bathroom group, a rack) exposes one stub per
 * service it needs from outside, carrying the group's rolled-up need on that
 * service. Networks connect to the stub like any element end, and totals
 * upstream count it by the typical's multiplier, never by expanding copies.
 */

export interface AssemblyStub {
  /** Stable within the group: `<groupId>#stub:<serviceId>` (a second stub on one service adds `:<n>`). */
  readonly id: string;
  readonly groupId: ElementId;
  /** The service it carries (`SERVICE_POINT` id). */
  readonly serviceId: string;
  /** What a person calls it ("Cold water"). */
  readonly label: string;
  /** Where the stub sits relative to the group's base point, plan mm (copies move and mirror it with the group). */
  readonly position: Vec2;
  /** The end a network connects to. */
  readonly end: ConnectorEnd;
  /** The group's rolled-up need on this service, one instance, by quantity key (what the service's network totals). */
  readonly need: Readonly<Record<string, number>>;
  /** How many instances it stands for (the original and its copies). */
  readonly instances: number;
}

type Elements = Readonly<Record<string, BimElement>>;

/** The end name a network joins a group's stub on (`<groupId>` element, this end). */
export function assemblyStubEnd(serviceId: string): ConnectorEnd {
  return `stub:${serviceId}`;
}

function liveGroup(elements: Elements, groupId: string): GroupEntry | null {
  const record = elements[groupId];
  if (record?.kind !== "organization" || record.deleted || record.entry.type !== "group") return null;
  return record.entry as GroupEntry;
}

function nonZero(t: QuantityTotals): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of QUANTITY_KEYS) if (t[k] !== 0) out[k] = t[k];
  return out;
}

/**
 * The stubs a group exposes: its loads (those it holds, or whose part it
 * holds) by service, each service's need summed for one instance. A load with
 * no service yet has no stub; the stub sits at the middle of the parts its
 * loads stand for, relative to the base point. Reads the group's loads only
 * (one pass over load records), never the model's networks.
 */
export function assemblyStubs(model: Pick<ModelState, "elements">, groupId: ElementId, locator?: SpaceLocator): readonly AssemblyStub[] | PackRefusal {
  const elements = model.elements;
  const group = liveGroup(elements, groupId);
  if (!group) return { refused: `${groupId} isn't a group in this model` };
  const typical = typicalOfGroup(elements, groupId);
  const base = typical?.spec.basePoint ?? { x: 0, y: 0 };
  const instances = typical ? typicalCount(typical.spec) : 1;
  const where = locator ?? modelSpaceLocator(elements);
  const byService = new Map<string, { need: QuantityTotals; xs: number; ys: number; n: number }>();
  for (const lp of elementsOfKind(elements, "load_point")) {
    if (!lp.service) continue;
    const part = lp.attachedPartId ? elements[lp.attachedPartId] : undefined;
    if (lp.groupId !== groupId && part?.groupId !== groupId) continue;
    let held = byService.get(lp.service);
    if (!held) byService.set(lp.service, (held = { need: ZERO_TOTALS, xs: 0, ys: 0, n: 0 }));
    held.need = addTotals(held.need, loadValueOf(elements, lp, where));
    if (part?.kind === "part") {
      held.xs += part.position.x;
      held.ys += part.position.y;
      held.n++;
    }
  }
  const out: AssemblyStub[] = [];
  for (const serviceId of [...byService.keys()].sort()) {
    const held = byService.get(serviceId);
    if (!held) continue;
    out.push({
      id: `${groupId}#stub:${serviceId}`,
      groupId,
      serviceId,
      label: serviceLabel(serviceId),
      position: held.n > 0 ? { x: held.xs / held.n - base.x, y: held.ys / held.n - base.y } : { x: 0, y: 0 },
      end: assemblyStubEnd(serviceId),
      need: nonZero(held.need),
      instances,
    });
  }
  return out;
}

/** A stub's need for every instance it stands for: additive quantities times the instance count, the rest (a minimum pressure) unchanged. */
export function stubTotalNeed(stub: AssemblyStub): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stub.need)) {
    const q = QUANTITIES[k as keyof typeof QUANTITIES];
    out[k] = q && q.add === "sum" ? v * stub.instances : v;
  }
  return out;
}

/** How long a stub is drawn on plan, model mm. */
export const ASSEMBLY_STUB_LENGTH_MM = 300;

/** One stub where one instance of the group puts it: the original, or a copy (moved, turned and mirrored with it). */
export interface AssemblyStubMark {
  readonly stubId: string;
  readonly serviceId: string;
  readonly label: string;
  /** The instance's mark ("001" for the original, "002" for a copy; "" for a group that isn't a typical). */
  readonly instanceMark: string;
  readonly copy: boolean;
  /** The stub's end where a network joins, plan mm. */
  readonly at: Vec2;
  /** The other end of the short drawn stub, plan mm (carried through the copy's transform). */
  readonly tip: Vec2;
}

/** Every stub of a group on every instance: stubs × (1 + copies) marks, from the group record and its loads only. */
export function assemblyStubMarks(model: Pick<ModelState, "elements">, groupId: ElementId, locator?: SpaceLocator): readonly AssemblyStubMark[] | PackRefusal {
  const stubs = assemblyStubs(model, groupId, locator);
  if ("refused" in stubs) return stubs;
  const typical = typicalOfGroup(model.elements, groupId);
  const base = typical?.spec.basePoint ?? { x: 0, y: 0 };
  const out: AssemblyStubMark[] = [];
  for (const s of stubs) {
    const at = { x: base.x + s.position.x, y: base.y + s.position.y };
    const tip = { x: at.x, y: at.y + ASSEMBLY_STUB_LENGTH_MM };
    out.push({ stubId: s.id, serviceId: s.serviceId, label: s.label, instanceMark: typical?.spec.mark ?? "", copy: false, at, tip });
    for (const c of typical?.spec.copies ?? []) {
      if (!typical) break;
      out.push({ stubId: s.id, serviceId: s.serviceId, label: s.label, instanceMark: c.mark, copy: true, at: copyPoint(typical.spec, c, at), tip: copyPoint(typical.spec, c, tip) });
    }
  }
  return out;
}
