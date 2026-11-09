/**
 * @jest-environment node
 *
 * c6x-network-coupling-bare (@mutinybim-bare-kernel): the water heater's
 * coupling is the Plumbing and gas add-on's `kernel.network_coupling` row.
 * With no add-on in force the kernel's walks carry nothing across the heater
 * and root no hot system at it; with the add-on alone they carry the hot
 * side's 15.75 WSFU on its cold inlet. Before round 6 lane X the kernel did
 * this itself, whatever was loaded.
 */
import { DEFAULT_SETTINGS, executeCommand, isCouplerPart, isCouplingOutlet, loadPointLoads, NETWORK_COUPLING_POINT, runNeighbours, type Command, type ElementId, type MepSystem, type ModelState } from "@permitzip/bim-kernel";
import { activePackSet, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { SAMPLE_MARKET_CW, SAMPLE_MARKET_TOTALS, sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { pipeLoadWalk, PLUMBING_GAS_PACK } from "../src";

const PLUMBING = PackSet.create([PLUMBING_GAS_PACK]);

function sampleMarketModel(): ModelState {
  let head: ModelState = { modelId: "c6x-bare", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  const commands: readonly Command[] = [...build.setup, sampleMarketLoadPointCommand(build.points)];
  for (const command of commands) {
    const run = executeCommand(head, command, { history: [], actorId: "avery" });
    if (!run.ok) throw new Error(`${command.type}: ${run.error.message}`);
    head = run.model;
  }
  return head;
}

describe("c6x-network-coupling-bare", () => {
  const m = withPackSet(PLUMBING, sampleMarketModel);
  const sys = m.elements[SAMPLE_MARKET_CW.id] as MepSystem;
  const walk = withPackSet(PLUMBING, () => pipeLoadWalk(m.elements, sys, "cw-s1" as ElementId, {}, []));
  const inlet = walk.walk.order.find((n) => n.startsWith("gwh#")) as string;
  const neighbours = (n: string) => runNeighbours(m.elements, n);
  const heater = m.elements.gwh;

  it("with no add-on, the heater is no coupler and its inlet carries nothing", () => {
    expect(activePackSet().items(NETWORK_COUPLING_POINT)).toEqual([]);
    expect(heater?.kind === "part" && isCouplerPart(m.elements, heater)).toBe(false);
    const bare = loadPointLoads(m.elements, walk.walk, sys.systemKind, neighbours);
    expect(inlet).toBeDefined();
    expect(bare.own.get(inlet)).toBeUndefined();
    expect(bare.alsoRead).toEqual([]);
  });

  it("with the add-on alone, its row carries the hot side on the cold inlet", () => {
    withPackSet(PLUMBING, () => {
      expect(heater?.kind === "part" && isCouplerPart(m.elements, heater)).toBe(true);
      expect(heater?.kind === "part" && Object.keys(heater.links ?? {}).some((c) => isCouplingOutlet(m.elements, heater, c))).toBe(true);
      expect(loadPointLoads(m.elements, walk.walk, sys.systemKind, neighbours).own.get(inlet)).toBe(SAMPLE_MARKET_TOTALS.hot);
    });
  });
});
