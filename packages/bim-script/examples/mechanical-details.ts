/**
 * Mechanical details sheet: two permit-ready HVAC drafting details built with
 * the `drafting` CAD API, placed onto sheet M-501:
 *
 * 1. Carrier 50FEQ Rooftop Unit on 14" Insulated Roof Curb with Ruskin 01-530
 *    Concentric Diffuser & Acoustic Dog-Leg Duct Offset (3/4" = 1'-0").
 * 2. Ceiling Toilet Exhaust Fan (EF-1A/1B) & 6" Ø Exterior Hooded Wall Cap
 *    with Backdraft Damper & 1/4" Bird Screen (3/4" = 1'-0").
 *
 * Demonstrates full CAD drafting standards: lineweight hierarchy (wide/medium/
 * thin/hidden/centerline), halftone & screened material hatches, mechanical 2D
 * detail components, break lines with cut masks, batt insulation, real CAD
 * dimensions, aligned left/right callout stacks with filled NCS arrowheads and
 * opaque text masks, tight crop fitting, and automated overlap QA.
 */
import { defineScript, units, documents, drafting } from "@permitzip/bim-script";

const inch = units.in;
const pt = (x: number, y: number) => ({ x: inch(x), y: inch(y) });

export default defineScript({
  kind: "layout",
  reads: {},
  parameters: {},
  run(ctx) {
    // ── DETAIL 1: CARRIER 50FEQ RTU ON 14" CURB & CONCENTRIC DIFFUSER DOG-LEG ──
    const rtuDetail = drafting.view(ctx, {
      name: "RTU ON 14\" CURB & CONCENTRIC DIFFUSER DETAIL",
      scale: 16, // 3/4" = 1'-0"
      discipline: "mechanical",
    });

    // Clearances (dashed thin envelopes flanking the unit, sitting flush on curb top y = 15.5)
    drafting.rect(ctx, { view: rtuDetail, at: pt(-48, 15.5), width: inch(48), height: inch(34), lineStyle: "hidden" });
    drafting.rect(ctx, { view: rtuDetail, at: pt(64, 15.5), width: inch(36), height: inch(34), lineStyle: "hidden" });

    // Roof assembly: metal deck (-5.5 to -2) + rigid insulation (-2 to 1.5) + roofing membrane (y = 1.5)
    // Curb rails sit cleanly at x = 0.8..4 (left) and x = 60..63.2 (right), resting on the roof assembly with cant strips flush on the membrane (y = 1.5)
    for (const [rx, rw] of [[-46, 50], [60, 38]] as const) {
      drafting.region(ctx, {
        view: rtuDetail,
        rect: { at: pt(rx, -5.5), width: inch(rw), height: inch(3.5) },
        hatch: "metal_deck",
        tone: "halftone",
        lineStyle: "medium",
      });
      drafting.region(ctx, {
        view: rtuDetail,
        rect: { at: pt(rx, -2), width: inch(rw), height: inch(3.5) },
        hatch: "insulation_rigid",
        tone: "screened",
        lineStyle: "thin",
      });
      drafting.line(ctx, { view: rtuDetail, from: pt(rx, 1.5), to: pt(rx + rw, 1.5), lineStyle: "wide" });
    }
    // Clean vertical break lines terminating both ends of the roof section (set slightly inboard so the cut mask slices cleanly through the hatched assembly)
    drafting.breakLine(ctx, { view: rtuDetail, from: pt(-44, -7.5), to: pt(-44, 4), maskSide: "left", maskDepth: inch(5) });
    drafting.breakLine(ctx, { view: rtuDetail, from: pt(96, -7.5), to: pt(96, 4), maskSide: "right", maskDepth: inch(5) });

    // 14" insulated roof curb rails (left & right mirrored) sitting flush on top of roof membrane (y = 1.5 -> 15.5)
    drafting.component(ctx, {
      view: rtuDetail,
      symbol: "mechanical.roof_curb_rail",
      at: pt(-2, 1.5),
      width: inch(8),
      height: inch(14),
    });
    drafting.component(ctx, {
      view: rtuDetail,
      symbol: "mechanical.roof_curb_rail",
      at: pt(58, 1.5),
      width: inch(8),
      height: inch(14),
      mirror: true,
    });

    // Carrier 50FEQ RTU cabinet body + top condenser fan discharge shroud + right OA intake hood (resting at y = 15.5)
    drafting.region(ctx, {
      view: rtuDetail,
      rect: { at: pt(0, 15.5), width: inch(64), height: inch(34) },
      hatch: "solid",
      tone: "screened",
      boundary: false,
    });
    drafting.rect(ctx, { view: rtuDetail, at: pt(0, 15.5), width: inch(64), height: inch(34), lineStyle: "wide" });
    // Internal equipment panel division lines
    drafting.line(ctx, { view: rtuDetail, from: pt(24, 15.5), to: pt(24, 49.5), lineStyle: "thin" });
    drafting.line(ctx, { view: rtuDetail, from: pt(48, 15.5), to: pt(48, 49.5), lineStyle: "thin" });
    // Top condenser fan discharge collar
    drafting.rect(ctx, { view: rtuDetail, at: pt(8, 49.5), width: inch(22), height: inch(4), lineStyle: "medium" });
    // Right outdoor-air rain hood with bird screen
    drafting.chain(ctx, {
      view: rtuDetail,
      points: [pt(64, 39.5), pt(74, 31.5), pt(74, 23.5), pt(64, 23.5)],
      lineStyle: "medium",
    });

    // Equipment center label inside clean cabinet interior
    drafting.note(ctx, {
      view: rtuDetail,
      at: pt(8, 37.5),
      width: inch(2.9),
      textHeight: inch(0.1),
      align: "center",
      bold: true,
      text: "CARRIER 50FEQ HEAT PUMP RTU\nRTU-1 (3T) / RTU-2 (7.5T) / RTU-3 (4T)",
    });

    // Supply & Return vertical drop ducts connecting RTU curb openings straight down into concentric transition box (y = -40)
    // (Left: Supply duct x = 10..24; Right: Return duct x = 40..54 — lined internally with 1" NFPA 90A acoustic liner)
    drafting.line(ctx, { view: rtuDetail, from: pt(10, 15.5), to: pt(10, -40), lineStyle: "wide" });
    drafting.line(ctx, { view: rtuDetail, from: pt(24, 15.5), to: pt(24, -40), lineStyle: "wide" });
    // 1" internal acoustic duct liner strips along supply duct interior walls
    drafting.region(ctx, {
      view: rtuDetail,
      rect: { at: pt(10, -35), width: inch(1.5), height: inch(28) },
      hatch: "acoustic",
      tone: "halftone",
      lineStyle: "thin",
    });
    drafting.region(ctx, {
      view: rtuDetail,
      rect: { at: pt(22.5, -35), width: inch(1.5), height: inch(28) },
      hatch: "acoustic",
      tone: "halftone",
      lineStyle: "thin",
    });
    // Supply volume damper + airflow direction arrow (downward)
    drafting.line(ctx, { view: rtuDetail, from: pt(11.5, -14), to: pt(22.5, -18), lineStyle: "medium" });
    drafting.circle(ctx, { view: rtuDetail, center: pt(17, -16), radius: inch(0.75), lineStyle: "thin" });
    drafting.component(ctx, { view: rtuDetail, symbol: "flow_arrow", at: pt(15.5, -24), width: inch(5), height: inch(3), rotationDeg: -90 });

    // Right: Return vertical duct (x = 40..54) with 1" internal acoustic liner & return airflow arrow (upward)
    drafting.line(ctx, { view: rtuDetail, from: pt(40, 15.5), to: pt(40, -40), lineStyle: "wide" });
    drafting.line(ctx, { view: rtuDetail, from: pt(54, 15.5), to: pt(54, -40), lineStyle: "wide" });
    drafting.region(ctx, {
      view: rtuDetail,
      rect: { at: pt(40, -35), width: inch(1.5), height: inch(28) },
      hatch: "acoustic",
      tone: "halftone",
      lineStyle: "thin",
    });
    drafting.region(ctx, {
      view: rtuDetail,
      rect: { at: pt(52.5, -35), width: inch(1.5), height: inch(28) },
      hatch: "acoustic",
      tone: "halftone",
      lineStyle: "thin",
    });
    drafting.component(ctx, { view: rtuDetail, symbol: "flow_arrow", at: pt(48.5, -18), width: inch(5), height: inch(3), rotationDeg: 90 });

    // Ceiling line & Ruskin 01-530 concentric diffuser transition plenum box
    drafting.line(ctx, { view: rtuDetail, from: pt(-12, -52), to: pt(8, -52), lineStyle: "medium" });
    drafting.line(ctx, { view: rtuDetail, from: pt(56, -52), to: pt(76, -52), lineStyle: "medium" });
    drafting.component(ctx, {
      view: rtuDetail,
      symbol: "mechanical.concentric_diffuser",
      at: pt(8, -53),
      width: inch(48),
      height: inch(13),
    });

    // Real CAD dimensions (service clearance, condenser clearance, curb height) — cleanly outside dashed clearance boxes
    drafting.dimension(ctx, {
      view: rtuDetail,
      from: pt(-48, 49.5),
      to: pt(0, 49.5),
      offset: inch(-0.45),
      suffix: " SERVICE CLR.",
    });
    drafting.dimension(ctx, {
      view: rtuDetail,
      from: pt(64, 49.5),
      to: pt(100, 49.5),
      offset: inch(-0.45),
      suffix: " COND. / OA CLR.",
    });
    drafting.dimension(ctx, {
      view: rtuDetail,
      from: pt(0, 1.5),
      to: pt(0, 15.5),
      offset: inch(-0.55),
      suffix: " CURB",
    });

    // Margin-aligned callout stacks (zero overlaps, opaque masks, horizontal-shoulder filled arrows, clean non-crossing routing)
    drafting.calloutStack(ctx, {
      view: rtuDetail,
      side: "left",
      x: inch(-54),
      topY: inch(20),
      width: inch(2.85),
      notes: [
        { text: "14\" INSULATED ROOF CURB\n(CRRFCURB) W/ CANT & FLASHING", to: pt(0.5, 11.5) },
      ],
    });
    drafting.calloutStack(ctx, {
      view: rtuDetail,
      side: "left",
      x: inch(-54),
      topY: inch(3.5),
      width: inch(2.85),
      notes: [
        { text: "SLOPED PEMB ROOF DECK\nW/ RIGID INSULATION & MEMBRANE", to: pt(-28, -0.5) },
      ],
    });
    drafting.calloutStack(ctx, {
      view: rtuDetail,
      side: "left",
      x: inch(-54),
      topY: inch(-16),
      width: inch(2.85),
      notes: [
        { text: "SUPPLY DROP DUCT W/ BAL. DAMPER\nSEAL ALL JOINTS (SMACNA CLASS A)", to: pt(10, -20) },
        { text: "FINISHED CEILING PLANE", to: pt(-6, -52) },
      ],
    });
    drafting.calloutStack(ctx, {
      view: rtuDetail,
      side: "right",
      x: inch(106),
      topY: inch(35),
      width: inch(2.95),
      notes: [
        { text: "OUTDOOR AIR INTAKE HOOD\nW/ BIRD SCREEN & MOTORIZED DAMPER", to: pt(74, 29) },
      ],
    });
    drafting.calloutStack(ctx, {
      view: rtuDetail,
      side: "right",
      x: inch(106),
      topY: inch(-16),
      width: inch(2.95),
      notes: [
        { text: "RETURN DROP DUCT W/ 1\" INTERNAL\nACOUSTIC DUCT LINER (NFPA 90A)", to: pt(54, -20) },
        { text: "RUSKIN 01-530 CONCENTRIC DIFFUSER\n4-WAY SUPPLY + CENTER EGGCRATE RETURN", to: pt(56, -46) },
      ],
    });

    drafting.fitCrop(ctx, rtuDetail, { margin: inch(0.35) });
    const rtuQa = drafting.check(ctx, rtuDetail);

    // ── DETAIL 2: TOILET EXHAUST FAN (EF-1A/1B) & 6" Ø EXTERIOR HOODED WALL CAP ──
    const fanDetail = drafting.view(ctx, {
      name: "TOILET EXHAUST FAN & HOODED WALL CAP DETAIL",
      scale: 16, // 3/4" = 1'-0"
      discipline: "mechanical",
    });

    // Exterior wall assembly (CMU/masonry backup + interior gypsum board + batt insulation)
    drafting.region(ctx, {
      view: fanDetail,
      rect: { at: pt(42, -14), width: inch(8), height: inch(42) },
      hatch: "masonry",
      tone: "halftone",
      lineStyle: "wide",
    });
    drafting.region(ctx, {
      view: fanDetail,
      rect: { at: pt(40, -14), width: inch(2), height: inch(42) },
      hatch: "gypsum",
      tone: "screened",
      lineStyle: "thin",
    });
    // Top and bottom wall break lines set slightly inboard so the zig-zag cut mask cleanly slices off the wall edges & masonry hatch
    drafting.breakLine(ctx, { view: fanDetail, from: pt(37.5, 25.5), to: pt(52.5, 25.5), maskSide: "left", maskDepth: inch(5) });
    drafting.breakLine(ctx, { view: fanDetail, from: pt(52.5, -11.5), to: pt(37.5, -11.5), maskSide: "left", maskDepth: inch(5) });

    // Restroom ceiling plane (gypsum board + cavity batt insulation)
    drafting.region(ctx, {
      view: fanDetail,
      rect: { at: pt(-10, -2), width: inch(50), height: inch(2) },
      hatch: "gypsum",
      tone: "screened",
      lineStyle: "medium",
    });
    drafting.line(ctx, { view: fanDetail, from: pt(-10, 0), to: pt(40, 0), lineStyle: "wide" });
    drafting.breakLine(ctx, { view: fanDetail, from: pt(-8.5, -4), to: pt(-8.5, 4), maskSide: "left", maskDepth: inch(4) });

    // Ceiling cabinet exhaust fan (EF-1A/1B)
    drafting.component(ctx, {
      view: fanDetail,
      symbol: "mechanical.exhaust_fan_ceiling",
      at: pt(2, -1),
      width: inch(14),
      height: inch(13),
    });

    // 6" Ø rigid galvanized exhaust duct sloped slightly down toward exterior wall cap
    // Opaque white mask fills the duct interior where it crosses the wall assembly so masonry hatch doesn't bleed through the duct.
    drafting.region(ctx, {
      view: fanDetail,
      points: [pt(16, 9), pt(50, 7.5), pt(50, 1.5), pt(16, 3)],
      masking: true,
      boundary: false,
    });
    drafting.chain(ctx, {
      view: fanDetail,
      points: [pt(16, 9), pt(50, 7.5)],
      lineStyle: "wide",
    });
    drafting.chain(ctx, {
      view: fanDetail,
      points: [pt(16, 3), pt(50, 1.5)],
      lineStyle: "wide",
    });
    // Duct centerline + airflow arrow
    drafting.line(ctx, { view: fanDetail, from: pt(16, 6), to: pt(50, 4.5), lineStyle: "center" });
    drafting.component(ctx, { view: fanDetail, symbol: "flow_arrow", at: pt(26, 4), width: inch(8), height: inch(3.5), rotationDeg: -2.5 });

    // 6" Ø exterior hooded wall cap (LOUV-1A/1B) w/ integral BDD & 1/4" bird screen
    drafting.component(ctx, {
      view: fanDetail,
      symbol: "mechanical.hooded_louver",
      at: pt(50, -0.5),
      width: inch(10),
      height: inch(10),
    });

    // Real CAD dimensions (placed cleanly in open margins outside wall & fan)
    drafting.dimension(ctx, {
      view: fanDetail,
      from: pt(0, -4),
      to: pt(16, -4),
      offset: inch(0.45),
      suffix: " FAN HSG.",
    });
    drafting.dimension(ctx, {
      view: fanDetail,
      from: pt(40, -14),
      to: pt(50, -14),
      offset: inch(0.45),
    });

    // Clean margin callouts on left & right (zero overlaps with geometry)
    drafting.calloutStack(ctx, {
      view: fanDetail,
      side: "left",
      x: inch(-16),
      topY: inch(24),
      width: inch(3.15),
      notes: [
        { text: "CEILING EXHAUST FAN (EF-1A/1B)\nGREENHECK SP-A50-QD (70 CFM)\nINTEGRAL BACKDRAFT DAMPER", to: pt(6, 11) },
        { text: "6\" Ø RIGID GALV. EXHAUST DUCT\nSLOPE 1/4\" PER FT TO EXTERIOR\nINSULATE W/ R-6 WRAP IN UNCOND. SPACE", to: pt(20, 8.8) },
        { text: "RESTROOM CEILING (9'-0\" AFF)", to: pt(-2, 0) },
      ],
    });
    drafting.calloutStack(ctx, {
      view: fanDetail,
      side: "right",
      x: inch(66),
      topY: inch(24),
      width: inch(2.85),
      notes: [
        { text: "EXTERIOR WALL ASSEMBLY\nSEAL DUCT PENETRATION WEATHERTIGHT", to: pt(48, 18) },
        { text: "6\" Ø HOODED WALL CAP (LOUV-1A/1B)\nW/ INTEGRAL BDD & 1/4\" BIRD SCREEN\nCAULK FLANGE PERIMETER", to: pt(57, 6) },
      ],
    });

    drafting.fitCrop(ctx, fanDetail, { margin: inch(0.35) });
    const fanQa = drafting.check(ctx, fanDetail);

    // ── PLACE BOTH DETAILS ON SHEET M-501 ──
    const sheet = documents.sheet(ctx, {
      number: "M-501",
      name: "MECHANICAL DETAILS & SCHEMATICS",
      discipline: "mechanical",
    });
    documents.place(ctx, sheet, rtuDetail, { x: inch(14.5), y: inch(15.8) });
    documents.place(ctx, sheet, fanDetail, { x: inch(14.5), y: inch(6.2) });

    ctx.report("Detail QA", {
      rtuDetail: { ok: rtuQa.ok, items: rtuQa.itemCount, notes: rtuQa.noteCount, dims: rtuQa.dimCount, issues: rtuQa.issues },
      fanDetail: { ok: fanQa.ok, items: fanQa.itemCount, notes: fanQa.noteCount, dims: fanQa.dimCount, issues: fanQa.issues },
    });
    ctx.label("Mechanical Details sheet M-501 (RTU curb & toilet exhaust fan)");
  },
});
