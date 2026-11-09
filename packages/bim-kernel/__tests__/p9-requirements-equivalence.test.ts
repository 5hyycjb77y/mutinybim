/**
 * @jest-environment node
 *
 * Round 9 P9: the requirements engine's cold build got cheaper (no totals
 * object per counter move, keys reused, a group's allocation re-folded only
 * when it changed). Every figure it reports must be exactly what it reported
 * before, to the last digit, through 200 random edits per seed: device and
 * estimate values with odd decimals, estimates appearing and disappearing,
 * a space's counting setting flipping, typical copies changing, loads added
 * and removed, a "max" quantity (minimum inlet pressure) alongside summed
 * ones. The fixture holds a digest of every step's figures as the engine
 * computed them before the change (P9_WRITE_GOLDEN=1 rewrites it).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RequirementsEngine, asElementId, fixedSpaceLocator, freezeElements, type BimElement, type ElementId, type Level, type LoadPointElement, type OrganizationElementRecord, type Space, type SpaceMeasure } from "../src";

const GOLDEN = path.join(__dirname, "fixtures", "p9-requirements-golden.json");

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POLICIES = [undefined, "max", "actual_only", "allocation_only"] as const;

function groupRecord(id: string, copies: number): OrganizationElementRecord {
  return {
    id: asElementId(id),
    version: 1,
    authoredRev: {},
    kind: "organization",
    entry: {
      type: "group",
      name: id,
      color: "#336699",
      description: "",
      locked: false,
      defaultVisibility: "show",
      order: 1,
      typical: { label: "Unit", mark: "001", basePoint: { x: 0, y: 0 }, copies: Array.from({ length: copies }, (_, i) => ({ id: `${id}:${i + 2}`, mark: String(i + 2).padStart(3, "0"), offset: { x: 10_000 * (i + 1), y: 0 }, rotationDeg: 0 })) },
    },
  };
}

/** Every step's figures, as one string: what the engine says after advancing, and what a fresh one says. */
function run(seed: number): { digest: string; steps: number; sample: string } {
  const rnd = prng(seed);
  const odd = (scale: number) => Math.round(rnd() * scale * 1e4) / 1e4 + 0.0001;
  const level = asElementId("lvl-1");
  const spaces: ElementId[] = Array.from({ length: 24 }, (_, i) => asElementId(`sp-${i}`));
  const zones: Record<string, ElementId[]> = { "zone-a": spaces.slice(0, 8), "zone-b": spaces.slice(6, 16) };
  const measures: Record<string, SpaceMeasure> = {};
  const spaceOf: Record<string, ElementId> = {};
  const elements: Record<string, BimElement> = {};
  const lvl: Level = { id: level, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  elements[level] = lvl;
  elements["g-unit"] = groupRecord("g-unit", 3);
  spaces.forEach((sid, i) => {
    const space: Space = { id: sid, kind: "space", version: 1, authoredRev: {}, number: sid, name: sid, levelId: level, bounds: { kind: "none" }, origin: { kind: "typed" }, ...(i % 5 === 0 ? { groupId: "g-unit" } : {}), ...(POLICIES[i % 4] ? { estimateCounting: POLICIES[i % 4] } : {}) };
    elements[sid] = space;
    measures[sid] = { areaSqM: odd(200), occupants: 1 + Math.floor(rnd() * 30) };
  });
  const load = (id: string, rest: Omit<LoadPointElement, "id" | "kind" | "version" | "authoredRev" | "connectionType">): LoadPointElement => ({ id: asElementId(id), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", ...rest });
  const values = (): LoadPointElement["values"] => ({ va: odd(900), wsfu_total: odd(4), dfu: odd(3), min_inlet_pressure: odd(30) });
  let nextDevice = 0;
  const addDevice = () => {
    const part = asElementId(`part-${nextDevice}`);
    spaceOf[part] = spaces[Math.floor(rnd() * spaces.length)] as ElementId;
    const id = `dev-${nextDevice++}`;
    elements[id] = load(id, { anchor: { kind: "part", partId: part }, values: values(), ...(rnd() < 0.15 ? { groupId: "g-unit" } : {}) });
    return id;
  };
  const addEstimate = (scope: { kind: "space" | "zone"; id: ElementId }, n: number) => {
    const id = `est-${scope.id}-${n}`;
    elements[id] = rnd() < 0.5 ? load(id, { anchor: { kind: scope.kind, id: scope.id }, basis: "density", rates: [{ key: "va", per: "area", value: odd(15) }, { key: "min_inlet_pressure", per: "occupant", value: odd(2) }], values: {} }) : load(id, { anchor: { kind: scope.kind, id: scope.id }, values: values() });
    return id;
  };
  for (let i = 0; i < 160; i++) addDevice();
  spaces.forEach((sid, i) => {
    if (i % 3 !== 2) addEstimate({ kind: "space", id: sid }, 0);
  });
  addEstimate({ kind: "zone", id: asElementId("zone-a") }, 0);
  addEstimate({ kind: "zone", id: asElementId("zone-b") }, 0);
  const locator = fixedSpaceLocator({ spaceOf, measures, zones });
  let model = { elements: freezeElements({ ...elements }) };
  const engine = new RequirementsEngine({ locator });
  const out: string[] = [];
  const figures = (m: typeof model, e: RequirementsEngine) => {
    const loads = Object.values(m.elements).filter((x) => x.kind === "load_point").map((x) => x.id).sort();
    const picks = [0, 1, 2, 3, 4].map(() => loads[Math.floor(rnd() * loads.length)] as string);
    return JSON.stringify({
      counted: e.counted(m),
      project: e.progress(m),
      electrical: e.progress(m, { kind: "trade", trade: "electrical" }),
      plumbing: e.progress(m, { kind: "trade", trade: "plumbing" }),
      space: [spaces[Math.floor(rnd() * spaces.length)] as string, "sp-0", "sp-5"].map((id) => e.scopeFigures(m, { kind: "space", id })),
      zones: ["zone-a", "zone-b"].map((id) => e.scopeFigures(m, { kind: "zone", id })),
      loads: picks.map((id) => [id, e.statusOf(m, id), e.valueOf(m, id), e.countedOf(m, id), e.allocatedActual(m, id)]),
    });
  };
  out.push(figures(model, engine));
  let steps = 0;
  for (let step = 0; step < 200; step++) {
    const next: Record<string, BimElement> = { ...model.elements };
    const changed: string[] = [];
    const roll = rnd();
    const loadIds = Object.keys(next).filter((id) => next[id]?.kind === "load_point");
    const pick = () => loadIds[Math.floor(rnd() * loadIds.length)] as string;
    if (roll < 0.35) {
      const id = pick();
      const lp = next[id] as LoadPointElement;
      next[id] = lp.basis === "density" ? { ...lp, version: lp.version + 1, rates: [{ key: "va", per: "area", value: odd(15) }] } : { ...lp, version: lp.version + 1, values: values() };
      changed.push(id);
    } else if (roll < 0.5) {
      const id = addDevice();
      next[id] = elements[id] as BimElement;
      changed.push(id);
    } else if (roll < 0.62) {
      const id = pick();
      delete next[id];
      changed.push(id);
    } else if (roll < 0.74) {
      const sid = spaces[Math.floor(rnd() * spaces.length)] as ElementId;
      const id = addEstimate({ kind: "space", id: sid }, step + 1);
      next[id] = elements[id] as BimElement;
      changed.push(id);
    } else if (roll < 0.86) {
      const sid = spaces[Math.floor(rnd() * spaces.length)] as ElementId;
      const s = next[sid] as Space;
      const policy = POLICIES[Math.floor(rnd() * POLICIES.length)];
      const { estimateCounting: _drop, ...rest } = s;
      next[sid] = { ...rest, version: s.version + 1, ...(policy ? { estimateCounting: policy } : {}) };
      changed.push(sid);
    } else {
      next["g-unit"] = { ...groupRecord("g-unit", 1 + Math.floor(rnd() * 6)), version: step + 2 };
      changed.push("g-unit");
    }
    model = { elements: freezeElements(next) };
    engine.advance(model, changed);
    out.push(figures(model, engine));
    out.push(figures(model, new RequirementsEngine({ locator })));
    steps += 1;
  }
  const all = out.join("\n");
  return { digest: createHash("sha256").update(all).digest("hex"), steps, sample: out[out.length - 1] ?? "" };
}

const SEEDS = [11, 4242, 90210];

describe("p9-requirements-equivalence: the cheaper engine reports exactly what it reported before", () => {
  const results = new Map(SEEDS.map((seed) => [seed, run(seed)]));

  if (process.env.P9_WRITE_GOLDEN === "1") {
    it("writes the golden digests from this engine", () => {
      const golden = Object.fromEntries(SEEDS.map((seed) => [String(seed), { digest: results.get(seed)?.digest, steps: results.get(seed)?.steps, lastStep: results.get(seed)?.sample }]));
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
      expect(Object.keys(golden)).toHaveLength(SEEDS.length);
    });
    return;
  }

  const golden: Record<string, { digest: string; steps: number; lastStep: string }> = JSON.parse(readFileSync(GOLDEN, "utf8"));
  for (const seed of SEEDS) {
    it(`seed ${seed}: 200 edits, every figure identical to the engine before round 9`, () => {
      const r = results.get(seed);
      const g = golden[String(seed)];
      expect(r?.steps).toBe(200);
      expect(r?.sample).toBe(g?.lastStep);
      expect(r?.digest).toBe(g?.digest);
    });
  }
});
