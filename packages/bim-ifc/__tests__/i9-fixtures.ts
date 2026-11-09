import { DEFAULT_SETTINGS, asElementId, asRevision, type ModelState } from "@permitzip/bim-kernel";

/**
 * Synthetic IFC4 linked models for the I9 tests, written by hand as STEP
 * text (no client data, no vendor file): one architecture + structure model
 * (two disciplines from one firm) and one mechanical + fire-sprinkler model
 * with segments, terminals and systems. Millimetre units unless a test asks
 * for feet.
 */

const g = (n: number): string => `'${n.toString(36).toUpperCase().padStart(22, "0")}'`;

export class IfcText {
  private readonly lines: string[] = [];
  private gid = 1;

  add(type: string, args: string): number {
    this.lines.push(`#${this.lines.length + 1}=${type}(${args});`);
    return this.lines.length;
  }

  guid(): string {
    return g(this.gid++);
  }

  pt(x: number, y: number, z?: number): number {
    return this.add("IFCCARTESIANPOINT", z === undefined ? `(${f(x)},${f(y)})` : `(${f(x)},${f(y)},${f(z)})`);
  }

  dir(x: number, y: number, z?: number): number {
    return this.add("IFCDIRECTION", z === undefined ? `(${f(x)},${f(y)})` : `(${f(x)},${f(y)},${f(z)})`);
  }

  axis3(at: readonly [number, number, number], z?: readonly [number, number, number], x?: readonly [number, number, number]): number {
    const p = this.pt(...at);
    const zz = z ? `#${this.dir(...z)}` : "$";
    const xx = x ? `#${this.dir(...x)}` : "$";
    return this.add("IFCAXIS2PLACEMENT3D", `#${p},${zz},${xx}`);
  }

  axis2(at: readonly [number, number], x?: readonly [number, number]): number {
    const p = this.pt(...at);
    return this.add("IFCAXIS2PLACEMENT2D", `#${p},${x ? `#${this.dir(...x)}` : "$"}`);
  }

  place(rel: number | null, axis: number): number {
    return this.add("IFCLOCALPLACEMENT", `${rel ? `#${rel}` : "$"},#${axis}`);
  }

  body(items: readonly number[], id = "Body", kind = "SweptSolid"): number {
    const rep = this.add("IFCSHAPEREPRESENTATION", `#${this.context},'${id}','${kind}',(${items.map((i) => `#${i}`).join(",")})`);
    return this.add("IFCPRODUCTDEFINITIONSHAPE", `$,$,(#${rep})`);
  }

  rect(x: number, y: number, at: readonly [number, number] = [0, 0], dirX?: readonly [number, number]): number {
    return this.add("IFCRECTANGLEPROFILEDEF", `.AREA.,$,#${this.axis2(at, dirX)},${f(x)},${f(y)}`);
  }

  circle(r: number): number {
    return this.add("IFCCIRCLEPROFILEDEF", `.AREA.,$,#${this.axis2([0, 0])},${f(r)}`);
  }

  polygon(points: readonly (readonly [number, number])[]): number {
    const ids = [...points, points[0] ?? [0, 0]].map(([x, y]) => `#${this.pt(x, y)}`);
    const line = this.add("IFCPOLYLINE", `(${ids.join(",")})`);
    return this.add("IFCARBITRARYCLOSEDPROFILEDEF", `.AREA.,$,#${line}`);
  }

  extrude(profile: number, depth: number, position: number | null = null, along: readonly [number, number, number] = [0, 0, 1]): number {
    return this.add("IFCEXTRUDEDAREASOLID", `#${profile},${position ? `#${position}` : "$"},#${this.dir(...along)},${f(depth)}`);
  }

  context = 0;
  project = 0;
  storeyPlacements = new Map<string, number>();
  storeys = new Map<string, number>();
  contained = new Map<number, number[]>();

  text(): string {
    const rels: string[] = [];
    for (const [storey, ids] of this.contained) this.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", `${this.guid()},$,$,$,(${ids.map((i) => `#${i}`).join(",")}),#${storey}`);
    return ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');", "FILE_NAME('i9.ifc','2026-11-01T12:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;", ...this.lines, ...rels, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
  }

  static start(units: "mm" | "ft" = "mm"): IfcText {
    const t = new IfcText();
    const unit =
      units === "mm"
        ? t.add("IFCSIUNIT", "*,.LENGTHUNIT.,.MILLI.,.METRE.")
        : t.add("IFCCONVERSIONBASEDUNIT", `#${t.add("IFCDIMENSIONALEXPONENTS", "1,0,0,0,0,0,0")},.LENGTHUNIT.,'FOOT',#${t.add("IFCMEASUREWITHUNIT", `IFCLENGTHMEASURE(0.3048),#${t.add("IFCSIUNIT", "*,.LENGTHUNIT.,$,.METRE.")}`)}`);
    const units_ = t.add("IFCUNITASSIGNMENT", `(#${unit})`);
    t.context = t.add("IFCGEOMETRICREPRESENTATIONCONTEXT", `$,'Model',3,1.E-05,#${t.axis3([0, 0, 0])},$`);
    t.project = t.add("IFCPROJECT", `${t.guid()},$,'Synthetic',$,$,$,$,(#${t.context}),#${units_}`);
    return t;
  }

  storey(name: string, elevation: number): number {
    const p = this.place(null, this.axis3([0, 0, elevation]));
    const s = this.add("IFCBUILDINGSTOREY", `${this.guid()},$,'${name}',$,$,#${p},$,$,.ELEMENT.,${f(elevation)}`);
    this.storeyPlacements.set(name, p);
    this.storeys.set(name, s);
    this.add("IFCRELAGGREGATES", `${this.guid()},$,$,$,#${this.project},(#${s})`);
    return s;
  }

  /** A product placed in a storey: `entity(GlobalId,$,Name,$,ObjectType,placement,shape,Tag,...rest)`. */
  product(storey: string, entity: string, name: string, at: readonly [number, number, number], shape: number | null, rest = "", opts: { tag?: string; objectType?: string; axis?: readonly [number, number, number] } = {}): number {
    const rel = this.storeyPlacements.get(storey) ?? null;
    const p = this.place(rel, this.axis3(at, undefined, opts.axis));
    const head = `${this.guid()},$,'${name}',$,${opts.objectType ? `'${opts.objectType}'` : "$"},#${p},${shape ? `#${shape}` : "$"},${opts.tag ? `'${opts.tag}'` : "$"}`;
    const id = this.add(entity, rest ? `${head},${rest}` : head);
    const s = this.storeys.get(storey);
    if (s) this.contained.set(s, [...(this.contained.get(s) ?? []), id]);
    return id;
  }

  /** A straight wall of `thickness` from `start` along +x for `length`, `height` tall (footprint rectangle centred on the axis). */
  wall(storey: string, name: string, start: readonly [number, number], length: number, thickness: number, height: number, angleDeg = 0): number {
    const a = (angleDeg * Math.PI) / 180;
    const shape = this.body([this.extrude(this.rect(length, thickness, [length / 2, 0]), height)]);
    return this.product(storey, "IFCWALL", name, [start[0], start[1], 0], shape, ".STANDARD.", { axis: [Math.cos(a), Math.sin(a), 0] });
  }

  /** A door filling an opening in `wallId`, centred `along` the wall from its start. */
  door(storey: string, wallId: number, wallStart: readonly [number, number], along: number, width: number, height: number, mark: string): number {
    const openingShape = this.body([this.extrude(this.rect(width, 400), height)]);
    const opening = this.add("IFCOPENINGELEMENT", `${this.guid()},$,'Opening',$,$,#${this.place(this.storeyPlacements.get(storey) ?? null, this.axis3([wallStart[0] + along, wallStart[1], 0]))},#${openingShape},$,.OPENING.`);
    this.add("IFCRELVOIDSELEMENT", `${this.guid()},$,$,$,#${wallId},#${opening}`);
    const doorShape = this.body([this.extrude(this.rect(width, 50), height)]);
    const door = this.product(storey, "IFCDOOR", "Door", [wallStart[0] + along, wallStart[1], 0], doorShape, `${f(height)},${f(width)},.DOOR.,.SINGLE_SWING_LEFT.,$`, { tag: mark });
    this.add("IFCRELFILLSELEMENT", `${this.guid()},$,$,$,#${opening},#${door}`);
    return door;
  }

  system(name: string, predefined: string): number {
    return this.add("IFCDISTRIBUTIONSYSTEM", `${this.guid()},$,'${name}',$,$,$,.${predefined}.`);
  }

  assign(system: number, members: readonly number[]): void {
    this.add("IFCRELASSIGNSTOGROUP", `${this.guid()},$,$,$,(${members.map((m) => `#${m}`).join(",")}),$,#${system}`);
  }

  type(entity: string, name: string, products: readonly number[], predefined = "NOTDEFINED"): number {
    const t = this.add(entity, `${this.guid()},$,'${name}',$,$,$,$,$,$,.${predefined}.`);
    this.add("IFCRELDEFINESBYTYPE", `${this.guid()},$,$,$,(${products.map((p) => `#${p}`).join(",")}),#${t}`);
    return t;
  }

  pset(name: string, products: readonly number[], props: Readonly<Record<string, string | boolean>>): void {
    const ids = Object.entries(props).map(([k, v]) => `#${this.add("IFCPROPERTYSINGLEVALUE", `'${k}',$,${typeof v === "boolean" ? `IFCBOOLEAN(.${v ? "T" : "F"}.)` : `IFCLABEL('${v}')`},$`)}`);
    const set = this.add("IFCPROPERTYSET", `${this.guid()},$,'${name}',$,(${ids.join(",")})`);
    this.add("IFCRELDEFINESBYPROPERTIES", `${this.guid()},$,$,$,(${products.map((p) => `#${p}`).join(",")}),#${set}`);
  }
}

function f(n: number): string {
  return Number.isInteger(n) ? `${n}.` : String(n);
}

/** Architecture and structure in one file: walls, a door, a room, a slab, a column, a beam, a roof and a stair (stay linked), a curtain wall with no shape. */
export function architectureAndStructure(units: "mm" | "ft" = "mm"): { readonly text: string } {
  const k = units === "ft" ? 1 / 304.8 : 1;
  const t = IfcText.start(units);
  t.storey("Level 1", 0);
  t.storey("Level 2", 3500 * k);
  const w1 = t.wall("Level 1", "Wall A", [0, 0], 6000 * k, 200 * k, 3000 * k);
  t.wall("Level 1", "Wall B", [6000 * k, 0], 5000 * k, 200 * k, 3000 * k, 90);
  t.pset("Pset_WallCommon", [w1], { FireRating: "1 HR", IsExternal: true });
  t.type("IFCWALLTYPE", "Interior 200", [w1], "STANDARD");
  t.door("Level 1", w1, [0, 0], 1500 * k, 900 * k, 2100 * k, "D-101");
  t.product("Level 1", "IFCSPACE", "101", [0, 0, 0], t.body([t.extrude(t.polygon([[0, 0], [4000 * k, 0], [4000 * k, 3000 * k], [0, 3000 * k]]), 2800 * k)]), ".ELEMENT.,.INTERNAL.,$", { tag: "Office" });
  t.product("Level 1", "IFCSLAB", "Floor", [0, 0, -250 * k], t.body([t.extrude(t.polygon([[0, 0], [6000 * k, 0], [6000 * k, 5000 * k], [0, 5000 * k]]), 250 * k)]), ".FLOOR.");
  t.product("Level 1", "IFCCOLUMN", "C1", [3000 * k, 2500 * k, 0], t.body([t.extrude(t.rect(400 * k, 400 * k), 3000 * k)]), ".COLUMN.");
  t.product("Level 2", "IFCBEAM", "B1", [0, 2500 * k, -500 * k], t.body([t.extrude(t.rect(300 * k, 500 * k), 6000 * k, t.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0]))]), ".BEAM.");
  t.product("Level 2", "IFCROOF", "Roof", [0, 0, 3000 * k], t.body([t.extrude(t.polygon([[0, 0], [6000 * k, 0], [6000 * k, 5000 * k], [0, 5000 * k]]), 200 * k, null, [0.2, 0, 1])]), ".FLAT_ROOF.");
  t.product("Level 1", "IFCSTAIR", "Stair", [5000 * k, 4000 * k, 0], t.body([t.extrude(t.rect(1000 * k, 3000 * k), 3500 * k)]), ".STRAIGHT_RUN_STAIR.");
  t.product("Level 1", "IFCCURTAINWALL", "Storefront", [0, 5000 * k, 0], null, ".NOTDEFINED.");
  return { text: t.text() };
}

/**
 * Mechanical and fire sprinkler in one file: a supply system with a
 * rectangular and a round segment, an air terminal (a box) of a type, and
 * a wet sprinkler system with a pipe segment and two heads.
 */
export function mechanicalAndSprinkler(): { readonly text: string; readonly headName: string } {
  const t = IfcText.start("mm");
  t.storey("Level 1", 0);
  const supply = t.system("Supply Air 1", "AIRCONDITIONING");
  const rectSeg = t.product("Level 1", "IFCDUCTSEGMENT", "Duct 1", [0, 1000, 2800], t.body([t.extrude(t.rect(400, 300), 5000, t.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0]))]), ".RIGIDSEGMENT.");
  const roundSeg = t.product("Level 1", "IFCDUCTSEGMENT", "Duct 2", [5000, 1000, 2800], t.body([t.extrude(t.circle(150), 3000, t.axis3([0, 0, 0], [0, 1, 0], [1, 0, 0]))]), ".RIGIDSEGMENT.");
  const terminal = t.product("Level 1", "IFCAIRTERMINAL", "Diffuser", [5000, 4000, 2700], t.body([t.extrude(t.rect(600, 600), 300)]), ".DIFFUSER.", { tag: "SD-1" });
  t.type("IFCAIRTERMINALTYPE", "Square diffuser 600", [terminal], "DIFFUSER");
  t.assign(supply, [rectSeg, roundSeg, terminal]);
  const wet = t.system("Wet sprinkler", "FIREPROTECTION");
  const pipe = t.product("Level 1", "IFCPIPESEGMENT", "Branch line", [0, 3000, 3000], t.body([t.extrude(t.circle(25), 6000, t.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0]))]), ".RIGIDSEGMENT.");
  const h1 = t.product("Level 1", "IFCFIRESUPPRESSIONTERMINAL", "Pendent head", [1500, 3000, 2950], t.body([t.extrude(t.circle(30), 50)]), ".SPRINKLER.", { tag: "SP-1" });
  const h2 = t.product("Level 1", "IFCFIRESUPPRESSIONTERMINAL", "Pendent head", [4500, 3000, 2950], t.body([t.extrude(t.circle(30), 50)]), ".SPRINKLER.", { tag: "SP-2" });
  t.assign(wet, [pipe, h1, h2]);
  return { text: t.text(), headName: "Pendent head" };
}

/** An empty host model with one level at 0 named like the file's first storey. */
export function hostModel(levels: readonly { readonly id: string; readonly name: string; readonly elevationMm: number }[] = [{ id: "L1", name: "Level 1", elevationMm: 0 }]): ModelState {
  const elements = Object.fromEntries(levels.map((l) => [l.id, { id: asElementId(l.id), kind: "level" as const, version: 1, authoredRev: {}, name: l.name, elevationMm: l.elevationMm }]));
  return { modelId: "i9-host", revision: asRevision(1), elements, connections: [], settings: DEFAULT_SETTINGS };
}
