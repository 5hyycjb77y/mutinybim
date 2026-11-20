/**
 * @jest-environment node
 *
 * `@permitzip/bim-script` exposure for view detail level, per-category /
 * per-service overrides (`singleLineBelow`, `detailLevel`), `showLineCodes`,
 * `documents.setView`, and `routes.setSystemGraphics`.
 */
import {
  CATEGORY_OVERRIDES_FEATURE,
  VIEW_SCHEMATIC_DETAIL_FEATURE,
  DEFAULT_SETTINGS,
  buildViewScene,
  planCommit,
  systemLineCode,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Primitive,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { defineScript, documents, routes, runScript, sliceModel, units } from "../src";

const FEATURES = [CATEGORY_OVERRIDES_FEATURE, VIEW_SCHEMATIC_DETAIL_FEATURE];
const peerReads = (f: string) => FEATURES.includes(f);

let seq = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = withUpgradePolicy(peerReads, () =>
    planCommit(
      model,
      [],
      {
        idempotencyKey: `vdg-${++seq}`,
        baseRevision: model.revision,
        actor: { id: "avery", name: "Avery", kind: "human" },
        command,
      },
      () => "2026-11-20T00:00:00.000Z",
    ),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const configurePlumbing = defineScript({
  kind: "layout",
  reads: { levels: true, kinds: ["view", "mep_system"] },
  parameters: {},
  run(ctx) {
    routes.along(ctx, {
      level: "lvl-1",
      domain: "pipe",
      size: routes.pipe(units.in(2), "copper"),
      system: { id: "sys-cw", kind: "domestic_cold_water", name: "DCW-1" },
      height: units.ft(9),
      points: [
        { x: units.ft(0), y: units.ft(0) },
        { x: units.ft(20), y: units.ft(0) },
      ],
    });
    routes.setSystemGraphics(ctx, "sys-cw", { pattern: "dash_dot", weight: "medium", lineCode: "DCW" });
    const v = documents.planView(ctx, {
      id: "v-plumb",
      level: "lvl-1",
      name: "Level 1 - Plumbing",
      discipline: "plumbing",
      scale: 48,
      detailLevel: "medium",
      showLineCodes: true,
      categoryOverrides: { pipe: { singleLineBelow: units.in(4) } },
    });
    documents.setView(ctx, v, {
      categoryOverrides: {
        pipe: { singleLineBelow: units.in(4) },
        "service:sanitary": { detailLevel: "fine" },
      },
    });
  },
});

describe("bim-script view detail level and system graphics configuration", () => {
  it("configures planView detailLevel, singleLineBelow, setView, and setSystemGraphics end to end", async () => {
    let model: ModelState = { modelId: "vdg", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    model = commit(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });

    const out = await runScript(configurePlumbing, {
      slice: sliceModel(model, configurePlumbing.manifest.reads, [], FEATURES),
      values: {},
      scriptHash: "sha256:vdg",
    });

    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") throw new Error("expected edits");
    for (const cmd of out.batches) model = commit(model, cmd);

    expect(systemLineCode(model.elements, "sys-cw")).toBe("DCW");
    const view = model.elements["v-plumb"] as ViewElement;
    expect(view.props?.detailLevel).toBe("medium");
    expect(view.props?.showLineCodes).toBe(true);
    expect(view.props?.categoryOverrides?.pipe?.singleLineBelowMm).toBeCloseTo(101.6, 2);
    expect(view.props?.categoryOverrides?.["service:sanitary"]?.detailLevel).toBe("fine");

    const texts = buildViewScene(model, "v-plumb").scene.primitives.filter((p): p is Extract<Primitive, { kind: "text" }> => p.kind === "text").map((t) => t.text);
    expect(texts).toContain("DCW");
  });
});
