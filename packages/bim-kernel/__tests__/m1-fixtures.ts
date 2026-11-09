import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import {
  applyChangeset,
  PRESSURE_TARGET_POINT,
  type PressureTargetSource,
  builtinPartType,
  canonicalJson,
  DEFAULT_SETTINGS,
  planCommit,
  type BimElement,
  type Changeset,
  type Command,
  type ModelState,
  type ParamDef,
  type PartTypeDefinition,
  type Space,
} from "../src";

/**
 * 7303 Sample Grill's pressurization (HVAC Demo 2, 16:43; ROADMAP F9 / M1):
 * KEF-1 hood exhaust −3,000 cfm and MUA-1 +2,400 cfm in the kitchen, RTU-1
 * (dining) 320 cfm and RTU-2 (kitchen) 380 cfm outdoor air, matched in HVAKR
 * at 10:40. Built through the authority's commit path, the way the surface
 * builds it. MUA-1 is untempered: 2,400 × 1.08 × (92 − 80) = 31,104 Btu/h.
 */

const FT = 304.8;
const NOW = () => "2026-10-28T08:00:00.000Z";
const builtin = { kind: "builtin", libraryVersion: "test" } as const;

const num = (name: string, label: string, unit: ParamDef["unit"]): ParamDef => ({ name, label, kind: "number", unit });
const text = (name: string, label: string): ParamDef => ({ name, label, kind: "text" });
const box = (): Pick<PartTypeDefinition, "geometry" | "symbol"> => ({ geometry: [{ kind: "box", center: [0, 0, 300], size: [900, 900, 600] }], symbol: [{ kind: "rect", center: [0, 0], size: [900, 900] }] });

/** A kitchen hood exhaust fan on the roof: its exhaust airflow and the zone it draws from. */
export const KITCHEN_EXHAUST_FAN: PartTypeDefinition = {
  familyName: "Kitchen exhaust fan, upblast",
  typeName: "3,000 cfm",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [num("exhaust_cfm", "Exhaust airflow", "cfm"), text("serves_zone", "Draws from zone")],
  connectors: [{ id: "inlet", label: "Inlet", domain: "duct", systemKind: "exhaust_air", position: [0, 0, 0], direction: [0, 0, -1], shape: "round", diameter: 400, flow: { param: "exhaust_cfm" } }],
  ...box(),
  tagFields: ["mark"],
  source: builtin,
};

/** A makeup air unit: makeup airflow, whether its air is tempered, and the two design temperatures (°F). */
export const MAKEUP_AIR_UNIT: PartTypeDefinition = {
  familyName: "Makeup air unit",
  typeName: "2,400 cfm",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [
    num("makeup_air_cfm", "Makeup airflow", "cfm"),
    text("serves_zone", "Supplies zone"),
    { name: "makeup_air_tempering", label: "Tempering", kind: "choice", choices: ["untempered", "partial", "tempered"] },
    num("tempering_from_temp", "Air arrives at (°F)", "none"),
    num("tempering_to_temp", "Brought to (°F)", "none"),
  ],
  connectors: [{ id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", position: [0, 0, 0], direction: [0, 0, -1], shape: "rect", width: 500, height: 300, flow: { param: "makeup_air_cfm" } }],
  ...box(),
  tagFields: ["mark"],
  source: builtin,
};

/** The built-in rooftop unit with its outdoor airflow (a type value: each RTU size is its own type). */
function rtuDefinition(outdoorCfm: number): PartTypeDefinition {
  const entry = builtinPartType("builtin:rtu-5-ton@2");
  if (!entry) throw new Error("builtin RTU missing");
  return { ...entry.definition, typeName: `${entry.definition.typeName}, ${outdoorCfm} cfm OA`, typeValues: { ...entry.definition.typeValues, outdoor_cfm: outdoorCfm } };
}

type CreateSpaceUse = NonNullable<Extract<Command, { type: "create_space" }>["spaces"][number]["use"]>;
const pinned = (useId: string, name: string): CreateSpaceUse => ({ libraryId: "builtin:space-uses", useId, name, revision: 1 });
const rect = (x: number, y: number, w: number, d: number) => [
  { x: x * FT, y: y * FT },
  { x: (x + w) * FT, y: y * FT },
  { x: (x + w) * FT, y: (y + d) * FT },
  { x: x * FT, y: (y + d) * FT },
];

let keySeq = 0;

export class PressurizationBuilding {
  head: ModelState = { modelId: "m1", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  private readonly types = new Set<string>();

  constructor() {
    this.ok({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  }

  submit(command: Command) {
    keySeq += 1;
    const d = planCommit(this.head, [], { idempotencyKey: `m1-key-${keySeq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "avery", kind: "human" }, command }, NOW, this.log);
    if (d.ok) {
      expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
      this.head = d.model;
      this.log.push(d.changeset);
    }
    return d;
  }

  ok(command: Command): Changeset {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }

  refused(command: Command): string {
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error.message;
  }

  place(id: string, typeId: string, definition: PartTypeDefinition, mark: string, values: Record<string, number | string>, at = { x: -100 * FT, y: 0 }): string {
    const first = !this.types.has(typeId);
    this.types.add(typeId);
    this.ok({ type: "place_part", partId: id, typeId, ...(first ? { partType: definition } : {}), levelId: "L1", position: at, mark, values });
    return id;
  }

  el(id: string): BimElement {
    const found = this.head.elements[id];
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
}

/** Kitchen (25 × 20 ft at the origin) and Dining (40 × 25 ft beside it), a zone each with its RTU; KEF-1 and MUA-1 on the roof naming the kitchen zone. */
export function sampleGrill(opts: { readonly withMua?: boolean; readonly kefCfm?: number | null } = {}): PressurizationBuilding {
  const b = new PressurizationBuilding();
  b.ok({
    type: "create_space",
    spaces: [
      { spaceId: "sp-kitchen", number: "102", name: "Kitchen", levelId: "L1", outline: rect(0, 0, 25, 20), use: pinned("kitchen_cooking", "Kitchens (cooking)") },
      { spaceId: "sp-dining", number: "101", name: "Dining", levelId: "L1", outline: rect(30, 0, 40, 25), use: pinned("restaurant_dining", "Restaurant dining rooms") },
    ],
  });
  b.place("rtu1", "type-rtu-1", rtuDefinition(320), "RTU-1", {});
  b.place("rtu2", "type-rtu-2", rtuDefinition(380), "RTU-2", {});
  b.ok({ type: "create_zone", zoneId: "z-dining", name: "Zone 1 Dining", purpose: "thermal", spaceIds: ["sp-dining"], servedBy: "rtu1" });
  b.ok({ type: "create_zone", zoneId: "z-kitchen", name: "Zone 2 Kitchen", purpose: "thermal", spaceIds: ["sp-kitchen"], servedBy: "rtu2" });
  const kef = opts.kefCfm === undefined ? 3000 : opts.kefCfm;
  b.place("kef1", "type-kef", KITCHEN_EXHAUST_FAN, "KEF-1", { serves_zone: "Zone 2 Kitchen", ...(kef === null ? {} : { exhaust_cfm: kef }) });
  if (opts.withMua !== false) b.place("mua1", "type-mua", MAKEUP_AIR_UNIT, "MUA-1", { makeup_air_cfm: 2400, serves_zone: "Zone 2 Kitchen", makeup_air_tempering: "untempered", tempering_from_temp: 80, tempering_to_temp: 92 });
  return b;
}

/** Kitchens negative, dining positive: the targets a host builds from the space-use library. */
export function restaurantTargets(space: Space) {
  if (space.use?.useId === "kitchen_cooking") return { target: "negative" as const, why: "kitchens are kept negative to the dining room." };
  if (space.use?.useId === "restaurant_dining") return { target: "positive" as const, why: "dining rooms are kept slightly positive." };
  return null;
}

/**
 * A pack set whose own pack supplies these pressure targets (round 6: targets
 * are a pack's `PRESSURE_TARGET_POINT` row, read per model; the last row in
 * set order is in force, so this overrides a first-party default).
 */
export function targetsSet(source: PressureTargetSource): PackSet {
  return PackSet.create([definePack({ id: "m1_targets", name: "M1 test targets", version: "1.0.0", kernel: "^1.3.0" }, [contribute(PRESSURE_TARGET_POINT, [{ id: "m1_targets.targets", target: source }])])]);
}

/** Run `fn` with `source` as the pressure targets in force. */
export function withTargets<R>(source: PressureTargetSource, fn: () => R): R {
  return withPackSet(targetsSet(source), fn);
}
