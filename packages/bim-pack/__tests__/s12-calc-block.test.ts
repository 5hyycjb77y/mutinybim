/**
 * @jest-environment node
 *
 * s12-calc-block: a calculation placed on a sheet. A test add-on (not
 * first-party) registers a beam sheet; `add_field_block` with `calc` stores
 * it (only when every peer reads `blocks:calc`), the sheet draws it through
 * `renderFieldBlock` with the host's tables and limits, the governing cell is
 * named in the text, the block depends on the beam it reads, and a table
 * change that moves the governing cell changes the block's value hash
 * ("changed since issue"). Unknown templates and older peers are refused in
 * words; undo-shaped specs keep `calc` through `fieldBlockSpecSchema`.
 *
 * Fails on round 11's code: `calc` is refused by the block command schema and
 * `renderFieldBlock` has no calculation path.
 */
import { CALC_SHEET_POINT, PackSet, contribute, definePack, withPackSet, type CalcSheetSpec, type CalcTable, type Pack } from "../src";
import { FIELD_RESOLVER_POINT } from "../src/runtime";
import {
  BLOCKS_CALC_FEATURE,
  DEFAULT_SETTINGS,
  asRevision,
  blockFreshness,
  blockHashInput,
  executeCommand,
  fieldBlockSpecSchema,
  renderFieldBlock,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type DrawingItem,
  type ElementId,
  type ModelState,
} from "@permitzip/bim-kernel";

type Beam = { readonly id: string; readonly kind: "zz_beam"; readonly span: number; readonly load: number };

const sheetSpec = (subjectId: string): CalcSheetSpec => ({
  template: "zz.beam_check",
  title: "Beam check",
  inputs: [
    { key: "span", label: "Span", unit: "ft", bind: { from: "field", subjectId: subjectId as ElementId, path: "zz.span" } },
    { key: "load", label: "Uniform load", unit: "plf", bind: { from: "field", subjectId: subjectId as ElementId, path: "zz.load" } },
  ],
  lookups: [{ key: "size", label: "Beam size", table: { slot: "zz.beam_capacity" }, row: { input: "span", match: "next_up" }, column: { input: "load", match: "next_up", by: "value" }, unit: "plf" }],
  steps: [],
  checks: [],
  citations: [{ section: "Beam table 2" }],
  result: { key: "size", label: "Beam capacity" },
});

const table = (columns: readonly string[]): CalcTable => ({ id: "zz.beam_capacity", label: "Beam capacity", rowHeading: { label: "Span", unit: "ft" }, columnHeading: { label: "Size", unit: "in" }, rows: [10, 15], columns, values: [[400, 700, 1100], [180, 320, 500]] });

const pack: Pack = definePack({ id: "zz", name: "Test structural", version: "1.0.0", kernel: "^1.10.0" }, [
  contribute(FIELD_RESOLVER_POINT, [
    {
      id: "zz.beam_fields",
      resolveRank: 30,
      listRank: 30,
      paths: [],
      resolve: (elements, id, path) => {
        const el = elements[id] as unknown as Partial<Beam> | undefined;
        if (el?.kind !== "zz_beam") return null;
        const v = path === "zz.span" ? el.span : path === "zz.load" ? el.load : undefined;
        return v === undefined ? null : { value: v, text: String(v) };
      },
    },
  ]),
  contribute(CALC_SHEET_POINT, [{ id: "zz.beam_check", label: "Beam check", build: (_m, req) => (req.subjectId ? sheetSpec(req.subjectId) : { refused: "Pick a beam" }) }]),
]);

function run(m: ModelState, c: Command): ModelState | string {
  const r = executeCommand(m, c);
  return r.ok ? r.model : r.error.message;
}

function sheetModel(): ModelState {
  const empty: ModelState = { modelId: "s12-calc-block", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const m = run(empty, { type: "create_sheet", sheetId: "s-1", number: "S-101", name: "Structural notes" });
  if (typeof m === "string") throw new Error(m);
  const beam = { id: "b1", kind: "zz_beam", span: 14, load: 300 } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, b1: beam } };
}

const add: Command = { type: "add_field_block", itemId: "blk-calc", sheetId: "s-1", at: { x: 40, y: 60 }, block: { template: "Beam check", title: "BEAM CHECK", subjectId: "b1", calc: { template: "zz.beam_check" } } };
const peersReadCalc = <T>(fn: () => T) => withUpgradePolicy((f) => f === BLOCKS_CALC_FEATURE, fn);

describe("s12-calc-block", () => {
  it("places a calculation, draws it with the governing cell named, and depends on the beam it reads", () => {
    withPackSet(PackSet.create([pack]), () => {
      const m = peersReadCalc(() => run(sheetModel(), add));
      if (typeof m === "string") throw new Error(m);
      const item = m.elements["blk-calc"] as DrawingItem;
      expect(item.block?.calc).toEqual({ template: "zz.beam_check" });
      const ctx = { tables: { table: () => table(["6", "8", "10"]) }, limits: {} };
      const r = renderFieldBlock(m, item.block!, { calc: ctx });
      expect(r.text.split("\n")[0]).toBe("Line | Value | Unit | How");
      expect(r.text).toContain("Beam size | 320 | plf | governing cell: 15 ft row, 8 column");
      expect(r.dependsOn).toEqual(["b1"]);
      const issued = blockHashInput(r);
      const moved = renderFieldBlock(m, item.block!, { calc: { ...ctx, tables: { table: () => table(["6", "7", "10"]) } } });
      expect(blockFreshness(blockHashInput(moved), { valueHash: issued }, "SD").state).toBe("changed_since");
      // With no library the sheet says what it needs instead of guessing.
      expect(renderFieldBlock(m, item.block!).text).toMatch(/Needs: Beam size: add the table this sheet reads \(zz\.beam_capacity\)/);
      expect(fieldBlockSpecSchema.parse(item.block)).toMatchObject({ calc: { template: "zz.beam_check" } });
    });
  });

  it("is never written to an older peer, and an unknown template is refused in words", () => {
    withPackSet(PackSet.create([pack]), () => {
      expect(run(sheetModel(), add)).toMatch(/older version that doesn't draw calculation sheets/);
      const unknown = { ...add, block: { ...(add as Extract<Command, { type: "add_field_block" }>).block, calc: { template: "nope.sheet" } } } as Command;
      expect(peersReadCalc(() => run(sheetModel(), unknown))).toMatch(/No add-on in this model has the nope\.sheet calculation/);
      const m = peersReadCalc(() => run(sheetModel(), add));
      if (typeof m === "string") throw new Error(m);
      const back = peersReadCalc(() => run(m, { type: "edit_field_block", itemId: "blk-calc", calc: null }));
      if (typeof back === "string") throw new Error(back);
      expect((back.elements["blk-calc"] as DrawingItem).block?.calc).toBeUndefined();
    });
  });
});
