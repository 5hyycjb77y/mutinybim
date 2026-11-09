/**
 * ifc.import.* — open a linked IFC model as a branch (round 9 I9).
 *
 *   node --import tsx scripts/perf/mutinybim/ifc-import.ts [--elements=250000] [--samples=3]
 *
 * Writes a synthetic IFC4 file (no client data) of `elements` products on
 * 14 storeys: straight walls, rooms, columns and rectangular segments of a
 * supply system in fixed proportions, each its own placement and extrusion,
 * profiles shared, the way exporters write them. Then measures:
 *
 *   ifc.import.convert       read the STEP text into products + plan what converts (the model server's worker thread)
 *   ifc.import.read          the read alone
 *   ifc.import.plan          the plan alone
 *   ifc.import.apply.2k      land one 2,000-record chunk on the branch (kernel landing, in process)
 *   ifc.import.peak_heap_mb  heap after the read (the worker's limit is 2,048 MB)
 */
import { DEFAULT_SETTINGS, asElementId, asRevision, landImportChunk, planIfcImport, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { readIfcSource } from "@permitzip/bim-ifc";
import { emit, gc, memoryMB } from "./lib";

const args = process.argv.slice(2);
const N = Number(args.find((a) => a.startsWith("--elements="))?.split("=")[1] ?? 250_000);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 3);
const STOREYS = 14;

function syntheticIfc(n: number): string {
  const lines: string[] = [];
  let id = 0;
  let g = 0;
  const add = (type: string, a: string) => {
    lines.push(`#${++id}=${type}(${a});`);
    return id;
  };
  const guid = () => `'${(g++).toString(36).toUpperCase().padStart(22, "0")}'`;
  const unit = add("IFCSIUNIT", "*,.LENGTHUNIT.,.MILLI.,.METRE.");
  const units = add("IFCUNITASSIGNMENT", `(#${unit})`);
  const origin = add("IFCCARTESIANPOINT", "(0.,0.,0.)");
  const world = add("IFCAXIS2PLACEMENT3D", `#${origin},$,$`);
  const ctx = add("IFCGEOMETRICREPRESENTATIONCONTEXT", `$,'Model',3,1.E-05,#${world},$`);
  const project = add("IFCPROJECT", `${guid()},$,'Perf',$,$,$,$,(#${ctx}),#${units}`);
  const up = add("IFCDIRECTION", "(0.,0.,1.)");
  const east = add("IFCDIRECTION", "(1.,0.,0.)");
  const north = add("IFCDIRECTION", "(0.,1.,0.)");
  const p2 = add("IFCAXIS2PLACEMENT2D", `#${add("IFCCARTESIANPOINT", "(0.,0.)")},$`);
  const p2w = add("IFCAXIS2PLACEMENT2D", `#${add("IFCCARTESIANPOINT", "(2000.,0.)")},$`);
  const wallProfile = add("IFCRECTANGLEPROFILEDEF", `.AREA.,$,#${p2w},4000.,200.`);
  const roomProfile = add("IFCRECTANGLEPROFILEDEF", `.AREA.,$,#${p2},3800.,3800.`);
  const columnProfile = add("IFCRECTANGLEPROFILEDEF", `.AREA.,$,#${p2},400.,400.`);
  const segProfile = add("IFCRECTANGLEPROFILEDEF", `.AREA.,$,#${p2},400.,300.`);
  const alongX = add("IFCAXIS2PLACEMENT3D", `#${origin},#${east},#${north}`);
  const system = add("IFCDISTRIBUTIONSYSTEM", `${guid()},$,'Supply Air 1',$,$,$,.AIRCONDITIONING.`);
  const storeyIds: number[] = [];
  const storeyPlace: number[] = [];
  for (let s = 0; s < STOREYS; s++) {
    const pt = add("IFCCARTESIANPOINT", `(0.,0.,${s * 4000}.)`);
    const pl = add("IFCLOCALPLACEMENT", `$,#${add("IFCAXIS2PLACEMENT3D", `#${pt},$,$`)}`);
    storeyPlace.push(pl);
    storeyIds.push(add("IFCBUILDINGSTOREY", `${guid()},$,'Level ${s + 1}',$,$,#${pl},$,$,.ELEMENT.,${s * 4000}.`));
  }
  const contained: number[][] = storeyIds.map(() => []);
  const segments: number[] = [];
  const per = Math.ceil(n / STOREYS);
  for (let i = 0; i < n; i++) {
    const s = Math.min(STOREYS - 1, Math.floor(i / per));
    const k = i % per;
    const x = (k % 100) * 4000;
    const y = Math.floor(k / 100) * 4000;
    const at = add("IFCCARTESIANPOINT", `(${x}.,${y}.,0.)`);
    const place = add("IFCLOCALPLACEMENT", `#${storeyPlace[s]},#${add("IFCAXIS2PLACEMENT3D", `#${at},$,$`)}`);
    const kind = i % 10;
    let shapeItem: number;
    let product: number;
    if (kind < 5) {
      shapeItem = add("IFCEXTRUDEDAREASOLID", `#${wallProfile},$,#${up},3000.`);
      product = add("IFCWALL", `${guid()},$,'W${i}',$,$,#${place},#${add("IFCPRODUCTDEFINITIONSHAPE", `$,$,(#${add("IFCSHAPEREPRESENTATION", `#${ctx},'Body','SweptSolid',(#${shapeItem})`)})`)},$,.STANDARD.`);
    } else if (kind < 7) {
      shapeItem = add("IFCEXTRUDEDAREASOLID", `#${roomProfile},$,#${up},2800.`);
      product = add("IFCSPACE", `${guid()},$,'${i}',$,$,#${place},#${add("IFCPRODUCTDEFINITIONSHAPE", `$,$,(#${add("IFCSHAPEREPRESENTATION", `#${ctx},'Body','SweptSolid',(#${shapeItem})`)})`)},'Room',.ELEMENT.,.INTERNAL.,$`);
    } else if (kind < 8) {
      shapeItem = add("IFCEXTRUDEDAREASOLID", `#${columnProfile},$,#${up},3000.`);
      product = add("IFCCOLUMN", `${guid()},$,'C${i}',$,$,#${place},#${add("IFCPRODUCTDEFINITIONSHAPE", `$,$,(#${add("IFCSHAPEREPRESENTATION", `#${ctx},'Body','SweptSolid',(#${shapeItem})`)})`)},$,.COLUMN.`);
    } else {
      shapeItem = add("IFCEXTRUDEDAREASOLID", `#${segProfile},#${alongX},#${up},3000.`);
      product = add("IFCDUCTSEGMENT", `${guid()},$,'S${i}',$,$,#${place},#${add("IFCPRODUCTDEFINITIONSHAPE", `$,$,(#${add("IFCSHAPEREPRESENTATION", `#${ctx},'Body','SweptSolid',(#${shapeItem})`)})`)},$,.RIGIDSEGMENT.`);
      segments.push(product);
    }
    contained[s]?.push(product);
  }
  for (const [s, ids] of contained.entries()) add("IFCRELCONTAINEDINSPATIALSTRUCTURE", `${guid()},$,$,$,(${ids.map((i) => `#${i}`).join(",")}),#${storeyIds[s]}`);
  add("IFCRELAGGREGATES", `${guid()},$,$,$,#${project},(${storeyIds.map((i) => `#${i}`).join(",")})`);
  add("IFCRELASSIGNSTOGROUP", `${guid()},$,$,$,(${segments.map((i) => `#${i}`).join(",")}),$,#${system}`);
  return ["ISO-10303-21;", "HEADER;", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;", ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
}

function host(): ModelState {
  const elements: Record<string, BimElement> = {};
  for (let s = 0; s < STOREYS; s++) elements[`L${s + 1}`] = { id: asElementId(`L${s + 1}`), kind: "level", version: 1, authoredRev: {}, name: `Level ${s + 1}`, elevationMm: s * 4000 };
  return { modelId: "perf-ifc-host", revision: asRevision(1), elements, connections: [], settings: DEFAULT_SETTINGS };
}

const text = syntheticIfc(N);
const bytes = Buffer.byteLength(text);
process.stderr.write(`[ifc-import] ${N.toLocaleString()} products, ${(bytes / 1e6).toFixed(1)} MB of STEP text\n`);
const read: number[] = [];
const plan: number[] = [];
const convert: number[] = [];
const apply: number[] = [];
const heap: number[] = [];
let converted = 0;
for (let i = 0; i < samples; i++) {
  gc();
  const t0 = performance.now();
  const source = readIfcSource(text, { sourceId: "perf-ver", label: "Perf model", disciplines: ["architecture", "mechanical"] });
  const t1 = performance.now();
  heap.push(memoryMB().heap);
  const planned = planIfcImport(source, { model: host(), referenceId: "perf-ref", sourceKey: "perf" });
  const t2 = performance.now();
  read.push(t1 - t0);
  plan.push(t2 - t1);
  convert.push(t2 - t0);
  converted = planned.report.converted;
  // One 2,000-record chunk landed on a branch that already holds the chunks before it (the middle of an import).
  let model = host();
  const chunk = 2000;
  const before = planned.records.slice(0, chunk * 3);
  for (let c = 0; c < before.length; c += chunk) {
    const r = landImportChunk(model, before.slice(c, c + chunk));
    if (!r.ok) throw new Error(r.error.message);
    model = r.model;
  }
  const next = planned.records.slice(chunk * 3, chunk * 4);
  const t3 = performance.now();
  const landed = landImportChunk(model, next);
  apply.push(performance.now() - t3);
  if (!landed.ok) throw new Error(landed.error.message);
}

const pct = (xs: readonly number[], p: number) => Math.round(([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0) * 10) / 10;
const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(`${JSON.stringify({ suite: "ifc-import", elements: N, mb: Math.round(bytes / 1e5) / 10, converted, metrics: { "ifc.import.convert": row(convert), "ifc.import.read": row(read), "ifc.import.plan": row(plan), "ifc.import.apply.2k": row(apply), "ifc.import.peak_heap_mb": row(heap) } }, null, 2)}\n`);
emit({
  suite: "batch",
  workload: { elements: N, storeys: STOREYS, megabytes: Math.round(bytes / 1e5) / 10, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { converted },
  samples: [
    { metric: "ifc.import.convert", values: convert, counts: { totalElements: N, affectedElements: converted }, note: "Read the STEP text and plan what converts." },
    { metric: "ifc.import.apply.2k", values: apply, counts: { totalElements: N, affectedElements: 2000 }, note: "Land one 2,000-record chunk on the branch." },
  ],
});
