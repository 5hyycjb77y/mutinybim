import type { CalcSheetTemplateRow } from "@permitzip/bim-kernel/calc-sheets";
import { GAS_SIZING_TEMPLATE } from "./gas-sizing";
import { GREASE_INTERCEPTOR_TEMPLATE } from "./grease-interceptor";
import { WATER_PRESSURE_LOSS_TEMPLATE } from "./water-pressure-loss";

export * from "./gas-sizing";
export * from "./water-pressure-loss";
export * from "./grease-interceptor";

/** Plumbing and gas's calculation sheets, in Insert › Calculation order. Ids are stored on placed sheets: frozen. */
export const PLUMBING_CALC_SHEET_TEMPLATES: readonly CalcSheetTemplateRow[] = [GAS_SIZING_TEMPLATE, WATER_PRESSURE_LOSS_TEMPLATE, GREASE_INTERCEPTOR_TEMPLATE];
