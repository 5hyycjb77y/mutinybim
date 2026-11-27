/**
 * Civil site grading and storm drainage: imports existing and proposed
 * LandXML 1.2 TIN surfaces, computes prismoidal cut and fill in cubic yards
 * and cubic metres, inspects the imported surfaces via `civil.grading_surfaces`,
 * and reports the earthwork takeoff.
 *
 * Run it: paste it to an assistant connected to the MutinyBIM tool server
 * ("run this script"), or `npm run example -- civil-site`.
 */
import { defineScript, units, building, documents } from "@permitzip/bim-script";

const ft = units.ft;

const SITE_LANDXML = `<?xml version="1.0"?>
<LandXML version="1.2">
  <Units><Imperial linearUnit="foot"/></Units>
  <Surfaces>
    <Surface name="Existing Grade">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 100.0</P>
          <P id="2">0 100 98.0</P>
          <P id="3">80 100 99.5</P>
          <P id="4">80 0 101.5</P>
          <P id="5">40 50 99.75</P>
        </Pnts>
        <Faces>
          <F>1 2 5</F>
          <F>2 3 5</F>
          <F>3 4 5</F>
          <F>4 1 5</F>
        </Faces>
      </Definition>
    </Surface>
    <Surface name="Proposed Pad">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 100.0</P>
          <P id="2">0 100 100.0</P>
          <P id="3">80 100 100.0</P>
          <P id="4">80 0 100.0</P>
          <P id="5">40 50 100.0</P>
        </Pnts>
        <Faces>
          <F>1 2 5</F>
          <F>2 3 5</F>
          <F>3 4 5</F>
          <F>4 1 5</F>
        </Faces>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>`;

export default defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    ctx.label("Civil site grading: import Existing and Proposed LandXML TINs, compute prismoidal cut/fill, and create sheet C-101");

    const siteLevel = building.level(ctx, { name: "Site", elevation: ft(0) });

    // Import both LandXML 1.2 TIN surfaces onto the Site level.
    ctx.edit({ type: "civil.import_landxml_surfaces", landXml: SITE_LANDXML, levelId: siteLevel });

    // Compute prismoidal cut, fill, net (fill - cut), and overlap area.
    const earthwork = ctx.calc({
      calc: "civil.surface_cut_fill",
      inputs: { existingId: "gs-existing-grade", proposedId: "gs-proposed-pad" },
    });

    // Place a civil site grading plan on Sheet C-101.
    const sheet = documents.sheet(ctx, { number: "C-101", name: "Civil Site Grading Plan" });
    const plan = documents.planView(ctx, { level: siteLevel, name: "Site Grading Plan", scale: 120 });
    documents.place(ctx, sheet, plan, { x: units.mm(260), y: units.mm(260) });

    ctx.report("Earthwork cut and fill", earthwork);
  },
});
