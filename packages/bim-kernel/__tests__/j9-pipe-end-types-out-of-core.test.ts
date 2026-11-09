/**
 * @jest-environment node
 *
 * Round 9 lane J9: end types belong to the add-ons. The bare kernel declares
 * none; the Plumbing add-on declares the pipe joints (reading the `joint`
 * every routed pipe fitting already stores) and Mechanical the duct ends; the
 * kernel's new connector files name no end type and no trade term. Fails on
 * round 8b's code: the joints existed only as kernel routing words, with no
 * point, no table and no add-on rows.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONNECTOR_END_TYPE_POINT, connectorEndTypeTable } from "@permitzip/bim-kernel";
import { MECHANICAL_END_TYPES } from "@permitzip/bim-pack-mechanical";
import { PIPE_END_TYPES } from "@permitzip/bim-pack-plumbing";
import { activePackSet } from "../src/packs";

/** The joint names and words round 9's kernel kept (`JOINT_LABEL`, gone from the kernel in round 10: P10). */
const ROUND_9_JOINT_LABEL = (JSON.parse(readFileSync(path.join(__dirname, "fixtures", "stored-changesets", "pipe-catalogue-r9.json"), "utf8")) as { readonly jointLabel: Readonly<Record<string, string>> }).jointLabel;

const KERNEL_FILES = ["connections/end-types.ts", "connections/integrity.ts"].map((f) => path.resolve(__dirname, "../src", f));

/** The trade-term ratchet's words (src/__tests__/trade-terms.test.ts) and the end types' own names. */
const FORBIDDEN = [
  "electrical", "plumbing", "mechanical", "sanitary", "grease", "vent", "sewer", "drainage", "interceptor",
  "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps",
  "nec", "ipc", "ifgc", "imc", "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation", "wsfu", "dfu", "fixture", "gas", "mbh", "sprinkler",
  "slip", "flanged", "threaded", "sweat", "solvent", "grooved", "crimp", "npt", "hub",
];

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

describe("j9-pipe-end-types-out-of-core", () => {
  it("the kernel ships no end type; every row in force is an add-on's", () => {
    expect(CONNECTOR_END_TYPE_POINT.builtins).toBeUndefined();
    expect([...connectorEndTypeTable().ids].sort()).toEqual([...MECHANICAL_END_TYPES, ...PIPE_END_TYPES].map((r) => r.id).sort());
    expect(activePackSet().items(CONNECTOR_END_TYPE_POINT).length).toBe(MECHANICAL_END_TYPES.length + PIPE_END_TYPES.length);
    expect(MECHANICAL_END_TYPES.every((r) => r.id.startsWith("mechanical.") && r.domains?.includes("duct"))).toBe(true);
    expect(PIPE_END_TYPES.every((r) => r.id.startsWith("plumbing_gas.") && r.domains?.includes("pipe"))).toBe(true);
  });

  it("every joint a routed pipe fitting stores reads as one of the Plumbing add-on's end types, with the same words", () => {
    const table = connectorEndTypeTable();
    expect(Object.keys(ROUND_9_JOINT_LABEL)).toHaveLength(10);
    for (const [joint, label] of Object.entries(ROUND_9_JOINT_LABEL)) {
      const row = table.resolveStored("joint", joint, "pipe");
      expect(row?.id).toBe(`plumbing_gas.${joint}`);
      expect(row?.label).toBe(label);
    }
  });

  it("the kernel's connector files name no end type and no trade term", () => {
    for (const file of KERNEL_FILES) {
      const hits = words(readFileSync(file, "utf8")).filter((w) => FORBIDDEN.some((t) => w === t || w === `${t}s` || w === `${t}es`));
      expect({ file: path.basename(file), hits }).toEqual({ file: path.basename(file), hits: [] });
    }
  });
});
