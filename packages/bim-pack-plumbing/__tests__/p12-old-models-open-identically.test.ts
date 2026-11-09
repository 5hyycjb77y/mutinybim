/**
 * @jest-environment node
 *
 * Round 12 lane P12: the pipe fitting families moved from the kernel into
 * the Plumbing and gas add-on, and every stored model opens with the same
 * families, specs, sizes and fitting choices. `p12-r11-fitting-families.json`
 * was written from round 11's kernel table (git 6eccc2969) before the move:
 * every family in full, and digests of every default choice (system kind ×
 * slot × material), every fit refusal (family × system kind × material ×
 * size) and every placed label. Round 9's stored pipe models
 * (`stored-changesets/pipe-*.json`) read the same element by element, and
 * round 9's frozen family order and joints hold. Installs Plumbing and gas
 * (@mutinybim-bare-kernel); since round 14 the choice matrix also installs
 * Mechanical, whose rows (hydronic, condensate, refrigerant, chilled and
 * heating water) the kernel's stand-in list carried until then, as every
 * host does.
 *
 * Fails on round 11's code: the add-on exports no `PIPE_FITTING_FAMILIES`
 * and the kernel has no `fittingFamilies()`.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  FITTING_SLOTS,
  PIPE_MATERIALS,
  SYSTEM_KINDS,
  fittingFamilies,
  pipeDefaultChoice,
  pipeFamilyMismatch,
  pipeFittingLabel,
  serviceOf,
  type FittingFamily,
  type ModelState,
} from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_PACK } from "@permitzip/bim-pack-mechanical";
import { PLUMBING_GAS_PACK, REGULATOR_PARAMS } from "../src";
import { pipeReadings, type PipeReading } from "../../bim-kernel/__tests__/fixtures/p10-pipe-readings";
import { matrices } from "./fixtures/p12-family-matrices";

interface R11 {
  readonly families: readonly FittingFamily[];
  readonly regulatorParams: unknown;
  readonly choicesSha: string;
  readonly choicesCount: number;
  readonly mismatchSha: string;
  readonly mismatchCount: number;
  readonly labelsSha: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface StoredFixture {
  readonly scenario: string;
  readonly head: ModelState;
  readonly expected: { readonly elements: Readonly<Record<string, PipeReading>> };
}

const R11_FILE = path.join(__dirname, "fixtures", "p12-r11-fitting-families.json");
const STORED = path.join(__dirname, "..", "..", "bim-kernel", "__tests__", "fixtures", "stored-changesets");
const r11 = JSON.parse(readFileSync(R11_FILE, "utf8")) as R11;
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const stored = readdirSync(STORED)
  .filter((f) => f.startsWith("pipe-") && f.endsWith(".json") && f !== "pipe-catalogue-r9.json")
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(STORED, f), "utf8")) as StoredFixture);
const r9 = JSON.parse(readFileSync(path.join(STORED, "pipe-catalogue-r9.json"), "utf8")) as { readonly familyJoints: Readonly<Record<string, { readonly joints?: readonly string[]; readonly param?: unknown }>> };

describe("p12-old-models-open-identically", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  // Families added after round 11 (new rows; every round 11 row stays byte for byte, in order).
  const ADDED_AFTER_R11 = new Set(["dwv.sixth_bend", "pipe.water.elbow_22"]);
  const pipeFamilies = (): FittingFamily[] => fittingFamilies().filter((f) => f.domain === "pipe" && !ADDED_AFTER_R11.has(f.id));

  it("every round 11 pipe family is an add-on row, byte for byte, in the same order", () => {
    expect(JSON.stringify(pipeFamilies())).toBe(JSON.stringify(r11.families));
    expect(JSON.stringify(REGULATOR_PARAMS)).toBe(JSON.stringify(r11.regulatorParams));
  });

  it("round 9's frozen family order and joints hold", () => {
    const families = pipeFamilies();
    expect(families.map((f) => f.id)).toEqual(Object.keys(r9.familyJoints));
    for (const f of families) {
      const was = r9.familyJoints[f.id];
      expect({ id: f.id, joints: f.pipe?.joints, param: f.params.find((p) => p.key === "joint") }).toEqual({ id: f.id, joints: was?.joints, param: was?.param });
    }
  });

  it("every default choice, fit refusal and label is round 11's (Mechanical's pipe services on too, as in every host)", () => {
    // Plumbing alone has no row for a hydronic pipe since round 14: the stand-in list that carried it is gone.
    expect(serviceOf("hydronic_supply")).toBeNull();
    installFirstPartyPacks([PLUMBING_GAS_PACK, MECHANICAL_PACK]);
    expect(serviceOf("hydronic_supply")).toBe("water");
    const now = matrices({ families: pipeFamilies(), choice: pipeDefaultChoice, mismatch: pipeFamilyMismatch, label: pipeFittingLabel, kinds: SYSTEM_KINDS, slots: FITTING_SLOTS, materials: PIPE_MATERIALS, serviceOf });
    expect(Object.keys(now.choices).length).toBe(r11.choicesCount);
    expect(Object.keys(now.mismatch).length).toBe(r11.mismatchCount);
    expect(now.labels).toEqual(r11.labels);
    expect(sha(now.choices)).toBe(r11.choicesSha);
    expect(sha(now.mismatch)).toBe(r11.mismatchSha);
    expect(sha(now.labels)).toBe(r11.labelsSha);
  });

  it.each(stored.map((f) => [f.scenario, f] as const))("%s: every pipe and fitting reads as round 9 read it", (_name, fx) => {
    const now = pipeReadings(fx.head);
    expect(Object.keys(now.elements)).toEqual(Object.keys(fx.expected.elements));
    for (const [id, want] of Object.entries(fx.expected.elements)) expect({ id, ...now.elements[id] }).toEqual({ id, ...want });
  });
});
