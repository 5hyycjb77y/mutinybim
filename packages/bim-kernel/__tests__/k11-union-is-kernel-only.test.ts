/**
 * @jest-environment node
 *
 * Round 13 lane K13 (step 1.5; the check round 11 named): the kernel's
 * element union names only kernel kinds. The Mechanical add-on's five record
 * shapes (unit, duct, tap, elbow, air terminal), `NetworkElement` and the
 * tap / duct geometry helpers live in `bim-pack-mechanical/src/types.ts`; the
 * union reaches them only through `AddOnElementTypes`, which an add-on fills
 * by declaration merging.
 *
 * Fails on round 12's code: kernel `types.ts` declared the five interfaces
 * and `NetworkElement`, `BimElement` started with `NetworkElement`, and the
 * kernel exported `tapPosition` and `segmentLength`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as kernel from "../src";
import * as mechanical from "@permitzip/bim-pack-mechanical";

const SRC = path.resolve(__dirname, "../src");
const MOVED = ["Equipment", "DuctSegment", "TapFitting", "Elbow", "Terminal", "NetworkElement"] as const;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("k11 union is kernel only", () => {
  it("no kernel source declares the five add-on record shapes or NetworkElement", () => {
    const declared = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return MOVED.filter((name) => new RegExp(`export (interface|type) ${name}\\b`).test(text)).map((name) => `${path.relative(SRC, file)}: ${name}`);
    });
    expect(declared).toEqual([]);
  });

  it("BimElement lists kernel kinds and the add-on registry, nothing named for a trade", () => {
    const text = readFileSync(path.join(SRC, "types.ts"), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("export type BimElement ="));
    expect(line).toBeDefined();
    for (const name of MOVED) expect(line).not.toMatch(new RegExp(`\\b${name}\\b`));
    expect(line).toMatch(/\bAddOnElement\b/);
    expect(text).toMatch(/export interface AddOnElementTypes \{\}/);
  });

  it("the kernel no longer exports the tap and duct geometry helpers; Mechanical does", () => {
    expect("tapPosition" in kernel).toBe(false);
    expect("segmentLength" in kernel).toBe(false);
    expect(typeof mechanical.tapPosition).toBe("function");
    expect(typeof mechanical.segmentLength).toBe("function");
  });

  it("Mechanical's types file fills the registry with its five kinds", () => {
    const text = readFileSync(path.resolve(__dirname, "../../bim-pack-mechanical/src/types.ts"), "utf8");
    expect(text).toMatch(/declare module "@permitzip\/bim-kernel\/types"/);
    for (const kind of ["equipment", "duct_segment", "tap", "elbow", "terminal"]) expect(text).toMatch(new RegExp(`\\b${kind}: \\w+;`));
  });
});
