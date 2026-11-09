/**
 * @jest-environment node
 *
 * Round 12 lane E: a new circuit is named from the room its devices are in
 * and what they are ("RECEPT OFFICE 104"), by the firm's pattern; devices in
 * no room (or in two) fall back to round 11's words ("Receptacles"); one
 * piece of equipment is named for itself. Existing circuit names are never
 * touched (this only proposes a name for a new circuit).
 *
 * On round 11's code the proposal ignored rooms and read "Receptacles".
 */
import { DEFAULT_CIRCUIT_NAME_PATTERN, circuitNameFromRoom, defaultCircuitDescription } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function office(): Building {
  const b = new Building();
  b.ok({
    type: "create_space",
    spaces: [
      { spaceId: "sp-104", number: "104", name: "Office", levelId: "lvl-1", outline: [{ x: -1000, y: -1000 }, { x: 5000, y: -1000 }, { x: 5000, y: 4000 }, { x: -1000, y: 4000 }] },
      { spaceId: "sp-105", number: "105", name: "Conference", levelId: "lvl-1", outline: [{ x: 6000, y: -1000 }, { x: 12000, y: -1000 }, { x: 12000, y: 4000 }, { x: 6000, y: 4000 }] },
    ],
  });
  b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "r1", { x: 0, y: 0 });
  b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "r2", { x: 3000, y: 0 });
  b.place("r3", "receptacle", { voltage: 120, load_va: 180 }, "r3", { x: 8000, y: 0 });
  b.place("r9", "receptacle", { voltage: 120, load_va: 180 }, "r9", { x: 30000, y: 0 });
  b.place("lt", "light", { voltage: 120, load_va: 40 }, "lt", { x: 1000, y: 1000 });
  b.place("rtu", "mech3", { voltage: 208, load_va: 9000 }, "RTU-1", { x: 2000, y: 2000 });
  return b;
}

describe("e12: new circuits are named from their room", () => {
  it("reads the room and what is on the circuit", () => {
    const els = office().head.elements;
    expect(DEFAULT_CIRCUIT_NAME_PATTERN).toBe("{use} {room}");
    expect(defaultCircuitDescription(els, ["r1", "r2"])).toBe("RECEPT OFFICE 104");
    expect(defaultCircuitDescription(els, ["lt"])).toBe("LTG OFFICE 104");
    expect(defaultCircuitDescription(els, ["r1", "lt"])).toBe("RECEPT/LTG OFFICE 104");
    expect(circuitNameFromRoom(els, ["r1"], "{room} {use}")).toBe("OFFICE 104 RECEPT");
  });

  it("falls back to the words on the devices when they are in no room or in two", () => {
    const els = office().head.elements;
    expect(defaultCircuitDescription(els, ["r9"])).toBe("Receptacles");
    expect(defaultCircuitDescription(els, ["r1", "r3"])).toBe("Receptacles");
  });

  it("names one piece of equipment for itself", () => {
    expect(defaultCircuitDescription(office().head.elements, ["rtu"])).toBe("RTU-1");
  });
});
