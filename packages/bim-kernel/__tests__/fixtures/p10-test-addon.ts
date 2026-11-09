import { CONNECTOR_END_TYPE_POINT, PIPE_PRODUCT_POINT, type PipeProduct } from "../../src";
import { PackSet, contribute, definePack } from "../../src/packs";
import { PIPE_MATERIAL_POINT } from "../../src/routing/pipe/materials";

/**
 * Round 10 lane P10: another firm's piping add-on, written against the
 * public contract only (no kernel edit): its own pipe material, its own end
 * type (a grooved coupling, joined to the Plumbing add-on's threaded end
 * through an adapter) and its own pipe product made with it.
 */
export const IN = 25.4;
export const FP_MATERIAL = "testfp.cpvc_fire";
export const FP_GROOVED = "testfp.grooved";

export const FP_PRODUCT: PipeProduct = {
  id: "testfp.cpvc_fire_sdr13_5",
  name: "CPVC fire pipe, SDR 13.5",
  materialId: FP_MATERIAL,
  spec: "sdr13_5",
  specLabel: "SDR 13.5",
  defaultForMaterial: true,
  standard: "Test standard",
  services: ["water"],
  sizes: [
    { nominalIn: 1, odMm: 33.4, idMm: 28.45, wallMm: 2.475 },
    { nominalIn: 2, odMm: 60.3, idMm: 51.36, wallMm: 4.47 },
    { nominalIn: 3, odMm: 88.9, idMm: 75.73, wallMm: 6.585 },
  ],
  roughnessMm: 0.0015,
  hazenWilliamsC: 150,
  manningN: 0.009,
  pressureClass: "175 psi",
  endTypes: [FP_GROOVED],
  defaultEndType: FP_GROOVED,
  hubs: { [FP_GROOVED]: { odOverPipe: 1.5, lengthOverOd: 0.4 } },
};

export const FP_PACK = definePack({ id: "testfp", name: "Test fire piping", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(PIPE_MATERIAL_POINT, [{ id: FP_MATERIAL, label: "CPVC fire pipe", fallback: "cpvc" }]),
  contribute(CONNECTOR_END_TYPE_POINT, [{ id: FP_GROOVED, label: "Grooved coupling", domains: ["pipe"], joinsVia: [{ endType: "plumbing_gas.threaded", fitting: "grooved-to-thread adapter" }] }]),
  contribute(PIPE_PRODUCT_POINT, [FP_PRODUCT]),
]);

export const FP_SET = PackSet.create([FP_PACK]);

export const fpSize = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "cpvc" as const, materialId: FP_MATERIAL });
