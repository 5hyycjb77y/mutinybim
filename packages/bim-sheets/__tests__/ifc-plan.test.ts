/**
 * @jest-environment node
 */
import * as WebIFC from "web-ifc";
import type { ReferencePlan } from "@permitzip/bim-kernel";
import { cutIfcPlan, cutIfcSection, deriveModelFrame, indexPolyCurveSegments, listStoreys } from "../src/ifc-plan";
import { FIRST_PARTY_LINKED_DISPLAY } from "./fixtures/linked-display";
import { fromRowMajor, IDENTITY4 } from "../src/plan-geometry";

const FT = 304.8;

/**
 * A 20 ft x 6 in x 10 ft wall authored in FEET, its extrusion placed at its
 * centre, and a door whose plan symbol is a FootPrint curve set: a 3 ft swing
 * arc (IfcArcIndex) and the panel line, placed at x = 5 ft.
 */
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('feet-wall.ifc','2026-10-18T00:00:00',('PermitZIP test'),('PermitZIP'),'hand-written','none','');
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
#30=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'Synthetic project',$,$,$,$,(#14),#24);
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
#43=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#42,20.,0.5);
#44=IFCCARTESIANPOINT((10.,0.25,0.));
#45=IFCAXIS2PLACEMENT3D(#44,#11,#12);
#46=IFCEXTRUDEDAREASOLID(#43,#45,#11,10.);
#47=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#46));
#48=IFCPRODUCTDEFINITIONSHAPE($,$,(#47));
#49=IFCLOCALPLACEMENT(#35,#13);
#50=IFCWALL('7YvctVUKr0kugbFTf53O9L',#5,'Feet wall',$,$,#49,#48,$,.STANDARD.);
#60=IFCCARTESIANPOINT((5.,1.,0.));
#61=IFCAXIS2PLACEMENT3D(#60,#11,#12);
#62=IFCLOCALPLACEMENT(#35,#61);
#63=IFCCARTESIANPOINT((1.5,0.1));
#64=IFCAXIS2PLACEMENT2D(#63,#41);
#65=IFCRECTANGLEPROFILEDEF(.AREA.,'Door',#64,3.,0.2);
#66=IFCEXTRUDEDAREASOLID(#65,#13,#11,7.);
#67=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#66));
#68=IFCCARTESIANPOINTLIST2D(((3.,0.),(2.1213203435596424,2.1213203435596424),(0.,3.)));
#69=IFCINDEXEDPOLYCURVE(#68,(IFCARCINDEX((1,2,3))),.F.);
#70=IFCCARTESIANPOINTLIST2D(((0.,0.),(0.,3.)));
#71=IFCINDEXEDPOLYCURVE(#70,$,.F.);
#72=IFCGEOMETRICCURVESET((#69,#71));
#73=IFCSHAPEREPRESENTATION(#16,'FootPrint','GeometricCurveSet',(#72));
#74=IFCPRODUCTDEFINITIONSHAPE($,$,(#67,#73));
#75=IFCDOOR('9YvctVUKr0kugbFTf53O9L',#5,'Door',$,$,#62,#74,$,7.,3.,.DOOR.,$,$);
#51=IFCRELCONTAINEDINSPATIALSTRUCTURE('8YvctVUKr0kugbFTf53O9L',#5,$,$,(#50,#75),#36);
ENDSEC;
END-ISO-10303-21;
`;

const bytes = new TextEncoder().encode(IFC);

function layer(plan: ReferencePlan, key: string): number[] {
  const l = plan.layers.find((x) => `${x.kind}:${x.category}` === key);
  return l ? [...l.segments] : [];
}

function extent(flat: readonly number[]) {
  const xs = flat.filter((_, i) => i % 2 === 0);
  const ys = flat.filter((_, i) => i % 2 === 1);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe("IFC -> plan background", () => {
  let api: WebIFC.IfcAPI;
  let modelId: number;

  beforeAll(async () => {
    api = new WebIFC.IfcAPI();
    await api.Init();
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  });
  afterAll(() => api.CloseModel(modelId));

  it("derives web-ifc's mesh frame and finds the file's foot unit applied exactly once", () => {
    const frame = deriveModelFrame(api, modelId);
    expect(frame.lengthUnitName).toBe("FOOT");
    expect(frame.lengthUnitMetres).toBe(0.3048);
    expect(frame.derivation.meshScale).toBeCloseTo(0.3048, 12);
    expect(frame.derivation.originsContained).toBe(frame.derivation.originChecks);
  });

  it("reads arc vs line segment kinds from the STEP text", () => {
    expect(indexPolyCurveSegments(bytes).get(69)).toEqual(["arc"]);
  });

  it("cuts the wall at 4'-0\" to its true size in millimetres", () => {
    const { plan, stats } = cutIfcPlan(api, modelId, {
      id: "t",
      file: "feet-wall.ifc",
      bytes,
      discipline: "architecture",
      ifcToHostMetres: IDENTITY4,
      storeyName: "Level 1",
      cutAboveLevelMm: 4 * FT,
      display: FIRST_PARTY_LINKED_DISPLAY,
    });
    const wall = extent(layer(plan, "cut:IFCWALL"));
    expect(wall.minX).toBeCloseTo(0, 1);
    expect(wall.maxX).toBeCloseTo(20 * FT, 1);
    expect(wall.minY).toBeCloseTo(0, 1);
    expect(wall.maxY).toBeCloseTo(0.5 * FT, 1);
    expect(stats.symbols).toBe(1);
    expect(layer(plan, "cut:IFCDOOR")).toEqual([]);
  });

  it("draws the door from its plan symbol, placed and scaled once", () => {
    const { plan } = cutIfcPlan(api, modelId, {
      id: "t",
      file: "feet-wall.ifc",
      bytes,
      discipline: "architecture",
      ifcToHostMetres: IDENTITY4,
      storeyName: "Level 1",
      cutAboveLevelMm: 4 * FT,
      display: FIRST_PARTY_LINKED_DISPLAY,
    });
    const door = layer(plan, "projection:IFCDOOR");
    const hinge = { x: 5 * FT, y: 1 * FT };
    // Every arc vertex is 3 ft from the hinge; the panel line runs 3 ft north of it.
    const radii: number[] = [];
    for (let i = 0; i + 1 < door.length; i += 2) radii.push(Math.hypot((door[i] ?? 0) - hinge.x, (door[i + 1] ?? 0) - hinge.y));
    expect(Math.max(...radii)).toBeCloseTo(3 * FT, 0);
    expect(extent(door)).toEqual({ minX: expect.closeTo(hinge.x, 0), maxX: expect.closeTo(hinge.x + 3 * FT, 0), minY: expect.closeTo(hinge.y, 0), maxY: expect.closeTo(hinge.y + 3 * FT, 0) });
  });

  it("applies the link placement once (180 degrees about Z)", () => {
    const { plan } = cutIfcPlan(api, modelId, {
      id: "t",
      file: "feet-wall.ifc",
      bytes,
      discipline: "architecture",
      ifcToHostMetres: fromRowMajor([
        [-1, 0, 0, 0],
        [0, -1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ]),
      storeyName: "Level 1",
      cutAboveLevelMm: 4 * FT,
      display: FIRST_PARTY_LINKED_DISPLAY,
    });
    const wall = extent(layer(plan, "cut:IFCWALL"));
    expect(wall.minX).toBeCloseTo(-20 * FT, 1);
    expect(wall.maxX).toBeCloseTo(0, 1);
    expect(wall.minY).toBeCloseTo(-0.5 * FT, 1);
  });

  it("refuses an unknown storey with the names it has", () => {
    expect(() =>
      cutIfcPlan(api, modelId, { id: "t", file: "f", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 9", cutAboveLevelMm: 1200, display: FIRST_PARTY_LINKED_DISPLAY }),
    ).toThrow('No storey named "Level 9"; the file has "Level 1"');
  });

  it("a vertical section cuts the wall to its true thickness and height, in the section's frame", () => {
    // Cut across the wall at x = 10 ft, from 5 ft south to 5 ft north, looking west.
    for (const direction of [1, -1] as const) {
      const { plan, stats } = cutIfcSection(api, modelId, {
        id: "t",
        file: "feet-wall.ifc",
        bytes,
        discipline: "architecture",
        ifcToHostMetres: IDENTITY4,
        cut: { start: { x: 10 * FT, y: -5 * FT }, end: { x: 10 * FT, y: 5 * FT }, direction, depthMm: 30 * FT },
      });
      expect(stats.cut).toBe(1);
      const wall = extent(layer(plan, "cut:IFCWALL"));
      // u = distance along the cut from its start: the wall's 6" (y = 0..0.5 ft) sits 5 ft along; v = elevation 0..10 ft.
      expect(wall.minX).toBeCloseTo(5 * FT, 0);
      expect(wall.maxX).toBeCloseTo(5.5 * FT, 0);
      expect(wall.minY).toBeCloseTo(0, 0);
      expect(wall.maxY).toBeCloseTo(10 * FT, 0);
    }
  });

  it("a section past the wall's end sees its end face beyond, and nothing past the far clip", () => {
    const at = (depthMm: number) =>
      cutIfcSection(api, modelId, { id: "t", file: "f", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, cut: { start: { x: 25 * FT, y: -5 * FT }, end: { x: 25 * FT, y: 5 * FT }, direction: 1, depthMm } });
    expect(at(3 * FT).plan.layers.filter((l) => l.category === "IFCWALL")).toHaveLength(0);
    const seen = at(10 * FT);
    expect(seen.stats.cut).toBe(0);
    const face = extent(layer(seen.plan, "projection:IFCWALL"));
    expect(face.minX).toBeCloseTo(5 * FT, 0);
    expect(face.maxX).toBeCloseTo(5.5 * FT, 0);
    expect(face.maxY).toBeCloseTo(10 * FT, 0);
  });

  it("lists storeys with host elevations", () => {
    expect(listStoreys(api, modelId, IDENTITY4)).toEqual([{ name: "Level 1", elevationMm: 0 }]);
  });
});
