/**
 * @jest-environment node
 *
 * Round 12 lane P12: an outside add-on (not first-party, a test fixture)
 * brings its own pipe fitting family through `FITTING_FAMILY_POINT` with no
 * kernel edit: a grooved sprinkler-style elbow, the default for a 90° pipe
 * elbow, with its own fit rule (it isn't made in plastic). The kernel's
 * readers find it, pick it for the slot and judge a fitting by its rule.
 * Bare kernel otherwise (@mutinybim-bare-kernel).
 *
 * Fails on round 11's code: there was no fitting family point; the kernel's
 * static list was the only source of families.
 */
import {
  FITTING_FAMILY_POINT,
  familyMismatch,
  fittingFamilies,
  fittingFamily,
  fittingFamilyRowProblems,
  pipeFittingLabel,
  systemDefault,
  type FittingFamily,
  type FittingFamilyRow,
} from "@permitzip/bim-kernel";
import { PACK_CONTRACT_VERSION, PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";

const GROOVED: FittingFamily = {
  id: "zzfp.grooved.elbow_90",
  name: "Grooved 90° elbow",
  smacnaType: "Grooved elbow",
  domain: "pipe",
  fittingTypes: ["elbow"],
  shapes: ["pipe"],
  angles: "90",
  params: [],
  geometry: "pipe_fitting",
  loss: "pipe_k",
  pipe: { services: ["water"], materials: ["steel", "black_steel"], joints: ["grooved"], form: "bend", rOverD: 1, lOverD: { body: 30 } },
  description: "Roll-grooved elbow with couplings.",
};

const ROW: FittingFamilyRow = {
  family: GROOVED,
  defaults: [{ scope: "pipe", slot: "pipe_elbow_90", choice: { family: GROOVED.id } }],
  mismatch: (family, f) => (f.sizes.some((s) => s.shape === "pipe" && (s.material === "pvc" || s.material === "cpvc")) ? `${family.name} isn't made in plastic pipe` : null),
  label: (family) => `${family.name} (grooved)`,
};

const ADDON = definePack({ id: "zzfp", name: "P12 test fire add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(FITTING_FAMILY_POINT, [ROW])]);

describe("p12-outside-pack-fitting-family", () => {
  it("its row passes conformance", () => {
    expect(fittingFamilyRowProblems([ROW])).toEqual([]);
  });

  it("the kernel's readers use the outside family with no kernel edit, and only when it is loaded", () => {
    const set = PackSet.create([ADDON]);
    withPackSet(set, () => {
      expect(fittingFamily(GROOVED.id)).toBe(GROOVED);
      expect(fittingFamilies().map((f) => f.id)).toContain(GROOVED.id);
      expect(systemDefault({ systemKind: "domestic_cold_water", domain: "pipe" }, "pipe_elbow_90")).toEqual({ family: GROOVED.id });
      expect(familyMismatch(GROOVED, { fittingType: "elbow", domain: "pipe", sizes: [{ shape: "pipe", nominalMm: 50.8, material: "cpvc" }] })).toBe("Grooved 90° elbow isn't made in plastic pipe");
      expect(familyMismatch(GROOVED, { fittingType: "elbow", domain: "pipe", sizes: [{ shape: "pipe", nominalMm: 50.8, material: "steel" }], angleDeg: 90 })).toBeNull();
      expect(pipeFittingLabel(GROOVED, [], undefined)).toBe("Grooved 90° elbow (grooved)");
    });
    expect(fittingFamily(GROOVED.id)).toBeNull();
  });
});
