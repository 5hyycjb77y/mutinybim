import { drawnWidth, fittingBody, fittingFamily, fittingMesh, jointIssue, pipeDims, pipeSizeIssue, specOfSize, validateModel, type BimElement, type ModelState, type RunSegment, type RunSize } from "../../src";

/**
 * Round 10 lane P10: what a model's pipes read as, through the public
 * readers only (dimensions, the product's hydraulics and words, every
 * fitting's joint check, body and mesh). Round 9's kernel wrote these
 * numbers into `stored-changesets/pipe-*.json`; the moved catalogue must
 * read every stored model the same, element by element.
 */
export interface PipeReading {
  readonly dims?: { readonly odMm: number; readonly idMm: number; readonly listed: boolean };
  readonly drawnMm?: number;
  readonly sizeIssue?: string | null;
  readonly product?: { readonly name: string; readonly standard: string; readonly roughnessMm: number; readonly hazenWilliamsC: number; readonly manningN: number; readonly pressureClass: string } | null;
  readonly joint?: string | null;
  readonly takeoffs?: Readonly<Record<string, number>>;
  readonly lengthMm?: number | null;
  readonly hubRadii?: readonly number[];
  readonly meshVertices?: number;
  readonly meshSum?: number;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function sizeReading(size: Extract<RunSize, { shape: "pipe" }>): PipeReading {
  const p = specOfSize(size);
  return {
    dims: pipeDims(size),
    drawnMm: drawnWidth(size),
    sizeIssue: pipeSizeIssue(size),
    product: p ? { name: p.name, standard: p.standard, roughnessMm: p.roughnessMm, hazenWilliamsC: p.hazenWilliamsC, manningN: p.manningN, pressureClass: p.pressureClass } : null,
  };
}

function fittingSize(elements: Readonly<Record<string, BimElement>>, el: Extract<BimElement, { kind: "run_fitting" }>): RunSize | undefined {
  if (el.fittingType === "accessory" && el.host) {
    const host = elements[el.host.segmentId] as RunSegment | undefined;
    return host?.size;
  }
  return el.ports[0]?.size;
}

/** Every pipe segment's and pipe fitting's reading, by id, plus the model's issues. */
export function pipeReadings(model: ModelState): { readonly elements: Readonly<Record<string, PipeReading>>; readonly issues: readonly string[] } {
  const out: Record<string, PipeReading> = {};
  const ids = Object.keys(model.elements).sort();
  for (const id of ids) {
    const el = model.elements[id];
    if (!el) continue;
    if (el.kind === "run_segment" && el.size.shape === "pipe") out[id] = sizeReading(el.size);
    if (el.kind === "run_fitting" && el.domain === "pipe") {
      const family = el.family ? fittingFamily(el.family) : null;
      const body = fittingBody(model.elements, el);
      const mesh = fittingMesh(body);
      const takeoffs: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.takeoffs)) takeoffs[k] = r3(v);
      out[id] = {
        joint: family ? jointIssue(family, el.params ?? {}, fittingSize(model.elements, el)) : null,
        takeoffs,
        lengthMm: body.lengthMm === undefined ? null : r3(body.lengthMm),
        hubRadii: body.tubes.flatMap((t) => t.rings.map((r) => r3(Math.hypot(r.a.x, r.a.y, r.a.z)))),
        meshVertices: mesh.positions.length / 3,
        meshSum: r3(mesh.positions.reduce((s, v) => s + Math.abs(v), 0)),
      };
    }
  }
  const issues = validateModel(model)
    .map((i) => `${i.code} ${[...i.elementIds].sort().join(",")} ${i.message}`)
    .sort();
  return { elements: out, issues };
}
