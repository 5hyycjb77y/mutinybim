import { paramValue, type BimElement, type PartInstance, type PartTypeElement } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Equipment as the electrical side sees it: the nameplate ratings a
 * mechanical (or any) part carries, read the same way for built-in parts,
 * cut-sheet parts (`mop`, `fla`, `phase`) and engineer-made ones (`mocp`,
 * `phases`). The circuit's default breaker, the protection findings and the
 * equipment connection schedule all read this one place.
 */

export interface EquipmentNameplate {
  readonly voltage: number | null;
  readonly phases: 1 | 3 | null;
  /** Minimum circuit ampacity. */
  readonly mcaA: number | null;
  /** Maximum overcurrent protection (MOCP / MOP / max fuse). */
  readonly mocpA: number | null;
  /** Full-load amps. */
  readonly flaA: number | null;
  readonly motorHp: number | null;
}

function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

function num(type: PartTypeElement, part: PartInstance, ...names: string[]): number | null {
  for (const n of names) {
    const v = paramValue(type.definition, part.values, n);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  }
  return null;
}

export function equipmentNameplate(elements: Elements, part: PartInstance): EquipmentNameplate {
  const type = typeOf(elements, part);
  if (!type) return { voltage: null, phases: null, mcaA: null, mocpA: null, flaA: null, motorHp: null };
  const phase = num(type, part, "phases", "phase");
  return {
    voltage: num(type, part, "voltage"),
    phases: phase === 1 || phase === 3 ? phase : null,
    mcaA: num(type, part, "mca"),
    mocpA: num(type, part, "mocp", "mop", "max_fuse", "max_ocpd"),
    flaA: num(type, part, "fla"),
    motorHp: num(type, part, "motor_hp", "hp"),
  };
}
