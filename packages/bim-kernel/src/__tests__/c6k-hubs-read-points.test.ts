/**
 * @jest-environment node
 *
 * Round 6 lane K: the kernel's generic hubs read versioned extension points,
 * so a trade plugs in where ours do with no kernel edit. A test pack
 * contributes a command, a field provider, a diagram graph, a block hop and
 * dependency, a form schedule, a symbol and a derived-zone rule; each is seen
 * through its hub only inside a set that holds the pack, never in another
 * model's set or outside any scope. Before round 6 the command parser,
 * provider list, diagram and form dispatch, block hop and symbol list were
 * fixed code: none of these reads could see a pack row.
 */
import { z } from "zod";
import {
  BLOCK_DEPENDENCY_POINT,
  BLOCK_HOP_POINT,
  COMMAND_POINT,
  DEFAULT_SETTINGS,
  DERIVED_ZONE_RULE_POINT,
  DIAGRAM_GRAPH_POINT,
  FIELD_PROVIDER_POINT,
  FORM_SCHEDULE_POINT,
  SYMBOL_POINT,
  commandSchema,
  derivedZoneRule,
  executeCommand,
  fieldProviders,
  renderFieldBlock,
  symbolById,
  type BlockHopDef,
  type DiagramGraphDef,
  type FieldProvider,
  type FormScheduleDef,
  type ModelState,
  type PackCommandDef,
  type SymbolDef,
} from "..";
import { PackSet, activePackSet, bindModelPacks, contribute, definePack, unbindModelPacks, withPackSet } from "../packs";

const PING: PackCommandDef = {
  type: "zz_ping",
  schema: z.object({ type: z.literal("zz_ping"), note: z.string().min(1) }).strict(),
  execute: (model) => ({ ok: false, error: { code: "invalid_value", message: `pinged ${model.modelId}`, elementIds: [] } }),
};
const PROVIDER: FieldProvider = { id: "zz.fields" };
const GRAPH: DiagramGraphDef = { kind: "zz_diagram", build: () => ({ roots: [], warnings: [], reads: [] }) };
const HOP: BlockHopDef = { id: "zz_hop", target: (_model, subjectId) => subjectId ?? null };
const FORM: FormScheduleDef = { kind: "zz_form", evaluate: () => { throw new Error("not drawn here"); } };
const SYMBOL: SymbolDef = { id: "zz.dot", label: "Dot", primitives: [{ kind: "circle", center: [0, 0], radius: 1 }], connectionPoint: [0, 0] };

const ZZ = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [
  contribute(COMMAND_POINT, [PING]),
  contribute(FIELD_PROVIDER_POINT, [{ id: "zz.fields", provider: PROVIDER }]),
  contribute(DIAGRAM_GRAPH_POINT, [GRAPH]),
  contribute(BLOCK_HOP_POINT, [HOP]),
  contribute(BLOCK_DEPENDENCY_POINT, [{ id: "zz.deps", collect: () => false }]),
  contribute(FORM_SCHEDULE_POINT, [FORM]),
  contribute(SYMBOL_POINT, [SYMBOL]),
  contribute(DERIVED_ZONE_RULE_POINT, [{ id: "zz.halo", label: "Halo", ifcPredefinedType: "USERDEFINED", derive: () => [] }]),
]);

const WITH = PackSet.create([ZZ]);
const OTHER = PackSet.create([]);

const MODEL: ModelState = { modelId: "zz-model", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

function sees(): Record<string, boolean> {
  const set = activePackSet();
  return {
    command: commandSchema.safeParse({ type: "zz_ping", note: "hi" }).success,
    provider: fieldProviders().includes(PROVIDER),
    diagram: set.items(DIAGRAM_GRAPH_POINT).includes(GRAPH),
    hop: renderFieldBlock({ elements: {} }, { template: "{zz_hop.name}" }).unresolved.length === 1 && set.items(BLOCK_HOP_POINT).includes(HOP),
    form: set.items(FORM_SCHEDULE_POINT).includes(FORM),
    symbol: symbolById("zz.dot") !== null,
    zone: derivedZoneRule("zz.halo") !== null,
  };
}

const ALL = { command: true, provider: true, diagram: true, hop: true, form: true, symbol: true, zone: true };
const NONE = { command: false, provider: false, diagram: false, hop: false, form: false, symbol: false, zone: false };

describe("c6k hubs read extension points", () => {
  it("every hub sees the pack's rows inside its set only", () => {
    expect(withPackSet(WITH, sees)).toEqual(ALL);
    expect(withPackSet(OTHER, sees)).toEqual(NONE);
    expect(sees()).toEqual(NONE);
  });

  it("a pack command parses strictly and runs as a command and as a batch step, through the model's bound set", () => {
    bindModelPacks("zz-model", WITH);
    try {
      expect(withPackSet(WITH, () => commandSchema.safeParse({ type: "zz_ping", note: "hi", extra: 1 }).success)).toBe(false);
      const alone = executeCommand(MODEL, { type: "zz_ping", note: "hi" });
      expect(alone).toEqual({ ok: false, error: { code: "invalid_value", message: "pinged zz-model", elementIds: [] } });
      const batch = withPackSet(WITH, () => commandSchema.safeParse({ type: "batch_edits", commands: [{ type: "zz_ping", note: "hi" }] }));
      expect(batch.success).toBe(true);
    } finally {
      unbindModelPacks("zz-model");
    }
    expect(executeCommand(MODEL, { type: "zz_ping", note: "hi" })).toEqual({ ok: false, error: { code: "invalid_value", message: `"zz_ping" isn't a command this model's add-ons know`, elementIds: [] } });
  });
});
