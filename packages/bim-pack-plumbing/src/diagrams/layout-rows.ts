import { riserLevels } from "@permitzip/bim-kernel";
import type { DiagramGraphLayoutInput, DiagramGraphLayoutResult, DiagramLayoutRow } from "@permitzip/bim-kernel";
import type { PackRefusal } from "@permitzip/bim-kernel/packs";
import { layoutPipingIsometric } from "./isometric-layout";
import { layoutPipingRiser, type PipingLayout } from "./piping-layout";

/**
 * Plumbing's diagram layout rows (`kernel.diagram_layout`, contract 1.12.0):
 * the plumbing riser and the plumbing isometric, drawn from the graph
 * `plumbingDiagramGraph` builds. Both draw one line across systems (hot water
 * leaving the heater on the cold line), so only the engineer's own section
 * boxes are drawn. The views store only their kind and hints; there is no
 * stored spec for `layout` to read.
 */

const NO_STORED_SPEC = (label: string): PackRefusal => ({ refused: `A ${label.toLowerCase()} is drawn from the model's piping, not from a stored spec` });

function asGraphLayout(layout: PipingLayout): DiagramGraphLayoutResult {
  const { pipes, ...rest } = layout;
  return { ...rest, pieces: pipes };
}

function labelsOf(input: DiagramGraphLayoutInput) {
  return input.hints.pipeLabels ? { labels: input.hints.pipeLabels } : {};
}

const RISER_LABEL = "Plumbing riser diagram";
const ISOMETRIC_LABEL = "Plumbing isometric";

export const PLUMBING_DIAGRAM_LAYOUT_ROWS: readonly DiagramLayoutRow[] = [
  {
    kind: "plumbing_riser",
    label: RISER_LABEL,
    serviceSections: false,
    check: () => null,
    layout: () => NO_STORED_SPEC(RISER_LABEL),
    layoutGraph: (input) => asGraphLayout(layoutPipingRiser(input.roots, riserLevels(input.elements), labelsOf(input))),
  },
  {
    kind: "plumbing_isometric",
    label: ISOMETRIC_LABEL,
    serviceSections: false,
    check: () => null,
    layout: () => NO_STORED_SPEC(ISOMETRIC_LABEL),
    layoutGraph: (input) => asGraphLayout(layoutPipingIsometric(input.roots, input.graph.pipes ?? [], labelsOf(input))),
  },
];
