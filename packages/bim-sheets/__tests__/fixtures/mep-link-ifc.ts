/**
 * A small synthetic linked MEP model in FEET, the shape a Revit MEP export
 * has: storeys LEVEL 01 (0 ft), ROOF LOW POINT (14 ft) and ROOF HIGH POINT
 * (16 ft); on LEVEL 01 a slab, a 10 ft wall, a duct run at 9 ft with an elbow,
 * a diffuser under it, a ceiling at 9'-6", a pipe at 2 ft; on the roof a
 * rooftop unit standing 14 to 18 ft. No client data: every name and size is
 * made up.
 *
 * Plan positions (ft): wall y 0..0.5, x 0..30; duct y 9..11, x 2..20; elbow
 * x 20..22, y 9..11; diffuser x 10..12, y 12..14; ceiling x 0..30, y 0..20;
 * pipe y 4..4.5, x 2..28; rooftop unit x 24..30, y 14..18.
 */

export const MEP_LINK_FT = {
  duct: { minX: 2, maxX: 20, minY: 9, maxY: 11, z0: 9, z1: 10 },
  rtu: { minX: 24, maxX: 30, minY: 14, maxY: 18, z0: 14, z1: 18 },
  ceiling: { z0: 9.5, z1: 9.6 },
  pipe: { z0: 2, z1: 2.5 },
} as const;

export const MEP_LINK_STOREYS = ["LEVEL 01", "ROOF LOW POINT", "ROOF HIGH POINT"] as const;

interface Box {
  readonly cx: number;
  readonly cy: number;
  readonly z0: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

const box = (minX: number, maxX: number, minY: number, maxY: number, z0: number, z1: number): Box => ({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, z0, dx: maxX - minX, dy: maxY - minY, dz: z1 - z0 });

/** grid > 1 repeats the floor's contents on a grid of 30 x 20 ft bays (the performance script's large linked model). */
export function mepLinkIfc(opts: { readonly grid?: number } = {}): string {
  const grid = Math.max(1, Math.floor(opts.grid ?? 1));
  const lines: string[] = [];
  let next = 100;
  const add = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const guid = (n: number) => `${n.toString(36).padStart(4, "0")}MepLinkFixture0000000`.slice(0, 22);
  const p3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}))`);
  const placementAt = (x: number, y: number, z: number) => add(`IFCAXIS2PLACEMENT3D(#${p3(x, y, z)},#11,#12)`);
  const boxSolid = (b: Box) => {
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#42,${b.dx.toFixed(4)},${b.dy.toFixed(4)})`);
    return add(`IFCEXTRUDEDAREASOLID(#${profile},#${placementAt(b.cx, b.cy, b.z0)},#11,${b.dz.toFixed(4)})`);
  };
  const contained: number[] = [];
  const element = (type: string, name: string, b: Box, predefined: string | null) => {
    const body = add(`IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${boxSolid(b)}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${body}))`);
    const local = add(`IFCLOCALPLACEMENT(#35,#13)`);
    const id = add(`${type}('${guid(next)}',#5,'${name}',$,$,#${local},#${shape},$${predefined === null ? "" : `,${predefined}`})`);
    contained.push(id);
    return id;
  };

  for (let gx = 0; gx < grid; gx++) {
    for (let gy = 0; gy < grid; gy++) {
      const ox = gx * 30;
      const oy = gy * 20;
      const at = (minX: number, maxX: number, minY: number, maxY: number, z0: number, z1: number) => box(minX + ox, maxX + ox, minY + oy, maxY + oy, z0, z1);
      const tag = grid === 1 ? "" : ` ${gx}-${gy}`;
      element("IFCSLAB", `Floor${tag}`, at(0, 30, 0, 20, -0.5, 0), ".FLOOR.");
      element("IFCWALL", `Wall${tag}`, at(0, 30, 0, 0.5, 0, 10), ".STANDARD.");
      element("IFCDUCTSEGMENT", `Supply duct${tag}`, at(MEP_LINK_FT.duct.minX, MEP_LINK_FT.duct.maxX, MEP_LINK_FT.duct.minY, MEP_LINK_FT.duct.maxY, MEP_LINK_FT.duct.z0, MEP_LINK_FT.duct.z1), ".RIGIDSEGMENT.");
      element("IFCDUCTFITTING", `Elbow${tag}`, at(20, 22, 9, 11, 9, 10), ".BEND.");
      element("IFCAIRTERMINAL", `Diffuser${tag}`, at(10, 12, 12, 14, 8.5, 9), ".DIFFUSER.");
      element("IFCCOVERING", `Ceiling${tag}`, at(0, 30, 0, 20, MEP_LINK_FT.ceiling.z0, MEP_LINK_FT.ceiling.z1), ".CEILING.");
      element("IFCPIPESEGMENT", `Water pipe${tag}`, at(2, 28, 4, 4.5, MEP_LINK_FT.pipe.z0, MEP_LINK_FT.pipe.z1), ".RIGIDSEGMENT.");
      element("IFCUNITARYEQUIPMENT", `Rooftop unit${tag}`, at(MEP_LINK_FT.rtu.minX, MEP_LINK_FT.rtu.maxX, MEP_LINK_FT.rtu.minY, MEP_LINK_FT.rtu.maxY, MEP_LINK_FT.rtu.z0, MEP_LINK_FT.rtu.z1), ".ROOFTOPUNIT.");
    }
  }

  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('8MepLinkFixture000000L',#5,$,$,(${contained.map((c) => `#${c}`).join(",")}),#36)`);

  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('mep-link.ifc','2026-11-06T00:00:00',('PermitZIP test'),('PermitZIP'),'hand-written','none','');
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
#30=IFCPROJECT('0MepLinkFixture000000L',#5,'MEP link fixture',$,$,$,$,(#14),#24);
#31=IFCLOCALPLACEMENT($,#13);
#32=IFCSITE('1MepLinkFixture000000L',#5,'Site',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#33=IFCLOCALPLACEMENT(#31,#13);
#34=IFCBUILDING('2MepLinkFixture000000L',#5,'Building',$,$,#33,$,$,.ELEMENT.,$,$,$);
#35=IFCLOCALPLACEMENT(#33,#13);
#36=IFCBUILDINGSTOREY('3MepLinkFixture000000L',#5,'LEVEL 01',$,$,#35,$,$,.ELEMENT.,0.);
#37=IFCRELAGGREGATES('4MepLinkFixture000000L',#5,$,$,#30,(#32));
#38=IFCRELAGGREGATES('5MepLinkFixture000000L',#5,$,$,#32,(#34));
#39=IFCRELAGGREGATES('6MepLinkFixture000000L',#5,$,$,#34,(#36,#53,#57));
#40=IFCCARTESIANPOINT((0.,0.));
#41=IFCDIRECTION((1.,0.));
#42=IFCAXIS2PLACEMENT2D(#40,#41);
#50=IFCCARTESIANPOINT((0.,0.,14.));
#51=IFCAXIS2PLACEMENT3D(#50,#11,#12);
#52=IFCLOCALPLACEMENT(#33,#51);
#53=IFCBUILDINGSTOREY('7MepLinkFixture000000L',#5,'ROOF LOW POINT',$,$,#52,$,$,.ELEMENT.,14.);
#54=IFCCARTESIANPOINT((0.,0.,16.));
#55=IFCAXIS2PLACEMENT3D(#54,#11,#12);
#56=IFCLOCALPLACEMENT(#33,#55);
#57=IFCBUILDINGSTOREY('9MepLinkFixture000000L',#5,'ROOF HIGH POINT',$,$,#56,$,$,.ELEMENT.,16.);
${lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
}
