/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 10 lane P10: the kernel without the Plumbing and gas add-on has no
 * pipe products at all. A stored copper pipe still reads (nominal size for
 * both diameters, the stored joint kept, no joint judged) and its size check
 * names the add-on that supplies it, in the same words a missing add-on's
 * command is refused with.
 *
 * Fails on round 9's code: the kernel carried the whole catalogue itself, so
 * a bare kernel sized copper as type L and never named an add-on.
 *
 * Round 12 (P11) moved the pipe fitting families into the add-on too: a stored
 * copper water elbow is kept, its joint is not judged, and the check names the
 * add-on instead of calling the elbow a type the library doesn't have (round
 * 12's first cut said "isn't in the fitting library").
 */
import { DEFAULT_SETTINGS, commandSchema, fittingFamily, pipeDims, pipeProducts, pipeSizeIssue, planCommit, specOfSize, validateModel, withUpgradePolicy, type ElementId, type MepSystem, type ModelState, type RunFitting, type RunSize } from "@permitzip/bim-kernel";
import { installedFirstPartyPacks } from "@permitzip/bim-kernel/packs";

const copper: Extract<RunSize, { shape: "pipe" }> = { shape: "pipe", nominalMm: 25.4, material: "copper" };

describe("p10-unknown-product-bare", () => {
  it("is a bare kernel", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("plumbing_gas");
    expect(pipeProducts()).toEqual([]);
  });

  it("reads a stored copper pipe without its products, and names the add-on that supplies them", () => {
    expect(specOfSize(copper)).toBeNull();
    expect(pipeDims(copper)).toEqual({ odMm: 25.4, idMm: 25.4, listed: false });
    expect(pipeSizeIssue(copper)).toBe("This model uses Plumbing and gas, which isn't loaded here, so this copper pipe's size isn't checked. Turn on that add-on");
    expect(fittingFamily("pipe.water.elbow_90")).toBeNull();
  });

  it("keeps a stored copper water elbow, judges no joint, and names the add-on its family comes from", () => {
    let seq = 0;
    const commit = (head: ModelState, command: unknown): ModelState => {
      seq += 1;
      const parsed = commandSchema.parse(command);
      const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `p10-bare-${seq}-xxxxxxxx`, baseRevision: head.revision, actor: { id: "u-p10", name: "P10", kind: "human" }, command: parsed }, () => "2026-11-04T12:00:00.000Z"));
      if (!d.ok) throw new Error(`${parsed.type}: ${d.error.message}`);
      return d.model;
    };
    let m: ModelState = { modelId: "p10-bare" as ModelState["modelId"], revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    expect(() => commit(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper, elevationMm: 3000, system: { id: "sys-cw", kind: "domestic_cold_water", name: "Cold water" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 6000 }] })).toThrow(/This model uses Plumbing and gas, which isn't loaded here, so Cold water can't place its pipe\.\S+ fittings\. Turn on that add-on/);
    const system: MepSystem = { id: "sys-cw" as ElementId, kind: "mep_system", version: 1, authoredRev: {}, name: "Cold water", systemKind: "domestic_cold_water", domain: "pipe" };
    const stored: RunFitting = {
      id: "cw-elbow" as ElementId, kind: "run_fitting", version: 1, authoredRev: {}, fittingType: "elbow", label: "90° elbow", domain: "pipe", systemId: system.id, levelId: "lvl-1" as ElementId, position: { x: 6000, y: 0, z: 3000 }, angleDeg: 90,
      ports: [{ id: "a", position: { x: 6000, y: 0, z: 3000 }, direction: { x: -1, y: 0, z: 0 }, size: copper }, { id: "b", position: { x: 6000, y: 0, z: 3000 }, direction: { x: 0, y: 1, z: 0 }, size: copper }],
      family: "pipe.water.elbow_90", params: { joint: "sweat" },
    };
    m = { ...m, elements: { ...m.elements, [system.id]: system, [stored.id]: stored } };
    const mine = validateModel(m).filter((i) => i.elementIds.includes(stored.id));
    expect(mine.map((i) => i.message)).toContain(`This model uses Plumbing and gas, which isn't loaded here, so ${stored.label} (pipe.water.elbow_90) is kept as stored and isn't checked. Turn on that add-on`);
    expect(mine.filter((i) => /joint|fitting library/.test(i.message))).toEqual([]);
    expect(m.elements[stored.id]).toMatchObject({ family: "pipe.water.elbow_90", params: { joint: "sweat" } });
  });
});
