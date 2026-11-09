import type { OneLineDevice, OneLineKind, OneLineTextLine } from "../layout/one-line";
import { defineExtensionPoint } from "../packs/contract";
import type { BimElement, ElementId } from "../types";
import type { DiagramHints, DiagramLabelKind } from "./definition";

/**
 * The graph a diagram adapter reads from the model: each node one model
 * element (or a placeholder the engineer asked for), each edge the link that
 * serves it. Layouts take this graph and nothing else, so the same model
 * gives the same graph, and the same graph the same drawing.
 */

export interface DiagramEdge {
  /** The served-from link (feeder, branch circuit) or the pipe run it stands for; null for a placeholder. */
  readonly linkId: ElementId | null;
  readonly device: OneLineDevice;
  /** "225A/3P". */
  readonly deviceLabel?: string;
  /** "(2) SETS 4#500 KCMIL AL, 1#3/0 G". */
  readonly conductors?: string;
  readonly lengthFt?: number;
  /** Feeder type mark, drawn in an oval ("F225"). */
  readonly typeMark?: string;
  /** For riser layouts: what the line between the two says (a pipe size). */
  readonly label?: string;
  /** Piping: every model element the drawn line stands for (segments, elbows, the branch fitting), in flow order. */
  readonly elementIds?: readonly ElementId[];
  /** Piping: the one of `elementIds` a click on the drawn line selects (the piece its label names); absent, the first. */
  readonly selects?: ElementId;
  /** Piping: what the pipe carries, as it prints ("59 DFU"). */
  readonly load?: string;
  /** Piping: slope of a gravity pipe ("1/8\"/FT") and its invert at the downstream end ("INV -2.17'"). */
  readonly slope?: string;
  readonly invert?: string;
  /** Piping: the piece rises or falls more than it runs (a stack or riser). */
  readonly vertical?: boolean;
}

/** Piping: what a node is on its line. A branch starts a line of its own; a device sits on the line; a terminal ends it. */
export type DiagramPipeRole = "source" | "branch" | "device" | "terminal";

/** Piping: one straight piece of pipe as modelled, ends in project mm (z above the project's zero), for isometrics. */
export interface DiagramPipe {
  readonly elementId: ElementId;
  readonly systemKind: string;
  readonly a: { readonly x: number; readonly y: number; readonly z: number };
  readonly b: { readonly x: number; readonly y: number; readonly z: number };
}

export interface DiagramNode {
  /** The model element, or `<kind>:<parent>:<n>` for something the diagram draws on its own (utility, future space). */
  readonly id: string;
  /** The model element it stands for, or null for a placeholder. */
  readonly elementId: ElementId | null;
  readonly kind: OneLineKind;
  readonly labelKind: DiagramLabelKind;
  readonly name: string;
  /** The text block as it prints, first line the name. */
  readonly lines: readonly OneLineTextLine[];
  /** Level element id the equipment is on (risers draw by level). */
  readonly levelId: string | null;
  /** The service it is part of ("normal", "fire pump"…), inherited down the tree. */
  readonly service: string;
  /** The link from the parent (absent for a root). */
  readonly feed?: DiagramEdge;
  readonly children: readonly DiagramNode[];
  /** A transfer switch's emergency source. */
  readonly emergency?: DiagramNode;
  readonly placeholder?: boolean;
  /** Equipment that exists but isn't placed in the drawing yet: drawn dashed and marked NOT PLACED. */
  readonly planned?: boolean;
  /** Bus equipment with a main breaker (drawn ahead of its bus). */
  readonly mainBreaker?: boolean;
  /** Piping: its place on the line, and where it is in the model (project mm, z above the project's zero). */
  readonly role?: DiagramPipeRole;
  readonly at?: { readonly x: number; readonly y: number; readonly z: number };
}

export type DiagramWarningKind = "bus_above_feeding_breaker" | "breaker_above_bus" | "not_fed" | "loop" | "missing_data" | "fed_from_text_mismatch";

export interface DiagramWarning {
  readonly kind: DiagramWarningKind;
  readonly elementId: ElementId;
  /** As it prints beside the equipment ("400A BUS FED BY 225A BREAKER"). */
  readonly short: string;
  /** The plain sentence for findings and the agent. */
  readonly message: string;
}

export interface DiagramGraph {
  readonly roots: readonly DiagramNode[];
  readonly warnings: readonly DiagramWarning[];
  /** Model elements the graph read, in id order (what an edit must touch to change the diagram). */
  readonly reads: readonly ElementId[];
  /** Piping: every modelled pipe of the systems drawn (isometrics project these). */
  readonly pipes?: readonly DiagramPipe[];
}

/** Every node of a graph, parents before children (emergency sources after their switch). */
export function diagramNodes(graph: Pick<DiagramGraph, "roots">): DiagramNode[] {
  const out: DiagramNode[] = [];
  const walk = (n: DiagramNode) => {
    out.push(n);
    if (n.emergency) walk(n.emergency);
    for (const c of n.children) walk(c);
  };
  for (const r of graph.roots) walk(r);
  return out;
}

/**
 * What builds one diagram kind's graph from the model (v1), from the pack
 * that owns the kind. `roots` decorates the graph's roots before layout (a
 * utility node above each service); absent, the roots are drawn as built.
 */
export interface DiagramGraphDef {
  /** The stored diagram kind (`DiagramDefinition.kind`). */
  readonly kind: string;
  build(elements: Readonly<Record<string, BimElement>>, hints: DiagramHints): DiagramGraph;
  roots?(elements: Readonly<Record<string, BimElement>>, graph: DiagramGraph, hints: DiagramHints): readonly DiagramNode[];
}

/** Diagram graph builders, by stored diagram kind (bare: kinds are stored). */
export const DIAGRAM_GRAPH_POINT = defineExtensionPoint<DiagramGraphDef>({ id: "kernel.diagram_graph", version: 1, label: "Diagram graphs", idOf: (d) => d.kind, namespaced: false });
