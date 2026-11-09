import { documentIndex, elementsOfKind, elementValues, evaluateDiagram, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { aabbOverlap, growAabb, p3, unionAabb, type Aabb } from "./geometry/convex";
import { IndexState, pointInPolygon, type BodyRecord, type Surface } from "./index-state";
import { findingId, rulesFor, type RuleContext, type RuleDef } from "./rules/registry";
import { activeLintRules } from "./rules";
import { elementName, elementShape } from "./shapes";
import type { Finding, LintConfig, LinkedModelIndex, LinkedRef } from "./types";

/**
 * The lint engine: a derived read over one model revision. It never edits
 * and never blocks a save. Like the aggregation engine it is told what an
 * edit changed (`advance(model, changedIds)`) and updates only those
 * elements' bodies; findings are computed on demand for a region, so a
 * 250k-element model with thousands of old clashes costs only the region
 * the edit touched.
 */

type Elements = ModelState["elements"];

const MM_PER_FT = 304.8;
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;
/** How far below a body "what's here" looks first for the surface it stands on (two storeys). */
const HOST_WINDOW_MM = 2 * 14 * MM_PER_FT;

export class LintDeadline extends Error {
  constructor() {
    super("The lint ran past its time budget");
    this.name = "LintDeadline";
  }
}

export interface LintRunOptions {
  readonly config: LintConfig;
  /** The model before the edit, for edit-scope rules (crop jumps, a person's view changed). */
  readonly previous?: ModelState | null;
  readonly editedByAgent?: boolean;
  readonly projectName?: string | null;
  /** performance.now() past which the run stops with LintDeadline. */
  readonly deadline?: number;
  /** Finding ids a person accepted; left out unless `includeAccepted`. */
  readonly accepted?: ReadonlySet<string>;
  readonly includeAccepted?: boolean;
}

export interface LintScope {
  /** Bodies whose boxes meet this box are in scope. Null: no spatial scope (documents only). */
  readonly box: Aabb | null;
  /** Views, sheets, viewports and drawing items to run document rules on (expanded to related ones). */
  readonly documents: readonly string[];
  /** Elements the edit changed (edit-scope rules), and our elements with no body to test anyway (a view's crop). */
  readonly changed: readonly string[];
  /** Run every system and document rule on everything (a full check). */
  readonly all?: boolean;
  /**
   * Clash pairs are measured only from these elements (an edit's changed
   * ones). A pair of two untouched elements is the same before and after, so
   * it can't be new or resolved; the lint block skips it. Absent: every
   * element in scope (bim_lint_check).
   */
  readonly pairsFrom?: readonly string[];
}

export interface RuleAvailability {
  readonly rule: string;
  readonly pack: string;
  readonly title: string;
  readonly available: boolean;
  readonly reason: string | null;
}

const DOC_KINDS = new Set(["view", "sheet", "viewport", "drawing_item"]);

function neighbours(el: BimElement | undefined): string[] {
  if (!el) return [];
  switch (el.kind) {
    case "run_segment":
      return [el.links.start?.elementId, el.links.end?.elementId, ...el.branches].filter((x): x is NonNullable<typeof x> => x !== undefined) as string[];
    case "run_fitting":
      return [...el.ports.map((p) => p.link?.elementId), el.host?.segmentId].filter((x): x is NonNullable<typeof x> => x !== undefined) as string[];
    case "part":
      return Object.values(el.links ?? {}).map((r) => r.elementId as string);
    default:
      return [];
  }
}

export class LintEngine {
  private state: IndexState | null = null;
  private current: ModelState | null = null;
  private linkedModels: readonly LinkedModelIndex[] = [];

  /** `rules`: a fixed list (tests, a panel). Absent: the built-in rules plus the pack set in force's, read on every run. */
  constructor(private readonly fixedRules: readonly RuleDef[] | null = null) {}

  private get rules(): readonly RuleDef[] {
    return this.fixedRules ?? activeLintRules();
  }

  /** The revision the engine has read, or null before `build`. */
  get revision(): number | null {
    return this.current?.revision ?? null;
  }

  get model(): ModelState | null {
    return this.current;
  }

  get linked(): readonly LinkedModelIndex[] {
    return this.linkedModels;
  }

  /** Index every element (cold). */
  build(model: ModelState, linked: readonly LinkedModelIndex[] = this.linkedModels): void {
    this.current = model;
    const state = new IndexState(model.elements);
    this.state = state;
    this.linkedModels = linked;
    state.bulkLoad(() => {
      state.buildAll();
      state.setLinked(linked);
    });
  }

  /** Replace the linked models' read-only elements. */
  setLinked(linked: readonly LinkedModelIndex[]): void {
    this.linkedModels = linked;
    this.state?.setLinked(linked);
  }

  /**
   * Tell the engine `model` is the last model it read with only `changedIds`
   * changed or removed (a committed changeset's changed and removed ids).
   */
  advance(model: ModelState, changedIds: Iterable<string>): void {
    if (!this.state || !this.current) {
      this.build(model);
      return;
    }
    this.state.apply(model.elements, changedIds);
    this.current = model;
  }

  /** Boxes `ids` have in `model` (before the engine reads it): the scope of an edit on both sides. */
  boxesIn(model: ModelState, ids: readonly string[]): Aabb[] {
    const out: Aabb[] = [];
    const levelElevation = (name: string) => this.state?.elevationOfLevel(name) ?? null;
    for (const id of ids) {
      const el = model.elements[id];
      if (!el) continue;
      const s = elementShape(model.elements, el, levelElevation);
      if (s) out.push(s.box);
    }
    return out;
  }

  /** The scope of an edit: the changed elements' boxes before and after, grown by the scope radius. */
  scopeFor(changedIds: readonly string[], before: readonly Aabb[], after: readonly Aabb[], radiusMm: number): LintScope {
    let box: Aabb | null = null;
    for (const b of [...before, ...after]) box = box ? unionAabb(box, b) : b;
    return { box: box ? growAabb(box, radiusMm) : null, documents: changedIds.filter((id) => DOC_KINDS.has(this.current?.elements[id]?.kind ?? "")), changed: changedIds };
  }

  /** Findings for one scope, at the revision the engine holds. Sorted: errors first, then by id. */
  run(scope: LintScope, opts: LintRunOptions): Finding[] {
    const state = this.state;
    const model = this.current;
    if (!state || !model) throw new Error("The lint engine has not read a model yet");
    const avail = { model, linked: this.linkedModels, hasNativeCeilings: state.hasNativeCeilings() };
    const rules = rulesFor(this.rules, opts.config).filter((r) => !r.available || r.available(avail) === null);
    const found = new Map<string, Finding>();
    const ctx = this.context(model, state, opts, found, new Set(scope.all ? [] : scope.changed), scope.pairsFrom ? new Set(scope.pairsFrom) : null);
    const tick = () => {
      if (opts.deadline !== undefined && performance.now() > opts.deadline) throw new LintDeadline();
    };

    const elementRules = rules.filter((r) => r.scope === "element");
    const systemRules = rules.filter((r) => r.scope === "system");
    const pairsFrom = ctx.pairsFrom;
    // Per kind: every element rule, and the ones still worth calling on an element outside pairsFrom.
    const byKind = new Map<string, { readonly all: readonly RuleDef[]; readonly outside: readonly RuleDef[] }>();
    const rulesOf = (kind: string) => {
      let entry = byKind.get(kind);
      if (!entry) {
        const all = elementRules.filter((r) => !r.kinds || r.kinds.some((k) => k === kind));
        entry = { all, outside: all.filter((r) => !r.pairsOnly) };
        byKind.set(kind, entry);
      }
      return entry;
    };
    const rulesHere = (id: string, kind: string) => {
      const entry = rulesOf(kind);
      return pairsFrom === null || pairsFrom.has(id) ? entry.all : entry.outside;
    };
    const opensSystem = (kind: string) => systemRules.length > 0 && (kind === "run_segment" || kind === "run_fitting" || kind === "mep_system");

    // Our elements in scope: every body whose box meets the scope box, plus changed elements with no body.
    // A body whose kind has no rule to run here and opens no system is skipped without reading its element.
    const inScope = new Map<string, BimElement>();
    if (scope.all) {
      for (const el of elementValues(model.elements)) inScope.set(el.id, el);
    } else {
      if (scope.box) {
        for (const slot of state.grid.query(scope.box)) {
          const id = state.elementIdAt(slot);
          const kind = state.elementKindAt(slot);
          if (!id || kind === null || (rulesHere(id, kind).length === 0 && !opensSystem(kind))) continue;
          inScope.set(id, model.elements[id] as BimElement);
        }
      }
      for (const id of scope.changed) {
        const el = model.elements[id];
        if (el && !inScope.has(id) && !DOC_KINDS.has(el.kind)) inScope.set(id, el);
      }
    }
    const ids: string[] = [];
    for (const [id, el] of inScope) if (rulesHere(id, el.kind).length > 0) ids.push(id);
    ids.sort();
    for (const id of ids) {
      const el = inScope.get(id);
      if (!el) continue;
      for (const r of rulesHere(id, el.kind)) r.run(ctx, el);
      tick();
    }
    if (inScope.size > 0) tick();

    // Rules that read other kinds (`reads`): when the edit changed one of those kinds, re-run them on every element they lint, wherever it is.
    const readers = scope.all ? [] : elementRules.filter((r) => (r.reads?.length ?? 0) > 0);
    if (readers.length > 0 && scope.changed.length > 0) {
      const changedKinds = new Set<string>();
      let unknownKind = false;
      for (const id of scope.changed) {
        const kind = (model.elements[id] ?? opts.previous?.elements[id])?.kind;
        if (kind === undefined) unknownKind = true;
        else changedKinds.add(kind);
      }
      const ran = new Set(ids);
      for (const r of readers) {
        if (!unknownKind && !(r.reads ?? []).some((k) => changedKinds.has(k))) continue;
        const targets = r.kinds ? elementsOfKind(model.elements, ...r.kinds) : elementValues(model.elements);
        for (const el of targets) {
          if (ran.has(el.id) || !rulesHere(el.id, el.kind).includes(r)) continue;
          r.run(ctx, el);
        }
        tick();
      }
    }

    // Systems with a run in scope (or every system).
    if (systemRules.length > 0) {
      const systems = new Set<string>();
      for (const el of inScope.values()) {
        if (el.kind === "run_segment" || el.kind === "run_fitting") systems.add(el.systemId);
        if (el.kind === "mep_system") systems.add(el.id);
      }
      for (const id of scope.changed) if (model.elements[id]?.kind === "mep_system") systems.add(id);
      for (const id of [...systems].sort()) {
        const sys = model.elements[id];
        if (!sys) continue;
        for (const r of systemRules) r.run(ctx, sys);
        tick();
      }
    }

    // Documents the edit touched, and the ones related to them.
    const docRules = rules.filter((r) => r.scope === "document");
    if (docRules.length > 0) {
      for (const id of this.documentTargets(model, scope)) {
        const el = model.elements[id];
        if (!el) continue;
        for (const r of docRules) if (!r.kinds || r.kinds.includes(el.kind)) r.run(ctx, el);
        tick();
      }
    }

    const editRules = rules.filter((r) => r.scope === "edit");
    if (editRules.length > 0) {
      for (const id of scope.changed) {
        const el = model.elements[id];
        if (!el) continue;
        for (const r of editRules) if (!r.kinds || r.kinds.includes(el.kind)) r.run(ctx, el);
      }
    }

    const out = [...found.values()].filter((f) => opts.includeAccepted || !opts.accepted?.has(f.id));
    out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /** Every finding on the model (or one level), for bim_lint_check and the Coordination panel. */
  check(opts: LintRunOptions & { readonly level?: string; readonly ids?: readonly string[] }): Finding[] {
    const model = this.current;
    if (!model) throw new Error("The lint engine has not read a model yet");
    if (opts.ids && opts.ids.length > 0) {
      const boxes = this.boxesIn(model, opts.ids);
      return this.run({ ...this.scopeFor(opts.ids, boxes, [], opts.config.scope_radius_ft * MM_PER_FT), changed: opts.ids }, opts);
    }
    const all = this.run({ box: null, documents: [], changed: [], all: true }, opts);
    if (!opts.level) return all;
    const want = opts.level.toLowerCase();
    return all.filter((f) => f.at.level.toLowerCase() === want);
  }

  /** Which rules this configuration runs, and which can't run on this model yet (and why). */
  availability(config: LintConfig): RuleAvailability[] {
    const model = this.current;
    return rulesFor(this.rules, config).map((r) => {
      const reason = model && r.available ? r.available({ model, linked: this.linkedModels, hasNativeCeilings: this.state?.hasNativeCeilings() ?? false }) : null;
      return { rule: r.id, pack: r.pack, title: r.title, available: reason === null, reason };
    });
  }

  /** "What's here": the level, room and surface under the first changed element, and the nearest named things. */
  near(ids: readonly string[], radiusMm: number, limit = 6): { level: string | null; room: string | null; host: string | null; within: Array<{ name: string; distanceFt: number; direction: string }> } {
    const state = this.state;
    const model = this.current;
    if (!state || !model) return { level: null, room: null, host: null, within: [] };
    const ordered = [...ids].sort((a, b) => rank(model.elements[a]) - rank(model.elements[b]));
    const primaryId = ordered.find((id) => state.hasBody(id));
    if (!primaryId) {
      const el = ordered.map((id) => model.elements[id]).find((e) => e !== undefined);
      return { level: el ? this.levelNameOf(model, el) || null : null, room: null, host: null, within: [] };
    }
    const body = state.body(primaryId) as BodyRecord;
    const el = model.elements[primaryId] as BimElement;
    const cx = (body.box.min.x + body.box.max.x) / 2;
    const cy = (body.box.min.y + body.box.max.y) / 2;
    const bottom = body.box.min.z;
    const { room, host } = this.roomAndHost(state, cx, cy, bottom);
    const changed = new Set(ids);
    // Every body within the radius, in grid order, with no record or name built yet.
    const slots: number[] = [];
    const dists: number[] = [];
    for (const slot of state.grid.query(growAabb(body.box, radiusMm))) {
      if (slot === body.slot) continue;
      const elementId = state.elementIdAt(slot);
      if ((elementId && changed.has(elementId)) || state.linkedKindAt(slot) === "space") continue;
      const d = state.grid.distanceTo(slot, body.box);
      if (d > radiusMm) continue;
      slots.push(slot);
      dists.push(d);
    }
    // Only the nearest `limit` can be listed: name those (and any tied with the last), then sort them by distance and name.
    // The sort is stable, so this is the head of the same sort over every body in reach.
    let cutoff = Infinity;
    if (limit > 0 && dists.length > limit) cutoff = [...dists].sort((a, b) => a - b)[limit - 1] as number;
    const items: Array<{ name: string; d: number; dx: number; dy: number }> = [];
    for (let i = 0; i < slots.length; i++) {
      const d = dists[i] as number;
      if (d > cutoff) continue;
      const slot = slots[i] as number;
      items.push({ name: state.labelAt(slot, model.elements), d, dx: state.grid.centreX(slot) - cx, dy: state.grid.centreY(slot) - cy });
    }
    items.sort((a, b) => a.d - b.d || (a.name < b.name ? -1 : 1));
    const hostTop = host ? (host.kind === "room" || host.kind === "space" ? host.bottom : host.top) : null;
    return {
      level: this.levelNameOf(model, el) || null,
      room: room ? `${room.name}${room.linked ? " (linked)" : ""}` : null,
      host: host && hostTop !== null ? `${host.linked ? "linked " : ""}${host.name} ${host.kind === "room" || host.kind === "space" ? "floor" : "top"} ${feetInchesLabel(hostTop)}` : null,
      within: items.slice(0, limit).map((i) => ({ name: i.name, distanceFt: Math.round((i.d / MM_PER_FT) * 10) / 10, direction: compassOf(i.dx, i.dy) })),
    };
  }

  /**
   * The room a body standing at (x, y, bottom) is in, and the surface it stands on: the highest
   * floor or top at most 13 mm above its bottom. Read from the storeys around it first; the whole
   * plan column only when nothing there can hold it. The window's surfaces are the column's, in
   * the column's order, so the answer is the same.
   */
  private roomAndHost(state: IndexState, x: number, y: number, bottom: number): { room: Surface | null; host: Surface | null } {
    const pick = (surfaces: readonly Surface[]) => {
      const room = surfaces.find((s) => (s.kind === "room" || s.kind === "space") && s.bottom <= bottom + 50 && s.top >= bottom) ?? null;
      let host: Surface | null = null;
      for (const s of surfaces) {
        const top = s.kind === "room" || s.kind === "space" ? s.bottom : s.top;
        if (top <= bottom + 13 && (!host || top > (host.kind === "room" || host.kind === "space" ? host.bottom : host.top))) host = s;
      }
      return { room, host };
    };
    const low = bottom - HOST_WINDOW_MM;
    const near = pick(this.surfacesIn(state, x, y, low, bottom + 50));
    const hostTop = near.host ? (near.host.kind === "room" || near.host.kind === "space" ? near.host.bottom : near.host.top) : null;
    // Every surface whose floor or top is within [low, bottom + 13] meets the window, so a host found there is the column's.
    if (hostTop !== null && hostTop >= low) return near;
    return pick(this.surfacesAt(state, x, y));
  }

  private surfacesIn(state: IndexState, x: number, y: number, z0: number, z1: number): Surface[] {
    const out: Surface[] = [];
    for (const slot of state.surfaceGrid.query({ min: p3(x, y, z0), max: p3(x, y, z1) })) {
      const s = state.surfaceAt(slot);
      if (s && pointInPolygon(x, y, s.outline)) out.push(s);
    }
    return out;
  }

  private surfacesAt(state: IndexState, x: number, y: number): Surface[] {
    const out: Surface[] = [];
    for (const slot of state.surfaceGrid.query({ min: p3(x, y, -1e12), max: p3(x, y, 1e12) })) {
      const s = state.surfaceAt(slot);
      if (s && pointInPolygon(x, y, s.outline)) out.push(s);
    }
    return out;
  }

  private levelNameOf(model: ModelState, el: BimElement): string {
    if (el.kind === "part" || el.kind === "run_segment" || el.kind === "run_fitting") {
      const level = model.elements[el.levelId];
      return level?.kind === "level" ? level.name : "";
    }
    if (el.kind === "view") return el.props?.level ?? "";
    return el.partition?.level ?? "";
  }

  private documentTargets(model: ModelState, scope: LintScope): string[] {
    const targets = new Set<string>();
    if (scope.all) {
      for (const el of elementValues(model.elements)) if ((el.kind === "view" || el.kind === "sheet") && !el.deleted) targets.add(el.id);
      return [...targets].sort();
    }
    let index: ReturnType<typeof documentIndex> | null = null;
    for (const id of scope.documents) {
      const el = model.elements[id];
      if (!el) continue;
      if (el.kind === "view" || el.kind === "sheet") targets.add(id);
      if (el.kind === "viewport") {
        targets.add(el.sheetId);
        targets.add(el.viewId);
      }
      if (el.kind === "drawing_item") targets.add(el.ownerId);
      if (el.kind === "sheet") {
        index ??= documentIndex(model);
        for (const vp of index.viewportsBySheet.get(el.id) ?? []) targets.add(vp.viewId);
      }
    }
    // Diagrams that read a changed element redraw with it.
    const changed = new Set(scope.changed);
    const touchesElectrical = scope.changed.some((id) => {
      const k = model.elements[id]?.kind;
      return k === "part" || k === "service_link" || k === "part_type";
    });
    if (touchesElectrical) {
      for (const el of elementValues(model.elements)) {
        if (el.kind !== "view" || el.deleted || !el.props?.diagram) continue;
        try {
          const ev = evaluateDiagram(model.elements, el);
          if (ev?.reads.some((r) => changed.has(r))) targets.add(el.id);
        } catch (err) {
          console.error("[bim-lint] a diagram could not be evaluated for scope", { viewId: el.id, err });
        }
      }
    }
    return [...targets].sort();
  }

  private context(model: ModelState, state: IndexState, opts: LintRunOptions, found: Map<string, Finding>, changed: ReadonlySet<string>, pairsFrom: ReadonlySet<string> | null): RuleContext {
    const elements: Elements = model.elements;
    const neighbourCache = new Map<string, Set<string>>();
    const near = (id: string): Set<string> => {
      let set = neighbourCache.get(id);
      if (!set) {
        set = new Set(neighbours(elements[id]));
        neighbourCache.set(id, set);
      }
      return set;
    };
    // The index doesn't change during a run, so each body's record is built once per run.
    const records = new Map<number, BodyRecord | undefined>();
    const recordAt = (slot: number): BodyRecord | undefined => {
      if (records.has(slot)) return records.get(slot);
      const b = state.bodyAt(slot);
      records.set(slot, b);
      return b;
    };
    const recordsAt = (slots: readonly number[]): BodyRecord[] => {
      const out: BodyRecord[] = [];
      for (const slot of slots) {
        const b = recordAt(slot);
        if (b) out.push(b);
      }
      return out;
    };
    const bodiesNear = (box: Aabb): BodyRecord[] => recordsAt(state.grid.query(box));
    return {
      model,
      config: opts.config,
      linked: this.linkedModels,
      previous: opts.previous ?? null,
      changed,
      pairsFrom,
      editedByAgent: opts.editedByAgent ?? false,
      projectName: opts.projectName ?? null,
      body: (id) => {
        const slot = state.slotOfKey(id);
        return slot === undefined ? undefined : recordAt(slot);
      },
      bodiesNear,
      obstaclesNear: (box) => recordsAt(state.obstacleSlotsNear(box)),
      surfacesAt: (x, y) => this.surfacesAt(state, x, y),
      surfacesNear: (box) => {
        const out: Surface[] = [];
        for (const slot of state.surfaceGrid.query(box)) {
          const s = state.surfaceAt(slot);
          if (s) out.push(s);
        }
        return out;
      },
      systemMembers: (id) => state.systemMembers(id),
      measured: (a, b, far) => state.pair(a, b, far),
      remember: (a, b, far, m) => state.setPair(a, b, far, m),
      nativeCeilings: () => state.nativeCeilings(),
      joined: (a, b) => {
        const na = near(a);
        if (na.has(b) || near(b).has(a)) return true;
        // Both joined to the same run segment or fitting: they meet by design (an elbow's two legs, a tap's trunk and branch).
        for (const m of na) {
          const k = elements[m]?.kind;
          if ((k === "run_fitting" || k === "run_segment") && near(m).has(b)) return true;
          if ((k === "run_fitting" || k === "run_segment") && near(b).has(m)) return true;
        }
        return false;
      },
      levelNameOf: (el) => this.levelNameOf(model, el),
      elevationOfLevel: (name) => state.elevationOfLevel(name),
      name: (id) => {
        const el = elements[id];
        return el ? elementName(elements, el) : id;
      },
      emit: (f) => {
        const elementIds = [...new Set(f.elementIds)].sort();
        const linked: LinkedRef[] | undefined = f.linked ? [...f.linked] : undefined;
        const id = findingId(f.rule, elementIds, linked ?? []);
        if (found.has(id)) return;
        found.set(id, { ...f, id, elementIds, ...(linked ? { linked } : {}) });
      },
    };
  }

  /** True when the scope box meets any of these boxes (callers decide whether an edit can matter). */
  static touches(scope: LintScope, box: Aabb): boolean {
    return scope.box !== null && aabbOverlap(scope.box, box);
  }
}

function rank(el: BimElement | undefined): number {
  if (!el) return 9;
  if (el.kind === "part") return 0;
  if (el.kind === "run_segment") return 1;
  if (el.kind === "run_fitting") return 2;
  return 5;
}

function compassOf(dx: number, dy: number): string {
  if (Math.hypot(dx, dy) < 150) return "here";
  const names = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
  const i = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  return names[i] as string;
}

function feetInchesLabel(mm: number): string {
  const totalIn = Math.round(Math.abs(mm) / 25.4);
  return `${mm < 0 ? "-" : ""}${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}
