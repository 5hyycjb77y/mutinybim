/**
 * @jest-environment node
 *
 * Round 15 SC15 (P15's gap): a placed starter fixture fills its row in the
 * plumbing fixture schedule at once. Placing a part whose type names a
 * starter connection type the project's catalog doesn't have yet adds that
 * type in the same edit (as a load point naming one does), so its DFU and
 * WSFU read straight away; one Undo takes both away.
 *
 * Fails on the code before SC15: placing the closets added no connection
 * type, so their DFU / WSFU cells were blank until someone opened
 * Connection types and adopted WC-FT by hand.
 */
import { catalogElementId, connectionTypeOf, evaluateScheduleV2, fieldProviderRegistry } from "@permitzip/bim-kernel";
import { buildRowSet } from "@permitzip/bim-kernel/schedules";
import { PLUMBING_FIXTURE_SCHEDULE } from "../src";
import { FT, starter, toiletRoom } from "./p15-fixtures";

/** The toilet room with a water heater too (the fixture schedule leaves heaters out by their kind). Nothing saved in Connection types. */
function room() {
  const m = toiletRoom();
  m.place("wh-1", starter("water-heater-tank"), 30 * FT, 10 * FT, 0, "WH-1");
  return m;
}

function fixtureRows(m: ReturnType<typeof toiletRoom>) {
  const def = PLUMBING_FIXTURE_SCHEDULE;
  const out = evaluateScheduleV2(buildRowSet(m.head, def, { viewId: "sc15", revision: m.head.revision, registry: fieldProviderRegistry() }), def);
  const at = (h: string) => out.headings.indexOf(h);
  return { row: (mark: string) => out.rows.find((r) => r[at("MARK")] === mark), at };
}

describe("sc15 a placed starter fixture fills the fixture schedule", () => {
  it("the closets' DFU and WSFU read with no catalog step; their starter type was added once, by the first placement", () => {
    const m = room();
    expect(connectionTypeOf(m.head.elements, "WC-FT")?.designator).toBe("WC-FT");
    const { row, at } = fixtureRows(m);
    expect([row("WC-1")?.[at("DFU")], row("WC-1")?.[at("TOTAL WSFU")]]).toEqual(["4.0 DFU", "5.0 WSFU"]);
    const adds = m.log.filter((cs) => cs.elements.some((el) => el.id === catalogElementId("connection_type", "WC-FT")));
    expect(adds).toHaveLength(1);
  });

  it("one Undo takes the fixture and the type it brought", () => {
    const m = room();
    const lav = catalogElementId("connection_type", "LAV");
    expect(m.head.elements[lav]).toBeUndefined();
    m.place("lav-1", starter("lavatory"), 2 * FT, 10 * FT, 0, "L-1");
    expect(m.head.elements[lav]).toBeDefined();
    expect(fixtureRows(m).row("L-1")?.[fixtureRows(m).at("DFU")]).toBe("1.0 DFU");
    m.ok({ type: "undo", revision: m.log[m.log.length - 1]?.revision ?? 0 });
    expect(m.head.elements[lav]).toBeUndefined();
    expect(m.head.elements["lav-1"]).toBeUndefined();
  });
});
