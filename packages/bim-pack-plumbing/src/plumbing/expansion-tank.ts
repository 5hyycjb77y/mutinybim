import { elementsOfKind, pipeDims, type BimElement } from "@permitzip/bim-kernel";
import { waterDensity } from "../routing/pipe/hydraulics";

type Elements = Readonly<Record<string, BimElement>>;

const MM3_PER_GAL = 3_785_411.784;
const ATM_PSI = 14.696;

/**
 * Expansion tank check (round 13 P13): a closed hot water system's water
 * grows as it heats; the tank must take that growth between its fill
 * (pre-charge) pressure and the most the system may reach (below the relief
 * valve). Physics only: water's density at the two temperatures (the same
 * `waterDensity` the hydraulics use) and Boyle's law on the tank's air. A
 * check, not a load. Nothing is guessed: every missing input is named.
 */

export interface ExpansionTankInputs {
  /** Water in the heated system (heater storage plus piping), US gal. */
  readonly systemGal: number | null;
  readonly coldF: number | null;
  readonly hotF: number | null;
  /** Fill / pre-charge pressure at the tank, psig. */
  readonly fillPsi: number | null;
  /** The most the system may reach at the tank (below the relief setting), psig. */
  readonly maxPsi: number | null;
  /** The tank's total volume, US gal. */
  readonly tankGal: number | null;
}

export type ExpansionTankCheck =
  | { readonly kind: "needs_input"; readonly missing: readonly string[]; readonly message: string }
  | { readonly kind: "checked"; readonly expansionGal: number; readonly requiredGal: number; readonly tankGal: number; readonly ok: boolean; readonly message: string };

const LABEL: Readonly<Record<keyof ExpansionTankInputs, string>> = {
  systemGal: "the system volume",
  coldF: "the cold water temperature",
  hotF: "the stored hot water temperature",
  fillPsi: "the fill pressure",
  maxPsi: "the maximum system pressure",
  tankGal: "the tank's volume",
};

const r1 = (v: number) => Math.round(v * 10) / 10;

export function expansionTankCheck(input: ExpansionTankInputs): ExpansionTankCheck {
  const missing = (Object.keys(LABEL) as (keyof ExpansionTankInputs)[]).filter((k) => input[k] === null).map((k) => LABEL[k]);
  const { systemGal, coldF, hotF, fillPsi, maxPsi, tankGal } = input;
  if (missing.length > 0 || systemGal === null || coldF === null || hotF === null || fillPsi === null || maxPsi === null || tankGal === null) return { kind: "needs_input", missing, message: `Can't size the expansion tank yet: add ${missing.join(", ")}` };
  if (hotF <= coldF) return { kind: "needs_input", missing: [], message: "The stored temperature must be above the cold water temperature: check both" };
  if (maxPsi <= fillPsi) return { kind: "needs_input", missing: [], message: "The maximum system pressure must be above the fill pressure: check both" };
  const expansionGal = systemGal * (waterDensity(coldF) / waterDensity(hotF) - 1);
  const acceptance = 1 - (fillPsi + ATM_PSI) / (maxPsi + ATM_PSI);
  const requiredGal = expansionGal / acceptance;
  const ok = tankGal >= requiredGal - 1e-9;
  const message = `${r1(systemGal)} gal heated from ${coldF}°F to ${hotF}°F grows ${r1(expansionGal)} gal; between ${fillPsi} and ${maxPsi} psi that needs a ${r1(requiredGal)} gal tank: ${tankGal} gal ${ok ? "is enough" : "is too small"}`;
  return { kind: "checked", expansionGal, requiredGal, tankGal, ok, message };
}

/** Water in a system's drawn pipe, US gal (inside diameter × length, every segment once). */
export function drawnPipeVolumeGal(elements: Elements, systemId: string): number {
  let mm3 = 0;
  for (const seg of elementsOfKind(elements, "run_segment")) {
    if (seg.systemId !== systemId || seg.size.shape !== "pipe") continue;
    const r = pipeDims(seg.size).idMm / 2;
    mm3 += Math.PI * r * r * Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y, seg.end.z - seg.start.z);
  }
  return mm3 / MM3_PER_GAL;
}
