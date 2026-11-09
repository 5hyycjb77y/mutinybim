/**
 * @jest-environment node
 *
 * P15 (round 15) step 2: starter fixtures whose connection type gives a vent
 * size get a vent connector `v`, pointing up from the trap, at that size;
 * their water and gas connectors take their own sizes from the same
 * connection type (a closet's cold water is 1/2", not its 3" waste).
 *
 * Fails on round 14: starter closets listed `ports: ["cw", "w"]` though
 * their vent size was given, and every connector was the waste size, so
 * Connect › To cold water refused "a 3" branch is larger than the 1" trunk".
 */
import { BUILTIN_LIBRARY_VERSION, type LibraryEntry, type PartConnector } from "@permitzip/bim-kernel";
import { PLUMBING_STARTER_CONNECTION_TYPES, nominalInches, plumbingStarterTypes } from "../src";

const IN = 25.4;
const entries = plumbingStarterTypes(BUILTIN_LIBRARY_VERSION);
const byStarter = (designator: string): LibraryEntry => {
  const e = entries.find((x) => x.definition.typeValues.default_connection_type === designator && x.definition.category === "plumbing_fixture");
  if (!e) throw new Error(`no starter fixture for ${designator}`);
  return e;
};
const conn = (e: LibraryEntry, id: string): PartConnector | undefined => e.definition.connectors.find((c) => c.id === id);
const sizeIn = (e: LibraryEntry, c: PartConnector | undefined): number | null => {
  const d = c?.diameter;
  if (!d || typeof d === "number" || !("param" in d)) return null;
  const v = e.definition.typeValues[d.param];
  return typeof v === "number" ? Math.round((v / IN) * 100) / 100 : null;
};

describe("starter fixture vent connectors", () => {
  it("every fixture whose connection type gives a vent size has `v`, pointing up, at that size", () => {
    const vented = PLUMBING_STARTER_CONNECTION_TYPES.filter((t) => t.quantities?.sizes?.v && t.trade === "plumbing");
    const fixtures = vented.map((t) => entries.find((e) => e.definition.typeValues.default_connection_type === t.designator && e.definition.connectors.some((c) => c.id === "w"))).filter((e): e is LibraryEntry => e !== undefined);
    expect(fixtures.length).toBeGreaterThanOrEqual(13);
    for (const e of fixtures) {
      const v = conn(e, "v");
      expect({ fixture: e.id, systemKind: v?.systemKind, up: v?.direction }).toEqual({ fixture: e.id, systemKind: "vent", up: [0, 0, 1] });
      const designator = e.definition.typeValues.default_connection_type;
      const want = PLUMBING_STARTER_CONNECTION_TYPES.find((t) => t.designator === designator)?.quantities?.sizes?.v;
      expect(sizeIn(e, v)).toBe(want ? nominalInches(want) : null);
    }
  });

  it("a flush-tank closet: 1/2\" cold water, 3\" waste, 2\" vent; a lavatory 1/2\" hot water", () => {
    const wc = byStarter("WC-FT");
    expect([sizeIn(wc, conn(wc, "cw")), sizeIn(wc, conn(wc, "w")), sizeIn(wc, conn(wc, "v"))]).toEqual([0.5, 3, 2]);
    const lav = byStarter("LAV");
    expect([sizeIn(lav, conn(lav, "hw")), sizeIn(lav, conn(lav, "v"))]).toEqual([0.5, 1.25]);
  });

  it("reads the sizes connection types write", () => {
    expect(["1/2\"", "3/4\"", "1\"", "1-1/4\"", "2\"", "x"].map(nominalInches)).toEqual([0.5, 0.75, 1, 1.25, 2, null]);
  });
});
