/**
 * @jest-environment node
 *
 * s12-design-limit-resolve, s12-design-limit-finding.
 *
 * Resolve: project over firm over the add-on default by id, most specific
 * first, per system (domestic cold, hot and recirc each their own), with the
 * firm's starting values (25 % panel spare, 20 % margin on mains) as add-on
 * defaults a library item replaces. The library item round-trips the kernel
 * limit (its key is the limit id) and refuses a band with nothing set.
 *
 * Finding: a test add-on measures a run's velocity through
 * `DESIGN_LIMIT_MEASURE_POINT`; the design limit problem source lists
 * "Velocity 9.2 ft/s over the firm's 8 ft/s (set by Quinn)", re-measures
 * only the edited ids, and retires the finding when the run is fixed.
 *
 * Fails on round 11's code: no design limits, no library item, no source.
 */
import { DESIGN_LIMIT_DEFAULT_POINT, PackSet, contribute, definePack, designLimitsFor, runPackConformance, withPackSet, type DesignLimit, type Pack } from "../src";
import { known } from "../src/known-point";
import { DESIGN_LIMIT_MEASURE_POINT, designLimitFindingSource, designLimitMeasureProblems, checkDesignLimit, type DesignLimitMeasurement } from "@permitzip/bim-kernel/policy";
import { designLimitFromItem, designLimitItemBody, designLimitItemSchema, parseItem } from "@permitzip/bim-library";
import type { FindingChangeContext } from "@permitzip/bim-kernel/findings";
import type { BimElement, FindingRef, ModelState } from "@permitzip/bim-kernel";

const lim = (id: string, quantity: string, unit: string, band: DesignLimit["band"], appliesTo: DesignLimit["appliesTo"], extra: Partial<DesignLimit> = {}): DesignLimit => ({
  id,
  label: id,
  quantity,
  unit,
  appliesTo,
  band,
  severity: "warning",
  citation: { source: "Test practice" },
  ...extra,
});

const defaults = [
  lim("tw.water_velocity", "velocity", "ft/s", { max: 8 }, { discipline: "tw" }),
  lim("tw.cold_velocity", "velocity", "ft/s", { max: 8 }, { discipline: "tw", systems: ["cold"] }),
  lim("tw.hot_velocity", "velocity", "ft/s", { max: 5 }, { discipline: "tw", systems: ["hot"] }),
  lim("tw.recirc_velocity", "velocity", "ft/s", { max: 2 }, { discipline: "tw", systems: ["recirc"] }),
  lim("tw.main_margin", "ratio", "%", { min: 20 }, { discipline: "tw", elementClasses: ["tw.main"] }),
  lim("tw.panel_spare", "ratio", "%", { min: 25 }, { discipline: "tw_power", elementClasses: ["tw.panel"] }),
];

type Run = { readonly id: string; readonly kind: "tw_run"; readonly system: string; readonly velocity: number };

const measured: string[][] = [];

const pack: Pack = definePack({ id: "tw", name: "Test water", version: "1.0.0", kernel: "^1.10.0" }, [
  contribute(DESIGN_LIMIT_DEFAULT_POINT, defaults),
  contribute(DESIGN_LIMIT_MEASURE_POINT, [
    {
      id: "tw.run_velocity",
      label: "Run velocity",
      quantities: ["velocity"],
      measure: (model: ModelState, ids?: ReadonlySet<string>): DesignLimitMeasurement[] => {
        const out: DesignLimitMeasurement[] = [];
        const seen: string[] = [];
        for (const el of Object.values(model.elements) as unknown as Run[]) {
          if (el.kind !== "tw_run" || (ids && !ids.has(el.id))) continue;
          seen.push(el.id);
          out.push({ elementId: el.id as BimElement["id"], label: "Velocity", selector: { quantity: "velocity", discipline: "tw", system: el.system }, value: el.velocity, unit: "ft/s" });
        }
        measured.push(seen);
        return out;
      },
    },
  ]),
]);

const modelOf = (runs: readonly Run[], revision = 1): ModelState => ({ revision, elements: Object.fromEntries(runs.map((r) => [r.id, r])) }) as unknown as ModelState;

describe("s12-design-limit-resolve", () => {
  it("each system has its own default; the firm's item replaces the default by id; the project's replaces the firm's", () => {
    expect(runPackConformance(pack, { points: [known(DESIGN_LIMIT_MEASURE_POINT, (items) => designLimitMeasureProblems(items), null)] }).problems).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      const first = (system: string, sources = {}) => designLimitsFor({ quantity: "velocity", discipline: "tw", system }, "cd", sources)[0];
      expect([first("cold")?.limit.id, first("hot")?.limit.id, first("recirc")?.limit.id]).toEqual(["tw.cold_velocity", "tw.hot_velocity", "tw.recirc_velocity"]);
      expect(first("gray")?.limit.id).toBe("tw.water_velocity");
      const firmItem = parseItem({ type: "design_limit", body: designLimitItemBody(lim("tw.hot_velocity", "velocity", "ft/s", { max: 4 }, { discipline: "tw", systems: ["hot"] }, { setBy: { name: "Quinn", at: "2026-11-03T20:00:00Z" } }), 1) });
      if (!firmItem.ok || firmItem.item.type !== "design_limit") throw new Error("the item didn't parse");
      const firm = [designLimitFromItem(firmItem.item.body)];
      expect(first("hot", { firm })).toMatchObject({ layer: "firm", replaces: ["addon"], limit: { band: { max: 4 }, setBy: { name: "Quinn" } } });
      const project = [lim("tw.hot_velocity", "velocity", "ft/s", { max: 3 }, { discipline: "tw", systems: ["hot"] })];
      expect(first("hot", { firm, project })).toMatchObject({ layer: "project", replaces: ["firm", "addon"], limit: { band: { max: 3 } } });
      expect(checkDesignLimit("Spare capacity", 18, "%", { quantity: "ratio", discipline: "tw_power", elementClass: "tw.panel" }, "cd", {}).words).toBe("Spare capacity 18 % under the default 25 % minimum");
      expect(checkDesignLimit("Margin", 0.25, "1", { quantity: "ratio", discipline: "tw", elementClass: "tw.main" }, "cd", {}).words).toBe("Margin 25 % within the default 20 %");
      expect(checkDesignLimit("Velocity", 3, "m/s", { quantity: "velocity", discipline: "tw", system: "cold" }, "cd", {}).words).toBe("Velocity 9.84 ft/s over the default 8 ft/s");
      expect(checkDesignLimit("Pressure loss", 3, "psi", { quantity: "pressure" }, "cd", {}).pass).toBeNull();
    });
  });

  it("the library item keeps the limit id as its key and refuses a band with nothing set", () => {
    const body = designLimitItemBody(defaults[0] as DesignLimit, 2);
    expect(body.id).toBe("design_limit:tw.water_velocity");
    expect(body.key).toBe("tw.water_velocity");
    expect(designLimitFromItem(designLimitItemSchema.parse(body))).toEqual(defaults[0]);
    const bad = designLimitItemSchema.safeParse({ ...body, band: {} });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/set a minimum, a maximum or a target/);
  });
});

describe("s12-design-limit-finding", () => {
  it("lists a violation with the limit and who set it; one edit re-measures only what it touched", () => {
    withPackSet(PackSet.create([pack]), () => {
      const firm = [lim("tw.cold_velocity", "velocity", "ft/s", { max: 8 }, { discipline: "tw", systems: ["cold"] }, { setBy: { name: "Quinn", at: "2026-11-03T20:00:00Z" }, severity: "error" })];
      const source = designLimitFindingSource({ limits: () => ({ firm }), stage: () => "cd" });
      const runs: Run[] = [
        { id: "r1", kind: "tw_run", system: "cold", velocity: 9.2 },
        { id: "r2", kind: "tw_run", system: "cold", velocity: 6 },
        { id: "r3", kind: "tw_run", system: "hot", velocity: 4 },
      ];
      const all = source.all({ model: modelOf(runs), lineageId: "main" });
      expect(all.map((f) => [f.id, f.severity, f.subjects, f.words])).toEqual([["design_limit:tw.cold_velocity:r1", "blocking", ["r1"], "Velocity 9.2 ft/s over the firm's 8 ft/s (set by Quinn)"]]);
      expect(all[0]?.source).toEqual({ kind: "design_limit", id: "tw.cold_velocity", version: "1" });

      measured.length = 0;
      const fixed = runs.map((r) => (r.id === "r1" ? { ...r, velocity: 7 } : r));
      const ledger = new Map<string, FindingRef>(all.map((f) => [f.id, f]));
      const ctx: FindingChangeContext = {
        model: modelOf(fixed, 2),
        previous: modelOf(runs),
        lineageId: "main",
        changedIds: ["r1"],
        current: ledger,
        touching: (ids) => {
          const want = new Set(ids);
          return [...ledger.values()].filter((f) => f.subjects.some((s) => want.has(s)));
        },
      };
      const change = source.changed?.(ctx);
      expect(change).toEqual({ retire: ["design_limit:tw.cold_velocity:r1"], put: [] });
      expect(measured).toEqual([["r1"]]);

      const worse = runs.map((r) => (r.id === "r3" ? { ...r, velocity: 6 } : r));
      const again = source.changed?.({ ...ctx, model: modelOf(worse, 3), changedIds: ["r3"] });
      expect(again).toEqual({ retire: [], put: [expect.objectContaining({ id: "design_limit:tw.hot_velocity:r3", words: "Velocity 6 ft/s over the default 5 ft/s", severity: "warning" })] });
    });
  });
});
