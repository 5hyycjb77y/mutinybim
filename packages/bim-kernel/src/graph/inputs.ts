import { currentStageIdOf } from "../lifecycle/current";
import { BOUNDARY_MEASURES, boundaryQuantityReads } from "../qto/boundary";
import { measuredValue } from "../qto/measure";
import { STAGE_PLAN_ID } from "../lifecycle/records";
import { elementKindTable } from "../registry/element-kind-point";
import { spaceMeasure, spaceOf, zonesOfSpace } from "../spaces/space-index";
import { designOccupants } from "../spaces/space-use";
import type { Space, Zone } from "../spaces/types";
import type { BimElement, ElementId } from "../types";
import { packParameterByKey, slot, type GraphAux } from "./auxiliary";
import { quantityInput, scalarInput, type InputValue } from "./formula";
import { ceilingLowMm } from "./makeup";
import { nameOf, shortDate, valueWords } from "./names";
import type { DeterminationElement, RequirementAnchorKind } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Reading a rule's declared inputs on one anchor (REQUIREMENTS-GRAPH §1,
 * `InputKey` in graph/types.ts). Every read notes what it looked at: element
 * ids it read, and slots for what it looked for and didn't find (a
 * determination not recorded yet, a ceiling not drawn yet, no instances of a
 * class yet), so the record that later fills a slot re-runs exactly the
 * rules that wanted it.
 *
 *   space.area | occupants | use | ceiling_height | name | number | <value key>
 *   zone.<value key> | name | purpose        the anchor zone, or the space's zones
 *   ceiling.height_at | form | slope         the typed ceiling over the space (lowest, when several), else the space's stated height
 *   determination.<key>                      on the anchor, then its zones (or its space), then the model
 *   model.<key>                              a model-wide determination (a design choice, the jurisdiction, the edition)
 *   class.<class id>                         how many instances of the class are in the anchor space
 *   class.<class id>:<parameter key>         (delivered only) their parameter values, summed
 *   stage.current                            the model's current stage id (round 11)
 *   <parameter key>                          a value on the anchor itself, typed by its pack parameter (or its kind row's unit)
 */

export interface AnchorRef {
  readonly kind: RequirementAnchorKind;
  /** The space, zone or element; null for the model. */
  readonly id: string | null;
}

export function anchorKeyOf(a: AnchorRef): string {
  return a.id === null ? "model" : `${a.kind}:${a.id}`;
}

/** What an evaluation read: element ids and slots. */
export class ReadNote {
  readonly reads = new Set<string>();
  /** Determinations it used, for the cause and the `informs` edges. */
  readonly determinations = new Map<ElementId, DeterminationElement>();
  id(id: string): void {
    this.reads.add(id);
  }
  slot(name: string): void {
    this.reads.add(name);
  }
}

export interface Delivered {
  readonly value: InputValue | null;
  readonly elementIds: readonly ElementId[];
}

/** "Room 104 is B (K. Example's determination, Oct 30)". */
export function determinationWords(elements: Elements, d: DeterminationElement): string {
  const b = d.determination;
  const subject = b.subject.id ? nameOf(elements[b.subject.id], b.subject.id) : "The model";
  const when = shortDate(b.decidedAt);
  const who = `${b.decidedBy}'s determination${when ? `, ${when}` : ""}`;
  const what = b.key.replace(/[._]/g, " ");
  return typeof b.value === "boolean" ? `${subject} is ${b.value ? "" : "not "}${what} (${who})` : `${subject} ${what} is ${valueWords(b.value, b.unit)} (${who})`;
}

export class InputReader {
  private readonly anchorEl: BimElement | undefined;
  private readonly space: Space | null;
  private zonesCache: Zone[] | null = null;

  constructor(
    private readonly elements: Elements,
    private readonly aux: GraphAux,
    readonly anchor: AnchorRef,
  ) {
    this.anchorEl = anchor.id ? elements[anchor.id] : undefined;
    if (this.anchorEl?.kind === "space") this.space = this.anchorEl;
    else if (anchor.kind === "element" && anchor.id) this.space = spaceOf(elements, anchor.id as ElementId);
    else this.space = null;
  }

  label(): string {
    return this.anchor.id === null ? "the model" : nameOf(this.anchorEl, this.anchor.id);
  }

  private zones(note: ReadNote): Zone[] {
    if (this.anchorEl?.kind === "zone") return [this.anchorEl];
    if (!this.space) return [];
    if (!this.zonesCache) this.zonesCache = zonesOfSpace(this.elements, this.space.id);
    for (const z of this.zonesCache) note.id(z.id);
    return this.zonesCache;
  }

  /** The determination in force for `key` on the anchor, its zones or space, then the model. */
  determination(key: string, note: ReadNote): DeterminationElement | null {
    const subjects: string[] = [];
    if (this.anchor.id) subjects.push(this.anchor.id);
    if (this.anchor.kind === "element" && this.space) subjects.push(this.space.id);
    for (const z of this.zones(note)) if (z.id !== this.anchor.id) subjects.push(z.id);
    subjects.push("model");
    for (const s of subjects) {
      // The slot too when found: a newer determination for the same subject and key takes over.
      note.slot(slot.determination(s, key));
      const d = this.aux.determination(s, key);
      if (d) {
        note.id(d.id);
        note.determinations.set(d.id, d);
        return d;
      }
    }
    return null;
  }

  private modelDetermination(key: string, note: ReadNote): DeterminationElement | null {
    note.slot(slot.determination("model", key));
    const d = this.aux.determination("model", key);
    if (d) {
      note.id(d.id);
      note.determinations.set(d.id, d);
    }
    return d;
  }

  private parameter(el: BimElement | undefined, key: string, note: ReadNote): InputValue | null {
    if (!el) return null;
    note.id(el.id);
    if (!("values" in el) || typeof el.values !== "object" || el.values === null) return null;
    const v: unknown = (el.values as Readonly<Record<string, unknown>>)[key];
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") return null;
    const def = packParameterByKey().get(key);
    if (typeof v === "number" && def?.unit) return quantityInput(v, def.unit);
    if (typeof v === "number") {
      // A value an add-on's kind row keeps (an intent record's setback, a parcel's area) is typed by the row's unit.
      const kv = elementKindTable().valueOf(el.kind, key);
      const q = kv && kv.key === key ? quantityInput(v, kv.unit) : null;
      if (q) return q;
    }
    return scalarInput(v);
  }

  private spaceField(field: string, note: ReadNote): InputValue | null {
    const s = this.space;
    if (!s) return null;
    note.id(s.id);
    if (s.bounds.kind === "rooms") for (const r of s.bounds.roomIds) note.id(r);
    switch (field) {
      case "area": {
        const m = spaceMeasure(this.elements, s.id)?.areaM2 ?? null;
        return m === null ? null : quantityInput(m, "m2");
      }
      case "occupants": {
        const area = spaceMeasure(this.elements, s.id)?.areaM2 ?? null;
        const o = designOccupants(s, area);
        return o ? quantityInput(o.value, "occ") : null;
      }
      case "use":
        return s.use ? { type: "text", value: s.use.useId } : null;
      case "ceiling_height":
        return s.ceilingHeightMm === undefined ? null : quantityInput(s.ceilingHeightMm, "mm");
      case "name":
        return { type: "text", value: s.name };
      case "number":
        return { type: "text", value: s.number };
      default:
        if (field.startsWith("qto.boundary.")) return this.boundaryQuantity(s, field, note);
        return this.parameter(s, field, note);
    }
  }

  /** A bounded space's boundary quantity (`qto.boundary.window_area`), read like any other measure; re-read when a wall or opening around it changes. */
  private boundaryQuantity(s: Space, field: string, note: ReadNote): InputValue | null {
    const def = BOUNDARY_MEASURES.find((m) => m.key === field);
    if (!def) return null;
    for (const id of boundaryQuantityReads(this.elements, s)) note.id(id);
    const v = measuredValue(this.elements, s.id, field);
    return v === null ? null : quantityInput(v, def.unit);
  }

  private zoneField(field: string, note: ReadNote): InputValue | null {
    for (const z of this.zones(note)) {
      if (field === "name") return { type: "text", value: z.name };
      if (field === "purpose") return { type: "text", value: z.purpose };
      const v = this.parameter(z, field, note);
      if (v) return v;
    }
    return null;
  }

  private ceilingField(field: string, note: ReadNote): InputValue | null {
    const s = this.space;
    if (!s) return null;
    note.slot(slot.ceiling(s.id));
    const ceilings = this.aux.ceilingsOf(s.id);
    for (const c of ceilings) note.id(c.id);
    const low = ceilings.length > 0 ? ceilings.reduce((a, b) => (ceilingLowMm(b) < ceilingLowMm(a) ? b : a)) : null;
    switch (field) {
      case "height_at":
        if (low) return quantityInput(ceilingLowMm(low), "mm");
        note.id(s.id);
        return s.ceilingHeightMm === undefined ? null : quantityInput(s.ceilingHeightMm, "mm");
      case "form":
        return low ? { type: "text", value: low.form } : null;
      case "slope":
        return low ? quantityInput(low.slope?.pitch ?? 0, "1") : null;
      default:
        return low ? this.parameter(low, field, note) : null;
    }
  }

  private instances(classId: string, note: ReadNote): readonly ElementId[] {
    const s = this.space;
    if (!s) return [];
    note.slot(slot.classIn(s.id, classId));
    const ids = this.aux.instancesIn(s.id, classId);
    for (const id of ids) note.id(id);
    return ids;
  }

  /** The model's current stage id (its stage plan, round 11); read notes the plan so a stage change re-runs what read it. */
  currentStage(note: ReadNote): InputValue | null {
    note.id(STAGE_PLAN_ID);
    const id = currentStageIdOf(this.elements);
    return id === null ? null : { type: "text", value: id };
  }

  /** One declared input on the anchor, or null when it isn't there. */
  read(key: string, note: ReadNote): InputValue | null {
    const dot = key.indexOf(".");
    const head = dot < 0 ? key : key.slice(0, dot);
    const rest = dot < 0 ? "" : key.slice(dot + 1);
    switch (head) {
      case "space":
        return this.spaceField(rest, note);
      case "zone":
        return this.zoneField(rest, note);
      case "ceiling":
        return this.ceilingField(rest, note);
      case "determination": {
        const d = this.determination(rest, note);
        return d ? scalarInput(d.determination.value, d.determination.unit) : null;
      }
      case "model": {
        const d = this.modelDetermination(rest, note);
        return d ? scalarInput(d.determination.value, d.determination.unit) : null;
      }
      case "class":
        return quantityInput(this.instances(rest, note).length, "ea");
      case "stage":
        return rest === "current" ? this.currentStage(note) : null;
      default:
        return this.parameter(this.anchorEl ?? this.space ?? undefined, key, note);
    }
  }

  /** The model's delivered value for a requirement (`RequirementTemplate.delivered`) and the elements that deliver it. */
  delivered(key: string, note: ReadNote): Delivered {
    if (key.startsWith("class.")) {
      const body = key.slice("class.".length);
      const colon = body.indexOf(":");
      const classId = colon < 0 ? body : body.slice(0, colon);
      const param = colon < 0 ? null : body.slice(colon + 1);
      const ids = this.instances(classId, note);
      if (!param) return { value: quantityInput(ids.length, "ea"), elementIds: ids };
      let total = 0;
      let unit: string | null = null;
      let any = false;
      for (const id of ids) {
        const v = this.parameter(this.elements[id], param, note);
        if (v?.type !== "quantity") continue;
        any = true;
        total += v.si;
        unit = unit ?? v.unit;
      }
      if (!any || !unit) return { value: null, elementIds: ids };
      const q = quantityInput(0, unit);
      return { value: q && q.type === "quantity" ? { ...q, si: total } : null, elementIds: ids };
    }
    const value = this.read(key, note);
    return { value, elementIds: value && this.anchor.id ? [this.anchor.id as ElementId] : [] };
  }

  /** The anchor's space use id, when it is (or is in) a space. */
  spaceUse(note: ReadNote): string | null {
    if (!this.space) return null;
    note.id(this.space.id);
    return this.space.use?.useId ?? null;
  }

  /** Whether the anchor space holds an instance of any of the classes. */
  holdsAnyOf(classes: readonly string[], note: ReadNote): boolean {
    return classes.some((c) => this.instances(c, note).length > 0);
  }
}
