/**
 * Reusable standard general notes & specification blocks for construction sheets.
 * Shared across the editor ribbon ("Annotate -> Standard notes") and @permitzip/bim-script
 * (`documents.listStandardNoteSets()` / `documents.placeStandardNotes(...)`).
 */

export interface StandardNoteSet {
  readonly id: string;
  readonly discipline: "electrical" | "mechanical" | "plumbing" | "fire_protection" | "architecture" | "structure";
  readonly title: string;
  readonly codeBasis: string;
  readonly notes: readonly string[];
}

export const STANDARD_NOTE_SETS: readonly StandardNoteSet[] = [
  {
    id: "electrical-general",
    discipline: "electrical",
    title: "ELECTRICAL GENERAL NOTES",
    codeBasis: "NFPA 70 (NEC 2023) / IECC",
    notes: [
      "ALL ELECTRICAL WORK SHALL COMPLY WITH NFPA 70 (NEC 2023), STATE AMENDMENTS, AND LOCAL AHJ REQUIREMENTS.",
      "CONDUCTORS SHALL BE COPPER, MINIMUM #12 AWG FOR POWER AND LIGHTING BRANCH CIRCUITS, TYPE THHN/THWN-2 IN EMT CONDUIT.",
      "PROVIDE DEDICATED EQUIPMENT GROUNDING CONDUCTOR IN ALL RACEWAYS PER NEC ARTICLE 250.",
      "MAINTAIN NEC 110.26 WORKING SPACE CLEARANCES IN FRONT OF ALL SWITCHBOARDS, PANELBOARDS, AND DISCONNECTS.",
      "VERIFY AVAILABLE FAULT CURRENT AND PROVIDE SERIES/FULLY RATED EQUIPMENT AIC LABELS PER NEC 110.24.",
      "PROVIDE GFCI PROTECTION FOR ALL RECEPTACLES IN RESTROOMS, BREAK AREAS, WITHIN 6'-0\" OF SINKS, AND EXTERIOR LOCATIONS PER NEC 210.8.",
      "COORDINATE FLOOR BOX LOCATIONS WITH ARCHITECTURAL FURNITURE PLANS AND STRUCTURAL SLAB PENETRATIONS PRIOR TO ROUGH-IN.",
      "PROVIDE PERMANENT ENGRAVED PHENOLIC NAMEPLATES ON ALL PANELS, TRANSFORMERS, AND DISCONNECT SWITCHES; UPDATE TYPED PANEL DIRECTORIES.",
    ],
  },
  {
    id: "electrical-demolition",
    discipline: "electrical",
    title: "ELECTRICAL DEMOLITION NOTES",
    codeBasis: "NFPA 70 / NFPA 70E",
    notes: [
      "FIELD VERIFY ALL EXISTING CIRCUITS, FEEDERS, AND CONDUIT ROUTING PRIOR TO DEMOLITION.",
      "DE-ENERGIZE, LOCKOUT/TAGOUT, AND VERIFY ZERO ENERGY PER NFPA 70E BEFORE REMOVING ANY EXISTING EQUIPMENT OR WIRING.",
      "REMOVE ABANDONED CONDUCTORS AND RACEWAYS BACK TO SOURCE PANELBOARD OR NEAREST ACTIVE JUNCTION BOX; MAINTAIN CONTINUITY OF CIRCUITS SERVING AREAS TO REMAIN.",
      "TURN OVER SALVAGEABLE EQUIPMENT DESIGNATED BY OWNER; LEGALLY DISPOSE OF DEMOLISHED LUMINAIRES, LAMPS, AND BALLASTS.",
      "UPDATE EXISTING PANELBOARD DIRECTORIES TO REFLECT ALL REMOVED AND REVISED CIRCUITS.",
    ],
  },
  {
    id: "mechanical-general",
    discipline: "mechanical",
    title: "MECHANICAL GENERAL NOTES",
    codeBasis: "IMC 2021 / ASHRAE 62.1 / SMACNA",
    notes: [
      "ALL HVAC WORK SHALL COMPLY WITH THE INTERNATIONAL MECHANICAL CODE (IMC), ASHRAE 62.1, ASHRAE 90.1, AND SMACNA DUCT CONSTRUCTION STANDARDS.",
      "FABRICATE SHEET METAL DUCTWORK FROM G90 GALVANIZED STEEL; SEAL ALL TRANSVERSE JOINTS AND LONGITUDINAL SEAMS TO SMACNA SEAL CLASS A.",
      "LIMIT FLEXIBLE DUCT CONNECTIONS TO MAXIMUM 5'-0\" LENGTH WITH NO SHARP BENDS OR COMPRESSION.",
      "COORDINATE ROOFTOP EQUIPMENT CURBS, PENETRATIONS, AND STRUCTURAL FRAMING WITH ARCHITECTURAL AND STRUCTURAL DRAWINGS.",
      "PERFORM INDEPENDENT AABC/NEBB TESTING, ADJUSTING, AND BALANCING (TAB) OF ALL AIR AND HYDRONIC SYSTEMS AND SUBMIT CERTIFIED REPORT PRIOR TO OCCUPANCY.",
    ],
  },
  {
    id: "plumbing-general",
    discipline: "plumbing",
    title: "PLUMBING GENERAL NOTES",
    codeBasis: "IPC 2021",
    notes: [
      "ALL PLUMBING WORK SHALL COMPLY WITH THE INTERNATIONAL PLUMBING CODE (IPC) AND LOCAL UTILITY REQUIREMENTS.",
      "DOMESTIC WATER PIPING SHALL BE TYPE L HARD DRAWN COPPER WITH LEAD-FREE SOLDER OR PRESS FITTINGS; INSULATE PER IECC.",
      "SANITARY DRAINAGE PIPING SHALL BE SLOPED MINIMUM 1/4\" PER FOOT FOR 2-1/2\" AND SMALLER, 1/8\" PER FOOT FOR 3\" AND LARGER.",
      "PROVIDE CLEANOUTS AT BASE OF ALL STACKS, CHANGES OF DIRECTION GREATER THAN 45 DEGREES, AND MAXIMUM 100'-0\" INTERVALS.",
      "DISINFECT AND FLUSH ALL POTABLE WATER PIPING PER AWWA C651 AND PRESSURE-TEST ALL SYSTEMS PRIOR TO CONCEALMENT.",
    ],
  },
  {
    id: "fire-protection-general",
    discipline: "fire_protection",
    title: "FIRE PROTECTION GENERAL NOTES",
    codeBasis: "NFPA 13 / IBC",
    notes: [
      "DESIGN, FABRICATE, AND INSTALL AUTOMATIC SPRINKLER SYSTEM IN FULL COMPLIANCE WITH NFPA 13 AND LOCAL FIRE MARSHAL REQUIREMENTS.",
      "SUBMIT HYDRAULIC CALCULATIONS, SHOP DRAWINGS, AND EQUIPMENT CUT SHEETS SIGNED BY NICET LEVEL III/IV OR LICENSED PE FOR APPROVAL PRIOR TO FABRICATION.",
      "COORDINATE SPRINKLER HEAD LOCATIONS WITH REFLECTED CEILING PLAN, LIGHT FIXTURES, AND AIR TERMINALS; CENTER HEADS IN ACOUSTICAL CEILING TILES.",
      "PERFORM HYDROSTATIC PRESSURE TEST AT 200 PSI FOR 2 HOURS PER NFPA 13.",
    ],
  },
  {
    id: "architectural-general",
    discipline: "architecture",
    title: "ARCHITECTURAL GENERAL NOTES",
    codeBasis: "IBC 2021 / ADA 2010",
    notes: [
      "VERIFY ALL DIMENSIONS AND EXISTING CONDITIONS AT THE SITE BEFORE COMMENCING WORK; DO NOT SCALE DRAWINGS.",
      "ALL ACCESSIBLE ROUTES, DOORS, CLEARANCES, AND PLUMBING FIXTURES SHALL COMPLY WITH 2010 ADA STANDARDS AND ICC A117.1.",
      "PROVIDE UL-LISTED FIRESTOPPING AT ALL PENETRATIONS OF FIRE-RATED WALLS AND FLOOR/CEILING ASSEMBLIES.",
      "COORDINATE ALL MECHANICAL, ELECTRICAL, PLUMBING, AND STRUCTURAL OPENINGS WITH RESPECTIVE DISCIPLINE DRAWINGS PRIOR TO FRAMING.",
    ],
  },
  {
    id: "structural-steel-concrete",
    discipline: "structure",
    title: "STRUCTURAL GENERAL NOTES",
    codeBasis: "IBC 2021 / AISC 360 / ACI 318",
    notes: [
      "STRUCTURAL STEEL WIDE-FLANGE SHAPES SHALL CONFORM TO ASTM A992 (FY = 50 KSI); PLATES AND ANGLES TO ASTM A36.",
      "CONCRETE FOR FOOTINGS AND SLABS SHALL ACHIEVE MINIMUM F'C = 4,000 PSI AT 28 DAYS PER ACI 318.",
      "VERIFY SOIL BEARING CAPACITY WITH GEOTECHNICAL ENGINEER PRIOR TO PLACING FOOTING CONCRETE.",
      "COORDINATE ALL EMBEDS, ANCHOR RODS, AND ROOFTOP EQUIPMENT DUNNAGE WITH ARCHITECTURAL AND MEP DRAWINGS.",
    ],
  },
] as const;

export interface FormatStandardNoteOptions {
  readonly title?: string;
  readonly extraNotes?: readonly string[];
  /** 1-based note numbers to omit from the starter set. */
  readonly excludeNumbers?: readonly number[];
}

export function getStandardNoteSet(setId: string): StandardNoteSet | undefined {
  return STANDARD_NOTE_SETS.find((s) => s.id === setId);
}

export function listStandardNoteSets(discipline?: string): readonly {
  readonly id: string;
  readonly discipline: StandardNoteSet["discipline"];
  readonly title: string;
  readonly codeBasis: string;
  readonly noteCount: number;
  readonly firstNote: string;
}[] {
  const filtered = discipline
    ? STANDARD_NOTE_SETS.filter((s) => s.discipline === discipline.toLowerCase())
    : STANDARD_NOTE_SETS;
  return filtered.map((s) => ({
    id: s.id,
    discipline: s.discipline,
    title: s.title,
    codeBasis: s.codeBasis,
    noteCount: s.notes.length,
    firstNote: s.notes[0] ?? "",
  }));
}

export function formatStandardNoteSet(
  setId: string,
  opts: FormatStandardNoteOptions = {},
): string {
  const set = getStandardNoteSet(setId);
  if (!set) {
    const valid = STANDARD_NOTE_SETS.map((s) => s.id).join(", ");
    throw new Error(`Unknown standard note set "${setId}". Available sets: ${valid}`);
  }
  const excluded = new Set(opts.excludeNumbers ?? []);
  const kept = set.notes.filter((_, idx) => !excluded.has(idx + 1));
  const combined = [...kept, ...(opts.extraNotes ?? []).map((n) => n.trim()).filter(Boolean)];
  const heading = (opts.title?.trim() || set.title).toUpperCase();
  const lines = [
    `${heading} (${set.codeBasis})`,
    ...combined.map((line, i) => `${i + 1}. ${line}`),
  ];
  return lines.join("\n");
}

export function standardNoteParagraphs(
  setId: string,
  opts: FormatStandardNoteOptions = {},
): Array<{ readonly runs: Array<{ readonly text: string; readonly bold?: boolean }> }> {
  const formatted = formatStandardNoteSet(setId, opts);
  const lines = formatted.split("\n");
  return lines.map((line, idx) => ({
    runs: [{ text: line, ...(idx === 0 ? { bold: true } : {}) }],
  }));
}
