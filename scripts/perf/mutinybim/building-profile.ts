/**
 * Synthetic buildings calibrated to a real one, without its data.
 *
 * A BuildingProfile is statistics only: floors, floor-to-floor height,
 * footprint, element counts per floor by IFC class, the linked IFC's size,
 * and how dense the authored MEP model is. No names, no geometry, no ids, so
 * a profile can be committed (and published with the open-source library)
 * while the client model it was measured on stays in private storage.
 *
 * - `extract-building-profile.ts` measures a profile from private IFC files
 *   on a laptop or in a private CI job (counts only leave the machine).
 * - `buildingIfc(profile)` writes a linked architect's IFC with those counts
 *   per storey (walls, doors, windows, columns, slab, rooms, furniture,
 *   anything else as boxes), cuttable by `cutIfcPlan` / `cutIfcSection`.
 * - `authoredOptions(profile)` sizes `createFullBimModel` for the MEP side.
 *
 *   node --import tsx scripts/perf/mutinybim/building-profile.ts --profile=fixtures/mutinybim/profiles/tower-14.json --out=.fixtures-cache/synthetic
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FullBimOptions } from "@permitzip/bim-first-party/seed";

export const buildingProfileSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "a neutral slug, never the client's project name"),
  note: z.string(),
  provenance: z.object({
    /** "provisional": estimated before the real model could be measured; "extracted": measured by extract-building-profile.ts. */
    stats: z.enum(["provisional", "extracted"]),
    measuredOn: z.string(),
    measuredAt: z.string(),
  }),
  floors: z.number().int().min(1).max(200),
  floorToFloorFt: z.number().positive().max(60),
  footprintFt: z.object({ x: z.number().positive().max(2000), y: z.number().positive().max(2000) }),
  linked: z.object({
    /** Elements per typical floor by IFC class (upper case, as the IFC writes it). */
    perFloor: z.record(z.string().regex(/^IFC[A-Z]+$/), z.number().int().min(0).max(100_000)),
    /** What the measured IFC weighed, to check the generated one lands near it. */
    ifcBytes: z.number().int().positive().optional(),
  }),
  authored: z.object({
    /** createFullBimModel zones per floor (each about 5,086 elements at default density). */
    zonesPerFloor: z.number().int().min(1).max(64),
    /** Elements the measured MEP model had, when known. */
    measuredElements: z.number().int().positive().optional(),
  }),
});
export type BuildingProfile = z.infer<typeof buildingProfileSchema>;

export function readBuildingProfile(file: string): BuildingProfile {
  return buildingProfileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function authoredOptions(profile: BuildingProfile, modelId = `synthetic-${profile.name}`): FullBimOptions {
  return { floors: profile.floors, zonesPerFloor: profile.authored.zonesPerFloor, modelId };
}

interface Box {
  readonly cx: number;
  readonly cy: number;
  readonly z0: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** Each class's IFC tail after Representation, and the box it gets on a floor. */
const CLASS_TAIL: Readonly<Record<string, string>> = {
  IFCWALL: "$,.STANDARD.)",
  IFCSLAB: "$,.FLOOR.)",
  IFCDOOR: "$,$,$,.DOOR.,$,$)",
  IFCWINDOW: "$,$,$,.WINDOW.,$,$)",
  IFCCOLUMN: "$,.COLUMN.)",
  IFCFURNITURE: "$,$)",
  IFCFURNISHINGELEMENT: "$)",
  IFCSPACE: "$,.ELEMENT.,.SPACE.,$)",
  IFCCOVERING: "$,.CEILING.)",
  IFCRAILING: "$,.HANDRAIL.)",
  IFCBEAM: "$,.BEAM.)",
  IFCMEMBER: "$,.MULLION.)",
  IFCPLATE: "$,.CURTAIN_PANEL.)",
  IFCSTAIRFLIGHT: "$,$,$,$,$,.STRAIGHT.)",
};

/** Deterministic numbers, so the same profile always writes the same file. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A box for the i-th of n elements of a class on one floor, inside the footprint. */
function boxFor(cls: string, i: number, n: number, fp: { x: number; y: number }, ftf: number, random: () => number): Box {
  const along = (i + 0.5) / Math.max(1, n);
  switch (cls) {
    case "IFCSLAB":
      return { cx: fp.x / 2, cy: fp.y / 2, z0: -1, dx: fp.x, dy: fp.y, dz: 1 };
    case "IFCWALL": {
      // A quarter on the perimeter, the rest an interior grid alternating directions.
      const lenFt = 12 + random() * 18;
      if (i % 4 === 0) {
        const t = along * 2 * (fp.x + fp.y);
        if (t < fp.x) return { cx: t, cy: 0.5, z0: 0, dx: lenFt, dy: 1, dz: ftf - 1 };
        if (t < fp.x + fp.y) return { cx: fp.x - 0.5, cy: t - fp.x, z0: 0, dx: 1, dy: lenFt, dz: ftf - 1 };
        if (t < 2 * fp.x + fp.y) return { cx: 2 * fp.x + fp.y - t, cy: fp.y - 0.5, z0: 0, dx: lenFt, dy: 1, dz: ftf - 1 };
        return { cx: 0.5, cy: 2 * (fp.x + fp.y) - t, z0: 0, dx: 1, dy: lenFt, dz: ftf - 1 };
      }
      const x = 5 + random() * (fp.x - 10);
      const y = 5 + random() * (fp.y - 10);
      return i % 2 === 0 ? { cx: x, cy: y, z0: 0, dx: lenFt, dy: 0.5, dz: ftf - 1 } : { cx: x, cy: y, z0: 0, dx: 0.5, dy: lenFt, dz: ftf - 1 };
    }
    case "IFCWINDOW": {
      const t = along * 2 * (fp.x + fp.y);
      const onX = t < fp.x || (t >= fp.x + fp.y && t < 2 * fp.x + fp.y);
      const cx = t < fp.x ? t : t < fp.x + fp.y ? fp.x - 0.5 : t < 2 * fp.x + fp.y ? 2 * fp.x + fp.y - t : 0.5;
      const cy = t < fp.x ? 0.5 : t < fp.x + fp.y ? t - fp.x : t < 2 * fp.x + fp.y ? fp.y - 0.5 : 2 * (fp.x + fp.y) - t;
      return { cx, cy, z0: 3, dx: onX ? 4 : 0.6, dy: onX ? 0.6 : 4, dz: 5 };
    }
    case "IFCDOOR":
      return { cx: 5 + random() * (fp.x - 10), cy: 5 + random() * (fp.y - 10), z0: 0, dx: 3, dy: 0.6, dz: 7 };
    case "IFCCOLUMN": {
      const cols = Math.max(1, Math.round(Math.sqrt((n * fp.x) / fp.y)));
      const rows = Math.max(1, Math.ceil(n / cols));
      return { cx: ((i % cols) + 0.5) * (fp.x / cols), cy: (Math.floor(i / cols) + 0.5) * (fp.y / rows), z0: 0, dx: 1.5, dy: 1.5, dz: ftf - 1 };
    }
    case "IFCSPACE": {
      const cols = Math.max(1, Math.round(Math.sqrt((n * fp.x) / fp.y)));
      const rows = Math.max(1, Math.ceil(n / cols));
      const w = fp.x / cols;
      const d = fp.y / rows;
      return { cx: ((i % cols) + 0.5) * w, cy: (Math.floor(i / cols) + 0.5) * d, z0: 0, dx: w * 0.9, dy: d * 0.9, dz: ftf - 2 };
    }
    case "IFCCOVERING":
      return { cx: 5 + random() * (fp.x - 10), cy: 5 + random() * (fp.y - 10), z0: ftf - 2, dx: 10, dy: 10, dz: 0.1 };
    default: {
      // Furniture and everything else: a piece 1-6 ft across somewhere on the floor.
      const s = 1 + random() * 5;
      return { cx: 3 + random() * (fp.x - 6), cy: 3 + random() * (fp.y - 6), z0: 0, dx: s, dy: s * (0.5 + random()), dz: 1 + random() * 3 };
    }
  }
}

export interface GeneratedIfc {
  readonly text: string;
  readonly elements: number;
  readonly perStorey: number;
  readonly storeys: readonly { readonly name: string; readonly elevationFt: number }[];
}

/**
 * A linked architect's IFC (feet) with `profile.linked.perFloor` on every
 * storey. `scale` < 1 keeps the shape at a fraction of the counts (tests).
 */
export function buildingIfc(profile: BuildingProfile, opts: { readonly scale?: number; readonly floors?: number } = {}): GeneratedIfc {
  const scale = opts.scale ?? 1;
  const floors = Math.min(profile.floors, opts.floors ?? profile.floors);
  const fp = profile.footprintFt;
  const ftf = profile.floorToFloorFt;
  const random = rng(profile.name.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const lines: string[] = [];
  let next = 100;
  const add = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const guid = (n: number) => `${n.toString(36).padStart(8, "0")}SyntheticTower00000000`.slice(0, 22);
  const num = (v: number) => v.toFixed(3);
  const p3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const placementAt = (x: number, y: number, z: number) => add(`IFCAXIS2PLACEMENT3D(#${p3(x, y, z)},#11,#12)`);
  const boxSolid = (b: Box) => {
    const profileId = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#42,${num(b.dx)},${num(b.dy)})`);
    return add(`IFCEXTRUDEDAREASOLID(#${profileId},#${placementAt(b.cx, b.cy, b.z0)},#11,${num(b.dz)})`);
  };

  const storeys: Array<{ name: string; elevationFt: number }> = [];
  const storeyIds: number[] = [];
  let elements = 0;
  let perStorey = 0;
  for (let f = 0; f < floors; f++) {
    const elevationFt = f * ftf;
    const name = `Level ${f + 1}`;
    storeys.push({ name, elevationFt });
    const storeyPlacement = add(`IFCLOCALPLACEMENT(#33,#${placementAt(0, 0, elevationFt)})`);
    const storey = add(`IFCBUILDINGSTOREY('${guid(next)}',#5,'${name}',$,$,#${storeyPlacement},$,$,.ELEMENT.,${num(elevationFt)})`);
    storeyIds.push(storey);
    const contained: number[] = [];
    for (const [cls, count] of Object.entries(profile.linked.perFloor)) {
      const n = cls === "IFCSLAB" ? count : Math.max(0, Math.round(count * scale));
      const known = cls in CLASS_TAIL;
      const ifcClass = known ? cls : "IFCBUILDINGELEMENTPROXY";
      const tail = known ? (CLASS_TAIL[cls] ?? "$)") : "$,.ELEMENT.)";
      for (let i = 0; i < n; i++) {
        const body = add(`IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${boxSolid(boxFor(cls, i, n, fp, ftf, random))}))`);
        const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${body}))`);
        const local = add(`IFCLOCALPLACEMENT(#${storeyPlacement},#13)`);
        contained.push(add(`${ifcClass}('${guid(next)}',#5,'${cls.slice(3).toLowerCase()} ${f + 1}-${i + 1}',$,$,#${local},#${shape},${tail}`));
      }
    }
    elements += contained.length;
    perStorey = contained.length;
    if (contained.length > 0) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(next)}',#5,$,$,(${contained.map((c) => `#${c}`).join(",")}),#${storey})`);
  }
  add(`IFCRELAGGREGATES('${guid(next)}',#5,$,$,#34,(${storeyIds.map((s) => `#${s}`).join(",")}))`);

  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('${profile.name}.ifc','2026-10-22T00:00:00',('PermitZIP perf'),('PermitZIP'),'building-profile.ts','none','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'Perf',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'PermitZIP',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','Synthetic','SYN');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#15=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#25=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#26=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#20);
#27=IFCCONVERSIONBASEDUNIT(#25,.LENGTHUNIT.,'FOOT',#26);
#23=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#24=IFCUNITASSIGNMENT((#27,#23));
#30=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'${profile.name}',$,$,$,$,(#14),#24);
#31=IFCLOCALPLACEMENT($,#13);
#32=IFCSITE('1YvctVUKr0kugbFTf53O9L',#5,'Site',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#33=IFCLOCALPLACEMENT(#31,#13);
#34=IFCBUILDING('2YvctVUKr0kugbFTf53O9L',#5,'Building',$,$,#33,$,$,.ELEMENT.,$,$,$);
#37=IFCRELAGGREGATES('4YvctVUKr0kugbFTf53O9L',#5,$,$,#30,(#32));
#38=IFCRELAGGREGATES('5YvctVUKr0kugbFTf53O9L',#5,$,$,#32,(#34));
#40=IFCCARTESIANPOINT((0.,0.));
#41=IFCDIRECTION((1.,0.));
#42=IFCAXIS2PLACEMENT2D(#40,#41);
${lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
  return { text, elements, perStorey, storeys };
}

async function main(): Promise<void> {
  const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
  const profileFile = arg("profile", "fixtures/mutinybim/profiles/tower-14.json");
  const outDir = arg("out", ".fixtures-cache/synthetic");
  const profile = readBuildingProfile(profileFile);
  const ifc = buildingIfc(profile);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${profile.name}.ifc`);
  writeFileSync(file, ifc.text);
  const bytes = Buffer.byteLength(ifc.text);
  const target = profile.linked.ifcBytes;
  console.log(
    `[building-profile] ${file}: ${profile.floors} storeys, ${ifc.perStorey} elements per storey, ${ifc.elements} total, ${(bytes / 1e6).toFixed(1)} MB` +
      (target ? ` (measured model ${(target / 1e6).toFixed(1)} MB)` : "") +
      `; authored MEP: createFullBimModel ${JSON.stringify(authoredOptions(profile))} (~${profile.floors * profile.authored.zonesPerFloor * 5086} elements)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error("[building-profile] failed", err);
    process.exit(1);
  });
}
