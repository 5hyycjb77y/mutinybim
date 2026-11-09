import { qty, to, type Quantity } from "@permitzip/bim-units";

/**
 * Sensible load of outdoor air brought to a temperature (ROADMAP M1: untempered
 * makeup air adds load to the unit that serves the space):
 *
 *   Q (Btu/h) = 1.08 × cfm × ΔT (°F)
 *
 * 1.08 = 60 min/h × 0.075 lb/ft³ (standard air) × 0.24 Btu/(lb·°F), the
 * sensible heat equation for standard air (ASHRAE Handbook, Fundamentals,
 * psychrometrics; not verified against a code library record). Physics, not a
 * code table, so it lives beside the balance it feeds; bim-calc puts it on the
 * calc plugin interface (`mech.makeup_air_heat`).
 *
 * Worked (HVAC Demo 2, 16:43, 7303 kitchen): 2,400 × 1.08 × (92 − 80) = 31,104 Btu/h.
 */

export const SENSIBLE_HEAT_FACTOR = 1.08;
export const SENSIBLE_HEAT_SOURCE = "Q = 1.08 × cfm × ΔT, standard air (60 min/h × 0.075 lb/ft³ × 0.24 Btu/lb·°F), ASHRAE Handbook—Fundamentals (not verified)";

export interface MakeupAirHeatInput {
  readonly airflow: Quantity<"flow_air">;
  /** The air as it arrives (outdoor design, or what a partial tempering unit delivers). */
  readonly from: Quantity<"temperature">;
  /** The temperature it must be brought to (the room or the serving unit's design). */
  readonly to: Quantity<"temperature">;
}

export interface MakeupAirHeat {
  /** Always non-negative. */
  readonly load: Quantity<"thermal_power">;
  /** Heating when the air must be warmed (to above from), cooling when cooled, none when equal. */
  readonly direction: "heating" | "cooling" | "none";
  readonly cfm: number;
  readonly fromF: number;
  readonly toF: number;
  /** "2,400 × 1.08 × (92 − 80) = 31,104 Btu/h". */
  readonly arithmetic: string;
}

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ONE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function makeupAirHeat(input: MakeupAirHeatInput): MakeupAirHeat {
  const cfm = to(input.airflow, "cfm");
  const fromF = to(input.from, "degF");
  const toF = to(input.to, "degF");
  if (!Number.isFinite(cfm) || cfm < 0) throw new RangeError(`Makeup airflow must be a non-negative number, got ${cfm} cfm`);
  if (!Number.isFinite(fromF) || !Number.isFinite(toF)) throw new RangeError("Both design temperatures must be numbers");
  const deltaF = toF - fromF;
  const btuh = SENSIBLE_HEAT_FACTOR * cfm * Math.abs(deltaF);
  const hi = Math.max(toF, fromF);
  const lo = Math.min(toF, fromF);
  return {
    load: qty("thermal_power", btuh, "Btu/h"),
    direction: deltaF > 0 ? "heating" : deltaF < 0 ? "cooling" : "none",
    cfm,
    fromF,
    toF,
    arithmetic: `${WHOLE.format(cfm)} × ${SENSIBLE_HEAT_FACTOR} × (${ONE.format(hi)} − ${ONE.format(lo)}) = ${WHOLE.format(Math.round(btuh))} Btu/h`,
  };
}
