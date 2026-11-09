import { qty, to } from "@permitzip/bim-units";
import { z } from "zod";
import { defineCalc, methodCite, round, type CalcIssue, type CalcValue, type Citation } from "@permitzip/bim-calc";
import { makeupAirHeat, SENSIBLE_HEAT_FACTOR } from "../../balance/makeup-air";

/**
 * Untempered (or partly tempered) makeup air on the calc plugin interface
 * (ROADMAP M1): the sensible load the serving unit must carry,
 * Q = 1.08 × cfm × ΔT. The arithmetic is the kernel's (balance/makeup-air.ts),
 * the same the pressurization table and the unit's field print.
 */

export const SENSIBLE_HEAT_CITE: Citation = methodCite("ASHRAE Handbook—Fundamentals, Psychrometrics", `sensible heat, standard air: Q = ${SENSIBLE_HEAT_FACTOR} × cfm × ΔT`, "1.08 = 60 min/h × 0.075 lb/ft³ × 0.24 Btu/lb·°F; not verified against a code library record");

const input = z
  .object({
    cfm: z.number().min(0).max(200_000).describe("Makeup airflow, cfm."),
    from_f: z.number().min(-60).max(150).describe("Temperature the makeup air arrives at, °F (outdoor design, or what a partial tempering unit delivers)."),
    to_f: z.number().min(-60).max(150).describe("Temperature it must be brought to, °F (the room or the serving unit's design)."),
  })
  .strict();

export const makeupAirHeatCalc = defineCalc({
  id: "mech.makeup_air_heat",
  version: "1.0.0",
  domain: "mechanical",
  title: "Makeup air tempering load (1.08 × cfm × ΔT)",
  summary: "Sensible load the unit serving a space carries when makeup air enters untempered or partly tempered: Q (Btu/h) = 1.08 × cfm × (to − from). Heating when the air must be warmed, cooling when cooled. Worked: 2,400 cfm from 80 °F to 92 °F = 31,104 Btu/h.",
  codeFamily: null,
  needsModel: false,
  input,
  example: { cfm: 2400, from_f: 80, to_f: 92 },
  run: (args) => {
    const h = makeupAirHeat({ airflow: qty("flow_air", args.cfm, "cfm"), from: qty("temperature", args.from_f, "degF"), to: qty("temperature", args.to_f, "degF") });
    const btuh = to(h.load, "Btu/h");
    const values: CalcValue[] = [
      { key: "load_mbh", label: `Makeup air ${h.direction === "none" ? "load" : h.direction} load`, value: round(btuh / 1000, 3), unit: "mbh", cite: [SENSIBLE_HEAT_CITE] },
      { key: "direction", label: "Heating or cooling", value: h.direction, unit: null, cite: [SENSIBLE_HEAT_CITE] },
      { key: "delta_f", label: "Temperature difference", value: round(Math.abs(h.toF - h.fromF), 2), unit: "degF", cite: [SENSIBLE_HEAT_CITE] },
    ];
    const issues: CalcIssue[] = h.direction === "none" ? [{ severity: "info", message: "The air arrives at the temperature it must be brought to, so it adds no load.", cite: [] }] : [];
    return { values, steps: [{ label: "Q = 1.08 × cfm × ΔT", detail: h.arithmetic, cite: [SENSIBLE_HEAT_CITE] }], issues, detail: h };
  },
});
