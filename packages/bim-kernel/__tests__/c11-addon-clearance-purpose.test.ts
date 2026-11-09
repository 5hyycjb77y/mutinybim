/**
 * @jest-environment node
 *
 * Round 11 C11: clearance purposes are rows (`CLEARANCE_PURPOSE_POINT`,
 * `kernel.clearance_purpose` v1). The six the kernel ships keep their stored
 * ids, labels, severities and derived-zone rules; an add-on's purpose is
 * written on a part type with no kernel edit, gets its derived-zone rule from
 * its row, and its label shows wherever the six do. A purpose whose add-on
 * isn't here is still read (kept as stored, named as such) but not written.
 *
 * Fails on round 10's code: `CLEARANCE_PURPOSES` was a closed list read by
 * `z.enum`, so the add-on's purpose was refused, and the point didn't exist.
 */
import {
  CLEARANCE_PURPOSES,
  CLEARANCE_PURPOSE_LABELS,
  CLEARANCE_PURPOSE_POINT,
  builtinPartType,
  clearancePurpose,
  clearancePurposeLabel,
  clearancePurposeRowProblems,
  clearanceZoneSchema,
  derivedZoneRule,
  partTypeIssues,
  type ClearancePurposeDef,
  type ClearanceZone,
} from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";

const HATCH: ClearancePurposeDef = { id: "c11acc.hatch_lift", label: "Hatch lift", severity: "warning" };
const ACCESS_PACK = definePack({ id: "c11acc", name: "Roof access (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(CLEARANCE_PURPOSE_POINT, [HATCH])]);
const WITH_ACCESS = PackSet.create([ACCESS_PACK]);
const ZONE: ClearanceZone = { id: "lift", name: "Hatch lift", purpose: "c11acc.hatch_lift", face: "top", depth: 900 };

function typeWith(zone: ClearanceZone) {
  const base = builtinPartType("builtin:rtu-5-ton@1");
  if (!base) throw new Error("starter library is missing the RTU");
  return { ...base.definition, clearances: [zone] };
}

describe("c11 clearance purposes are rows", () => {
  it("the six built-in purposes are rows with their stored ids, labels and severities unchanged", () => {
    expect(CLEARANCE_PURPOSES).toEqual(["service_access", "combustible", "economizer_access", "working_space", "keep_out", "dedicated_space"]);
    for (const id of CLEARANCE_PURPOSES) expect(clearancePurpose(id)?.label).toBe(CLEARANCE_PURPOSE_LABELS[id]);
    expect(CLEARANCE_PURPOSE_LABELS.working_space).toBe("Electrical working space");
    expect(CLEARANCE_PURPOSES.filter((id) => clearancePurpose(id)?.severity === "error")).toEqual(["combustible", "working_space"]);
    expect(derivedZoneRule("clearance:working_space")).toMatchObject({ label: "working space clearance", ifcPredefinedType: "RESERVATION" });
    expect(derivedZoneRule("clearance:service_access")).toMatchObject({ label: "service access clearance", ifcPredefinedType: "USERDEFINED" });
  });

  it("an add-on's purpose is written on a part type, gets its derived-zone rule and its label, with no kernel edit", () => {
    expect(clearancePurposeRowProblems([HATCH])).toEqual([]);
    withPackSet(WITH_ACCESS, () => {
      expect(clearanceZoneSchema.safeParse(ZONE).success).toBe(true);
      expect(partTypeIssues(typeWith(ZONE))).toEqual([]);
      expect(derivedZoneRule("clearance:c11acc.hatch_lift")).toMatchObject({ label: "hatch lift clearance", ifcPredefinedType: "USERDEFINED" });
      expect(CLEARANCE_PURPOSE_LABELS["c11acc.hatch_lift"]).toBe("Hatch lift");
    });
  });

  it("without the add-on its purpose is read and named, never written or guessed", () => {
    expect(clearanceZoneSchema.safeParse(ZONE).success).toBe(true);
    expect(partTypeIssues(typeWith(ZONE)).map((i) => i.message)).toEqual(['Hatch lift: its purpose "c11acc.hatch_lift" comes from an add-on this model doesn\'t have']);
    expect(derivedZoneRule("clearance:c11acc.hatch_lift")).toBeNull();
    expect(clearancePurposeLabel("c11acc.hatch_lift")).toBe("c11acc.hatch lift (from an add-on this model doesn't have)");
  });

  it("a purpose id that isn't a registry id is refused by the shape", () => {
    expect(clearanceZoneSchema.safeParse({ ...ZONE, purpose: "Hatch Lift!" }).success).toBe(false);
  });
});
