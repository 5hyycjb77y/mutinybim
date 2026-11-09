/**
 * A TEST fire-alarm add-on (round 7 lane R): the proof that a trade nobody
 * built into the kernel can propose devices from the requirements graph with
 * zero kernel edits. It brings its own rule (synthetic numbers, the author's
 * own words, no code text), its detector class and part type, and a proposer
 * that places smoke detectors on typed ceilings that take devices.
 *
 * It imports only the kernel's public entry points.
 */
import {
  asElementId,
  builtinPartTypes,
  ceilingHeightAtPoint,
  ceilingRole,
  ceilingsOfSpace,
  CLASS_POINT,
  PART_TYPE_POINT,
  PROPOSER_POINT,
  REQUIREMENTS_SOURCE_POINT,
  requirementsAt,
  type Ceiling,
  type GhostPlacement,
  type LibraryEntry,
  type ModelState,
  type ProposerAnswer,
  type ProposerDef,
  type ProposerRequest,
  type RuleRecord,
  type Vec2,
} from "@permitzip/bim-kernel";
import { contribute, definePack } from "@permitzip/bim-kernel/packs";

export const FA_SOURCE_ID = "fa.alarm_study";
export const FA_DETECTOR_CLASS = "fa.smoke_detector";
export const FA_DETECTOR_TYPE = "fa:smoke-detector@1";
export const FA_PROPOSER_ID = "fa.smoke_detectors";
export const FA_REQUIREMENT_KEY = "fa.detector_count";

export const FA_RULE: RuleRecord = {
  ruleId: "fa-detectors",
  provider: FA_SOURCE_ID,
  citation: { instrument: "Test Alarm Code", edition: "2024", section: "A-1.1" },
  title: "Smoke detector coverage",
  summary: "One detector for each test coverage area of ceiling in a storage room.",
  discipline: "fire_alarm",
  applies: { spaceUses: ["storage"] },
  reads: ["space.area", `class.${FA_DETECTOR_CLASS}`],
  parameters: { coverage: { value: 5, unit: "m2" } },
  produces: [{ key: FA_REQUIREMENT_KEY, anchor: "space", value: "ceil({space.area} / {param.coverage})", unit: "ea", compare: "at_least", delivered: `class.${FA_DETECTOR_CLASS}` }],
  verification: { status: "verified", by: "Test author" },
};

/** A detector type: the kernel's first starter type under the add-on's own id and name. */
function detectorType(): LibraryEntry {
  const base = builtinPartTypes()[0];
  if (!base) throw new Error("the starter library is empty");
  return { id: FA_DETECTOR_TYPE, definition: { ...base.definition, familyName: "Test smoke detector", typeName: "Standard" } };
}

function bboxOf(points: readonly Vec2[]): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** `n` points on an even grid over the ceiling's extent. */
function gridOn(ceiling: Ceiling, n: number): Vec2[] {
  const b = bboxOf(ceiling.outline);
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * w) / h)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const out: Vec2[] = [];
  for (let r = 0; r < rows && out.length < n; r += 1) {
    for (let c = 0; c < cols && out.length < n; c += 1) out.push({ x: b.minX + ((c + 0.5) * w) / cols, y: b.minY + ((r + 0.5) * h) / rows });
  }
  return out;
}

export const FA_PROPOSER: ProposerDef = {
  id: FA_PROPOSER_ID,
  label: "Smoke detectors",
  hosts: "typed ceilings that take devices",
  propose(model: ModelState, request: ProposerRequest): ProposerAnswer {
    const ghosts: GhostPlacement[] = [];
    const notes: string[] = [];
    for (const roomId of request.roomIds) {
      const need = requirementsAt(model, { kind: "space", id: roomId }).find((r) => r.key === FA_REQUIREMENT_KEY && typeof r.value === "number");
      if (!need || typeof need.value !== "number") {
        notes.push(`${roomId}: no detector requirement here`);
        continue;
      }
      const ceiling = ceilingsOfSpace(model.elements, asElementId(roomId)).find((c) => ceilingRole(c).hostsDevices);
      if (!ceiling) {
        notes.push(`${roomId}: no ceiling that takes devices`);
        continue;
      }
      const points = gridOn(ceiling, need.value);
      points.forEach((position, i) =>
        ghosts.push({
          key: `${roomId}#${i + 1}`,
          roomId,
          hostId: ceiling.id,
          typeId: request.typeId,
          position,
          heightMm: ceilingHeightAtPoint(ceiling, position),
          rotationDeg: 0,
          requirementId: need.id,
          reason: `Detector ${i + 1} of ${points.length}: ${need.title}, at least ${need.value} here`,
          cite: `${need.citation.instrument} ${need.citation.section}`,
        }),
      );
    }
    return { ghosts, summary: `${ghosts.length} detector${ghosts.length === 1 ? "" : "s"} in ${new Set(ghosts.map((g) => g.roomId)).size} room(s)`, passes: notes.length === 0, notes };
  },
};

export const FIRE_ALARM_TEST_PACK = definePack({ id: "fa", name: "Test fire alarm", version: "1.0.0", kernel: "^1.4.0" }, [
  contribute(CLASS_POINT, [{ id: FA_DETECTOR_CLASS, label: "Test smoke detectors", discipline: "general" }]),
  contribute(PART_TYPE_POINT, [{ entry: detectorType() }]),
  contribute(REQUIREMENTS_SOURCE_POINT, [{ descriptor: { id: FA_SOURCE_ID, label: "Test alarm study", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "firm" }, rules: () => [FA_RULE] }]),
  contribute(PROPOSER_POINT, [FA_PROPOSER]),
]);
