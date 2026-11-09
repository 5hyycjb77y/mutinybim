/** Conductor sizes, smallest to largest, as NEC tables spell them (AWG, then kcmil). */
export const CONDUCTOR_SIZES = [
  "14",
  "12",
  "10",
  "8",
  "6",
  "4",
  "3",
  "2",
  "1",
  "1/0",
  "2/0",
  "3/0",
  "4/0",
  "250",
  "300",
  "350",
  "400",
  "500",
  "600",
  "700",
  "750",
  "800",
  "900",
  "1000",
  "1250",
  "1500",
  "1750",
  "2000",
] as const;

export type ConductorSize = (typeof CONDUCTOR_SIZES)[number];

export type ConductorMaterial = "copper" | "aluminum";

export const sizeIndex = (s: ConductorSize): number => CONDUCTOR_SIZES.indexOf(s);

export const isKcmil = (s: ConductorSize): boolean => sizeIndex(s) >= sizeIndex("250");

/** "#12", "#1/0", "250 kcmil": how a schedule writes it. */
export function sizeLabel(s: ConductorSize): string {
  return isKcmil(s) ? `${s} kcmil` : `#${s}`;
}

export function isConductorSize(value: string): value is ConductorSize {
  return (CONDUCTOR_SIZES as readonly string[]).includes(value);
}

/** Accepts "12", "#12", "12 AWG", "1/0", "250", "250 kcmil", "250MCM". */
export function parseConductorSize(text: string): ConductorSize | null {
  const t = text.trim().toLowerCase().replace(/^#/, "").replace(/\s{0,32}(awg|kcmil|mcm)$/, "").trim();
  return isConductorSize(t) ? t : null;
}

export const materialLabel = (m: ConductorMaterial): string => (m === "copper" ? "Cu" : "Al");
