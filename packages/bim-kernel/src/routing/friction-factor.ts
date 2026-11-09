import type { SystemDesign } from "./types";

/**
 * The Darcy friction factor of a full run (Colebrook, or the
 * Altshul-Tsal approximation): fluid mechanics every trade that sizes a
 * pressure-driven run shares. Each add-on brings its own fluid and roughness.
 */

/** Darcy friction factor. Laminar below Re 2300. */
export function frictionFactor(re: number, relRoughness: number, method: NonNullable<SystemDesign["frictionMethod"]> = "colebrook"): number {
  if (re <= 0) return 0;
  if (re < 2300) return 64 / re;
  if (method === "altshul_tsal") {
    const f1 = 0.11 * (relRoughness + 68 / re) ** 0.25;
    return f1 >= 0.018 ? f1 : 0.85 * f1 + 0.0028;
  }
  // Swamee–Jain start, then Colebrook to convergence.
  let f = 0.25 / Math.log10(relRoughness / 3.7 + 5.74 / re ** 0.9) ** 2;
  for (let i = 0; i < 20; i++) {
    const next = (-2 * Math.log10(relRoughness / 3.7 + 2.51 / (re * Math.sqrt(f)))) ** -2;
    if (Math.abs(next - f) < 1e-10) return next;
    f = next;
  }
  return f;
}
