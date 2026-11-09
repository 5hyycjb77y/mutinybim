import { KIT_EXAMPLE_SOURCES } from "./examples.generated";

export { KIT_EXAMPLE_SOURCES };

/**
 * The showcase scripts in packages/bim-script/examples: whole jobs, written
 * against the public kit, each one bim_run_script → check → apply. People
 * copy them; agents start from them (bim_script_reference({ example })).
 */
export interface KitExample {
  /** The file name without .ts, and what `npm run example -- <name>` takes. */
  readonly name: string;
  readonly title: string;
  /** What it builds, in plain words. */
  readonly builds: string;
  readonly topics: readonly string[];
  readonly source: string;
}

/** Where the files are, in the repository. */
export const KIT_EXAMPLES_PATH = "packages/bim-script/examples";

const ABOUT: readonly Omit<KitExample, "source">[] = [
  {
    name: "small-office",
    title: "Small office",
    builds: "Two floors of a 40 x 30 ft office: exterior and interior walls, doors and windows, rooms found from the walls (open office, conference, office), and a plan of each floor on its own sheet.",
    topics: ["office", "walls", "rooms", "doors", "windows", "levels", "sheets", "floor plan", "architecture"],
  },
  {
    name: "rooftop-unit",
    title: "Rooftop unit",
    builds: "A 10 ton rooftop unit built as a part type, placed on the roof, its supply and return ducts sized from airflow and routed down into two rooms, every duct tagged, and an equipment schedule on a sheet.",
    topics: ["rooftop unit", "rtu", "ducts", "duct sizing", "hvac", "mechanical", "equipment schedule", "tags"],
  },
  {
    name: "plumbing-riser",
    title: "Plumbing riser",
    builds: "Toilet rooms on two floors with their fixture units counted, branches, a stack and a building drain sized by the plumbing code and sloped 1/4 in per ft, the fixtures connected, water demand from the Hunter curve, and the drain tagged with size and slope.",
    topics: ["plumbing", "riser", "stack", "building drain", "dfu", "wsfu", "fixture units", "slope", "sanitary"],
  },
  {
    name: "electrical-room",
    title: "Electrical room",
    builds: "A one-bedroom unit: walls and rooms, a panel, receptacles placed by NEC 210.52 wall spacing, one circuit per room from a room template, and the panel schedule on a sheet with the code's demand factors.",
    topics: ["electrical", "receptacles", "panel", "panel schedule", "circuits", "nec 210.52", "power plan"],
  },
];

export const KIT_EXAMPLES: readonly KitExample[] = ABOUT.map((a) => ({ ...a, source: KIT_EXAMPLE_SOURCES[a.name] ?? "" }));

export function kitExample(name: string): KitExample | undefined {
  const key = name.trim().toLowerCase().replace(/\.ts$/, "");
  return KIT_EXAMPLES.find((e) => e.name === key);
}
