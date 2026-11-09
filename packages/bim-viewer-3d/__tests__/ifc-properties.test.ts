/**
 * @jest-environment node
 */
import path from "node:path";
import { IfcImporter, SingleThreadedFragmentsModel } from "@thatopen/fragments";
import { configureIfcImporter } from "../src/ifc-import";
import { readReferenceItem, type ReferenceItemProperties } from "../src/item-properties";

// A furnace the way Revit's IFC exporter writes one when parameters are on: instance property
// sets (one with an enumerated value), a quantity set, a type with its own property set, a
// duct port and a return-air system.
const FURNACE_ID = 100;
/** A second furnace of the same type: reading the first must never read this one. */
const OTHER_FURNACE_ID = 120;
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');
FILE_NAME('furnace.ifc','2026-10-18T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#10);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCSITE('1YvctVUKr0kugbFTf53O9L',$,'S',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCLOCALPLACEMENT($,#21);
#40=IFCBUILDING('2YvctVUKr0kugbFTf53O9L',$,'B',$,$,#41,$,$,.ELEMENT.,$,$,$);
#41=IFCLOCALPLACEMENT(#31,#21);
#50=IFCBUILDINGSTOREY('3YvctVUKr0kugbFTf53O9L',$,'LEVEL 1',$,$,#51,$,$,.ELEMENT.,0.);
#51=IFCLOCALPLACEMENT(#41,#21);
#60=IFCRELAGGREGATES('0aaaaaaaaaaaaaaaaaaaaa',$,$,$,#1,(#30));
#61=IFCRELAGGREGATES('0aaaaaaaaaaaaaaaaaaaab',$,$,$,#30,(#40));
#62=IFCRELAGGREGATES('0aaaaaaaaaaaaaaaaaaaac',$,$,$,#40,(#50));
#100=IFCBUILDINGELEMENTPROXY('2CwS2GsarBRvnoKhdQGITK',$,'Furnace:59SC2D:7405481',$,$,#101,#102,'7405481',.NOTDEFINED.);
#101=IFCLOCALPLACEMENT(#51,#21);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#103=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#104));
#104=IFCEXTRUDEDAREASOLID(#105,#21,#107,1.);
#105=IFCRECTANGLEPROFILEDEF(.AREA.,$,#106,1.,1.);
#106=IFCAXIS2PLACEMENT2D(#108,$);
#107=IFCDIRECTION((0.,0.,1.));
#108=IFCCARTESIANPOINT((0.,0.));
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('0aaaaaaaaaaaaaaaaaaaad',$,$,$,(#100),#50);
#200=IFCPROPERTYSINGLEVALUE('Mark',$,IFCTEXT('F-1'),$);
#201=IFCPROPERTYSINGLEVALUE('GAS INPUT',$,IFCREAL(60000.),$);
#202=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('NEW')),$);
#203=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaae',$,'Identity Data',$,(#200,#202));
#204=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaaf',$,'Mechanical',$,(#201));
#205=IFCRELDEFINESBYPROPERTIES('0aaaaaaaaaaaaaaaaaaaag',$,$,$,(#100),#203);
#206=IFCRELDEFINESBYPROPERTIES('0aaaaaaaaaaaaaaaaaaaah',$,$,$,(#100),#204);
#210=IFCQUANTITYLENGTH('Height',$,$,1.,$);
#211=IFCELEMENTQUANTITY('0aaaaaaaaaaaaaaaaaaaai',$,'Qto_BuildingElementProxyBaseQuantities',$,$,(#210));
#212=IFCRELDEFINESBYPROPERTIES('0aaaaaaaaaaaaaaaaaaaaj',$,$,$,(#100),#211);
#300=IFCPROPERTYSINGLEVALUE('SEER',$,IFCREAL(16.),$);
#301=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaak',$,'Other',$,(#300));
#302=IFCBUILDINGELEMENTPROXYTYPE('0aaaaaaaaaaaaaaaaaaaal',$,'Furnace:59SC2D',$,$,(#301),$,'7405465',$,.NOTDEFINED.);
#303=IFCRELDEFINESBYTYPE('0aaaaaaaaaaaaaaaaaaaam',$,$,$,(#100),#302);
#400=IFCDISTRIBUTIONPORT('0aaaaaaaaaaaaaaaaaaaan',$,'InPort_7405481_22','Flow',$,#101,$,.SINK.,.DUCT.,.VENTILATION.);
#401=IFCRELNESTS('0aaaaaaaaaaaaaaaaaaaao',$,$,$,#100,(#400));
#410=IFCDISTRIBUTIONSYSTEM('0aaaaaaaaaaaaaaaaaaaap',$,'Mechanical Return Air 1',$,'Return Air',$,.VENTILATION.);
#411=IFCRELASSIGNSTOGROUP('0aaaaaaaaaaaaaaaaaaaaq',$,$,$,(#100),$,#410);
#120=IFCBUILDINGELEMENTPROXY('2CwS2GsarBRvnoKhdQGITL',$,'Furnace:59SC2D:7418766',$,$,#101,#102,'7418766',.NOTDEFINED.);
#121=IFCRELDEFINESBYTYPE('0aaaaaaaaaaaaaaaaaaaar',$,$,$,(#120),#302);
#122=IFCRELCONTAINEDINSPATIALSTRUCTURE('0aaaaaaaaaaaaaaaaaaaas',$,$,$,(#120),#50);
ENDSEC;
END-ISO-10303-21;
`;

const WASM_DIR = path.join(process.cwd(), "node_modules", "web-ifc") + path.sep;

async function convertAndRead(configure: boolean): Promise<{ props: ReferenceItemProperties; reached: Set<number> }> {
  const importer = new IfcImporter();
  importer.wasm = { absolute: true, path: WASM_DIR };
  if (configure) configureIfcImporter(importer);
  const frag = await importer.process({ bytes: new TextEncoder().encode(IFC) });
  const model = new SingleThreadedFragmentsModel("furnace", frag);
  const reached = new Set<number>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "object" && value !== null) {
      const id: unknown = Reflect.get(value, "_localId");
      if (typeof id === "object" && id !== null && typeof Reflect.get(id, "value") === "number") reached.add(Reflect.get(id, "value"));
      for (const v of Object.values(value)) if (typeof v === "object" && v !== null && !("value" in v)) collect(v);
    }
  };
  try {
    await model.ready;
    const props = await readReferenceItem((ids, config) => {
      const items = model.getItemsData(ids, config);
      ids.forEach((id) => reached.add(id));
      items.forEach(collect);
      return items;
    }, FURNACE_ID);
    return { props, reached };
  } finally {
    model.dispose();
  }
}

const rows = (props: ReferenceItemProperties, group: string, source: "instance" | "type") =>
  Object.fromEntries(props.groups.find((g) => g.name === group && g.source === source)?.rows.map((r) => [r.name, r.value]) ?? []);

describe("linked IFC properties survive conversion and read back grouped", () => {
  let props: ReferenceItemProperties;
  let reached: Set<number>;
  beforeAll(async () => {
    ({ props, reached } = await convertAndRead(true));
  }, 60_000);

  it("names the element, its IFC class, type and where it sits", () => {
    expect(props.name).toBe("Furnace:59SC2D:7405481");
    expect(props.ifcClass).toBe("IFCBUILDINGELEMENTPROXY");
    expect(props.typeName).toBe("Furnace:59SC2D");
    expect(props.container).toBe("LEVEL 1");
    expect(props.attributes).toContainEqual({ name: "Tag", value: "7405481" });
  });

  it("keeps instance values, including enumerated ones", () => {
    expect(rows(props, "Identity Data", "instance")).toEqual({ Mark: "F-1", Status: "NEW" });
    expect(rows(props, "Mechanical", "instance")).toEqual({ "GAS INPUT": "60000" });
  });

  it("keeps quantity sets", () => {
    const qto = props.groups.find((g) => g.kind === "quantities");
    expect(qto?.name).toBe("Qto_BuildingElementProxyBaseQuantities");
    expect(qto?.rows).toEqual([{ name: "Height", value: "1" }]);
  });

  it("keeps type values separately from instance values", () => {
    expect(rows(props, "Other", "type")).toEqual({ SEER: "16" });
    expect(props.groups.map((g) => g.source)).toEqual(["instance", "instance", "instance", "type"]);
  });

  it("keeps the element's systems and ports", () => {
    expect(props.systems).toEqual(["Mechanical Return Air 1 · Return Air"]);
    expect(props.ports).toEqual([{ name: "InPort_7405481_22", value: "sink duct ventilation · not connected" }]);
  });

  it("never reads the other elements that share the type", () => {
    expect(reached.has(FURNACE_ID)).toBe(true);
    expect(reached.has(OTHER_FURNACE_ID)).toBe(false);
  });

  it("would lose enumerated values, systems and ports with Fragments' default import", async () => {
    const { props: plain } = await convertAndRead(false);
    expect(rows(plain, "Identity Data", "instance")).toEqual({ Mark: "F-1" });
    expect(plain.systems).toEqual([]);
    expect(plain.ports).toEqual([]);
  }, 60_000);
});
