import { chartKind, registerChartKind } from "@permitzip/bim-kernel";
import { BIM_CALC_CHART_KINDS } from "@permitzip/bim-pack-plumbing/host";

/**
 * The chart kinds the host app offers on sheets (bim-calc's: the Hunter curve
 * first). The kernel draws a chart figure only for a registered kind, so
 * every place that builds a sheet scene (the Building Model, Print PDF, the
 * agent's renders and set issues) calls this first.
 */
export function ensureBimChartKinds(): void {
  for (const kind of BIM_CALC_CHART_KINDS) if (chartKind(kind.id) !== kind) registerChartKind(kind);
}
