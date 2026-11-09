import {
  asConnectionId,
  asElementId,
  roundVec,
  storedRecord,
  type BimElement,
  type Connection,
  type ConnectorEnd,
  type ElementId,
  type NetworkService,
  type Partition,
  type Profile,
  type Vec2,
} from "@permitzip/bim-kernel";
import {
  tapPosition,
} from "../types";

/**
 * The connected-element tree the all-discipline load-test building seeds for
 * each system (moved out of the kernel's `fullbim.ts` in round 12, byte for
 * byte): per trunk a source feeding 10 ft segments, two branches per
 * segment. The records are this add-on's kinds whatever the service, as
 * they have been since round 4, so the frozen tiers read the same.
 */

const FT = 304.8;

/** Where a seeder writes: the building's elements and connections, in order. */
export interface SeedBuilder {
  readonly elements: BimElement[];
  readonly connections: Connection[];
}

const base = { version: 1, authoredRev: {} };

function conn(id: string, a: [string, ConnectorEnd], b: [string, ConnectorEnd]): Connection {
  return {
    id: asConnectionId(id),
    a: { elementId: asElementId(a[0]), end: a[1] },
    b: { elementId: asElementId(b[0]), end: b[1] },
  };
}

export interface NetworkSize {
  /** Trunks in one zone, each fed by its own unit / riser valve / panel. */
  readonly trunks: number;
  /** 10 ft trunk segments per trunk; each carries two branches. */
  readonly segments: number;
}

export interface TreeNetworkSeed {
  readonly prefix: string;
  readonly partition: Partition;
  readonly service: NetworkService;
  readonly origin: Vec2;
  readonly size: NetworkSize;
  readonly trunkProfile: Profile;
  readonly branchProfile: Profile;
  readonly sourceName: string;
  readonly sourceMark: string;
  readonly endName: string;
  readonly endMark: string;
  /** Load per end device (CFM, GPM, heads or VA; summed up the tree the same way). */
  readonly load: (i: number) => number;
}

/**
 * One zone's system: per trunk a source (unit, riser valve, panel) feeding
 * 10 ft segments, two branches per segment (tap, riser, elbow, run, end
 * device). Same shape as the duct heavy model, so the same rules apply.
 */
export function seedTreeNetwork(b: SeedBuilder, spec: TreeNetworkSeed): { sources: ElementId[]; ends: ElementId[] } {
  const segLen = 10 * FT;
  const sources: ElementId[] = [];
  const ends: ElementId[] = [];
  const common = { ...base, systemClass: "supply" as const, service: spec.service, partition: spec.partition };
  for (let t = 0; t < spec.size.trunks; t++) {
    const y0 = spec.origin.y + t * 10 * FT;
    const x0 = spec.origin.x;
    const sourceId = `${spec.prefix}-t${t + 1}-src`;
    sources.push(asElementId(sourceId));
    b.elements.push(storedRecord({
      ...common,
      id: asElementId(sourceId),
      kind: "equipment",
      mark: `${spec.sourceMark}-${t + 1}`,
      typeName: spec.sourceName,
      position: { x: x0 - 2 * FT, y: y0 },
      size: { x: 4 * FT, y: 3 * FT },
      portOffset: { x: 2 * FT, y: 0 },
      totalCfm: 0,
    }));
    let upstream: [string, ConnectorEnd] = [sourceId, "out"];
    for (let k = 0; k < spec.size.segments; k++) {
      const segId = `${spec.prefix}-t${t + 1}-s${k + 1}`;
      const trunk = storedRecord({
        ...common,
        id: asElementId(segId),
        kind: "duct_segment",
        start: { x: x0 + k * segLen, y: y0 },
        end: { x: x0 + (k + 1) * segLen, y: y0 },
        profile: spec.trunkProfile,
        flowCfm: 0,
      });
      b.elements.push(trunk);
      b.connections.push(conn(`c-${segId}-in`, upstream, [segId, "start"]));
      upstream = [segId, "end"];
      [3 * FT, 7 * FT].forEach((s, j) => {
        const n = `${segId}-b${j + 1}`;
        const tapPos = roundVec(tapPosition(trunk, { s, side: 1 }));
        const elbowPos = { x: tapPos.x, y: y0 + 4 * FT };
        const endPos = { x: tapPos.x + 2 * FT, y: elbowPos.y };
        const endId = `${n}-dev`;
        ends.push(asElementId(endId));
        b.elements.push(
          { ...common, id: asElementId(`${n}-tap`), kind: "tap", hostId: trunk.id, s, side: 1, profile: spec.branchProfile, position: tapPos },
          storedRecord({ ...common, id: asElementId(`${n}-riser`), kind: "duct_segment", start: tapPos, end: elbowPos, profile: spec.branchProfile, flowCfm: 0 }),
          { ...common, id: asElementId(`${n}-elbow`), kind: "elbow", position: elbowPos, profile: spec.branchProfile },
          storedRecord({ ...common, id: asElementId(`${n}-run`), kind: "duct_segment", start: elbowPos, end: endPos, profile: spec.branchProfile, flowCfm: 0 }),
          storedRecord({
            ...common,
            id: asElementId(endId),
            kind: "terminal",
            mark: `${spec.endMark}-${t + 1}.${k + 1}.${j + 1}`,
            typeName: spec.endName,
            position: endPos,
            cfm: spec.load(t * 31 + k * 7 + j),
            anchored: true,
          }),
        );
        b.connections.push(
          conn(`c-${n}-riser`, [`${n}-tap`, "branch"], [`${n}-riser`, "start"]),
          conn(`c-${n}-elbow`, [`${n}-riser`, "end"], [`${n}-elbow`, "in"]),
          conn(`c-${n}-run`, [`${n}-elbow`, "out"], [`${n}-run`, "start"]),
          conn(`c-${n}-end`, [`${n}-run`, "end"], [endId, "in"]),
        );
      });
    }
  }
  return { sources, ends };
}
