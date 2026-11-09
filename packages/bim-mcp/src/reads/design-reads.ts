import { ALLOCATION_POLICY_LABELS, QUANTITY_KEYS, allocate, allQuestions, answerValidity, askerWords, authorWords, modelAnswerFor, ownerWords, questionAt, recordValidity, productChainOf, questionOutcomeLabel, questionThread, submittalsIn, type Question, allocatedActualLine, allocationPolicyOf, designOccupants, elementsOfKind, formatQuantity, modelSpaceLocator, plannedPartGroups, spaceAreaM2, spaceLabel, tracingRefusal, zonesOfSpace, zoneBoundsOf, elementCoreOf, isClassifiedElement, isCoreElement, type BimElement, type AllocationGroup, type DrawingUnderlay, type ModelState, type Space, type Zone } from "@permitzip/bim-kernel";
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { PACK_READ_POINT, activePackSet } from "@permitzip/bim-kernel/packs";

/**
 * What the agent reads about things that exist before they are drawn (planned
 * parts, typed spaces) and about the spaces, zones and underlays people trace.
 * The row facts come from bim-sync; these add what a planned or spatial
 * element means, so a placeholder location is never reported as a location.
 */

type Elements = ModelState["elements"];

const FT2_PER_M2 = 10.7639;
const NOT_PLACED_LIMIT = 100;

type Facts = Record<string, string | number | boolean>;
interface Row {
  readonly id: string;
  readonly kind: string;
  readonly area: string;
  readonly facts: Readonly<Facts>;
}

/**
 * What installed add-ons say about one planned row. An add-on contributes a
 * pack read whose id ends in `.planned_row_facts`; it is run with
 * `{ elementId }` and answers `{ facts, waiting? }`: plain facts added to the
 * row ("circuit": its name or "none yet"), and, when the row still waits on
 * that add-on, the summary key that counts it ("waiting_for_a_circuit").
 */
export const PLANNED_ROW_FACTS_SUFFIX = ".planned_row_facts";

/** One Not placed yet row as an agent reads it, with whatever installed add-ons said about it (`circuit`, …). */
export type PlannedRowOut = { readonly id: string; readonly name: string; readonly type: string; readonly level_hint?: string; readonly note?: string } & { readonly [fact: string]: string | number | boolean | undefined };

export interface PlannedRowFacts {
  readonly facts: Readonly<Record<string, string | number | boolean>>;
  readonly waiting?: string;
}

function isPlannedRowFacts(value: unknown): value is PlannedRowFacts {
  if (typeof value !== "object" || value === null || !("facts" in value)) return false;
  const { facts, waiting } = value as { facts: unknown; waiting?: unknown };
  return typeof facts === "object" && facts !== null && (waiting === undefined || typeof waiting === "string");
}

function rowFactsOf(elements: Elements, id: string): { facts: Record<string, string | number | boolean>; waiting: string[] } {
  const reads = activePackSet().items(PACK_READ_POINT).filter((r) => r.id.endsWith(PLANNED_ROW_FACTS_SUFFIX));
  const out = { facts: {} as Record<string, string | number | boolean>, waiting: [] as string[] };
  if (reads.length === 0) return out;
  const model: ModelState = { modelId: "", revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
  for (const read of reads) {
    const answer = read.run(model, { elementId: id });
    if (!isPlannedRowFacts(answer)) continue;
    Object.assign(out.facts, answer.facts);
    if (answer.waiting) out.waiting.push(answer.waiting);
  }
  return out;
}

/** The Not placed yet list as the Building Model shows it, grouped by trade and category, with what each add-on says about each item (its circuit). */
export function notPlacedYet(model: Pick<ModelState, "elements">) {
  const groups = plannedPartGroups(model.elements);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  let left = NOT_PLACED_LIMIT;
  const waiting = new Map<string, number>();
  const out = groups.flatMap((g) => {
    const facts = new Map(g.rows.map((r) => [r.id, rowFactsOf(model.elements, r.id)] as const));
    for (const f of facts.values()) for (const key of f.waiting) waiting.set(key, (waiting.get(key) ?? 0) + 1);
    if (left <= 0) return [];
    const parts = g.rows.slice(0, left).map((r): PlannedRowOut => ({ id: r.id, name: r.name, type: r.typeName, ...(r.levelHint ? { level_hint: r.levelHint } : {}), ...(r.note ? { note: r.note } : {}), ...facts.get(r.id)?.facts }));
    left -= parts.length;
    return [{ discipline: g.discipline, category: g.categoryLabel, parts }];
  });
  return {
    count,
    ...Object.fromEntries(waiting),
    groups: out,
    ...(count > NOT_PLACED_LIMIT ? { truncated: count - NOT_PLACED_LIMIT } : {}),
  };
}

const QUESTION_ROWS = 30;
const QUESTION_ROWS_ALL = 200;

/** The newest thread entries an agent reads per question (who said what, and every change of state). */
const THREAD_LINES = 8;

function threadOf(model: Pick<ModelState, "elements">, q: Question) {
  const entries = questionThread(model.elements, q.id)?.entries ?? [];
  return entries.slice(-THREAD_LINES).map((e) =>
    e.kind === "answer"
      ? (() => {
          const v = recordValidity(model.elements, e.id);
          return { who: e.record.answer.author ? authorWords(e.record.answer.author) : e.record.answer.by, did: `answered: ${questionOutcomeLabel(e.record.answer.outcome).toLowerCase()}`, text: e.record.answer.text, at: e.record.answer.at, ...(v.state === "may_not_hold" ? { may_no_longer_hold: v.words } : {}) };
        })()
      : {
          who: authorWords(e.record.reply.author),
          did: e.record.reply.event ? e.record.reply.event.kind.replace(/_/g, " ") : e.record.reply.statusChange ? `set it ${e.record.reply.statusChange.to.replace(/_/g, " ")}` : "replied",
          ...(e.record.reply.event?.to ? { to: e.record.reply.event.to.label } : {}),
          ...(e.record.reply.event?.reason ? { reason: e.record.reply.event.reason } : {}),
          ...(e.record.reply.text ? { text: e.record.reply.text } : {}),
          at: e.record.reply.at,
        },
  );
}

/**
 * The design → submittal → field chain for one element (`chainOf`): what the
 * design says, what was submitted and how each item was reviewed, approved
 * substitutions ("design not changed") and field observations. Read-only.
 */
export function chainOf(model: Pick<ModelState, "elements">, elementId: string) {
  const c = productChainOf(model.elements, elementId);
  return {
    element_id: c.elementId,
    ...(c.typeId ? { type_id: c.typeId } : {}),
    submittals: c.submittals.map((s) => ({ id: s.submittal.id, title: s.submittal.submittal.title, revision: s.submittal.submittal.revision, review: s.submittal.submittal.review.state, items: s.items.map((i) => ({ id: i.id, label: i.label, review: i.review?.state ?? "pending", ...(i.review?.notes ? { notes: i.review.notes } : {}) })) })),
    substitutions: c.divergences.map((d) => ({ product: d.divergence.approvedProduct.label, approved_by: d.divergence.approvedBy, notes: d.divergence.notes, design_changed: false, ...(d.divergence.responsibleParty ? { responsible: d.divergence.responsibleParty.label } : {}) })),
    field: c.field.map((o) => ({ by: o.observation.observedBy, at: o.observation.at, result: o.observation.result, note: o.observation.note })),
  };
}

function questionRow(model: Pick<ModelState, "elements">, q: Question, withChain = false) {
  const m = q.status === "open" || q.status === "assumed" ? modelAnswerFor(model, q) : null;
  const thread = threadOf(model, q);
  const asked = askerWords(q);
  const chains = withChain ? q.anchor.elementIds.map((id) => chainOf(model, id)).filter((c) => c.submittals.length + c.substitutions.length + c.field.length > 0) : [];
  return {
    id: q.id,
    number: q.number,
    type: q.type,
    status: q.status,
    text: q.text,
    ask_of: q.askOf,
    ...(asked ? { asked_by: asked } : {}),
    ...(q.ownerAuthor ? { carried_by: ownerWords(q) } : {}),
    ...(q.keptClosed ? { kept_closed: q.keptClosed.reason } : {}),
    ...(q.askedBefore ? { asked_before: questionAt(model.elements, q.askedBefore)?.number ?? q.askedBefore } : {}),
    ...(q.status === "answered" && answerValidity(model.elements, q.id).state === "may_not_hold" ? { answer_may_no_longer_hold: true } : {}),
    ...(thread.length > 0 ? { thread } : {}),
    ...(chains.length > 0 ? { chain_of: chains } : {}),
    ...(q.answer ? { answer: q.answer } : {}),
    ...(q.blocksIssue ? { holds_issue: q.status === "open" } : {}),
    ...(q.closeBy ? { close_by: q.closeBy } : {}),
    about: q.anchor.elementIds,
    ...(m?.answered ? { model_answers_it: `${m.from} is ${m.value}` } : {}),
  };
}

/**
 * Questions and assumptions as the Coordination › Questions list shows them.
 * `which` absent: the open ones (and assumptions still to confirm), summary
 * size; "all": every question, answered and withdrawn too.
 */
export function questionsList(model: Pick<ModelState, "elements">, which?: "all") {
  const all = allQuestions(model.elements);
  const open = all.filter((q) => q.status === "open");
  const shown = which === "all" ? all.slice(0, QUESTION_ROWS_ALL) : all.filter((q) => q.status === "open" || q.status === "assumed").slice(0, QUESTION_ROWS);
  return {
    count: all.length,
    open: open.length,
    holding_issue: open.filter((q) => q.blocksIssue).length,
    rows: shown.map((q) => questionRow(model, q, which === "all")),
    ...(which === "all" && submittalsIn(model.elements).length > 0 ? { submittals: submittalsIn(model.elements).length } : {}),
  };
}

function levelName(elements: Elements, id: string | undefined): string | null {
  const el = id ? elements[id] : undefined;
  return el?.kind === "level" ? el.name : null;
}

function plannedFacts(elements: Elements, el: Extract<BimElement, { kind: "part" }>, facts: Readonly<Facts>): Facts {
  const { level: _level, x_ft: _x, y_ft: _y, height_above_level_ft: _h, rotation_deg: _r, ...kept } = facts;
  const hint = levelName(elements, el.planned?.levelHint);
  const space = el.planned?.spaceHint ? elements[el.planned.spaceHint] : undefined;
  return {
    ...kept,
    placement: "not placed yet",
    ...(hint ? { level_hint: hint } : {}),
    ...(space?.kind === "space" ? { space_hint: spaceLabel(space) } : {}),
    ...(el.planned?.note ? { note: el.planned.note } : {}),
  };
}

function originText(elements: Elements, space: Space): string {
  const o = space.origin;
  switch (o.kind) {
    case "typed":
      return space.bounds.kind === "none" ? "typed, not drawn yet" : "typed";
    case "drawn":
      return "drawn";
    case "traced": {
      const u = elements[o.underlayId];
      return u?.kind === "drawing_underlay" ? `traced over ${u.source.name}` : "traced";
    }
    case "from_room":
      return "made from a room";
    case "from_linked_room":
      return "made from a linked model room";
    case "detected":
      return o.accepted ? "detected, accepted" : "detected, waiting for acceptance";
  }
}

/** Estimate groups by scope ("space:<id>", "zone:<id>"), from one pass over the model's loads per read. */
function loadGroups(elements: Elements): Map<string, AllocationGroup[]> {
  const allocation = allocate(elements, elementsOfKind(elements, "load_point"), modelSpaceLocator(elements), allocationPolicyOf(elements));
  const out = new Map<string, AllocationGroup[]>();
  for (const g of allocation.groups) {
    const scope = g.key.split(":").slice(0, 2).join(":");
    out.set(scope, [...(out.get(scope) ?? []), g]);
  }
  return out;
}

/** "estimate 5,000 VA, devices so far 800 VA" per quantity the scope's estimates carry. */
function loadsText(groups: readonly AllocationGroup[] | undefined): Facts {
  if (!groups || groups.length === 0) return {};
  const lines = groups.flatMap((g) => QUANTITY_KEYS.filter((k) => g.figures.allocated[k] !== 0 || g.figures.actual[k] !== 0).map((k) => allocatedActualLine(g.figures, k, formatQuantity)));
  return lines.length > 0 ? { loads: lines.join("; ") } : {};
}

function spaceFacts(elements: Elements, space: Space): Facts {
  const m2 = spaceAreaM2(elements, space);
  const occupants = designOccupants(space, m2);
  const zones = zonesOfSpace(elements, space.id);
  const level = levelName(elements, space.levelId);
  return {
    number: space.number,
    name: space.name,
    level: level ?? "not on a level yet",
    ...(space.use?.name ? { use: space.use.name } : {}),
    area_ft2: m2 === null ? "no area until drawn" : Math.round(m2 * FT2_PER_M2),
    ...(occupants ? { occupants: occupants.value, occupants_from: occupants.basis === "typed" ? "typed" : "use default" } : {}),
    ...(zones.length > 0 ? { zones: zones.map((z) => z.name).join(", ") } : {}),
    origin: originText(elements, space),
    estimates_count: space.estimateCounting ? ALLOCATION_POLICY_LABELS[space.estimateCounting] : `as the model says (${ALLOCATION_POLICY_LABELS[allocationPolicyOf(elements)].toLowerCase()})`,
  };
}

/** Outlined and derived zones have no member spaces; say what they are instead of an empty list. */
function zoneShapeWords(zone: Zone): string | null {
  const b = zoneBoundsOf(zone);
  if (b.kind === "outline") return "none (drawn as an outline)";
  if (b.kind === "derived") return `none (follows ${b.hostId}, rule ${b.rule})`;
  if (b.kind === "unknown") return `none this version can read (shape "${b.storedKind}")`;
  return null;
}

function zoneFacts(elements: Elements, zone: Zone): Facts {
  const served = zone.servedBy ? elements[zone.servedBy] : undefined;
  const servedName = served?.kind === "part" ? served.mark || served.id : served ? served.id : null;
  return {
    name: zone.name,
    purpose: zone.purpose.replace(/_/g, " "),
    spaces: zoneShapeWords(zone) ?? zone.spaceIds.map((id) => {
      const s = elements[id];
      return s?.kind === "space" ? spaceLabel(s) : id;
    }).join(", "),
    served_by: servedName ? `${servedName}${served?.kind === "part" && served.planned ? " (not placed yet)" : ""}` : "nothing yet",
  };
}

function underlayFacts(elements: Elements, u: DrawingUnderlay): Facts {
  const refusal = tracingRefusal(u);
  return {
    file: u.source.name,
    ...(u.source.page ? { page: u.source.page } : {}),
    level: levelName(elements, u.levelId) ?? u.levelId,
    scale: u.calibration ? u.calibration.method.replace(/_/g, " ") : "not set",
    tracing: refusal ?? "on",
  };
}

/** Rows from bim_query_elements with planned parts, spaces, zones and underlays said in words; spaces and zones with their estimates against the devices inside. */
/** A building element's class, type, values and lock as bim_set_element sets them; a part's class only (its values read through its type). */
function elementCoreFacts(elements: Elements, el: BimElement): Facts {
  const core = elementCoreOf(el);
  const out: Facts = {};
  if (core.classId !== undefined) out.class = core.classId;
  if (core.typeId !== undefined) {
    const t = elements[core.typeId];
    out.type = t?.kind === "element_type" ? `${t.name} (${t.id})` : core.typeId;
  }
  for (const [key, v] of Object.entries(core.values ?? {})) out[`value.${key}`] = v;
  if (core.locked !== undefined) out.locked = `${core.locked.state === "existing" ? "existing conditions" : core.locked.state === "issued" ? "issued work" : core.locked.state}: ${core.locked.reason}`;
  return out;
}

export function withDesignFacts<T extends { readonly rows: readonly Row[] }>(result: T, model: Pick<ModelState, "elements">): T {
  let groups: Map<string, AllocationGroup[]> | null = null;
  const loadsOf = (scope: string) => loadsText((groups ??= loadGroups(model.elements)).get(scope));
  const rows = result.rows.map((row): Row => {
    const el = model.elements[row.id];
    if (!el) return row;
    if (el.kind === "part" && el.planned !== undefined) return { ...row, facts: plannedFacts(model.elements, el, row.facts) };
    if (el.kind === "space") return { ...row, facts: { ...row.facts, ...spaceFacts(model.elements, el), ...loadsOf(`space:${el.id}`) } };
    if (el.kind === "zone") return { ...row, facts: { ...row.facts, ...zoneFacts(model.elements, el), ...loadsOf(`zone:${el.id}`) } };
    if (el.kind === "drawing_underlay") return { ...row, facts: { ...row.facts, ...underlayFacts(model.elements, el) } };
    if (isCoreElement(el) || isClassifiedElement(el)) {
      const core = elementCoreFacts(model.elements, el);
      return Object.keys(core).length > 0 ? { ...row, facts: { ...row.facts, ...core } } : row;
    }
    return row;
  });
  return { ...result, rows };
}
