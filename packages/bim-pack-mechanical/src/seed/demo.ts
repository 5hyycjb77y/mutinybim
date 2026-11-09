import {
  DEFAULT_SETTINGS,
  asConnectionId,
  asElementId,
  asRevision,
  elementEntries,
  recomputeDerived,
  roundVec,
  storedRecord,
  type BimElement,
  type Connection,
  type ConnectorEnd,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  tapPosition,
  type TapFitting,
} from "../types";

/**
 * The Mechanical add-on's seed models (moved out of the kernel's `seed.ts`
 * in round 12, byte for byte): the round-1 demo supply network, the same
 * network placed at an origin, and the deterministic heavy supply network
 * the benchmarks size. Stored ids, kinds and connections are unchanged, so
 * every frozen fixture built from them reads the same.
 */

const FT = 304.8;

function conn(id: string, a: [string, ConnectorEnd], b: [string, ConnectorEnd]): Connection {
  return {
    id: asConnectionId(id),
    a: { elementId: asElementId(a[0]), end: a[1] },
    b: { elementId: asElementId(b[0]), end: b[1] },
  };
}

/**
 * The F-a demo model: one rooftop unit, one rectangular supply trunk, two
 * branch taps, each branch an L (riser off the trunk, elbow, run to a fixed
 * diffuser). Terminals are anchored so sliding a tap stretches the branch run.
 */
export function createDemoModel(modelId = "demo"): ModelState {
  const base = { version: 1, authoredRev: {}, systemClass: "supply" as const };
  const trunkProfile = { shape: "rect" as const, width: 24 * 25.4, height: 12 * 25.4 };
  const branchProfile = { shape: "rect" as const, width: 10 * 25.4, height: 8 * 25.4 };

  const trunk = storedRecord({
    ...base,
    id: asElementId("seg-trunk"),
    kind: "duct_segment",
    start: { x: 0, y: 0 },
    end: { x: 40 * FT, y: 0 },
    profile: trunkProfile,
    flowCfm: 0,
  });

  const branchY = 10 * FT;
  const tapDefs: Array<{ n: number; s: number; terminalX: number; cfm: number }> = [
    { n: 1, s: 12 * FT, terminalX: 18 * FT, cfm: 350 },
    { n: 2, s: 26 * FT, terminalX: 33 * FT, cfm: 300 },
  ];

  const elements: BimElement[] = [
    storedRecord({
      ...base,
      id: asElementId("ahu-1"),
      kind: "equipment",
      mark: "RTU-1",
      typeName: "Rooftop unit, 5 ton",
      position: { x: -3.5 * FT, y: 0 },
      size: { x: 7 * FT, y: 4 * FT },
      portOffset: { x: 3.5 * FT, y: 0 },
      totalCfm: 0,
    }),
    trunk,
  ];
  const connections: Connection[] = [conn("c-ahu-trunk", ["ahu-1", "out"], ["seg-trunk", "start"])];

  for (const def of tapDefs) {
    const tapDraft: Pick<TapFitting, "s" | "side"> = { s: def.s, side: 1 };
    const tapPos = roundVec(tapPosition(trunk, tapDraft));
    const elbowPos = { x: tapPos.x, y: branchY };
    const tap: TapFitting = {
      ...base,
      id: asElementId(`tap-${def.n}`),
      kind: "tap",
      hostId: trunk.id,
      s: def.s,
      side: 1,
      profile: branchProfile,
      position: tapPos,
    };
    elements.push(
      tap,
      storedRecord({
        ...base,
        id: asElementId(`seg-riser-${def.n}`),
        kind: "duct_segment",
        start: tapPos,
        end: elbowPos,
        profile: branchProfile,
        flowCfm: 0,
      }),
      { ...base, id: asElementId(`elbow-${def.n}`), kind: "elbow", position: elbowPos, profile: branchProfile },
      storedRecord({
        ...base,
        id: asElementId(`seg-run-${def.n}`),
        kind: "duct_segment",
        start: elbowPos,
        end: { x: def.terminalX, y: branchY },
        profile: branchProfile,
        flowCfm: 0,
      }),
      storedRecord({
        ...base,
        id: asElementId(`sd-${def.n}`),
        kind: "terminal",
        mark: `SD-${def.n}`,
        typeName: "Supply diffuser 24x24",
        position: { x: def.terminalX, y: branchY },
        cfm: def.cfm,
        anchored: true,
      }),
    );
    connections.push(
      conn(`c-tap-${def.n}-riser`, [`tap-${def.n}`, "branch"], [`seg-riser-${def.n}`, "start"]),
      conn(`c-riser-${def.n}-elbow`, [`seg-riser-${def.n}`, "end"], [`elbow-${def.n}`, "in"]),
      conn(`c-elbow-${def.n}-run`, [`elbow-${def.n}`, "out"], [`seg-run-${def.n}`, "start"]),
      conn(`c-run-${def.n}-sd`, [`seg-run-${def.n}`, "end"], [`sd-${def.n}`, "in"]),
    );
  }

  const model: ModelState = {
    modelId,
    revision: asRevision(0),
    elements: Object.fromEntries(elements.map((el) => [el.id, el])),
    connections,
    settings: DEFAULT_SETTINGS,
  };
  return recomputeDerived(model).model;
}

/**
 * The demo network translated to `origin` (model millimetres), e.g. to sit
 * inside a linked architectural reference. Taps keep their distance along the
 * trunk; derived positions are recomputed.
 */
export function createPlacedDemoModel(modelId: string, origin: { x: number; y: number }): ModelState {
  const demo = createDemoModel(modelId);
  const move = (p: { x: number; y: number }) => ({ x: p.x + origin.x, y: p.y + origin.y });
  const elements: Record<string, BimElement> = {};
  for (const [id, el] of elementEntries(demo.elements)) {
    switch (el.kind) {
      case "duct_segment":
        elements[id] = { ...el, start: move(el.start), end: move(el.end) };
        break;
      case "equipment":
      case "elbow":
      case "terminal":
      case "tap":
        elements[id] = { ...el, position: move(el.position) };
        break;
      default:
        elements[id] = el;
    }
  }
  return recomputeDerived({ ...demo, elements }).model;
}

export interface HeavyModelOptions {
  /** Air handlers, each with its own trunk (one per floor zone). */
  readonly units: number;
  /** 30 ft trunk segments per unit; each carries two branches. */
  readonly segmentsPerTrunk: number;
  readonly modelId?: string;
}

/** Scale tiers used by the benchmarks and the heavy-model runs. */
export const HEAVY_TIERS = {
  S: { units: 12, segmentsPerTrunk: 15 },
  M: { units: 30, segmentsPerTrunk: 30 },
  L: { units: 60, segmentsPerTrunk: 45 },
} as const satisfies Record<string, HeavyModelOptions>;

/**
 * A deterministic, valid large supply network: per unit one AHU feeding a
 * straight trunk of `segmentsPerTrunk` 30 ft segments, each segment hosting two
 * branches (tap, riser, elbow, run, anchored diffuser). Element count is
 * `units * (1 + 11 * segmentsPerTrunk)`.
 */
export function createHeavyModel({ units, segmentsPerTrunk, modelId = "heavy" }: HeavyModelOptions): ModelState {
  const base = { version: 1, authoredRev: {}, systemClass: "supply" as const };
  const trunkProfile = { shape: "rect" as const, width: 24 * 25.4, height: 12 * 25.4 };
  const branchProfile = { shape: "rect" as const, width: 10 * 25.4, height: 8 * 25.4 };
  const segmentLength = 30 * FT;
  const elements: BimElement[] = [];
  const connections: Connection[] = [];

  for (let u = 0; u < units; u++) {
    const y0 = u * 60 * FT;
    const unitId = `ahu-${u + 1}`;
    elements.push(storedRecord({
      ...base,
      id: asElementId(unitId),
      kind: "equipment",
      mark: `AHU-${u + 1}`,
      typeName: "Air handling unit",
      position: { x: -3.5 * FT, y: y0 },
      size: { x: 7 * FT, y: 4 * FT },
      portOffset: { x: 3.5 * FT, y: 0 },
      totalCfm: 0,
    }));
    let upstream: [string, ConnectorEnd] = [unitId, "out"];
    for (let k = 0; k < segmentsPerTrunk; k++) {
      const segId = `u${u + 1}-trunk-${k + 1}`;
      const trunk = storedRecord({
        ...base,
        id: asElementId(segId),
        kind: "duct_segment",
        start: { x: k * segmentLength, y: y0 },
        end: { x: (k + 1) * segmentLength, y: y0 },
        profile: trunkProfile,
        flowCfm: 0,
      });
      elements.push(trunk);
      connections.push(conn(`c-${segId}-in`, upstream, [segId, "start"]));
      upstream = [segId, "end"];

      [8 * FT, 20 * FT].forEach((s, j) => {
        const n = `u${u + 1}-s${k + 1}-b${j + 1}`;
        const tapPos = roundVec(tapPosition(trunk, { s, side: 1 }));
        const elbowPos = { x: tapPos.x, y: y0 + 10 * FT };
        const terminalPos = { x: tapPos.x + 5 * FT, y: elbowPos.y };
        elements.push(
          { ...base, id: asElementId(`tap-${n}`), kind: "tap", hostId: trunk.id, s, side: 1, profile: branchProfile, position: tapPos },
          storedRecord({ ...base, id: asElementId(`riser-${n}`), kind: "duct_segment", start: tapPos, end: elbowPos, profile: branchProfile, flowCfm: 0 }),
          { ...base, id: asElementId(`elbow-${n}`), kind: "elbow", position: elbowPos, profile: branchProfile },
          storedRecord({ ...base, id: asElementId(`run-${n}`), kind: "duct_segment", start: elbowPos, end: terminalPos, profile: branchProfile, flowCfm: 0 }),
          storedRecord({
            ...base,
            id: asElementId(`sd-${n}`),
            kind: "terminal",
            mark: `SD-${n}`,
            typeName: "Supply diffuser 24x24",
            position: terminalPos,
            cfm: 150 + ((u * 7 + k * 3 + j) % 8) * 50,
            anchored: true,
          }),
        );
        connections.push(
          conn(`c-${n}-riser`, [`tap-${n}`, "branch"], [`riser-${n}`, "start"]),
          conn(`c-${n}-elbow`, [`riser-${n}`, "end"], [`elbow-${n}`, "in"]),
          conn(`c-${n}-run`, [`elbow-${n}`, "out"], [`run-${n}`, "start"]),
          conn(`c-${n}-sd`, [`run-${n}`, "end"], [`sd-${n}`, "in"]),
        );
      });
    }
  }

  const model: ModelState = {
    modelId,
    revision: asRevision(0),
    elements: Object.fromEntries(elements.map((el) => [el.id, el])),
    connections,
    settings: DEFAULT_SETTINGS,
  };
  return recomputeDerived(model).model;
}
