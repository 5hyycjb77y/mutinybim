/**
 * @jest-environment node
 *
 * Shared linked-cut caches are keyed by IFC_CUT_VERSION. If the cut of this
 * fixed model changes, a cached background would be stale: this test fails
 * until IFC_CUT_VERSION is bumped and the golden hash below updated with it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as WebIFC from "web-ifc";
import { canonicalJson } from "@permitzip/bim-kernel";
import { IFC_CUT_VERSION, IFC_READER } from "../src/ifc-cut-version";
import { cutIfcPlan, cutIfcSection } from "../src/ifc-plan";
import { FIRST_PARTY_LINKED_DISPLAY } from "./fixtures/linked-display";
import { IDENTITY4 } from "../src/plan-geometry";
import { furnitureIfc } from "./fixtures/furniture-ifc";

const FT = 304.8;
/** Hash of the plan + section cut below at IFC_CUT_VERSION. Update both together. */
const GOLDEN: Record<number, string> = {
  1: "7986d273d69ec2ad",
  // 2: linked categories from the add-ons' display rules, view top, ceiling plans. The architect-only fixture cuts the same.
  2: "7986d273d69ec2ad",
};

describe("IFC cut version", () => {
  it("names the installed IFC reader", () => {
    const installed: unknown = JSON.parse(readFileSync(path.join(path.dirname(require.resolve("web-ifc")), "package.json"), "utf8"));
    const version = typeof installed === "object" && installed !== null && "version" in installed ? String(installed.version) : "unknown";
    expect(IFC_READER).toBe(`web-ifc@${version}`);
  });

  it("is bumped whenever the cut's output changes", async () => {
    const api = new WebIFC.IfcAPI();
    await api.Init();
    const bytes = new TextEncoder().encode(furnitureIfc({ grid: 2 }));
    const modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
    try {
      const { plan } = cutIfcPlan(api, modelId, { id: "arch", file: "furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 1", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY });
      const { plan: section } = cutIfcSection(api, modelId, {
        id: "arch",
        file: "furniture.ifc",
        bytes,
        discipline: "architecture",
        ifcToHostMetres: IDENTITY4,
        cut: { start: { x: 0, y: 10 * FT }, end: { x: 60 * FT, y: 10 * FT }, direction: 1, depthMm: 40 * FT },
      });
      const hash = createHash("sha256").update(canonicalJson({ plan, section })).digest("hex").slice(0, 16);
      expect({ version: IFC_CUT_VERSION, hash }).toEqual({ version: IFC_CUT_VERSION, hash: GOLDEN[IFC_CUT_VERSION] });
    } finally {
      api.CloseModel(modelId);
    }
  });
});
