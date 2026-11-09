/**
 * Shared synthetic pack and model for the round-3 lane B tests: a test pack
 * (`civtest`) with a gravity service, a structure class, a parameter set for
 * that class and a pipe material; a structure part type with two pipe ports.
 * No client data.
 */
import { BUILTIN_SERVICE_REGISTRY, commandSchema, DEFAULT_SETTINGS, partTypeDefinitionSchema, planCommit, serviceById, withUpgradePolicy, type ModelState, type PartTypeDefinition } from "../src";
import { CLASS_POINT } from "../src/registry";
import { PARAMETER_SET_POINT } from "../src/fields/pack-parameters";
import { PackSet, contribute, definePack } from "../src/packs";
import { SERVICE_POINT, withPackServices } from "../src/services/registry";
import { PIPE_MATERIAL_POINT } from "../src/routing/pipe/materials";

const sanitary = serviceById("sanitary");
if (!sanitary) throw new Error("the built-in sanitary row");

export const CIVTEST = definePack({ id: "civtest", name: "Civil test", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(SERVICE_POINT, [{ ...sanitary, id: "civtest.storm", label: "Storm", discipline: "civil", regime: "gravity", connector: "pipe", adapter: undefined, asLoad: false, sourceRoles: [], graphics: { colour: "#3a7d44", pattern: "dashed" } }]),
  contribute(CLASS_POINT, [{ id: "civtest.manhole", label: "Manholes", discipline: "civil" }]),
  contribute(PARAMETER_SET_POINT, [
    {
      id: "civtest.structures",
      label: "Structures",
      parameters: [
        { key: "civtest.invert_elevation", label: "Invert", classes: ["civtest.manhole"], valueType: "quantity", kind: "length", unit: "mm" },
        { key: "civtest.cover", label: "Cover", classes: ["civtest.manhole"], valueType: "choice", choices: ["solid", "grate"] },
      ],
    },
  ]),
  contribute(PIPE_MATERIAL_POINT, [{ id: "civtest.rcp", label: "reinforced concrete", fallback: "pe" }]),
]);
export const CIVTEST_SET = PackSet.create([CIVTEST]);
export const CIVTEST_SERVICES = withPackServices(BUILTIN_SERVICE_REGISTRY, CIVTEST_SET);

/** A storm structure with an inlet and an outlet, and an inlet capacity in cfs (a unit code, not a v1 unit name). */
export const STRUCTURE: PartTypeDefinition = partTypeDefinitionSchema.parse({
  familyName: "Storm structure",
  typeName: "48 in.",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [{ name: "inlet_capacity", label: "Inlet capacity", kind: "number", unit: "cfs", min: 0 }],
  connectors: [
    { id: "in", label: "Inlet", domain: "pipe", systemKind: "civtest.storm", position: [-600, 0, 300], direction: [-1, 0, 0], shape: "round", diameter: 304.8, flowDirection: "in" },
    { id: "out", label: "Outlet", domain: "pipe", systemKind: "civtest.storm", position: [600, 0, 300], direction: [1, 0, 0], shape: "round", diameter: 304.8, flowDirection: "out" },
  ],
  geometry: [{ kind: "cylinder", center: [0, 0, 0], radius: 600, height: 2400, axis: "z" }],
  symbol: [{ kind: "circle", center: [0, 0], radius: 600 }],
  tagFields: [],
  source: { kind: "builtin", libraryVersion: "test" },
});

let seq = 0;

export type Policy = (feature: string) => boolean;
export const ALL: Policy = () => true;

/** One commit under `policy` (default: every feature read), the model's pack set in force through its binding. */
export function tryCommit(head: ModelState, command: unknown, policy: Policy = ALL): { ok: true; model: ModelState } | { ok: false; message: string } {
  seq += 1;
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "unparsed" };
  const d = withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `c5e-r3-${seq}`, baseRevision: head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command: parsed.data }, () => "2026-10-29T00:00:00.000Z"));
  return d.ok ? { ok: true, model: d.model } : { ok: false, message: d.error.message };
}

export function commit(head: ModelState, command: { readonly type: string } & Readonly<Record<string, unknown>>, policy: Policy = ALL): ModelState {
  const r = tryCommit(head, command, policy);
  if (!r.ok) throw new Error(`${command.type}: ${r.message}`);
  return r.model;
}

export function emptyModel(modelId: string): ModelState {
  return { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

/** A site level and two classed structures 30 m apart. */
export function site(modelId: string): ModelState {
  let m = commit(emptyModel(modelId), { type: "create_level", levelId: "lvl-site", name: "Site", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "mh1", typeId: "pt-mh", partType: STRUCTURE, levelId: "lvl-site", position: { x: 0, y: 0 }, mark: "MH-1", values: { inlet_capacity: 2.5 } });
  m = commit(m, { type: "place_part", partId: "mh2", typeId: "pt-mh", levelId: "lvl-site", position: { x: 30_000, y: 0 }, mark: "MH-2" });
  return commit(m, { type: "set_element_class", elementIds: ["mh1", "mh2"], classId: "civtest.manhole" });
}
