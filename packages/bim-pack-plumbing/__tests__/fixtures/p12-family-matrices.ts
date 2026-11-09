import type { FittingChoice, FittingFamily, FittingSlot, FittingType, PipeMaterial, RunSize, SystemKind } from "@permitzip/bim-kernel";

/**
 * Every answer the pipe fitting library gives, as plain data: the default
 * choice per system kind × slot × material (and with no size), the fit
 * refusal per family × system kind × fitting type × material × size, and the
 * placed label per tee family × sizes. Used twice: on round 11's kernel table
 * (frozen into `p12-r11-fitting-families.json` before the move) and on the
 * add-on's rows today. Equal answers mean old models open identically.
 */
type PipeSize = Extract<RunSize, { shape: "pipe" }>;

export interface MatrixInputs {
  readonly families: readonly FittingFamily[];
  readonly choice: (kind: SystemKind, slot: FittingSlot, size: PipeSize | undefined) => FittingChoice;
  readonly mismatch: (family: FittingFamily, f: { readonly fittingType: FittingType; readonly sizes: readonly RunSize[]; readonly systemKind?: SystemKind; readonly main?: RunSize }) => string | null;
  readonly label: (family: FittingFamily, sizes: readonly RunSize[], main: RunSize | undefined) => string;
  readonly kinds: readonly SystemKind[];
  readonly slots: readonly FittingSlot[];
  readonly materials: readonly PipeMaterial[];
  readonly serviceOf: (kind: SystemKind) => string | null;
}

export interface Matrices {
  readonly choices: Record<string, FittingChoice>;
  readonly mismatch: Record<string, string | null>;
  readonly labels: Record<string, string>;
}

const IN = 25.4;
const pipe = (material: PipeMaterial, inches: number): PipeSize => ({ shape: "pipe", nominalMm: inches * IN, material });

export function matrices(m: MatrixInputs): Matrices {
  const choices: Record<string, FittingChoice> = {};
  const mismatch: Record<string, string | null> = {};
  const labels: Record<string, string> = {};
  const pipeKinds = m.kinds.filter((k) => m.serviceOf(k) !== null);
  for (const kind of pipeKinds) {
    for (const slot of m.slots) {
      choices[`${kind}|${slot}|-`] = m.choice(kind, slot, undefined);
      for (const mat of m.materials) choices[`${kind}|${slot}|${mat}`] = m.choice(kind, slot, pipe(mat, 2));
    }
  }
  for (const family of m.families) {
    const type = family.fittingTypes[0];
    if (!type) continue;
    for (const kind of [undefined, ...pipeKinds]) {
      for (const mat of m.materials) {
        for (const inches of [1, 4]) {
          const size = pipe(mat, inches);
          mismatch[`${family.id}|${kind ?? "-"}|${type}|${mat}|${inches}`] = m.mismatch(family, { fittingType: type, sizes: [size], ...(kind ? { systemKind: kind } : {}), main: pipe(mat, 6) });
        }
      }
    }
    if (family.pipe?.form === "tee") {
      const mat = family.pipe.materials[0] ?? "copper";
      labels[`${family.id}|reducing`] = m.label(family, [pipe(mat, 1)], pipe(mat, 2));
      labels[`${family.id}|equal`] = m.label(family, [pipe(mat, 2)], pipe(mat, 2));
    }
  }
  return { choices, mismatch, labels };
}
