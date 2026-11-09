import type { TagStylePreset, MepSystem, PipeMaterial, RunSize, BimElement, ElementId, FieldPathInfo, FieldScalar } from "@permitzip/bim-kernel";
import { gasFuelOf, GAS_FUEL_LABEL } from "../routing/pipe/gas-fuel";
import { gasNetwork, pressureLabel, type GasNetwork } from "../routing/pipe/gas-zones";
import { segmentLength3, pipeRow, pipeSpecLabel, inchSizeText, pipeSegmentOf } from "@permitzip/bim-kernel";

/**
 * Field paths on a gas pipe: the content of a gas segment tag (size and
 * developed length, as the issued gas plans tag every piece: `1" 3 LF`,
 * `½" SDR 9 PE 12 LF`), the developed length from the source, the pressure
 * zone and the fuel. Tags, tag styles, schedules and risers read them here,
 * so a tag never disagrees with the sizing walk (`gasNetwork`).
 *
 * A tag style line `{gas.size} {gas.length}` is the built-in gas segment tag
 * (tag template `gas_pipe`); firms can lay the same fields out their own way.
 */

type Elements = Readonly<Record<string, BimElement>>;

const FT = 304.8;
const IN = 25.4;

export const GAS_FIELD_PATHS: readonly FieldPathInfo[] = [
  { path: "gas.tag", label: "Gas segment tag (size and length)", on: "pipe", example: '1" 3 LF' },
  { path: "gas.size", label: "Gas pipe size, with the material when not steel", on: "pipe", example: '½" SDR 9 PE' },
  { path: "gas.length", label: "Gas pipe developed length of this piece", on: "pipe", example: "3 LF" },
  { path: "gas.from_source", label: "Developed length from the gas source to the end of this pipe", on: "pipe", example: "93 LF" },
  { path: "gas.zone", label: "Gas pressure zone", on: "pipe", example: "11 in. w.c." },
  { path: "gas.fuel", label: "Gas (natural gas or propane)", on: "pipe", example: "Propane" },
  { path: "gas.zone_longest", label: "Longest developed length in this pipe's pressure zone (sizing length)", on: "pipe", example: "250" },
  { path: "gas.carries_cfh", label: "Gas flow this pipe carries (CFH)", on: "pipe", example: "1,950" },
  { path: "gas.heating_value", label: "Heating value of the gas (Btu per cubic foot)", on: "pipe", example: "1,000" },
];

/**
 * The gas segment tag as a tag style preset (id, lines, look): the same
 * content as tag template `gas_pipe`, registered below so Tag styles › Start
 * from and `bim_list_tag_styles` offer it.
 */
export const GAS_SIZE_LENGTH_TAG_PRESET: TagStylePreset = {
  id: "gas.size_length",
  name: "Gas size and length",
  trade: "gas",
  description: "Size and developed length of each gas pipe piece, as gas plans tag every piece.",
  lines: ["{gas.size} {gas.length}"],
  box: "none",
  orientation: "along",
  appliesTo: ["pipe"],
};


/** Steel is the default gas pipe and prints as its size alone; other materials say what they are. */
const GAS_MATERIAL_WORD: Partial<Readonly<Record<PipeMaterial, string>>> = { copper: "CU", csst: "CSST", pe: "PE" };

/** `1"`, `½" SDR 9 PE`, `¾" CSST`. */
export function gasSizeText(size: RunSize): string {
  if (size.shape !== "pipe") return "";
  const word = GAS_MATERIAL_WORD[size.material];
  if (!word) return inchSizeText(size.nominalMm);
  const row = pipeRow(size);
  const sdr = size.material === "pe" ? (row?.designation ?? (size.spec ? pipeSpecLabel(size.spec) : "")) : "";
  return [inchSizeText(size.nominalMm), sdr, word].filter(Boolean).join(" ");
}

const networks = new WeakMap<Elements, Map<string, GasNetwork | null>>();

/** The gas zones walk of a system, once per model state. */
function networkOf(elements: Elements, systemId: string): GasNetwork | null {
  let bySystem = networks.get(elements);
  if (!bySystem) {
    bySystem = new Map();
    networks.set(elements, bySystem);
  }
  if (!bySystem.has(systemId)) bySystem.set(systemId, gasNetwork({ elements }, systemId));
  return bySystem.get(systemId) ?? null;
}

/** The gas zones walk of a system, shared with every other gas field read of the same model state. */
export function gasNetworkOf(elements: Elements, systemId: string): GasNetwork | null {
  return networkOf(elements, systemId);
}

export interface GasPipeQuantities {
  /** This piece's own developed length (ft). */
  readonly lengthFt: number;
  /** From the gas source to the far end of this piece (ft); null when the walk doesn't reach it. */
  readonly fromSourceFt: number | null;
  /** The inlet pressure of the zone it starts in (in. w.c.). */
  readonly zoneInWc: number | null;
}

/** A gas pipe's lengths and zone pressure, unrounded (what `gas.length`, `gas.from_source` and `gas.zone` print). */
export function gasPipeQuantities(elements: Elements, elementId: string): GasPipeQuantities | null {
  const seg = pipeSegmentOf(elements, elementId);
  const system = seg ? elements[seg.systemId] : undefined;
  if (!seg || system?.kind !== "mep_system" || system.systemKind !== "natural_gas") return null;
  return { lengthFt: segmentLength3(seg) / FT, fromSourceFt: fromSourceFt(elements, system, seg.id), zoneInWc: zoneOf(elements, system, seg.id) };
}

const out = (value: FieldScalar, text: string) => ({ value, text });

const lf = (ft: number) => Math.max(1, Math.round(ft));

/** A `gas.*` path on a gas pipe; null when the path is not a gas path (the next resolver answers). */
export function resolveGasField(elements: Elements, elementId: string, path: string): { value: FieldScalar; text: string } | null {
  if (!path.startsWith("gas.")) return null;
  const seg = pipeSegmentOf(elements, elementId);
  const system = seg ? elements[seg.systemId] : undefined;
  if (!seg || system?.kind !== "mep_system" || system.systemKind !== "natural_gas") return out(null, "");
  const lengthFt = segmentLength3(seg) / FT;
  switch (path.slice("gas.".length)) {
    case "size": {
      const t = gasSizeText(seg.size);
      return out(seg.size.shape === "pipe" ? Math.round((seg.size.nominalMm / IN) * 1000) / 1000 : null, t);
    }
    case "length":
      return out(lf(lengthFt), `${lf(lengthFt)} LF`);
    case "tag":
      return out(gasSizeText(seg.size), `${gasSizeText(seg.size)} ${lf(lengthFt)} LF`);
    case "fuel": {
      const fuel = gasFuelOf(system);
      return fuel ? out(fuel, GAS_FUEL_LABEL[fuel]) : out(null, "");
    }
    case "from_source": {
      const ft = fromSourceFt(elements, system, seg.id);
      return ft === null ? out(null, "") : out(Math.round(ft * 10) / 10, `${lf(ft)} LF`);
    }
    case "zone": {
      const zone = zoneOf(elements, system, seg.id);
      return zone === null ? out(null, "") : out(zone, pressureLabel(zone));
    }
    case "zone_longest": {
      const ft = zoneLongestFt(elements, system, seg.id);
      return ft === null ? out(null, "") : out(Math.round(ft * 10) / 10, `${lf(ft)} LF`);
    }
    case "carries_cfh": {
      const net = networkOf(elements, system.id);
      const mbh = carriedMbh(net, seg.id);
      if (!net || mbh === null) return out(null, "");
      const cfh = Math.round(((mbh * 1000) / net.heatingValueBtuPerCf) * 10) / 10;
      return out(cfh, `${cfh.toLocaleString("en-US")} CFH`);
    }
    case "heating_value": {
      const net = networkOf(elements, system.id);
      return net ? out(net.heatingValueBtuPerCf, `${net.heatingValueBtuPerCf.toLocaleString("en-US")} Btu/cf`) : out(null, "");
    }
    default:
      return out(null, "");
  }
}

/** The far end of a drawn gas pipe from the source (ft): the largest developed length over its pieces. */
function fromSourceFt(elements: Elements, system: MepSystem, segmentId: ElementId): number | null {
  const net = networkOf(elements, system.id);
  let best: number | null = null;
  for (const z of net?.zones ?? []) for (const s of z.segments) if (s.elementId === segmentId) best = Math.max(best ?? 0, s.fromSourceFt);
  return best;
}

/** The inlet pressure of the zone a drawn gas pipe starts in (in. w.c.). */
function zoneOf(elements: Elements, system: MepSystem, segmentId: ElementId): number | null {
  const net = networkOf(elements, system.id);
  let best: { inlet: number; from: number } | null = null;
  for (const z of net?.zones ?? []) for (const s of z.segments) if (s.elementId === segmentId && (best === null || s.fromSourceFt < best.from)) best = { inlet: z.inletInWc, from: s.fromSourceFt };
  return best?.inlet ?? null;
}

/** The longest developed length of the pressure zone a drawn gas pipe starts in (ft): what the longest-length method sizes on. */
function zoneLongestFt(elements: Elements, system: MepSystem, segmentId: ElementId): number | null {
  const net = networkOf(elements, system.id);
  let best: { longest: number; from: number } | null = null;
  for (const z of net?.zones ?? []) for (const s of z.segments) if (s.elementId === segmentId && (best === null || s.fromSourceFt < best.from)) best = { longest: z.longestFt, from: s.fromSourceFt };
  return best?.longest ?? null;
}

/** The gas input a drawn pipe carries (MBH): every length from its upstream end down, each length's load counted once. */
function carriedMbh(net: GasNetwork | null, segmentId: ElementId): number | null {
  for (const z of net?.zones ?? []) {
    const mine = z.segments.filter((s) => s.elementId === segmentId);
    if (mine.length === 0) continue;
    const top = mine.reduce((a, b) => (b.fromSourceFt < a.fromSourceFt ? b : a));
    const children = new Map<string, string[]>();
    for (const s of z.segments) if (s.parent !== null) children.set(s.parent, [...(children.get(s.parent) ?? []), s.id]);
    const byId = new Map(z.segments.map((s) => [s.id, s] as const));
    let total = 0;
    const stack = [top.id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      total += byId.get(id)?.loadMbh ?? 0;
      stack.push(...(children.get(id) ?? []));
    }
    return total;
  }
  return null;
}
