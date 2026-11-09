import type { BimElement } from "../types";
import { domainWord, sizeLabel } from "./rules";
import { systemKindLabel } from "./system-label";
import type { RunFitting, RunSegment } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/** Plain name of a run element: "12"x8" supply air duct", "2" copper domestic cold water pipe", "90° elbow". */
export function runLabel(elements: Elements, el: RunSegment | RunFitting): string {
  const system = elements[el.systemId];
  const what = system?.kind === "mep_system" ? systemKindLabel(system).toLowerCase() : "";
  if (el.kind === "run_segment") return `${sizeLabel(el.size)} ${what} ${el.flex ? "flex" : domainWord(el.domain)}`.replace(/\s+/g, " ");
  const size = el.ports[0]?.size;
  return `${el.label}${size ? ` (${sizeLabel(size)})` : ""}`;
}
