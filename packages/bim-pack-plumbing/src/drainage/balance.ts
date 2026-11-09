/**
 * The balance shape now lives in the cross-trade kernel module (balance/core.ts,
 * KERNEL-REQUIREMENTS-MODEL §3.10). Drainage keeps reading it from here.
 */
export { balance, coversDemand, type BalanceResult, type BalanceTolerance, type BalanceVerdict, type DemandCoverage } from "@permitzip/bim-kernel";
