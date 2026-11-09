/**
 * Static pressure and run readouts for the Building Model screens, from the
 * add-on that owns them. Screens import this host module, so they name no
 * trade package; `model-session.ts` loads it lazily.
 */
export { PA_PER_IN_WC, PressureEngine, runReadout, type FittingPressure, type SegmentPressure } from "@permitzip/bim-pack-mechanical";
