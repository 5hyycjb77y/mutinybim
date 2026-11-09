/**
 * A small architect's model in FEET for hidden-line tests: one level, a slab,
 * two parallel walls 15 ft apart, a 6 x 3 ft table (top at 2'-6", four legs)
 * with a chair tucked under it, a second chair in the open, and a 3" cup on
 * the table. Furniture carries FootPrint plan symbols, as Revit exports write.
 *
 * Plan positions (ft): wall A y 0..0.5, x 0..30, 10 ft tall; wall B y 15..15.5, x 5..25, 8 ft tall;
 * table x 7..13, y 8.5..11.5; chair under it centred (10, 10.25); chair in the
 * open centred (20, 10.25); cup centred (12, 10).
 */

export const FURNITURE_FT = {
  table: { minX: 7, maxX: 13, minY: 8.5, maxY: 11.5, topZ: 2.5 },
  chairUnder: { cx: 10, cy: 10.25 },
  chairOpen: { cx: 20, cy: 10.25 },
  cup: { cx: 12, cy: 10 },
} as const;

interface Box {
  /** Box centre in plan and its bottom, ft. */
  readonly cx: number;
  readonly cy: number;
  readonly z0: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** grid > 1 repeats the table, both chairs and the cup on a grid of 30 x 20 ft rooms (the performance gate's large linked model). */
export function furnitureIfc(opts: { readonly grid?: number } = {}): string {
  const grid = Math.max(1, Math.floor(opts.grid ?? 1));
  const lines: string[] = [];
  let next = 100;
  const add = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const guid = (n: number) => `${n.toString(36).padStart(4, "0")}FurnitureFixture00000`.slice(0, 22);

  const p3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}))`);
  const p2 = (x: number, y: number) => add(`IFCCARTESIANPOINT((${x.toFixed(4)},${y.toFixed(4)}))`);
  const placementAt = (x: number, y: number, z: number) => add(`IFCAXIS2PLACEMENT3D(#${p3(x, y, z)},#11,#12)`);

  /** One extruded box in an element's own frame (the element sits at the origin of the storey). */
  const boxSolid = (b: Box) => {
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#42,${b.dx.toFixed(4)},${b.dy.toFixed(4)})`);
    return add(`IFCEXTRUDEDAREASOLID(#${profile},#${placementAt(b.cx, b.cy, b.z0)},#11,${b.dz.toFixed(4)})`);
  };

  /** A closed plan polyline as a FootPrint curve (points in the element's frame). */
  const footprint = (loops: ReadonlyArray<ReadonlyArray<readonly [number, number]>>) => {
    const curves = loops.map((pts) => add(`IFCPOLYLINE((${[...pts, pts[0] ?? [0, 0]].map(([x, y]) => `#${p2(x, y)}`).join(",")}))`));
    const set = add(`IFCGEOMETRICCURVESET((${curves.map((c) => `#${c}`).join(",")}))`);
    return add(`IFCSHAPEREPRESENTATION(#16,'FootPrint','GeometricCurveSet',(#${set}))`);
  };

  const rect = (x0: number, y0: number, x1: number, y1: number): Array<readonly [number, number]> => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  const contained: number[] = [];
  const element = (type: string, name: string, boxes: readonly Box[], symbol?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>) => {
    const body = add(`IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(${boxes.map((b) => `#${boxSolid(b)}`).join(",")}))`);
    const reps = [body, ...(symbol ? [footprint(symbol)] : [])];
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${reps.map((r) => `#${r}`).join(",")}))`);
    const local = add(`IFCLOCALPLACEMENT(#35,#13)`);
    const tail = type === "IFCWALL" ? ",.STANDARD.)" : type === "IFCSLAB" ? ",.FLOOR.)" : type === "IFCFURNITURE" ? ",$)" : ")";
    const id = add(`${type}('${guid(next)}',#5,'${name}',$,$,#${local},#${shape},$${tail}`);
    contained.push(id);
    return id;
  };

  element("IFCSLAB", "Floor", [{ cx: 15, cy: 10, z0: -0.5, dx: 30, dy: 20, dz: 0.5 }]);
  element("IFCWALL", "Wall A", [{ cx: 15, cy: 0.25, z0: 0, dx: 30, dy: 0.5, dz: 10 }]);
  element("IFCWALL", "Wall B", [{ cx: 15, cy: 15.25, z0: 0, dx: 20, dy: 0.5, dz: 8 }]);

  const room = (ox: number, oy: number, tag: string): void => {
      const t = { minX: FURNITURE_FT.table.minX + ox, maxX: FURNITURE_FT.table.maxX + ox, minY: FURNITURE_FT.table.minY + oy, maxY: FURNITURE_FT.table.maxY + oy, topZ: FURNITURE_FT.table.topZ };
      const tcx = (t.minX + t.maxX) / 2;
      const tcy = (t.minY + t.maxY) / 2;
      const legs = [
        [t.minX + 0.2, t.minY + 0.2],
        [t.maxX - 0.2, t.minY + 0.2],
        [t.maxX - 0.2, t.maxY - 0.2],
        [t.minX + 0.2, t.maxY - 0.2],
      ] as const;
      element(
        "IFCFURNITURE",
        `Table${tag}`,
        [{ cx: tcx, cy: tcy, z0: t.topZ - 0.1, dx: t.maxX - t.minX, dy: t.maxY - t.minY, dz: 0.1 }, ...legs.map(([x, y]) => ({ cx: x, cy: y, z0: 0, dx: 0.2, dy: 0.2, dz: t.topZ - 0.1 }))],
        [rect(t.minX, t.minY, t.maxX, t.maxY)],
      );

      const chair = (cx: number, cy: number, name: string) =>
        element(
          "IFCFURNITURE",
          name,
          [
            { cx, cy, z0: 1.35, dx: 1.5, dy: 1.5, dz: 0.15 },
            { cx, cy: cy - 0.675, z0: 1.5, dx: 1.5, dy: 0.15, dz: 0.8 },
            ...[
              [-0.6, -0.6],
              [0.6, -0.6],
              [0.6, 0.6],
              [-0.6, 0.6],
            ].map(([lx, ly]) => ({ cx: cx + (lx ?? 0), cy: cy + (ly ?? 0), z0: 0, dx: 0.15, dy: 0.15, dz: 1.35 })),
          ],
          [rect(cx - 0.75, cy - 0.75, cx + 0.75, cy + 0.75), rect(cx - 0.75, cy - 0.75, cx + 0.75, cy - 0.6)],
        );
      chair(FURNITURE_FT.chairUnder.cx + ox, FURNITURE_FT.chairUnder.cy + oy, `Chair under the table${tag}`);
      chair(FURNITURE_FT.chairOpen.cx + ox, FURNITURE_FT.chairOpen.cy + oy, `Chair in the open${tag}`);
      element("IFCFURNISHINGELEMENT", `Cup${tag}`, [{ cx: FURNITURE_FT.cup.cx + ox, cy: FURNITURE_FT.cup.cy + oy, z0: t.topZ, dx: 0.25, dy: 0.25, dz: 0.3 }]);
    };
  for (let gx = 0; gx < grid; gx++) {
    for (let gy = 0; gy < grid; gy++) {
      const ox = gx * 30;
      const oy = gy * 20;
      room(ox, oy, grid === 1 ? "" : ` ${gx}-${gy}`);
    }
  }

  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('8YvctVUKr0kugbFTf53O9L',#5,$,$,(${contained.map((c) => `#${c}`).join(",")}),#36)`);

  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('furniture.ifc','2026-10-22T00:00:00',('PermitZIP test'),('PermitZIP'),'hand-written','none','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'Test',$,$,$,$,$,$);
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
#16=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('FootPrint','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#25=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#26=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#20);
#27=IFCCONVERSIONBASEDUNIT(#25,.LENGTHUNIT.,'FOOT',#26);
#23=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#24=IFCUNITASSIGNMENT((#27,#23));
#30=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'Furniture fixture',$,$,$,$,(#14),#24);
#31=IFCLOCALPLACEMENT($,#13);
#32=IFCSITE('1YvctVUKr0kugbFTf53O9L',#5,'Site',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#33=IFCLOCALPLACEMENT(#31,#13);
#34=IFCBUILDING('2YvctVUKr0kugbFTf53O9L',#5,'Building',$,$,#33,$,$,.ELEMENT.,$,$,$);
#35=IFCLOCALPLACEMENT(#33,#13);
#36=IFCBUILDINGSTOREY('3YvctVUKr0kugbFTf53O9L',#5,'Level 1',$,$,#35,$,$,.ELEMENT.,0.);
#37=IFCRELAGGREGATES('4YvctVUKr0kugbFTf53O9L',#5,$,$,#30,(#32));
#38=IFCRELAGGREGATES('5YvctVUKr0kugbFTf53O9L',#5,$,$,#32,(#34));
#39=IFCRELAGGREGATES('6YvctVUKr0kugbFTf53O9L',#5,$,$,#34,(#36));
#40=IFCCARTESIANPOINT((0.,0.));
#41=IFCDIRECTION((1.,0.));
#42=IFCAXIS2PLACEMENT2D(#40,#41);
${lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
}
