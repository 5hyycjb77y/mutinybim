/**
 * Plumbing riser: toilet rooms on two floors, drained by a stack into a
 * sloped building drain, every pipe sized by the plumbing code.
 *
 * The script counts drainage fixture units (DFU) and water supply fixture
 * units (WSFU) for the fixtures it places, sizes the floor branches, the
 * stack and the building drain with the code's drain sizing calc (2021
 * plumbing code tables), and the water demand with the Hunter curve. Then it
 * routes the piping with its fall, connects the fixtures, and tags the drain
 * and branches with their size and slope.
 *
 * Run it: paste it to an assistant connected to the MutinyBIM tool server
 * ("run this script"), or `npm run example -- plumbing-riser`.
 */
import { defineScript, units, routes, building, equipment, documents } from "@permitzip/bim-script";

const ft = units.ft;
const at = (x: number, y: number) => ({ x: ft(x), y: ft(y) });

/** Fixture units per fixture, public use (plumbing code drainage and supply fixture unit tables). */
const FIXTURES = [
  { type: "builtin:plumbing-wc-flush-tank@1", mark: "WC", x: 4, dfu: 4, wsfu: 5 },
  { type: "builtin:plumbing-wc-flush-tank@1", mark: "WC", x: 8, dfu: 4, wsfu: 5 },
  { type: "builtin:plumbing-lavatory@1", mark: "L", x: 12, dfu: 1, wsfu: 2 },
  { type: "builtin:plumbing-lavatory@1", mark: "L", x: 15, dfu: 1, wsfu: 2 },
];
/** 1/4 in per ft: the code minimum for drains 3 in and smaller, and the slope the sizing table is read at. */
const SLOPE = { rise: units.in(0.25), per: ft(1) };

export default defineScript({
  kind: "route",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    /** Size one drain by the code (3 in. at least where a water closet drains to it); the answer is nominal inches. */
    const drainSize = (role: "building_drain" | "horizontal_branch" | "stack", dfu: number): number => {
      const result = ctx.calc({ calc: "plumbing.size_drain", inputs: { role, dfu, slope_in_per_ft: 0.25, serves_water_closet: true }, plumbingEdition: "2021" });
      if (!result.ok) throw new Error(result.reason);
      return Number(result.run.values.find((v) => v.key === "size_nominal_in")?.value);
    };

    const floorDfu = FIXTURES.reduce((sum, f) => sum + f.dfu, 0);
    const floorWsfu = FIXTURES.reduce((sum, f) => sum + f.wsfu, 0);
    const floors = [building.level(ctx, { name: "Level 1", elevation: ft(0) }), building.level(ctx, { name: "Level 2", elevation: ft(12) })];
    const sanitary = { id: "san-1", kind: "sanitary", name: "Sanitary" } as const;
    const branchIn = drainSize("horizontal_branch", floorDfu);
    const stackIn = drainSize("stack", floorDfu);
    const drainIn = drainSize("building_drain", floorDfu * floors.length);

    const [ground, upper] = floors;
    if (!ground || !upper) throw new Error("Two floors expected.");
    const pipe = (inches: number) => routes.pipe(units.in(inches), "pvc");
    const lastPiece = (route: { segment(n: number): string }) => {
      // The kernel numbers a route's pieces s1, s2, … from its start.
      let n = 1;
      while (ctx.model.find(route.segment(n + 1))) n += 1;
      return route.segment(n);
    };

    // Fixtures in the same spot on each floor: two water closets and two lavatories along one wall.
    const fixturesOn = (level: string, floor: number) => FIXTURES.map((f) => equipment.place(ctx, { level, type: f.type, at: at(f.x, 4), mark: `${f.mark}-${floor}` }));

    // Level 2: a branch under the floor, falling west to the stack at x = 1 ft.
    const branch = routes.along(ctx, { level: upper, domain: "pipe", size: pipe(branchIn), system: sanitary, height: ft(-1), slope: SLOPE, flow: "with_points", points: [at(17, 2), at(2, 2)] });
    routes.connectInto(ctx, { from: fixturesOn(upper, 2).map((p) => ({ elementId: p.id, port: "w" })), into: branch.segment(1) });

    // The stack: drawn on Level 1, where it ends. It leaves the branch end straight (1 ft on), then drops
    // to 18 in under the Level 1 floor. The first point takes the branch end's height, after its fall.
    const stack = routes.along(ctx, { level: ground, domain: "pipe", size: pipe(stackIn), system: sanitary, from: routes.atRunEnd(branch.segment(1), "end"), points: [at(1, 2), { ...at(1, 2), height: ft(-1.5) }] });

    // The building drain: from the stack's foot (an elbow turns it), east 2.5 ft under the Level 1 floor to the street, falling 1/4 in per foot.
    const drain = routes.along(ctx, { level: ground, domain: "pipe", size: pipe(drainIn), system: sanitary, from: routes.atRunEnd(lastPiece(stack), "end"), height: ft(-2.5), slope: SLOPE, flow: "with_points", points: [at(2, 2), at(60, 2)] });

    // Level 1's fixtures drain straight into the building drain under them.
    routes.connectInto(ctx, { from: fixturesOn(ground, 1).map((p) => ({ elementId: p.id, port: "w" })), into: lastPiece(drain) });

    // Water demand for every fixture, from the Hunter curve.
    const demand = ctx.calc({ calc: "plumbing.hunter_demand", inputs: { wsfu: floorWsfu * floors.length, building_type: "office" } });
    const gpm = demand.ok ? Number(demand.run.values.find((v) => v.key === "design_gpm")?.value) : null;

    // A plumbing plan of Level 1, the building drain tagged with its size, slope and fixture units.
    const plan = documents.planView(ctx, { level: ground, name: "Level 1 - Plumbing", scale: 48, discipline: "plumbing" });
    documents.tag(ctx, { view: plan, element: lastPiece(drain), at: at(40, -3), fields: ["pipe.size", "pipe.slope", "pipe.carries.dfu"] });
    const sheet = documents.sheet(ctx, { number: "P-101", name: "Level 1 plumbing plan" });
    documents.place(ctx, sheet, plan, { x: units.mm(300), y: units.mm(280) });

    ctx.label(`Riser: ${floorDfu * floors.length} DFU, ${branchIn} in branches, ${stackIn} in stack, ${drainIn} in building drain at 1/4 in per ft${gpm ? `, ${Math.round(gpm)} gpm water demand` : ""}`);
  },
});
