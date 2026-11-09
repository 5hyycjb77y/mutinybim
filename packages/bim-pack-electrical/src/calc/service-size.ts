import { z } from "zod";
import { necCite, type NecEdition, type CalcIssue, type CalcOutput, type CalcStep, type CalcValue, type Citation, SQRT3, round } from "@permitzip/bim-calc";
import { LOAD_CLASSES, demandLoad, type DemandDetail } from "./demand";

/**
 * Early service sizing (V4@0:00): before any layout, from the kitchen
 * consultant's equipment schedule and the mechanical schedule. A pasted
 * table, a CSV or text copied out of a PDF becomes one row per item with
 * its load in VA and a suggested NEC load class; the engineer confirms each
 * class, then the service is sized by the same Article 220 demand calc every
 * panel uses, so the trail reads the same way.
 *
 * Reading the pasted list (rows, units, the class suggestion) is shared with
 * the Building Model's Equipment list: `readEquipmentList` in equipment-list.ts.
 * Nothing here selects equipment (US 11,087,054 design rules).
 */

export const SERVICE_SIZES_A = [100, 125, 150, 200, 225, 400, 600, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000, 5000, 6000] as const;

export const serviceSizeInput = z
  .object({
    voltage_v: z.number().positive().max(1000).describe("Service voltage: line-to-line for three-phase (208, 480), 240 for 120/240 V single-phase."),
    phases: z.union([z.literal(1), z.literal(3)]),
    occupancy: z.enum(["dwelling", "hospital", "hotel", "warehouse", "other"]).default("other"),
    items: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(160),
            class: z.enum(LOAD_CLASSES).describe("The class the engineer confirmed."),
            va: z.number().positive().max(10_000_000).describe("Load of one unit, VA."),
            quantity: z.number().int().min(1).max(10_000).default(1),
            continuous: z.boolean().optional().describe("Runs 3 hours or more. Default from the code pack: lighting, and heating (424.4(B))."),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    spare_pct: z.number().min(0).max(100).default(0).describe("Future capacity added on top of the calculated load (design choice, not code)."),
  })
  .strict();

export type ServiceSizeInput = z.infer<typeof serviceSizeInput>;

export interface ServiceSizeDetail {
  readonly demand: DemandDetail;
  /** Every load at 100% (no demand factor): the SD study's "82 kW = 342 A at 240 V". */
  readonly connectedVa: number;
  /** connectedVa as line current at the service voltage. */
  readonly connectedA: number;
  /** Minimum required ampacity: noncontinuous + 125% of continuous (230.42(A)(1)) plus spare, amps at the service voltage. */
  readonly requiredA: number;
  /** The next standard service rating at or above requiredA; null above the largest. */
  readonly serviceA: number | null;
  readonly label: string;
}

const systemWords = (v: number, phases: 1 | 3) =>
  phases === 3 ? (v <= 240 ? `120/${v} V 3-phase 4-wire` : `${Math.round(v / SQRT3)}/${v} V 3-phase 4-wire`) : v === 240 ? "120/240 V single-phase 3-wire" : `${v} V single-phase`;

/** The smallest standard service at or above the minimum required ampacity (230.42(A)(1), 230.79), with the Article 220 trail. */
export function serviceSize(nec: NecEdition, input: ServiceSizeInput): CalcOutput<ServiceSizeDetail> {
  const demand = demandLoad(nec, {
    node: "Service",
    occupancy: input.occupancy,
    voltage_v: input.voltage_v,
    phases: input.phases,
    loads: input.items.map((i) => ({ label: i.label, class: i.class, va: i.va, quantity: i.quantity, ...(i.continuous !== undefined ? { continuous: i.continuous } : {}) })),
  }, { sizingClause: "service_continuous" });
  const d = demand.detail;
  const spare = input.spare_pct / 100;
  const requiredA = d.sizingA * (1 + spare);
  const serviceA = SERVICE_SIZES_A.find((s) => s >= requiredA - 1e-9) ?? null;
  const cites: Citation[] = [necCite(nec, "service_conductors", "not less than the calculated load per Article 220"), necCite(nec, "service_rating", "service disconnect rated not less than the calculated load")];
  const steps: CalcStep[] = [...demand.steps];
  if (spare > 0) steps.push({ label: "Spare capacity", detail: `${round(d.sizingA, 1)} A + ${input.spare_pct}% future = ${round(requiredA, 1)} A (design choice)`, cite: [] });
  const system = systemWords(input.voltage_v, input.phases);
  const label = serviceA ? `${serviceA} A, ${system}` : `over ${SERVICE_SIZES_A[SERVICE_SIZES_A.length - 1]} A: more than one service or a higher voltage`;
  steps.push({ label: "Service size", detail: serviceA ? `Minimum required ampacity ${round(requiredA, 1)} A; the next standard rating at or above it is ${label}` : `Minimum required ampacity ${round(requiredA, 1)} A: ${label}`, cite: cites });
  const issues: CalcIssue[] = [...demand.issues];
  if (serviceA === null) issues.push({ severity: "warning", message: `${round(requiredA, 0)} A at ${input.voltage_v} V is above the largest standard service; consider 480 V or more than one service.`, cite: cites });
  issues.push({ severity: "info", message: "Early estimate from the equipment list: confirm with the utility and the full Article 220 calculation once the design has panels.", cite: [] });
  const values: CalcValue[] = [...demand.values, { key: "required_a", label: "Minimum required ampacity (noncontinuous + 125% of continuous, plus spare)", value: round(requiredA, 1), unit: "A", cite: cites }, { key: "service_a", label: "Service size (next standard rating at or above the minimum)", value: serviceA, unit: "A", cite: cites }];
  const connectedA = d.connectedVa / (input.phases === 3 ? input.voltage_v * SQRT3 : input.voltage_v);
  return { values, steps, issues, detail: { demand: d, connectedVa: d.connectedVa, connectedA, requiredA, serviceA, label } };
}
