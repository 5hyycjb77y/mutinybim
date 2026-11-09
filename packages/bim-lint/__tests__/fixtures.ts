import { asElementId, builtinPartType, DEFAULT_SETTINGS, planCommit, type BimElement, type Command, type ModelState, type RunSize } from "@permitzip/bim-kernel";
import { DEFAULT_LINT_CONFIG, LintEngine, type LinkedModelIndex, type LintConfig } from "../src";

export const FT = 304.8;
export const IN = 25.4;
export const ROOF_ELEVATION = 24.5 * FT;

export const RTU = builtinPartType("builtin:rtu-5-ton@1");
export const DIFFUSER = builtinPartType("builtin:supply-diffuser-24@1");

let seq = 0;

/** An in-test sequencer: the authority's own commit path. */
export class Model {
  head: ModelState = { modelId: "site-7334", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  private placedTypes = new Set<string>();

  constructor(levels = true) {
    if (levels) {
      this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
      this.ok({ type: "create_level", levelId: "lvl-roof", name: "ROOF", elevationMm: ROOF_ELEVATION });
    }
  }

  /** Commits and returns the changed and removed ids (what an agent session reports). */
  ok(command: Command): string[] {
    const r = this.try(command);
    if (typeof r === "string") throw new Error(`expected ${command.type} to commit: ${r}`);
    return r;
  }

  /** Commits, or returns the refusal. */
  try(command: Command): string[] | string {
    seq += 1;
    const d = planCommit(this.head, [], { idempotencyKey: `lint-fixture-${seq}-key`, baseRevision: this.head.revision, actor: { id: "agent:lint", name: "Agent", kind: "agent" }, command });
    if (!d.ok) return d.error.message;
    this.head = d.model;
    return [...d.changeset.elements.map((e) => e.id as string), ...(d.changeset.removedIds ?? []).map((x) => x as string)];
  }

  /** Puts raw elements in (slabs, rooms, views: things with no authoring command in this fixture). */
  put(...elements: BimElement[]): void {
    const next = { ...this.head.elements };
    for (const e of elements) next[e.id] = e;
    this.head = { ...this.head, elements: next, revision: (this.head.revision + 1) as ModelState["revision"] };
  }

  placeRtu(id: string, at: { x: number; y: number }, offsetMm = 0, levelId = "lvl-roof"): string[] {
    if (!RTU) throw new Error("starter library is missing the RTU");
    const first = !this.placedTypes.has(RTU.id);
    this.placedTypes.add(RTU.id);
    return this.ok({ type: "place_part", partId: id, typeId: RTU.id, ...(first ? { partType: RTU.definition } : {}), levelId, position: at, offsetMm, mark: id.toUpperCase() });
  }

  placeDiffuser(id: string, at: { x: number; y: number }, offsetMm = 9 * FT, airflow?: number): string[] {
    if (!DIFFUSER) throw new Error("starter library is missing the diffuser");
    const first = !this.placedTypes.has(DIFFUSER.id);
    this.placedTypes.add(DIFFUSER.id);
    return this.ok({ type: "place_part", partId: id, typeId: DIFFUSER.id, ...(first ? { partType: DIFFUSER.definition } : {}), levelId: "lvl-1", position: at, offsetMm, mark: id.toUpperCase(), ...(airflow !== undefined ? { values: { airflow } } : {}) });
  }

  /** A duct run along plan points (feet) at one height (feet above the level). */
  duct(idPrefix: string, system: { id: string; kind: "supply_air" | "return_air"; name: string }, pointsFt: ReadonlyArray<readonly [number, number]>, elevationFt: number, size: RunSize = { shape: "rect", width: 20 * IN, height: 12 * IN }, levelId = "lvl-1"): string[] {
    return this.ok({ type: "route_run", idPrefix, levelId, domain: "duct", size, elevationMm: elevationFt * FT, system, points: pointsFt.map(([x, y]) => ({ x: x * FT, y: y * FT })) });
  }
}

export const SUPPLY = { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" } as const;
export const RETURN = { id: "sys-ra", kind: "return_air", name: "Return Air 1" } as const;

/** The architect's linked model: a 60 x 40 ft building, Level 1 floor and a ROOF slab, one beam under the roof. */
export function linkedBuilding(opts: { storeys?: Array<{ name: string; elevationMm: number }>; beam?: boolean } = {}): LinkedModelIndex {
  const slab = (gid: string, name: string, top: number, kind: "slab" | "roof") => ({
    globalId: gid,
    name,
    ifcClass: kind === "roof" ? "IFCROOF" : "IFCSLAB",
    kind,
    storey: name,
    box: [0, 0, top - FT, 60 * FT, 40 * FT, top] as const,
    hull: [0, 0, 60 * FT, 0, 60 * FT, 40 * FT, 0, 40 * FT],
  });
  return {
    modelId: "linked-arch-v3",
    label: "Architecture",
    discipline: "architecture",
    storeys: opts.storeys ?? [
      { name: "LEVEL 01", elevationMm: 0 },
      { name: "ROOF", elevationMm: ROOF_ELEVATION },
    ],
    elements: [
      slab("2Fq-level1-slab", "Level 1", 0, "slab"),
      slab("2Fq-roof-slab", "ROOF", ROOF_ELEVATION, "roof"),
      ...(opts.beam === false
        ? []
        : [
            {
              globalId: "2Fq-beam-w12",
              name: "BEAM W12x26",
              ifcClass: "IFCBEAM",
              kind: "beam" as const,
              storey: "ROOF",
              box: [30 * FT - 3 * IN, 0, ROOF_ELEVATION - FT - 12 * IN, 30 * FT + 3 * IN, 40 * FT, ROOF_ELEVATION - FT] as const,
            },
          ]),
    ],
  };
}

export function config(over: Partial<LintConfig> = {}): LintConfig {
  return { ...DEFAULT_LINT_CONFIG, ...over };
}

export function engineFor(model: ModelState, linked: LinkedModelIndex[] = []): LintEngine {
  const e = new LintEngine();
  e.build(model, linked);
  return e;
}

/** Every finding on the model, by rule. */
export function rulesFired(model: ModelState, linked: LinkedModelIndex[] = [], over: Partial<LintConfig> = {}): Map<string, string[]> {
  const e = engineFor(model, linked);
  const out = new Map<string, string[]>();
  for (const f of e.check({ config: config({ ruleset: "issue", ...over }) })) out.set(f.rule, [...(out.get(f.rule) ?? []), f.message]);
  return out;
}

export const id = asElementId;
