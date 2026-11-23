import { elementsOfKind, findLevelByName, type BimElement, type ElementKind, type ModelState, type Room, type Space } from "@permitzip/bim-kernel";
import type { RuleContext, RuleDef } from "@permitzip/bim-lint";
import { evaluateEgressPhotometrics, evaluateNormalPhotometrics } from "../photometrics/calc";
import { isEgressSpace } from "../photometrics/standards";

/**
 * Photometric & emergency egress lighting lint rules (`LINT_RULE_POINT`).
 *
 * Performance guarantee:
 * - `scope: "element"` on `["space", "room"]` (plus `"architecture.stair"` for egress).
 * - O(1) WeakMap-indexed check whether the space's level has placed lighting fixtures
 *   and O(1) WeakMap-indexed covered-room set built at most once per `model.elements`
 *   revision: models without lighting design skip immediately with zero scan or calc work.
 * - Full-level photometric results are memoized per `model.elements` revision inside
 *   `evaluateNormalPhotometrics` / `evaluateEgressPhotometrics`, so evaluating N rooms
 *   on a level computes once per revision.
 */

const LEVEL_HAS_LIGHTS = new WeakMap<ModelState["elements"], ReadonlySet<string>>();
const COVERED_ROOM_IDS = new WeakMap<ModelState["elements"], ReadonlySet<string>>();

const NORMAL_READS: readonly (ElementKind | `${string}.${string}`)[] = [
  "part",
  "part_type",
  "service_catalog",
  "level",
  "wall",
  "opening",
  "slab",
  "ceiling",
  "column",
  "space",
  "room",
  "architecture.stair",
];

const EGRESS_READS: readonly (ElementKind | `${string}.${string}`)[] = [
  ...NORMAL_READS,
  "service_link",
];

function levelsWithLightingFixtures(model: ModelState): ReadonlySet<string> {
  let hit = LEVEL_HAS_LIGHTS.get(model.elements);
  if (hit) return hit;
  const set = new Set<string>();
  for (const part of elementsOfKind(model.elements, "part")) {
    const pt = model.elements[part.typeId];
    if (pt?.kind === "part_type" && pt.definition.category === "lighting_fixture") {
      set.add(part.levelId);
    }
  }
  LEVEL_HAS_LIGHTS.set(model.elements, set);
  return set;
}

function coveredRoomIds(model: ModelState): ReadonlySet<string> {
  let hit = COVERED_ROOM_IDS.get(model.elements);
  if (hit) return hit;
  const set = new Set<string>();
  for (const sp of elementsOfKind(model.elements, "space")) {
    if (sp.bounds.kind === "rooms") {
      for (const roomId of sp.bounds.roomIds) set.add(roomId);
    }
    if (sp.origin.kind === "from_room" && sp.origin.roomId) set.add(sp.origin.roomId);
  }
  COVERED_ROOM_IDS.set(model.elements, set);
  return set;
}

function levelIdOfSpatial(model: ModelState, el: Space | Room): string | null {
  if (el.kind === "space" && el.levelId) return el.levelId;
  if ("placement" in el && el.placement && "levelId" in el.placement) return el.placement.levelId;
  const levels = [...elementsOfKind(model.elements, "level")];
  const lvlName = el.partition?.level;
  if (lvlName) return findLevelByName(levels, lvlName)?.id ?? null;
  return levels[0]?.id ?? null;
}

function stairLevelIds(model: ModelState, el: BimElement): { readonly baseId: string | null; readonly topId: string | null } {
  const raw = el as unknown as {
    readonly levelId?: string;
    readonly topLevelId?: string;
    readonly placement?: { readonly levelId?: string };
  };
  const levels = [...elementsOfKind(model.elements, "level")].sort((a, b) => a.elevationMm - b.elevationMm);
  const baseId = raw.levelId ?? raw.placement?.levelId ?? levels[0]?.id ?? null;
  const baseLvl = baseId ? levels.find((l) => l.id === baseId) : undefined;
  const topId =
    raw.topLevelId ??
    (baseLvl ? levels.find((l) => l.elevationMm > baseLvl.elevationMm + 500)?.id ?? null : null);
  return { baseId, topId };
}

export const PHOTOMETRIC_LINT_RULES: readonly RuleDef[] = [
  {
    id: "photometrics-normal-illuminance",
    version: 1,
    pack: "electrical",
    severity: "warning",
    title: "Space normal illuminance or LPD fails IES / ASHRAE 90.1 target",
    scope: "element",
    kinds: ["space", "room"],
    reads: NORMAL_READS,
    rank: 920,
    run(ctx: RuleContext, el: BimElement) {
      if (el.kind !== "space" && el.kind !== "room") return;
      const litLevels = levelsWithLightingFixtures(ctx.model);
      if (litLevels.size === 0) return;
      const lvlId = levelIdOfSpatial(ctx.model, el);
      if (!lvlId || !litLevels.has(lvlId)) return;
      if (el.kind === "room" && coveredRoomIds(ctx.model).has(el.id)) return;

      const res = evaluateNormalPhotometrics(ctx.model, { level: lvlId, gridSpacingFt: 2, interReflectance: true });
      const summary = res.spaces.find((s) => s.spaceId === el.id);
      if (!summary || summary.pass) return;

      const pt = summary.gridPoints[0];
      ctx.emit({
        rule: "photometrics-normal-illuminance",
        severity: "warning",
        elementIds: [el.id],
        at: {
          level: summary.levelName,
          x_ft: pt ? Math.round((pt.xMm / 304.8) * 10) / 10 : 0,
          y_ft: pt ? Math.round((pt.yMm / 304.8) * 10) / 10 : 0,
          z_ft: Math.round(((summary.levelElevationMm + summary.workplaneHeightIn * 25.4) / 304.8) * 10) / 10,
        },
        message: `${summary.name}: ${summary.failReasons.join("; ")} (avg ${summary.avgFc} fc, min ${summary.minFc} fc, LPD ${summary.lpdWPerSqFt} W/ft²).`.slice(0, 160),
        fix: {
          tool: "bim_run_script",
          hint: summary.passAvg && summary.passMin && summary.passUniformity
            ? "Reduce fixture wattage or count to meet ASHRAE 90.1 Space-by-Space LPD."
            : "Add luminaires, assign a higher-lumen IES profile, or adjust spacing with electrical.setLuminaireIes.",
        },
      });
    },
  },
  {
    id: "photometrics-egress-compliance",
    version: 1,
    pack: "electrical",
    severity: "error",
    title: "Egress path fails NFPA 101 §7.9.2.1 / IBC §1008.3.5 emergency lighting criteria",
    scope: "element",
    kinds: ["space", "room", "architecture.stair"],
    reads: EGRESS_READS,
    rank: 925,
    run(ctx: RuleContext, el: BimElement) {
      const litLevels = levelsWithLightingFixtures(ctx.model);
      if (litLevels.size === 0) return;

      if (String(el.kind) === "architecture.stair") {
        const { baseId, topId } = stairLevelIds(ctx.model, el);
        if (!baseId || (!litLevels.has(baseId) && (!topId || !litLevels.has(topId)))) return;
        const res = evaluateEgressPhotometrics(ctx.model, { level: baseId, gridSpacingFt: 2, workplaneHeightIn: 0 });
        const path = res.paths.find((p) => p.pathId === `egress_stair:${el.id}`);
        if (!path || path.pass) return;

        const pt = path.gridPoints.find((g) => g.fail) ?? path.gridPoints[0];
        const zMm = pt?.zMm ?? path.levelElevationMm;
        ctx.emit({
          rule: "photometrics-egress-compliance",
          severity: "error",
          elementIds: [el.id],
          at: {
            level: path.levelName,
            x_ft: pt ? Math.round((pt.xMm / 304.8) * 10) / 10 : 0,
            y_ft: pt ? Math.round((pt.yMm / 304.8) * 10) / 10 : 0,
            z_ft: Math.round((zMm / 304.8) * 10) / 10,
          },
          message: `${path.name}: ${path.failReasons.join("; ")} (init ${path.avgFc}/${path.minFc} fc; 90m ${path.avgFc90Min}/${path.minFc90Min} fc).`.slice(0, 160),
          fix: {
            tool: "bim_run_script",
            hint: "Add emergency stairwell luminaires or assign battery/generator emergency lumens with electrical.setLuminaireIes.",
          },
        });
        return;
      }

      if (el.kind !== "space" && el.kind !== "room") return;
      const lvlId = levelIdOfSpatial(ctx.model, el);
      if (!lvlId || !litLevels.has(lvlId)) return;
      if (el.kind === "room" && coveredRoomIds(ctx.model).has(el.id)) return;
      const occHint = el.kind === "space" ? (el.use?.useId ?? el.use?.name) : undefined;
      if (!isEgressSpace(occHint, el.name)) return;

      const res = evaluateEgressPhotometrics(ctx.model, { level: lvlId, gridSpacingFt: 2, workplaneHeightIn: 0 });
      const path = res.paths.find((p) => p.pathId === el.id);
      if (!path || path.pass) return;

      const pt = path.gridPoints.find((g) => g.fail) ?? path.gridPoints[0];
      ctx.emit({
        rule: "photometrics-egress-compliance",
        severity: "error",
        elementIds: [el.id],
        at: {
          level: path.levelName,
          x_ft: pt ? Math.round((pt.xMm / 304.8) * 10) / 10 : 0,
          y_ft: pt ? Math.round((pt.yMm / 304.8) * 10) / 10 : 0,
          z_ft: Math.round((path.levelElevationMm / 304.8) * 10) / 10,
        },
        message: `${path.name}: ${path.failReasons.join("; ")} (init ${path.avgFc}/${path.minFc} fc; 90m ${path.avgFc90Min}/${path.minFc90Min} fc).`.slice(0, 160),
        fix: {
          tool: "bim_run_script",
          hint: "Assign emergency battery packs or generator circuits via electrical.setLuminaireIes, or add an exit/emergency combo unit.",
        },
      });
    },
  },
];
