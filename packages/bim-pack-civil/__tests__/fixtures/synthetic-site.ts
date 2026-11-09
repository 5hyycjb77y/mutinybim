/**
 * A synthetic site (no client data), built through the kernel's own commands
 * with the civil pack bound to the model: two paved catchments and one lawn
 * (outlined zones), two inlets, a manhole and an outfall (parts of the pack's
 * structure types, given its classes), joined by three storm pipes routed
 * connector to connector in the pack's reinforced concrete pipe.
 *
 * Plan, feet (x east, y north), local model frame: the model's internal
 * origin sits on the outfall, and the project origin carries the large shared
 * coordinates (a state-plane-sized easting and northing), so geometry stays
 * in small numbers and only `modelToShared` sees the big ones.
 *
 *            C3 lawn (1.000 ac, x -100..200, y 180..325.2) ──served by I2──┐
 *                                                                        │
 *          C2 paved (12,000 ft², x 150..250, y 60..180)  ⊃  I2 (200,100) (served by I2)
 *                                                             │ P102 (100 ft, routed MH1 → I2)
 *   OF1 (0,0) ◄── P103 (200 ft) ── MH1 (200,0) ◄── P101 (150 ft) ── I1 (350,0)
 *                                                    C1 paved (30,000 ft², x 250..450, y -75..75) ⊃ I1
 *
 * Elevations (ft, model): I1 rim 100.00 / inv 96.00; I2 rim 100.50 / inv
 * 96.50; MH1 rim 99.80 / inv 95.00; OF1 inv 94.90 (the pack's parameters on
 * the parts). Storm system: 4 in/h, minimum slope 0.5 %. Inlet capacities
 * 2.50 and 3.00 cfs. Pipes are storm pipes by their system (no class set on
 * them).
 */
import { DEFAULT_SETTINGS, commandSchema, planCommit, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { PackSet, bindModelPacks, type Pack } from "@permitzip/bim-pack";
import { CIVIL_CLASS, CIVIL_PARAM, CIVIL_RCP, CIVIL_STORM_SERVICE } from "../../src/ids";
import { CIVIL_PACK } from "../../src/pack";
import { MANHOLE_TYPE, OUTFALL_TYPE, STORM_INLET_TYPE } from "../../src/structures";

export const FT = 304.8;
const ftMm = (ft: number): number => ft * FT;
const pt = (xFt: number, yFt: number) => ({ x: ftMm(xFt), y: ftMm(yFt) });
const rect = (x0: number, y0: number, x1: number, y1: number) => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];

export const SHARED_EASTING_FT = 3_500_000;
export const SHARED_NORTHING_FT = 1_200_000;

export const CIVIL_SET = PackSet.create([CIVIL_PACK]);

let seq = 0;

/** One commit through the command schema, the way a host applies a peer's edit. */
export function commit(head: ModelState, command: unknown): ModelState {
  seq += 1;
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) throw new Error(`${JSON.stringify(command).slice(0, 80)}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `c5v-${seq}`, baseRevision: head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command: parsed.data }, () => "2026-10-29T00:00:00.000Z"));
  if (!d.ok) throw new Error(`${parsed.data.type}: ${d.error.message}`);
  return d.model;
}

const size = (inches: number) => ({ shape: "pipe", nominalMm: inches * 25.4, material: "pe", materialId: CIVIL_RCP });
const system = { id: "sys-storm", kind: CIVIL_STORM_SERVICE, name: "Storm 1" };

/** The synthetic site as a model bound to `packs` (default: the civil pack only). */
export function syntheticSiteModel(modelId = "c5v-site", packs: readonly Pack[] = [CIVIL_PACK]): ModelState {
  bindModelPacks(modelId, packs.length === 1 && packs[0] === CIVIL_PACK ? CIVIL_SET : PackSet.create(packs));
  const steps: unknown[] = [
    { type: "create_level", levelId: "lvl-site", name: "Site", elevationMm: 0 },
    { type: "set_project_origin", mode: "relocate_project", shared: { eastWest: ftMm(SHARED_EASTING_FT), northSouth: ftMm(SHARED_NORTHING_FT), elevation: 0 } },
    { type: "place_part", partId: "OF1", typeId: "pt-outfall", partType: OUTFALL_TYPE, levelId: "lvl-site", position: pt(0, 0), mark: "OF1" },
    { type: "place_part", partId: "MH1", typeId: "pt-manhole", partType: MANHOLE_TYPE, levelId: "lvl-site", position: pt(200, 0), mark: "MH1" },
    { type: "place_part", partId: "I1", typeId: "pt-inlet", partType: STORM_INLET_TYPE, levelId: "lvl-site", position: pt(350, 0), mark: "I1" },
    // Turned a quarter left, so its outlet faces south to the manhole's north inlet.
    { type: "place_part", partId: "I2", typeId: "pt-inlet", levelId: "lvl-site", position: pt(200, 100), rotationDeg: 90, mark: "I2" },
    { type: "route_run", idPrefix: "P101", levelId: "lvl-site", domain: "pipe", size: size(15), system, points: [], slopeInPerFt: 0, from: { kind: "part", partId: "I1", connectorId: "out" }, to: { kind: "part", partId: "MH1", connectorId: "in_e" } },
    // Routed against the flow on purpose: direction comes from the network.
    { type: "route_run", idPrefix: "P102", levelId: "lvl-site", domain: "pipe", size: size(15), system, points: [], slopeInPerFt: 0, from: { kind: "part", partId: "MH1", connectorId: "in_n" }, to: { kind: "part", partId: "I2", connectorId: "out" } },
    { type: "route_run", idPrefix: "P103", levelId: "lvl-site", domain: "pipe", size: size(18), system, points: [], slopeInPerFt: 0, from: { kind: "part", partId: "MH1", connectorId: "out" }, to: { kind: "part", partId: "OF1", connectorId: "in" } },
    { type: "set_element_class", elementIds: ["I1", "I2"], classId: CIVIL_CLASS.stormInlet },
    { type: "set_element_class", elementIds: ["MH1"], classId: CIVIL_CLASS.manhole },
    { type: "set_element_class", elementIds: ["OF1"], classId: CIVIL_CLASS.outfall },
    { type: "set_element_values", elementIds: ["OF1"], values: { [CIVIL_PARAM.invertElevation]: ftMm(94.9) } },
    { type: "set_element_values", elementIds: ["MH1"], values: { [CIVIL_PARAM.rimElevation]: ftMm(99.8), [CIVIL_PARAM.invertElevation]: ftMm(95) } },
    { type: "set_element_values", elementIds: ["I1"], values: { [CIVIL_PARAM.rimElevation]: ftMm(100), [CIVIL_PARAM.invertElevation]: ftMm(96), [CIVIL_PARAM.inletCapacity]: 2.5 } },
    { type: "set_element_values", elementIds: ["I2"], values: { [CIVIL_PARAM.rimElevation]: ftMm(100.5), [CIVIL_PARAM.invertElevation]: ftMm(96.5), [CIVIL_PARAM.inletCapacity]: 3 } },
    { type: "set_element_class", elementIds: ["sys-storm"], classId: CIVIL_CLASS.stormSystem },
    { type: "set_element_values", elementIds: ["sys-storm"], values: { [CIVIL_PARAM.designIntensity]: 4, [CIVIL_PARAM.minSlope]: 0.5 } },
    { type: "create_zone", zoneId: "C1", name: "C1 parking", purpose: "drainage_catchment", outline: { levelId: "lvl-site", outline: rect(250, -75, 450, 75) } },
    { type: "create_zone", zoneId: "C2", name: "C2 drive", purpose: "drainage_catchment", outline: { levelId: "lvl-site", outline: rect(150, 60, 250, 180) }, servedBy: "I2" },
    { type: "create_zone", zoneId: "C3", name: "C3 lawn", purpose: "drainage_catchment", outline: { levelId: "lvl-site", outline: rect(-100, 180, 200, 325.2) }, servedBy: "I2" },
    { type: "set_element_class", elementIds: ["C1", "C2", "C3"], classId: CIVIL_CLASS.catchment },
    { type: "set_element_values", elementIds: ["C1", "C2"], values: { [CIVIL_PARAM.surface]: "paved" } },
    { type: "set_element_values", elementIds: ["C3"], values: { [CIVIL_PARAM.surface]: "lawn_heavy_average" } },
  ];
  let m: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const step of steps) m = commit(m, step);
  return m;
}

/** The pipe routed from `prefix` (route_run names segments `<prefix>-s1`, …). */
export function segmentOf(m: ModelState, prefix: string): string {
  const id = Object.keys(m.elements).find((k) => k.startsWith(`${prefix}-s`));
  if (!id) throw new Error(`no segment routed as ${prefix}`);
  return id;
}
