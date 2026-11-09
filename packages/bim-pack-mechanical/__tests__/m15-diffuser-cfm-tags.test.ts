/**
 * @jest-environment node
 *
 * M6 (round 15, a check): Annotate › Tag all › Air devices on a plan tags
 * every diffuser with its mark and the CFM its connector carries, and a CFM
 * edit shows in the tag. Nothing new was built for it; this pins it so the
 * permit set's diffuser tags can't silently lose their airflow.
 */
import { planAutoTags } from "@permitzip/bim-kernel";
import { DIFFUSER, FT, K15Model } from "../../bim-kernel/__tests__/k15-fixtures";

function plan(): K15Model {
  const m = new K15Model();
  m.ok({ type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "Level 1", scale: 48 } });
  m.place("sd-1", DIFFUSER, 0, 0, 8 * FT, "SD-1");
  m.place("sd-2", DIFFUSER, 12 * FT, 0, 8 * FT, "SD-2");
  return m;
}

const tagText = (m: K15Model, id: string) => planAutoTags(m.head, "v-plan", { categories: ["air_terminal"], idPrefix: "t" }).items.find((i) => i.elementId === id)?.text ?? "";

describe("diffuser tags carry their CFM", () => {
  it("each diffuser is tagged with its mark and its airflow", () => {
    const m = plan();
    expect(tagText(m, "sd-1")).toMatch(/SD-1[\s\S]*150/);
    expect(tagText(m, "sd-2")).toMatch(/SD-2[\s\S]*150/);
  });

  it("a CFM edit shows in the tag", () => {
    const m = plan();
    m.ok({ type: "set_parameters", id: "sd-2", scope: "instance", values: { airflow: 225 } });
    expect(tagText(m, "sd-2")).toMatch(/SD-2[\s\S]*225/);
  });
});
