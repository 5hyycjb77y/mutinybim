import { loadAnchorOf, loadPointQuantities, paramValue, resolveConnectors, systemKindsServedBy, type BimElement, type ElementId, type LoadPointElement, type ModelState } from "@permitzip/bim-kernel";
import { greaseInterceptorLoads } from "../../plumbing/grease";

type Elements = Readonly<Record<string, BimElement>>;

/** One fixture as the grease interceptor calc takes it (plumbing.grease_interceptor `fixtures`). */
export interface PipedGreaseFixture {
  readonly label: string;
  readonly quantity: number;
  readonly volume_gal?: number;
  readonly length_in?: number;
  readonly width_in?: number;
  readonly depth_in?: number;
  readonly compartments: number;
}

export interface PipedGreaseFixtures {
  readonly interceptorName: string;
  readonly fixtures: readonly PipedGreaseFixture[];
  /** Loads that drain through the interceptor with no bowl size given: listed, never guessed. */
  readonly missing: readonly string[];
  readonly loadIds: readonly ElementId[];
}

const MM_PER_IN = 25.4;

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** "plumb.compartment_length" → "compartment length": a connector value key read by its last segment, so any pack namespace works. */
const keyWords = (key: string) => norm(key.split(/[.:]/).pop() ?? key);

/**
 * A bowl number by name: the load's own values first ("compartment length"
 * in its custom quantities), then the fixture's drain connector `values`
 * (`plumb.compartment_length`, inches; `plumb.compartment_volume`, gallons;
 * `plumb.compartments`), then the fixture's parameters.
 */
function bowlReader(elements: Elements, lp: LoadPointElement): (name: string) => number | undefined {
  const custom = loadPointQuantities(elements, lp).custom ?? [];
  const anchor = loadAnchorOf(lp);
  const partId = lp.attachedPartId ?? (anchor.kind === "part" ? anchor.partId : undefined);
  const part = partId ? elements[partId] : undefined;
  const type = part?.kind === "part" ? elements[part.typeId] : undefined;
  const drains = systemKindsServedBy("grease_interceptor");
  const connectorValues: Array<readonly [string, number]> = [];
  if (part?.kind === "part" && type?.kind === "part_type") {
    for (const c of resolveConnectors(type.definition, part.values)) {
      if (!drains.includes(c.systemKind) || !c.values) continue;
      for (const [k, v] of Object.entries(c.values)) if (typeof v === "number" && Number.isFinite(v) && v > 0) connectorValues.push([keyWords(k), v]);
    }
  }
  return (name) => {
    const own = custom.find((c) => norm(c.name) === name);
    if (own) return own.value;
    const onConnector = connectorValues.find(([k]) => k === name);
    if (onConnector) return onConnector[1];
    if (part?.kind !== "part" || type?.kind !== "part_type") return undefined;
    const def = type.definition;
    const param = [...def.instanceParams, ...def.typeParams].find((p) => norm(p.name) === name || norm(p.label) === name);
    if (!param) return undefined;
    const v = paramValue(def, part.values, param.name);
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
    // Length parameters are stored in millimetres; the calc takes bowl sizes in inches.
    return param.kind === "length" ? v / MM_PER_IN : v;
  };
}

/**
 * The fixtures a grease interceptor sizes from, read from the model: every
 * load whose drain is piped to the interceptor's inlet, and every load that
 * names it with nothing drawn yet (kernel `greaseInterceptorLoads`). Bowl
 * sizes are "compartment length / width / depth" in inches and
 * "compartments", or "compartment volume" in gallons, on the load or on its
 * fixture.
 */
export function greaseFixturesPipedTo(model: ModelState, interceptorId: string): PipedGreaseFixtures | null {
  const elements = model.elements;
  const gi = elements[interceptorId];
  if (gi?.kind !== "part") return null;
  const fixtures: PipedGreaseFixture[] = [];
  const missing: string[] = [];
  const loads = greaseInterceptorLoads(elements, gi.id);
  for (const lp of loads) {
    const read = bowlReader(elements, lp);
    const label = lp.mark || lp.connectionType || lp.id;
    const volume = read("compartment volume");
    const [l, w, d] = [read("compartment length"), read("compartment width"), read("compartment depth")];
    const compartments = Math.max(1, Math.round(read("compartments") ?? 1));
    const quantity = lp.basis === "count" ? (lp.count ?? 1) : 1;
    if (volume !== undefined) fixtures.push({ label, quantity, volume_gal: volume, compartments });
    else if (l !== undefined && w !== undefined && d !== undefined) fixtures.push({ label, quantity, length_in: l, width_in: w, depth_in: d, compartments });
    else missing.push(label);
  }
  return { interceptorName: gi.mark || gi.id, fixtures, missing, loadIds: loads.map((lp) => lp.id) };
}
