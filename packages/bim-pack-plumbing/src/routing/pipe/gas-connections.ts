import type { ElementId, ModelState, PipeMaterial, PipeDesign } from "@permitzip/bim-kernel";
import { elementValues, inchSizeText } from "@permitzip/bim-kernel";
import { GAS_FUEL_LABEL, type GasFuel } from "./gas-fuel";
import { gasNetwork, pressureLabel, type GasNetwork } from "./gas-zones";

/**
 * One row per gas outlet (an appliance part or a load point on a pipe end):
 * its input, the pressure zone and regulator it is on, the size of the pipe
 * that feeds it, the developed length from the source to it along the routed
 * pipe, and the length its pipe is sized on. Read from the gas zones walk
 * (`gasNetwork`), so it is the same topology, the same input and the same
 * lengths the sizing calc reads.
 *
 * This is the data source for the gas connection schedule and for the
 * sizing calc's connection rows; any later schedule or report reads it here
 * instead of walking the pipe again.
 */

export interface GasSizingBasis {
  readonly method: GasNetwork["method"];
  /** The length the pipe to this outlet is sized on: the zone's longest run (402.4.1), or the length to this outlet (402.4.2) (ft). */
  readonly lengthFt: number;
  readonly inletInWc: number;
  readonly allowableDropInWc: number;
}

export interface GasConnectionRow {
  readonly systemId: ElementId;
  readonly systemName: string;
  readonly fuel: GasFuel;
  readonly elementId: ElementId;
  readonly mark: string;
  readonly description: string;
  readonly source: "part" | "load_point";
  readonly inputMbh: number;
  /** Input as gas flow at the system's heating value (cfh). */
  readonly inputCfh: number;
  readonly zoneId: string;
  readonly zoneLabel: string;
  readonly zoneInletInWc: number;
  readonly regulatorId: ElementId | null;
  readonly regulatorLabel: string | null;
  readonly minInletInWc: number | null;
  /** The drawn pipe that feeds the outlet, and its size; null when the outlet hangs right at a regulator or the source. */
  readonly feedElementId: ElementId | null;
  readonly pipeNominalIn: number | null;
  readonly pipeMaterial: PipeMaterial | null;
  /** From the system's source to the outlet, through every regulator (ft). */
  readonly developedLengthFt: number;
  /** From the start of the outlet's own pressure zone (its regulator, or the source) (ft). */
  readonly zoneLengthFt: number;
  readonly basis: GasSizingBasis;
}

const r = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** The connection rows of one gas network, in the order the walk meets them. */
export function gasConnectionRowsOf(network: GasNetwork): GasConnectionRow[] {
  const zones = new Map(network.zones.map((z) => [z.id, z]));
  const regs = new Map(network.regulators.map((g) => [g.elementId, g]));
  return network.appliances.map((a) => {
    const zone = zones.get(a.zoneId);
    const reg = a.regulatorId ? regs.get(a.regulatorId) : undefined;
    const inletInWc = zone?.inletInWc ?? 0;
    return {
      systemId: network.systemId as ElementId,
      systemName: network.systemName,
      fuel: network.gas,
      elementId: a.elementId,
      mark: a.mark ?? a.label,
      description: a.description,
      source: a.source,
      inputMbh: a.mbh,
      inputCfh: r((a.mbh * 1000) / network.heatingValueBtuPerCf, 1),
      zoneId: a.zoneId,
      zoneLabel: zone?.label ?? "",
      zoneInletInWc: inletInWc,
      regulatorId: a.regulatorId,
      regulatorLabel: reg?.label ?? null,
      minInletInWc: a.minInletInWc,
      feedElementId: a.feedElementId,
      pipeNominalIn: a.feedNominalIn,
      pipeMaterial: a.feedMaterial,
      developedLengthFt: a.fromSourceFt,
      zoneLengthFt: a.pathFt,
      basis: {
        method: network.method,
        lengthFt: network.method === "branch_length" ? a.pathFt : (zone?.longestFt ?? a.pathFt),
        inletInWc,
        allowableDropInWc: zone?.allowableDropInWc ?? 0,
      },
    };
  });
}

/** Every gas outlet on every gas system (or one system), from the routed pipe. */
export function gasConnectionRows(model: Pick<ModelState, "elements">, options: { readonly systemId?: string; readonly firm?: PipeDesign } = {}): GasConnectionRow[] {
  const out: GasConnectionRow[] = [];
  for (const el of elementValues(model.elements)) {
    if (el.kind !== "mep_system" || el.systemKind !== "natural_gas") continue;
    if (options.systemId && el.id !== options.systemId) continue;
    const net = gasNetwork(model, el.id, options.firm ? { firm: options.firm } : {});
    if (net) out.push(...gasConnectionRowsOf(net));
  }
  return out;
}

/** "Longest length, 97 ft, 11 in. w.c. inlet, 0.5 in. w.c. drop": the basis as the schedule prints it (the code table is the calc's to name). */
export function gasBasisText(b: GasSizingBasis): string {
  const method = b.method === "branch_length" ? "Branch length" : "Longest length";
  return `${method}, ${Math.ceil(b.lengthFt - 1e-9)} ft, ${pressureLabel(b.inletInWc)} inlet, ${pressureLabel(b.allowableDropInWc)} drop`;
}

/** `¾"` for a feed pipe, or "" when none is drawn. */
export function gasPipeSizeText(row: Pick<GasConnectionRow, "pipeNominalIn">): string {
  return row.pipeNominalIn === null ? "" : inchSizeText(row.pipeNominalIn * 25.4);
}

export function gasFuelText(fuel: GasFuel): string {
  return GAS_FUEL_LABEL[fuel];
}
