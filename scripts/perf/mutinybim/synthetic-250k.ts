/**
 * The 250k proof model for the round 5c scale rows: the full-building
 * synthetic at its 250k tier (air, water, sprinkler, power and lighting
 * networks, walls, slabs, rooms, openings, annotations), with a level per
 * floor, 2,000 placed parts over five starter-library types, and a
 * 250,000-element linked tower (slabs, ceilings, roofs and walls on a 10 ft
 * bay grid). Deterministic, no client data. Shared by the c5s perf tests and
 * any gate suite that needs the same shape.
 */
import {
  asElementId,
  builtinPartType,
  draftElements,
  elementsOfKind,
  executeCommand,
  freezeElements,
  type BimElement,
  type Command,
  type LinkedSurfaceSource,
  type ModelState,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";

const FT = 304.8;
const FLOOR_MM = 14 * FT;
const PART_TYPES = ["builtin:rtu-5-ton@1", "builtin:panelboard-225-480@1", "builtin:transformer-75kva@1", "builtin:switch-single-pole@1", "builtin:makeup-air-unit-480@1"] as const;
export const SYNTHETIC_PARTS = 2_000;

export interface Synthetic250k {
  /** A committed head (frozen record), as the model server and a confirmed browser session hold it. */
  readonly model: ModelState;
  readonly levelIds: readonly string[];
  readonly partIds: readonly string[];
}

function run(m: ModelState, c: Command): ModelState {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`[synthetic-250k] ${c.type}: ${r.error.message}`);
  return r.model;
}

export function createSynthetic250k(): Synthetic250k {
  const shape = FULL_BIM_TIERS["250k"];
  let m = createFullBimModel({ ...shape, modelId: "synthetic-250k" });
  m = { ...m, elements: freezeElements(m.elements) };
  const levelIds: string[] = [];
  for (let f = 0; f < shape.floors; f++) {
    const levelId = `lvl-${String(f + 1).padStart(2, "0")}`;
    m = run(m, { type: "create_level", levelId, name: `L${String(f + 1).padStart(2, "0")}`, elevationMm: f * FLOOR_MM });
    levelIds.push(levelId);
  }
  const templates: Array<Extract<BimElement, { kind: "part" }>> = [];
  PART_TYPES.forEach((typeId, i) => {
    const t = builtinPartType(typeId);
    if (!t) throw new Error(`[synthetic-250k] starter library is missing ${typeId}`);
    const partId = `syn-part-t${i}`;
    m = run(m, { type: "place_part", partId, typeId: t.id, partType: t.definition, levelId: levelIds[0] ?? "lvl-01", position: { x: i * 10 * FT, y: 0 }, offsetMm: 0, mark: `P-${i}` });
    const placed = m.elements[partId];
    if (placed?.kind !== "part") throw new Error(`[synthetic-250k] ${partId} was not placed`);
    templates.push(placed);
  });
  const draft = draftElements(m.elements);
  const partIds: string[] = templates.map((t) => t.id);
  for (let i = templates.length; i < SYNTHETIC_PARTS; i++) {
    const template = templates[i % templates.length];
    if (!template) continue;
    const id = asElementId(`syn-part-${i}`);
    const levelId = asElementId(levelIds[i % levelIds.length] ?? template.levelId);
    draft[id] = { ...template, id, mark: `P-${i}`, levelId, position: { x: (i % 50) * 10 * FT, y: Math.floor(i / 50) * 10 * FT } };
    partIds.push(id);
  }
  const model: ModelState = { ...m, elements: freezeElements(draft) };
  if (elementsOfKind(model.elements, "part").length !== SYNTHETIC_PARTS) throw new Error("[synthetic-250k] part count drifted");
  return { model, levelIds, partIds };
}

/** A 250,000-element linked tower, 50 storeys of 14 ft on a 50 x 50 grid of 10 ft bays: every 10th element a slab, every 10th + 1 a ceiling, every 997th a roof piece, the rest walls. */
export function syntheticLinkedTower(count = 250_000): LinkedSurfaceSource {
  const elements: Array<LinkedSurfaceSource["elements"][number]> = [];
  for (let i = 0; i < count; i++) {
    const storey = i % 50;
    const cell = Math.floor(i / 50) % 2_500;
    const x = (cell % 50) * 10 * FT;
    const y = Math.floor(cell / 50) * 10 * FT;
    const kind = i % 10 === 0 ? "slab" : i % 10 === 1 ? "covering" : i % 997 === 0 ? "roof" : "wall";
    const z0 = storey * FLOOR_MM + (kind === "covering" ? 9 * FT : 0);
    elements.push({ globalId: `e-${i}`, name: kind, ifcClass: "IFC", kind, box: [x, y, z0, x + 10 * FT, y + 10 * FT, z0 + (kind === "wall" ? 13 * FT : 300)] });
  }
  return { modelId: "synthetic-tower", label: "Tower", elements };
}

/** Samples' p50 and p95 by nearest rank. */
export function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}
