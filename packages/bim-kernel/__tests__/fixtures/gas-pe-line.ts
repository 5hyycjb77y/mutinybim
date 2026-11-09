import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState, type PartTypeDefinition, type RunSize } from "../../src";

/**
 * A short gas line as model commands: a gas service at the origin and one
 * straight 40 ft run east. Below grade in polyethylene (`material: "pe"`),
 * like the DOAS line on the 7492 sheet ("½" SDR 9 PE to DOAS below
 * grade"), or in steel. The far end is either the DOAS (224.407 MBH) or an
 * open end carrying a load point (no equipment drawn yet).
 */

const FT = 304.8;
const IN = 25.4;
const Z = -2 * FT;

export const GAS_LINE_SYSTEM = "sys-gas-line";
export const GAS_LINE_LENGTH_FT = 40;

const builtin = { kind: "builtin", libraryVersion: "test" } as const;
const box = { geometry: [{ kind: "box" as const, center: [0, 0, 100] as [number, number, number], size: [200, 200, 200] as [number, number, number] }], symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [200, 200] as [number, number] }] };

function gasPart(familyName: string, typeName: string, direction: [number, number, number], mbh: number | null, flowDirection?: "out"): PartTypeDefinition {
  return {
    familyName,
    typeName,
    category: "mechanical_equipment",
    typeParams: mbh !== null ? [{ name: "input_mbh", label: "Input (MBH)", kind: "number", unit: "none", min: 0 }] : [],
    typeValues: mbh !== null ? { input_mbh: mbh } : {},
    instanceParams: [],
    connectors: [{ id: "g", label: "Gas", domain: "pipe", systemKind: "natural_gas", position: [0, 0, 0], direction, shape: "round", diameter: 0.5 * IN, ...(flowDirection ? { flowDirection } : {}) }],
    ...box,
    tagFields: ["mark"],
    source: builtin,
  };
}

export interface GasLineOptions {
  readonly fuel: "natural" | "propane";
  readonly material?: "pe" | "black_steel";
  /** The far end: the DOAS part, or an open end with a load point of this input (MBH). */
  readonly end: "doas" | { readonly loadPointMbh: number };
  readonly nominalIn?: number;
}

export function gasLineCommands(o: GasLineOptions): Command[] {
  const size: RunSize = { shape: "pipe", nominalMm: (o.nominalIn ?? 0.5) * IN, material: o.material ?? "pe", ...(o.material === "black_steel" ? {} : { spec: "sdr11" as const }) };
  const system = { id: GAS_LINE_SYSTEM, kind: "natural_gas" as const, name: "Gas line" };
  const inlet = o.fuel === "propane" ? 11 : 7;
  const cmds: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
    { type: "place_part", partId: "svc", typeId: "t:svc", partType: gasPart(o.fuel === "propane" ? "Propane tank regulator" : "Gas meter", "Outlet", [1, 0, 0], null, "out"), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: Z, mark: "GM-1" },
  ];
  if (o.end === "doas") {
    cmds.push({ type: "place_part", partId: "doas", typeId: "t:doas", partType: gasPart("Dedicated outdoor air unit", "DOAS-1", [-1, 0, 0], 224.407), levelId: "lvl-1", position: { x: GAS_LINE_LENGTH_FT * FT, y: 0 }, offsetMm: Z, mark: "DOAS-1" });
    cmds.push({ type: "route_run", idPrefix: "line", levelId: "lvl-1", domain: "pipe", size, elevationMm: Z, system, points: [], from: { kind: "part", partId: "svc", connectorId: "g" }, to: { kind: "part", partId: "doas", connectorId: "g" } });
  } else {
    cmds.push({ type: "route_run", idPrefix: "line", levelId: "lvl-1", domain: "pipe", size, elevationMm: Z, system, points: [{ x: GAS_LINE_LENGTH_FT * FT, y: 0 }], from: { kind: "part", partId: "svc", connectorId: "g" } });
    cmds.push({ type: "create_load_point", points: [{ hostId: "line-s1", port: "end", values: { mbh: o.end.loadPointMbh }, mark: "K10" }] });
  }
  cmds.push({ type: "set_system_design", systemId: GAS_LINE_SYSTEM, design: { pipe: { gasType: o.fuel, inletPressureInWc: inlet, allowableDropInWc: 0.5 } } });
  return cmds;
}

let n = 0;
export function buildGasLine(o: GasLineOptions): ModelState {
  let m: ModelState = { modelId: "gas-line", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of gasLineCommands(o)) {
    const d = planCommit(m, [], { idempotencyKey: `gas-line-${++n}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-24T00:00:00.000Z");
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    m = d.model;
  }
  return m;
}
